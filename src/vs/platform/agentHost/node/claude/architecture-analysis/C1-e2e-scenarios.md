# C1 — E2E validation scenarios (live authenticated window)

Run in the authenticated Agents window (via the `launch` skill). Each scenario
names the **C1 code path** it exercises and **what to observe**. Priority ★ =
core C1 path; ◆ = empirical open question.

## Materialize (initial `_startSdkQuery`)

1. **★ Fresh session → first message.** New Claude session, send "hi", get a
   reply. *Exercises:* `materialize` → `_startSdkQuery(isResume=false)` → Options
   build → `startup` → pipeline → first turn. *Observe:* a normal streamed reply;
   agenthost.log shows one `startup isResume=false` line, no errors.
2. **Multi-turn (pipeline reuse, NO rebuild).** Send 2–3 messages in a row.
   *Observe:* only ONE `startup` line total (the pipeline is reused; the
   `send` pre-flight does not rebuild when nothing is dirty).

## Rebuild / rematerialize (`_rebuildSdkQuery`)

3. **★ Tool-set / customization change → restart-rebind.** Between turns, toggle a
   skill/customization (or change client tools), then send. *Exercises:* `send`
   pre-flight sees `clientCustomizationsDiff.hasDifference` → `_rebindForSyncedState`
   → `rebindForRestart` → the ctor-injected `_rebuildSdkQuery`. *Observe:* a second
   `startup isResume=true` line; the turn completes; the new customization is
   active; NO "no rematerializer attached" error (that path is gone).
4. **★ Abort mid-turn + resend → recover-rebind.** Start a long turn (ask for a big
   task), hit Stop, then send a new message. *Exercises:* abort → `_needsRebind` →
   next `send` → `_rebindQuery('recover')` → `_rebuildSdkQuery`. *Observe:* the new
   turn works on a fresh Query; the `markDirty()`-on-failure path is NOT triggered
   on the happy rebuild.

## Config (Desired on session → Applied on pipeline)

5. **Model change between turns.** Send a msg, switch model in the picker, send
   again. *Observe:* the new model answers (model indicator / behavior); no rebuild
   needed (eager `setModel`, applies next turn per SDK).
6. **Effort change.** Switch to a model without reasoning effort (e.g. Haiku) after
   a high-effort model. *Observe:* no API 400 (`effortLevel: null` clears it).
7. **PermissionMode change (immediate).** Mid-turn, switch approvals mode; confirm
   the NEXT tool in the SAME turn respects it (issue #321691 behavior).
8. **◆ Agent change (empirical for the runtime-swap question).** Select a custom
   agent, send. *Observe (the open question):* does it take effect? Does the log
   show a rebuild (`startup isResume=true`) today? This is the ~15-min check that
   gates treating `agent` as a live setter in C9.

## Resume anchor / truncate (`_pendingResumeSessionAt` through `_startSdkQuery`)

9. **★ Restore Checkpoint.** After several turns, Restore Checkpoint to an earlier
   turn, then send. *Exercises:* `truncateToTurn` stages the anchor →
   next `_startSdkQuery` passes `resumeSessionAt` → the branch resumes. *Observe:*
   history truncates correctly; the next turn continues from the restored point;
   the anchor is cleared after success (a retry doesn't re-truncate).
10. **Remove-all ("start over").** Clear the session; send. *Observe:* fresh
    same-id session materializes on a clean transcript.

## Resume / lifecycle (`isResume=true` materialize; dispose)

11. **Resume across restart.** Reload the window; reopen an existing session; send.
    *Exercises:* `_resumeSession` → `materialize(isResume=true)` → `_startSdkQuery`.
    *Observe:* transcript re-hydrates; the next turn works.
12. **Dispose mid-turn.** Dispose/close a session while a turn is active.
    *Observe:* clean teardown, no orphaned subprocess (check `ps`/logs).

## Steering (M10 — confirm C1 didn't disturb it)

13. **Steering mid-turn.** During a running turn, send a steering message.
    *Observe:* it's consumed (`steering_consumed`), folds into the in-flight turn.

---

**Minimum bar to green-light the commit:** 1, 3, 4, 9 (the core C1 paths) plus 8
(the agent empirical). The rest are regression breadth.
