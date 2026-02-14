# Copilot SDK Adoption Plan — Sessions Window

> **Scope:** Sessions window (`src/vs/sessions/`) only. Regular VS Code chat (sidebar, inline, editor) stays entirely on the copilot-chat extension and is untouched.

---

## 1. Motivation

The sessions window currently depends on the **copilot-chat extension** for Background (worktree) and Cloud sessions. This creates a deep coupling:

- Session creation goes through VS Code's extension API layer (`chatSessionsProvider` proposed API)
- The chat UI reuses `ChatWidget` / `ChatInputPart` / `ChatModel` from `vs/workbench/contrib/chat/`
- Session listing depends on `ChatSessionItemProvider` registered by the extension
- The extension owns the CLI process lifecycle, agent orchestration, tool execution, and streaming

By adopting the **[Copilot SDK](https://github.com/github/copilot-sdk)** (`@github/copilot-sdk`), the sessions window can own the full stack: CLI management, session lifecycle, chat UI, and tool execution — without going through the extension API layer.

---

## 2. Architecture Overview

### Process Model (Terminal Pattern)

The sessions window renderer is **sandboxed** (`sandbox: true`, no Node.js). The Copilot SDK
needs Node.js to spawn the CLI child process. We follow the **terminal (pty host) pattern** —
the most proven architecture in VS Code for long-running child processes streaming data to
the renderer.

Three-layer architecture:

```
┌────────────────────────────────────────────────────────────────┐
│ RENDERER (sessions window)                                     │
│                                                                │
│  @ICopilotSdkService ← registerMainProcessRemoteService(...)  │
│  (automatic proxy — all calls/events go over IPC transparently)│
│                                                                │
│  Chat UI, session list, etc. just inject ICopilotSdkService    │
└──────────────────────┬─────────────────────────────────────────┘
                       │ Electron IPC (automatic via ProxyChannel)
┌──────────────────────┴─────────────────────────────────────────┐
│ MAIN PROCESS                                                   │
│                                                                │
│  CopilotSdkMainService — thin proxy to the utility process     │
│  • Spawns utility process on first use (lazy)                  │
│  • Forwards the IPC channel via MessagePort                    │
│  • Handles restart if utility process crashes                  │
│  Registers: server.registerChannel('copilotSdk', channel)      │
└──────────────────────┬─────────────────────────────────────────┘
                       │ MessagePort (UtilityProcess.connect())
┌──────────────────────┴─────────────────────────────────────────┐
│ UTILITY PROCESS (copilotSdkHost)                               │
│                                                                │
│  CopilotClient (@github/copilot-sdk)                           │
│    → spawns copilot CLI (--server --stdio)                     │
│    → manages sessions, streams events, handles tool callbacks  │
│                                                                │
│  Wrapped as IServerChannel via ProxyChannel.fromService()      │
│  Events (onSessionEvent, etc.) auto-forwarded over the channel │
└────────────────────────────────────────────────────────────────┘
```

### Why This Pattern

The renderer is sandboxed — the SDK **cannot** run there. The extension host is risky
because restarts kill all child processes. The terminal (pty host) pattern is battle-tested
for exactly this: long-running child processes streaming high-frequency data.

| Concern | How It's Handled |
|---------|-----------------|
| Renderer has no Node.js | `registerMainProcessRemoteService` creates a transparent proxy — renderer code just injects `@ICopilotSdkService` |
| SDK needs child_process | Utility process has full Node.js — spawns CLI via the SDK |
| High-frequency streaming | `ProxyChannel` auto-forwards `Event<T>` properties over IPC with buffering (same as terminal data streaming) |
| Process isolation | Utility process crash doesn't affect main process or renderer |
| Lifecycle | Utility process tied to sessions window — spawned on first use, killed on window close |
| Adding new methods | Add to interface + implement in host — proxy layers auto-handle via `ProxyChannel` |

### Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| SDK vs raw JSON-RPC | **SDK** (`@github/copilot-sdk`) | Handles CLI lifecycle, typed events, tool dispatch, streaming, auth. Avoids reimplementing the raw JSON-RPC protocol layer. |
| SDK hosting | **Utility process** via terminal pattern | Full isolation. `registerMainProcessRemoteService` gives trivial renderer-side DI. Main process is a thin proxy. |
| CLI binary | **Bundled** (npm package or build-time download) + **PATH fallback** for dev | Production users can't be expected to install the CLI. Dev workflow uses PATH discovery. |
| Chat UI | **New, purpose-built** in `src/vs/sessions/` | No dependency on `ChatWidget` / `ChatInputPart` / `ChatModel`. Clean slate. |
| Session list | **SDK-based** (`listSessions()`) | Full decoupling from copilot-chat's `ChatSessionItemProvider`. |
| Worktrees | **CLI creates, git extension manages** | CLI creates worktrees autonomously. We discover the path from `session.workspacePath`. Git extension (in the session window's extension host) handles diff stats, apply changes, commits. |
| Extension host | **Kept** for git extension, language services, terminal | Sessions window already has its own extension host. We keep it for git operations, not for the SDK. |

### Event Multiplexing

Sessions are multiplexed by session ID through a single IPC channel (matching the terminal
pattern of multiplexing by terminal ID):

```typescript
// Single event carrying all session events, demuxed by sessionId in the renderer
onSessionEvent: Event<{ sessionId: string; event: ISessionEvent }>
```

`ProxyChannel.fromService()` auto-detects `Event<T>` properties and buffers them. No manual
batching needed — the terminal streams data at higher frequency and works fine with this.

### Reference Patterns

| VS Code component | Our equivalent | Pattern file |
|-------------------|---------------|-------------|
| `ILocalPtyService` | `ICopilotSdkService` | `src/vs/platform/terminal/common/terminal.ts` |
| `ElectronPtyHostStarter` | `CopilotSdkMainService` | `src/vs/platform/terminal/electron-main/electronPtyHostStarter.ts` |
| `ptyHostMain.ts` | `copilotSdkHost.ts` | `src/vs/platform/terminal/node/ptyHostMain.ts` |
| `registerMainProcessRemoteService(ILocalPtyService, ...)` | `registerMainProcessRemoteService(ICopilotSdkService, 'copilotSdk')` | `src/vs/platform/ipc/electron-browser/services.ts` |
| `LocalTerminalBackend` (event demuxing) | Session event routing in chat UI | `src/vs/workbench/contrib/terminal/electron-browser/localTerminalBackend.ts` |

---

## 3. What the Copilot SDK Provides

From the [Node.js SDK docs](https://github.com/github/copilot-sdk/blob/main/nodejs/README.md):

### CopilotClient

```typescript
const client = new CopilotClient({
    cliPath: '/path/to/bundled/copilot',  // or omit for PATH discovery
    githubToken: '<from IAuthenticationService>',
    autoStart: true,
    autoRestart: true,
});
```

**Methods:** `start()`, `stop()`, `createSession(config)`, `resumeSession(id, config)`, `listSessions()`, `deleteSession(id)`, `ping()`, `getState()`, `listModels()`

### CopilotSession

```typescript
const session = await client.createSession({
    model: 'gpt-4.1',
    streaming: true,
    tools: [myTool],
    systemMessage: { content: '...' },
    infiniteSessions: { enabled: true },
    mcpServers: { github: { type: 'http', url: '...' } },
    customAgents: [{ name: 'reviewer', prompt: '...' }],
    onUserInputRequest: async (request) => ({ answer: '...' }),
    hooks: { onPreToolUse: async (input) => ({ permissionDecision: 'allow' }) },
});
```

**Methods:** `send(options)`, `sendAndWait(options)`, `abort()`, `getMessages()`, `destroy()`

**Events (via `session.on()`):**
- `user.message` — user prompt added
- `assistant.message` — complete response
- `assistant.message_delta` — streaming chunk
- `assistant.reasoning_delta` — reasoning/chain-of-thought chunk
- `tool.execution_start` — tool call begun
- `tool.execution_complete` — tool call finished
- `session.idle` — session finished processing
- `session.compaction_start/complete` — context compaction (infinite sessions)

### Tools

```typescript
import { defineTool } from '@github/copilot-sdk';

const myTool = defineTool('tool_name', {
    description: '...',
    parameters: { type: 'object', properties: { ... } },
    handler: async (args) => { return result; },
});
```

---

## 4. Implementation Phases

### Phase 0: Copilot CLI Binary Bundling

**Goal:** Ship the `copilot` CLI binary with VS Code so end users don't need to install it separately.

**Options:**

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| **A. npm package** | Create/use a `@github/copilot-cli` npm package (like `@vscode/ripgrep`) | Follows existing VS Code pattern exactly. Build pipeline just adds ASAR unpack rule in `gulpfile.vscode.ts`. | Requires publishing the CLI as an npm package. Need to coordinate with CLI team. |
| **B. Build-time download** | Add gulp task to download CLI binary per platform/arch (like Node.js binary in `gulpfile.reh.ts`) | Full control over version. Can pin checksums. | More build infrastructure. Need download URLs per platform/arch. |
| **C. PATH discovery only** | Find `copilot` on PATH at launch | Zero build changes. Works immediately for dev. | Not viable for production — can't ship to users without CLI installed. |

**Recommended:** Option A for production + Option C for development.

**Development workflow:** The SDK can find `copilot` on PATH by default (no `cliPath` needed). Developers just need the CLI installed.

**Production:** The CLI binary is bundled via npm package, excluded from ASAR (like ripgrep), and the path is resolved at runtime:
```typescript
// Similar to ripgrep path resolution
import { cliPath } from '@github/copilot-cli';
const copilotDiskPath = cliPath.replace(/\bnode_modules\.asar\b/, 'node_modules.asar.unpacked');
```

**Build pipeline changes:**
- Add `@github/copilot-cli` (or equivalent) to `package.json`
- Add ASAR unpack rule in `build/gulpfile.vscode.ts`: `'**/@github/copilot-cli/bin/*'`
- Add to `cgmanifest.json` for third-party declaration
- Add checksum validation

**Files to modify:**
- `package.json` — add dependency
- `build/gulpfile.vscode.ts` — ASAR unpack rule
- `cgmanifest.json` — third-party declaration
- `product.json` — potentially add `copilotCliPath` configuration

---

### Phase 1: SDK Host Process (Terminal Pattern)

**Goal:** Create a utility process hosting the `CopilotClient`, exposed via `registerMainProcessRemoteService` so any workbench code can inject `@ICopilotSdkService`.

**New files (4 files + 1 registration line):**

| # | File | Layer | Purpose |
|---|------|-------|---------|
| 1 | `src/vs/sessions/common/copilotSdkService.ts` | Common | `ICopilotSdkService` interface + all types. The contract. |
| 2 | `src/vs/sessions/node/copilotSdkHost.ts` | Utility process | Entry point. Creates `CopilotClient`, wraps as `IServerChannel` via `ProxyChannel.fromService()`. |
| 3 | `src/vs/sessions/electron-main/copilotSdkMainService.ts` | Main process | Spawns utility process, proxies the channel to the Electron IPC server. Handles restart on crash. |
| 4 | `src/vs/sessions/electron-browser/copilotSdkService.ts` | Renderer | One-liner: `registerMainProcessRemoteService(ICopilotSdkService, 'copilotSdk')` |

**Service interface:**

```typescript
interface ICopilotSdkService {
    readonly _serviceBrand: undefined;

    // Lifecycle
    start(): Promise<void>;
    stop(): Promise<void>;

    // Sessions
    createSession(config: ISessionConfig): Promise<string>; // returns sessionId
    resumeSession(sessionId: string, config?: IResumeSessionConfig): Promise<void>;
    destroySession(sessionId: string): Promise<void>;
    listSessions(): Promise<ISessionMetadata[]>;
    deleteSession(sessionId: string): Promise<void>;

    // Messaging
    send(sessionId: string, prompt: string, options?: ISendOptions): Promise<string>;
    sendAndWait(sessionId: string, prompt: string, options?: ISendOptions): Promise<IAssistantMessage | undefined>;
    abort(sessionId: string): Promise<void>;
    getMessages(sessionId: string): Promise<ISessionEvent[]>;

    // Events (auto-forwarded over IPC by ProxyChannel)
    readonly onSessionEvent: Event<{ sessionId: string; event: ISessionEvent }>;
    readonly onSessionLifecycle: Event<ISessionLifecycleEvent>;

    // Models
    listModels(): Promise<IModelInfo[]>;

    // Authentication
    setGitHubToken(token: string): Promise<void>;
}
```

**How the layers connect (terminal pattern):**

```
Renderer:
  registerMainProcessRemoteService(ICopilotSdkService, 'copilotSdk')
  → ProxyChannel.toService(mainProcessService.getChannel('copilotSdk'))
  → Workbench code just does: @ICopilotSdkService private sdk: ICopilotSdkService

Main Process (CopilotSdkMainService):
  1. On first call: spawns UtilityProcess with entryPoint 'vs/sessions/node/copilotSdkHost'
  2. Calls utilityProcess.connect() → gets MessagePort
  3. Wraps port as IPCClient → gets channel to utility process
  4. Registers that channel on the Electron IPC server as 'copilotSdk'
  → All renderer calls transparently flow through to the utility process

Utility Process (copilotSdkHost.ts):
  1. Creates CopilotClient from @github/copilot-sdk
  2. Implements ICopilotSdkService (wrapping SDK methods + forwarding events)
  3. Wraps as IServerChannel via ProxyChannel.fromService(service)
  4. Registers on UtilityProcessMessagePortServer
```

**Authentication:** The renderer gets the GitHub/Copilot token from `IAuthenticationService` and calls `sdk.setGitHubToken(token)`. This flows through to the utility process, which passes it to the SDK's `githubToken` option.

**Lifecycle:** The utility process is spawned lazily on first use. It is killed when the sessions window closes. If it crashes, the main process service restarts it (with a max restart count, matching the pty host pattern).

**Reference implementations to follow:**

| Pty host file | Our equivalent |
|--------------|---------------|
| `src/vs/platform/terminal/common/terminal.ts` (service interface) | `src/vs/sessions/common/copilotSdkService.ts` |
| `src/vs/platform/terminal/node/ptyHostMain.ts` (utility process entry) | `src/vs/sessions/node/copilotSdkHost.ts` |
| `src/vs/platform/terminal/electron-main/electronPtyHostStarter.ts` (spawner) | `src/vs/sessions/electron-main/copilotSdkMainService.ts` |
| `registerMainProcessRemoteService(ILocalPtyService, ...)` | `registerMainProcessRemoteService(ICopilotSdkService, 'copilotSdk')` |

---

### Phase 2: New Chat UI

**Goal:** Build a purpose-built chat UI under `src/vs/sessions/` that does NOT depend on `ChatWidget`, `ChatInputPart`, or `ChatModel` from `vs/workbench/contrib/chat/`.

**New files:**

| File | Purpose |
|------|---------|
| `src/vs/sessions/browser/chatRenderer.ts` | Streaming chat renderer — displays messages, tool calls, progress |
| `src/vs/sessions/browser/parts/chatbar/chatInputEditor.ts` | New input editor widget (CodeEditorWidget-based) |
| `src/vs/sessions/browser/parts/chatbar/chatToolCallView.ts` | Tool call status visualization |
| `src/vs/sessions/browser/parts/chatbar/chatConfirmationView.ts` | User input request / tool approval UI |

**What to build:**
1. **Input editor** — a `CodeEditorWidget` for the prompt, with send button, attachment support
2. **Streaming renderer** — renders `assistant.message_delta` events into a scrolling view using `IMarkdownRendererService`
3. **Tool call UI** — shows tool execution status from `tool.execution_start` / `tool.execution_complete` events
4. **Confirmation UI** — handles `onUserInputRequest` / `ask_user` for tool approval prompts
5. **Model picker** — uses `listModels()` to show available models

**What can be reused from existing VS Code codebase:**
- `IMarkdownRendererService` / `MarkdownRenderer` for rendering responses
- `CodeEditorWidget` for the input box
- `IHoverService`, `IContextMenuService` for UI chrome
- The existing sessions window layout (chat bar part, editor modal, sidebar, panel, etc.)
- `IAuthenticationService` for token management

**What gets removed from the sessions window (eventually):**
- `AgentSessionsChatWidget` wrapper (`src/vs/sessions/browser/widget/agentSessionsChatWidget.ts`)
- `AgentSessionsChatTargetConfig` (`src/vs/sessions/browser/widget/agentSessionsChatTargetConfig.ts`)
- `AgentSessionsChatWelcomePart` and related welcome view code
- All imports of `ChatWidget`, `ChatInputPart`, `ChatModel`, `ChatService` in `src/vs/sessions/`
- Dependency on `IChatSessionsService` for session creation/content

---

### Phase 3: Tool Registration

**Goal:** Register VS Code's workspace tools (file edit, terminal, search, etc.) as SDK tools so the Copilot agent can operate on the workspace.

The SDK's `defineTool()` mechanism allows the host to register tools that the CLI agent can invoke. External tools like `rename_session`, `create_pull_request`, etc. are registered by the host — the CLI sends JSON-RPC requests back when the agent invokes them.

For VS Code, we'd register tools that bridge to existing VS Code services:

| Tool | Description | VS Code Service |
|------|-------------|-----------------|
| `read_file` | Read file contents | `IFileService` |
| `write_file` | Write/create file | `IFileService` |
| `list_directory` | List directory contents | `IFileService` |
| `run_terminal_command` | Execute shell command | `ITerminalService` |
| `search_files` | Search workspace | `ISearchService` |
| `open_editor` | Open a file in the editor modal | `IEditorService` |
| `rename_session` | Rename the current session | Session metadata |
| `ask_user` | Ask for user confirmation | Built-in via SDK's `onUserInputRequest` |

Note: The CLI already has built-in tools (file read/write, bash, etc.) that work directly on the filesystem. We may not need to re-register all of these — the CLI handles them natively. We primarily need to register tools for UI actions (open editor, show notification, etc.) and tools that need to go through VS Code services.

---

### Phase 4: Session List & Management

**Goal:** Replace `ChatSessionItemProvider` (from copilot-chat extension) with SDK-based session listing.

**Current flow:**
```
copilot-chat extension → registerChatSessionItemProvider(type, provider)
    → ChatSessionsService._itemControllers
    → getChatSessionItems() → sessions view
```

**New flow:**
```
ICopilotSdkService.listSessions() → ISessionMetadata[]
    → sessions view pane
```

**SDK provides:**
- `client.listSessions()` → `SessionMetadata[]` (sessionId, creation time, etc.)
- `client.on('session.created' | 'session.updated' | 'session.deleted', handler)` — lifecycle events
- `session.getMessages()` → full message history for a session

**What might be missing from the SDK** (compared to current `ChatSessionItem`):
- File changes (insertions/deletions) — would need to be computed from git or the CLI's workspace state
- Status badges (InProgress, NeedsInput, Failed) — can be derived from session events
- Session timing (created, lastRequestStarted, lastRequestEnded) — partially available from SDK
- Archive/read state — would need to be tracked locally (Storage)

**Files to modify:**
- `src/vs/sessions/contrib/sessions/browser/sessionsViewPane.ts` — consume `ICopilotSdkService` instead of `IChatSessionsService`
- `src/vs/sessions/contrib/sessions/browser/activeSessionService.ts` — track active session from SDK

---

### Phase 5: Remove Copilot-Chat Dependency

**Goal:** Once Phases 1-4 are complete, remove all copilot-chat extension dependencies from the sessions window.

**What gets removed from `src/vs/sessions/`:**
- All imports from `vs/workbench/contrib/chat/` (ChatWidget, ChatInputPart, ChatModel, ChatService, etc.)
- `AgentSessionsChatWidget` and related widget code
- `IChatSessionsService` usage for session creation/content
- `AgentSessionProviders` enum mapping to extension scheme strings (`copilotcli`, `copilot-cloud-agent`)
- The `chatSessionsProvider` proposed API path (for sessions window use cases)

**What stays unchanged:**
- Regular VS Code chat (sidebar, inline, editor) — still uses copilot-chat for everything
- Local sessions — still managed by `ChatService`
- Extension-contributed session types (Claude, etc.) — still use the extension API
- The `chatSessions` extension point — still works for non-sessions-window consumers

**Files to modify:**
- `src/vs/sessions/sessions.desktop.main.ts` — remove chat contrib imports, add SDK service registration
- `src/vs/sessions/sessions.common.main.ts` — remove shared chat imports if any
- `src/vs/sessions/browser/parts/chatbar/chatBarPart.ts` — switch from ChatWidget to new SDK-based UI
- `src/vs/sessions/contrib/chat/browser/chat.contribution.ts` — remove or gut

---

## 5. Copilot SDK API Quick Reference

### Installation
```
npm install @github/copilot-sdk
```

### CopilotClient Constructor Options
- `cliPath?: string` — path to CLI executable (default: `copilot` from PATH)
- `cliUrl?: string` — URL of existing CLI server (skips spawning)
- `port?: number` — server port (default: random)
- `useStdio?: boolean` — use stdio transport (default: true)
- `autoStart?: boolean` — auto-start server (default: true)
- `autoRestart?: boolean` — auto-restart on crash (default: true)
- `githubToken?: string` — GitHub token for auth
- `logLevel?: string` — log level (default: "info")

### Session Config
- `sessionId?: string` — custom session ID
- `model?: string` — model to use ("gpt-4.1", "claude-sonnet-4.5", etc.)
- `reasoningEffort?: "low" | "medium" | "high" | "xhigh"`
- `tools?: Tool[]` — custom tools
- `systemMessage?: { content: string; mode?: "append" | "replace" }`
- `streaming?: boolean` — enable streaming responses
- `infiniteSessions?: { enabled: boolean; thresholds... }` — context compaction
- `mcpServers?: { [name]: { type, url } }` — MCP server config
- `customAgents?: [{ name, displayName, description, prompt }]`
- `onUserInputRequest?: (request) => Promise<{ answer, wasFreeform }>`
- `hooks?: { onPreToolUse, onPostToolUse, onUserPromptSubmitted, onSessionStart, onSessionEnd, onErrorOccurred }`
- `provider?: ProviderConfig` — BYOK custom provider

### Event Types
- `user.message` — user message added
- `assistant.message` — complete assistant response
- `assistant.message_delta` — streaming response chunk (has `deltaContent`)
- `assistant.reasoning` — complete reasoning content
- `assistant.reasoning_delta` — streaming reasoning chunk
- `tool.execution_start` — tool execution started
- `tool.execution_complete` — tool execution completed
- `session.idle` — session finished processing
- `session.compaction_start` — context compaction started
- `session.compaction_complete` — context compaction finished

### Client Lifecycle Events
- `session.created` — new session created
- `session.deleted` — session deleted
- `session.updated` — session updated (new messages)

---

## 6. Open Questions

1. ~~**CLI binary packaging:** Does the `@github/copilot-sdk` npm package bundle the CLI?~~ **RESOLVED:** The SDK depends on `@github/copilot` which includes platform-specific native binaries via optional deps (`@github/copilot-darwin-arm64`, etc.). We resolve the native binary at runtime via `import.meta.resolve()`. The SDK's default `index.js` entry spawns an Electron-based JS loader that crashes in our utility process context.

2. ~~**SDK in utility process:**~~ **RESOLVED:** Works. The utility process is an Electron Chromium process with Node.js integration. It spawns GPU/network sub-processes (normal Electron behavior, causes noisy but harmless stderr). The SDK runs fine inside it.

3. ~~**Event streaming over IPC:**~~ **RESOLVED:** `ProxyChannel` auto-forwards events. Works correctly.

4. **Authentication:** The SDK accepts `githubToken`. VS Code has `IAuthenticationService`. Need to bridge these -- get the token from the auth service and call `sdk.setGitHubToken()`. Not yet implemented.

5. **MCP servers:** Need to decide if we use the SDK's native MCP support (`mcpServers` config) or keep the existing VS Code MCP infrastructure.

6. **Existing tool infrastructure:** The CLI has built-in tools (file I/O, bash, etc.) that operate directly on the filesystem. We may not need to re-register these as SDK tools. Need to understand which are built-in vs need to be provided by the host.

7. **SDK maturity:** The SDK is in Technical Preview (v0.1.23). API may change.

8. **File changes / diff support:** The sessions view currently shows file insertions/deletions per session. The SDK doesn't directly provide this. Compute from git or the CLI's workspace state.

9. **`CopilotSdkChannel` formatters:** TypeScript formatters/organizers repeatedly merge the `CopilotSdkChannel` value import into `import type {}` blocks, which strips it at compile time and causes a runtime `ReferenceError`. Use inline `type` keywords on individual type imports to prevent this: `import { CopilotSdkChannel, type ICopilotSdkService, ... }`.

---

## 7. File Structure (Implemented)

```
src/vs/platform/copilotSdk/                    ← Platform layer (not vs/sessions/)
├── common/
│   └── copilotSdkService.ts                   ICopilotSdkService + ICopilotSdkMainService interfaces
├── node/
│   └── copilotSdkHost.ts                      Utility process entry point (SDK host)
├── electron-main/
│   └── copilotSdkStarter.ts                   Main process service (spawns utility process)

src/vs/sessions/                               ← Sessions window layer (consumers)
├── electron-browser/
│   └── copilotSdkService.ts                   One-liner: registerMainProcessRemoteService
├── browser/
│   ├── copilotSdkDebugPanel.ts                RPC debug panel (temporary)
│   ├── media/copilotSdkDebugPanel.css         Debug panel styles
│   ├── parts/
│   │   ├── chatbar/
│   │   │   ├── chatBarPart.ts                 (existing, will be modified for Milestone 2)
│   │   │   ├── chatInputEditor.ts             ← TODO: New input editor widget
│   │   │   ├── chatToolCallView.ts            ← TODO: Tool call visualization
│   │   │   └── chatConfirmationView.ts        ← TODO: User input / tool approval
│   │   └── ...                                (existing)
│   └── widget/                                (TO BE REMOVED once SDK UI replaces it)
│       ├── agentSessionsChatWidget.ts         ← REMOVE: replaced by SDK integration
│       └── ...
├── contrib/
│   ├── sessions/browser/
│   │   ├── sessionsViewPane.ts                (will consume ICopilotSdkService)
│   │   └── activeSessionService.ts            (will track SDK sessions)
│   └── chat/browser/
│       └── chat.contribution.ts               (has debug panel command + existing actions)
└── sessions.desktop.main.ts                   (imports copilotSdkService.ts registration)

src/vs/code/electron-main/app.ts               Registers ICopilotSdkMainService + channel
```

### Key: Platform vs Sessions Layer

| Layer | Location | Contains |
|-------|----------|----------|
| `vs/platform/copilotSdk/` | Service interface, utility process host, main process starter | Imported by `vs/code/electron-main/app.ts` -- must be in `vs/platform/` for layering |
| `vs/sessions/` | Renderer registration, debug panel, chat UI, session views | Consumes `ICopilotSdkService` via DI |

---

## 8. Worktree Strategy

### How Worktrees Work Today

The **copilot-chat extension** orchestrates worktrees via `ChatSessionWorktreeService`:
1. Calls the **git extension API** (`repository.createWorktree({ branch })`) to create worktrees
2. Stores metadata (`worktreePath`, `repositoryPath`, `baseCommit`, `branchName`) in extension global state
3. Auto-commits changes after each request via `repository.commit()`
4. Computes file changes via `repository.diffBetweenWithStats()`
5. Applies changes back to the main repo via `repository.migrateChanges()` or `repository.apply(patch)`

Everything goes through the **VS Code git extension** (`extensions/git/`) — copilot-chat never runs `git` commands directly.

### With the SDK: Hybrid Approach

The CLI creates worktrees autonomously as part of its agent workflow. We discover the path and use the git extension for post-creation operations:

| Concern | Who handles it |
|---------|---------------|
| Worktree **creation** | Copilot CLI (built-in git tools, runs `git worktree add`) |
| Worktree **path discovery** | Read `session.workspacePath` → parse `workspace.yaml` → extract `cwd` |
| File **change stats** | Git extension API: `repository.diffBetweenWithStats()` |
| **Apply changes** to main repo | Git extension API: `repository.migrateChanges()` or `repository.apply(patch)` |
| Auto-**commit** | Git extension API: `repository.commit()` |
| **Open terminal** in worktree | `ITerminalService.createTerminal({ cwd: worktreePath })` |
| **Open in VS Code** | `IHostService.openWindow([{ folderUri: worktreeUri }])` |

### Extension Host

The sessions window **keeps its own extension host** — it already has one for the git extension, language services, terminal, etc. The SDK adoption does not remove the extension host. It only removes the dependency on the **copilot-chat extension** running in that extension host.

| Extension | Status | Used for |
|-----------|--------|----------|
| `vscode.git` (built-in) | **Kept** | `createWorktree`, `deleteWorktree`, `migrateChanges`, `diffBetween*`, `commit`, `apply`, repository state |
| `github.vscode-pull-request-github` | **Kept** (if installed) | PR creation from worktree branches |
| `github.copilot-chat` | **Removed** from sessions window dependency | No longer needed — SDK handles session lifecycle |
| Other built-in extensions | **Kept** | Language services, terminal, file system providers |

---

## 8. Current UI Architecture (Research Findings)

### How the Chat Bar Works Today

The chat flows through 7 layers:

```
ChatBarPart (AbstractPaneCompositePart)
  -> ViewPaneContainer ('workbench.panel.chat')
    -> ChatViewPane (ViewPane)
      -> AgentSessionsChatWidget (sessions window only)
        -> ChatWidget (core chat rendering)
          -> ChatService -> Extension Host -> copilot-chat extension
```

Key findings:

1. **ChatBarPart** is a standard `AbstractPaneCompositePart` -- it has NO direct chat imports. It delegates entirely to the pane composite framework.

2. **The chat view container** is registered at `ViewContainerLocation.ChatBar` with `isDefault: true` in `chatParticipant.contribution.ts`. On startup, `restoreParts()` opens the default container, which instantiates `ChatViewPane`.

3. **ChatViewPane** has an `if (isSessionsWindow)` branch that creates either `AgentSessionsChatWidget` (sessions) or plain `ChatWidget` (regular VS Code).

4. **AgentSessionsChatWidget** wraps `ChatWidget` and adds deferred session creation. On first send, it creates a session via `chatService.loadSessionForResource()` and then delegates to `ChatWidget.acceptInput()`.

### Dependency Map: sessions/ -> workbench/contrib/chat/

| Category | Count | Examples |
|----------|-------|---------|
| **UI** (must replace) | 12+ symbols | `ChatWidget`, `ChatInputPart`, `AgentSessionsControl`, `AgentSessionsPicker`, `ChatViewPane`, `IChatWidgetService` |
| **Data** (must replace) | 20+ symbols | `IChatService`, `IChatSessionsService`, `IAgentSessionsService`, `IChatModel`, `IAgentSession`, `AgentSessionProviders`, `getChatSessionType` |
| **Can keep** (shared utilities) | 15+ symbols | `ChatAgentLocation`, `ChatModeKind`, `IPromptsService`, `PromptsType`, `ChatContextKeys`, `ILanguageModelsService` |

### Heaviest Files (by chat dependency count)

1. `agentSessionsChatWidget.ts` -- 10 imports (heart of chat UI, TO BE REPLACED)
2. `agentSessionsChatWelcomePart.ts` -- 7 imports (welcome UI, TO BE REPLACED)
3. `changesView.ts` -- 7 imports (file changes, KEEP for now)
4. `sessionsTitleBarWidget.ts` -- 6 imports (title bar, MODIFY later)
5. `activeSessionService.ts` -- 5 imports (session tracking, MODIFY later)
6. `aiCustomizationManagementEditor.ts` -- 7 imports (customizations, KEEP for now)

### Adoption Strategy: Replace from the Inside Out

Rather than rewriting everything at once, we replace the **widget layer** inside `ChatViewPane`:

**Option C (recommended):** Create a NEW `SdkChatViewPane` class in `vs/sessions/` that hosts `SdkChatWidget` directly. Register it as an alternative view in the ChatBar container. Zero changes to `ChatViewPane` or `ChatWidget`. The existing UI keeps working as fallback.

```
ChatBarPart (UNCHANGED)
  -> ViewPaneContainer (UNCHANGED)
    -> SdkChatViewPane (NEW, in vs/sessions/)
      -> SdkChatWidget (NEW, in vs/sessions/)
        -> ICopilotSdkService -> Utility Process -> SDK -> CLI
```

### Phase 2 File Plan

| File | Action | Phase |
|------|--------|-------|
| `src/vs/sessions/browser/widget/sdkChatWidget.ts` | **NEW** -- Core SDK chat widget | 2A |
| `src/vs/sessions/browser/widget/sdkChatWidget.css` | **NEW** -- Styles | 2A |
| `src/vs/sessions/browser/widget/sdkChatViewPane.ts` | **NEW** -- View pane hosting the SDK widget | 2B |
| `src/vs/sessions/contrib/chat/browser/chat.contribution.ts` | **MODIFY** -- Register `SdkChatViewPane` | 2B |
| `src/vs/sessions/contrib/sessions/browser/activeSessionService.ts` | **MODIFY** -- Add SDK data source | 2D |
| `src/vs/sessions/contrib/sessions/browser/sessionsTitleBarWidget.ts` | **MODIFY** -- Show SDK session info | 2D |

### What We Don't Touch (Yet)

- `ChatBarPart` -- pane composite infrastructure, no changes needed
- `ChatViewPane` -- no changes, stays for fallback
- `changesView.ts` -- keeps existing data flow
- `aiCustomization*` -- keeps existing flow
- `sessions.desktop.main.ts` -- SDK service already registered

---

## 9. Concrete Implementation Plan

This section is the **actionable build order**. Each step produces a compilable, testable checkpoint. Steps within a milestone can be developed in parallel; milestones are sequential.

---

### Milestone 1: SDK Client in a Utility Process (Foundation)

Everything else depends on this. The goal is: send a prompt, get a streaming response, see it logged in the dev console.

#### Step 1.1 — Add `@github/copilot-sdk` dependency

- Add `"@github/copilot-sdk": "^0.1.23"` to root `package.json`
- Run `npm install`
- Add ASAR unpack rule in `build/gulpfile.vscode.ts` for any native bits the SDK ships
- Validate: `node -e "require('@github/copilot-sdk')"` succeeds

#### Step 1.2 — Define the service interface

Create `src/vs/sessions/common/copilotSdkService.ts`:
- `ICopilotSdkService` interface (see Phase 1 in plan above)
- All event and data types: `ISessionConfig`, `ISessionEvent`, `ISessionMetadata`, `ISendOptions`, `IModelInfo`, etc.
- `createDecorator<ICopilotSdkService>('copilotSdkService')`
- **No implementation** — just types. This is the contract between the utility process host and the workbench client.
- **Compiles independently** — no dependencies beyond `vs/base` and `vs/platform`.

#### Step 1.3 — Build the utility process host

Create `src/vs/sessions/node/copilotSdkHost.ts`:
- Utility process entry point (like `src/vs/platform/terminal/node/ptyHostMain.ts`)
- Creates a `UtilityProcessMessagePortServer` to accept connections
- Implements `ICopilotSdkService`:
  - Creates a `CopilotClient` from `@github/copilot-sdk` (for dev: omit `cliPath` so the SDK finds `copilot` on PATH)
  - Maps each SDK method to the service interface
  - Collects SDK `session.on()` callbacks and emits them as `Event<{ sessionId, event }>` on the service
- Wraps the service as an `IServerChannel` via `ProxyChannel.fromService(service)` — this auto-handles all methods and events
- Registers the channel on the server

Key: `ProxyChannel.fromService()` auto-detects all `onFoo: Event<T>` properties and buffers them for IPC. No manual event wiring needed.

#### Step 1.4 — Build the main process service (proxy layer)

Create `src/vs/sessions/electron-main/copilotSdkMainService.ts`:
- Follows the `ElectronPtyHostStarter` / `PtyHostService` pattern
- Spawns a `UtilityProcess` with entryPoint `'vs/sessions/node/copilotSdkHost'` (lazy — on first method call)
- Calls `utilityProcess.connect()` → gets MessagePort → wraps as `MessagePortClient` → gets `IChannel`
- Proxies that channel to the Electron IPC server via `server.registerChannel('copilotSdk', channel)`
- Handles crash/restart: max 5 restarts, then give up
- Handles lifecycle: kills utility process when sessions window closes

Wire into the main process app initialization:
- In `src/vs/code/electron-main/app.ts` (or sessions-specific equivalent): instantiate `CopilotSdkMainService`, register the channel on `mainProcessElectronServer`

#### Step 1.5 — Register the renderer-side proxy

Create `src/vs/sessions/electron-browser/copilotSdkService.ts`:
- **One line**: `registerMainProcessRemoteService(ICopilotSdkService, 'copilotSdk')`
- This creates a `ProxyChannel.toService()` wrapper around `mainProcessService.getChannel('copilotSdk')`
- Any workbench code can now inject `@ICopilotSdkService` via standard DI

Modify `src/vs/sessions/sessions.desktop.main.ts`:
- Import the registration file

#### Step 1.6 — Smoke test: end-to-end message round-trip

Create a temporary test action (or use the dev console):
1. `copilotSdkService.start()`
2. `const sessionId = await copilotSdkService.createSession({ model: 'gpt-4.1', streaming: true })`
3. Subscribe to `copilotSdkService.onSessionEvent` and log to console
4. `await copilotSdkService.send(sessionId, 'What is 2+2?')`
5. Verify: `assistant.message_delta` events arrive in the renderer console
6. Verify: `session.idle` fires when done

**Checkpoint: The SDK is alive and talking to the renderer. No UI yet.**

---

### Milestone 2: Minimal Chat UI (See It Working)

Replace the current chat bar's content with a new, minimal chat UI powered by `ICopilotSdkService`. Goal: type a prompt, see a streaming response rendered in the chat bar.

#### Step 2.1 — New chat input editor

Create `src/vs/sessions/browser/parts/chatbar/chatInputEditor.ts`:
- A `Disposable` class that creates a `CodeEditorWidget` (single-line mode, like the existing chat input)
- Send button (icon button or keyboard shortcut: Enter to send, Shift+Enter for newline)
- Exposes: `onDidSubmit: Event<string>` (fires with the prompt text)
- Exposes: `focus()`, `clear()`, `getValue()`
- CSS in `src/vs/sessions/browser/parts/chatbar/media/chatInputEditor.css`
- **Standalone** — no dependencies on `ChatInputPart` or `ChatWidget`

#### Step 2.2 — Streaming message renderer

Create `src/vs/sessions/browser/chatRenderer.ts`:
- A `Disposable` that manages a scrollable container
- Accepts `ISessionEvent` stream and renders them:
  - `user.message` → right-aligned user bubble with the prompt text
  - `assistant.message_delta` → accumulates `deltaContent` into a growing markdown block, rendered via `IMarkdownRendererService`
  - `assistant.message` → finalizes the markdown block
  - `tool.execution_start` → shows a tool call indicator (icon + tool name + "running...")
  - `tool.execution_complete` → updates the indicator to "done"
  - `session.idle` → scroll to bottom, enable input
- Auto-scroll behavior: stick to bottom while streaming, disengage if user scrolls up
- **Standalone** — uses `IMarkdownRendererService`, `IHoverService`, standard DOM. No `ChatWidget` dependency.

#### Step 2.3 — Wire into the ChatBarPart

Modify `src/vs/sessions/browser/parts/chatBarPart.ts`:
- Currently hosts a pane composite (which loads the chat view pane containing `AgentSessionsChatWidget`)
- **New approach:** The ChatBarPart directly creates:
  1. A `StreamingChatRenderer` (from step 2.2) filling the main area
  2. A `ChatInputEditor` (from step 2.1) at the bottom
  3. On submit: calls `copilotSdkService.createSession()` (if no session), then `copilotSdkService.send()`
  4. Pipes `copilotSdkService.onSessionEvent` into the renderer
- For now, hardcode model to `'gpt-4.1'` and default streaming config
- **Keep the old code path behind a feature flag** so we can switch back if needed

#### Step 2.4 — Auth token plumbing

Create a workbench contribution in `src/vs/sessions/contrib/chat/browser/` (or reuse existing):
- On activation, get the GitHub Copilot token from `IAuthenticationService`
- Call `copilotSdkService.setGitHubToken(token)`
- Listen for token refresh events and update
- Without this, the SDK can't authenticate with the Copilot service

**Checkpoint: Type a prompt in the sessions window, see a streaming response. No session list, no tool calls, no polish — but it works.**

---

### Milestone 3: Session Management

#### Step 3.1 — Session lifecycle in the UI

Extend the ChatBarPart:
- Track the active session ID
- "New Session" action → destroys current session, creates a new one
- Session resume on window reopen: store last session ID, call `resumeSession()` on startup
- `abort()` button while response is streaming

#### Step 3.2 — Session list integration

Modify `src/vs/sessions/contrib/sessions/browser/sessionsViewPane.ts`:
- Add an `ICopilotSdkService` dependency
- Call `listSessions()` to populate the sessions list
- Subscribe to `onSessionLifecycle` for real-time updates
- On session click: call `resumeSession()` and load messages via `getMessages()`
- Keep the existing `AgentSessionsControl` and `AgentSessionsFilter` UX — just swap the data source
- **Dual mode**: support both SDK sessions and legacy `IChatSessionsService` sessions during transition

#### Step 3.3 — Active session service update

Modify `src/vs/sessions/contrib/sessions/browser/activeSessionService.ts`:
- Track the active SDK session (session ID + metadata)
- Expose the workspace/worktree path from the session's `workspacePath` property
- Keep backward compatibility with the existing `IActiveSessionItem` shape

**Checkpoint: Sessions list shows SDK sessions. Can switch between sessions. Sessions persist across window restarts.**

---

### Milestone 4: Tool Calls & Agent Features

#### Step 4.1 — Tool call visualization

Extend the `StreamingChatRenderer`:
- `tool.execution_start` → expandable panel showing tool name, arguments
- `tool.execution_complete` → show result, duration
- Special rendering for common tools: file edits (show diff), terminal commands (show output), etc.

#### Step 4.2 — User input requests

Handle the SDK's `onUserInputRequest` callback:
- When the agent calls `ask_user`, the utility process forwards the request over IPC
- The workbench shows a modal or inline prompt (question + optional choices)
- User response is sent back over IPC → SDK → CLI
- This is critical for tool approval flows (e.g., "Allow file edit?")

#### Step 4.3 — Session hooks (tool approval)

Register `onPreToolUse` hook in the SDK:
- Show a "Allow tool X?" UI before dangerous operations
- Auto-approve safe operations (read_file, search)
- User preference: "always allow", "ask each time", "deny"

#### Step 4.4 — Custom external tools

Register VS Code-specific tools via `defineTool()`:
- `open_editor` → opens a file in the editor modal (`IEditorService`)
- `rename_session` → updates the session title in the sessions list
- `show_notification` → shows a VS Code notification
- These are tools the CLI doesn't have built-in — they need VS Code UI integration

#### Step 4.5 — Model picker

Add a model picker dropdown to the ChatInputEditor:
- On mount: call `listModels()` to get available models
- Show as a dropdown/quick pick
- Pass selected model to `createSession({ model: ... })`

**Checkpoint: Full agent experience — tool calls visible, confirmations working, model selection, custom VS Code tools.**

---

### Milestone 5: Polish & Parity

#### Step 5.1 — Welcome view

Build a welcome/empty state for the chat bar:
- Shown when no session is active
- Quick action buttons: "Start a new session", model picker
- Branding / mascot (if applicable)

#### Step 5.2 — File changes view

The auxiliary bar's changes view currently shows file diffs from the copilot-chat extension:
- Compute file changes from git (diff between session branch and base)
- Or use the CLI's workspace state if available
- Wire into the existing `ChangesView` component

#### Step 5.3 — Keyboard shortcuts & accessibility

- Enter to send, Shift+Enter for newline
- Ctrl+C / Cmd+C to abort
- Screen reader announcements for streaming responses
- Focus management between input and message list

#### Step 5.4 — Remove old code paths

Once the SDK path is stable:
- Remove `src/vs/sessions/browser/widget/` (AgentSessionsChatWidget, etc.)
- Remove `src/vs/sessions/contrib/chat/browser/` imports of ChatWidget/ChatService
- Remove copilot-chat extension dependency from sessions window entirely
- Clean up `sessions.desktop.main.ts` — remove unused chat imports

**Checkpoint: Feature parity with the current sessions window, fully powered by the Copilot SDK. No copilot-chat extension dependency.**

---

### Summary: Build Order at a Glance

```
M1: Foundation          M2: See it work      M3: Sessions       M4: Agent         M5: Polish
─────────────────────   ──────────────────   ────────────────   ──────────────    ──────────────
1.1 npm dependency      2.1 Input editor     3.1 Lifecycle      4.1 Tool viz      5.1 Welcome
1.2 Service interface   2.2 Chat renderer    3.2 Sessions list  4.2 User input    5.2 Changes
1.3 Utility proc host   2.3 Wire ChatBar     3.3 Active svc     4.3 Tool hooks    5.3 A11y
1.4 Main proc starter   2.4 Auth token                          4.4 Custom tools  5.4 Remove old
1.5 Workbench client                                            4.5 Model picker
1.6 Smoke test
```

Each milestone produces a working, demoable checkpoint. M1+M2 gets us to "type and see a response" — the core wow moment. M3 adds persistence. M4 adds agent power. M5 reaches parity and removes the old dependency.

---

## Revision History

| Date | Change |
|------|--------|
| 2026-02-13 | Initial plan created. Covers SDK adoption, CLI bundling, utility process hosting, new chat UI, session list migration, and copilot-chat dependency removal. Based on Copilot SDK official documentation. |
| 2026-02-13 | Added concrete implementation plan (Section 9) with 5 milestones and detailed step-by-step build order. |
| 2026-02-13 | Refined architecture to terminal (pty host) pattern: `registerMainProcessRemoteService` + main process proxy + utility process. Renderer-side code is one line DI. Added worktree strategy (Section 8): CLI creates worktrees, git extension handles post-creation operations. Extension host is kept for git, not removed. |
| 2026-02-13 | **Milestone 1 complete.** Moved service to `vs/platform/copilotSdk/` (fixes layering violation). Created `ICopilotSdkMainService` for proper DI registration in `app.ts`. Native CLI binary resolved via `import.meta.resolve('@github/copilot-{platform}-{arch}')`. Stripped `ELECTRON_*`/`VSCODE_*` env vars from CLI child process env. Added RPC debug panel with event stream logging. |
| 2026-02-13 | Added Section 8: Current UI Architecture research findings. Mapped all `vs/sessions/` -> `vs/workbench/contrib/chat/` dependencies (12+ UI symbols, 20+ data symbols, 15+ keepable utilities). Designed Phase 2 adoption strategy: new `SdkChatViewPane` + `SdkChatWidget` registered as alternative view in ChatBar, zero changes to existing ChatViewPane/ChatWidget. |
