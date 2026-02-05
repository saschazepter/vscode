# MCP Gateway Feature Implementation Plan

## Context

This feature adds a new `vscode.lm.startMcpGateway()` API that creates HTTP-based MCP gateway endpoints. External processes (such as CLI-based agent loops) can connect to these endpoints to interact with MCP servers known to the editor.

### Architecture

The implementation follows VS Code's existing IPC patterns (similar to `NativeMcpDiscovery`):

1. **Platform level** (`src/vs/platform/mcp/`): The actual HTTP server runs in the main process (desktop) or remote server. This is where Node.js `http` module is used.

2. **Workbench level** (`src/vs/workbench/contrib/mcp/`): The workbench services communicate with the platform service via IPC channels (ProxyChannel).

3. **Extension API**: Extensions call `vscode.lm.startMcpGateway()` which flows through ExtHost → MainThread → WorkbenchService → PlatformService (via IPC).

### Key Design Decisions

- **`IMcpGatewayResult` is `IDisposable`**: The result includes `address: URI` and `dispose()` method
- **`MainThreadMcp` uses `DisposableMap`**: Gateways tracked by `gatewayId`, auto-cleaned when MainThread is disposed
- **Function named `startMcpGateway`**: To comply with lint rules (`createXYZ` must return sync)
- **`inRemote` parameter**: `createGateway(inRemote: boolean)` determines where the gateway is created:
  - `ExtensionHostKind.Remote` → `inRemote: true` (gateway on remote server)
  - `ExtensionHostKind.LocalWebWorker` with remote → `inRemote: true` (browser connected to remote)
  - `ExtensionHostKind.LocalProcess` → `inRemote: false` (gateway in desktop main process)
- **Auto-dispose on client disconnect**: `McpGatewayService.registerConnectionHub(hub, getClientId)` allows the service to internally listen for client disconnections and clean up their gateways. Callers (app.ts, serverServices.ts) just register the hub at startup.
- **Secure random route IDs**: Each gateway gets `/gateway/{uuid}` to make URLs unguessable
- **Shared HTTP server**: Single server per environment, ref-counted lifecycle

## Tasks

### Completed

- [x] Define proposed API types in `vscode.proposed.mcpServerDefinitions.d.ts`
  - Added `McpGateway` interface extending `Disposable`
  - Added `startMcpGateway(): Thenable<McpGateway | undefined>`

- [x] Create platform-level IPC interface (`src/vs/platform/mcp/common/mcpGateway.ts`)
  - `IMcpGatewayService` with `createGateway()` and `disposeGateway()`
  - `McpGatewayChannelName` constant

- [x] Implement Node.js HTTP server (`src/vs/platform/mcp/node/mcpGatewayService.ts`)
  - Shared server with ref-counting
  - Secure random route IDs per gateway
  - Dynamic port allocation (port 0)
  - Stub request handler (returns 501 Not Implemented)
  - `registerConnectionHub()` for automatic cleanup on client disconnect

- [x] Create IPC channel for remote server (`src/vs/platform/mcp/node/mcpGatewayChannel.ts`)
  - Extracts `clientId` from `RemoteAgentConnectionContext` for gateway tracking

- [x] Create IPC channel for electron-main (`src/vs/platform/mcp/electron-main/mcpGatewayMainChannel.ts`)
  - Extracts `ctx` (client ID string) for gateway tracking

- [x] Register in electron-main (`src/vs/code/electron-main/app.ts`)
  - Service registration with `SyncDescriptor`
  - Custom `McpGatewayMainChannel` for client tracking
  - Calls `registerConnectionHub(server, ctx => ctx)` for cleanup

- [x] Register in remote server (`src/vs/server/node/serverServices.ts`)
  - Service registration
  - `McpGatewayChannel` with URI transformer
  - Calls `registerConnectionHub(server, ctx => ctx.clientId)` for cleanup

- [x] Create workbench service interface (`src/vs/workbench/contrib/mcp/common/mcpGatewayService.ts`)
  - `IWorkbenchMcpGatewayService`
  - `IMcpGatewayResult extends IDisposable`

- [x] Implement electron workbench service (`src/vs/workbench/contrib/mcp/electron-browser/mcpGatewayService.ts`)
  - Uses `IMainProcessService` + `ProxyChannel.toService`

- [x] Implement browser workbench service (`src/vs/workbench/contrib/mcp/browser/mcpGatewayService.ts`)
  - Uses `IRemoteAgentService.getConnection().withChannel()`
  - Returns `undefined` in serverless web (no remote connection)

- [x] Register workbench services in contribution files
  - `electron-browser/mcp.contribution.ts`
  - `browser/mcp.contribution.ts`

- [x] Update extension host protocol (`src/vs/workbench/api/common/extHost.protocol.ts`)
  - Added `$startMcpGateway()` and `$disposeMcpGateway()` to `MainThreadMcpShape`

- [x] Implement ExtHost gateway method (`src/vs/workbench/api/common/extHostMcp.ts`)
  - `startMcpGateway()` in `IExtHostMpcService`

- [x] Implement MainThread gateway (`src/vs/workbench/api/browser/mainThreadMcp.ts`)
  - `$startMcpGateway()` and `$disposeMcpGateway()`
  - Uses `DisposableMap<string, IMcpGatewayResult>` for tracking
  - Returns `undefined` for `LocalWebWorker` without `remoteAuthority`

- [x] Wire up API in `extHost.api.impl.ts`
  - `startMcpGateway()` in `lm` namespace with proposal check

- [x] Clean up old files
  - Removed `src/vs/workbench/contrib/mcp/node/mcpGatewayService.ts` (was incorrect layer)

### Remaining

- [ ] Implement actual MCP protocol handling in `McpGatewayRoute.handleRequest()`
  - Currently returns stub 501 response
  - Need to integrate with `IMcpRegistry` to route requests to MCP servers

- [ ] Add configuration setting `mcp.gateway.port` for explicit port selection
  - Currently always uses dynamic port (0)

- [ ] Add unit tests
  - Test gateway creation/disposal lifecycle
  - Test server start/stop ref-counting
  - Test secure route ID generation

- [ ] Add integration tests
  - Test API returns valid localhost URI in desktop
  - Test API returns `undefined` in serverless web
  - Test HTTP endpoint responds

## File Summary

### New Files

| File | Purpose |
|------|---------|
| `src/vs/platform/mcp/common/mcpGateway.ts` | Platform service interface + channel name |
| `src/vs/platform/mcp/node/mcpGatewayService.ts` | HTTP server implementation with per-client tracking |
| `src/vs/platform/mcp/node/mcpGatewayChannel.ts` | IPC channel for remote server (extracts clientId) |
| `src/vs/platform/mcp/electron-main/mcpGatewayMainChannel.ts` | IPC channel for electron-main (extracts ctx) |
| `src/vs/workbench/contrib/mcp/common/mcpGatewayService.ts` | Workbench service interface |
| `src/vs/workbench/contrib/mcp/browser/mcpGatewayService.ts` | Browser workbench impl |
| `src/vs/workbench/contrib/mcp/electron-browser/mcpGatewayService.ts` | Electron workbench impl |

### Modified Files

| File | Changes |
|------|---------|
| `src/vscode-dts/vscode.proposed.mcpServerDefinitions.d.ts` | Added `McpGateway` + `startMcpGateway()` |
| `src/vs/code/electron-main/app.ts` | Register service + custom channel + onDidRemoveConnection cleanup |
| `src/vs/server/node/serverServices.ts` | Register service + channel + onDidRemoveConnection cleanup |
| `src/vs/workbench/contrib/mcp/browser/mcp.contribution.ts` | Register browser service |
| `src/vs/workbench/contrib/mcp/electron-browser/mcp.contribution.ts` | Register electron service |
| `src/vs/workbench/api/common/extHost.protocol.ts` | Added protocol methods |
| `src/vs/workbench/api/common/extHostMcp.ts` | Added `startMcpGateway()` |
| `src/vs/workbench/api/browser/mainThreadMcp.ts` | Added gateway handling with DisposableMap |
| `src/vs/workbench/api/common/extHost.api.impl.ts` | Wired up API |
