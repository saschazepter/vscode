# Chat Request Queuing and Steering Implementation Plan

This feature enables users to queue messages while a chat request is in progress, with options to either queue the message (sent after current request completes) or steer the conversation (triggers `yieldRequested` on the active request). Initial prompt:

>Language model responses can take a while, and we want to give users the ability to queue messages to be sent after the current task completes, as well as the ability to gracefully interrupt the current request and send a queued message (via the new `yieldRequested` API)
>
>Project requirements:
>
>- During a request in the chat input, currently users can't send new messages while the request is ongoing. We want to give two new options: "Add Queue Message" and "Steer with Message". These should be shown in a dropdown beside the chat input (a DropdownWithDefaultActionViewItem) and the last-used of the queue vs steer methods should be the default action.
>- After submitting the chat request, it should be shown under a dividing line titled "Pending Requests" in the chat list widget.
>- If the request was sent as a "Steering" request, then `yieldRequested` should be set on any ongoing request's context.
>- After the last request has completed, if it didn't end with an error, the next "pending request" should be sent.


## Configuration Decisions

- **Queue scope**: Session-scoped (each chat session has its own pending request queue)
- **Queue limit**: Unlimited
- **Pending requests placement**: Below last message in chat list, before input
- **Error handling**: Queue continues processing even if a request errors

---

## Phase 1: Core Infrastructure

### 1.1 Add `yieldRequested` to request pipeline

- [x] Add `yieldRequested?: boolean` to `IChatAgentRequest` in `src/vs/workbench/contrib/chat/common/participants/chatAgents.ts`
- [x] Add `yieldRequested?: boolean` to the DTO in `src/vs/workbench/api/common/extHost.protocol.ts`
- [x] Update `ChatContext` construction in `src/vs/workbench/api/common/extHostChatAgents2.ts` to pass `yieldRequested` from request
- [x] Add `isSteering?: boolean` to `IChatSendRequestOptions` in `src/vs/workbench/contrib/chat/common/chatService/chatService.ts`

### 1.2 Create pending request queue in ChatModel

- [x] Create `IChatPendingRequest` interface in `src/vs/workbench/contrib/chat/common/model/chatModel.ts`
- [x] Add `_pendingRequests: IChatPendingRequest[]` array to `ChatModel` class
- [x] Add `_onDidChangePendingRequests` emitter and `onDidChangePendingRequests` event
- [x] Implement `queueRequest(message: string, options?: IChatSendRequestOptions, isSteering?: boolean): void`
- [x] Implement `dequeuePendingRequest(): IChatPendingRequest | undefined`
- [x] Implement `getPendingRequests(): readonly IChatPendingRequest[]`
- [x] Implement `removePendingRequest(id: string): void`
- [x] Implement `clearPendingRequests(): void`
- [x] Expose methods through `IChatModel` interface

### 1.3 Update ChatService for queue processing

- [x] Add `isSteering?: boolean` to `IChatSendRequestOptions` in `src/vs/workbench/contrib/chat/common/chatService/chatService.ts`
- [x] Add `setYieldRequested()` method to `IChatService` interface and implement in `ChatService`
- [x] Modify `sendRequest()` in `src/vs/workbench/contrib/chat/common/chatService/chatServiceImpl.ts`:
  - When `_pendingRequests.has(sessionResource)`, queue the request instead of returning early
  - Pass `isSteering` through the request pipeline
- [x] After request completion in `_sendRequestAsync`, check queue and process next request

---

## Phase 2: Context Keys and State

### 2.1 Add queue-related context keys

- [x] Add `hasPendingRequests` and `pendingRequestCount` context keys to `src/vs/workbench/contrib/chat/common/actions/chatContextKeys.ts`

### 2.2 Bind context keys in chat widget

- [ ] Update `src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts` to:
  - Create context key instances for `hasPendingRequests` and `pendingRequestCount`
  - Subscribe to `model.onDidChangePendingRequests` and update context keys
  - Clear context keys when session changes

---

## Phase 3: Actions and UI

### 3.1 Create queue actions

- [x] Create new file `src/vs/workbench/contrib/chat/browser/actions/chatQueueActions.ts`
- [x] Implement `ChatQueueMessageAction`
- [x] Implement `ChatSteerWithMessageAction`
- [x] Implement `ChatRemovePendingRequestAction`
- [x] Export `registerChatQueueActions()` function

### 3.2 Register queue menu

- [x] Add `MenuId.ChatExecuteQueue` in `src/vs/platform/actions/common/actions.ts`
- [x] Register actions to `MenuId.ChatExecuteQueue` with appropriate `when` clauses

### 3.3 Register actions in contribution

- [x] Import and call `registerChatQueueActions()` in `src/vs/workbench/contrib/chat/browser/chat.contribution.ts`

### 3.4 Add dropdown to execute toolbar

- [x] Update `src/vs/workbench/contrib/chat/browser/actions/chatQueueActions.ts`:
  - Create submenu action for `MenuId.ChatExecuteQueue`
  - Use `DropdownWithDefaultActionViewItem` with `togglePrimaryAction: true`
  - Storage key: `'chatExecuteQueue_lastActionId'`
  - Show only when `ChatContextKeys.requestInProgress` && `ChatContextKeys.inputHasText`

---

## Phase 4: Chat List Rendering

### 4.1 Create pending request view models

- [x] Add `IChatPendingRequestViewModel` and `IChatPendingDividerViewModel` to `src/vs/workbench/contrib/chat/common/model/chatViewModel.ts`
- [x] Add type guards: `isPendingRequestVM()`, `isPendingDividerVM()`
- [x] Update `ChatViewModel.getItems()` to append pending divider + pending requests after regular items

### 4.2 Update chat tree item types

- [x] Update `ChatTreeItem` union type in `src/vs/workbench/contrib/chat/browser/chat.ts`
- [x] Fix type narrowing in content parts that access ChatTreeItem properties

### 4.3 Render pending items in list

- [x] Update `src/vs/workbench/contrib/chat/browser/widget/chatListRenderer.ts`:
  - Add imports for pending types
  - Implement `renderPendingItem()` method
  - Handle pending items in `renderChatTreeItem()` dispatch

### 4.4 Add CSS styles

- [ ] Add to `src/vs/workbench/contrib/chat/browser/widget/media/chat.css`:
  - `.pending-divider-content` and `.pending-request-content` styling

---

## Phase 5: Extension Host Integration

### 5.1 Update protocol for yieldRequested updates

- [ ] Add `$setYieldRequested(sessionResource: UriComponents, requestId: string): void` to `MainThreadChatAgentsShape2` in `src/vs/workbench/api/common/extHost.protocol.ts`
- [ ] Implement in `src/vs/workbench/api/browser/mainThreadChatAgents2.ts`

### 5.2 Update extension host to observe yieldRequested

- [ ] In `src/vs/workbench/api/common/extHostChatAgents2.ts`:
  - Store `yieldRequested` state per in-flight request
  - Update `chatContext.yieldRequested` when `$setYieldRequested` is called
  - Make `yieldRequested` observable or provide getter

---

## Phase 6: Edge Cases and Cleanup

### 6.1 Handle session lifecycle

- [ ] Clear pending queue when session is cleared (`ChatModel.clear()`)
- [ ] Clear pending queue when session is disposed
- [ ] Handle session transfer (transfer pending queue with session)

### 6.2 Handle request completion states

- [ ] On successful completion: process next queued request
- [ ] On error completion: continue processing queue (don't block on errors)
- [ ] On cancellation: continue processing queue

### 6.3 Serialization (if needed)

- [ ] Add pending requests to session serialization in `ChatModel.toJSON()`
- [ ] Restore pending requests in `ChatModel.fromJSON()`

---

## Phase 7: Testing

### 7.1 Unit tests

- [ ] Create `src/vs/workbench/contrib/chat/test/common/chatQueue.test.ts`:
  - Test `queueRequest()` adds to queue
  - Test `dequeuePendingRequest()` returns and removes first item
  - Test `removePendingRequest()` removes specific item
  - Test `clearPendingRequests()` empties queue
  - Test `onDidChangePendingRequests` fires appropriately

- [ ] Add tests to `src/vs/workbench/contrib/chat/test/common/chatService/chatService.test.ts`:
  - Test queuing request when another is in progress
  - Test steering sets `yieldRequested` on active request
  - Test queue processing after request completion
  - Test queue processing continues after error
  - Test queue cleared on session clear

### 7.2 Integration tests

- [ ] Test end-to-end flow with mock chat participant
- [ ] Verify `yieldRequested` is received by participant

### 7.3 Manual testing checklist

- [ ] Start long-running chat request
- [ ] Use "Add Queue Message" - verify appears in pending section
- [ ] Use "Steer with Message" - verify `yieldRequested` behavior
- [ ] Verify queued messages process in order after completion
- [ ] Verify remove button works on pending requests
- [ ] Verify dropdown remembers last-used action
- [ ] Verify pending section hides when queue is empty

---

## Phase 8: Validation

- [ ] Run `VS Code - Build` task and verify no compilation errors
- [ ] Run `npm run valid-layers-check` for layering validation
- [ ] Run `scripts/test.bat --grep "chat"` for existing test regression
- [ ] Run hygiene checks with `gulp hygiene`

---

## Files to Create

1. `src/vs/workbench/contrib/chat/browser/actions/chatQueueActions.ts`
2. `src/vs/workbench/contrib/chat/test/common/chatQueue.test.ts`

## Files to Modify

1. `src/vs/workbench/contrib/chat/common/participants/chatAgents.ts`
2. `src/vs/workbench/api/common/extHost.protocol.ts`
3. `src/vs/workbench/api/common/extHostChatAgents2.ts`
4. `src/vs/workbench/contrib/chat/common/chatService/chatService.ts`
5. `src/vs/workbench/contrib/chat/common/chatService/chatServiceImpl.ts`
6. `src/vs/workbench/contrib/chat/common/model/chatModel.ts`
7. `src/vs/workbench/contrib/chat/common/model/chatViewModel.ts`
8. `src/vs/workbench/contrib/chat/common/actions/chatContextKeys.ts`
9. `src/vs/workbench/contrib/chat/browser/chat.ts`
10. `src/vs/workbench/contrib/chat/browser/chat.contribution.ts`
11. `src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts`
12. `src/vs/workbench/contrib/chat/browser/widget/input/chatInputPart.ts`
13. `src/vs/workbench/contrib/chat/browser/widget/chatListRenderer.ts`
14. `src/vs/workbench/contrib/chat/browser/widget/media/chat.css`
15. `src/vs/platform/actions/common/actions.ts`
16. `src/vs/workbench/api/browser/mainThreadChatAgents2.ts`
17. `src/vscode-dts/vscode.proposed.chatParticipantPrivate.d.ts` (already has `yieldRequested`)
