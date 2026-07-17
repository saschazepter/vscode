# 04 — Responsibility Overlap, Module Depth, and the Deletion Test

Analysis of the four core runtime files against the architecture vocabulary in
`../CONTEXT.md` ("Language" section) and the `improve-codebase-architecture`
LANGUAGE.md (Module, Interface, Depth, Seam, Deletion test).

Files and sizes (LOC):

| File | LOC | Role |
|---|---|---|
| `claudeAgent.ts` | 2247 | `IAgent` provider + (hidden) peer-chat manager |
| `claudeAgentSession.ts` | 1092 | per-session/per-chat coordinator |
| `claudeSdkPipeline.ts` | 689 | one SDK `Query` lifecycle |
| `claudePromptQueue.ts` | 171 | prompt iterable + deferred bookkeeping |

> **Interface size** below = public methods + getters + events a caller must
> know, plus the *ordering constraints* (invariants a caller must uphold that
> the module cannot enforce itself). Depth = hidden behaviour ÷ interface.

---

## 1. Per-module depth verdict

| Module | Stated responsibility (quoted JSDoc) | Interface size | Deep / shallow | Deletion-test result |
|---|---|---|---|---|
| **ClaudePromptQueue** | "Owns the prompt queue + the async iterable handed to `WarmQuery.query()`. Knows nothing about the SDK Query lifecycle, config push, or message dispatch" (`claudePromptQueue.ts:31-33`) | 8 members (`iterable`, `isEmpty`, `push`, `peekParent`, `settleHead`, `failAll`, `notifyAborted`, `resetForRebind`) + 4-arg ctor + exported `IPendingSdkMessage`. **4 leaked ordering constraints** (see below). | **Deep-but-leaky.** Hides a genuinely tricky parked async-iterator (`:62-83`) and the M10 steering-preempt batch (`settleHead :126-143`, `_popped :59`). But 4 of its 8 methods only make sense in a fixed call order the *pipeline* must drive. | Deleting it would relocate ~90 lines of async-iterator + batch logic into the pipeline. Complexity **relocates, shrinks a seam** — see §4. |
| **ClaudeSdkPipeline** | "Owns one SDK Query lifecycle… Knows nothing about protocol turns, the workbench mapper, file-edit observers, or permission registries" (`:37-41`) | **18 methods/getters + 1 event + 8-arg ctor.** | **Deep core, bloated surface.** The rebind/recover/replay state machine (`_rebindQuery :550`, `_runConsumerLoop :508`, `_replayCurrentConfig :526`, `_processMessages :617`) is deep. But the surface is padded by a 4-method config cluster (`setModel/setEffort/setPermissionMode/seedCurrentConfig`) and a 4-method customization cluster (`reloadPlugins/snapshotResolvedCustomizations/startMcpServer/stopMcpServer`) — two of which (`reloadPlugins`, `setClientToolOwner`) are **dead**. | Keep the core; the config/customization surface is the bloat. Deleting the module fails — complexity reappears. |
| **ClaudeAgentSession** | "Per-session coordinator. Owns: per-session identity… the ClaudeSdkPipeline… Pending-permission and pending-user-input registries" (`:89-99`) — a 3-bullet claim. | **~30 methods + ~20 getters/fields/events.** | **Shallow-per-concern god-object.** The 3-bullet JSDoc undersells it: the class actually owns **≥15 responsibilities** (enumerated below). Many methods are 1-3 line forwards (shallow); the heavy ones (`materialize :423`, `getSessionCustomizations :1007`) are deep but unrelated to each other. | Cannot delete — but it is the merge point of two-to-three distinct modules. |
| **ClaudeAgent** | "Phase 4 skeleton IAgent provider… intentionally lean: each subsequent phase adds one concern" (`:196-213`) | IAgent surface (~25 methods) **+ a hidden ~17-member peer-chat module**. | **Two modules in a trench coat.** The `IAgent` provider surface is real; the peer-chat lifecycle cluster is a second, cohesive module hiding inside it. | Cannot delete; **should be split** (§5). |

### ClaudeAgentSession's real responsibility count (vs. its 3-bullet JSDoc)

1. Identity (`sessionId/sessionUri/chatChannelUri/workspace/_storageUri :113`)
2. Materialize + Options build (`:423`)
3. Rematerializer closure construction (`:534-572`) — builds `Options` a **second time**
4. Permission registry (`_pendingPermissions :200`, `requestPermission :838`)
5. User-input registry (`_pendingUserInputs :206`, `requestUserInput :870`)
6. Client-tool diff ownership (`toolDiff :217`, `setClientTools :900`)
7. Client-customization diff ownership (`clientCustomizationsDiff :233`)
8. Credits accounting (`_currentTurnNanoAiu :247`, `recordTurnCredits :262`, `_enrichSignalWithCredits :274`)
9. MCP-contributor signal enrichment (`_enrichSignalWithMcpContributor :301`)
10. Customization discovery / disk-scan orchestration (`getSessionCustomizations :1007` — fans out to **5 scanners** in one `Promise.all`)
11. Metadata-overlay writes (`_metadataStore.write` at `:513, :762, :790`)
12. Steering message construction (`injectSteering :800`)
13. Model/agent/permission-mode change (`setModel :750`, `setAgent :780`, `setPermissionMode :825`)
14. MCP server start/stop (`startMcpServer :1051`, `stopMcpServer :1064`)
15. Truncation/prune DB writes (`truncateToTurn :386`, `pruneAllTurns :392`, `_withDatabase :401`)
16. File watching (`_watchCustomizations :352`)

That is a coordinator in name and a god-object in fact.

### ClaudeAgent's hidden second module (peer-chat manager)

A cohesive ~17-member cluster with its own state map (`_chatBackings :273`), its
own event (`onDidChangeChatData :281`), and its own lifecycle:
`chats` (`:860`), `_resolveChatTarget :889`, `_createChat :1225`, `_disposeChat
:1287`, `_resolveParentSession :1318`, `_forkChat :1352`, `_resolveChatSdkId
:1373`, `_resolveChatBacking :1389`, `_ensureSessionEntry :1399`,
`_materializeChatLocked :1433`, `_buildProvisionalChat :1463`,
`_updateChatBackingModel :1505`, `materializeChat :1523`, `_findChat :350`,
`_findSessionBySdkId :383`. This is a `ClaudeChatManager` waiting to be extracted.

---

## 2. Overlapping-responsibility map (the smear)

### 2a. Permission-mode resolution — smeared across **4 files, 8 sites**

The single value `permissionMode` is read, narrowed, and fallback-chained in
eight places with **three different fallback tails**:

| Site | File:line | Fallback tail |
|---|---|---|
| `narrowClaudePermissionMode` (the one true narrower) | `common/claudeSessionConfigKeys.ts:37` | — |
| `readClaudePermissionMode` (live config read) | `claudeSessionPermissionMode.ts:23` | `undefined` |
| `resolveCurrentPermissionMode` (read + fallback) | `claudeAgentSession.ts:81` | `?? permissionModeFallback` |
| `ClaudeAgent._resolvePermissionMode` (create-config bag) | `claudeAgent.ts:1117` | `?? 'default'` |
| fork inheritance | `claudeAgent.ts:936` | `?? sourceOverlay.permissionMode` |
| resume | `claudeAgent.ts:1066` | `?? overlay.permissionMode ?? 'default'` |
| `_resolveParentSession` (peer chat) | `claudeAgent.ts:1342` | `?? overlay.permissionMode ?? 'default'` |
| `_buildProvisionalChat` (peer chat) | `claudeAgent.ts:1475` | `?? overlay.permissionMode ?? parentSession.permissionMode` |
| materialize seed | `claudeAgentSession.ts:439` | `?? this._permissionModeFallback` |
| rematerializer re-read | `claudeAgentSession.ts:535` | `?? this._permissionModeFallback` |
| send pre-flight | `claudeAgentSession.ts:700` | via `resolveCurrentPermissionMode` |
| `onSessionConfigChanged` mid-turn | `claudeAgent.ts:1998, 2003` | `?? chat.permissionModeFallback` |

Then the pipeline keeps its **own** applied/current cache
(`_currentPermissionMode`/`_appliedPermissionMode` `:196, :201`,
`setPermissionMode :472`, `_replayCurrentConfig :536`). **Flow of one mode:**
create-config → `_resolvePermissionMode` → `createProvisional(permissionModeFallback)`
→ stored as `_permissionModeFallback` → materialize re-reads live config *and*
falls back to the stored one → seeds `pipeline.seedCurrentConfig` → send pre-flight
re-reads live config *again* → `pipeline.setPermissionMode` (deduped by the
bijective cache) → `_replayCurrentConfig` re-applies after rebind. The **same
value is re-resolved from `IAgentConfigurationService` at least 3× per turn**
(materialize, send pre-flight, and — pre-Phase — the canUseTool gate documented in
`claudeSessionPermissionMode.ts:23-24`). The narrowing is DRY (one function); the
**fallback chaining is copy-pasted 8×** with subtly different tails.

### 2b. Config replay / bijective cache — split session ↔ pipeline

The "remember the user's chosen model/effort/mode and re-apply after rebind"
responsibility straddles the seam:

- **Session side:** `setModel :750` (writes provisional + forwards + persists
  overlay + separately calls `setEffort`), `setAgent :780`, materialize's
  `seedCurrentConfig` call `:501-505`, and the **dead** `seedBijectiveState :664`.
- **Pipeline side:** the actual cache — `_currentModel/_currentEffort/_currentPermissionMode`
  (`:199-201`), `_appliedModel/_appliedEffort/_appliedPermissionMode` (`:194-196`),
  `seedCurrentConfig :327`, `setModel :342`, `setEffort :366`, `setPermissionMode
  :472`, and `_replayCurrentConfig :526`.

Effort is a standout smear: the SDK has no `setEffort`, so the session **derives
effort from the model** (`resolveClaudeEffort(model)` at `:503, :760`) and pushes
it as a *separate* pipeline call, while the pipeline stores it as a *first-class*
cached axis. One concept (model selection) is decomposed into two cached axes that
must be kept in lockstep by hand across two files.

### 2c. Abort — **3 owners, one mutable controller**

| Actor | What it does | Site |
|---|---|---|
| Session (birth) | `new AbortController()` in `createProvisional :177`; stored as `readonly abortController :134`; passed to pipeline at materialize `:481` | session |
| Agent (provisional path) | aborts `session.abortController` **directly** when `!isPipelineReady` — 6 sites: `:1186, :1193, :1298, :1826, :1946, :2219` | agent |
| Session (live path) | `abort() :730` denies pending registries then `pipeline.abort()` | session |
| Pipeline (owner-of-record) | `_abortController :178` — **mutable, swapped on every rebind** (`:560, :588`); `abort() :456`, `shutdownAndWait :289`, dispose chain `:258` | pipeline |
| Queue (observer) | reads the signal via injected closure `() => this._abortController.signal` (`pipeline :245`), and `notifyAborted :163` woken by `_wireAbortHandler :480` | queue |

**Who owns it?** Nobody cleanly. The session holds the *original* controller as a
`readonly` field, but after the first rebind the pipeline's `_abortController`
is a **different object** (`:560, :588`) — so `session.abortController` and the
controller the pipeline actually aborts have **diverged**. This is safe only
because the agent aborts `session.abortController` exclusively in the
pre-materialize window (`!isPipelineReady`), an invariant enforced by convention,
not by types. The abort concept is genuinely smeared: **born in the session,
owned-and-swapped by the pipeline, observed by the queue.**

### 2d. Turn-complete / result settlement — split queue ↔ pipeline (the M10 seam)

The "a turn finished" decision is split into two halves living in two files:

- **Deferred settlement** lives in the queue: `settleHead :126-143` pops the
  yielded head and, *iff `this.isEmpty`*, batch-completes `_popped` (the M10
  steering-preempt batch). The queue decides **when the `sendMessage` promise
  resolves.**
- **`ChatTurnComplete` emission** lives in the pipeline: `_processMessages
  :642-658` calls `settleHead()` then **re-checks `this._queue.isEmpty`** and only
  then fires `ChatTurnComplete`.

Both consult `isEmpty`; the "is this turn really done" predicate is evaluated
**twice, once on each side of the seam**, per `result` message. The M10 invariant
(intermediate steering `result`s must not settle the original deferred nor fire
turn-complete) is therefore enforced in **two places that must agree**. If the
queue's batch rule and the pipeline's emission guard ever drift, steering breaks
silently. This is the awkward split the maintainer flagged: the turn *lifecycle*
lives in the queue, the turn *signal* lives in the pipeline.

### 2e. Customizations — smeared across all three of agent/session/pipeline

| Layer | Touchpoints |
|---|---|
| **Agent** | `syncClientCustomizations :2112` (drives `IAgentPluginManager` + `adoptClientCustomizations`), `_fireCustomizationUpdated :2141`, `setCustomizationEnabled :2152`, `getCustomizations :2158` (returns `[]`), `getSessionCustomizations :2173` (pure forward) |
| **Session** | `clientCustomizationsDiff :233`, `adoptClientCustomizations :973`, `setClientCustomizationEnabled :978`, `getSessionCustomizations :1007` (5-scanner fan-out + SDK filter + built-in fold), `_lastCustomizations :992`, `_enrichSignalWithMcpContributor :301`, `_resolveMcpServerName :1078`, `startMcpServer/stopMcpServer :1051/:1064` |
| **Pipeline** | `snapshotResolvedCustomizations :109`, `_initPlugins :191` (captured in `_processMessages :630`), `reloadPlugins :95` **(dead)**, `startMcpServer/stopMcpServer :119/:130` |

The projection (`getSessionCustomizations`) lives in the session; the SDK-resolved
snapshot lives in the pipeline; the plugin-manager sync lives in the agent; MCP
start/stop is **triplicated** (agent forward → session resolve+rebind → pipeline
SDK toggle). Enabling a customization can touch all three files in one call chain.

---

## 3. Pass-through inventory

### 3a. ClaudeAgentSession → ClaudeSdkPipeline (near-pure forwards)

| Session method | Forwards to | Live? |
|---|---|---|
| `isResumed :645` | `pipeline.isResumed` | test-only consumer |
| `hasActiveTurn :633` | `pipeline.hasActiveTurn` | ✅ (agent `:1164`) |
| `shutdownLiveQuery :654` | `pipeline.shutdownAndWait` | ✅ (agent `:826`) |
| `setPermissionMode :825` | `pipeline.setPermissionMode` | ✅ (agent `:2004`) |
| `attachRematerializer :668` | `pipeline.attachRematerializer` | ❌ **dead** — real attach is direct at `:534` |
| `seedBijectiveState :664` | `pipeline.seedCurrentConfig` | ❌ **dead** — real seed is direct at `:501` |
| `rebindForClientTools :937` | `_rebindForSyncedState → pipeline.rebindForRestart` | ❌ **dead** — no caller |
| `injectSteering :800` | builds `SDKUserMessage`, then `pipeline.injectSteering` | ✅ partial (does build work) |

**7 pure/near-pure forwards, 3 of them dead.** A shallow-intermediary signature.

### 3b. ClaudeAgent → ClaudeAgentSession (near-pure forwards)

| Agent method | Forwards to (via `_findAnySession`/`_findChat`) | Shape |
|---|---|---|
| `getSessionCustomizations :2173` | `sess.getSessionCustomizations()` | pure |
| `startMcpServer :2178` | `sess.startMcpServer(id)` | pure |
| `stopMcpServer :2183` | `sess.stopMcpServer(id)` | pure |
| `setCustomizationEnabled :2152` | `defaultChat.setClientCustomizationEnabled` | loop |
| `respondToPermissionRequest :1900` | `sess.respondToPermissionRequest` | search-loop |
| `respondToUserInputRequest :1911` | `sess.respondToUserInputRequest` | search-loop |
| `onClientToolCallComplete :2099` | `defaultChat.completeClientToolCall` | URI-walk + forward |
| `_abortSession :1932` | `sess.abort()` / `abortController.abort()` | branch |
| `setPendingMessages :1952` | `target.injectSteering` | branch |
| `onSessionConfigChanged :1993` | `chat.setPermissionMode` | loop |
| `_changeModel :2010` | `sess.setModel` (+ overlay/backing fallback) | partial |
| `_changeAgent :2038` | `sess.setAgent` (+ overlay fallback) | partial |

**~10 near-pure forwards + 2 partial.** Combined with §3a, roughly **17
pass-through methods across the two intermediary layers** — strong evidence that
the session/pipeline seam sits *too high* and re-exports rather than adds.

### 3c. Dead surface (deletion candidates)

`pipeline.reloadPlugins :95`, `pipeline.setClientToolOwner :312`,
`session.attachRematerializer :668`, `session.seedBijectiveState :664`,
`session.rebindForClientTools :937` — 5 public methods with **no production
caller**. Each inflates an interface without paying rent.

---

## 4. Deletion-test conclusions for the session / pipeline / queue split

### Fold the **pipeline** into the session?

**Verdict: keep the pipeline — but move the seam.** The pipeline hides a real deep
core: the rebind/recover state machine (`_rebindQuery :550`), the consumer-loop
handoff across a query swap (`_runConsumerLoop :508-518`), config replay
(`_replayCurrentConfig :526`), and the M10 `_processMessages` loop. Folding this
into the already-15-responsibility session would **not** vanish complexity — it
would drown the one genuinely clean seam in the design (`onDidProduceSignal`, the
SDK-messaging-shaped ↔ protocol-shaped boundary). **However**, the 7 pass-through
forwards in §3a and the config-cache smear in §2b prove the boundary is drawn
wrong: the session re-exports the pipeline verbatim (`isResumed`,
`setPermissionMode`, `hasActiveTurn`, `shutdownLiveQuery`) and **co-owns** the
bijective cache. The fix is not to merge but to **relocate the config cache
wholly into the pipeline** and delete the session's forwarding wrappers, letting
the agent talk to `pipeline` for lifecycle/config and to `session` only for
protocol concerns.

### Fold the **queue** into the pipeline?

**Verdict: the weakest of the four splits — borderline.** The queue is 171 LOC,
and §2d shows its headline responsibility (turn settlement) is *already* split
with the pipeline: `settleHead` and `_processMessages` both key off `isEmpty`, and
the M10 batch rule must agree across the two files. The queue's four ordering
constraints (`push` wakes `next`; `settleHead` per `result`; `notifyAborted` after
abort; `resetForRebind` on rebind) are all **driven by the pipeline** — the queue
cannot enforce them itself, so the "knows nothing about the Query lifecycle" claim
(`:31`) is only half true. Folding it in would **remove a leaky seam** and let the
turn-lifecycle decision (deferred batching *and* `ChatTurnComplete` emission) live
in one place. The only thing keeping the split alive is unit-testability (there is
a dedicated queue test) — a legitimate but weak reason given the async-iterator +
batch logic is meaningless without the pipeline driving it. **Recommendation: if
the split stays, move the *entire* M10 turn-done decision onto the queue (have
`settleHead` return a "turn complete" verdict the pipeline merely relays); if it
goes, fold it into the pipeline and keep the test at the pipeline level.**

### Is the 4-way split earning its keep?

- **Queue** — deep-ish but leaky; borderline keep (§4).
- **Pipeline** — deep core, earns its keep, but its surface is bloated by the
  config/customization clusters and two dead methods.
- **Session** — does *not* earn a single "coordinator" identity; it is 2-3 modules
  merged (protocol coordinator + customization service + credits/enrichment).
- **Agent** — is 2 modules (IAgent provider + peer-chat manager).

Net: the split should be **~5 focused modules, not 4 blurred ones** (§5).

---

## 5. Candidate re-divisions (deepening opportunities)

1. **Extract `ClaudeChatManager` out of `ClaudeAgent`.** Move `_chatBackings`,
   the `chats` object, `_createChat/_forkChat/_disposeChat/_materializeChatLocked/
   _buildProvisionalChat/_resolveParentSession/_resolveChatSdkId/_resolveChatBacking/
   _ensureSessionEntry/_updateChatBackingModel/materializeChat` and
   `onDidChangeChatData` into a peer-chat module. **Seam moves:** the agent keeps
   the `IAgent` surface and delegates every chat-addressed op to one collaborator,
   shrinking a 2247-line file and giving the peer-chat lifecycle a testable home.

2. **Sink the bijective config cache entirely into the pipeline.** Delete
   `session.seedBijectiveState` (dead) and stop the session from deriving/pushing
   effort separately. Give the pipeline a single `applyConfig({ model, effort,
   permissionMode })` and let it own the model→effort derivation. **Seam moves:**
   the §2b smear collapses to one owner; `setModel :750`'s split (`setModel` +
   `setEffort` + overlay-write) becomes one call + one persistence hop.

3. **Make one permission-mode resolver own the fallback chain.** Promote the
   8-site fallback tails (§2a) into a single domain helper on the metadata/config
   layer — e.g. `resolveSessionPermissionMode(uri, { create?, overlay?, parent? })`
   returning the resolved mode — so create/fork/resume/peer/materialize/send all
   call one function instead of hand-rolling `?? overlay ?? 'default'`.
   **Seam moves:** per the user's own service-responsibility rule, domain logic
   (fallback precedence) leaves 4 consumers and lands in one domain service.

4. **Give the turn-lifecycle a single owner (M10).** Have `queue.settleHead`
   return a discriminated result (`{ settled, turnComplete, completedEntry }`) so
   the pipeline's `_processMessages` merely *relays* the `ChatTurnComplete` the
   queue decided. **Seam moves:** the `isEmpty` predicate stops being evaluated on
   both sides of the seam; the queue becomes the sole authority on "turn done,"
   deepening it from a passive buffer into a real turn-batcher.

5. **Split `ClaudeAgentSession`'s customization/credits satellites off.** Extract
   (a) a `ClaudeSessionCustomizations` collaborator owning `getSessionCustomizations`
   (the 5-scanner fan-out `:1007`), `_lastCustomizations`, `_resolveMcpServerName`,
   and the MCP start/stop resolve+rebind dance; and (b) a `ClaudeTurnCredits`
   collaborator owning `_currentTurnNanoAiu/recordTurnCredits/_enrichSignalWithCredits/
   _enrichSignalWithMcpContributor`. **Seam moves:** the session drops from ~15
   responsibilities to a lean coordinator (identity + materialize + registries +
   pipeline), and each satellite becomes independently testable per the user's
   "extract complex logic into a public collaborator" rule.
