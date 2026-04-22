---
name: vscode-scenario-builder
description: "Build, iterate on, and run Playwright-driven scenarios that exercise VS Code from sources. Use when the user asks the agent to verify a feature end-to-end in the workbench, drive a UI flow autonomously, write a repeatable scripted scenario, or build a feature and prove it works without manual button-clicking. Pairs a long-lived Code OSS window with the agent-browser CLI for snapshot-driven selector discovery, and a Playwright runner for fast, deterministic replays."
---

# VS Code Scenario Builder

Build a Playwright script that drives **VS Code from sources** through a real user scenario, iterate on it interactively with `agent-browser`, then re-run it autonomously to verify a feature you just built. The goal is a fast, deterministic alternative to clicking through the UI by hand every time you change product code.

## When to Use

- You just implemented a feature and want to verify it end-to-end in the workbench, repeatedly, while you keep iterating on the code.
- You need to reproduce a user-reported bug in a scripted way, then prove a fix.
- You want to drive a non-trivial UI flow (multi-step wizard, chat session, tree interactions, editor + panel coordination) without paying the cost of manual clicking.
- You want a scenario the next agent session can rerun unchanged.

Do **not** use this skill when:

- You only need a *one-shot* exploration ("does this command exist?"). Just use `agent-browser` against a running window.
- You're investigating performance or memory specifically. Use `auto-perf-optimize` — it's the same launch+CDP pattern with heap snapshots layered on top.
- The scenario is well-covered by an existing integration test runner (`scripts/test-integration.sh`, smoke tests under `test/`). Use those instead.

## Pick a Real Surface (Read This First)

The point of this skill is to find **product bugs**. That requires running against the real product surface, not a test harness. Before writing a single line of scenario code:

- **Default to Electron** (`./scripts/code.sh` / `code.bat` / `code-agents.sh`). The web shell and the Electron shell take different code paths — features you ship to users run in Electron.
- **Default to real providers** (real Copilot, real agent host with a real agent backend, a real workspace folder). Mock agents (`MockAgent`, `ScriptedMockAgent`, `--mock`, `sessions.web.test.internal`) exist to verify the *test harness itself*. They will not exercise streaming, tool approvals, auth refresh, network drops, real LLM behavior, or any of the surfaces where real bugs live.
- **If a launch path fails — STOP and report it.** Do not silently downgrade to a less-realistic surface. The downgrade hides the original problem AND makes the rest of the run uninformative. Common culprits and their fixes are in [Launch Gotchas](#launch-gotchas) below.
- **Bugs found only in `test/` directories or `Mock*` classes don't count.** Pre-flight checklist before declaring a product bug:
  1. Does the same code path exist in the non-mock provider?
  2. Does it behave correctly there?
  3. If yes to both, you've found a test-infra issue, not a product bug. Keep looking.
- **Escalate complexity along the real-product axis, not the UI-automation axis.** A 26-step scripted mock conversation is less valuable than 3 steps with a real agent doing a real edit on a real file.

## Launch Gotchas

These have all wasted real time. Check them before pivoting away from a launch path:

- **`ELECTRON_RUN_AS_NODE=1` in the environment.** When set (commonly inherited from VS Code's integrated terminal or agent runtimes), `./scripts/code.sh` launches the Electron binary as a plain Node process, and the workbench fails with cryptic ESM errors like `import { Menu } from 'electron'`. `launchCode.mts` strips this from the child env automatically, but if you spawn Electron yourself in a scenario, do the same:
  ```ts
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(codeScript, args, { env, ... });
  ```
- **Built-in extensions not built.** If the extension host logs `Cannot find module '.../extensions/.../out/extension.js'`, run `npm run watch-extensions` (or `npm run compile-extensions`) once.
- **Watch task not running.** The launcher serves files from `out/`, populated by `npm run watch`. If you only ever ran `npm run gulp transpile-client-esbuild`, you'll get stale code. Keep `npm run watch` running in another terminal during iteration.

## Core Story

The skill is a tight loop between **two terminals talking to the same Code window**:

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│ Terminal A (Playwright)     │         │ Terminal B (agent-browser)   │
│                             │         │                              │
│ node scenario.mts           │         │ npx agent-browser connect    │
│   --keep-open               │  CDP    │   <port>                     │
│   --port 9229               │ <-----> │ npx agent-browser snapshot -i│
│                             │         │ npx agent-browser screenshot │
│ Drives the scripted scenario│         │ Discovers refs/selectors,    │
│ Writes summary.json + PNGs  │         │ explores stuck states        │
└─────────────────────────────┘         └──────────────────────────────┘
              │                                       │
              └───────────► same Code OSS ◄───────────┘
                            (own user-data-dir,
                             own --remote-debugging-port)
```

1. **Bootstrap a scenario script** from the [template](./scripts/scenarioTemplate.mts) into [scratchpad/](./scratchpad/) under a dated subfolder.
2. **Launch with `--keep-open --port <free>`** so the window stays alive between script runs and agent-browser can attach.
3. **Snapshot-driven selector discovery.** Don't guess CSS — let `agent-browser snapshot -i` tell you the accessible name and ref of the element you actually want.
4. **Prefer commands over clicks.** Use `runCommand('workbench.action.X')` from [vscodeHelpers.mts](./scripts/vscodeHelpers.mts) whenever a command exists. Faster, more deterministic, survives UI changes.
5. **Re-run with `--reuse --port <same>`** to replay against the still-open window. No relaunch overhead — typical iteration is ~2 seconds.
6. **Settle waits, not sleep waits.** Wait for an observable state change (element visible, text content matches, response complete), never `setTimeout`.
7. **Write `summary.json` incrementally** so a stuck run still gives you the last successful step.
8. **When the script is boring and reliable,** drop `--keep-open`/`--reuse` and let it run cold for the autonomous verification pass.

## Why This Beats Click-by-Click

| Manual button-clicking | Scripted scenario |
| --- | --- |
| Re-do every step on every code change | Replay in 2s |
| Easy to forget a step | Recorded in code |
| Selectors drift silently | Failure points to the exact step |
| No reproducible artifact | `summary.json` + screenshots per run |
| Can't run while you read code | Headless runs in background |

## Quick Start

Build VS Code from sources first if you haven't (`npm run watch` — keep it running).

```bash
# 1. Make a dated scratchpad folder
mkdir -p .github/skills/vscode-scenario-builder/scratchpad/$(date +%F)-my-feature

# 2. Copy the template
cp .github/skills/vscode-scenario-builder/scripts/scenarioTemplate.mts \
   .github/skills/vscode-scenario-builder/scratchpad/$(date +%F)-my-feature/scenario.mts

# 3. First run — keep the window open, pick a free port
node .github/skills/vscode-scenario-builder/scratchpad/$(date +%F)-my-feature/scenario.mts \
  --keep-open --port 9229
```

In a **second terminal** while that window is open:

```bash
npx agent-browser connect 9229
npx agent-browser tab                        # confirm the workbench tab is selected
npx agent-browser snapshot -i                # discover refs and accessible names
npx agent-browser screenshot .build/scenario-builder/observe.png
```

Edit the scenario to use what you discovered, then **replay against the same window**:

```bash
node .github/skills/vscode-scenario-builder/scratchpad/$(date +%F)-my-feature/scenario.mts \
  --reuse --port 9229
```

When the scenario is reliable, do the cold autonomous run:

```bash
node .github/skills/vscode-scenario-builder/scratchpad/$(date +%F)-my-feature/scenario.mts
```

The cold run launches Code, runs the scenario, writes `summary.json` + screenshots, then closes everything.

## Anatomy of a Scenario

A scenario imports the helpers and exports/runs an `async (page, helpers) => { ... }` function. Helpers include:

- `runCommand(id)` — opens command palette, runs by command id (e.g. `workbench.action.toggleSidebar`). The fastest way to drive the workbench. **Always check if a command exists before scripting a click sequence.**
- `openFile(relativePath)` — opens a workspace file via quick open.
- `waitForElement(selector, opts?)` — wait for a DOM element with a sensible default timeout.
- `waitForElementGone(selector)` — wait until something disappears (dialogs, progress, loading spinners).
- `getText(selector)` — read text content of the first match.
- `screenshot(label)` — write a labeled PNG into the run output dir, returned in `summary.json`.
- `step(name, fn)` — wrap a logical step; failures attach a screenshot and the step name to `summary.json` automatically.

See [scripts/scenarioTemplate.mts](./scripts/scenarioTemplate.mts) for a runnable example.

## Selector Strategy (Most Important Section)

**Cardinal rule: discover selectors from a live snapshot, don't invent them.** VS Code class names change. Accessible roles and labels are far more stable.

Preference order:

1. **Command IDs** via `runCommand('workbench.action.X')` — no DOM at all. Best.
2. **`aria-label`, `role`, and `title` attributes** — `[aria-label="Source Control"]`, `[role="treeitem"][aria-label="src"]`. Stable across themes and refactors.
3. **View IDs** — every workbench part has an `id` like `workbench.view.scm`, `workbench.panel.chat`. Selector: `[id="workbench.panel.chat"]`.
4. **Container + descendant** — `[id="workbench.panel.chat"] .interactive-input-part`. Scope to a known stable container before reaching for class names.
5. **Last resort: leaf class names** like `.monaco-list-row`. These break. If you must use one, scope it tightly and add a settle wait + assertion.

Discovery loop with agent-browser:

```bash
npx agent-browser snapshot -i        # interactive refs, shows roles + names
npx agent-browser eval 'document.activeElement.outerHTML.slice(0, 400)'
npx agent-browser eval 'Array.from(document.querySelectorAll("[id^=workbench]")).map(e => e.id)'
```

The `eval` escape hatch is great for asking the live page "what classes are on this thing right now?" before you commit to a selector.

## Screenshots Are Your Evidence (Take Lots)

The user is not watching you click. The only way they can verify what you did, what you saw, and what you actually proved is by looking at the screenshots and `summary.json` you leave behind. Treat screenshots as the deliverable, not as a debugging aid.

Rules:

- **Take a screenshot at every meaningful step.** Use `helpers.screenshot('verb-noun')` (or rely on `step()` which captures one per step automatically). After a successful action, after an unexpected state, after the final assertion — all of them.
- **Capture state *before* AND *after* a key interaction** when proving a behavior change (e.g. `before-send-message`, `after-send-message`). Two adjacent screenshots make a far better proof than one.
- **Always screenshot the final asserted state.** Even on success. The user wants to see the "Hello, world!" response actually rendered — not just read your text claim that it appeared.
- **Always screenshot on failure.** `step()` does this for you, but if you `try/catch` manually, take one yourself before re-throwing or recovering.
- **Name them descriptively.** `01-chat-opened.png` is fine; `screenshot1.png` is not. The numeric prefix is added automatically by `step()` ordering — your label is the verb-noun part.
- **Tell the user where to look** at the end of the run. The scenario should print the absolute output path so the user can open it. `launchCode.mts` and the template do this — keep it.

Where they go (do NOT change this):

```
.build/scenario-builder/<scenario-name>/<timestamp>/
  ├── summary.json
  ├── 01-<step-name>.png
  ├── 02-<step-name>.png
  └── ...
```

Anti-patterns:

- Writing screenshots into `/tmp/`, `~/Desktop`, or anywhere outside the run output dir. They get orphaned from `summary.json` and the user can't find them.
- Skipping the final-state screenshot because "the test passed." The user has no way to audit your "pass" claim without it.
- Taking a screenshot but never mentioning the output path in your final summary to the user. They won't go hunting.

## Waits, Not Sleeps

Every wait should be tied to a user-visible state change:

- View opened: `waitForElement('[id="workbench.view.scm"]')`
- Editor content settled: `getText('.editor-instance .view-line')` matches expected
- Quick pick visible: `waitForElement('.quick-input-widget:not(.hidden)')`
- Progress gone: `waitForElementGone('.monaco-progress-container.active')`
- Chat response complete: `waitForElement('.interactive-response:not(.chat-response-loading)')`

Never `await timeout(1000)` "just to be safe". A flaky settle wait is a real bug — fix it once and every replay benefits.

If you genuinely need a small pause for DOM reflow, use `await page.waitForTimeout(50)` *after* the proper wait fired, not instead of it.

## User-Data-Dir Isolation

Each scenario gets its own user-data-dir under `.build/scenario-builder/<scenario-name>/user-data` by default. That means:

- Multiple scenarios can run **in parallel** in different worktrees.
- Auth (Copilot, GitHub) is preserved across runs of the same scenario.
- A bad scenario can't pollute your real VS Code profile.

Flags:

- `--user-data-dir <path>` — override the default location (e.g. share auth across scenarios).
- `--temporary-user-data` — use a fresh temp profile, deleted after the run. Use for "first-launch" scenarios.
- `--seed-user-data-dir <path>` — copy a logged-in profile in before launching. Useful when a fresh profile needs Copilot auth.
- `--workspace <path>` — open this folder. Default: a throwaway scratch folder under the run output dir. **Do not point at your real repo unless the scenario needs it** — scripted Chat tool calls will modify those files.

## Watch / Iterate Loop

Recommended for active development of a scenario:

```bash
# Terminal A — leave running
node .github/skills/vscode-scenario-builder/scratchpad/.../scenario.mts \
  --keep-open --port 9229 --output .build/scenario-builder/watch

# Terminal B — observe
npx agent-browser connect 9229
npx agent-browser snapshot -i

# Terminal A — replay against same window after each edit
node .github/skills/vscode-scenario-builder/scratchpad/.../scenario.mts \
  --reuse --port 9229 --output .build/scenario-builder/watch
```

Tips:

- **Each scenario step should be idempotent or self-resetting.** Prefer "open quick pick → escape → open quick pick" over assuming a starting state. This makes `--reuse` replays robust.
- **If the window gets into a weird state**, close it and start fresh — don't fight it. `Cmd+Q` is fine; the script will relaunch on the next non-`--reuse` run.
- **Stuck script?** Capture a snapshot from Terminal B, read the latest `summary.json`. The last successful step + the current accessibility tree almost always identify the missing wait.

## Output Contract

Every run writes to `--output` (default `.build/scenario-builder/<scenario-name>/<timestamp>/`):

```
summary.json            # machine-readable: steps, timings, errors, screenshots
00-launched.png         # workbench restored
NN-<step-name>.png      # one per `step()` call, plus on failure
error.log               # if the run failed
```

Inspect `summary.json` first. The shape:

```json
{
  "scenario": "my-feature",
  "startedAt": "2026-...",
  "endedAt": "2026-...",
  "ok": true,
  "steps": [
    { "name": "open chat", "ok": true, "durationMs": 234, "screenshot": "01-open-chat.png" },
    { "name": "send prompt", "ok": true, "durationMs": 1820, "screenshot": "02-send-prompt.png" }
  ],
  "error": null
}
```

The shape is stable enough for the agent to grep and assert on. When verifying a feature, prefer reading `summary.json` over re-running the scenario.

## Anti-Patterns

- **Sleep-based waits.** Always replace with a state-based wait.
- **Inventing CSS selectors.** Snapshot first; use `aria-label`/`role`/view ids.
- **Reusing your real user profile.** Don't. Use the default `.build/...` path.
- **Skipping `step()` wrappers.** Without them, failures lose context.
- **Letting screenshots pile up in `/tmp`.** They go in the run output folder, where they stay attached to the `summary.json`.
- **Letting a `--keep-open` window leak.** Close it before the next non-reuse run, or `--reuse` will fail mysteriously when ports conflict.
- **Silently downgrading from real → mock when launch fails.** See [Pick a Real Surface](#pick-a-real-surface-read-this-first). If you can't launch the real product, that *is* the bug — report it, don't paper over it with a mock.
- **Fixing a "bug" that only exists in `test/` or `Mock*` code.** Run the pre-flight checklist before claiming a product bug.

## Promoting a Scenario

If a scratchpad scenario proves repeatedly useful (you'd rerun it next week), move the `.mts` from `scratchpad/<dated>/` into `scripts/`, add a top-of-file comment block matching the existing scripts, and reference it from this SKILL.md. Otherwise leave it in the dated scratchpad folder — that folder is gitignored on purpose so investigation cruft doesn't accumulate.

## Files in This Skill

- **[scripts/launchCode.mts](./scripts/launchCode.mts)** — launches Code OSS from sources with CDP enabled, returns `{ browser, page, session, dispose }`. Handles `--keep-open`, `--reuse`, `--port`, `--user-data-dir`, `--workspace`.
- **[scripts/vscodeHelpers.mts](./scripts/vscodeHelpers.mts)** — `runCommand`, `openFile`, `waitForElement`, `step`, etc. The DSL your scenarios are written in.
- **[scripts/scenarioTemplate.mts](./scripts/scenarioTemplate.mts)** — copy-paste starter for new scenarios.
- **[scratchpad/](./scratchpad/)** — gitignored. New scenarios live here under dated subfolders (`YYYY-MM-DD-short-description/`).
