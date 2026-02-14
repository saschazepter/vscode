## Chat Sessions / Background Agent Architecture

There are **three layers** that connect to form a chat session type (like "Background Agent" / "Copilot CLI"):

### Layer 1: `chatSessions` Extension Point (package.json)

In package.json, the extension contributes to the `"chatSessions"` extension point. Each entry declares a session **type** (used as a URI scheme), a **name** (used as a chat participant name like `@cli`), display metadata, capabilities, slash commands, and a `when` clause for conditional availability.

Three session types are currently registered: `copilotcli` (Background Agent), `claude-code` (Claude), and `copilot-cloud-agent` (Cloud Agent).

### Layer 2: VS Code Platform — Extension Point + Service

On the VS Code side:

- chatSessions.contribution.ts — Registers the `chatSessions` extension point via `ExtensionsRegistry.registerExtensionPoint`. When extensions contribute to it, the `ChatSessionsService` processes each contribution: it sets up context keys, icons, welcome messages, commands, and — critically — if `canDelegate` is true, it also **registers a dynamic chat agent** via `IChatAgentService.registerAgent()`.

- chatSessionsService.ts — The `IChatSessionsService` interface. It manages two kinds of providers:
  - **`IChatSessionItemController`** — Lists available sessions (e.g., "show me all my background agent runs")
  - **`IChatSessionContentProvider`** — Provides the actual session content (history + request handler) when you open a specific session

- agentSessions.ts — The `AgentSessionProviders` enum maps well-known types to their string identifiers:
  - `Local` = `'local'`
  - `Background` = `'copilotcli'`
  - `Cloud` = `'copilot-cloud-agent'`
  - `Claude` = `'claude-code'`
  - `Codex` = `'openai-codex'`
  - `AgentHost` = `'agent-host'`

### Layer 3: Extension Side Registration

In chatSessions.ts (`ChatSessionsContrib`), each session type registers **three things** via the proposed API:

1. **`vscode.chat.registerChatSessionItemProvider(type, provider)`** — Provides the list of sessions
2. **`vscode.chat.createChatParticipant(type, handler)`** — Creates the chat participant that handles user requests
3. **`vscode.chat.registerChatSessionContentProvider(type, contentProvider, chatParticipant)`** — Binds the content provider to the participant, so when a session is opened, the content provider loads history and the participant handles new requests

### How They Connect

```
package.json "chatSessions" contribution
     │
     │  (extension point processed by ChatSessionsService)
     ▼
  VS Code registers:
  - Dynamic chat agent (if canDelegate)
  - Menu items, commands, context keys
  - Activation event: onChatSession:{type}
     │
     │  (activation triggers extension code)
     ▼
  Extension registers via proposed API:
  - ChatSessionItemProvider  ←→  lists sessions
  - ChatParticipant          ←→  handles requests
  - ChatSessionContentProvider ←→  provides session content + binds the participant
```

### Agent Host: Internal (Non-Extension) Registration

The `agent-host` session type bypasses the extension point entirely. Instead, `AgentHostChatContribution` (a desktop-only workbench contribution) directly registers:

1. **Dynamic chat agent** via `IChatAgentService.registerDynamicAgent()` — makes `@agent-host` available
2. **Session item controller** via `IChatSessionsService.registerChatSessionItemController('agent-host', ...)` — lists SDK sessions
3. **Session content provider** via `IChatSessionsService.registerChatSessionContentProvider('agent-host', ...)` — loads history, provides request handler
4. **Session type picker entry** — hardcoded in `sessionTargetPickerActionItem.ts` alongside "Local"
5. **New session command** — `workbench.action.chat.openNewChatSessionInPlace.agent-host` registered in `electron-browser/chat.contribution.ts`

Because there is no `chatSessions` extension point contribution for `agent-host`, the widget lock mechanism (`lockToCodingAgent`) was extended in `chatViewPane.ts` and `chatEditor.ts` to fall back to checking `IChatAgentService.getAgent(sessionType)` when no contribution exists. This ensures the widget locks to the correct agent for internally-registered session types.

### All Entry Points to Think About

| # | Entry Point | File |
|---|-------------|------|
| 1 | **package.json `chatSessions` contribution** | package.json — declares type, name, capabilities, commands, `when` |
| 2 | **Extension point handler** | chatSessions.contribution.ts — processes contributions, registers agents + menus |
| 3 | **Service interface** | chatSessionsService.ts — `IChatSessionsService`, `IChatSessionItemController`, `IChatSessionContentProvider` |
| 4 | **Proposed API** | vscode.proposed.chatSessionsProvider.d.ts — ext API for `registerChatSessionItemProvider`, `registerChatSessionContentProvider`, `createChatParticipant` |
| 5 | **Extension registration** | chatSessions.ts — `ChatSessionsContrib` wires everything together |
| 6 | **Background Agent item provider** | copilotCLIChatSessionsContribution.ts — `CopilotCLIChatSessionItemProvider` + `CopilotCLIChatSessionContentProvider` + `CopilotCLIChatSessionParticipant` |
| 7 | **Cloud Agent provider** | copilotCloudSessionsProvider.ts — implements both item + content provider |
| 8 | **Claude item/content/participant providers** | claudeChatSessionItemProvider.ts, claudeChatSessionContentProvider.ts, claudeChatSessionParticipant.ts |
| 9 | **Agent session provider enum** | agentSessions.ts — `AgentSessionProviders` maps types to strings |
| 10 | **Agent Host contribution** | agentHostChatContribution.ts — internal (non-extension) agent, session controller, content provider, auth |
| 11 | **Agent Host process** | src/vs/platform/agent/ — utility process, Copilot SDK integration |
| 12 | **CLI agent contribution** | contribution.ts — `CopilotCLIContrib` registers CLI-specific commands, tools, MCP server |
| 13 | **Menu contributions** | [package.json `chat/chatSessions` menu](vscode-copilot-chat2/package.json) — context menu items conditioned on `chatSessionType` |
| 14 | **Configuration** | package.json — `github.copilot.chat.backgroundAgent.enabled` setting |

The key insight: the `chatSessions` package.json contribution declares the session type **and** implicitly creates a dynamic chat participant (via the `name` field). The extension then separately registers an `ItemProvider` (for listing), a `ContentProvider` (for content/history), and a `ChatParticipant` (for handling requests), all keyed on the same **type** string (e.g., `'copilotcli'`). The `registerChatSessionContentProvider` call is what **binds** the content provider to the participant.

For the `agent-host` type, all of this is done internally from a single workbench contribution without any extension involvement.
