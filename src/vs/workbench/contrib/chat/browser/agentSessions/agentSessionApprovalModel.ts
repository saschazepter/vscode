/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { renderAsPlaintext } from '../../../../../base/browser/markdownRenderer.js';
import { Disposable, DisposableResourceMap, IDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun, autorunIterableDelta, IObservable, ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { migrateLegacyTerminalToolSpecificData } from '../../common/chat.js';
import { IChatModel } from '../../common/model/chatModel.js';
import { IChatQuestionAnswers, IChatQuestionCarousel, IChatService, IChatToolInvocation, ToolConfirmKind } from '../../common/chatService/chatService.js';
import { ChatQuestionCarouselData } from '../../common/model/chatProgressTypes/chatQuestionCarouselData.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';

/**
 * The kind of attention a pending approval needs. Lets consumers tailor UI
 * (e.g. a summary message) to what the user is actually being asked to do.
 */
export const enum AgentSessionApprovalKind {
	/** A terminal command is waiting to be run. */
	Terminal = 'terminal',
	/** The agent is asking the user a question / needs a free-form response. */
	Question = 'question',
	/**
	 * The ask-questions tool is presenting a structured question carousel that
	 * carries its own interactive widget (see {@link IAgentSessionApprovalInfo.carousel}).
	 */
	QuestionCarousel = 'questionCarousel',
	/** Some other tool invocation is waiting for confirmation. */
	Other = 'other',
}

export interface IAgentSessionApprovalInfo {
	readonly kind: AgentSessionApprovalKind;
	readonly label: string;
	readonly languageId: string | undefined;
	readonly since: Date;
	/**
	 * The question carousel awaiting answers, present only for
	 * {@link AgentSessionApprovalKind.QuestionCarousel} approvals produced by the
	 * ask-questions tool. Consumers that can render the carousel widget (e.g. the
	 * blocked-sessions list) use this to show the tool's own UI inline.
	 */
	readonly carousel?: IChatQuestionCarousel;
	confirm(): void;
	/**
	 * Submit answers for {@link carousel}. No-op for approvals without a carousel.
	 */
	submitCarousel?(answers: IChatQuestionAnswers | undefined): void;
}

/**
 * A stable identity for a specific pending approval, distinguishing it from a
 * later, distinct approval on the same session (a fresh `since` yields a new id).
 */
export function agentSessionApprovalId(info: IAgentSessionApprovalInfo): string {
	return `${info.kind}\u0000${info.label}\u0000${info.since.getTime()}`;
}

/**
 * Tracks approval state for all live chat sessions. For each session,
 * exposes an observable that emits {@link IAgentSessionApprovalInfo}
 * when a tool invocation is waiting for user confirmation, or `undefined`
 * when no approval is needed.
 */
export class AgentSessionApprovalModel extends Disposable {

	private readonly _approvals = new Map<string, ISettableObservable<IAgentSessionApprovalInfo | undefined>>();
	private readonly _modelTrackers = this._register(new DisposableResourceMap());

	constructor(
		@IChatService private readonly _chatService: IChatService,
		@ILanguageService private readonly _languageService: ILanguageService,
	) {
		super();

		this._register(autorunIterableDelta(
			reader => this._chatService.chatModels.read(reader),
			({ addedValues, removedValues }) => {
				for (const model of addedValues) {
					this._modelTrackers.set(model.sessionResource, this._trackModel(model));
				}
				for (const model of removedValues) {
					this._modelTrackers.deleteAndDispose(model.sessionResource);
					this._approvals.get(model.sessionResource.toString())?.set(undefined, undefined);
				}
			}
		));
	}

	getApproval(sessionResource: URI): IObservable<IAgentSessionApprovalInfo | undefined> {
		return this._getOrCreateApproval(sessionResource.toString());
	}

	private _getOrCreateApproval(key: string): ISettableObservable<IAgentSessionApprovalInfo | undefined> {
		let obs = this._approvals.get(key);
		if (!obs) {
			obs = observableValue<IAgentSessionApprovalInfo | undefined>(`sessionApproval.${key}`, undefined);
			this._approvals.set(key, obs);
		}
		return obs;
	}

	private _trackModel(model: IChatModel): IDisposable {
		const settable = this._getOrCreateApproval(model.sessionResource.toString());

		const setIfChanged = (value: IAgentSessionApprovalInfo | undefined) => {
			const current = settable.get();
			if (current === value) {
				return;
			}
			if (current !== undefined && value !== undefined && current.kind === value.kind && current.label === value.label && current.languageId === value.languageId && current.carousel === value.carousel) {
				return;
			}
			settable.set(value, undefined);
		};

		return autorun(reader => {
			const needsInput = model.requestNeedsInput.read(reader);
			if (!needsInput) {
				setIfChanged(undefined);
				return;
			}

			const lastResponse = model.lastRequest?.response;
			if (!lastResponse?.response?.value) {
				setIfChanged(undefined);
				return;
			}

			for (const part of lastResponse.response.value) {
				if (part.kind === 'questionCarousel') {
					if (part.isUsed) {
						continue;
					}
					const carousel = part;
					const requestId = model.lastRequest?.id;
					const firstQuestion = carousel.questions[0];
					const messageSource = carousel.message ?? firstQuestion?.message ?? firstQuestion?.title;
					const label = messageSource === undefined ? '' : (typeof messageSource === 'string' ? messageSource : renderAsPlaintext(messageSource));
					setIfChanged({
						kind: AgentSessionApprovalKind.QuestionCarousel,
						label,
						languageId: undefined,
						since: new Date(),
						carousel,
						confirm: () => this._submitCarousel(requestId, carousel, undefined),
						submitCarousel: answers => this._submitCarousel(requestId, carousel, answers),
					});
					return;
				}
				if (part.kind !== 'toolInvocation' || part.toolSpecificData?.kind === 'modifiedFilesConfirmation') {
					continue; // unsupported
				}
				const state = part.state.read(reader);
				if (state.type === IChatToolInvocation.StateKind.WaitingForConfirmation || state.type === IChatToolInvocation.StateKind.WaitingForPostApproval) {
					let label: string;
					let languageId: string | undefined;
					let kind: AgentSessionApprovalKind;
					if (part.toolSpecificData?.kind === 'terminal') {
						const terminalData = migrateLegacyTerminalToolSpecificData(part.toolSpecificData);
						label = terminalData.presentationOverrides?.commandLine ?? terminalData.commandLine.forDisplay ?? terminalData.commandLine.userEdited ?? terminalData.commandLine.toolEdited ?? terminalData.commandLine.original;
						languageId = this._languageService.getLanguageIdByLanguageName(terminalData.presentationOverrides?.language ?? terminalData.language) ?? undefined;
						kind = AgentSessionApprovalKind.Terminal;
					} else if (needsInput.detail) {
						label = needsInput.detail;
						kind = AgentSessionApprovalKind.Question;
					} else {
						const msg = part.invocationMessage;
						label = typeof msg === 'string' ? msg : renderAsPlaintext(msg);
						kind = AgentSessionApprovalKind.Other;
					}

					const confirmState = state;
					setIfChanged({
						kind,
						label,
						languageId,
						since: new Date(),
						confirm: () => confirmState.confirm({ type: ToolConfirmKind.UserAction }),
					});
					return;
				}
			}

			setIfChanged(undefined);
		});
	}

	/**
	 * Resolve a pending question carousel with the given answers, completing the
	 * ask-questions tool invocation that produced it. Safe to call once — later
	 * calls are no-ops once the carousel is used.
	 */
	private _submitCarousel(requestId: string | undefined, carousel: IChatQuestionCarousel, answers: IChatQuestionAnswers | undefined): void {
		if (carousel.isUsed) {
			return;
		}
		carousel.data = answers ?? {};
		carousel.isUsed = true;
		if (carousel instanceof ChatQuestionCarouselData) {
			carousel.draftAnswers = undefined;
			carousel.draftCurrentIndex = undefined;
			carousel.completion.complete({ answers });
		}
		if (requestId && carousel.resolveId) {
			this._chatService.notifyQuestionCarouselAnswer(requestId, carousel.resolveId, answers);
		}
	}
}
