# 00 — Synthesis: where we are, and where we can go

_Cross-cutting synthesis of reports 01–05. Domain vocabulary from `../CONTEXT.md`;
architecture vocabulary (Module / Interface / Depth / Seam / Leverage / Locality;
deletion test) from the `improve-codebase-architecture` skill._

---

## The one-paragraph diagnosis

The four modules are **correctly wired but blurrily divided**. Nothing points
"up" the ownership chain by a hard reference — every upward flow is an `Event` or
a `this`-capturing closure — so there are no true reference cycles. But two of
those closures are **hidden back-references** that could be plain data, one seam
(the rematerializer) carries **~50% duplicated Options-building logic** and forces
a **two-phase init**, the same **permission-mode fallback is copy-pasted across 4
files / 8 sites**, a **six-field bijective config cache** is split across the
session and pipeline, and the **session is a god-object** (≥15 responsibilities,
zero isolated tests) while the **agent hides a second module** (the peer-chat
manager). The lifecycle is *correct* — no leak, no double-dispose bug — but
**illegible**: the abort controller silently forks after the first rebind, and
subprocess teardown is spread across three verbs (`shutdownAndWait`, dispose
chain, manual `asyncDispose`) whose safety depends on undocumented SDK `close()`
memoization.

**Two corrections to the stated hypothesis, stated plainly:**

1. **"We're probably disposing when we shouldn't, or not disposing when we
   should."** The audit found no such bug. The pipeline is `_register`ed on the
   session and `materialize` throws if already set (`claudeAgentSession.ts:424`),
   so it is created and disposed **exactly once**. The problem is **legibility of
   lifetime, not correctness of lifetime** — plus genuine over-*statefulness*
   (the double config cache, cached enrichment snapshots, applied-vs-current).
2. **"The rematerializer is a smell — delete it."** The rematerializer *seam* is
   the one correct thing here: it's the only Pipeline→Session channel and it
   deliberately breaks the ownership cycle (the pipeline owns the `Query`
   lifetime; only the session can build `Options`). What's rotten is **what
   crosses the seam** — a fat closure that rebuilds `Options` from scratch,
   duplicating the `materialize` body — and **when it's attached** (after
   construction, two-phase). Keep the seam; change its currency.

---

## Visual 1 — Current coupling map

Solid arrows = hard reference / direct call (down the ownership chain).
Dotted arrows = upward flow via closure or event (the "calls in circles" feeling).

```
                         ┌──────────────────────────────────────────────┐
                         │                 ClaudeAgent                   │
                         │  IAgent provider  +  [hidden] peer-chat mgr   │
                         │  _sessions: DisposableMap<id, SessionEntry>   │
                         └───────┬───────────────────────────▲──────────┘
              constructs / calls │                           ┊ Event: onDidSessionProgress
                                 ▼                           ┊ (+ closures: canUseTool, onElicitation)
                         ┌──────────────────────────────────┴──────────┐
                         │             ClaudeAgentSession               │
                         │  god-object: materialize, rematerializer,    │
                         │  2 diffs, 2 pending registries, credits,      │
                         │  customization scan fan-out, overlay writes   │
                         └───┬───────────────────────────────▲──────────┘
       constructs (materialize)│  attaches rematerializer      ┊ Event: onDidProduceSignal
       _register(pipeline)     │  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─▶ ┊
                                ▼   (fat closure re-enters      ┊
                         ┌───────────session for Options)──────┴──────────┐
                         │              ClaudeSdkPipeline                 │
                         │  deep core (rebind/replay/consumer loop)       │
                         │  + bloated surface (18 methods, 8-arg ctor)    │
                         │  owns _query, _warm, _abortController (SWAPS)  │
                         └───┬───────────────────────────────▲──────────┘
       constructs (queue)    │   _getAbortSignal closure       ┊ _onSteeringYielded closure
       _register(queue)      │  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─▶ ┊ ◀─ ─ ─ (both avoidable)
                                ▼                              ┊
                         ┌──────────────────────────────────┴──────────┐
                         │             ClaudePromptQueue                │
                         │  DEEP + cleanly seamed (the reference shape) │
                         └──────────────────────────────────────────────┘
```

The **dotted upward edges are exactly the closures**. Three are legitimate
dependency-inversion seams (`canUseTool`/`onElicitation` — the SDK carries only
an sdkSessionId and needs the agent's cross-session registry; the rematerializer
— breaks the cycle). Two are **avoidable back-references**: `_getAbortSignal`
and `_onSteeringYielded` (see Candidate 4).

---

## Visual 2 — Lifecycle state machine (the illegible part)

```
  createProvisional()                       materialize(ctx)                     dispose / deleteAndDispose
  ─────────────────►  ● PROVISIONAL  ──────────────────────►  ● MATERIALIZED  ──────────────────────────►  ✕ DISPOSED
                      │  _pipeline = ∅       (throws if           │  _pipeline set               (once; DisposableMap)
                      │  abortController #0   already set →        │  pipeline owns _abortController = #0
                      │  (session-owned)      once-per-session)    │
                      │                                            │
                      │  abort path:                               │   _rebindQuery('restart'|'recover')
                      │  abortController#0.abort()                 │   ┌────────────────────────────────┐
                      └───────────────────────────────────────────┘   │  #0 → placeholder → #1 (fresh)  │
                                                                        │  session.abortController STILL #0│  ◀── DIVERGENCE
                                                                        │  (benign: readers isPipelineReady-guarded)
                                                                        └────────────────────────────────┘
  Subprocess (WarmQuery) teardown has THREE entry points, all safe only via SDK close() memoization:
    • shutdownAndWait()  → abort + warm.asyncDispose + query.return   (remove-all path; does NOT dispose the pipeline Disposable)
    • dispose-chain      → toDisposable(() => warm.asyncDispose)      (normal teardown)
    • _rebindQuery       → manual oldWarm.asyncDispose                (swap path)
```

The state itself is fine. What's hard: the **AbortController forks silently at the
first rebind**, and "tear down the subprocess" is spelled three different ways.

---

## Visual 3 — The rematerializer duplication (report 03)

`buildOptions(...)` is called from two places, **both inside `ClaudeAgentSession`**:

```
   materialize()  L443─461                    attachRematerializer(closure)  L540─558
   ┌───────────────────────────┐              ┌───────────────────────────┐
   │ buildOptions({             │              │ buildOptions({             │
   │   sessionId,        ───────┼─ IDENTICAL ──┼─  sessionId,               │
   │   workingDirectory, ───────┼─ IDENTICAL ──┼─  workingDirectory!,       │
   │   model,            ───────┼─ IDENTICAL ──┼─  model,                   │
   │   abortController: this.#0 │  ◀ DIFFERS ▶ │   abortController: fresh#N │
   │   permissionMode,   ───────┼─ same formula┼─  permissionMode: liveMode │
   │   canUseTool,       ───────┼─ IDENTICAL ──┼─  canUseTool,   (ctx)      │
   │   onElicitation,    ───────┼─ IDENTICAL ──┼─  onElicitation,(ctx)      │
   │   isResume: ctx.isResume   │  ◀ DIFFERS ▶ │   isResume: true           │
   │   resumeSessionAt,  ───────┼─ IDENTICAL ──┼─  resumeSessionAt,         │
   │   mcpServers,       ───────┼─ same derive ┼─  mcpServers,  (rebuild*)  │
   │   allowedTools,     ───────┼─ same derive ┼─  allowedTools,(rebuild*)  │
   │   plugins: diff.consume()  ─── IDENTICAL ─┼─  plugins: diff.consume()  │
   │   agent: resolveName(...)  ─── same derive ┼─  agent: resolveName(...)  │
   │ }, ctx.transport, stderr)  │              │ }, ctx.transport, stderr)  │
   └───────────────────────────┘              └───────────────────────────┘
   + _buildStartupToolWiring()  ◀── duplicated ──▶ + _buildStartupToolWiring()
   + _sdkService.startup()      ◀── duplicated ──▶ + _sdkService.startup()
   + _pendingResumeSessionAt=∅  ◀── duplicated ──▶ + _pendingResumeSessionAt=∅

   Only 3 of 13 fields carry a real semantic delta. ~20 of the closure's ~39 lines
   are a copy of the materialize body. model/effort is derived a THIRD time in
   seedCurrentConfig (L501).
```

The closure's type is `() => Promise<{warm, abortController}>` — but by capture it
smuggles **7 session fields + 3 services + 2 diffs + `_buildStartupToolWiring` + 4
ctx values** across the seam. On failure it even mutates session state
(`toolDiff.markDirty()`, `clientCustomizationsDiff.markDirty()`, L568-569). The
pipeline's JSDoc claim "knows nothing about … options building" is type-true and
behaviour-false.

---

## Visual 4 — Responsibility smear matrix

Which files touch each cross-cutting concern (✚ = owns/decides, · = re-derives/forwards):

```
                              Agent   Session   Pipeline   Queue   (+ helpers)
  permission-mode resolve      ·        ·          ·         –     ✚ narrow in claudeSessionConfigKeys
     └ `?? overlay ?? default`  ·(×4)    ·(×2)      –          –    ← 8 sites, copy-pasted
  bijective config (model/                                          
     effort/permissionMode)     –        ·(seed,    ✚(applied    –
                                          setModel)   ×current)
  abort ownership               ·        ✚(#0 born) ✚(owns/swap) ·(observes)  ← 3 owners
  turn-complete / settlement    –        –          ✚(fires)    ✚(settleHead) ← split
  customizations                ✚(sync)  ✚(scan×5)  ·(snapshot) –
  Options building              –        ✚(×2 dup)  (via closure)–
```

Every row with more than one ✚/· column is a candidate for consolidation into one
owner (Locality).

---

## Visual 5 — Target division: ~5 focused modules, not 4 blurred ones

```
  BEFORE (4 blurred)                         AFTER (focused seams)

  ClaudeAgent  ─────────────┐                ClaudeAgent            (IAgent provider only)
   (provider + peer-chats)  │        ┌──────  ClaudePeerChatManager  (backings, fork, resolve)  ◀ C6
                            │        │
  ClaudeAgentSession ───────┼────────┤        ClaudeAgentSession    (thin coordinator)
   (god-object ≥15 jobs)    │        ├──────  SdkQueryFactory       (Options + WarmQuery build) ◀ C1
                            │        ├──────  SessionPendingState    (permission + user-input)   ◀ C5
                            │        └──────  (credits / enrichment folded or extracted)         ◀ C5
  ClaudeSdkPipeline ────────┤                 ClaudeSdkPipeline      (Query lifetime + config)   ◀ C2
   (deep core+bloat)        │                   └ owns the WHOLE bijective cache
                            │
  ClaudePromptQueue ────────┘                 ClaudePromptQueue      (unchanged — reference shape)
```

---

## Deepening candidates (ranked by leverage × how directly they hit your complaints)

Legend for which complaint each serves: **[dup]** duplication/rematerializer ·
**[cyc]** overlap/circular calls · **[life]** lifecycle/statefulness.

### Tier 0 — free win (do regardless): delete dead code  **[cyc]**
Three agents independently grep-confirmed **5 public methods with zero production
callers**: `ClaudeAgentSession.seedBijectiveState`, `ClaudeAgentSession.attachRematerializer`,
`ClaudeAgentSession.rebindForClientTools`, `ClaudeSdkPipeline.setClientToolOwner`,
`ClaudeSdkPipeline.reloadPlugins`. Pure interface-shrink, no behaviour change.

### Candidate 1 — Extract a `SdkQueryFactory` (Options + WarmQuery building)  **[dup][cyc][life]**  ★ highest leverage
- **Files**: `claudeAgentSession.ts` (materialize + rematerializer), `claudeSdkPipeline.ts` (ctor, `_rebindQuery`), `claudeSdkOptions.ts`.
- **Problem**: `materialize` and the rematerializer closure build `Options` twice
  (~50% duplication); the pipeline takes the rematerializer via two-phase
  `attachRematerializer` and throws if unattached; the closure launders the
  session's whole Options-building capability across the seam.
- **Solution**: one deep module that, given the session's declarative state
  (model, agent, permissionMode, diffs, workingDirectory, transport, isResume,
  resumeAnchor), produces a `WarmQuery` + its `AbortController`. Both the first
  materialize and every rebind call the *same* method. The pipeline takes this
  factory (a `rebuild: () => Promise<{warm, abortController}>` — or the factory
  itself) **at construction**, killing the two-phase init and the throw.
- **Benefits**: kills the duplication (Locality: one place to change how a Query
  is built); the seam now carries a *built subprocess*, not a re-entrant closure;
  and — the testability payoff — Options-building becomes a **pure unit test with
  no subprocess**, and the pipeline can be constructed with a fake factory to
  test a **realistic rebind** without the 7010-line agent test.

### Candidate 2 — Sink the entire bijective config cache into the pipeline  **[dup][life]**
- **Files**: `claudeSdkPipeline.ts` (six `_applied*`/`_current*` fields, `seedCurrentConfig`, `_replayCurrentConfig`), `claudeAgentSession.ts` (`setModel`/`setAgent`, the `seedCurrentConfig` call, effort derivation).
- **Problem**: model/effort/permissionMode is derived up to 3×/turn and cached as
  two parallel six-field sets; effort is computed on the session but cached as a
  first-class axis on the pipeline. "What has the SDK been told" has no single owner.
- **Solution**: the pipeline is the sole owner of "current vs applied"; the
  session hands it *desired* values only. Collapse `applied×current` into one
  structure with an explicit dirty check.
- **Benefits**: removes a whole statefulness axis from the session; one owner of
  SDK-config truth (Locality). Directly serves "less statefulness."

### Candidate 3 — One owner for permission-mode resolution  **[dup]**
- **Files**: `claudeAgent.ts` (4 sites), `claudeAgentSession.ts` (2 sites), `claudeSessionPermissionMode.ts`.
- **Problem**: the `readClaudePermissionMode(cfg,uri) ?? overlay ?? 'default'`
  chain is re-rolled at 8 sites. Per your own project guidance (domain logic
  belongs in the domain service), this resolution is domain logic living in consumers.
- **Solution**: a single `resolvePermissionMode(uri)` (or a small mode resolver)
  that owns the full fallback chain; every site delegates.
- **Benefits**: one place the fallback order can change; consumers stop re-implementing it.

### Candidate 4 — Give the queue sole ownership of abort/done; delete the two closures  **[cyc][life]**
- **Files**: `claudeSdkPipeline.ts` (`_getAbortSignal`, `_onSteeringYielded`, `_wireAbortHandler`), `claudePromptQueue.ts`.
- **Problem**: `_getAbortSignal = () => this._abortController.signal` exists *only*
  because the controller is swapped on rebind — but abortedness already reaches
  the queue via the direct `notifyAborted()` push. `_onSteeringYielded` is a
  back-reference where every sibling (router→pipeline) already uses an `Event`.
- **Solution**: the queue owns a `_done` boolean set by `notifyAborted`, cleared
  by `resetForRebind` (deletes `_getAbortSignal`); expose steering-yielded as
  `Queue.onDidYieldSteering: Event` (matches the router pattern).
- **Benefits**: removes both dotted back-references from Visual 1; the queue
  stops depending on the pipeline's live-controller identity.

### Candidate 5 — Split the god-object session  **[cyc][life]**
- **Files**: `claudeAgentSession.ts`.
- **Problem**: ≥15 responsibilities, no isolated test, only reachable through the
  7010-line agent test. Two clean extractions: the pending-permission +
  pending-user-input registries (already `PendingRequestRegistry`-backed) into a
  `SessionPendingState`, and the credit-accounting + signal-enrichment into a
  small mapper the pipeline signal passes through.
- **Benefits**: each extraction gets its own small test surface; the session
  interface shrinks toward "coordinator." Shrinks the agent test.

### Candidate 6 — Extract the peer-chat manager out of `ClaudeAgent`  **[cyc]**
- **Files**: `claudeAgent.ts` (`_chatBackings`, `_createChat`, `_forkChat`, `_materializeChatLocked`, `_buildProvisionalChat`, `_resolveParentSession`, `materializeChat`, `_updateChatBackingModel`, `_resolveChatSdkId`, …).
- **Problem**: ~17 members form a self-contained module hidden inside the 2247-line
  provider — "two modules in a trench coat."
- **Benefits**: the agent becomes the `IAgent` surface again; the chat-backing
  lifecycle gets its own seam and test surface.

### Candidate 7 — Split Provisional vs Materialized into two types  **[life]**
- **Files**: `claudeAgentSession.ts` (`isPipelineReady` branching, `abortController` exposure, `_requirePipeline`).
- **Problem**: one class models both a draft (no pipeline, exposes
  `abortController`) and a live session (pipeline present). Callers branch on
  `isPipelineReady` everywhere; the raw `abortController` leaks so provisional
  aborts can be issued from four call sites.
- **Solution**: a provisional type that exposes `abortProvisional()` and
  `materialize(): MaterializedSession`; the live type never exposes the raw
  controller. Makes the state machine legible in the type system.
- **Benefits**: directly addresses "I'm losing my grip on lifetime" — the
  compiler tracks the phase; the AbortController divergence becomes unrepresentable.

### Candidate 8 — Unify subprocess teardown into one awaitable verb  **[life]**
- **Files**: `claudeSdkPipeline.ts` (`shutdownAndWait`, dispose-chain, `_rebindQuery` manual dispose).
- **Problem**: three spellings of "kill the WarmQuery," safe only via SDK
  `close()` memoization (undocumented); `shutdownAndWait` deliberately does *not*
  dispose the pipeline Disposable, which is subtle.
- **Benefits**: one teardown path whose safety doesn't rest on an SDK
  implementation detail.

---

## Self-critique / second-guessing

- **Is Candidate 1 worth it, or is the duplication "load-bearing"?** The two
  `buildOptions` calls *look* copy-pasted but the maintainer may have kept them
  apart deliberately (the rematerializer runs in a `catch`-sensitive path that
  marks diffs dirty on failure). Counter: the failure-handling is orthogonal to
  Options-*building*; extracting the builder doesn't touch the catch. I'm
  confident the extraction is safe, but the grilling should confirm the
  `markDirty`-on-failure semantics survive.
- **Queue: reference shape (report 05) vs weakest split (report 04).** These two
  findings genuinely conflict. The queue is the *most* testable module — yet its
  turn-settlement invariant (M10 steering batching) is co-owned with the pipeline
  (`settleHead` vs `_processMessages` both re-check `isEmpty`). So "the queue is
  the good example" and "the queue's seam leaks" are *both true*. My lean: keep
  the queue (its isolation is real leverage) but move the `ChatTurnComplete`
  decision to live entirely on one side. I flag this as the least-settled call.
- **Am I over-fitting to "5 modules"?** The number is a consequence, not a goal.
  Candidates 5–7 are three independent splits; a maintainer could reasonably do
  only C5 (the session) and stop. I should not present "5 modules" as a target to
  hit — only as the shape that falls out if all splits are taken.
- **The honest correction on lifecycle.** I want to be careful not to let the
  maintainer chase a disposal bug that isn't there. The value in C7/C8 is
  *legibility and less state*, not fixing a leak. If the grilling reveals the
  real pain is elsewhere (e.g. debugging a specific hang), C1 (testable rebind)
  probably helps more than C7.
- **Sequencing risk.** C1 and C2 overlap (both touch config replay / the
  rematerializer). C1 should land first; C2 becomes smaller afterward. C3/C4/Tier-0
  are independent and safe to do anytime. C5–C7 are larger and should follow C1.

## What I'd want to grill next
Whichever candidate you pick, the open design questions are: (C1) does the factory
take the session by interface or receive a flat value bag? where does the
`markDirty`-on-failure live? (C2) is permissionMode part of the same cache as
model/effort or its own thing given it has a live runtime setter? (C5) do the
pending registries need the session at all, or just the `chatChannelUri` + the
progress emitter?
