# Implementation Plan: Separate GitHub PR Review Threads Model

## Overview

Extract review-thread state and polling out of `GitHubPullRequestModel` into a dedicated model so lightweight pull request data and mergeability can refresh independently from the more expensive GraphQL review-thread query. The resulting split should preserve current code-review behavior while ensuring active-session PR refreshes do not fetch review threads.

## Existing Context

- `GitHubPullRequestModel` currently owns pull request data, reviews, mergeability, review threads, issue comments, review-thread replies, thread resolution, and a single polling scheduler.
- `GitHubActiveSessionRefreshContribution` calls `prModel.refresh()` when the active session changes. Today that refresh includes review threads.
- `CodeReviewService` is the only runtime consumer of `reviewThreads`, `refreshThreads()`, and `resolveThread()`.
- CI-related views and actions consume `GitHubPullRequestModel.pullRequest` only, then use `GitHubPullRequestCIModel` for checks.
- `GitHubPRFetcher.getReviewThreads()` uses GraphQL and is separate from the REST calls used by pull request data and reviews.

## Dependency Graph

```text
GitHubApiClient
    |
    +-- GitHubPRFetcher
            |
            +-- GitHubPullRequestModel
            |       |
            |       +-- pullRequest observable
            |       +-- reviews observable
            |       +-- mergeability observable
            |       +-- GitHubActiveSessionRefreshContribution
            |       +-- ChecksViewModel / checks actions / session PR icon
            |
            +-- GitHubPullRequestReviewThreadsModel (new)
                    |
                    +-- reviewThreads observable
                    +-- refresh/startPolling/stopPolling
                    +-- postReviewComment/resolveThread
                    +-- CodeReviewService PR review state

GitHubService
    |
    +-- caches GitHubPullRequestModel by owner/repo/prNumber
    +-- caches GitHubPullRequestReviewThreadsModel by owner/repo/prNumber (new)
    +-- caches GitHubPullRequestCIModel by owner/repo/headRef
```

## Architecture Decisions

- Add `GitHubPullRequestReviewThreadsModel` instead of adding conditional flags to `GitHubPullRequestModel.refresh()`. This gives review threads their own lifecycle, polling interval, tests, and cache entry.
- Keep `GitHubPRFetcher` as the shared stateless fetcher. The expensive/cheap split belongs in models and service ownership, not in duplicated fetcher classes.
- Add a new `IGitHubService.getPullRequestReviewThreads(owner, repo, prNumber)` method so consumers choose the data lifecycle they need explicitly.
- Leave `postIssueComment()` on `GitHubPullRequestModel` because it is PR-level issue-comment behavior, not review-thread state.
- Move `postReviewComment()` and `resolveThread()` to the review-threads model because both mutate thread state and should refresh only that model after mutation.
- Use a longer default review-thread poll interval than PR metadata polling, unless product direction chooses another cadence. A proposed starting point is 5 minutes for review threads and 1 minute for lightweight PR data.

## Task List

### Phase 1: Foundation

## Task 1: Introduce Review Threads Model

**Description:** Create a dedicated model for review threads that owns the `reviewThreads` observable, thread refresh, review-thread polling, review replies, and thread resolution.

**Acceptance criteria:**

- [ ] `GitHubPullRequestReviewThreadsModel` exposes `reviewThreads: IObservable<readonly IGitHubPullRequestReviewThread[]>` with an initial empty array.
- [ ] `refresh()` fetches `GitHubPRFetcher.getReviewThreads()` and updates only the thread observable.
- [ ] `postReviewComment()` and `resolveThread()` delegate to `GitHubPRFetcher`, then refresh thread state.
- [ ] The model has its own `RunOnceScheduler`, default poll interval, `startPolling()`, `stopPolling()`, and disposal behavior.

**Verification:**

- [ ] Add/update unit tests in `src/vs/sessions/contrib/github/test/browser/githubModels.test.ts` for initial state, refresh, mutation refresh, and polling start/stop.
- [ ] Confirm no pull request or review REST calls are made by thread-model refresh tests.

**Dependencies:** None

**Files likely touched:**

- `src/vs/sessions/contrib/github/browser/models/githubPullRequestReviewThreadsModel.ts`
- `src/vs/sessions/contrib/github/test/browser/githubModels.test.ts`

**Estimated scope:** Medium: 2 files

## Task 2: Add Service Cache and API

**Description:** Extend `IGitHubService` and `GitHubService` with a cached accessor for the new review-threads model, using the same owner/repo/prNumber key scheme as `getPullRequest()`.

**Acceptance criteria:**

- [ ] `IGitHubService` includes `getPullRequestReviewThreads(owner, repo, prNumber): GitHubPullRequestReviewThreadsModel`.
- [ ] `GitHubService` caches review-thread models independently from pull request models.
- [ ] Service disposal disposes cached review-thread models with the existing disposable map pattern.

**Verification:**

- [ ] Add tests in `src/vs/sessions/contrib/github/test/browser/githubService.test.ts` for same-key caching, different-PR separation, and dispose coverage.

**Dependencies:** Task 1

**Files likely touched:**

- `src/vs/sessions/contrib/github/browser/githubService.ts`
- `src/vs/sessions/contrib/github/test/browser/githubService.test.ts`

**Estimated scope:** Small: 2 files

### Checkpoint: Foundation

- [ ] Review the public service shape before rewiring consumers.
- [ ] Confirm the new model can be tested without modifying `CodeReviewService`.
- [ ] Confirm the new API keeps `vs/sessions` layering intact.

### Phase 2: Consumer Rewire

## Task 3: Rewire PR Code Review Thread Flow

**Description:** Update `CodeReviewService` to use `getPullRequestReviewThreads()` for PR review state, initial thread fetch, polling, and resolving threads.

**Acceptance criteria:**

- [ ] `_ensurePRReviewInitialized()` watches `reviewThreadsModel.reviewThreads` instead of `prModel.reviewThreads`.
- [ ] Initial PR review loading calls `reviewThreadsModel.refresh()`.
- [ ] Thread polling starts on the review-threads model and is stopped when PR review data is disposed.
- [ ] `resolvePRReviewThread()` calls `reviewThreadsModel.resolveThread()` and preserves the current local-state fallback behavior when GitHub resolution fails.

**Verification:**

- [ ] Add or update focused tests if a code-review service test harness exists; otherwise rely on model/service unit tests plus TypeScript validation.
- [ ] Manually inspect that `data.disposables` owns the polling stop disposable, matching existing disposable patterns.

**Dependencies:** Task 2

**Files likely touched:**

- `src/vs/sessions/contrib/codeReview/browser/codeReviewService.ts`

**Estimated scope:** Small: 1 file

## Task 4: Make PR Model Lightweight

**Description:** Remove review-thread state and thread-specific APIs from `GitHubPullRequestModel`, leaving it responsible for pull request data, reviews, mergeability, PR-level issue comments, and lightweight polling.

**Acceptance criteria:**

- [ ] `GitHubPullRequestModel.refresh()` fetches only pull request data and reviews/mergeability.
- [ ] `reviewThreads`, `refreshThreads()`, `postReviewComment()`, and `resolveThread()` are removed from `GitHubPullRequestModel`.
- [ ] `GitHubActiveSessionRefreshContribution` can continue calling `prModel.refresh()` without triggering `getReviewThreads()`.
- [ ] Remaining consumers of `GitHubPullRequestModel` compile with no thread-related references.

**Verification:**

- [ ] Update `GitHubPullRequestModel` tests so `refresh()` verifies pull request and mergeability only.
- [ ] Add a regression assertion that pull-request refresh does not call the thread fetcher.
- [ ] Search for `reviewThreads`, `refreshThreads`, `postReviewComment`, and `resolveThread` references under `src/vs/sessions` and confirm they point to the new model where appropriate.

**Dependencies:** Task 3

**Files likely touched:**

- `src/vs/sessions/contrib/github/browser/models/githubPullRequestModel.ts`
- `src/vs/sessions/contrib/github/test/browser/githubModels.test.ts`
- `src/vs/sessions/contrib/github/browser/github.contribution.ts` (likely no code change, but verify behavior)

**Estimated scope:** Medium: 2-3 files

### Checkpoint: Consumer Rewire

- [ ] Active-session refresh path updates PR metadata without GraphQL review-thread calls.
- [ ] PR review UI state still loads unresolved review threads and updates after resolve.
- [ ] CI and PR icon consumers still read `pullRequest` from `GitHubPullRequestModel` unchanged.

### Phase 3: Validation and Cleanup

## Task 5: Validate Types, Tests, and Layers

**Description:** Run the repository-required validation for a TypeScript change in `src/vs/sessions`, then fix only issues caused by this extraction.

**Acceptance criteria:**

- [ ] TypeScript compile checks pass for the modified `src` files.
- [ ] Relevant GitHub model/service tests pass.
- [ ] Layering remains valid.
- [ ] Hygiene issues introduced by the change are resolved.

**Verification:**

- [ ] Check `VS Code - Build` task output first if available; otherwise run `npm run compile-check-ts-native`.
- [ ] Run focused unit tests for `src/vs/sessions/contrib/github/test/browser/githubModels.test.ts` and `src/vs/sessions/contrib/github/test/browser/githubService.test.ts`.
- [ ] Run `npm run valid-layers-check`.
- [ ] Run the appropriate hygiene check for touched files.

**Dependencies:** Task 4

**Files likely touched:** None beyond fixes from validation

**Estimated scope:** Small: validation and targeted fixes

## Final Checkpoint: Ready for Review

- [ ] The extracted model owns all review-thread observable and polling behavior.
- [ ] Lightweight PR refresh no longer performs the expensive GraphQL review-thread query.
- [ ] Code-review behavior remains functionally equivalent for loading, displaying, and resolving PR review threads.
- [ ] Tests and validation results are recorded in the implementation summary.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Code-review state silently stops updating after the split | High | Rewire one consumer path at a time and keep `autorun` mapping unchanged except for model source. |
| Polling leaks if the new model starts polling without a matching stop | Medium | Mirror existing disposable patterns and ensure `CodeReviewService` registers a dispose callback for `stopPolling()`. |
| API churn creates ambiguous PR vs thread responsibilities | Medium | Keep service methods explicit: `getPullRequest()` for metadata/mergeability, `getPullRequestReviewThreads()` for thread state. |
| Thread polling interval is product-sensitive | Medium | Default to a conservative longer interval and leave the constant easy to tune. |

## Open Questions

- What exact default poll interval should review threads use? Proposed: 5 minutes.
- Should review-thread polling start only when the PR review UI initializes, or should any future caller be allowed to opt in independently by calling `startPolling()` on the cached thread model?