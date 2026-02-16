# Agent host design decisions

> **Keep this document in sync with the code.** Any change to the agent-host protocol, tool rendering approach, or architectural boundaries must be reflected here. If you add a new `toolKind`, change how tool-specific data is populated, or modify the separation between agent-specific and generic code, update this document as part of the same change.

Design decisions and principles for the agent-host feature. For process architecture and IPC details, see [architecture.md](architecture.md). For the task backlog, see [backlog.md](backlog.md).

## Agent-agnostic protocol

**The IPC protocol between the agent-host process and the renderer must remain agent-agnostic.** This is a hard rule.

The renderer-side code (`agentHostChatContribution.ts` and everything in the workbench layer) must never contain knowledge of specific agent tool names, parameter shapes, or SDK-specific behavior. It consumes display-ready fields from the protocol and renders them generically.

All agent-specific logic -- translating tool names like `shell`/`view`/`grep` into display strings, extracting command lines from tool parameters, determining rendering hints like `toolKind: 'terminal'` -- lives exclusively in the agent-host process layer (`src/vs/platform/agent/node/`), specifically in `copilotToolDisplay.ts`.

What this means concretely:

- `IAgentToolStartEvent` carries `displayName`, `invocationMessage`, `toolInput`, and `toolKind` -- all computed by the agent-host from SDK-specific data.
- `IAgentToolCompleteEvent` carries `pastTenseMessage` and `toolOutput` -- also computed agent-side.
- The renderer creates `ChatToolInvocation` objects and `toolSpecificData` (e.g., `IChatTerminalToolInvocationData`) purely from these protocol fields.
- If we swap out the Copilot SDK for a different agent, only the agent-host process code needs to change. The renderer and the protocol shape stay the same.

## Tool rendering

Tools from the agent-host render using the same UI components as VS Code's native chat agent. The protocol carries enough information for the renderer to choose the right rendering without knowing tool names:

- **Shell commands** (`toolKind: 'terminal'`): Rendered as `IChatTerminalToolInvocationData` with the command in a syntax-highlighted code block, output displayed below, and exit code for success/failure styling. The renderer checks `toolKind === 'terminal'` and `toolInput` to decide this -- it never checks the tool name.
- **Everything else**: Rendered via `ChatToolProgressSubPart` using `invocationMessage` (while running) and `pastTenseMessage` (when complete). No `toolSpecificData` is set -- the standard progress/completion UI handles it.

We intentionally do not use `IChatSimpleToolInvocationData`. The terminal rendering path gives us proper command display with syntax highlighting for shell tools, and the progress message path is sufficient for all other tools.

## Copilot SDK tool name mapping

The Copilot CLI uses these built-in tools. Tool names and parameter shapes are not typed in the SDK (`toolName` is `string`) -- they come from the CLI server. The interfaces in `copilotToolDisplay.ts` are derived from observing actual CLI events and the `ShellConfig` class in `@github/copilot`.

Shell tools follow a naming pattern per `ShellConfig`: `shellToolName`, `readShellToolName`, `writeShellToolName`, `stopShellToolName`, `listShellsToolName`. `ShellType` is `"bash" | "powershell"`.

| SDK tool name | Display name | Parameters | Rendering |
|---|---|---|---|
| `bash` | Bash | `{ command: string, timeout?: number }` | Terminal command block (`toolKind: 'terminal'`, language `shellscript`) |
| `powershell` | PowerShell | `{ command: string, timeout?: number }` | Terminal command block (`toolKind: 'terminal'`, language `powershell`) |
| `read_bash` | Read Shell Output | | Progress message |
| `write_bash` | Write Shell Input | | Progress message |
| `bash_shutdown` | Stop Shell | | Progress message |
| `list_bash` | List Shells | | Progress message |
| `read_powershell` | Read Shell Output | | Progress message |
| `write_powershell` | Write Shell Input | | Progress message |
| `list_powershell` | List Shells | | Progress message |
| `view` | View File | `{ file_path: string }` | Progress message |
| `edit` | Edit File | `{ file_path: string }` | Progress message |
| `write` | Write File | `{ file_path: string }` | Progress message |
| `grep` | Search | `{ pattern: string, path?: string, include?: string }` | Progress message |
| `glob` | Find Files | `{ pattern: string, path?: string }` | Progress message |
| `patch` | Patch | | Progress message |
| `web_search` | Web Search | | Progress message |
| `ask_user` | Ask User | | Progress message |

This mapping lives in `copilotToolDisplay.ts` and is the only place that knows about Copilot-specific tool names. The file defines typed interfaces (`ICopilotShellToolArgs`, `ICopilotFileToolArgs`, `ICopilotGrepToolArgs`, `ICopilotGlobToolArgs`) for the known parameter shapes.

## Which tools -- ours or theirs?

The SDK has its own built-in tools (shell, file operations, etc.) and VS Code has its own (terminal, file editing, search, etc.). Currently the SDK runs its own tools and VS Code just renders the results. The question of whether to replace SDK tools with VS Code tools (or vice versa) is a product decision that's still open. The plumbing to plug in VS Code tools is described in the backlog (#1).

The same question applies to MCP: do we use VS Code's MCP server management, or the SDK's MCP implementation, or both?

## Model ownership -- open question

When using the agent-host, do we need VS Code's own Copilot model access at all, or does everything flow through the SDK? Currently the Copilot extension registers language models and the agent-host registers its own from `client.listModels()`. These may overlap or diverge. Key questions:

- **Does VS Code need independent model access?** The SDK makes its own LM requests using the GitHub token. If all agent-host interactions go through the SDK, VS Code never directly calls a model. The model list from the SDK would be the only source of truth for which models are available in agent-host sessions.
- **Can the model lists diverge?** The SDK's available models depend on the CLI version and server-side configuration. VS Code's Copilot extension has its own model list. These could differ, especially during rollouts or for BYOK users.
- **What happens to BYOK?** The SDK doesn't support custom endpoints (see blocked items in backlog). If a user has BYOK configured, the agent-host can't use it. This means the model picker for agent-host sessions should only show SDK models, not BYOK models.
- **Current approach (proof of concept):** The agent-host registers an `ILanguageModelChatProvider` that exposes SDK models in the picker. The selected model ID is passed to `createSession({ model })`. The SDK handles its own model resolution. The `sendChatRequest` method throws -- agent-host models aren't usable for direct LM calls, only for the agent loop.

## Internal registration (no extension point)

The `agent-host` session type bypasses the `chatSessions` extension point entirely. `AgentHostChatContribution` directly registers a dynamic chat agent, session item controller, session content provider, and new session command from a desktop-only workbench contribution. See [sessions.md](sessions.md) for details on how this differs from extension-contributed session types.
