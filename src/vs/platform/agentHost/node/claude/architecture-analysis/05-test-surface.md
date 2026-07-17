# 05 — Test Surface (orchestrator's own finding)

_This report is authored by the orchestrator, not one of the four angle agents.
It exists because the skill treats **the interface as the test surface**: if a
module's real behaviour can only be tested *past* its interface, the module is
the wrong shape._

## Test-file inventory for the four modules

| Module | Source LOC | Dedicated unit test | Test LOC | Isolation cost |
|---|---|---|---|---|
| `ClaudePromptQueue` | 171 | `claudePromptQueue.test.ts` | 252 | **Trivial** — harness is `(sessionId, () => controller.signal, (id)=>push)` |
| `ClaudeSdkPipeline` | 689 | `claudeSdkPipeline.test.ts` | 580 | **High** — `FakeWarmQuery` + `ImmediatelyDoneQuery` stub ~30 SDK methods, most `throw 'not modeled'` |
| `ClaudeAgentSession` | 1092 | **NONE** | 0 | n/a — only tested transitively |
| `ClaudeAgent` | 2247 | `claudeAgent.test.ts` | **7010** | Monolithic; also carries the session's + pipeline's untested behaviour |

Integration: `claudeAgent.integrationTest.ts` (953) and `protocol/claudeAgentHostE2E.integrationTest.ts` (82).

## Signal 1 — the queue is DEEP and cleanly seamed (the good case)

`claudePromptQueue.test.ts` constructs the queue with a 3-argument harness and
exercises every invariant (steering-preempt M10 batching, `settleHead`,
`failAll`, `resetForRebind`, abort→done) directly against the public interface.
Behaviour per unit of interface is high; the seam (an injected abort-signal
getter + a steering callback) is small and honest. **This is the shape the other
three should aspire to.** Deletion test: fold the queue into the pipeline and the
parked-iterator + M10 batching complexity reappears inline — it earns its keep.

## Signal 2 — the pipeline's real behaviour is tested *past* its interface

`claudeSdkPipeline.test.ts` header comment (verbatim):

> "Tests in this file deliberately do NOT drive the consumer loop — they
> exercise the synchronous lifecycle surface (abort, dispose, rebind gating).
> Driving the SDK message stream end-to-end is covered by `claudeAgent.test.ts`."

So the pipeline's **most important** responsibility — the consumer loop
(`_processMessages`), turn-complete emission, rebind/recover, config replay — is
NOT verified through `ClaudeSdkPipeline`'s own interface. It's verified through
the 7010-line agent test, four layers up. This is the textbook "interface is not
the test surface" failure. Causes:
- The pipeline needs a live `WarmQuery` that actually yields SDK messages, and
  the fake can't cheaply model the stream, so the loop is left undriven here.
- The rebind path needs an `IRematerializer`, which only the *session* knows how
  to build (see report 03) — so a pipeline-level test can't exercise a realistic
  rebind without reconstructing half the session.

The ~30-method `FakeWarmQuery`/`ImmediatelyDoneQuery` stub (most methods
`throw new Error('not modeled')`) is itself evidence the SDK `Query` seam is
wide — the pipeline's interface to the SDK is nearly as large as the SDK.

## Signal 3 — the session has no test surface at all

There is no `claudeAgentSession.test.ts`. The 1092-line coordinator — which owns
materialize, the rematerializer closure, permission/user-input registries, both
diffs, credit accounting, signal enrichment, customization discovery, metadata
writes — is only reachable through `claudeAgent.test.ts`. A god-object with no
isolated test is the strongest possible "this module is the wrong shape" signal:
its interface is too entangled with the agent (sequencers, `_sessions` map,
proxy handle) to stand up alone. The 7010-line agent test is the direct cost of
that entanglement.

## How the candidates should be judged on testability

Any deepening that this analysis proposes should be scored on: *does it create a
seam that turns currently-untestable behaviour into an interface a small test can
cross?* Concretely:
- Extracting Options-building (the rematerializer duplication, report 03) into a
  pure `materializeOptions()` / `ISdkQueryFactory` makes it unit-testable with no
  SDK subprocess and lets the pipeline take the factory at construction — which
  in turn makes a **realistic pipeline rebind test** possible without the agent.
- Splitting the session's god-object responsibilities (report 04) gives each
  extracted collaborator its own small test surface, shrinking the 7010-line
  agent test.
- The queue needs no change — it's the reference example of the target state.
