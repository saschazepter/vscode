# Plan: End-to-End OTel Tracing for the Chat Pipeline

**Status:** Draft. Dev-only. Not for users.
**Branch:** `zhichli/otelexpanded`.
**Goal:** Make a single OTel trace cover the entire chat dispatch pipeline — from the user pressing Enter in the chat input through to the agent's `invoke_agent` span and any subagents/tools — without bespoke IPC plumbing or CORS workarounds.

This document supersedes the ad-hoc approach currently on the branch (which proxies renderer spans through a Copilot extension command). The plan below is the conventional, multi-process OTel pattern used by Slack, GitHub Desktop, the Azure Monitor team, and is recommended by the OpenTelemetry maintainers.

---

## 1. Principles

These three rules shape every decision in the rest of the document:

1. **One OTel SDK per process.** Renderer, extension host, Copilot CLI subprocess, and any other Node process each run their own SDK and export independently. Nothing forwards spans on behalf of another process.
2. **Federate by W3C trace context.** Every process boundary propagates a 32-hex `traceId` + 16-hex `spanId` (the standard `traceparent` string). The collector merges by `traceId` automatically.
3. **All exports go to a local OTel Collector.** The Collector handles CORS, batching, retries, fan-out, sampling, redaction, and protocol translation. Apps stay dumb. The Collector is what makes Aspire/Jaeger/Tempo/App-Insights interchangeable.

If a feature in this plan can be implemented either inside the app or inside the Collector, it goes in the Collector.

---

## 2. Target Architecture

```
                    ┌─────────────────────┐
   Renderer (web) ─►│                     │
                    │                     │
   Ext host (Node) ─►│  OTel Collector    │─► Jaeger / Tempo / Aspire / App-Insights / file
                    │  (localhost:4318)   │
   Copilot CLI ────►│  CORS enabled       │
                    │                     │
   Claude proxy ───►│                     │
                    └─────────────────────┘
```

- All services emit to **one** endpoint: the local Collector.
- The Collector exposes OTLP/HTTP on `4318` and OTLP/gRPC on `4317`, with `cors.allowed_origins: ["*"]` so the renderer can `fetch()` directly.
- Each process sets distinct `service.name` resource attributes (`vscode-workbench`, `vscode-exthost`, `copilot-chat`, `github-copilot`) so the trace UI shows the same trace stitched across services.

### Why a Collector and not direct-to-Jaeger / direct-to-Aspire?

- Aspire's OTLP endpoint **does not serve CORS preflight**. A renderer `fetch()` to it is permanently blocked. The current branch routes the renderer's payload through a `vscode.commands` relay in the Copilot extension as a workaround. This is brittle, doesn't generalize to `vscode.dev` (where the extension host is in a different process tree), and couples the renderer to one specific extension.
- Jaeger's OTLP endpoint also does not enable CORS by default; you'd have the same problem.
- A Collector with `cors.allowed_origins: ["*"]` (one line of YAML) eliminates both issues forever. Same Collector serves any backend you point it at.
- Even if you only ever use Jaeger, you still want a Collector in front: it lets you fan out to a JSON file for debugging, swap exporters without touching the app, and add tail-based sampling later.

---

## 3. Process Boundaries to Instrument

| Boundary | Carrier for trace context | Span on the producer side | Span on the consumer side |
|---|---|---|---|
| User keystroke → Renderer dispatch | in-process (active context) | `chat.submit` | `chat.dispatch` |
| Renderer → Ext host (chat agent RPC) | `IChatAgentRequest.traceContext` field | — | `invoke_agent <agent>` |
| Ext host → Copilot CLI subprocess | env var `TRACEPARENT` (already supported by the SDK) | `execute_tool runCopilotCLI` | `invoke_agent copilotcli` |
| Ext host → Claude proxy (in-process HTTP) | `traceparent` header | `chat <model>` | `chat <model>` (CAPI side) |
| Ext host → MCP tool | `_meta.traceparent` in JSON-RPC payload | `execute_tool <tool>` | (tool's own root span) |
| Subagent invocation (in-process) | stored context map keyed by invocation ID | `execute_tool runSubagent` | `invoke_agent <subagent>` |

Most of these (CLI, MCP, subagent) are already correct. The two new ones are the **renderer → ext host** hop and the **renderer-side spans** that precede it.

---

## 4. Phased Implementation

### Phase 1 — Stand up the Collector setup (1 file)

**Files to add:**
- `extensions/copilot/docs/monitoring/dev-collector/docker-compose.yaml`
- `extensions/copilot/docs/monitoring/dev-collector/otel-collector-config.yaml`

**Collector config** (sketch):

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
        cors:
          allowed_origins: ["*"]
          allowed_headers: ["*"]
      grpc:
        endpoint: 0.0.0.0:4317

processors:
  batch:
    timeout: 1s

exporters:
  otlphttp/jaeger:
    endpoint: http://jaeger:4318
  file/debug:
    path: /var/log/otel/spans.jsonl
    rotation:
      max_megabytes: 10

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/jaeger, file/debug]
```

**Docker compose**: Collector + Jaeger all-in-one. One `docker compose up`. UI on `http://localhost:16686`. OTLP on `http://localhost:4318`.

**Verification:** the `extensions/copilot/docs/monitoring/agent_monitoring.md` Quick Start switches its recommended endpoint from Aspire's to the Collector's. Aspire still works — you just point its OTLP exporter at the Collector instead of having apps point at Aspire directly.

### Phase 2 — Replace renderer span impl with the real OTel SDK

**Goal:** delete the hand-rolled span/exporter code in `chatTracingServiceImpl.ts`. Use `@opentelemetry/sdk-trace-web` + `@opentelemetry/exporter-trace-otlp-http`.

**Files:**
- `src/vs/workbench/contrib/chat/common/chatTracingService.ts` — interface stays the same shape (so call sites don't churn) but is now a thin façade over the SDK.
- `src/vs/workbench/contrib/chat/browser/chatTracingServiceImpl.ts` — rewrite. Dynamic-import the OTel packages so the bundle stays empty when disabled (same pattern the Copilot extension already uses for its own SDK, see `extensions/copilot/src/platform/otel/node/otelServiceImpl.ts`).

**Sketch:**

```ts
async function ensureSdk() {
  const [api, sdk, exporter, resources] = await Promise.all([
    import('@opentelemetry/api'),
    import('@opentelemetry/sdk-trace-web'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/resources'),
  ]);
  const provider = new sdk.WebTracerProvider({
    resource: resources.resourceFromAttributes({
      'service.name': 'vscode-workbench',
      'service.version': productService.version,
      'service.instance.id': sessionId,
    }),
    spanProcessors: [
      new sdk.BatchSpanProcessor(new exporter.OTLPTraceExporter({
        url: endpoint + '/v1/traces',
      })),
    ],
  });
  provider.register({ propagator: new api.W3CTraceContextPropagator() });
  return api.trace.getTracer('vscode.chat');
}
```

**Bundle impact when disabled:** zero. All packages are behind `await import()` and only resolved when `chat.experimental.devOTel.enabled === true`.

**Bundle impact when enabled:** ~80 KB gzipped, lazy-loaded once.

**What this fixes:**
- No more CORS workaround. The renderer's `OTLPTraceExporter` posts to the Collector, which has CORS on.
- No more bespoke exporter. We get retries, batching, exponential backoff, gzip, and trace flags handling for free.
- Future signals (metrics, logs) drop in by adding the corresponding SDK packages — no new exporter code.

### Phase 3 — Use `propagation.inject` / `extract` at the RPC boundary

**Files:**
- `src/vs/workbench/contrib/chat/common/participants/chatAgents.ts` — `IChatAgentRequest.traceContext` becomes `traceContext?: { traceparent: string; tracestate?: string }` (a W3C string, not a structured object).
- `src/vscode-dts/vscode.proposed.chatParticipantPrivate.d.ts` — same shape.
- `src/vs/workbench/contrib/chat/common/chatService/chatServiceImpl.ts` — replace the hand-built `{ traceId, spanId }` object with `propagation.inject(context.active(), carrier, setter)`.
- `extensions/copilot/src/extension/intents/node/toolCallingLoop.ts` — replace the manual `{ traceId, spanId, traceFlags }` parse with `propagation.extract(context.active(), carrier, getter)`. Pass the resulting context to `tracer.startActiveSpan(name, opts, parentContext, fn)`.

**Why a string and not a structured object:**

- `traceparent` is the wire format the OTel API expects. `inject`/`extract` produce/consume strings directly.
- Keeps the carrier opaque — if we ever switch propagators (B3, Jaeger), only this serialization changes.
- Aligns with the MCP `_meta.traceparent` field already in use (`extensions/copilot/src/extension/tools/vscode-node/toolsService.ts`).

**Code shape:**

```ts
// Renderer (sender)
const carrier: Record<string, string> = {};
api.propagation.inject(api.context.active(), carrier, {
  set: (c, k, v) => { c[k] = v as string; }
});
options.traceContext = { traceparent: carrier.traceparent, tracestate: carrier.tracestate };
```

```ts
// Ext host (receiver)
const ctx = api.propagation.extract(api.context.active(), request.traceContext ?? {}, {
  get: (c, k) => c?.[k],
  keys: c => Object.keys(c ?? {}),
});
return tracer.startActiveSpan(`invoke_agent ${name}`, opts, ctx, async span => { ... });
```

This replaces ~60 lines of bespoke `_createRemoteContext` / `getStoredTraceContext` plumbing with two SDK calls.

### Phase 4 — Adopt an async context manager (Node only)

**File:** `extensions/copilot/src/platform/otel/node/otelServiceImpl.ts`.

Add `@opentelemetry/context-async-hooks` and register `AsyncLocalStorageContextManager` once at SDK init. Result: any `await`/`then` chain inside an active span automatically inherits the parent context. Most of the manual `parentTraceContext` threading inside `toolCallingLoop` becomes unnecessary.

**Renderer side:** skip. `ZoneContextManager` works but pulls in zone.js (heavy and grumpy in Electron). Keep threading the active span explicitly through the few async boundaries that matter — what the current code already does with `submitSpan`.

### Phase 5 — Resource attributes & service naming

Standardize `service.name` across processes:

| Process | `service.name` | `service.namespace` |
|---|---|---|
| Workbench renderer | `vscode-workbench` | `vscode` |
| Extension host | `vscode-exthost` | `vscode` |
| Copilot extension spans (today: `copilot-chat`) | `copilot-chat` | `vscode` |
| Copilot CLI SDK | `github-copilot` | `vscode` |
| Claude Code subprocess | `claude-code` | `vscode` |

Plus on every process:
- `service.instance.id` = window id (so multi-window sessions don't collide)
- `service.version` = extension/product version
- `process.runtime.name` / `process.runtime.version`
- For renderer: `browser.brands` / `browser.platform` (helps when debugging web mode)

**Code change:** small additions to each SDK init site. Document the schema in a new `### Resource Attributes` section of `agent_monitoring.md`.

### Phase 6 — Sampling: 100% in dev, tail-based in prod (later)

For now: head-based 100% sampling in all processes. Trivial; nothing to do.

For a future production rollout: add a `tail_sampling` processor in the Collector that keeps:
- All errors
- Top 10% by latency
- 1% baseline

Apps stay sampling-on; the Collector decides what to drop. This is the standard pattern.

---

## 5. What Comes Off the Branch

Once Phases 1–3 land, delete:

- `github.copilot.chat._otelDevRelay` command in `extensions/copilot/src/extension/otel/vscode-node/otelContrib.ts`. No longer needed — the renderer talks to the Collector directly.
- The hand-rolled span class and OTLP JSON serialization in `src/vs/workbench/contrib/chat/browser/chatTracingServiceImpl.ts`. Replaced by the SDK.
- The `IChatRequestTraceContext` structured shape (`{ traceId, spanId, traceFlags?, traceState? }`). Replaced by the W3C string carrier.
- The `_createRemoteContext` helper in `extensions/copilot/src/platform/otel/node/otelServiceImpl.ts` if `propagation.extract` covers all callers.

Keep:
- The dev-only setting `chat.experimental.devOTel.enabled`. Renamed to `chat.experimental.tracing.enabled` to match its broader scope.
- The dev-only setting `chat.experimental.devOTel.endpoint`. Renamed to `chat.experimental.tracing.otlpEndpoint`.
- The `chat.submit` and `chat.dispatch` span names — they're useful and now real OTel spans.

---

## 6. Settings Surface (After Refactor)

| Setting | Type | Default | Description |
|---|---|---|---|
| `chat.experimental.tracing.enabled` | boolean | `false` | Enable workbench-side OTel tracing for the chat dispatch pipeline. Loads `@opentelemetry/sdk-trace-web` on demand. Off by default — zero overhead. |
| `chat.experimental.tracing.otlpEndpoint` | string | `http://localhost:4318` | OTLP/HTTP endpoint for workbench traces. Should point at an OTel Collector with CORS enabled. |

Together with the existing Copilot extension settings (`github.copilot.chat.otel.*`) you get the full picture: workbench spans + extension spans, all in one trace.

---

## 7. Verification Checklist

After each phase, manually verify:

| Check | How |
|---|---|
| Bundle size unchanged when disabled | `npm run gulp vscode-linux-x64-min`; compare `out-vscode/vs/workbench/workbench.js` size before vs after. SDK packages must not be in the chunk. |
| Renderer span exports work | Open Jaeger UI → service `vscode-workbench` → see `chat.submit` traces. |
| Cross-process trace stitches correctly | Send a chat message in agent mode → look for one trace with `chat.submit` → `chat.dispatch` → `invoke_agent` → `chat`/`execute_tool` children, spanning services `vscode-workbench` + `copilot-chat`. |
| CLI subagent linkage still works | Use a `runSubagent` tool → confirm subagent's `invoke_agent` is a child of parent's `execute_tool`. |
| MCP tool linkage still works | Configure an MCP server with its own OTel → see its spans nested under `execute_tool`. |
| Web mode (`code.sh --web`) | All of the above works in the browser, served by Code Server. CORS is the only renderer-specific concern; the Collector handles it. |
| Disable + reload | Spans stop. No hanging exporter, no console noise, no requests in the network tab. |

---

## 8. Risks & Open Questions

1. **Renderer bundle size.** ~80 KB gzipped lazy-loaded is acceptable for a dev-only feature. Confirm with a build before declaring done.
2. **OTel JS Web SDK version drift.** Stay on the same major as the Node SDK already pinned in `extensions/copilot/package.json`. Add to root `package.json` only behind a `dependencies` (not `devDependencies`) entry so it's tree-shakable.
3. **Async context in renderer.** We're not using `ZoneContextManager`, so any code path that awaits across a `chat.submit` span without holding the span object will lose the parent. Right now this only matters between `chat.submit` (renderer) and `chat.dispatch` (also renderer, in `ChatServiceImpl`) — and both have access to the span. Document the pattern: pass `IChatTraceSpan` explicitly through call chains in the renderer.
4. **Multi-window.** `service.instance.id` per window keeps traces isolated. Two windows submitting at once each produce their own root trace; that's correct.
5. **vscode.dev / web.** The renderer's OTLP exporter is just a `fetch`. As long as the Collector is reachable from the browser (which means a CORS-enabled deployment, not just localhost), this works unchanged. For the vscode.dev hosted experience we'd want a tunnel or a publicly-reachable Collector — out of scope for dev-only.
6. **Privacy.** Same rules as today: no content captured by default. The renderer's spans only carry chat location, mode, and agent name — no prompts, no file paths.

---

## 9. Out of Scope (Explicit Non-Goals)

- **Production telemetry.** This pipeline is dev-only and gated by an experimental setting.
- **Metrics from the renderer.** No use case yet; we have no renderer-side counters worth shipping. Add later if needed by including `@opentelemetry/sdk-metrics`.
- **Logs from the renderer.** Same — `ILogService` already has its own pipeline.
- **Replacing the existing Copilot OTel SDK.** It works, follows GenAI conventions, and is fine. We're only adding the renderer side and the cross-process glue.
- **Auto-instrumentation packages.** `@opentelemetry/auto-instrumentations-*` would add HTTP/fetch instrumentation but explodes bundle size. Not worth it for this feature.

---

## 10. Rollout Steps

1. Land Phase 1 (Collector + docker-compose) — independent, no app code change. Update `agent_monitoring.md` Quick Start to point at the Collector.
2. Land Phase 2 (renderer SDK) and Phase 3 (`propagation.inject/extract`) together in one PR. Behind the existing `chat.experimental.devOTel.enabled` setting (renamed to `chat.experimental.tracing.enabled`).
3. Land Phase 4 (async context manager) as an isolated PR for the extension side. No renderer change.
4. Land Phase 5 (resource attributes) as a docs + small code PR.
5. Phase 6 stays as a follow-up note in the doc; no code yet.

After Phase 3, the dev relay command and all the bespoke serialization on this branch get deleted in the same PR.

---

## Summary

Use one OTel SDK per process, propagate W3C trace context across boundaries via `propagation.inject` / `extract`, and route everything through a local OpenTelemetry Collector. This eliminates the CORS workaround, the bespoke span class, the structured trace-context object, and the cross-process IPC relay — and makes the feature work in vscode.dev, web mode, and any future process the chat pipeline grows into, without further plumbing.
