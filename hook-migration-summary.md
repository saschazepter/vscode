# Chat Hooks Execution Migration Summary

**Date:** 2026-02-09
**Branch (vscode):** main (uncommitted changes)
**Branch (vscode-copilot-chat):** roblou/poised-panda-release (uncommitted changes)

## What Was Done

Migrated chat hook execution from VS Code core to the Copilot Chat extension. Previously, the extension called `vscode.chat.executeHook()` which routed through VS Code's `HooksExecutionService` → proxy → `extHostHooksNode.$runHookCommand` → spawn. Now the extension executes hook commands directly using its own `NodeHookExecutor`.

## Architecture Before

```
Extension (ChatHookService)
  → vscode.chat.executeHook() API
    → extHostHooksNode.executeHook()
      → mainThreadHooks.$executeHook()
        → HooksExecutionService.executeHook()
          → HooksExecutionService._runSingleHook()
            → proxy.runHookCommand()
              → extHostHooksNode.$runHookCommand()
                → spawn (shell command)
```

## Architecture After

```
Extension (ChatHookService)
  → NodeHookExecutor.executeCommand()
    → spawn (shell command)

VS Code still handles Pre/PostToolUse hooks internally:
languageModelToolsService
  → HooksExecutionService.executePreToolUseHook()
    → HooksExecutionService.executeHook() [internal]
      → proxy.runHookCommand()
        → extHostHooksNode.$runHookCommand()
          → spawn
```

## Changes by File

### VS Code (vscode2)

#### DTS Changes
- **vscode.proposed.chatHooks.d.ts** — Version bumped to 5. Removed `ChatHookExecutionOptions` type and `vscode.chat.executeHook()` API. Kept `ChatHookCommand`, `ChatRequestHooks`, `ChatHookResult`, `ChatHookResultKind`, `ChatResponseHookPart`, `hookProgress`. Removed `shellType` from `ChatHookCommand`.
- **vscode.proposed.chatParticipantPrivate.d.ts** — Added `readonly hooks?: ChatRequestHooks` to `ChatRequest` so the extension receives resolved hook commands directly.
- **extensionsApiProposals.ts** — Version bumped to 5.

#### API Layer
- **extHost.api.impl.ts** — Removed `vscode.chat.executeHook` implementation and `IExtHostHooks` import.
- **extHost.protocol.ts** — Removed `$executeHook` from `MainThreadHooksShape`.
- **extHostHooks.ts** — Removed `executeHook` from `IExtHostHooks` interface, removed `IChatHookExecutionOptions` type.
- **extHostHooksNode.ts** — Removed `executeHook` method, removed `IExtHostRpcService` dependency (no longer needs `MainThreadHooksShape` proxy for executeHook). Kept `$runHookCommand` (still needed for PreToolUse/PostToolUse hooks).
- **extHostHooksWorker.ts** — Same cleanup as node version. Kept `$runHookCommand` stub.
- **mainThreadHooks.ts** — Removed `$executeHook` implementation. Kept proxy setup for `runHookCommand`.
- **extHostTypeConverters.ts** — Added `ChatRequestHooksConverter` and `ChatHookCommand` converters to pass resolved hooks on `request.hooks`. Removed `ChatHookResult.to` converter (no longer needed). Uses `resolveEffectiveCommand(hook, OS)` for platform-specific command resolution.

#### HooksExecutionService Cleanup
- **hooksExecutionService.ts** — Removed from public interface: `executeHook`, `IHooksExecutionOptions`, `IHookExecutedEvent`, `onDidExecuteHook`. Removed internal: `_sessionTranscriptPaths`, `_extractTranscriptPath`. `executeHook` remains as a public method on the class (used by tests) but not on the interface. Fixed `stopReason` check to use `!== undefined`.

#### Other
- **chatSubagentContentPart.ts** — Conflict resolution: kept upstream's `isParentSubagentTool()`, removed stale `modelName` property, removed unused `MutableDisposable` import.
- **extHostHooks.test.ts** — Updated test setup to match new `NodeExtHostHooks` constructor (no more RPC service).

### Extension (vscode-copilot-chat2)

#### New Files
- **src/platform/chat/common/hookExecutor.ts** — `IHookExecutor` service interface with `HookCommandResultKind` enum (Success=1, Error=2 for exit code 2, NonBlockingError=3 for other non-zero).
- **src/platform/chat/node/hookExecutor.ts** — `NodeHookExecutor` implementation. Spawns commands with `shell: true`, handles timeout/cancellation with SIGTERM→SIGKILL escalation, parses JSON stdout, converts URI-like objects to filesystem paths in stdin input.
- **src/platform/chat/test/node/hookExecutor.spec.ts** — 15 vitest tests covering success, JSON parsing, exit code semantics, stderr capture, stdin input, env vars, cwd, URI conversion, cancellation, timeout.

#### Modified Files
- **src/platform/chat/common/chatHookService.ts** — Changed `IChatHookService.executeHook` signature from `(hookType, options, sessionId?, token?)` to `(hookType, hooks, input, sessionId?, token?)`. No longer takes `ChatHookExecutionOptions` with `toolInvocationToken`.
- **src/extension/chat/vscode-node/chatHookService.ts** — Completely rewritten. Now uses `NodeHookExecutor` directly instead of `vscode.chat.executeHook`. Builds common input (timestamp, hookEventName, transcript_path), iterates hook commands, converts `IHookCommandResult` to `ChatHookResult` with proper exit code semantics including `continue: false` handling.
- **src/extension/extension/vscode-node/services.ts** — Added `IHookExecutor` → `NodeHookExecutor` DI registration.
- **src/extension/intents/node/toolCallingLoop.ts** — All `executeHook` calls updated to pass `this.options.request.hooks` and input directly.
- **src/extension/prompt/node/defaultIntentRequestHandler.ts** — `UserPromptSubmit` hook call updated.
- **src/extension/prompts/node/agent/summarizedConversationHistory.tsx** — `PreCompact` hook call updated.
- **src/extension/vscode.proposed.chatHooks.d.ts** — Synced with VS Code.
- **src/extension/vscode.proposed.chatParticipantPrivate.d.ts** — Synced with VS Code (adds `hooks` property).

#### Test Updates
- **toolCallingLoopHooks.spec.ts** — Updated `MockChatHookService.executeHook` to match new signature.
- **hookExecutor.spec.ts** — Tests for exit code 2 (blocking error) vs exit code 1 (non-blocking warning).

## What Still Needs Attention

1. **PreToolUse/PostToolUse hooks** — These still execute via the VS Code side's `HooksExecutionService` → proxy → `$runHookCommand` path. A future migration could move these to the extension too, which would fully eliminate the proxy mechanism.

2. **Cross-proposal type coupling** — `ChatRequest.hooks` (in chatParticipantPrivate) references `ChatRequestHooks` (in chatHooks). If proposals can be enabled independently, this could cause DTS compilation issues. Currently works because the Copilot Chat extension enables both.

3. **Shell selection parity** — `NodeHookExecutor` in the extension always uses `shell: true`. The VS Code side's `extHostHooksNode.$runHookCommand` preserves explicit PowerShell/bash handling via `getEffectiveCommandSource`. The extension-side hooks don't need this because commands are already resolved for the platform via `resolveEffectiveCommand` before being passed to the extension in `request.hooks`.

4. **Pre-existing build errors** — VS Code's watch build shows errors about `ChatHookType`/`ChatHookResult` not found. These are pre-existing (exist on clean main) due to DTS proposal aggregation, not caused by these changes.

5. **URI-like conversion heuristic** — `NodeHookExecutor` converts any object with `scheme` + `path` keys to a filesystem path when serializing stdin input. This could accidentally rewrite non-URI objects. The VS Code side uses `isUriComponents()` which is more precise.
