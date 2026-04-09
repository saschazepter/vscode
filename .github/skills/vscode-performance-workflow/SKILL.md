---
name: vscode-performance-workflow
description: "Run agent-driven VS Code performance or memory investigations. Use when asked to launch Code OSS, automate a VS Code scenario, run the Chat memory smoke runner, capture renderer heap snapshots, take workflow screenshots, compare run summaries, or drive a repeatable scenario before heap-snapshot analysis."
---

# VS Code Performance Workflow

Drive a repeatable VS Code scenario, collect memory/performance artifacts, verify that the scenario actually happened, then hand the resulting heap snapshots to the generic heap-snapshot-analysis skill when object-level investigation is needed.

## When to Use

- User describes a VS Code workflow and asks whether it leaks or grows memory
- User asks the agent to launch VS Code, drive a scenario, and capture heap snapshots
- User asks to run the Chat memory smoke runner bundled with this skill
- User wants screenshots, `summary.json`, renderer heap samples, and targeted `.heapsnapshot` files for one scenario
- User wants a new automation runner for a non-Chat VS Code scenario

Do not use this skill when snapshots already exist and the user only wants heap object/retainer analysis. Use heap-snapshot-analysis directly.

## The Story

1. **Define the scenario.** Write down one warmup action, one repeatable iteration, and one quiescent point where it is fair to force GC and sample memory.
2. **Develop the automation.** Start with a tiny no-snapshot run. If it fails or the UI state is uncertain, keep the Code window open, connect agent-browser to the same CDP port, take workspace-local screenshots, inspect snapshots, and update the runner's selectors/waits.
3. **Run a fast smoke.** Disable heap snapshots first. Prove the scenario completes and the artifact summary says what you think it says.
4. **Capture targeted snapshots.** Snapshot a warmed-up baseline and a later iteration. Do not snapshot every sample unless necessary; snapshots are huge and slow.
5. **Verify the run.** Inspect `summary.json` and screenshots. Do not analyze a failed login, trust prompt, stuck progress row, or wrong UI state.
6. **Analyze snapshots.** Switch to heap-snapshot-analysis for compare scripts, object grouping, and retainer paths.
7. **Fix and verify.** After product-code changes, rerun the same fast smoke and the same targeted snapshot run. Compare like-for-like labels.

## Chat Workflow: Existing Runner

Use the bundled [Chat memory smoke runner](./scripts/chat-memory-smoke.mts) when the scenario is Chat-specific or can be expressed as repeated Chat prompts. It launches Code OSS, opens Chat, sends prompts, waits for responses, writes screenshots and `summary.json`, samples renderer heap, and can take selected heap snapshots.

Fast health check:

```bash
node .github/skills/vscode-performance-workflow/scripts/chat-memory-smoke.mts --iterations 3 --no-heap-snapshots
```

Targeted post-warmup snapshots:

```bash
node .github/skills/vscode-performance-workflow/scripts/chat-memory-smoke.mts --iterations 8 --heap-snapshot-label 03-iteration-01 --heap-snapshot-label 03-iteration-08
```

User-described Chat scenario:

```bash
node .github/skills/vscode-performance-workflow/scripts/chat-memory-smoke.mts --iterations 8 --message 'For memory investigation iteration {iteration}, summarize the active workspace in one paragraph.' --heap-snapshot-label 03-iteration-01 --heap-snapshot-label 03-iteration-08
```

Important runner behavior:

- The default profile is persistent at `.build/chat-memory-smoke/user-data` so Chat auth can be reused.
- Pass `--temporary-user-data` only if a clean profile is part of the scenario.
- Pass `--keep-open` when the user needs to log in or watch the window, then close the window before the next automated run unless intentionally reusing it.
- Pass `--reuse` only when attaching to a Code window that was launched with `--enable-smoke-test-driver` and the chosen remote-debugging port.

## Develop and Watch a Runner

The first version of an automation runner is rarely correct. Treat the runner as a test you are developing: run a cheap scenario, observe the live workbench, adjust one selector or wait condition, and repeat. Do not collect heap snapshots until the runner is boringly reliable.

Suggested watch loop for the bundled Chat runner:

```bash
node .github/skills/vscode-performance-workflow/scripts/chat-memory-smoke.mts --keep-open --iterations 1 --no-heap-snapshots --port 9224 --output .build/chat-memory-smoke/watch-chat
```

While that Code window is open, inspect it with agent-browser from the repo root:

```bash
npx agent-browser connect 9224
npx agent-browser tab
npx agent-browser snapshot -i
npx agent-browser screenshot .build/chat-memory-smoke/watch-chat/agent-browser-observation.png
```

Agent-browser checkpoints:

- Run `tab` first. If the selected target is `about:blank` or a webview instead of the workbench, switch targets before trusting snapshots.
- Use `snapshot -i` to rediscover buttons, textboxes, list rows, webviews, and current accessible names. Prefer discovered state over stale selectors.
- Save screenshots inside the runner output folder or another workspace-local `.build/...` folder. Do not use `/tmp` for screenshots you expect the user to review.
- If the script is stuck, capture a screenshot and read the incremental `summary.json` before killing the window. The last submitted turn and last screenshot usually identify the missing wait condition.
- If auth is required, use `--keep-open`, let the user sign in once in the persistent default profile, close the window, then rerun the fast smoke.

When editing a scenario runner:

- Keep a stable output contract: `summary.json`, checkpoint screenshots, heap samples, optional `heap/*.heapsnapshot` files, and an `error` field on failure.
- Write summary/screenshot artifacts before long waits so failed runs are diagnosable.
- Wait for user-visible scenario completion, not arbitrary time. Prefer an observed response, progress disappearance, row-count change, editor content change, or command result.
- Validate with `--no-heap-snapshots` first. A broken runner plus a 2GB heap snapshot wastes time and hides the real failure.
- Close owned Code windows between runs unless the command intentionally uses `--keep-open` or `--reuse`.

## Verify Before Analyzing

Read the run's `summary.json` before opening heap snapshots. Check:

- `error` is absent
- `chatTurns` has the expected count
- each turn has a response-start reason and final response text, unless the run intentionally used `--skip-send`
- `analysis.postFirstTurnUsedBytes` and `analysis.postFirstTurnUsedBytesPerTurn` are present for multi-turn memory probes
- requested snapshot labels exist under `heap/`
- screenshots show the requested workflow and settled UI

Prefer a warmed-up baseline such as `03-iteration-01.heapsnapshot` over startup snapshots. Startup, Chat opening, login, extension activation, and first-use model loads are expected allocations.

## Compare a Chat Runner Result

After capture, use heap-snapshot-analysis. A minimal scratchpad comparison script looks like this:

```javascript
import path from 'node:path';
import { compareSnapshots, printComparison } from '../helpers/compareSnapshots.js';

const runDir = process.env.RUN;
if (!runDir) {
	throw new Error('Set RUN to a chat-memory-smoke output directory');
}

const before = path.join(runDir, 'heap', '03-iteration-01.heapsnapshot');
const after = path.join(runDir, 'heap', '03-iteration-08.heapsnapshot');
printComparison(compareSnapshots(before, after));
```

Run it from the heap-snapshot-analysis skill folder:

```bash
cd .github/skills/heap-snapshot-analysis
RUN=../../../.build/chat-memory-smoke/<run-folder> node --max-old-space-size=16384 scratchpad/compare-chat-run.mjs
```

## Non-Chat VS Code Scenarios

When the user describes a non-Chat scenario, ask only for the missing essentials: what action starts the scenario, what counts as one repeatable iteration, what indicates the UI is settled, and whether the profile should be persistent or temporary.

Then create a scenario-specific runner in a scratch location first. If it becomes generally useful, promote it to this skill's `scripts/` folder with documentation and validation.

Reuse these patterns from the [Chat memory smoke runner](./scripts/chat-memory-smoke.mts):

- launch `scripts/code.sh` or `scripts/code.bat`
- pass `--enable-smoke-test-driver`, `--disable-workspace-trust`, a known `--remote-debugging-port`, explicit `--user-data-dir`, explicit `--extensions-dir`, `--skip-welcome`, and `--skip-release-notes`
- connect Playwright with `chromium.connectOverCDP`
- wait for `globalThis.driver?.whenWorkbenchRestored?.()`
- enable CDP `Performance` and `HeapProfiler`
- collect garbage before memory samples
- write screenshots at important checkpoints
- write a machine-readable `summary.json` incrementally, especially before long waits
- support `--no-heap-snapshots` and targeted snapshot labels so validation stays fast
- make cleanup explicit: close the CDP browser, terminate owned Code processes, and preserve user-provided profiles

Keep scenario-specific UI selectors and wait logic in the scenario runner. Avoid making the Chat runner a generic abstraction unless multiple proven scenarios share the exact same lifecycle.

## Handoff to Heap Snapshot Analysis

Use heap-snapshot-analysis when you need to:

- compare two `.heapsnapshot` files by constructor/object group
- find direct retainers or paths to GC roots
- inspect why a particular class, model, widget, editor input, or DOM tree survived
- write investigation-specific scratchpad analysis against parsed snapshots

The output of this workflow is evidence: run summaries, screenshots, heap samples, targeted snapshots, comparison output, and retainer paths. Use that evidence to form a concrete leak hypothesis before editing product code.
