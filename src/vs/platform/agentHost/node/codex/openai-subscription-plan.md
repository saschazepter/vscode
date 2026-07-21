# Codex Agent Host: OpenAI Account / Subscription Transport

## Executive recommendation

Add an explicit Codex **usage source** with two values:

- **GitHub Copilot** — the current CAPI proxy path and the compatibility default.
- **OpenAI account** — launch the Codex app-server against its normal OpenAI provider and let app-server own ChatGPT OAuth, credential persistence, refresh, account state, and model discovery.

Do not model this as an automatic fallback. A fallback could silently move usage between Copilot quota, a ChatGPT plan, and usage-billed OpenAI API credentials. The UI should always show the active source and, for the OpenAI source, the actual account mode (`ChatGPT`, `API key`, or signed out). This directly addresses the billing ambiguity behind the Claude request and its discoverability follow-up.[S1][S2][S3]

The backend change is smaller than Claude's native transport because Codex app-server already exposes the complete account surface we need: `account/read`, managed ChatGPT browser and device-code login, completion/update notifications, cancellation, logout, rate limits, and `model/list`.[S4][S5] The main engineering work is separating proxy-only startup assumptions, handling the shared app-server lifecycle, and exposing account state/actions to the workbench.

## Current state

The Codex harness currently assumes Copilot at every stage:

1. `getProtectedResources()` always advertises both Copilot and repository GitHub resources, and `_ensureAuthenticated()` requires a GitHub token.[S6]
2. Model discovery always calls Copilot CAPI and filters for the Responses endpoint.[S7]
3. `_startConnection()` always starts `CodexProxyService`, replaces `OPENAI_API_KEY` with the proxy nonce, and injects a `vscode-proxy` model provider through `-c` arguments.[S8]
4. The ready connection always contains an `ICodexProxyHandle`; disposal and token rotation therefore assume a proxy exists.[S6][S9]
5. `account/read` is only logged. `account/updated` and rate-limit notifications are deliberately ignored, so no account state reaches the UI.[S10]

The generated app-server protocol already contains the needed login request/response unions, account notifications, account snapshot, and model catalog types. No upstream Codex protocol change is required for the basic feature.[S11]

## What to reuse from Claude

Claude's implementation provides five patterns worth reusing:

1. **A root host setting selects the transport.** `claudeUseCopilotProxy` defaults to `true`, preserving existing behavior.[S12]
2. **Native mode drops the Copilot protected resource but keeps repository auth.** This prevents model access from being blocked on an unrelated GitHub sign-in.[S13]
3. **Model discovery follows the selected transport.** CAPI remains authoritative in proxy mode; the native harness is authoritative in direct mode.[S13]
4. **Native credentials and user configuration stay with the native SDK.** Claude preserves the subprocess environment instead of copying credentials into VS Code-owned storage.[S14]
5. **Configuration changes are observed reactively, with stale async refreshes guarded.**[S13]

The Claude UX should *not* be copied. Its option is only discoverable by opening a session context menu, selecting **Open Host Settings**, and hand-editing `agent-host-config.json`; the follow-up issue explicitly calls for a normal VS Code setting, first-use choice, and actionable auth errors.[S1][S2][S15]

## Important difference from Claude

Claude materializes a separate SDK subprocess per session, so a transport change can naturally affect only later materializations. Codex uses one app-server process shared by all sessions for the lifetime of `CodexAgent`.[S8][S9]

Therefore the Codex transport must be a property of the **shared runtime**, not individual sessions. A switch must atomically replace that runtime and mark materialized threads for resume. It must never leave one app-server serving a mixture of Copilot and OpenAI-account sessions.

## Proposed backend design

### 1. Use a source enum, not a user-facing boolean

Add a root configuration value such as:

```json
{
  "codexUsageSource": "copilot"
}
```

Allowed values are `copilot` and `openai`; default is `copilot`. Internally, use a discriminated union:

```ts
type CodexTransport =
	| { readonly kind: 'copilot'; readonly githubToken: string }
	| { readonly kind: 'openai' };
```

An enum makes UI copy and telemetry legible and leaves room for a future provider without inverted boolean semantics. If symmetry with Claude is valued more than extensibility, `codexUseCopilotProxy` is workable as the persisted host key, but the user-facing setting should still be an enum.

### 2. Put launch complexity behind one deep module

Extract app-server startup into a `CodexAppServerConnection` module at the process-spawn seam. Its interface should be small:

```ts
start(transport: CodexTransport): Promise<ICodexConnection>
```

The implementation should own binary resolution, environment construction, CLI overrides, proxy acquisition, spawn, initialize/initialized, startup cleanup, and disposal. The returned connection should expose the typed app-server client, selected transport, child process, and one idempotent `dispose()`; callers should not know whether a proxy handle exists.

This concentrates the variant behavior and removes the current optional-proxy checks from token rotation, connection loss, shutdown, and disposal. A pure internal `buildLaunchSpec()` seam can make environment/argument tests cheap without expanding the external interface.

### 3. Preserve the proxy path exactly

For `copilot`:

- Require the Copilot GitHub token.
- Start `CodexProxyService`.
- Set the child `OPENAI_API_KEY` to the proxy nonce.
- Inject the existing `vscode-proxy` provider overrides.
- Keep `requires_openai_auth=false`, Responses wire format, WebSocket disablement, and CAPI-only image-generation disablement.
- Continue fetching models and pricing/policy metadata from CAPI.

This keeps the default behavior and billing unchanged.

### 4. Launch the normal Codex provider for OpenAI accounts

For `openai`:

- Do not start `CodexProxyService`.
- Do not replace `OPENAI_API_KEY` with a proxy nonce.
- Do not inject `model_provider="vscode-proxy"` or any `model_providers.vscode-proxy.*` settings.
- Do not call the proxy-only API-key login path after initialize.
- Preserve `process.env`, the existing `CODEX_HOME` override, and user/global Codex configuration.
- Keep host-integration feature overrides such as `features.tool_call_mcp_elicitation=false` if they are provider-independent; keep `features.image_generation=false` only on the CAPI path because its current rationale is CAPI rejection.[S8]

The normal Codex `CODEX_HOME` contains config, auth, sessions, skills, and other state. Codex CLI and the IDE extension share cached login state, and credentials may live in `auth.json` or the OS credential store depending on `cli_auth_credentials_store`.[S3][S16] Reusing that state means users already signed in with `codex login` should normally be ready without a second login.

Do not copy ChatGPT tokens into agent-host config or VS Code SecretStorage. App-server is the credential owner and already refreshes managed ChatGPT tokens.[S3][S4]

### 5. Make account state first-class

After `initialize`/`initialized`, call `account/read({ refreshToken: false })` and retain a sanitized snapshot:

- source: `copilot` or `openai`
- status: `signedOut`, `signedIn`, `signingIn`, or `error`
- OpenAI auth mode: `chatgpt`, `apiKey`, or another documented mode
- ChatGPT plan type when supplied
- email only if the UI has a concrete need for it; otherwise avoid retaining/transmitting PII

Register `account/login/completed` and `account/updated` before starting a login so a fast completion cannot race listener installation. On completion or account update, re-read account state and refresh the native model catalog.

Do not use experimental `chatgptAuthTokens`. It is documented for host applications that already own the ChatGPT token lifecycle; VS Code should prefer app-server's stable managed login and avoid becoming a token refresh authority.[S5]

### 6. Branch model discovery

For `copilot`, retain `_copilotApiService.models()` and its CAPI metadata mapping.[S7]

For `openai`, paginate `model/list` after app-server initialization and project each visible `Model` into `IAgentModelInfo`:

- `id` from `model`/`id` according to the app-server contract used by thread requests
- `name` from `displayName`
- `supportsVision` from `inputModalities`
- reasoning choices and default from `supportedReasoningEfforts` / `defaultReasoningEffort`
- default ordering from `isDefault`
- no fabricated Copilot pricing or policy metadata

`model/list` is app-server's catalog and filters models according to the active authentication mode; it must be refreshed after login/logout/account changes.[S5][S17]

Native model enumeration requires an app-server connection before a session exists. In OpenAI mode, start the shared runtime during the initial model refresh (as Claude native mode does for its own catalog) rather than waiting for the first turn.

### 7. Protected resources and GitHub token handling

In `copilot`, advertise Copilot plus repository GitHub resources.

In `openai`, advertise only the repository GitHub resource, matching Claude native mode.[S13] A GitHub token received while in OpenAI mode may be retained for repository operations and a later switch back to Copilot, but it must not affect OpenAI account state or model refresh.

When switching to Copilot without a cached Copilot token, emit the existing `auth/required` notification. OpenAI sign-in should not be forced through that notification: it is an RFC 9728 bearer-token flow where the client obtains and pushes a token, while Codex managed login intentionally keeps tokens inside app-server.[S18]

### 8. Shared-runtime switch semantics

Observe root config changes, but serialize them with connection startup and turn execution:

1. Record the desired source and increment a connection generation.
2. If no runtime exists, refresh models using the new source.
3. If a runtime is starting, let it finish only if its generation is current; otherwise dispose it immediately and start the new source.
4. If any turn is active, defer the switch until all turns finish. Show the pending source in UI; do not interrupt a paid/in-progress request.
5. Dispose the old runtime once idle. Deny/cancel pending app-server requests, clear source-specific model state, and mark materialized sessions `needsResume=true`.
6. Start the new runtime, refresh account/models, then allow new turns.

Never automatically fall back from OpenAI to Copilot after an auth, entitlement, rate-limit, or network failure. The error should remain on the selected source so billing does not change without consent.

## Workbench protocol and UI

### Account protocol

The existing `auth/required` / `authenticate` protocol is the wrong seam for managed ChatGPT login because it assumes VS Code obtains a bearer token and sends it to the agent host.[S18]

Add an optional provider-account capability to `AgentInfo` and generic commands routed by provider:

- `agent/account/read`
- `agent/account/login/start`
- `agent/account/login/cancel`
- `agent/account/logout`

The login result should contain only frontend instructions:

- browser: `loginId`, `authUrl`
- device code: `loginId`, `verificationUrl`, `userCode`

Account changes should republish root agent info or emit a typed account notification. Keep raw tokens entirely inside app-server.

The corresponding optional `IAgent` methods can be implemented only by Codex initially. Avoid adding Codex-specific fields to `_meta`; account state affects core UX, error handling, and billing clarity and deserves a typed protocol.

### Local and remote login UX

For a local agent host, call `account/login/start({ type: 'chatgpt' })`, open `authUrl` through VS Code's external opener, and show cancellable progress until `account/login/completed` arrives. App-server hosts the localhost callback and persists/refreshes the resulting tokens.[S4][S5]

For a remote agent host, prefer `chatgptDeviceCode`. A browser-flow callback points to localhost on the machine running app-server, which may not be reachable from the user's local browser. Show the code, provide **Copy Code**, and open `verificationUrl`; cancellation calls `account/login/cancel`.[S4][S5]

### Discoverability

Add a normal VS Code setting, for example:

```json
"chat.agentHost.codexAgent.usageSource": "copilot" // copilot | openai
```

Forward it to the local host using the existing schema-gated `AgentHostRootConfigForwarder` pattern. Remote hosts should continue to use their own host setting because local workbench settings are intentionally not pushed to remote machines.[S19]

Do not rely on **Open Host Settings** as the primary entry point; that command is currently session-context/command-palette driven and is exactly why Claude's option is hard to find.[S2][S15]

Recommended UI:

1. In the new-session/model picker, show a persistent source row or chip: **Usage: GitHub Copilot** or **Usage: OpenAI account**.
2. Make the row actionable and open a two-choice picker with billing-oriented descriptions.
3. In OpenAI mode, show **ChatGPT · Plus/Pro/Business/...**, **OpenAI API key · usage billed by API**, or **Not signed in** based on `account/read`—never label every OpenAI credential as a “subscription.”[S3][S4]
4. If signed out, show **Sign in with ChatGPT** inline before model selection/first send.
5. If an API key is active, offer **Switch to ChatGPT subscription** rather than silently replacing it.
6. On first Codex use with no explicit choice, retain Copilot for compatibility but visibly disclose it and offer **Use OpenAI account instead**. Do not auto-select based only on which credentials happen to exist.
7. Persist the choice at host scope and explain that changing it affects all Codex sessions on that host.

Avoid creating duplicate providers named “Codex via Copilot” and “Codex via OpenAI.” The backend cannot run both concurrently without changing the one-shared-app-server decision, and duplicate providers would fragment session identity and settings. A visible source selector accurately represents the global runtime.

### Logout warning

Codex CLI and the IDE extension share cached credentials. Logging out through app-server can therefore affect other Codex surfaces using the same `CODEX_HOME`.[S3] Either omit logout in the first UI iteration or require confirmation with copy such as: **Sign out of Codex on this machine? This also affects other Codex clients using this Codex home.**

## Error behavior

Use typed host errors and actionable UI rather than passing raw app-server text through unchanged:

| Condition | Required behavior |
| --- | --- |
| OpenAI source, no account | Show **Sign in with ChatGPT** and keep the draft/session intact. |
| Managed token refresh fails | Re-read with `refreshToken: true`, then offer sign-in; do not switch source. |
| Account has API-key auth | Run normally but label usage as API-billed. |
| ChatGPT plan lacks Codex entitlement | Show the app-server error plus account/plan context; do not fall back to Copilot. |
| `forced_login_method` or workspace restriction rejects credentials | Surface that managed configuration rejected the login and link to Codex auth docs.[S3] |
| Login cancelled/window closed | Call `account/login/cancel`, return to signed-out state, and do not report a turn failure. |
| Browser callback cannot complete | Offer device-code login, especially for remote hosts. |
| Source changes during a turn | Defer until idle and show “switch pending.” |
| App-server exits during switch | Use the existing disconnect completion path, dispose both runtime variants idempotently, and retry only on the next explicit action. |
| Model catalog is empty | Distinguish signed-out/account failure from a genuinely empty catalog; do not show only “Codex has no available models.” |
| Multiple windows start login | Coalesce around the app-server `loginId`; only the owner may cancel, while all windows observe account state. |
| Custom `CODEX_HOME` | Read and write auth/config only there; make the active path visible in diagnostics, not normal UI. |
| Keyring unavailable | Let Codex's `cli_auth_credentials_store=auto` fallback behavior apply; do not invent another credential store.[S3] |

Do not log tokens, API keys, device codes, full auth URLs, or email addresses. Plan type and coarse auth mode are sufficient for most telemetry. Any telemetry should record explicit source selection, login outcome category, and source-switch failures—not secrets or account identity.

## Implementation sequence

### PR 1 — backend transport and cached-account support

1. Add `codexUsageSource` to `agentHostCustomizationConfigSchema` with a Copilot default.
2. Extract transport-aware app-server launch/disposal.
3. Branch protected resources, authentication requirements, and model discovery.
4. In OpenAI mode, reuse existing `CODEX_HOME` credentials and expose typed “sign-in required” failures.
5. Add the normal VS Code setting and local root-config forwarder.
6. Show the active source in the new-session UI, even before integrated sign-in exists.

This PR already enables subscription use for users signed in through Codex CLI or another Codex client sharing the same home.

### PR 2 — integrated account UX

1. Add typed provider-account state/capability and account commands to the agent-host protocol.
2. Adapt app-server browser/device-code login, cancellation, updates, and logout.
3. Add local/remote login UI and actionable auth errors.
4. Refresh models after account transitions.
5. Add explicit API-key-versus-ChatGPT billing labels and logout confirmation.

### PR 3 — optional account polish

1. Surface ChatGPT rate-limit state from `account/rateLimits/read` / updates.
2. Add “switch account” and device-code fallback affordances.
3. Consider applying the same visible source-setting pattern to Claude, closing the discoverability gap instead of creating two different UXs.

## Expected file changes

Backend:

- `src/vs/platform/agentHost/common/agentHostCustomizationConfig.ts` — source key/schema.
- `src/vs/platform/agentHost/node/codex/codexAgent.ts` — transport selection, account/model branching, switch orchestration.
- New `src/vs/platform/agentHost/node/codex/codexAppServerConnection.ts` — deep launch/disposal module.
- Existing generated files under `src/vs/platform/agentHost/node/codex/protocol/generated/` — consume, do not hand-edit.
- `src/vs/platform/agentHost/test/node/codex/` — launch-spec, account state, switching, and mapping tests.

Workbench/protocol:

- `src/vs/platform/agentHost/common/agentService.ts` and agent-host protocol sources — optional account interface/capability.
- `src/vs/platform/agentHost/common/agentHostStarter.config.contribution.ts` — normal workbench setting and corrected policy copy (it currently says Codex always uses the Copilot subscription).[S20]
- New contribution beside `agentHostCopilotCliSettingsContribution.ts` — local setting forwarding.
- Agent-session model picker/new-session UI — source/account chip, chooser, and sign-in flow.
- Local and remote provider adapters — account command routing and browser/device-code presentation.

## Test matrix and acceptance criteria

### Unit/integration coverage

- Launch spec: Copilot includes nonce/provider overrides; OpenAI includes neither and preserves environment/`CODEX_HOME`.
- Disposal: both variants are idempotent; failed initialize cleans up child and proxy only when present.
- Protected resources: Copilot requires Copilot + repo; OpenAI requires repo only.
- Model discovery: CAPI mapping remains unchanged; app-server pagination/default/reasoning/vision mapping is correct.
- Account lifecycle: signed out, ChatGPT, API key, completion-before-wait race, cancellation, update, refresh failure.
- Switching: idle, starting, active turn deferred, stale generation, no Copilot token on switch, session resume marking.
- Multiple clients: one login attempt, observer updates, owner-only cancellation.
- Remote login: device-code result and cancellation.
- No silent source fallback on auth, entitlement, network, or rate-limit errors.

### Manual/E2E scenarios

1. Default install remains on Copilot and produces the same CAPI request path.
2. With `codexUsageSource=openai` and an existing ChatGPT login in default `~/.codex`, models load and a turn uses no `CodexProxyService` request.
3. Signed-out local host completes browser login and refreshes models without restarting VS Code.
4. Signed-out remote host completes device-code login.
5. An API-key account is clearly labeled as usage-billed, not subscription-backed.
6. Switching source while idle resumes existing sessions on the new runtime.
7. Switching during a turn waits for completion and never double-sends or changes billing mid-turn.
8. Logout warning is accurate with default and custom `CODEX_HOME`.
9. Corporate proxy/custom CA settings still reach app-server in OpenAI mode.

Before tests, run `npm run typecheck-client` as required by this repository. Then run focused agent-host Codex tests and the CAPI replay E2E suite; add a live-account smoke test only as an opt-in test because it consumes real entitlement/quota.

## Decisions to settle before implementation

1. **Naming:** `codexUsageSource` / `chat.agentHost.codexAgent.usageSource` is recommended over a proxy boolean.
2. **Scope:** host-global is recommended because there is one shared app-server. Per-session source requires separate concurrent runtimes and is a materially larger design.
3. **Switch timing:** defer active switches rather than interrupting turns.
4. **First release:** decide whether cached-login support and integrated login ship together. Backend support can land first, but the visible source selector should not be deferred.
5. **Logout:** omit initially or ship with a cross-client warning.
6. **Remote auth:** device code should be the default for remote hosts.

## Sources

- **[S1]** [microsoft/vscode#314952 — Allow Claude Agent to run through Anthropic subscription instead of Copilot quota](https://github.com/microsoft/vscode/issues/314952)
- **[S2]** [microsoft/vscode#323049 — Improve discoverability of native (BYOK) Claude in the agent host](https://github.com/microsoft/vscode/issues/323049)
- **[S3]** [OpenAI Codex authentication](https://developers.openai.com/codex/auth)
- **[S4]** [OpenAI Codex app-server documentation](https://learn.chatgpt.com/docs/app-server)
- **[S5]** [openai/codex app-server README — auth endpoints](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#auth-endpoints)
- **[S6]** `src/vs/platform/agentHost/node/codex/codexAgent.ts:771`
- **[S7]** `src/vs/platform/agentHost/node/codex/codexAgent.ts:1047`
- **[S8]** `src/vs/platform/agentHost/node/codex/codexAgent.ts:1097`
- **[S9]** `src/vs/platform/agentHost/node/codex/codexAgent.ts:2269`
- **[S10]** `src/vs/platform/agentHost/node/codex/codexAgent.ts:1743`
- **[S11]** `src/vs/platform/agentHost/node/codex/protocol/generated/v2/LoginAccountParams.ts:9`, `src/vs/platform/agentHost/node/codex/protocol/generated/v2/LoginAccountResponse.ts:9`, and `src/vs/platform/agentHost/node/codex/protocol/generated/v2/Model.ts:16`
- **[S12]** [microsoft/vscode#323037 — Claude native transport implementation](https://github.com/microsoft/vscode/pull/323037) and `src/vs/platform/agentHost/common/agentHostCustomizationConfig.ts:86`
- **[S13]** `src/vs/platform/agentHost/node/claude/claudeAgent.ts:455`
- **[S14]** `src/vs/platform/agentHost/node/claude/claudeSdkOptions.ts:93`
- **[S15]** `src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostSettings.contribution.ts:61`
- **[S16]** [OpenAI Codex environment variables and `CODEX_HOME`](https://learn.chatgpt.com/docs/config-file/environment-variables)
- **[S17]** [openai/codex model-list implementation](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/catalog_processor.rs)
- **[S18]** `src/vs/platform/agentHost/common/state/protocol/common/notifications.ts:23`
- **[S19]** `src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostRootConfigForwarder.ts:29`
- **[S20]** `src/vs/platform/agentHost/common/agentHostStarter.config.contribution.ts:124`
