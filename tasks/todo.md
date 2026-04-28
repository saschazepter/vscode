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

- [x] Task 4: Make `GitHubPullRequestModel` lightweight
  - [x] Remove review-thread observable and thread-specific APIs.
  - [x] Keep pull request, reviews, mergeability, and issue-comment behavior.
  - [x] Update tests and search for stale thread references.

## Checkpoint: Consumer Rewire

- [x] Active-session PR refresh no longer calls GraphQL review-thread fetch.
- [x] PR review UI still loads and resolves unresolved review threads.
- [x] CI and PR icon consumers still work from `pullRequest` state.

## Phase 3: Validation

- [x] Task 5: Validate types, tests, layers, and hygiene
  - [x] Check `VS Code - Build` task output or run `npm run compile-check-ts-native`.
  - [x] Run focused GitHub model/service unit tests.
  - [x] Run `npm run valid-layers-check`.
  - [x] Run hygiene for touched files.

## Final Checkpoint

- [x] Review-thread state and polling live in the extracted model.
- [x] Pull request metadata and mergeability polling remain lightweight.
- [x] Validation results are captured in the implementation summary.
