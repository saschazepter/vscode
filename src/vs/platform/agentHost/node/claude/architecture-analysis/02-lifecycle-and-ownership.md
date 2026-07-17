# 02 — Lifecycle & Ownership Audit (Claude Agent Host runtime)

Scope: `claudeAgent.ts`, `claudeAgentSession.ts`, `claudeSdkPipeline.ts`, `claudePromptQueue.ts`, plus the ownership seams into `claudeSdkMessageRouter.ts`, `claudeFileEditObserver.ts`, `sessionDataService.ts`, `pendingRequestRegistry.ts`, and `agentPeerChats.ts`.

Domain vocabulary per `CONTEXT.md` "Language" + "M9": **Provisional session** (created, no SDK contact) → **Materialization** (`ClaudeAgentSession.materialize`, builds the **Pipeline** + binds the **WarmQuery**) → live turns → **Rematerializer**-driven rebind → dispose/shutdown. Materialization is a one-way edge; there is no de-materialize.

Base-lifecycle facts used throughout (verified in `base/common/lifecycle.ts`):
- `Disposable.dispose()` → `_store.dispose()`; `DisposableStore.dispose()` early-returns if already disposed (`lifecycle.ts:433`). **All `Disposable` subclasses here are idempotent on double-`dispose()`.**
- `DisposableMap.deleteAndDispose(key)` disposes then deletes; a missing key is a no-op (`lifecycle.ts:821`). **Idempotent per key.**
- `WarmQuery[Symbol.asyncDispose]()` calls the query's memoized `close()`; `Query.return()` awaits the same memoized cleanup (per `shutdownAndWait` JSDoc, pipeline `:277-296`). **Double async-dispose of a WarmQuery is safe by SDK memoization** — a load-bearing assumption several hazards below lean on.

---

## 1. Object lifecycle table

| Object | Created (file:line) | Owner | Registered for disposal? | Disposed (file:line) | Idempotent? |
|---|---|---|---|---|---|
| `ClaudeAgent` | DI singleton (agent host container) | Agent host process | n/a (root) | `dispose()` `claudeAgent.ts:2190-2228` | Yes (`Disposable`) |
| `_metadataStore` (`ClaudeSessionMetadataStore`) | `claudeAgent.ts:448` (`createInstance`) | `ClaudeAgent` | **No** — not `_register`ed | never | n/a — class is **not** a `Disposable` (`claudeSessionMetadataStore.ts:63`), so benign |
| `_sessions` (`DisposableMap<string, ClaudeSessionEntry>`) | `claudeAgent.ts:264` | `ClaudeAgent` | `_register` | agent `dispose()` via `super.dispose()` | Yes |
| `ClaudeSessionEntry` (container + leaves) | container `claudeAgent.ts:410`; leaf `_wireEntry` `:395` | `_sessions` map (container); container `_chats` map (leaves) | `DisposableMap.set` / `AgentSessionEntry` ctor `_register(session)` `agentPeerChats.ts:87` | `_teardownEntry`→`deleteAndDispose` `claudeAgent.ts:1201`; `_removeAllTurns` `:827`; agent `dispose` | Yes (per-key) |
| `ClaudeAgentSession` | `createProvisional`→`createInstance` `claudeAgentSession.ts:167`; call sites `claudeAgent.ts:709,1076,1407,1482` | its leaf `ClaudeSessionEntry` (`_register(session)`) | Yes (leaf `_store`) | when leaf disposed (teardown / entry dispose) | Yes; `dispose()` override `claudeAgentSession.ts:1084` denies pending registries then `super.dispose()` |
| `ClaudeSdkPipeline` | `claudeAgentSession.ts:475` (`createInstance`, inside `materialize`) | **the session** (`this._register(...)`) | Yes — `_register` on session `_store` | when session disposed; also torn-down-but-not-disposed by `shutdownAndWait` `claudeSdkPipeline.ts:288` | Yes (`Disposable`); once per session (materialize throws if `_pipeline` set, `:424`) |
| `ClaudePromptQueue` | `claudeSdkPipeline.ts:242` (`createInstance`) | the pipeline (`_register`) | Yes | pipeline dispose | Yes; survives rebinds (`resetForRebind` `:590/168`) |
| `ClaudeSdkMessageRouter` | `claudeSdkPipeline.ts:252` (`createInstance`) | the pipeline (`_register`) | Yes | pipeline dispose | Yes |
| `WarmQuery` (`_warm`) | `claudeAgentSession.ts:465` (initial `startup`); rebuild `:560` | the pipeline (`_warm` field) | **Not via store** — torn down by hand-rolled `toDisposable` chain `claudeSdkPipeline.ts:259-262` + rebind `:585` + `shutdownAndWait` `:291` | dispose chain / rebind / `shutdownAndWait` | async-dispose is memoized ⇒ safe under double-call |
| `dbRef` (`IReference<ISessionDatabase>`, pipeline's) | `claudeAgentSession.ts:472` (`openDatabase`) | transitively **`ClaudeFileEditObserver`** (`_register(dbRef)` `claudeFileEditObserver.ts:71`) via session→pipeline→router→observer | Yes (observer `_store`); manual `dbRef.dispose()` on pipeline-ctor throw `claudeAgentSession.ts:487` | observer dispose (⇐ pipeline dispose) | Yes (ref-counted; last dispose closes) |
| `dbRef` (`_withDatabase`'s short-lived ref) | `claudeAgentSession.ts:402` | `_withDatabase` local | manual `finally` | `claudeAgentSession.ts:406` | Yes (ref-count) |
| `AbortController` (session's) | `createProvisional` `claudeAgentSession.ts:177` | session (`readonly abortController`) | n/a (not disposable) | aborted, never "disposed" | abort idempotent |
| `AbortController` (pipeline placeholder) | `claudeSdkPipeline.ts:559` | pipeline (`_abortController`) | n/a | swapped away `:588` | n/a |
| `AbortController` (rebuild) | `claudeAgentSession.ts:539` (rematerializer closure) | pipeline after rebind (`_abortController`) `:588` | n/a | aborted on dispose chain | n/a |
| `AbortController` (native model probe) | `buildModelEnumerationOptions()` | `_fetchNativeModels` local | manual | `abort()` `claudeAgent.ts:645` | n/a |
| `SubagentRegistry` | `claudeAgentSession.ts:194` (`_register(new …)`) | **the session** | Yes | session dispose | Yes; referenced (not owned) by pipeline/router `:483/253` — correctly outlives rebinds |
| `PendingRequestRegistry` — `_pendingClientToolCalls` | `new` at each `createProvisional` call site (`claudeAgent.ts:718,1085,1416,1491`) | session (ctor param) | **No** — plain object, not disposable | drained via `rejectAll` in session `dispose()` `:1089` | drain idempotent |
| `PendingRequestRegistry` — `_pendingPermissions` | `claudeAgentSession.ts:200` | session | No (not disposable) | `denyAll(false)` in `dispose()` `:1087` | idempotent |
| `PendingRequestRegistry` — `_pendingUserInputs` | `claudeAgentSession.ts:206` | session | No | `denyAll` in `dispose()` `:1088` | idempotent |
| `SessionClientToolsDiff` | `createProvisional` `claudeAgentSession.ts:179` | session; `this.toolDiff = this._register(toolDiff)` `:346` | Yes | session dispose | Yes |
| `SessionClientCustomizationsDiff` | `claudeAgentSession.ts:233` (`_register(new …)`) | session | Yes | session dispose | Yes |
| `ClaudeCustomizationWatcher` | `_watchCustomizations` `claudeAgentSession.ts:354` | session `_customizationWatcher` `DisposableStore` `:146` | Yes; `clear()`ed + re-added on re-watch `:353` | ctor watch, or `materialize` re-watch `:432`; session dispose | Yes — old watcher disposed by `clear()` |
| `ClaudeActiveClientHandle` | `getOrCreateActiveClient` `claudeAgent.ts:2061` | `_activeClientHandles` `Map` | No (not disposable) | `_pruneActiveClientHandles` `:2090` | delete idempotent |

---

## 2. State machine: provisional → materialized → rebinding → disposed

```
                         createProvisional (claudeAgentSession.ts:153)
                         AbortController#0 created (:177)  ── session.abortController (readonly, forever)
                                   │
                                   ▼
                        ┌─────────────────────┐
                        │     PROVISIONAL     │  _pipeline === undefined ; isPipelineReady=false
                        │  (no SDK, no dbRef) │  teardown here = abortController#0.abort() + drop
                        └─────────────────────┘
                                   │  first send()  →  materialize(ctx)   (claudeAgentSession.ts:423)
                                   │  guard: throws if _pipeline set (:424)  ⇒ ONCE per session
                                   ▼
                startup() ⇒ WarmQuery#0 (:465)   [await]
                gate: abortController#0.aborted? → asyncDispose warm, throw (:467)
                openDatabase ⇒ dbRef (:472)
                new ClaudeSdkPipeline(warm#0, abortController#0, dbRef)  _register on SESSION (:475)
                    └─ pipeline._abortController === session.abortController  (ALIASED here)
                _pipeline = pipeline (:492)   ← isPipelineReady flips true (synchronous, no await 467→492)
                metadata write [await] (:513) ; pre-commit gate (:530)
                attachRematerializer(closure) (:534)
                                   │
                                   ▼
                        ┌─────────────────────┐
                        │    MATERIALIZED     │  _pipeline set ; WarmQuery#0 live ; _query bound lazily
                        └─────────────────────┘
                          │                 ▲
             send(): diffs dirty /          │  happy rebind completes:
             _needsRebind /                 │  _bindWarmQuery + _replayCurrentConfig (:599-600)
             _pendingResumeSessionAt        │
                          ▼                 │
                ┌───────────────────────────────────────┐
                │            REBINDING (_rebindQuery :550)│
                │  oldWarm = _warm                        │
                │  _abortController = placeholder#p (:560)│  ← now DIVERGES from session.abortController#0
                │  built = await rematerializer()         │     (builds WarmQuery#1 + AbortController#1 :539/560)
                │  ─ gate A: _store.isDisposed → kill built, throw (:566)
                │  ─ gate B: placeholder#p.aborted → kill built + oldWarm, failAll, throw (:575)
                │  happy: asyncDispose oldWarm (:585); _warm=WarmQuery#1; _abortController=#1 (:587-588)
                └───────────────────────────────────────┘
                                   │
                                   ▼   dispose (session `_store`) OR shutdownAndWait (:288)
                        ┌─────────────────────┐
                        │      DISPOSED       │  dispose chain: abort(current _abortController) + asyncDispose(current _warm)
                        └─────────────────────┘
```

**AbortController swap / divergence (item 2).** At materialize the pipeline is handed `session.abortController` (#0) — they are the *same object* (`claudeAgentSession.ts:481`). On the **first** `_rebindQuery`, the pipeline sets `_abortController = placeholder` (`claudeSdkPipeline.ts:560`) and then `_abortController = built.abortController` (#1, `:588`). From that point `session.abortController` (#0, still what the readonly field holds) and `pipeline._abortController` (#1) **permanently diverge**. `session.abortController` is never re-synced.

Every post-materialize reader of `session.abortController` is **gated behind `!isPipelineReady`**, so it only fires while provisional (when #0 is still the live Options controller):
- `_teardownEntry` `claudeAgent.ts:1186` (default) and `:1194` (peer) — guarded.
- `disposeSession`/`releaseSession` → `_teardownEntry` — guarded.
- `shutdown` `claudeAgent.ts:1825-1827` — guarded.
- `_abortSession` `claudeAgent.ts:1945-1948` — guarded.
- `dispose` `claudeAgent.ts:2218-2220` — guarded.
- Materialize's own gates (`:467,:530`) read #0 **before** any rebind — correct.

Verdict: the stale `session.abortController` is **benign today** because materialized teardown always routes through the pipeline (`pipeline.abort()` / pipeline dispose chain, which read the *current* `_abortController`). But it is a **fragile invariant** (smell H4): the readonly field silently becomes a decoy after the first rebind, and any new `session.abortController.abort()` added without the `isPipelineReady` guard would abort a detached controller and fail to kill the live subprocess.

---

## 3. Hazards, ranked

### H1 — [smell] WarmQuery teardown correctness depends on SDK `close()` memoization (double async-dispose)
`shutdownAndWait` (`claudeSdkPipeline.ts:288-296`) aborts + `await _warm[asyncDispose]()` + `await _query.return()` but **does not dispose the pipeline `Disposable`**. The next thing `_removeAllTurns` does is `_sessions.deleteAndDispose(sessionId)` (`claudeAgent.ts:827`), which disposes the session → pipeline → the dispose-chain `toDisposable(() => _warm[asyncDispose]())` (`:260`) runs **a second time** on the same WarmQuery. Answer to the maintainer's item 4(a): **the pipeline `Disposable` is disposed exactly once** (via `deleteAndDispose`), *not* twice — but the WarmQuery's `asyncDispose` executes twice (manual + dispose-chain), plus `Query.return()`. This is safe **only** because the SDK memoizes `close()`. It is a real statefulness/ownership smell: two teardown verbs (`shutdownAndWait` vs `dispose`) both fire subprocess teardown, and the dispose-chain copy is fire-and-forget (unawaited) — correctness of the "id is free to reuse" invariant is preserved by `shutdownLiveQuery` awaiting the real exit *before* `deleteAndDispose`, not by the dispose chain.

### H2 — [smell] `_rebindQuery` gate-B double-disposes `oldWarm`
On abort-during-rebind (`claudeSdkPipeline.ts:575-584`): `built.warm` is killed, `oldWarm` is async-disposed (`:579`), `failAll`, `_needsRebind=true`, throw — **but `this._warm` is never reassigned**, so it still points at `oldWarm`. A later pipeline dispose runs the dispose chain and async-disposes `oldWarm` **again**. Memoized ⇒ safe, but the JSDoc only documents the happy-path single dispose; the gate-B double is undocumented. Gate-A (`_store.isDisposed`, `:566`) leaves `oldWarm` to the dispose chain (already torn down by it) and kills only `built` — correct and leak-free.

### H3 — [confirmed-safe, but fragile] materialize/teardown interleave rests on a no-await window
Teardown runs on `_disposeSequencer`; materialize/send on `_sessionSequencer` — **different key spaces**, so they interleave at `await` points. The two interleave points in `materialize` are the `startup()` await (`:465`) and the metadata-write await (`:513`):
- Interleave at `startup` await: teardown sees `!isPipelineReady`, aborts #0 (`:1186`); materialize resumes, gate `:467` throws. Safe.
- Interleave at metadata-write await: `_pipeline` is **already set** (`:492`), so `isPipelineReady===true`, teardown does **not** abort and instead `deleteAndDispose`s (`:1201`) → disposes pipeline → aborts #0 (still aliased) + async-disposes warm; materialize resumes, pre-commit gate `:530` sees aborted → throws; caller `deleteAndDispose`s again (idempotent). Safe.

Safety is **entirely dependent** on there being *no `await`* between gate `:467` and `_pipeline = pipeline` (`:492`) — `openDatabase` (`:472`) and `createInstance` (`:475`) are synchronous. If a future edit inserts an `await` in that span, or moves the metadata write ahead of `_pipeline=`, a WarmQuery/dbRef leak window opens (session disposed while materialize still holds an unregistered warm). Flag as a maintenance landmine, not a live bug.

### H4 — [smell] `session.abortController` becomes a decoy after first rebind
See §2. Divergence is real; all current readers are guarded; the field is a trap for future callers. Recommend not exposing it publicly (see simplification S2).

### H5 — [smell] `_lastCustomizations` is a stale cache driving signal enrichment
`_lastCustomizations` (`claudeAgentSession.ts:992`) is written **only** as a side effect of `getSessionCustomizations()` (`:1047`) and read by `_enrichSignalWithMcpContributor` (`:310`) and `_resolveMcpServerName` (`:1079`). Between customization changes and the next workbench refetch, MCP tool-call signals are stamped from a **stale snapshot** (a tool-call `contributor` may be missing or wrong). Not a lifetime bug, but an accidental cache that couples signal enrichment to an unrelated method being called. 

### H6 — [confirmed-safe] `releaseSession` vs `disposeSession` in-memory teardown is identical
Both funnel through `_teardownEntry` (`claudeAgent.ts:1130` vs `:1168`) then `_pruneActiveClientHandles`. `releaseSession` adds guards (skip provisional `:1157`, skip active-turn `:1164`); the destructive delta (durable SDK session + DB deletion) lives in the orchestrator, not here. In-memory teardown is byte-identical and safe for both. Confirmed, no hazard.

### H7 — [confirmed-safe] Two dbRef lifecycles are intended
Long-lived pipeline dbRef (`:472`, owned by `ClaudeFileEditObserver` `:71`, lives for the materialized session) vs short-lived `_withDatabase` ref (`:402`, per-op, disposed in `finally` `:406`). Both hit `openDatabase(this._storageUri)`, which is ref-counted (`sessionDataService.ts:364`). The `_withDatabase` ref exists so `truncateToTurn`/`pruneAllTurns` work on a **provisional** session (no pipeline dbRef) — e.g. `_removeAllTurns` prunes a freshly-recreated provisional (`claudeAgent.ts:842`). Intended and safe; the JSDoc (`:396-400`) documents the rationale. One Locality smell: the pipeline takes an `IReference` ctor param it never registers itself, delegating disposal two layers down to the observer — non-obvious ownership.

### H8 — [smell] `_pipeline` is dual bookkeeping with the disposable store
Materialization state lives in **two** places: the `_pipeline` field (`:102`, the `isPipelineReady` latch and `_requirePipeline` throw-source) *and* the session `_store` (which owns the pipeline via `_register`). They can never be de-materialized, so `_pipeline` is monotone — but the field + `~15` `_requirePipeline()` guards are a stateful tax that a type split would erase (S5).

---

## 4. Mutable-field statefulness inventory

### `ClaudeAgentSession`
| Field | Writers | Readers | Verdict |
|---|---|---|---|
| `_pipeline` | `materialize` `:492` | `isPipelineReady`, `_requirePipeline`, ~15 sites | Essential latch, but dual with `_store` (H8) |
| `_workingDirectory` | ctor default; `materialize` `:431` | `workingDirectory` getter | Essential |
| `_provisionalModel` | ctor `:342`; `setModel` `:751` | `materialize` `:447`, rematerializer `:545`, `seedCurrentConfig` `:502`, getter | Essential — dual pre/post-materialize (read by rebind) |
| `_provisionalAgent` | ctor `:343`; `setAgent` `:784` | `materialize` `:441`, rematerializer `:538` | Essential across rebind |
| `provisionalConfig` | ctor (readonly) | `materialize` permission read | Essential, immutable |
| `_pendingResumeSessionAt` | `truncateToTurn` `:388`; cleared `:496`/`:565` | `materialize` `:453`, rematerializer `:550`, `send` `:697` | Essential one-shot anchor |
| `_currentTurnNanoAiu` | `recordTurnCredits` `:264`; reset `send` `:696` | `_enrichSignalWithCredits` `:275` | Essential accumulator |
| `_transportKind` | `materialize` `:437` | `_enrichSignalWithCredits` `:275` | Cache of `ctx.transport.kind` — minor |
| `_lastCustomizations` | `getSessionCustomizations` `:1047` | `_enrichSignalWithMcpContributor` `:310`, `_resolveMcpServerName` `:1079` | **Accidental stale cache (H5)** |
| `abortController` (readonly) | ctor | teardown paths (guarded) | **Decoy after rebind (H4)** |

### `ClaudeSdkPipeline`
| Field | Writers | Readers | Verdict |
|---|---|---|---|
| `_query` | `_bindWarmQuery` `:166` | loop, setters, `_ensureQueryBound`, `shutdownAndWait` | Essential; health via `_needsRebind`, never nulled except by never |
| `_warm` | ctor `:239`; rebind `:587` | dispose chain, `shutdownAndWait`, `_bindWarmQuery` | Essential |
| `_abortController` | ctor `:240`; rebind `:560`/`:588` | `isAborted`, loop gate, queue signal, dispose chain | Essential — the swap (H4) |
| `_isResumed` | `_processMessages` init `:632` | `isResumed` getter | Monotone latch |
| `_initPlugins` | `_processMessages` init `:630` | `snapshotResolvedCustomizations` `:116` | Cache of last `system:init` |
| `_appliedModel` / `_appliedEffort` / `_appliedPermissionMode` | `seedCurrentConfig` `:331-333`; setters `:347/371/476`; `_replayCurrentConfig` `:530/534/538`; reset on rebind `:596-598` | dedupe guards in setters + replay | **Prime smell: "applied" half of a double-cache** |
| `_currentModel` / `_currentEffort` / `_currentPermissionMode` | `seedCurrentConfig` `:328-330`; setters `:343/367/473` | `_replayCurrentConfig` | "current/desired" half of the double-cache |
| `_rematerializer` | `attachRematerializer` `:318` | `_rebindQuery` `:551` | Essential hook |
| `_needsRebind` | `abort` `:464`; `_processMessages` `:682`; rebind `:582/591` | `send`, `_ensureQueryBound`, setters | Essential health bit |
| `_consumerLoopRunning` | `_ensureConsumerLoop` `:490`; `_runConsumerLoop` `:516` | `_ensureConsumerLoop` | Essential re-entrancy guard |

**The `applied*` × `current*` six-field bijective cache is the standout statefulness smell.** It duplicates the SDK's own model/effort/permission state so the pipeline can dedupe redundant control calls; it is seeded (`:327`), mutated by four code paths, and reset-then-replayed on every rebind (`:596-600`). Every rebind has to keep the two halves consistent by hand.

### `ClaudePromptQueue`
| Field | Writers | Readers | Verdict |
|---|---|---|---|
| `_toYield` | `push` `:103`; iterable `shift` `:70`; `failAll` `:157` | `isEmpty`, `peekParent`, iterable | Essential queue |
| `_yielded` | iterable `push` `:71`; `settleHead` `shift` `:127`; `failAll` | `isEmpty`, `peekParent`, `settleHead` | Essential in-flight list |
| `_popped` | `settleHead` `:140`; cleared `:138`/`:159` | `settleHead` batch-complete | Essential (M10 steering-preempt deferral) |
| `_pendingPromptDeferred` | iterable `:79`; `push` `:104`; `notifyAborted` `:164`; `resetForRebind` `:169` | iterable `await` `:78` | Essential wakeup latch |

---

## 5. Candidate simplifications (reduce statefulness / lifetime confusion)

1. **Collapse the `applied*`/`current*` double-cache.** Replace the six pipeline fields with one "desired config" struct and let the SDK setters be called unconditionally (the SDK already no-ops unchanged values), or track a single `dirty` bit per key. Kills the hand-maintained two-halves-consistent invariant and the reset-then-replay dance on every rebind (`claudeSdkPipeline.ts:194-201,327-334,526-543,596-600`).

2. **Stop exposing `session.abortController` publicly.** It is only legitimately used to unblock a *provisional* `startup()` await. Replace the readonly field with an `abortProvisional()` method that is a no-op once `isPipelineReady`, and route all materialized aborts through `pipeline.abort()` / dispose. Removes the post-rebind decoy (H4) and the five scattered `!isPipelineReady` guard sites.

3. **Unify subprocess teardown into one awaitable verb.** Fold `shutdownAndWait` into `pipeline.dispose()` (make dispose return the exit promise, or have `shutdownLiveQuery` call `deleteAndDispose` and await the same completion) so there is exactly one place that aborts + async-disposes the WarmQuery + awaits exit — instead of `shutdownAndWait` (manual) *plus* the dispose chain (fire-and-forget) both firing teardown and relying on `close()` memoization for correctness (H1/H2).

4. **Derive MCP-contributor enrichment instead of caching `_lastCustomizations`.** Have `_enrichSignalWithMcpContributor` consult the owned customization model (or a small server-name→id index kept in lockstep with customization changes) rather than a snapshot that only refreshes when `getSessionCustomizations` happens to be called (H5).

5. **Split `Provisional` and `Materialized` sessions into two types (Depth/Seam move).** Today one `ClaudeAgentSession` spans both states with a nullable `_pipeline` and ~15 `_requirePipeline()` throws. Modeling materialize as `Provisional.materialize(): Materialized` makes the one-way edge a type-level fact, removes the `_pipeline`-vs-`_store` dual bookkeeping (H8), and makes the "is this field meaningful yet?" question disappear for `provisionalModel/agent/config` and `abortController`.

---

### Summary (data for orchestrator)

Ownership chain is `ClaudeAgent._sessions(DisposableMap)` → `ClaudeSessionEntry`(leaf `_register(session)` `agentPeerChats.ts:87`) → `ClaudeAgentSession` → (`materialize` `claudeAgentSession.ts:475`) `_register` `ClaudeSdkPipeline` → `_register` `ClaudeSdkMessageRouter` `claudeSdkPipeline.ts:252` → `_register` `ClaudeFileEditObserver` → `_register(dbRef)` `claudeFileEditObserver.ts:71`. So the pipeline `dbRef` (opened `claudeAgentSession.ts:472`) is disposed transitively; `WarmQuery` is torn down by a hand-rolled `toDisposable` chain `claudeSdkPipeline.ts:259-262` (NOT the store). Pipeline is `_register`ed on the **session** and materialize throws if `_pipeline` already set (`:424`) ⇒ once-per-session, no re-materialize leak. **AbortController divergence is real**: session #0 (`:177`) is aliased into the pipeline at materialize (`:481`) then the pipeline swaps to a placeholder (`claudeSdkPipeline.ts:560`) and rebuild #1 (`:588`) on first `_rebindQuery`; `session.abortController` never re-syncs but every post-materialize reader is `!isPipelineReady`-guarded (`claudeAgent.ts:1186,1194,1825,1945,2218`) ⇒ benign-but-fragile (H4). WarmQuery double-async-dispose on the `shutdownAndWait`+`deleteAndDispose` path (`claudeAgent.ts:826-827`) and on rebind gate-B (`claudeSdkPipeline.ts:579`) is safe only via SDK `close()` memoization (H1/H2) — pipeline `Disposable` itself disposes exactly **once**, not twice. New warm can't leak on dispose-during-rebind: gate-A (`:566`) kills `built` if `_store.isDisposed`; the `_warm=built.warm` assignment (`:587`) is synchronous with no interleaving await after the gates. `releaseSession`/`disposeSession` share identical in-memory `_teardownEntry` (H6, safe); durable delete is orchestrator-side. Two dbRef lifecycles (long pipeline ref + short `_withDatabase` ref `:402`) are intended and ref-count-safe (H7). Prime statefulness smells: the pipeline `applied*`×`current*` six-field bijective config cache (`claudeSdkPipeline.ts:194-201`), the stale `_lastCustomizations` enrichment cache (`claudeAgentSession.ts:992`), and `_pipeline` dual-bookkeeping with the store (H8). `_metadataStore` (`claudeAgent.ts:448`) is not registered but is not a `Disposable`, so benign. Full report: `architecture-analysis/02-lifecycle-and-ownership.md`.
