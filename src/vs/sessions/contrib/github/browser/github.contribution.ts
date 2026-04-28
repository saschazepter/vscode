/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun, derivedOpts } from '../../../../base/common/observable.js';
import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IGitHubInfo, ISession } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { GitHubService, IGitHubService } from './githubService.js';

interface ITrackedPullRequest {
	readonly owner: string;
	readonly repo: string;
	readonly prNumber: number;
	readonly model: ReturnType<IGitHubService['getPullRequest']>;
	refCount: number;
}

export class GitHubPullRequestPollingContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.contrib.githubPullRequestPolling';

	private readonly _sessionListeners = this._register(new DisposableMap<string, DisposableStore>());
	private readonly _sessionPullRequests = new Map<string, string>();
	private readonly _pullRequests = new Map<string, ITrackedPullRequest>();

	constructor(
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@IGitHubService private readonly _gitHubService: IGitHubService,
	) {
		super();

		for (const session of this._sessionsManagementService.getSessions()) {
			this._trackSession(session);
		}

		this._register(this._sessionsManagementService.onDidChangeSessions(e => {
			for (const session of e.removed) {
				this._untrackSession(session);
			}
			for (const session of e.added) {
				this._trackSession(session);
			}
			for (const session of e.changed) {
				this._trackSession(session);
			}
		}));
	}

	private _trackSession(session: ISession): void {
		if (this._sessionListeners.has(session.sessionId)) {
			return;
		}

		const store = new DisposableStore();
		store.add(autorun(reader => {
			const gitHubInfo = session.gitHubInfo.read(reader);
			const isArchived = session.isArchived.read(reader);
			this._updateSessionPullRequest(session, isArchived ? undefined : gitHubInfo);
		}));
		this._sessionListeners.set(session.sessionId, store);
	}

	private _untrackSession(session: ISession): void {
		this._releaseSessionPullRequest(session.sessionId);
		this._sessionListeners.deleteAndDispose(session.sessionId);
	}

	private _updateSessionPullRequest(session: ISession, gitHubInfo: IGitHubInfo | undefined): void {
		const nextPullRequest = gitHubInfo?.pullRequest;
		const nextKey = nextPullRequest ? this._pullRequestKey(gitHubInfo.owner, gitHubInfo.repo, nextPullRequest.number) : undefined;
		const previousKey = this._sessionPullRequests.get(session.sessionId);
		if (previousKey === nextKey) {
			return;
		}

		this._releaseSessionPullRequest(session.sessionId);

		if (gitHubInfo && nextPullRequest) {
			this._retainPullRequest(session.sessionId, gitHubInfo.owner, gitHubInfo.repo, nextPullRequest.number);
		}
	}

	private _retainPullRequest(sessionId: string, owner: string, repo: string, prNumber: number): void {
		const key = this._pullRequestKey(owner, repo, prNumber);
		let trackedPullRequest = this._pullRequests.get(key);
		if (!trackedPullRequest) {
			const model = this._gitHubService.getPullRequest(owner, repo, prNumber);
			model.startPolling();
			trackedPullRequest = { owner, repo, prNumber, model, refCount: 0 };
			this._pullRequests.set(key, trackedPullRequest);
		}
		trackedPullRequest.refCount++;
		this._sessionPullRequests.set(sessionId, key);
	}

	private _releaseSessionPullRequest(sessionId: string): void {
		const key = this._sessionPullRequests.get(sessionId);
		if (!key) {
			return;
		}
		this._sessionPullRequests.delete(sessionId);

		const trackedPullRequest = this._pullRequests.get(key);
		if (!trackedPullRequest) {
			return;
		}

		trackedPullRequest.refCount--;
		if (trackedPullRequest.refCount === 0) {
			trackedPullRequest.model.stopPolling();
			this._gitHubService.disposePullRequest(trackedPullRequest.owner, trackedPullRequest.repo, trackedPullRequest.prNumber);
			this._pullRequests.delete(key);
		}
	}

	private _pullRequestKey(owner: string, repo: string, prNumber: number): string {
		return `${owner}/${repo}/${prNumber}`;
	}

	override dispose(): void {
		for (const sessionId of [...this._sessionPullRequests.keys()]) {
			this._releaseSessionPullRequest(sessionId);
		}
		super.dispose();
	}
}

/**
 * Immediately refreshes PR data when the active session changes so that
 * CI checks and PR state are up-to-date without waiting for the next
 * polling cycle.
 */
export class GitHubActiveSessionRefreshContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.contrib.githubActiveSessionRefresh';

	constructor(
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@IGitHubService private readonly _gitHubService: IGitHubService,
	) {
		super();

		const activeSessionResourceObs = derivedOpts<URI | undefined>({ equalsFn: isEqual }, reader => {
			return this._sessionsManagementService.activeSession.read(reader)?.resource;
		});

		this._register(autorun(reader => {
			const activeSessionResource = activeSessionResourceObs.read(reader);
			const activeSession = this._sessionsManagementService.activeSession.read(reader);
			if (!activeSessionResource || !activeSession || activeSession.isArchived.read(reader)) {
				return;
			}
			const gitHubInfo = activeSession.gitHubInfo.read(reader);
			if (!gitHubInfo?.pullRequest) {
				return;
			}
			const prModel = this._gitHubService.getPullRequest(gitHubInfo.owner, gitHubInfo.repo, gitHubInfo.pullRequest.number);
			prModel.refresh();
		}));
	}
}

registerSingleton(IGitHubService, GitHubService, InstantiationType.Delayed);
registerWorkbenchContribution2(GitHubPullRequestPollingContribution.ID, GitHubPullRequestPollingContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(GitHubActiveSessionRefreshContribution.ID, GitHubActiveSessionRefreshContribution, WorkbenchPhase.AfterRestored);
