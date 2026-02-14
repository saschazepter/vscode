# Agent Host Process Architecture

## Overview

The agent host is a dedicated Electron **utility process** that runs agent logic in isolation from the main process and renderer. It follows the same pattern as the **pty host** (`src/vs/platform/terminal/`), communicating over **MessagePort** via the standard `ProxyChannel` IPC infrastructure.

## Process Model

```
┌─────────────────────┐
│   Renderer Window   │
│  (workbench UI)     │
│                     │
│  IAgentHostService  │◄── channel proxy via main process
│                     │    (or direct MessagePort later)
└──────────┬──────────┘
           │ Electron IPC
┌──────────▼───────────┐
│    Main Process      │
│                      │
│  AgentHostService    │◄── proxies to utility process
│  ElectronAgentHost-  │    via MessagePort
│    Starter           │
└──────────┬───────────┘
           │ MessagePort
┌──────────▼────────────┐
│  Agent Host Process   │
│  (utility process)    │
│                       │
│  AgentService         │◄── real implementation lives here
│                       │
└───────────────────────┘
```

## File Layout

```
src/vs/platform/agent/
├── common/
│   ├── agent.ts            # IAgentHostStarter, IAgentHostConnection (starter contract)
│   └── agentService.ts     # IAgentService, IAgentHostService interfaces, IPC channel constants
├── electron-main/
│   └── electronAgentHostStarter.ts   # Spawns utility process, brokers MessagePort connections
└── node/
    ├── agentHostMain.ts     # Entry point inside the utility process
    ├── agentService.ts      # AgentService — the real implementation (runs in the utility process)
    └── agentHostService.ts  # AgentHostService — wrapper in main process, proxies via MessagePort
```

## How It Works

### Startup (lazy)

1. `ElectronAgentHostStarter` is created in `app.ts` → `initServices()` and handed to `AgentHostService`.
2. The utility process is **not** spawned immediately. It starts lazily on the first call to `IAgentHostService` (e.g., `ping()`).
3. On start, `ElectronAgentHostStarter.start()` calls `UtilityProcess.fork()` with entry point `vs/platform/agent/node/agentHostMain`, then `utilityProcess.connect()` to get a `MessagePortMain`.
4. The port is wrapped in a `MessagePortClient` which gives us an `IChannelClient`.

### Message Flow

A call like `agentHostService.ping("hello")` flows:

1. `AgentHostService.ping()` → ensures the utility process is running
2. Calls `this._proxy.ping("hello")` — the proxy is built via `ProxyChannel.toService(client.getChannel('agentHost'))`
3. The call is serialized over the MessagePort to the utility process
4. Inside the utility process, `UtilityProcessServer` receives it and routes to the `agentHost` channel
5. `AgentService.ping()` runs, returns `"pong: hello"`
6. Response flows back over the same MessagePort

### Direct Window Connections

For lower-latency communication, renderers can establish a **direct MessagePort** to the agent process (bypassing the main process as a relay). The plumbing is in place:

- Renderer sends `vscode:createAgentHostMessageChannel` IPC message
- Main process calls `utilityProcess.connect()`, sends one port to the renderer, the other to the agent process
- Renderer receives `vscode:createAgentHostMessageChannelResult` with the port

The renderer-side consumer (`acquirePort()`) is not yet wired up — add it when direct window connections are needed.

### Crash Recovery

`AgentHostService` monitors the utility process exit. On unexpected termination, it automatically restarts (up to 5 times). The proxy is rebuilt on each restart.

## Wiring in app.ts

In `CodeApplication.initServices()`:
```typescript
const agentHostStarter = new ElectronAgentHostStarter(this.lifecycleMainService, this.logService);
const agentHostService = new AgentHostService(agentHostStarter, this.logService);
services.set(IAgentHostService, agentHostService);
```

In `openMainProcessElectronIPC()`:
```typescript
const agentHostChannel = ProxyChannel.fromService(accessor.get(IAgentHostService), disposables);
mainProcessElectronServer.registerChannel(AgentHostIpcChannels.AgentHost, agentHostChannel);
```

## Closest Analogs

| Component | Pattern | Key Difference |
|---|---|---|
| **Pty Host** | Singleton utility process, MessagePort, lazy start, heartbeat | Pty host also has heartbeat monitoring and reconnect logic |
| **Shared Process** | Singleton utility process, MessagePort | Much heavier, hosts many services, tightly coupled to app lifecycle |
| **Extension Host** | Per-window utility process (`WindowUtilityProcess`), custom `RPCProtocol` | Uses custom RPC, not standard channels; tied to window lifecycle |

The agent host most closely follows the pty host pattern but is simpler — no heartbeat, no reconnect constants, no environment variable plumbing (yet).

## TODO

- [ ] Replace `ping()` placeholder with real agent service API
- [ ] Add renderer-side `acquirePort()` for direct MessagePort connections
- [ ] Consider whether this should be singleton (current) or per-window
- [ ] Add heartbeat monitoring if crash detection latency matters
- [ ] Wire up logging inside the utility process (like pty host's `LoggerChannel`)
- [ ] Support non-Electron spawning (`NodeAgentHostStarter` via `child_process.fork`) for remote server scenarios
