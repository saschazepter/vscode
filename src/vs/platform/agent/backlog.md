# Agent host backlog

> **Keep this document in sync with the code.** When you complete a backlog item, remove or update it here. When you discover new work, add it. If a blocked item becomes unblocked, move it to the appropriate priority section.

Remaining work to bring the agent-host to feature parity with VS Code's native chat agent. For design decisions, see [design.md](design.md). For process architecture, see [architecture.md](architecture.md).

## Blocked (SDK gaps)

These items cannot be implemented without changes to `@github/copilot` itself.

### Custom-type tools / responses API (apply_patch)

The `apply_patch` tool uses OpenAI's responses API with a custom tool type. The Copilot SDK doesn't support custom-type tools or the responses API format. Not implementable with the SDK's agent loop.

### LM request proxying / BYOK

The SDK makes its own LM requests using the GitHub token. There's no way to intercept those requests and route them through VS Code's `IChatEndpoint` or a user's own API key. Options: SDK adds a custom endpoint callback, or BYOK users fall back to the native agent loop.

### Dynamic tool set changes mid-turn

VS Code sometimes changes the available tool set during an active turn (e.g., installing a Python extension to bootstrap notebook tools). The SDK would need to support updating available tools mid-turn.

---

## Open questions

- **Which tools do we use -- ours or theirs?** See [design.md](design.md) for context.
- Can the SDK's system prompt be replaced or appended to?
- Does `session.send()` accept structured context (files, images) beyond a text prompt?
- What API exists for registering custom tools or intercepting tool calls?
- How does `tool.user_requested` work -- does the SDK block waiting for an approve/deny response?
- Does the SDK support creating/restoring snapshots for checkpoints?
- Custom compaction prompts?
- Custom LM endpoint / request interception for BYOK?
- Does the SDK generate follow-up suggestions?

---

## P0 -- Unblocks real usage

### 1. Plugging in VS Code tools

The SDK runs its own built-in tools. We have no way to plug in VS Code tools (from extensions or built-in) to be used instead of or alongside the SDK's tools.

The SDK needs an API to register custom tools or intercept tool calls. The `tool.user_requested` event already fires when a tool needs user approval. Investigate `CopilotSession` for a tool override / custom tool handler API. Once found, implement the round-trip: SDK requests a tool call -> IPC to renderer -> renderer executes via `ILanguageModelToolsService` -> result sent back over IPC -> fed back to SDK.

### 2. Tool confirmation

Not plumbed. The SDK fires `tool.user_requested` with tool name, arguments, and a call ID. We need to implement confirmation on the renderer side: receive this event over IPC, show the VS Code confirmation UI, and send back an approve/deny response.

### 3. Attachments / user-selected context

Only the plain text message is sent. File attachments, editor selections, directory references, and images are silently discarded. Expand `sendMessage()` to accept structured context alongside the prompt.

### 4. Interrupt / abort

Stubbed -- the interrupt callback returns `true` but doesn't actually stop anything. Add an `abortSession(sessionId)` IPC method wired to `session.abort()`.

---

## P1 -- Core UX parity

### 5. System prompt and instructions injection

The SDK uses its own system prompt. VS Code's `.instructions.md` files, `copilot-instructions.md`, skills, agent instructions, and per-model JIT instructions are all ignored. Assemble VS Code's full system prompt in the renderer and pass it to the agent-host.

### 6. Streaming tool call arguments

The SDK fires `tool.execution_start` and `tool.execution_complete`, but we don't forward the partial argument stream in between. The wrapper already has `onToolProgress` and `onToolPartialResult` events -- forward these over IPC.

### 7. Edit session integration (free with #1)

File edits proposed by the agent aren't plumbed through VS Code's editing service (diff view, accept/reject, etc.). Free once VS Code tools are plugged in (#1) -- the tool implementations already create edits through `IChatEditingService`.

### 8. Model selection

The IPC infrastructure supports passing a model when creating a session, but the UI never sends it. Read the selected model from the chat widget's model picker and pass it through `createSession({ model })`.

### 9. References and citations (free with #1)

Tool results arrive as plain text with no structured file references or code citations. Free once VS Code tools are plugged in (#1).

### 10. Tool picker

The "Configure Tools..." action is hidden when locked to a coding agent. Either remove the `lockedToCodingAgent` guard or introduce a more granular context key.

### 11. Agent / participant picker

When locked to an agent, input completions filter out all other agents/participants. Decide whether agent-host sessions should allow switching participants.

### 12. Post-request toolbar (redo, continue, edit)

All gated on `lockedToCodingAgent.negate()` and hidden. Continue should work today (gate needs removing). Redo and edit request need checkpoint support (#14).

### 13. Undo / redo edit actions

Same `lockedToCodingAgent` gate. Requires edit session integration (#7) to be working first.

### 14. File and context attachment completions

Conditionally hidden when locked to an agent. The agent-host agent registration needs to declare `supportsPromptAttachments: true`. One-line fix once attachments (#3) are plumbed.

---

## P2 -- Important but not launch-blocking

### 15. Checkpoints and request editing

Not exposed. The SDK has `session.snapshot_rewind` events suggesting checkpoint/rewind support. The "Restore Checkpoint" UI action is also gated on `lockedToCodingAgent.negate()`.

### 16. Compaction

Not exposed, though the SDK fires `session.compaction_start` / `session.compaction_complete` events. Add a `compact(sessionId)` IPC method for `/compact`.

### 17. Hooks (pre-tool-use)

Not plumbed. The SDK has `hook.start` / `hook.end` events. Two paths: use the SDK's hook system, or run VS Code's own hook system on the renderer side. Path (b) is straightforward once tool execution round-trip (#1) works.

### 18. Telemetry

Basic logging only. No token usage, no per-request telemetry, no tool invocation telemetry. The SDK fires `assistant.usage` and `session.usage_info` events.

### 19. MCP server integration

Not plumbed. If we plug in VS Code tools (#1), MCP tools come through the same round-trip. Alternatively, forward MCP server configs to the SDK and let it manage connections.

### 20. Thinking / reasoning output

Not forwarded. The SDK fires `assistant.reasoning` and `assistant.reasoning_delta` events. Forward over IPC and render as thinking blocks.

### 21. Follow-up suggestions

Not implemented. Needs investigation: does the SDK generate follow-up suggestions?

### 22. Continue chat in... (delegation)

Hidden when `lockedToCodingAgent` is true. The SDK fires `session.handoff` events suggesting some support.

### 23. Steering messages (mid-turn user input)

VS Code supports "steering" -- sending a message while the agent is still processing a previous request (`ChatRequestQueueKind.Steering`). The SDK has native message queuing: calling `session.send()` while a turn is active enqueues the message, and the SDK fires `pending_messages.modified` when the queue changes. However, SDK queuing is "next turn" -- the queued message is processed after the current turn finishes, not injected mid-turn. This may or may not match VS Code's steering semantics depending on whether steering is supposed to influence the current tool execution or just queue for the next exchange. Needs investigation into how the native agent loop handles steering today and whether the SDK's queue-for-next-turn behavior is sufficient.

---

## P3 -- Nice to have

### 23. Server-side tools (web search)

The SDK handles web search internally. The renderer doesn't see or render these invocations. Probably fine to let the SDK handle this one.

### 24. Large tool results to disk

The SDK saves large tool results to disk internally. If we plug in VS Code tools instead, we need our own strategy.

### 25. Title generation

Sessions display the SDK's `summary` field, but there's no on-demand title generation. The SDK likely generates summaries automatically after the first exchange.

---

## Notes

### Subagent events

The SDK fires `subagent.started`, `subagent.completed`, `subagent.failed`, and `subagent.selected` events. Could be rendered as progress/status in the chat UI. Low priority.

### `lockedToCodingAgent` gates

Many UI actions are hidden for agent-host sessions because they check `lockedToCodingAgent.negate()`. Items #10-14 above are all instances of this pattern. The fix is generally to relax the gate or replace it with a capability check.
