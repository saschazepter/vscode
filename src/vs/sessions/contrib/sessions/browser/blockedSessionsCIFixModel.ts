/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { derived, IObservable } from '../../../../base/common/observable.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISession } from '../../../services/sessions/common/session.js';
import { getFailedChecks, submitFixCIChecks } from '../../changes/browser/checksActions.js';
import { IGitHubService } from '../../github/browser/githubService.js';
import { GitHubPullRequestCIModel } from '../../github/browser/models/githubPullRequestCIModel.js';
import { GitHubCheckStatus } from '../../github/common/types.js';
import { ISessionCIFixModel, ISessionCIFixState } from './views/sessionsList.js';

/**
 * Backs the per-session "Fix CI" row shown in the blocked-sessions dropdown for
 * sessions whose pull request has failing CI checks. Exposes a reactive summary
 * of the failing/pending check counts and, on demand, opens the session and
 * submits the `fix-ci` prompt for its failed checks.
 */
export class BlockedSessionsCIFixModel extends Disposable implements ISessionCIFixModel {

	/** Cached CI-state observables, keyed by session, to keep references stable and GC-friendly. */
	private readonly _states = new WeakMap<ISession, IObservable<ISessionCIFixState | undefined>>();

	/** Session resources with an in-flight fix so repeated clicks don't submit duplicate prompts. */
	private readonly _fixInFlight = new Set<string>();

	constructor(
		@IGitHubService private readonly _gitHubService: IGitHubService,
		@ISessionsService private readonly _sessionsService: ISessionsService,
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	getCIFix(session: ISession): IObservable<ISessionCIFixState | undefined> {
		let obs = this._states.get(session);
		if (!obs) {
			obs = derived(this, reader => {
				const gitHubInfo = session.workspace.read(reader)?.folders[0]?.gitRepository?.gitHubInfo.read(reader);
				if (!gitHubInfo?.pullRequest) {
					return undefined;
				}

				const prRef = reader.store.add(this._gitHubService.createPullRequestModelReference(gitHubInfo.owner, gitHubInfo.repo, gitHubInfo.pullRequest.number));
				const livePR = prRef.object.pullRequest.read(reader);
				if (!livePR) {
					return undefined;
				}

				const ciRef = reader.store.add(this._gitHubService.createPullRequestCIModelReference(gitHubInfo.owner, gitHubInfo.repo, gitHubInfo.pullRequest.number, livePR.headSha));
				const ciModel = ciRef.object;

				// Once a fix has been requested for the current head commit, hide the
				// row until a new commit lands (mirrors the chat input CI banner).
				if (ciModel.fixRequested.read(reader)) {
					return undefined;
				}

				const checks = ciModel.checks.read(reader);
				const failed = getFailedChecks(checks).length;
				if (failed === 0) {
					return undefined;
				}
				const completed = checks.filter(check => check.status === GitHubCheckStatus.Completed).length;
				const pending = checks.length - completed;
				return { failed, pending };
			});
			this._states.set(session, obs);
		}
		return obs;
	}

	fixCI(session: ISession): void {
		const key = session.resource.toString();
		if (this._fixInFlight.has(key)) {
			return;
		}
		this._fixInFlight.add(key);
		this._fixCI(session)
			.catch(err => this._logService.error('[BlockedSessionsCIFixModel] Failed to fix CI checks', err))
			.finally(() => this._fixInFlight.delete(key));
	}

	private async _fixCI(session: ISession): Promise<void> {
		// Acquire our own CI-model reference for the duration: opening the session
		// removes it from the blocked list, which drops the row's observers and
		// would otherwise release the shared model reference mid-flight.
		const store = new DisposableStore();
		try {
			const ciModel = this._acquireCIModel(session, store);
			if (!ciModel) {
				return;
			}

			await this._sessionsService.openSession(session.resource, { preserveFocus: true });

			const chatWidget = this._chatWidgetService.getWidgetBySessionResource(session.resource);
			if (!chatWidget) {
				this._logService.error('[BlockedSessionsCIFixModel] Cannot fix CI checks: no chat widget found for session', session.resource.toString());
				return;
			}

			await submitFixCIChecks(ciModel, chatWidget);
		} finally {
			store.dispose();
		}
	}

	private _acquireCIModel(session: ISession, store: DisposableStore): GitHubPullRequestCIModel | undefined {
		const gitHubInfo = session.workspace.get()?.folders[0]?.gitRepository?.gitHubInfo.get();
		if (!gitHubInfo?.pullRequest) {
			return undefined;
		}

		const prRef = store.add(this._gitHubService.createPullRequestModelReference(gitHubInfo.owner, gitHubInfo.repo, gitHubInfo.pullRequest.number));
		const livePR = prRef.object.pullRequest.get();
		if (!livePR) {
			return undefined;
		}

		const ciRef = store.add(this._gitHubService.createPullRequestCIModelReference(gitHubInfo.owner, gitHubInfo.repo, gitHubInfo.pullRequest.number, livePR.headSha));
		return ciRef.object;
	}
}
