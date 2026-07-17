# 03 — The Rematerializer Smell + `buildOptions`-Twice Duplication

_Diagnosis only. Two smells fused into one construct: (1) a callback that lets the
session **smuggle its Options-building guts into the pipeline** after the fact, and
(2) a near-verbatim **duplication** of the whole materialize body inside that
callback. Line numbers are against the source as read; all claims verified._

Files:
- `claudeAgentSession.ts` — `materialize` (L423–584) + the `attachRematerializer` closure (L534–572)
- `claudeSdkPipeline.ts` — `IRematerializer` (L33–35), `attachRematerializer` (L317–319), `_rebindQuery` (L550–601), `_ensureQueryBound` (L147–156), `send` (L385–405)
- `claudeSdkOptions.ts` — `buildOptions` (L91–145), the thing called twice
- `claudeAgent.ts` — how the materialize ctx (`canUseTool`/`onElicitation`/`transport`/`serverToolHost`) is assembled (L970–990, L1010–1020, L530–543)

---

## 1. The two-call field-by-field diff

`buildOptions(input, transport, logStderr)` is called from exactly two places, both
inside `ClaudeAgentSession`:

- **A — initial materialize:** `claudeAgentSession.ts:443–461`
- **B — rematerializer closure:** `claudeAgentSession.ts:540–558`

They pass the same 13-field `IBuildOptionsInput` bag plus the same two trailing
args. Field-by-field:

| `IBuildOptionsInput` field | A (materialize, L445–457) | B (rematerialize, L542–554) | Verdict |
|---|---|---|---|
| `sessionId` | `this.sessionId` | `this.sessionId` | **IDENTICAL** |
| `workingDirectory` | `this.workingDirectory` (L446) | `this.workingDirectory!` (L543) | **IDENTICAL value**, differs only by a non-null `!` — same getter |
| `model` | `this._provisionalModel` | `this._provisionalModel` | **IDENTICAL expr** — live re-read (a mid-session `setModel` mutates this field, L751) |
| `abortController` | `this.abortController` (session-lifetime) | `rebuildAbort` = `new AbortController()` (L539) | **DIFFERS** — fresh controller per rebuild |
| `permissionMode` | `permissionMode` local (L439) | `liveMode` local (L535) | **DIFFERS by derivation, same formula** — both `readClaudePermissionMode(cfg, _storageUri) ?? _permissionModeFallback`; B re-reads live so a between-turns `SessionConfigChanged` wins |
| `canUseTool` | `ctx.canUseTool` | `ctx.canUseTool` | **IDENTICAL** — closed-over ctx |
| `onElicitation` | `ctx.onElicitation` | `ctx.onElicitation` | **IDENTICAL** — closed-over ctx |
| `isResume` | `ctx.isResume` (may be false) | `true` (hard-coded, L549) | **DIFFERS** — a rebuild is always a resume; flips `Options` from `{ sessionId }` to `{ resume }` (see `buildOptions` L131–133) |
| `resumeSessionAt` | `this._pendingResumeSessionAt` | `this._pendingResumeSessionAt` | **IDENTICAL expr** — live re-read of the staged anchor |
| `mcpServers` | `mcpServers` (from `_buildStartupToolWiring`, L440) | `rebuildMcp` (from `_buildStartupToolWiring`, L537) | **DIFFERS by var name, IDENTICAL derivation** — same `_buildStartupToolWiring(ctx.serverToolHost)` call |
| `allowedTools` | `allowedTools` (L440) | `rebuildAllowedTools` (L537) | **DIFFERS by var name, IDENTICAL derivation** — same wiring call |
| `plugins` | `this.clientCustomizationsDiff.consume()` | `this.clientCustomizationsDiff.consume()` | **IDENTICAL expr** — live-consuming re-read (clears the dirty bit) |
| `agent` | `agentName` (`resolveClaudeAgentName(...)`, L441) | `rebuildAgentName` (`resolveClaudeAgentName(...)`, L538) | **DIFFERS by var name, IDENTICAL derivation** — same 4-arg call |
| _arg 2_ `transport` | `ctx.transport` | `ctx.transport` | **IDENTICAL** |
| _arg 3_ `logStderr` | `data => this._logService.error(\`[Claude SDK stderr] ${data}\`)` | same literal (L557) | **IDENTICAL** — duplicated arrow literal |

**Net semantic delta = exactly three fields:** `abortController` (fresh), `isResume`
(false→hard `true`), and `permissionMode` (same formula, re-evaluated live). Every
other field is either the identical expression or the identical derivation with a
renamed local. Nothing in B is *conceptually new* — it is A re-typed with three
substitutions.

### Surrounding scaffolding, called twice

| Scaffold | Materialize | Rematerialize | Verdict |
|---|---|---|---|
| `readClaudePermissionMode(cfg, _storageUri) ?? _permissionModeFallback` | L439 (`permissionMode`) | L535 (`liveMode`) | duplicated formula |
| `_buildStartupToolWiring(ctx.serverToolHost)` | L440 | L537 | duplicated call (helper explicitly exists "so the two startup paths can never drift" — L599–600) |
| `resolveClaudeAgentName(this._provisionalAgent, _fileService, _logService, sessionId)` | L441 | L538 | duplicated verbatim |
| `buildOptions({…13 fields}, ctx.transport, stderrCb)` | L443–461 | L540–558 | duplicated (19-line call, 13-field bag) |
| `this._sdkService.startup({ options })` | L465 | L560 | duplicated |
| clear `this._pendingResumeSessionAt = undefined` | L496 | L565 | duplicated (both guard "cleared only on success"; A's comment L493–495, B's L561–564) |
| stderr callback arrow | L460 | L557 | duplicated literal |

The abort-gating differs: A has two explicit post-await abort gates against
`this.abortController` (L467–470, L530–532); B's freshly-built pair is instead
gated by the pipeline in `_rebindQuery` (`_store.isDisposed` L566, placeholder
`signal.aborted` L575). So the abort discipline is *also* duplicated — once in the
session for path A, once in the pipeline for path B.

**Quantified duplication.** The rematerializer closure is `claudeAgentSession.ts:534–572`
(≈39 lines). Of those, the near-verbatim recurrences of the materialize body are:
permissionMode (1) + tool wiring (1) + agent name (1) + `buildOptions` bag (≈15 of
the 19 call lines) + `startup` (1) + anchor-clear (1) ≈ **20 duplicated lines**, i.e.
roughly **half the closure is a copy of the initial materialize body**. The closure's
only genuinely new lines are the fresh `AbortController` (L539), the `isResume: true`
literal (L549), the resume-rebuild log (L559), the `return { warm, abortController }`
(L566), and the `catch { markDirty; markDirty; throw }` (L567–571).

---

## 2. What the rematerializer closure captures (the session→pipeline seam)

The closure at `claudeAgentSession.ts:534` is created inside `materialize` and handed
to the pipeline via `pipeline.attachRematerializer(...)`. It is a `() => Promise<{ warm, abortController }>`
— the *only* thing that crosses the seam by signature. But by **closure capture** it
smuggles the session's entire Options-building capability across. Everything it reads:

**Captured session fields (mutable `this` state, read live at rebuild time):**
- `this.sessionId` (L542)
- `this.workingDirectory` (L543) — the getter, with a `!` assertion
- `this._provisionalModel` (L544) — mutated by `setModel` between turns
- `this._provisionalAgent` (L538, via `resolveClaudeAgentName`) — mutated by `setAgent`
- `this._pendingResumeSessionAt` (L550) — staged by `truncateToTurn`, cleared here on success (L565)
- `this._permissionModeFallback` (L535)
- `this._storageUri` (L535, inside `readClaudePermissionMode`)

**Captured injected services:**
- `this._configurationService` (L535) — live permission-mode read
- `this._sdkService` (L560) — `startup({ options })`
- `this._fileService`, `this._logService` (L538, via `resolveClaudeAgentName`; also stderr L557)

**Captured collaborators (mutated on failure):**
- `this.toolDiff` (L537 via `_buildStartupToolWiring`, and `markDirty()` L568)
- `this.clientCustomizationsDiff` (L553 `.consume()`, and `markDirty()` L569)

**Captured methods:**
- `this._buildStartupToolWiring` (L537)

**Captured `ctx` (the `IMaterializeContext` from `claudeAgent.ts`):**
- `ctx.transport` (L556), `ctx.canUseTool` (L547), `ctx.onElicitation` (L548), `ctx.serverToolHost` (L537)

So the pipeline's JSDoc claim — *"Owns one SDK Query lifecycle… **Knows nothing about
protocol turns, the workbench mapper, file-edit observers, or permission registries**"*
(`claudeSdkPipeline.ts:37–41`) and `IRematerializer`'s framing that the pipeline can
"rebuild… **without depending on the materializer service directly**" (L27–32) — is
technically true at the *type* level and false at the *behavioural* level. The
pipeline **drives** Options-building: `_rebindQuery` calls `this._rematerializer(reason)`
(L561), which reaches back into the session and rebuilds the SDK subprocess using
seven session fields, three services, two diffs, one method, and four ctx values. The
callback is the hidden back-reference that makes the pipeline depend on the whole
session; the type signature launders that dependency down to `Promise<{ warm, abortController }>`.

**Error-recovery coupling (control + state ownership tangled).** On rebuild failure
the closure runs `this.toolDiff.markDirty()` and `this.clientCustomizationsDiff.markDirty()`
(L568–569) — mutating **session** state from inside a **pipeline**-invoked callback.
`buildClientMcpServers` already *consumed* (cleared) the tool diff (`claudeSdkOptions.ts:162`)
and `clientCustomizationsDiff.consume()` cleared the customization diff (L553); the
`catch` re-dirties both so the next `send` retries the rebind. The rationale is sound
(consume-then-restore-on-throw), but it means the pipeline's rebind control flow owns
the correctness of session-level dirty bits. Who is responsible for the diffs' state
is smeared across the seam. (Verified: throw path `claudeAgentSession.ts:567–571`.)

---

## 3. Temporal coupling / two-phase-init hazard

The pipeline is a **partially-constructed object**. Its constructor
(`claudeSdkPipeline.ts:226–263`) takes `warm`, `abortController`, `dbRef`, `subagents`,
`clientToolOwner` — but **not** the rematerializer. `_rematerializer` starts `undefined`
(L203) and is populated later by a separate `attachRematerializer(...)` mutation
(L317–319). So the real required-dependency set is *larger than the constructor
signature advertises*:

- **Construction happens at** `claudeAgentSession.ts:475` (inside `materialize`).
- **Attachment happens at** `claudeAgentSession.ts:534`, ~60 lines and several `await`
  boundaries later (after `startup`, after the DB ref open, after `seedCurrentConfig`,
  after the metadata write, after the final abort gate).

Between those two points the pipeline is live but un-rebindable. If `_rebindQuery` is
reached with no rematerializer attached it **throws at runtime**:

```
// claudeSdkPipeline.ts:551–553
if (!this._rematerializer) {
    throw new Error(`ClaudeSdkPipeline.rebind: no rematerializer attached (reason=${reason})`);
}
```

(Verified.) This is a classic temporal-coupling smell: a method whose precondition
(*"attach first"*) is enforced by a thrown error rather than by the type system. A
caller cannot construct a valid pipeline in one step; correctness depends on calling
two methods in the right order. The JSDoc even normalises it — *"Optional — tests that
exercise only the dispose path skip this"* (L316) — which is the tell that the
dependency is real but has been demoted to "optional" to make the two-phase shape
tolerable.

Why the two phases exist: the rematerializer closes over the very pipeline it is
attached to only indirectly, but it closes over `ctx`, the session's fields, and the
result of a *successful* first materialize (the whole point is to rebuild in `resume`
mode, `isResume: true`). You cannot build the closure until materialize has decided the
session is viable — but the pipeline must be constructed mid-materialize to receive
`warm`. So construction and attachment straddle the `startup` await by necessity *given
this shape*. The shape is what forces the split.

**Vestigial parallel surface.** The session also exposes its own `attachRematerializer`
(L668–670) and `seedBijectiveState` (L664–666) wrappers that just forward to
`_requirePipeline()`. Neither is called in production — materialize attaches the
rematerializer **directly** on the local `pipeline` variable (L534) and seeds config
**directly** via `pipeline.seedCurrentConfig` (L501). Both wrappers are reached only
from tests / plan docs (grep: `seedBijectiveState` and the session-level
`attachRematerializer` have no non-test production caller). So the two-phase-init API
has been duplicated onto the session as dead pass-through surface — a second copy of a
smell that already only exists to paper over the first.

---

## 4. Duplicated-lines tally

| Duplicated unit | A (materialize) | B (rematerialize) | Lines |
|---|---|---|---|
| permission-mode read formula | L439 | L535 | 1 |
| `_buildStartupToolWiring` call + destructure | L440 | L537 | 1 |
| `resolveClaudeAgentName` call | L441 | L538 | 1 |
| `buildOptions` argument bag (13 fields) + wrapper | L443–461 | L540–558 | ~15 of 19 |
| `_sdkService.startup({ options })` | L465 | L560 | 1 |
| `_pendingResumeSessionAt = undefined` (success clear) | L496 | L565 | 1 |
| stderr callback arrow literal | L460 | L557 | 1 |
| **Total near-verbatim duplication** | | | **≈20 lines** |

Out of the ≈39-line rematerializer closure (L534–572), **≈50% is a copy of the
materialize body**. The genuinely-new content is 5 small fragments (fresh
`AbortController`, `isResume: true`, one log line, the `return`, the 5-line `catch`).
Plus a **third** copy of the same effort/model derivation lives in `seedCurrentConfig`
(see §5). The `_buildStartupToolWiring` helper (L586–623) is itself the *evidence* of
this pressure: its own JSDoc says it exists because "the two startup paths can never
drift" (L599) — it factored out one slice of the duplication but left the larger
`buildOptions`/`startup`/anchor-clear slice un-factored.

---

## 5. Bijective / applied-vs-current double-cache duplication

Model/effort/permissionMode are **derived three times** per materialize+rebuild cycle:

1. **In `buildOptions` (path A)** — `Options.model = toSdkModelId(input.model?.id)`,
   `Options.effort = resolveClaudeEffort(input.model)` (`claudeSdkOptions.ts:128–129`),
   `permissionMode` L130. These bake startup-only values into the subprocess.
2. **In `seedCurrentConfig` (right after A)** — `claudeAgentSession.ts:501–505` derives
   the *same* values again independently:
   `toSdkModelId(this._provisionalModel?.id)`,
   `toRuntimeEffortLevel(resolveClaudeEffort(this._provisionalModel))`, `permissionMode`
   — and writes them into **both** the pipeline's `_current*` and `_applied*` caches
   (`claudeSdkPipeline.ts:327–334`). The comment states the intent: the SDK already
   started with these, so mark them current-and-applied to skip a redundant first
   `setModel`.
3. **In `buildOptions` (path B)** — the rematerializer re-derives all three a third
   time from `_provisionalModel` / `liveMode`.

The pipeline maintains a **double cache** — `_currentModel/_currentEffort/_currentPermissionMode`
(what the consumer wants, L199–201) vs `_appliedModel/_appliedEffort/_appliedPermissionMode`
(what the SDK has, L194–196). `_rebindQuery` resets the *applied* trio to `undefined`
after a successful rebuild (L596–598) then calls `_replayCurrentConfig` (L600), which
pushes `_current*` back onto the fresh Query via `setModel` / `applyFlagSettings` /
`setPermissionMode` (L526–543). But the rebuilt Query **already baked those same values
into `Options`** via path-B `buildOptions`. So the sequence is: derive into Options →
start subprocess with them → wipe applied cache → re-derive current → **redundantly
re-push the same values at runtime**. The bijective ("settable at startup *and* mutable
at runtime" — CONTEXT.md "Startup-only vs runtime mutability") nature of these three
fields is exactly what lets the code get away with computing them in two subsystems
(Options bag + runtime setters) that don't share a derivation — and pay for it with a
triple computation and a redundant post-rebind re-push.

`seedBijectiveState` (L664) is the JSDoc'd public wrapper for step 2, but production
uses the direct `pipeline.seedCurrentConfig` call at L501 (§3) — so the "bijective
seed" concept, like the rematerializer, has a duplicated unused surface.

---

## 6. Who calls the rematerializer, and the tension that forces it

`_rematerializer(reason)` is invoked from exactly one place — `_rebindQuery` at
`claudeSdkPipeline.ts:561`. `_rebindQuery` fires from two:

- **`_rebindQuery('restart')`** ← `rebindForRestart()` (L304–306) ← session
  `_rebindForSyncedState()` (L717–721) ← `send()` pre-flight when `toolDiff` /
  `clientCustomizationsDiff` / `_pendingResumeSessionAt` differ (L697–698), plus
  `rebindForClientTools()` (L938) and `startMcpServer` fallback (L1059).
- **`_rebindQuery('recover')`** ← `_ensureQueryBound()` when `_needsRebind` (L148–149)
  and `send()` when `_needsRebind` (L386–388), i.e. after an abort/crash left the
  stream dead.

**The underlying tension (state it crisply):** The SDK bakes a large set of
**startup-only** `Options` into the subprocess at `startup()` time — tool set
(`mcpServers`), plugins, custom `agent`, `resume` anchor. There is no runtime
control-plane to change these on a live `Query` (CONTEXT.md M6/M11:
`reloadPlugins()` is parameterless and cannot change the plugin URI set; `Options.agent`
"is captured at startup — there is no runtime control-plane equivalent"). So any
tool/plugin/agent change, or an abort/crash, requires a **whole new WarmQuery**. But:

- **Only the session knows how to build `Options`** — it owns `_provisionalModel`,
  `_provisionalAgent`, both diffs, the metadata overlay, the permission-mode read, and
  the `ctx` (transport/canUseTool/onElicitation/serverToolHost).
- **The pipeline owns the `Query` lifetime** — the warm/abort swap, the parked-iterator
  handoff, the placeholder-abort race in `_rebindQuery`, the consumer-loop re-arm.

Neither side can own the rebuild alone. The rematerializer is the negotiated seam
between them: the pipeline says *"I need a fresh `{ warm, abortController }`, you build
it,"* and the session obliges by re-running its materialize body. The convolution the
maintainer flagged is the **direct cost of splitting Options-ownership (session) from
Query-ownership (pipeline)** across a callback instead of a first-class collaborator.

---

## 7. Redesign sketches (plain English, no code) + tradeoffs

**Sketch 1 — Extract `materializeOptions()` / an `ISdkQueryFactory`.**
Pull the shared spine — permission read, `_buildStartupToolWiring`, `resolveClaudeAgentName`,
the `buildOptions` bag, `_sdkService.startup`, the success anchor-clear — into one
method/collaborator parameterised by the three real deltas (`abortController`,
`isResume`, whether to re-read permission live). Both materialize (path A) and the
rematerializer (path B) call it. Kills the §1/§4 duplication and the §5 triple
derivation at the source (one place computes model/effort). *Tradeoffs:* smallest,
lowest-risk change; does **not** by itself fix the two-phase init or the closure seam —
the factory still closes over session state and is still attached after construction.
But it is the enabling refactor for 2/3 and, per report 05, makes Options-building
unit-testable with no subprocess.

**Sketch 2 — Pass the factory in the pipeline constructor, not `attachRematerializer`.**
Build the `ISdkQueryFactory` (Sketch 1) *before* constructing the pipeline and hand it
in as a constructor dependency. Removes the `_rematerializer: undefined` field, the
`attachRematerializer` mutator, and the throw-if-unattached guard (§3) — the pipeline is
whole after `new`. *Tradeoffs:* requires the factory to be buildable pre-`startup`
(it must produce the *first* warm too, or the first warm is passed separately and the
factory only rebuilds) — a mild ordering puzzle since today the first `warm` is created
*inside* materialize and the pipeline is constructed around it. Cleanest fix for the
temporal-coupling hazard; medium blast radius (constructor signature + the vestigial
session wrappers in §3 get deleted).

**Sketch 3 — Invert ownership: session owns Query-building, pipeline takes `rebuild: () => Promise<WarmQuery>` at construction.**
Make the session the single owner of "how to stand up a WarmQuery" (both first and
rebuild), and narrow the pipeline to a pure lifetime manager that receives a `rebuild`
thunk once, at construction. Same callback *shape* as today but attached honestly at
`new` time rather than mutated in later — collapses §2 and §3 together, and the seam
becomes a documented one-way dependency (pipeline → session-supplied rebuild) instead
of a hidden back-reference laundered through a type. *Tradeoffs:* closest to the current
architecture (least conceptual churn) but keeps the closure-capture pattern — the
pipeline still can't be tested without a realistic rebuild thunk. The `markDirty`-on-
failure state coupling (§2) stays unless the factory also owns diff consume/restore.

**Cross-cutting note.** None of the three erase the fundamental tension in §6 (startup-
only Options ⇒ full rebuild on any tool/plugin/agent change; session owns Options,
pipeline owns Query). They relocate *where the seam is declared*: today it is an
after-the-fact mutation carrying a laundered whole-session dependency; the redesigns make
it a named, constructor-time, testable collaborator. The duplication (§1/§4/§5) is
independently removable by Sketch 1 regardless of which ownership shape wins.
