# Deferred Chat Target Selection - Implementation Summary

## Problem Statement
Originally, when a user changed the chat target (local, cloud, background, etc.) in the picker, it immediately created/switched the session resource. This required providers to be loaded ahead of time and created resources eagerly that might not be used.

## New Requirement
Defer determining the resource until the send button is clicked. Track the target selection without creating resources, allowing:
1. Async loading of providers without requiring them upfront
2. Better performance by deferring resource allocation
3. More flexible architecture for different chat contexts

## Solution Architecture

### Key Components

**1. Pending Initial Target (`_pendingInitialTarget`)**
- New field in `ChatInputPart` to track target selection before any session exists
- Separate from `_pendingDelegationTarget` which is for switching existing sessions
- Cleared when view model changes (session created)

**2. Updated Picker Behavior**
- `SessionTypePickerActionItem._run()` now checks if a session exists
- If no session: sets `_pendingInitialTarget` instead of executing command
- If session exists: executes command to create new session (existing behavior)
- Label/UI reflects the pending selection

**3. Deferred Session Creation**
- `ChatWidget._acceptInput()` checks for `pendingInitialTarget` before sending
- If present and no viewModel, calls `_createSessionForPendingTarget()`
- Creates session via command execution with correct target type
- Session creation is synchronous within the send flow

**4. Context Key Updates**
- `updateAgentSessionTypeContextKey()` prioritizes: pending initial > pending delegation > actual session
- UI accurately reflects pending state throughout the application

### Code Flow

```
User selects target in picker
  ↓
SessionTypePickerActionItem._run()
  ↓
No session exists?
  ↓ YES
setPendingInitialTarget(targetType)
  ↓
UI updates to show pending selection
  ↓
User clicks send
  ↓
ChatWidget._acceptInput()
  ↓
Check pendingInitialTarget?
  ↓ EXISTS
_createSessionForPendingTarget(targetType)
  ↓
Execute command to create session
  ↓
Wait for viewModel to be set
  ↓
Continue with normal send flow
```

## Files Modified

### chat.ts
- Restored `ISessionTypePickerDelegate` interface (removed in previous refactor)
- Added `getPendingInitialTarget` and `setPendingInitialTarget` methods
- Documented distinction between initial target and delegation target

### chatInputPart.ts
- Added `_pendingInitialTarget` field
- Added `pendingInitialTarget` getter and `setPendingInitialTarget()` method
- Updated `updateAgentSessionTypeContextKey()` to prioritize pending initial target
- Clear pending initial target on view model change
- Wire pending initial target into sessionPickerState delegate

### sessionTargetPickerActionItem.ts
- Modified `_run()` to check for existing session
- Set pending target if no session, execute command if session exists
- Updated `_getSelectedSessionType()` to prioritize pending initial target

### chatWidget.ts
- Added `ICommandService` dependency
- Added `_createSessionForPendingTarget()` method to create session at send time
- Modified `_acceptInput()` to check and handle pending initial target
- Determines position (sidebar/editor) from viewContext

## Benefits

✅ **Deferred Resource Allocation**: Resources created only when needed (on send)
✅ **Async Provider Support**: Providers can load lazily without blocking input creation
✅ **Flexible Architecture**: Clean separation between selection and creation
✅ **Backward Compatible**: Existing delegation pattern still works
✅ **Better Performance**: No unnecessary session creation for abandoned selections

## Testing Considerations

- Select target without sending → should not create session
- Select target, then send → should create session with correct type
- Switch targets multiple times → should use last selected on send
- Existing session + target change → should still use command (existing behavior)
- Clear input after target selection → pending target should persist
- Create new session → should clear pending target

## Future Enhancements

- Add telemetry for pending target selections that never send
- Add UI indication of "pending" state (e.g., grayed out until send)
- Consider auto-loading provider when target is selected (but defer resource creation)
- Handle edge cases like rapid target switching
