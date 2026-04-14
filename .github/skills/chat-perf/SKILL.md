# Chat Performance Testing

Run chat perf benchmarks and memory leak checks against the local dev build or any published VS Code version. Use when investigating chat rendering regressions, validating perf-sensitive changes to chat UI, or checking for memory leaks in the chat response pipeline.

## When to use

- Before/after modifying chat rendering code (`chatListRenderer.ts`, `chatInputPart.ts`, markdown rendering)
- When changing the streaming response pipeline or SSE processing
- When modifying disposable/lifecycle patterns in chat components
- To compare performance between two VS Code releases
- In CI to gate PRs that touch chat UI code

## Quick start

```bash
# Run perf regression test (compares local dev build vs VS Code 1.115.0):
npm run perf:chat -- --scenario text-only --runs 3

# Run all scenarios with no baseline (just measure):
npm run perf:chat -- --no-baseline --runs 3

# Run memory leak check (10 messages in one session):
npm run perf:chat-leak

# Run leak check with more messages for accuracy:
npm run perf:chat-leak -- --messages 20 --verbose
```

## Perf regression test

**Script:** `scripts/chat-perf/test-chat-perf-regression.js`  
**npm:** `npm run perf:chat`

Launches VS Code via Playwright Electron, opens the chat panel, sends a message with a mock LLM response, and measures timing, layout, and rendering metrics. By default, downloads VS Code 1.115.0 as a baseline, benchmarks it, then benchmarks the local dev build and compares.

### Key flags

| Flag | Default | Description |
|---|---|---|
| `--runs <n>` | `5` | Runs per scenario. More = more stable. Use 5+ for CI. |
| `--scenario <id>` | all | Scenario to test (repeatable). See scenarios below. |
| `--build <path\|ver>` | local dev | Build to test. Accepts path or version (`1.110.0`, `insiders`). |
| `--baseline-build <ver>` | `1.115.0` | Version to download and compare against. |
| `--no-baseline` | — | Skip baseline comparison entirely. |
| `--threshold <frac>` | `0.2` | Regression threshold (0.2 = flag if 20% slower). |
| `--verbose` | — | Print per-run details including response content. |

### Comparing two remote builds

```bash
# Compare 1.110.0 against 1.115.0 (no local build needed):
npm run perf:chat -- --build 1.110.0 --baseline-build 1.115.0 --runs 5
```

### Exit codes

- `0` — all metrics within threshold
- `1` — regression detected or runs failed

### Scenarios

| ID | What it stresses |
|---|---|
| `text-only` | Baseline — plain text response |
| `large-codeblock` | Single TypeScript block with syntax highlighting |
| `many-codeblocks` | 10 fenced code blocks (~600 lines) |
| `many-small-chunks` | 200 small SSE chunks |
| `mixed-content` | Markdown with headers, code blocks, prose |
| `long-prose` | ~3000 words across 15 sections |
| `rich-markdown` | Nested lists, bold, italic, links, blockquotes |
| `giant-codeblock` | Single 200-line TypeScript block |
| `rapid-stream` | 1000 tiny SSE chunks |
| `file-links` | 32 file URI references with line anchors |

### Metrics collected

- **Timing:** time to first token, time to complete (prefers internal `code/chat/*` perf marks, falls back to client-side measurement)
- **Rendering:** layout count, style recalculation count, forced reflows, long tasks (>50ms)
- **Memory:** heap before/after (informational, noisy for single requests)

### Statistics

Results use **IQR-based outlier removal** and **median** (not mean) to handle startup jitter. The **coefficient of variation (cv)** is reported — under 15% is stable, over 15% gets a ⚠ warning. Use 5+ runs to get stable results.

## Memory leak check

**Script:** `scripts/chat-perf/test-chat-mem-leaks.js`  
**npm:** `npm run perf:chat-leak`

Launches one VS Code session, sends N messages sequentially, forces GC between each, and measures renderer heap and DOM node count. Uses **linear regression** on the samples to compute per-message growth rate, which is compared against a threshold.

### Key flags

| Flag | Default | Description |
|---|---|---|
| `--messages <n>` | `10` | Number of messages to send. More = more accurate slope. |
| `--build <path\|ver>` | local dev | Build to test. |
| `--threshold <MB>` | `2` | Max per-message heap growth in MB. |
| `--verbose` | — | Print per-message heap/DOM counts. |

### What it measures

- **Heap growth slope** (MB/message) — linear regression over forced-GC heap samples. A leak shows as sustained positive slope.
- **DOM node growth** (nodes/message) — catches rendering leaks where elements aren't cleaned up. Healthy chat virtualizes old messages so node count plateaus.

### Interpreting results

- `0.3–1.0 MB/msg` — normal (V8 internal overhead, string interning)
- `>2.0 MB/msg` — likely leak, investigate retained objects
- DOM nodes stable after first message — normal (chat list virtualization working)
- DOM nodes growing linearly — rendering leak, check disposable cleanup

## Architecture

```
scripts/chat-perf/
├── common/
│   ├── mock-llm-server.js    # Mock CAPI server matching @vscode/copilot-api URL structure
│   └── utils.js              # Shared: paths, env setup, stats, launch helpers
├── test-chat-perf-regression.js
└── test-chat-mem-leaks.js
```

### Mock server

The mock LLM server (`common/mock-llm-server.js`) implements the full CAPI URL structure from `@vscode/copilot-api`'s `DomainService`:

- `GET /models` — returns model metadata
- `POST /models/session` — returns `AutoModeAPIResponse` with `available_models` and `session_token`
- `POST /models/session/intent` — model router
- `POST /chat/completions` — SSE streaming response matching the scenario
- Agent, session, telemetry, and token endpoints

The copilot extension connects to this server via `IS_SCENARIO_AUTOMATION=1` mode with `overrideCapiUrl` and `overrideProxyUrl` settings. The `vscode-api-tests` extension must be disabled (`--disable-extension=vscode.vscode-api-tests`) because it contributes a duplicate `copilot` vendor that blocks the real extension's language model provider registration.

### Adding a scenario

1. Add a new entry to the `SCENARIOS` object in `common/mock-llm-server.js` — an array of string chunks that will be streamed as SSE
2. Add the scenario ID to the `SCENARIOS` array in `common/utils.js`
3. Run: `npm run perf:chat -- --scenario your-new-scenario --runs 1 --no-baseline --verbose`
