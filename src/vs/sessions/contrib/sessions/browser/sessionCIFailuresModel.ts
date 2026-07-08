/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { raceTimeout } from '../../../../base/common/async.js';
import { derivedOpts, IObservable, IReaderWithStore } from '../../../../base/common/observable.js';
import { structuralEquals } from '../../../../base/common/equals.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IChatWidget, IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { ISession } from '../../../services/sessions/common/session.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { IGitHubService } from '../../github/browser/githubService.js';
import { GitHubCheckStatus } from '../../github/common/types.js';
import { buildFixChecksPrompt, getFailedChecks, getPullRequestUrl } from '../../changes/browser/checksActions.js';

/**
 * Safety bound for waiting on a session's chat widget to bind after opening it.
 * The wait is primarily event-driven; this only prevents a permanently pending
 * promise if the widget never appears.
 */
const WAIT_FOR_WIDGET_TIMEOUT_MS = 15_000;

/** Snapshot of a session's failing CI checks, used to render the blocked-list CI row. */
export interface ISessionCIFailures {
	/** Number of completed checks that failed. */
	readonly failed: number;
	/** Number of checks that have completed (succeeded or failed). */
	readonly completed: number;
	/** Number of checks still running or queued. */
	readonly pending: number;
}

/**
 * Provides per-session CI failure state to the sessions list so a "Fix CI" row
 * can be rendered inline (only where the provider is supplied, i.e. the
 * blocked-sessions list). Mirrors the role of the approval model for terminal
 * confirmations.
 */
export interface ISessionCIFailuresProvider {
	/**
	 * Observable of the session's failing-CI state, or `undefined` when the
	 * session has no failing checks (or the user has already requested a fix).
	 */
	getCIFailures(session: ISession): IObservable<ISessionCIFailures | undefined>;
	/** Send the `fix-ci` prompt for the session's failed checks, opening it first. */
	fixChecks(session: ISession): Promise<void>;
}

/**
 * Concrete {@link ISessionCIFailuresProvider} backed by the GitHub CI models.
 * The CI check data itself is kept warm by the GitHub polling contribution; this
 * model only observes the shared, reference-counted models for the sessions it
 * is asked about.
 */
export class SessionCIFailuresModel extends Disposable implements ISessionCIFailuresProvider {

	private readonly _perSession = new Map<string, IObservable<ISessionCIFailures | undefined>>();
	/** Session resources with a fix-CI request currently in flight (guards double submits). */
	private readonly _fixInFlight = new Set<string>();

	constructor(
		@IGitHubService private readonly _gitHubService: IGitHubService,
		@ISessionsService private readonly _sessionsService: ISessionsService,
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	getCIFailures(session: ISession): IObservable<ISessionCIFailures | undefined> {
		const key = session.resource.toString();
		let obs = this._perSession.get(key);
		if (!obs) {
			obs = derivedOpts<ISessionCIFailures | undefined>({
				owner: this,
				equalsFn: structuralEquals,
			}, reader => this._compute(reader as IReaderWithStore, session));
			this._perSession.set(key, obs);
		}
		return obs;
	}

	private _compute(reader: IReaderWithStore, session: ISession): ISessionCIFailures | undefined {
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

		// Once a fix has been requested for this head commit, hide the row until a
		// new commit lands (a new head SHA yields a fresh model without the flag).
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
		return { failed, completed, pending };
	}

	async fixChecks(session: ISession): Promise<void> {
		const key = session.resource.toString();
		// Guard against overlapping submits (e.g. rapid double clicks): the fix is
		// only remembered via `markFixRequested()` after the prompt is accepted, so
		// without this a second click could send a duplicate request.
		if (this._fixInFlight.has(key)) {
			return;
		}
		this._fixInFlight.add(key);
		try {
			await this._fixChecks(session);
		} catch (err) {
			this._logService.error('[SessionCIFailuresModel] Failed to fix CI checks for session', session.resource.toString(), err);
		} finally {
			this._fixInFlight.delete(key);
		}
	}

	private async _fixChecks(session: ISession): Promise<void> {
		const gitHubInfo = session.workspace.get()?.folders[0]?.gitRepository?.gitHubInfo.get();
		if (!gitHubInfo?.pullRequest) {
			return;
		}

		const store = new DisposableStore();
		try {
			const prRef = store.add(this._gitHubService.createPullRequestModelReference(gitHubInfo.owner, gitHubInfo.repo, gitHubInfo.pullRequest.number));
			const livePR = prRef.object.pullRequest.get();
			if (!livePR) {
				return;
			}

			const ciRef = store.add(this._gitHubService.createPullRequestCIModelReference(gitHubInfo.owner, gitHubInfo.repo, gitHubInfo.pullRequest.number, livePR.headSha));
			const ciModel = ciRef.object;

			const failedChecks = getFailedChecks(ciModel.checks.get());
			if (failedChecks.length === 0) {
				return;
			}

			const failedCheckDetails = await Promise.all(failedChecks.map(async check => {
				const annotations = await ciModel.getCheckRunAnnotations(check.id);
				return { check, annotations };
			}));

			const prompt = buildFixChecksPrompt(failedCheckDetails, getPullRequestUrl(ciModel));

			// Open the session, then wait for its chat widget to bind — `openSession`
			// resolving does not guarantee the widget's view model is set yet.
			await this._sessionsService.openSession(session.resource);
			const chatWidget = await this._waitForChatWidget(session.resource);
			if (!chatWidget) {
				this._logService.error('[SessionCIFailuresModel] Cannot fix CI checks: no chat widget for session', session.resource.toString());
				return;
			}

			const response = await chatWidget.acceptInput(prompt);
			if (response) {
				ciModel.markFixRequested();
			}
		} finally {
			store.dispose();
		}
	}

	/**
	 * Resolve the chat widget bound to the given session, waiting for it to be
	 * added and to bind its view model. Event-driven so it settles as soon as the
	 * widget appears; a generous timeout only guards against a widget that never
	 * binds so the promise cannot hang forever.
	 */
	private async _waitForChatWidget(sessionResource: URI): Promise<IChatWidget | undefined> {
		const existing = this._chatWidgetService.getWidgetBySessionResource(sessionResource);
		if (existing) {
			return existing;
		}

		const store = new DisposableStore();
		const wait = new Promise<IChatWidget>(resolve => {
			const check = (): boolean => {
				const widget = this._chatWidgetService.getWidgetBySessionResource(sessionResource);
				if (widget) {
					resolve(widget);
					return true;
				}
				return false;
			};
			const observe = (widget: IChatWidget) => {
				// A widget may bind its session view model after being added.
				store.add(widget.onDidChangeViewModel(() => check()));
			};
			for (const widget of this._chatWidgetService.getAllWidgets()) {
				observe(widget);
			}
			store.add(this._chatWidgetService.onDidAddWidget(widget => {
				observe(widget);
				check();
			}));
			check();
		});

		try {
			return await raceTimeout(wait, WAIT_FOR_WIDGET_TIMEOUT_MS);
		} finally {
			store.dispose();
		}
	}
}
