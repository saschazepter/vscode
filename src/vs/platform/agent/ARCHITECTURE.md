# Agent Host Process Architecture

## Overview

The agent host is a dedicated Electron **utility process** that runs the [Copilot SDK](https://github.com/github/copilot-sdk) (`@github/copilot-sdk`) in isolation. It follows the same pattern as the **pty host** (`src/vs/platform/terminal/`), communicating over **MessagePort** via the standard `ProxyChannel` IPC infrastructure.

The workbench connects the agent host to VS Code's chat UI by registering a dynamic chat agent, a session item controller, and a session content provider — all from a single desktop-only workbench contribution.

## Process Model

```
┌──────────────────────────┐
│    Renderer Window       │
│    (workbench UI)        │
│                          │
│  AgentHostChat-          │
│    Contribution          │──── registers dynamic chat agent,
│      │                   │     session item controller,
│      │                   │     session content provider
│      ▼                   │
│  IAgentHostService       │◄── channel proxy via main process
└──────────┬───────────────┘
           │ Electron IPC
┌──────────▼───────────────┐
│    Main Process          │
│                          │
│  AgentHostService        │◄── proxies to utility process
│  ElectronAgentHost-      │    via MessagePort
│    Starter               │
└──────────┬───────────────┘
           │ MessagePort
┌──────────▼───────────────┐
│  Agent Host Process      │
│  (utility process)       │
│                          │
│  AgentService            │
│    └─ CopilotClient      │◄── @github/copilot-sdk
│       └─ CopilotSession  │    (spawns copilot CLI via JSON-RPC)
└──────────────────────────┘
```

## File Layout

```
src/vs/platform/agent/
├── common/
│   ├── agent.ts              # IAgentHostStarter, IAgentHostConnection (starter contract)
│   └── agentService.ts       # IAgentService, IAgentHostService interfaces, IPC data types
├── electron-browser/
│   └── agentHostService.ts   # registerMainProcessRemoteService (renderer proxy)
├── electron-main/
│   └── electronAgentHostStarter.ts  # Spawns utility process, brokers MessagePort connections
└── node/
    ├── agentHostMain.ts      # Entry point inside the utility process
    ├── agentService.ts       # AgentService — Copilot SDK wrapper (runs in utility process)
    └── agentHostService.ts   # AgentHostService — main process wrapper, proxies via MessagePort

src/vs/workbench/contrib/chat/browser/agentSessions/
└── agentHostChatContribution.ts  # Workbench contribution: auth, chat agent, session controller/provider

src/vs/workbench/contrib/chat/electron-browser/
└── chat.contribution.ts      # Desktop-only: registers AgentHostChatContribution + new session command
```

## IPC Contract (`IAgentService`)

Methods proxied across MessagePort via `ProxyChannel`:

| Method | Description |
|---|---|
| `setAuthToken(token)` | Push GitHub OAuth token for Copilot SDK auth |
| `listSessions()` | List all sessions from the Copilot CLI |
| `createSession(config?)` | Create a new SDK session (returns session ID) |
| `sendMessage(sessionId, prompt)` | Send a user message into a session |
| `getSessionMessages(sessionId)` | Get session history (user + assistant messages) |
| `disposeSession(sessionId)` | Dispose a session and free resources |
| `ping(msg)` | Connectivity check |

Events:
- `onDidSessionProgress` — streaming progress from the SDK (`delta`, `message`, `idle`, `tool_start`, `tool_complete`)

## How It Works

### Startup (lazy)

1. `ElectronAgentHostStarter` is created in `app.ts` → `initServices()` and hands to `AgentHostService`.
2. The utility process is **not** spawned until the first IPC call (e.g., `createSession()`).
3. On start, `ElectronAgentHostStarter.start()` calls `UtilityProcess.fork()` with entry point `vs/platform/agent/node/agentHostMain`, then `utilityProcess.connect()` to get a `MessagePortMain`.
4. The port is wrapped in a `MessagePortClient` which gives us an `IChannelClient`.

### End-to-End Message Flow

When a user types a message in the chat UI with "Agent Host" selected:

```
Chat UI → user submits message
  → ChatService.sendRequest(resource, message, { agentIdSilent: 'agent-host' })
  → ChatAgentService.invokeAgent('agent-host', request)
  → AgentHostChatContribution._invokeAgent()
     → creates/reuses SDK session (resource→sessionId map)
     → IAgentHostService.sendMessage(sessionId, prompt)           [renderer → main]
     → AgentHostService._proxy.sendMessage(sessionId, prompt)     [main → utility]
     → AgentService.sendMessage()                                  [utility process]
        → CopilotSession.send({ prompt })                          [@github/copilot-sdk]
        → SDK events stream back:
           assistant.message_delta → onDidSessionProgress({type:'delta'})
           session.idle           → onDidSessionProgress({type:'idle'})
     ← events flow back over MessagePort                           [utility → main → renderer]
     → progress([{ kind: 'markdownContent', content }])
  → Chat UI renders streaming response
```

### Session Routing

The chat widget locks to the `agent-host` agent via `lockToCodingAgent()`. This sets `agentIdSilent` on every request, ensuring messages go to our agent instead of the default.

For **new sessions** (URI path starts with `/untitled-`): a fresh SDK session is created via `createSession()` and mapped to the chat resource URI.

For **existing sessions** (opened from session list): the SDK session is either in memory or resumed via `resumeSession()`.

### Auth Token Flow

1. `AgentHostChatContribution` injects `IDefaultAccountService` + `IAuthenticationService`
2. On startup and on account/session changes, it retrieves the GitHub OAuth token
3. Pushes it to the agent host via `IAgentHostService.setAuthToken(token)`
4. The `AgentService` passes it to `CopilotClient({ githubToken })` on next client creation

### Chat Integration

`AgentHostChatContribution` (desktop-only workbench contribution) registers:

1. **Dynamic chat agent** via `IChatAgentService.registerDynamicAgent()` — `id: 'agent-host'`, shows in agent picker
2. **Session item controller** via `IChatSessionsService.registerChatSessionItemController()` — lists SDK sessions
3. **Session content provider** via `IChatSessionsService.registerChatSessionContentProvider()` — loads history, provides `requestHandler`
4. **Session type picker entry** — added in `sessionTargetPickerActionItem.ts` as a built-in item
5. **New session command** — `workbench.action.chat.openNewChatSessionInPlace.agent-host` registered in desktop contribution

### Crash Recovery

`AgentHostService` monitors the utility process exit. On unexpected termination, it automatically restarts (up to 5 times). The proxy is rebuilt on each restart.

### Logging

- **Output channel**: "Agent Host" in the Output panel — shows session lifecycle, message routing, streaming events
- **Utility process console**: `[AgentHost][level]` prefix — CopilotClient lifecycle, SDK events, errors

## Closest Analogs

| Component | Pattern | Key Difference |
|---|---|---|
| **Pty Host** | Singleton utility process, MessagePort, lazy start, heartbeat | Pty host also has heartbeat monitoring and reconnect logic |
| **Shared Process** | Singleton utility process, MessagePort | Much heavier, hosts many services, tightly coupled to app lifecycle |
| **Extension Host** | Per-window utility process (`WindowUtilityProcess`), custom `RPCProtocol` | Uses custom RPC, not standard channels; tied to window lifecycle |

## TODO

- [ ] Add renderer-side `acquirePort()` for direct MessagePort connections (bypass main process relay)
- [ ] Consider whether this should be singleton (current) or per-window
- [ ] Add heartbeat monitoring if crash detection latency matters
- [ ] Support non-Electron spawning (`NodeAgentHostStarter` via `child_process.fork`) for remote server scenarios
- [ ] Hook up `session.abort()` for the interrupt callback
- [ ] Wire up tool integration (file edits, MCP, etc.)
- [ ] Add follow-up and title generation support
