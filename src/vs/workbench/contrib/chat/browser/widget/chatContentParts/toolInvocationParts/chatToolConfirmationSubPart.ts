/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../../base/browser/dom.js';
import { Separator } from '../../../../../../../base/common/actions.js';
import { CancellationTokenSource } from '../../../../../../../base/common/cancellation.js';
import { RunOnceScheduler } from '../../../../../../../base/common/async.js';
import { IMarkdownString, MarkdownString } from '../../../../../../../base/common/htmlContent.js';
import { toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { count } from '../../../../../../../base/common/strings.js';
import { isEmptyObject } from '../../../../../../../base/common/types.js';
import { generateUuid } from '../../../../../../../base/common/uuid.js';
import { ElementSizeObserver } from '../../../../../../../editor/browser/config/elementSizeObserver.js';
import { ILanguageService } from '../../../../../../../editor/common/languages/language.js';
import { localize } from '../../../../../../../nls.js';
import { ICommandService } from '../../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../../../platform/keybinding/common/keybinding.js';
import { IMarkdownRenderer } from '../../../../../../../platform/markdown/browser/markdownRenderer.js';
import { IMarkerData, IMarkerService, MarkerSeverity } from '../../../../../../../platform/markers/common/markers.js';
import { IChatToolInvocation, ToolConfirmKind } from '../../../../common/chatService/chatService.js';
import { ChatConfiguration } from '../../../../common/constants.js';
import { createToolSchemaUri, ILanguageModelToolsService, IToolConfirmationMessages } from '../../../../common/tools/languageModelToolsService.js';
import { ILanguageModelToolsConfirmationService } from '../../../../common/tools/languageModelToolsConfirmationService.js';
import { AcceptToolConfirmationActionId, SkipToolConfirmationActionId } from '../../../actions/chatToolActions.js';
import { IChatCodeBlockInfo, IChatWidgetService } from '../../../chat.js';
import { IChatToolRiskAssessmentService, IToolRiskAssessment } from '../../../tools/chatToolRiskAssessmentService.js';
import { renderFileWidgets } from '../chatInlineAnchorWidget.js';
import { CodeBlockPart, ICodeBlockRenderOptions } from '../codeBlockPart.js';
import { IChatContentPartRenderContext } from '../chatContentParts.js';
import { IChatMarkdownAnchorService } from '../chatMarkdownAnchorService.js';
import { ChatMarkdownContentPart } from '../chatMarkdownContentPart.js';
import { AbstractToolConfirmationSubPart, IAbstractToolPrimaryAction } from './abstractToolConfirmationSubPart.js';
import { EditorPool } from '../chatContentCodePools.js';
import { ToolRiskBadgeWidget } from './toolRiskBadgeWidget.js';

const SHOW_MORE_MESSAGE_HEIGHT_TRIGGER = 100;

export class ToolConfirmationSubPart extends AbstractToolConfirmationSubPart {
	private markdownParts: ChatMarkdownContentPart[] = [];
	public get codeblocks(): IChatCodeBlockInfo[] {
		return this.markdownParts.flatMap(part => part.codeblocks);
	}

	private _riskBadge: ToolRiskBadgeWidget | undefined;
	private _riskAssessment: IToolRiskAssessment | undefined;

	constructor(
		toolInvocation: IChatToolInvocation,
		context: IChatContentPartRenderContext,
		private readonly renderer: IMarkdownRenderer,
		private readonly editorPool: EditorPool,
		private readonly currentWidthDelegate: () => number,
		private readonly codeBlockStartIndex: number,
		@IInstantiationService instantiationService: IInstantiationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IChatWidgetService chatWidgetService: IChatWidgetService,
		@ICommandService private readonly commandService: ICommandService,
		@IMarkerService private readonly markerService: IMarkerService,
		@ILanguageModelToolsService languageModelToolsService: ILanguageModelToolsService,
		@IChatMarkdownAnchorService private readonly chatMarkdownAnchorService: IChatMarkdownAnchorService,
		@ILanguageModelToolsConfirmationService private readonly confirmationService: ILanguageModelToolsConfirmationService,
		@IChatToolRiskAssessmentService private readonly riskAssessmentService: IChatToolRiskAssessmentService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		const state = toolInvocation.state.get();
		if (state.type !== IChatToolInvocation.StateKind.WaitingForConfirmation || !state.confirmationMessages?.title) {
			throw new Error('Confirmation messages are missing');
		}

		super(toolInvocation, context, instantiationService, keybindingService, contextKeyService, chatWidgetService, languageModelToolsService);

		// Kick off the (cheap) risk assessment in parallel with rendering. The
		// confirmation buttons remain immediately clickable; the badge updates
		// asynchronously.
		this._startRiskAssessment(state.parameters);

		this.render({
			allowActionId: AcceptToolConfirmationActionId,
			skipActionId: SkipToolConfirmationActionId,
			allowLabel: state.confirmationMessages.confirmResults ? localize('allowReview', "Allow and Review Once") : localize('allow', "Allow Once"),
			skipLabel: localize('skip.detail', 'Proceed without running this tool'),
			partType: 'chatToolConfirmation',
			subtitle: typeof toolInvocation.originMessage === 'string' ? toolInvocation.originMessage : toolInvocation.originMessage?.value,
		});

		// After render, attach the risk badge inline next to the confirmation title.
		this._attachRiskBadgeToTitle(state.parameters);
	}

	private _attachRiskBadgeToTitle(parameters: unknown): void {
		if (!this.riskAssessmentService.isEnabled()) {
			return;
		}
		const tool = this.languageModelToolsService.getTool(this.toolInvocation.toolId);
		if (!tool) {
			return;
		}
		const widget = this._register(this.instantiationService.createInstance(ToolRiskBadgeWidget));
		this._riskBadge = widget;
		const cached = this._riskAssessment ?? this.riskAssessmentService.getCached(tool, parameters);
		if (cached) {
			widget.setAssessment(cached);
		} else {
			widget.setLoading();
		}

		// Slot the badge as a slim row between the title row and the message body
		// of the confirmation widget. Defer until the next animation frame so the
		// sub-part is mounted (and we can find the message scrollable to insert
		// before).
		const targetWindow = dom.getWindow(this.domNode);
		const handle = dom.scheduleAtNextAnimationFrame(targetWindow, () => {
			// eslint-disable-next-line no-restricted-syntax
			const widgetRoot = this.domNode.querySelector('.chat-confirmation-widget2') as HTMLElement | null;
			if (widgetRoot) {
				const messageScrollable = Array.from(widgetRoot.children)
					.find(c => c.classList.contains('chat-confirmation-widget-message-scrollable'));
				if (messageScrollable) {
					widgetRoot.insertBefore(widget.domNode, messageScrollable);
					return;
				}
			}
			// Fallback: append inside the title row.
			// eslint-disable-next-line no-restricted-syntax
			this.domNode.querySelector('.chat-confirmation-widget-title')?.appendChild(widget.domNode);
		});
		this._register(handle);
	}

	private _startRiskAssessment(parameters: unknown): void {
		if (!this.riskAssessmentService.isEnabled()) {
			return;
		}
		const tool = this.languageModelToolsService.getTool(this.toolInvocation.toolId);
		if (!tool) {
			return;
		}
		// Skip the network round-trip if we already have a cached result.
		if (this.riskAssessmentService.getCached(tool, parameters)) {
			return;
		}
		const cts = this._register(new CancellationTokenSource());
		(async () => {
			try {
				const result = await this.riskAssessmentService.assess(tool, parameters, cts.token);
				if (cts.token.isCancellationRequested) {
					return;
				}
				if (!result) {
					this._riskBadge?.setHidden();
					return;
				}
				this._riskAssessment = result;
				this._riskBadge?.setAssessment(result);
				// Re-render the sub-part so suggested rules can be surfaced as primary actions.
				if (result.suggestedRules.length > 0) {
					this._onNeedsRerender.fire();
				}
			} catch {
				this._riskBadge?.setHidden();
			}
		})();
	}

	protected override additionalPrimaryActions() {
		const actions = super.additionalPrimaryActions();

		const state = this.toolInvocation.state.get();
		if (state.type !== IChatToolInvocation.StateKind.WaitingForConfirmation) {
			return actions;
		}

		if (state.confirmationMessages?.allowAutoConfirm !== false) {
			// Get combination label and precomputed key if present
			const approveCombination = state.confirmationMessages?.approveCombination;
			const combination = approveCombination
				? {
					label: typeof approveCombination.label === 'string' ? approveCombination.label : approveCombination.label.value,
					key: approveCombination.key,
					arguments: approveCombination.arguments,
				}
				: undefined;

			// Get actions from confirmation service
			const confirmActions = this.confirmationService.getPreConfirmActions({
				toolId: this.toolInvocation.toolId,
				source: this.toolInvocation.source,
				parameters: state.parameters,
				chatSessionResource: this.context.element.sessionResource,
				combination,
			});

			for (const action of confirmActions) {
				if (action.divider) {
					actions.push(new Separator());
				}
				actions.push({
					label: action.label,
					tooltip: action.detail,
					scope: action.scope,
					data: async () => {
						const shouldConfirm = await action.select();
						if (shouldConfirm) {
							this.confirmWith(this.toolInvocation, { type: ToolConfirmKind.UserAction });
						}
					}
				});
			}
		}

		// Append LLM-suggested auto-approve rules (when configured to do so).
		const suggestedActions = this._buildSuggestedRuleActions(state.parameters);
		if (suggestedActions.length > 0) {
			actions.push(new Separator());
			actions.push(...suggestedActions);
		}

		if (state.confirmationMessages?.confirmResults) {
			actions.unshift(
				{
					label: localize('allowSkip', 'Allow and Skip Reviewing Result'),
					data: () => {
						(state.confirmationMessages as IToolConfirmationMessages).confirmResults = undefined;
						this.confirmWith(this.toolInvocation, { type: ToolConfirmKind.UserAction });
					}
				},
				new Separator(),
			);
		}

		return actions;
	}

	private _buildSuggestedRuleActions(parameters: unknown): IAbstractToolPrimaryAction[] {
		if (this.configurationService.getValue<boolean>(ChatConfiguration.ToolRiskAssessmentSuggestRules) === false) {
			return [];
		}
		const tool = this.languageModelToolsService.getTool(this.toolInvocation.toolId);
		if (!tool) {
			return [];
		}
		const cached = this._riskAssessment ?? this.riskAssessmentService.getCached(tool, parameters);
		if (!cached || cached.suggestedRules.length === 0) {
			return [];
		}
		const out: IAbstractToolPrimaryAction[] = [];
		for (const rule of cached.suggestedRules) {
			out.push({
				label: rule.label,
				tooltip: rule.rationale || undefined,
				scope: rule.scope,
				data: () => {
					// MVP: accept this single call. Persisting the rule itself is delegated
					// to the existing per-scope auto-approve flows; this surface acts as a
					// hint plus a one-click confirm.
					this.confirmWith(this.toolInvocation, { type: ToolConfirmKind.UserAction });
				}
			});
		}
		return out;
	}

	protected override useAllowOnceAsPrimary(): boolean {
		const state = this.toolInvocation.state.get();
		if (state.type === IChatToolInvocation.StateKind.WaitingForConfirmation) {
			return !!state.confirmationMessages?.approveCombination;
		}
		return false;
	}

	protected createContentElement(): HTMLElement | string {
		const state = this.toolInvocation.state.get();
		if (state.type !== IChatToolInvocation.StateKind.WaitingForConfirmation) {
			return '';
		}
		return this._createInnerContentElement();
	}

	private _createInnerContentElement(): HTMLElement | string {
		const state = this.toolInvocation.state.get();
		if (state.type !== IChatToolInvocation.StateKind.WaitingForConfirmation) {
			return '';
		}
		const { message, disclaimer } = state.confirmationMessages!;
		const toolInvocation = this.toolInvocation as IChatToolInvocation;

		if (typeof message === 'string' && !disclaimer) {
			return message;
		} else {
			const codeBlockRenderOptions: ICodeBlockRenderOptions = {
				hideToolbar: true,
				reserveWidth: 19,
				verticalPadding: 5,
				editorOptions: {
					tabFocusMode: true,
					ariaLabel: this.getTitle(),
				},
			};

			const elements = dom.h('div', [
				dom.h('.message@messageContainer', [
					dom.h('.message-wrapper@message'),
					dom.h('.see-more@showMore', [
						dom.h('a', [localize('showMore', "Show More")])
					]),
				]),
				dom.h('.editor@editor'),
				dom.h('.disclaimer@disclaimer'),
			]);

			if (toolInvocation.toolSpecificData?.kind === 'input' && toolInvocation.toolSpecificData.rawInput && !isEmptyObject(toolInvocation.toolSpecificData.rawInput)) {

				const titleEl = document.createElement('h3');
				titleEl.textContent = localize('chat.input', "Input");
				elements.editor.appendChild(titleEl);

				const inputData = toolInvocation.toolSpecificData;

				const codeBlockRenderOptions: ICodeBlockRenderOptions = {
					hideToolbar: true,
					reserveWidth: 19,
					maxHeightInLines: 13,
					verticalPadding: 5,
					editorOptions: {
						wordWrap: 'off',
						readOnly: false,
						ariaLabel: this.getTitle(),
					}
				};

				const langId = this.languageService.getLanguageIdByLanguageName('json');
				const rawJsonInput = JSON.stringify(inputData.rawInput ?? {}, null, 1);
				const canSeeMore = count(rawJsonInput, '\n') > 2; // if more than one key:value
				// View a single JSON line by default until they 'see more'
				const initialText = rawJsonInput.replace(/\n */g, ' ');

				const key = CodeBlockPart.poolKey(this.context.element.id, this.codeBlockStartIndex);
				const editor = this._register(this.editorPool.get(key));
				editor.object.render({
					codeBlockIndex: this.codeBlockStartIndex,
					element: this.context.element,
					languageId: langId ?? 'json',
					text: initialText,
					renderOptions: codeBlockRenderOptions,
					chatSessionResource: this.context.element.sessionResource
				}, this.currentWidthDelegate());
				const model = editor.object.editor.getModel()!;

				const markerOwner = generateUuid();
				const schemaUri = createToolSchemaUri(toolInvocation.toolId);
				const validator = new RunOnceScheduler(async () => {

					const newMarker: IMarkerData[] = [];

					type JsonDiagnostic = {
						message: string;
						range: { line: number; character: number }[];
						severity: string;
						code?: string | number;
					};

					const result = await this.commandService.executeCommand<JsonDiagnostic[]>('json.validate', schemaUri, model.getValue());
					for (const item of result ?? []) {
						if (item.range && item.message) {
							newMarker.push({
								severity: item.severity === 'Error' ? MarkerSeverity.Error : MarkerSeverity.Warning,
								message: item.message,
								startLineNumber: item.range[0].line + 1,
								startColumn: item.range[0].character + 1,
								endLineNumber: item.range[1].line + 1,
								endColumn: item.range[1].character + 1,
								code: item.code ? String(item.code) : undefined
							});
						}
					}

					this.markerService.changeOne(markerOwner, model.uri, newMarker);
				}, 500);

				validator.schedule();
				this._register(model.onDidChangeContent(() => validator.schedule()));
				this._register(toDisposable(() => this.markerService.remove(markerOwner, [model.uri])));
				this._register(validator);

				this.codeblocks.push({
					codeBlockIndex: this.codeBlockStartIndex,
					codemapperUri: undefined,
					elementId: this.context.element.id,
					focus: () => editor.object.focus(),
					ownerMarkdownPartId: this.codeblocksPartId,
					uri: model.uri,
					chatSessionResource: this.context.element.sessionResource
				});
				this._register(model.onDidChangeContent(e => {
					try {
						inputData.rawInput = JSON.parse(model.getValue());
					} catch {
						// ignore
					}
				}));

				elements.editor.append(editor.object.element);

				if (canSeeMore) {
					const seeMore = dom.h('div.see-more', [dom.h('a@link')]);
					seeMore.link.textContent = localize('seeMore', "See more");
					this._register(dom.addDisposableGenericMouseDownListener(seeMore.link, () => {
						try {
							const parsed = JSON.parse(model.getValue());
							model.setValue(JSON.stringify(parsed, null, 2));
							editor.object.editor.updateOptions({ tabFocusMode: false });
							editor.object.editor.updateOptions({ wordWrap: 'on' });
						} catch {
							// ignored
						}
						seeMore.root.remove();
					}));
					elements.editor.append(seeMore.root);
				}
			}

			const mdPart = this._makeMarkdownPart(elements.message, message!, codeBlockRenderOptions);

			const messageSeeMoreObserver = this._register(new ElementSizeObserver(mdPart.domNode, undefined));
			const updateSeeMoreDisplayed = () => {
				const show = messageSeeMoreObserver.getHeight() > SHOW_MORE_MESSAGE_HEIGHT_TRIGGER;
				if (elements.messageContainer.classList.contains('can-see-more') !== show) {
					elements.messageContainer.classList.toggle('can-see-more', show);
				}
			};

			this._register(dom.addDisposableListener(elements.showMore, 'click', () => {
				elements.messageContainer.classList.toggle('can-see-more', false);
				messageSeeMoreObserver.dispose();
			}));


			this._register(messageSeeMoreObserver.onDidChange(updateSeeMoreDisplayed));
			messageSeeMoreObserver.startObserving();

			if (disclaimer) {
				this._makeMarkdownPart(elements.disclaimer, disclaimer, codeBlockRenderOptions);
			} else {
				elements.disclaimer.remove();
			}

			return elements.root;
		}
	}

	protected getTitle(): string {
		const state = this.toolInvocation.state.get();
		if (state.type !== IChatToolInvocation.StateKind.WaitingForConfirmation) {
			return '';
		}
		const title = state.confirmationMessages?.title;
		if (!title) {
			return '';
		}
		return typeof title === 'string' ? title : title.value;
	}

	private _makeMarkdownPart(container: HTMLElement, message: string | IMarkdownString, codeBlockRenderOptions: ICodeBlockRenderOptions) {
		const part = this._register(this.instantiationService.createInstance(ChatMarkdownContentPart,
			{
				kind: 'markdownContent',
				content: typeof message === 'string' ? new MarkdownString().appendMarkdown(message) : message,
			},
			this.context,
			this.editorPool,
			false,
			this.codeBlockStartIndex,
			this.renderer,
			undefined,
			this.currentWidthDelegate(),
			{ codeBlockRenderOptions },
		));
		renderFileWidgets(part.domNode, this.instantiationService, this.chatMarkdownAnchorService, this._store);
		container.append(part.domNode);

		return part;
	}
}
