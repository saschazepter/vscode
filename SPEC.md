# Spec: GitHub Pull Request Model Polling for Agent Sessions

## Assumptions

1. This feature is scoped to the Agents window GitHub integration under `src/vs/sessions/contrib/github`.
2. "Pull request model" means `GitHubPullRequestModel`, not CI or review-thread models, unless explicitly expanded later.
3. A session is eligible for polling only when `ISession.gitHubInfo` includes `pullRequest` metadata and `ISession.isArchived` is false.
4. Deleted sessions arrive through `ISessionsManagementService.onDidChangeSessions.removed`.
5. Archived sessions remain in `getSessions()` but surface `isArchived: true`, so archive/unarchive must be detected from observables or changed-session events.
6. Polling should use the model's existing `startPolling()` and `stopPolling()` methods and the current default cadence.

## Objective

Keep GitHub pull request metadata fresh for every available agent session that has an associated PR, not only for the active session.

Target users are Agents window users who rely on PR state, mergeability, and reviews while multiple agent sessions are available. Success means available, non-archived PR-backed sessions continuously refresh their PR model, while archived or deleted sessions stop polling and release cached PR model resources.

Acceptance criteria:

- On startup, every existing non-archived session with `gitHubInfo.pullRequest` starts polling its `GitHubPullRequestModel`.
- When a new PR-backed session is added, its pull request model starts polling without waiting for the session to become active.
- When a session is archived, its pull request model stops polling and is disposed or released from the GitHub service cache when no remaining session uses the same PR.
- When a session is deleted or removed by a provider, its pull request model stops polling and is disposed or released when no remaining session uses the same PR.
- When a session is unarchived, polling resumes if the session still has PR metadata.
- The active-session immediate refresh behavior remains intact or is folded into the same contribution without changing the user-visible behavior.

## Tech Stack

- TypeScript in the VS Code `src/vs/sessions` layer.
- Existing VS Code lifecycle primitives: `Disposable`, `DisposableMap`, `DisposableStore`, and observable autoruns.
- Existing session lifecycle API: `ISessionsManagementService.getSessions()`, `onDidChangeSessions`, `ISession.isArchived`, and `ISession.gitHubInfo`.
- Existing GitHub model API: `IGitHubService.getPullRequest()` and `GitHubPullRequestModel.startPolling()/stopPolling()`.

Recommended ownership:

- Implement orchestration as a workbench contribution in `src/vs/sessions/contrib/github/browser/github.contribution.ts` or a sibling contribution file imported from there.
- Keep `GitHubService` responsible for model creation, caching, and disposal mechanics only. It should not inject or observe `ISessionsManagementService` because that would couple a domain data service to workbench/session lifecycle policy.
- Add a narrow `IGitHubService` method such as `disposePullRequest(owner, repo, prNumber)` or a reference-counted retain/release helper only if the contribution needs to remove models from the service cache safely.

Rationale:

- The question "which sessions should be polled" is workbench lifecycle policy, not GitHub API policy.
- A contribution already owns active-session PR refresh, so broadening this contribution keeps session observation in one place.
- `GitHubService` is currently a cache/factory for GitHub models. Adding session observation there would introduce a dependency from GitHub data access back to the session management surface.
- Multiple sessions can point at the same PR, so disposal must account for shared model keys.

## Commands

Compile check for TypeScript changes under `src`:

```sh
npm run compile-check-ts-native
```

Layering check:

```sh
npm run valid-layers-check
```

Focused unit tests, if test coverage is added under `src/vs/sessions/contrib/github/test`:

```sh
./scripts/test.sh --grep GitHub
```

Focused code review tests, if shared PR review polling behavior changes:

```sh
./scripts/test.sh --grep CodeReviewService
```

## Project Structure

Relevant source locations:

```text
src/vs/sessions/contrib/github/browser/github.contribution.ts
  Workbench contribution observing sessions and controlling PR model polling.

src/vs/sessions/contrib/github/browser/githubService.ts
  GitHub model cache and optional narrow release/dispose APIs.

src/vs/sessions/contrib/github/browser/models/githubPullRequestModel.ts
  Existing PR model with refresh and polling primitives.

src/vs/sessions/services/sessions/common/session.ts
  ISession and IGitHubInfo contracts.

src/vs/sessions/services/sessions/common/sessionsManagement.ts
  Session lifecycle service contract.

src/vs/sessions/contrib/github/test/browser/githubService.test.ts
  Existing GitHub service cache tests; add disposal or release tests here if the service API changes.

src/vs/sessions/contrib/github/test/browser/
  Add contribution lifecycle tests here if a test harness exists or is practical to introduce.
```

## Code Style

Follow the existing VS Code TypeScript style: tabs, single quotes for non-localized strings, explicit disposable ownership, and constructor service injection.

Illustrative shape:

```ts
class GitHubPullRequestPollingContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.contrib.githubPullRequestPolling';

	private readonly _trackedSessions = this._register(new DisposableMap<string, DisposableStore>());
	private readonly _trackedPullRequests = new Map<string, number>();

	constructor(
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@IGitHubService private readonly _gitHubService: IGitHubService,
	) {
		super();

		for (const session of this._sessionsManagementService.getSessions()) {
			this._trackSession(session);
		}

		this._register(this._sessionsManagementService.onDidChangeSessions(e => {
			for (const session of e.added) {
				this._trackSession(session);
			}
			for (const session of e.changed) {
				this._trackSession(session);
			}
			for (const session of e.removed) {
				this._untrackSession(session);
			}
		}));
	}
}
```

The final implementation should avoid duplicate polling for the same PR key and should register all per-session observable listeners in a store that is disposed when that session stops being tracked.

## Testing Strategy

- Unit-test service cache release/disposal behavior if a new `IGitHubService` release method is added.
- Unit-test the contribution lifecycle if feasible with a lightweight fake `ISessionsManagementService` and fake `IGitHubService`.
- Cover startup sessions, added sessions, archived sessions, unarchived sessions, removed sessions, and two sessions sharing the same PR.
- Before running tests, check TypeScript compilation errors first, per repository instructions.
- Run `npm run valid-layers-check` because the feature sits in `src/vs/sessions` and depends on workbench contribution registration.

## Boundaries

- Always: keep session lifecycle observation in a workbench contribution.
- Always: use existing `ISessionsManagementService` session events and observables.
- Always: avoid starting duplicate polling loops for the same owner/repo/PR key.
- Always: dispose per-session listeners when a session is removed, archived, or replaced.
- Ask first: expanding the feature to also poll CI models or review-thread models for every session.
- Ask first: changing polling intervals, adding settings, or introducing backoff/rate-limit policy.
- Ask first: changing the public session provider contract.
- Never: make `GitHubService` depend on `ISessionsManagementService`.
- Never: silently swallow GitHub API failures outside the existing model error handling.
- Never: dispose a shared PR model while another live, non-archived session still uses the same PR.

## Success Criteria

- A new or expanded GitHub workbench contribution tracks all existing and future PR-backed sessions.
- PR model polling starts only for eligible non-archived sessions.
- PR model polling stops and cached models are released for archived and removed sessions.
- Shared PR models remain alive until the last interested session is untracked.
- Existing active-session immediate refresh behavior still refreshes the PR promptly when the active session changes.
- TypeScript compile check and layering validation pass.

## Decisions

- Poll only `GitHubPullRequestModel` for this feature. CI and review-thread models keep their existing demand-driven creation and polling behavior.
- Archived and removed sessions release PR-scoped cached models immediately when no remaining non-archived session references the same PR. This includes the PR model, review-thread model, and CI models keyed by the same owner/repo/PR number.
- `IGitHubService.getPullRequestCI` takes the pull request number so CI models use the same owner/repo/PR key as the PR and review-thread model caches. The GitHub service keeps at most one CI model per pull request, for that pull request's current head ref. Requesting CI for another ref on the same pull request disposes the previously cached CI model for that pull request.
- Use the existing 60 second default cadence from `GitHubPullRequestModel.startPolling()`.
- Track sessions even before PR metadata is present so later `gitHubInfo` changes can start polling.
- Keep active-session immediate refresh as a separate contribution so active PR state refreshes promptly without changing the polling cadence.