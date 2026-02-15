# Agent-Host Parity: Remaining Work

What's needed to bring the agent-host process to feature parity with VS Code's native chat agent. The agent-host runs `@github/copilot` (the Copilot SDK) in a utility process, replacing **only the agent loop**. Everything else — tools, editing, MCP, UI — stays in the renderer and gets plumbed through.

## What's Already Done

We can run the Copilot SDK in a dedicated utility process and have it appear as a chat agent in VS Code. Sessions created through the SDK show up in the agent sessions list, and you can open any of them to see their history. You can send messages and get streaming responses back in the chat widget. Multi-turn conversations work — the same SDK session is reused across messages within a chat resource. Auth tokens are forwarded from VS Code's GitHub account so the SDK can make requests. If the process crashes, it auto-restarts. Logs from the agent-host appear in a dedicated Output channel.

What you can actually *do* right now is have a conversation where the SDK uses its own built-in tools (shell, file operations, etc.) — but VS Code doesn't see or control any of that tool execution. The SDK just does its thing and streams text back.

---

## ⛔ Blocked — Not Possible Today (SDK Gaps)

These items cannot be implemented without changes to `@github/copilot` itself.

### Custom-Type Tools / Responses API (apply_patch)

The `apply_patch` tool uses OpenAI's responses API with a custom tool type. The Copilot SDK doesn't support custom-type tools or the responses API format. **Not implementable** with the SDK's agent loop. Either keep using VS Code's native agent loop for this feature, or wait for SDK support.

### LM Request Proxying / BYOK

The SDK makes its own LM requests using the GitHub token. There's no way to intercept those requests and route them through VS Code's `IChatEndpoint` or a user's own API key (BYOK). This is architecturally significant — the SDK owns the network calls. Options:
- The SDK adds support for a custom endpoint callback, allowing us to proxy requests through VS Code's LM provider infrastructure.
- We accept that BYOK users cannot use the agent-host and fall back to the native agent loop.
- **Needs investigation**: does the SDK expose any request interception or custom endpoint configuration?

### Dynamic Tool Set Changes Mid-Turn

VS Code sometimes changes the available tool set during an active turn (e.g., installing a Python extension to bootstrap notebook tools). The SDK would need to support updating available tools mid-turn. If it doesn't, new tools can only appear on the next turn.

---

## ❓ Open Questions

### Which tools do we use — ours or theirs?

The SDK has its own built-in tools (shell, file operations, etc.) and VS Code has its own (terminal, file editing, search, etc.). For example, do we use VS Code's terminal tool or the SDK's shell tool? This is very TBD. The plumbing to plug in VS Code tools exists conceptually (see #1 below), but the decision of which tools to replace is a product question.

Same question applies to MCP: do we use VS Code's MCP server management, or the SDK's MCP implementation, or both?

---

## Remaining Items

### 0. Tool Invocation Rendering — P0 (bug)

**Status:** When the SDK runs a tool, `tool_start` is currently emitted as a `progressMessage` (a transient status line that disappears when the next progress arrives). `tool_complete` is logged but not rendered at all. So tools flash briefly then vanish from the response — they should persist as proper tool invocation parts in the chat response. We also don't make use of toolSpecificData to nicely display tools like Bash.

**How:** Emit `tool_start` / `tool_complete` as `IChatToolInvocationSerialized` (or create a `ChatToolInvocation`) instead of `progressMessage`. This makes them render as collapsible tool call blocks that stay visible in the response, matching how the native agent loop displays tool use.

---

### 1. Plugging In VS Code Tools — P0

**Status:** The SDK runs its own built-in tools. We have no way to plug in VS Code tools (from extensions or built-in) to be used instead of or alongside the SDK's tools. For example, VS Code's terminal tool could replace the SDK's shell tool.

**How:** The SDK needs an API to register custom tools or intercept tool calls. The `tool.user_requested` event already fires in the SDK when a tool needs user approval — this suggests the SDK has *some* notion of external tool handling. Investigate `CopilotSession` for a tool override / custom tool handler API. Once found, implement a round-trip: SDK requests a tool call → IPC to renderer → renderer executes via `ILanguageModelToolsService` → result sent back over IPC → fed back to SDK. This unblocks #2, #9, #17, and #22.

**Open question:** Which tools do we actually replace? Do we disable all SDK built-in tools in favor of VS Code's? Just some? This is a product decision, but the plumbing should support either approach.

---

### 2. Tool Confirmation — P0

**Status:** Not plumbed. The SDK has a `tool.user_requested` event that fires when a tool needs user approval, which means the SDK already has a confirmation interface — it just needs an implementation on our side.

**How:** The SDK fires `tool.user_requested` with tool name, arguments, and a call ID. We need to implement confirmation on the renderer side: receive this event over IPC, show the VS Code confirmation UI (the same one used today — approval buttons, auto-approval settings, etc.), and send back an approve/deny response. The interface is roughly: the agent-host sends `{ type: 'tool_confirmation_request', toolName, toolCallId, arguments }` to the renderer, and the renderer responds with `{ type: 'tool_confirmation_response', toolCallId, approved: boolean }`. The SDK presumably blocks on this response before proceeding with tool execution.

---

### 3. System Prompt & Instructions Injection — P1

**Status:** The SDK uses its own system prompt. VS Code's `.instructions.md` files, `copilot-instructions.md`, skills, agent instructions, and per-model JIT instructions are all ignored.

**How:** Before sending the first message, assemble VS Code's full system prompt in the renderer and pass it to the agent-host via a `setSystemPrompt(sessionId, prompt)` IPC method. The agent-host passes it to the SDK's session config. **Needs investigation**: does the SDK support replacing or appending to the system prompt? If not, we could inject instructions as a preamble in the user message, though that's less clean.

---

### 4. Attachments / User-Selected Context — P0

**Status:** Only the plain text message is sent. File attachments, editor selections, directory references, and images attached by the user are silently discarded.

**How:** Expand `sendMessage()` to accept structured context alongside the prompt (file contents, selection ranges, images, etc.). In the agent-host, inject these into the prompt sent to the SDK. The SDK's `session.send()` may support additional context parameters — needs investigation.

---

### 5. Interrupt / Abort — P0

**Status:** Stubbed — the interrupt callback returns `true` but doesn't actually stop anything.

**How:** Add an `abortSession(sessionId)` IPC method. The SDK wrapper already has the `abort` event wired up, and the `CopilotSession` likely exposes `session.abort()`. Just wire the renderer's interrupt callback to call through.

---

### 6. Streaming Tool Call Arguments — P1

**Status:** The SDK fires `tool.execution_start` (tool name) and `tool.execution_complete`, but we don't forward the partial argument stream that happens in between.

**How:** The wrapper already has `onToolProgress` and `onToolPartialResult` events. Forward these over IPC as progress events and render them in the chat UI as streaming tool invocations (showing arguments as they're generated, before execution begins).

---

### 7. Checkpoints & Request Editing — P2

**Status:** Not exposed. Additionally, the "Restore Checkpoint" UI action is gated on `lockedToCodingAgent.negate()`, so it's hidden for agent-host sessions even if the underlying support existed.

**How:** The SDK has a `session.snapshot_rewind` event, suggesting it supports checkpoint/rewind semantics. Add IPC methods for setting and restoring checkpoints. The renderer's chat model already has `setCheckpoint()`/`resetCheckpoint()` — wire them through. The `lockedToCodingAgent` gate on the restore action also needs to be relaxed (see #26). **Needs investigation**: what API does the SDK expose for creating/restoring snapshots?

---

### 8. Compaction — P2

**Status:** Not exposed, though the SDK fires `session.compaction_start` / `session.compaction_complete` events.

**How:** Add a `compact(sessionId)` IPC method to trigger compaction on demand (for `/compact`). The SDK already does automatic compaction — we mostly need to expose the manual trigger and optionally customize the compaction prompt. **Needs investigation**: does the SDK support custom compaction prompts?

---

### 9. Hooks (Pre-Tool-Use) — P2 (builds on #1)

**Status:** Not plumbed — but the SDK itself has `hook.start` / `hook.end` events, meaning it has its own hook system.

**How:** Two paths: (a) Use the SDK's hook system if it supports user-defined hooks and we can configure them. (b) Run VS Code's own hook system (pre-tool-use hooks from `.github/hooks/`) on the renderer side when a tool request arrives, before approving execution. Path (b) is straightforward once tool execution round-trip (#1) works. **Open question**: do we use the SDK's hooks, VS Code's hooks, or both?

---

### 10. Server-Side Tools (Web Search) — P3

**Status:** The SDK handles web search internally. The renderer doesn't see or render these tool invocations.

**How:** Either let the SDK continue handling web search (and forward progress events so the renderer can show what's happening), or disable SDK-side web search and use VS Code's own web search tool via the tool execution round-trip. Probably fine to let the SDK handle this one.

---

### 11. Telemetry — P2

**Status:** Basic logging only. No token usage, no per-request telemetry, no tool invocation telemetry.

**How:** The SDK fires `assistant.usage` and `session.usage_info` events with token counts and model info. Forward these over IPC and feed them into VS Code's chat telemetry system. For tool invocation telemetry, capture tool call counts, success/failure, and latency from the tool execution round-trip.

---

### 13. MCP Server Integration — P2

**Status:** Not plumbed. VS Code manages MCP servers in the renderer; the SDK may have its own MCP implementation.

**How:** If we plug in VS Code tools (#1), MCP tools are just another kind of tool — they'd come through the same round-trip. Alternatively, forward MCP server configs to the SDK and let it manage connections directly. **Open question**: do we use VS Code's MCP or the SDK's MCP? Using VS Code's keeps everything unified and means existing MCP server configurations just work.

---

### 15. Large Tool Results to Disk — P3

**Status:** The SDK saves large tool results to disk internally. If we plug in VS Code tools instead, the renderer produces tool results and needs its own strategy.

**How:** If VS Code tools produce the results, store them on the renderer side. If the SDK produces results (using its own tools), we need access to the storage path so the renderer can read referenced files. Either way, straightforward once we decide which tools we're using.

---

### 17. Edit Session Integration — P1 (free with #1)

**Status:** File edits proposed by the agent aren't plumbed through VS Code's editing service (diff view, accept/reject, etc.).

**How:** This is free once VS Code tools are plugged in (#1). The tool implementations already create edits through `IChatEditingService` — they'll just work when invoked via the agent-host path instead of the native agent loop.

---

### 18. Model Selection — P1

**Status:** The IPC infrastructure supports passing a model when creating a session, but the UI never sends it.

**How:** Read the selected model from the chat widget's model picker and pass it through `createSession({ model })`. Trivial wiring.

---

### 23. Tool Picker — P1

**Status:** The "Configure Tools…" action is hidden when the widget is locked to a coding agent (via `lockedToCodingAgent.negate()` in `chatToolActions.ts`). Agent-host sessions use `lockToCodingAgent()`, so the tool picker is invisible. Users can't select/deselect tools for agent-host sessions.

**How:** Either: (a) remove the `lockedToCodingAgent` guard from the tool configuration action so it appears for agent-host sessions, or (b) introduce a more granular context key (e.g., `agentSupportsToolPicker`) that the agent-host agent sets. Option (a) is simpler and makes sense if tool selection should always be available. Also requires plumbing the selected tool set to the SDK session (see #1).

---

### 24. Agent / Participant Picker — P1

**Status:** When locked to an agent, the input completions filter out all other agents/participants (`widget.lockedAgentId` check in `chatInputCompletions.ts`). Users can't switch away from the agent-host agent or invoke other participants within the same session.

**How:** Decide whether agent-host sessions should allow switching participants. If yes, don't lock the widget — or make the lock more selective (suppress participant switching but keep other UI). If each agent-host session is inherently single-agent, this is expected behavior and doesn't need fixing — but should be documented as intentional.

---

### 25. Post-Request Toolbar (Redo, Continue, Edit) — P1

**Status:** The toolbar buttons that appear after a response — Redo, Continue, and Edit Request — are all gated on `lockedToCodingAgent.negate()` and therefore hidden for agent-host sessions. This means users cannot redo a request, continue the conversation from a specific point, or edit a previous request.

**How:** These actions need the locked-agent gate relaxed or replaced with a capability check. Implementation:
- **Redo**: Needs the SDK session to support re-sending from a checkpoint. Depends on #7 (Checkpoints).
- **Continue**: Should work today — just sends another message. The gate needs to be removed.
- **Edit Request**: Needs the SDK session to support rewinding to an earlier state and re-sending. Depends on #7.

---

### 26. Undo / Redo Edit Actions — P1

**Status:** The "Undo Edit Request" and redo-edit actions in `chatEditingActions.ts` are hidden by `lockedToCodingAgent.negate()`. Users can't undo file changes made by the agent-host. Also, the "Restore Checkpoint" actions are disabled (covered in #7 but the UI gate is the `lockedToCodingAgent` key).

**How:** Same pattern as #25 — relax the locked-agent gate. Undo/redo of edits requires the editing session integration (#17) to be working first. Once VS Code tools are plugged in (#1), file edits flow through `IChatEditingService` and undo/redo should work if the UI gates are opened.

---

### 27. File & Context Attachment Completions — P1

**Status:** File attachment suggestions and tool attachment suggestions in the input are conditionally hidden when locked to an agent, based on whether the agent declares `supportsPromptAttachments` and tool attachment capability. The "Add Context…" action is similarly gated (`lockedToCodingAgent.negate() OR agentSupportsAttachments`).

**How:** The agent-host agent registration in `agentHostChatContribution.ts` needs to declare the correct capabilities: `supportsPromptAttachments: true` (and tool attachments if applicable) in its `IChatAgentData.metadata`. This is a one-line fix once attachments (#4) are actually plumbed through.

---

### 28. Continue Chat In… (Delegation) — P2

**Status:** The "Continue Chat in…" action that lets users delegate a session to a background/cloud provider is hidden when `lockedToCodingAgent` is true. Agent-host sessions can't be delegated.

**How:** Remove the locked-agent gate from `chatContinueInAction.ts`. This may require the SDK to support session export/handoff (the SDK does fire `session.handoff` events, suggesting some support exists). Low priority — delegation is a secondary workflow.

---

### 19. Title Generation — P3

**Status:** Sessions display the SDK's `summary` field, but there's no on-demand title generation.

**How:** The SDK likely generates summaries automatically after the first exchange. If we need manual triggering (e.g., for rename), expose a `generateTitle(sessionId)` IPC method.

---

### 20. Thinking / Reasoning Output — P2

**Status:** Not forwarded, but the SDK fires `assistant.reasoning` and `assistant.reasoning_delta` events.

**How:** Forward reasoning deltas over IPC and render them as thinking blocks in the chat UI. The SDK already exposes this — just needs plumbing.

---

### 21. Follow-Up Suggestions — P2

**Status:** Not implemented.

**How:** **Needs investigation**: does the SDK generate follow-up suggestions? If so, forward them. If not, generate them renderer-side by making a separate LM call after the response completes (as the native agent does today).

---

### 22. References & Citations — P1 (free with #1)

**Status:** Tool results arrive as plain text with no structured file references or code citations.

**How:** Free once VS Code tools are plugged in (#1). The VS Code tool implementations already produce structured references — they'll flow naturally through the chat UI.

---

## Subagent Events

The SDK fires `subagent.started`, `subagent.completed`, `subagent.failed`, and `subagent.selected` events. These aren't in the list above because VS Code's native agent doesn't have a subagent concept exposed in the same way, but they could be rendered as progress/status in the chat UI. Low priority; worth noting for future consideration.

---

## Priority Summary

| Priority | Items | Notes |
|----------|-------|-------|
| **P0** | 0 (Tool rendering), 1 (VS Code tools), 2 (Tool confirmation), 4 (Attachments), 5 (Abort) | Unblocks real usage |
| **P1** | 3 (System prompt), 6 (Streaming args), 17 (Edits), 18 (Model selection), 22 (References), 23 (Tool picker), 24 (Agent picker), 25 (Post-request toolbar), 26 (Undo/redo edits), 27 (Attachment completions) | Core UX parity; 17+22 are free with #1; 23–27 mostly need `lockedToCodingAgent` gates relaxed |
| **P2** | 7 (Checkpoints), 8 (Compaction), 9 (Hooks), 11 (Telemetry), 13 (MCP), 20 (Thinking), 21 (Follow-ups), 28 (Delegation) | Important but not launch-blocking |
| **P3** | 10 (Server-side tools), 14 (Dynamic tools mid-turn), 15 (Large results), 19 (Titles) | Nice-to-have |
| **Blocked** | 16 (apply_patch / responses API), 12 (BYOK), 14 (Dynamic tools mid-turn) | Needs SDK changes |

### Needs Investigation (SDK API unknowns)

- Can the SDK's system prompt be replaced or appended to?
- Does `session.send()` accept structured context (files, images) beyond a text prompt?
- What API exists for registering custom tools or intercepting tool calls?
- How does `tool.user_requested` work — does the SDK block waiting for an approve/deny response?
- Does the SDK support creating/restoring snapshots for checkpoints?
- Custom compaction prompts?
- Custom LM endpoint / request interception for BYOK?
- Does the SDK generate follow-up suggestions?
