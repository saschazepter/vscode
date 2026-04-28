# Task List: Separate GitHub PR Review Threads Model

## Phase 1: Foundation

- [x] Task 1: Introduce `GitHubPullRequestReviewThreadsModel`
  - [x] Add review-thread observable with empty initial state.
  - [x] Add refresh, mutation refresh, independent polling, and disposal behavior.
  - [x] Add focused model tests.

- [x] Task 2: Add `IGitHubService.getPullRequestReviewThreads()`
  - [x] Cache review-thread models by owner/repo/prNumber.
  - [x] Dispose cached review-thread models through `GitHubService`.
  - [x] Add service caching tests.

## Checkpoint: Foundation

- [x] New model and service API reviewed before consumer rewiring.
- [x] Tests cover review-thread fetch without pull request metadata fetch.

## Phase 2: Consumer Rewire

- [x] Task 3: Rewire `CodeReviewService`
  - [x] Use review-threads model for observable thread state.
  - [x] Use review-threads model for initial fetch and polling.
  - [x] Use review-threads model for resolving PR review threads.

- [ ] Task 4: Make `GitHubPullRequestModel` lightweight
  - [ ] Remove review-thread observable and thread-specific APIs.
  - [ ] Keep pull request, reviews, mergeability, and issue-comment behavior.
  - [ ] Update tests and search for stale thread references.

## Checkpoint: Consumer Rewire

- [ ] Active-session PR refresh no longer calls GraphQL review-thread fetch.
- [ ] PR review UI still loads and resolves unresolved review threads.
- [ ] CI and PR icon consumers still work from `pullRequest` state.

## Phase 3: Validation

- [ ] Task 5: Validate types, tests, layers, and hygiene
  - [ ] Check `VS Code - Build` task output or run `npm run compile-check-ts-native`.
  - [ ] Run focused GitHub model/service unit tests.
  - [ ] Run `npm run valid-layers-check`.
  - [ ] Run hygiene for touched files.

## Final Checkpoint

- [ ] Review-thread state and polling live in the extracted model.
- [ ] Pull request metadata and mergeability polling remain lightweight.
- [ ] Validation results are captured in the implementation summary.