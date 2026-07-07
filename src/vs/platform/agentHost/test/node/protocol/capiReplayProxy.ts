/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A record/replay HTTP proxy for the CAPI (Copilot API) traffic that the agent
 * host's bundled Copilot SDK/CLI produces.
 *
 * It sits in front of an upstream CAPI-speaking server (either the in-repo mock
 * LLM server or, when recording with a real token, real CAPI) and:
 *
 *  - **record** mode: forwards every request to the upstream, streams the
 *    response back to the caller, and captures the raw response bytes to a
 *    JSON fixture on disk.
 *  - **replay** mode: serves recorded responses from the fixture with no
 *    upstream contact at all — deterministic and token-free.
 *  - **auto** mode (default): replays when a fixture exists, otherwise records
 *    one (mirrors the CLI e2e harness workflow). This is self-healing: a
 *    missing fixture records instead of failing, so the suite stays green
 *    before fixtures are committed. When replaying a committed fixture, a
 *    request with no recorded response is a strict cache miss (fails the run).
 *
 * The proxy is intentionally **wire-agnostic**: it captures and replays the raw
 * response body, so it works identically for the Chat Completions
 * (`/chat/completions`), Responses (`/responses`) and Anthropic Messages
 * (`/v1/messages`) SSE dialects without needing per-dialect adapters.
 *
 * Matching is **sequence-based per `(method, path)`**: the Nth request to a
 * given endpoint replays the Nth recorded response. In replay the agent's
 * behavior is driven entirely by the recorded responses, so the sequence of
 * calls it makes is reproduced exactly — making exact-body matching (which is
 * brittle against volatile fields like dates or request ids) unnecessary. The
 * normalized request body is still stored in the fixture for reviewability.
 */

import type * as http from 'http';
import type * as https from 'https';
import { createRequire } from 'module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from '../../../../../base/common/path.js';

// `http`/`https` are lazily required (they are slow to load and direct value
// imports are disallowed in this layer); the `import type` above still gives us
// their types for annotations.
const nodeRequire = createRequire(import.meta.url);
const httpModule = nodeRequire('http') as typeof http;
const httpsModule = nodeRequire('https') as typeof https;

/** Model-producing endpoints. Replaying past the recorded count here is a hard
 * cache miss (reusing a stale turn could spin the agent loop forever), whereas
 * idempotent endpoints (`/models`, token) may be safely re-served. */
const MODEL_ENDPOINTS = new Set(['/chat/completions', '/responses', '/v1/messages']);

const WORKDIR_PLACEHOLDER = '${workdir}';
const HOMEDIR_PLACEHOLDER = '${homedir}';
/**
 * Placeholder for the upstream CAPI origin in recorded response bodies. The
 * mock LLM server echoes its own host into token responses (`endpoints.api`);
 * rewriting that origin to this placeholder — and back to the proxy's own URL
 * on replay — keeps the SDK pointed at the proxy across token refreshes rather
 * than at a mock port that no longer exists.
 */
const CAPI_PLACEHOLDER = '${capi}';

export type CapiReplayMode = 'auto' | 'record' | 'replay';

interface IRecordedResponse {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
}

interface IRecordedExchange {
	readonly method: string;
	readonly path: string;
	/** Normalized request body, stored for human review of fixture diffs. */
	readonly requestBody: string;
	readonly response: IRecordedResponse;
}

interface IFixture {
	readonly version: 1;
	readonly exchanges: IRecordedExchange[];
}

export interface ICapiReplayProxyOptions {
	/** Absolute path to the JSON fixture for this test. */
	readonly fixturePath: string;
	/** Upstream base URL to forward to while recording (e.g. the mock LLM server). */
	readonly upstreamUrl: string;
	/** Recording/replay behavior. Defaults to `auto`. */
	readonly mode?: CapiReplayMode;
	/** Absolute working directory to normalize out of request bodies. */
	readonly workDir?: string;
	/** Absolute home directory to normalize out of request bodies. */
	readonly homeDir?: string;
	/**
	 * Fail (throw from {@link stop}) if any request missed the cache while
	 * replaying. Defaults to true. Ignored while recording.
	 */
	readonly strict?: boolean;
}

/** Sequence cursor for one `(method, path)` bucket during replay. */
interface IReplayBucket {
	readonly responses: IRecordedResponse[];
	index: number;
}

export class CapiReplayProxy {
	private _server: http.Server | undefined;
	private _url: string | undefined;
	private _stopped = false;

	private readonly _mode: CapiReplayMode;
	private readonly _strict: boolean;
	private readonly _isReplaying: boolean;

	/** Buckets used for replay, keyed by `${method} ${path}`. */
	private readonly _replayBuckets = new Map<string, IReplayBucket>();
	/** Exchanges captured during recording, in arrival order. */
	private readonly _recorded: IRecordedExchange[] = [];
	private readonly _cacheMisses: string[] = [];

	constructor(private readonly _options: ICapiReplayProxyOptions) {
		const fixtureExists = existsSync(_options.fixturePath);
		this._mode = _options.mode ?? 'auto';
		this._strict = _options.strict ?? true;

		if (this._mode === 'replay' && !fixtureExists) {
			throw new Error(`[capi-replay] replay mode requires a fixture but none exists at ${_options.fixturePath}`);
		}

		// `auto` replays a committed fixture when present, otherwise records one
		// by proxying the upstream (self-healing, so a missing fixture never
		// breaks the run — it just records instead of replaying).
		this._isReplaying = this._mode === 'replay' || (this._mode === 'auto' && fixtureExists);
		if (this._isReplaying) {
			this._loadFixture();
		}
	}

	/** Base URL the agent host should be pointed at. Available after {@link start}. */
	get url(): string {
		if (!this._url) {
			throw new Error('[capi-replay] proxy not started');
		}
		return this._url;
	}

	get isReplaying(): boolean {
		return this._isReplaying;
	}

	async start(): Promise<string> {
		this._server = httpModule.createServer((req, res) => this._handle(req, res));
		return new Promise((resolve, reject) => {
			this._server!.on('error', reject);
			this._server!.listen(0, '127.0.0.1', () => {
				const addr = this._server!.address();
				if (addr && typeof addr === 'object') {
					this._url = `http://127.0.0.1:${addr.port}`;
					resolve(this._url);
				} else {
					reject(new Error('[capi-replay] failed to determine proxy address'));
				}
			});
		});
	}

	/**
	 * Stop the proxy. When recording, flushes captured exchanges to the fixture.
	 * When replaying in strict mode, throws if any request missed the cache.
	 */
	async stop(): Promise<void> {
		if (this._stopped) {
			return;
		}
		this._stopped = true;
		const server = this._server;
		this._server = undefined;
		if (server) {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}

		if (this._isReplaying) {
			if (this._strict && this._cacheMisses.length > 0) {
				throw new Error(`[capi-replay] ${this._cacheMisses.length} cache miss(es):\n${this._cacheMisses.join('\n')}`);
			}
			return;
		}

		if (this._recorded.length > 0) {
			this._writeFixture();
		}
	}

	// -- request handling -----------------------------------------------------

	private _handle(req: http.IncomingMessage, res: http.ServerResponse): void {
		const chunks: Buffer[] = [];
		req.on('data', chunk => chunks.push(chunk));
		req.on('end', () => {
			const body = Buffer.concat(chunks).toString('utf8');
			if (this._isReplaying) {
				this._replay(req, body, res);
			} else {
				this._record(req, body, res);
			}
		});
		req.on('error', () => this._fail(res, 'request stream error'));
	}

	private _replay(req: http.IncomingMessage, body: string, res: http.ServerResponse): void {
		const method = req.method ?? 'GET';
		const path = new URL(req.url ?? '/', 'http://localhost').pathname;
		const key = `${method} ${path}`;
		const bucket = this._replayBuckets.get(key);

		let recorded: IRecordedResponse | undefined;
		if (bucket) {
			if (bucket.index < bucket.responses.length) {
				recorded = bucket.responses[bucket.index++];
			} else if (!MODEL_ENDPOINTS.has(path)) {
				// Idempotent endpoint called more often than recorded — re-serve
				// the last recorded response rather than failing.
				recorded = bucket.responses[bucket.responses.length - 1];
			}
		}

		if (!recorded) {
			this._cacheMisses.push(`${key} (call #${(bucket?.index ?? 0) + 1}) — no recorded response`);
			this._fail(res, `no recorded response for ${key}`);
			return;
		}

		const headers = { ...recorded.headers };
		// Let Node recompute framing for the exact recorded body.
		delete headers['content-length'];
		delete headers['transfer-encoding'];
		res.writeHead(recorded.status, headers);
		res.end(replaceAll(recorded.body, CAPI_PLACEHOLDER, this.url));
	}

	private _record(req: http.IncomingMessage, body: string, res: http.ServerResponse): void {
		const method = req.method ?? 'GET';
		const path = new URL(req.url ?? '/', 'http://localhost').pathname;
		const upstream = new URL(req.url ?? '/', this._options.upstreamUrl);
		const isHttps = upstream.protocol === 'https:';
		const transport = isHttps ? httpsModule : httpModule;

		const forwardHeaders = { ...req.headers };
		forwardHeaders.host = upstream.host;
		delete forwardHeaders['connection'];
		delete forwardHeaders['content-length'];

		const upstreamReq = transport.request(
			{
				hostname: upstream.hostname,
				port: upstream.port || (isHttps ? 443 : 80),
				path: upstream.pathname + upstream.search,
				method,
				headers: forwardHeaders,
			},
			upstreamRes => {
				const respChunks: Buffer[] = [];
				const status = upstreamRes.statusCode ?? 502;
				const headers = flattenHeaders(upstreamRes.headers);
				res.writeHead(status, headers);
				upstreamRes.on('data', chunk => {
					respChunks.push(chunk);
					res.write(chunk);
				});
				upstreamRes.on('end', () => {
					res.end();
					const rawBody = Buffer.concat(respChunks).toString('utf8');
					this._recorded.push({
						method,
						path,
						requestBody: this._normalize(body),
						response: { status, headers, body: replaceAll(rawBody, new URL(this._options.upstreamUrl).origin, CAPI_PLACEHOLDER) },
					});
				});
			},
		);
		upstreamReq.on('error', err => this._fail(res, `upstream error: ${err instanceof Error ? err.message : String(err)}`));
		if (body) {
			upstreamReq.write(body);
		}
		upstreamReq.end();
	}

	private _fail(res: http.ServerResponse, message: string): void {
		if (!res.headersSent) {
			// `x-should-retry: false` mirrors the CLI proxy so the SDK does not
			// hammer a missing fixture with retries.
			res.writeHead(500, { 'content-type': 'text/plain', 'x-should-retry': 'false' });
		}
		res.end(`[capi-replay] ${message}`);
	}

	// -- fixture I/O ----------------------------------------------------------

	private _loadFixture(): void {
		const fixture = JSON.parse(readFileSync(this._options.fixturePath, 'utf8')) as IFixture;
		for (const exchange of fixture.exchanges) {
			const key = `${exchange.method} ${exchange.path}`;
			let bucket = this._replayBuckets.get(key);
			if (!bucket) {
				bucket = { responses: [], index: 0 };
				this._replayBuckets.set(key, bucket);
			}
			bucket.responses.push(exchange.response);
		}
	}

	private _writeFixture(): void {
		const fixture: IFixture = { version: 1, exchanges: this._recorded };
		mkdirSync(dirname(this._options.fixturePath), { recursive: true });
		writeFileSync(this._options.fixturePath, JSON.stringify(fixture, null, '\t') + '\n');
	}

	private _normalize(text: string): string {
		let result = text;
		if (this._options.workDir) {
			result = replaceAll(result, this._options.workDir, WORKDIR_PLACEHOLDER);
		}
		if (this._options.homeDir) {
			result = replaceAll(result, this._options.homeDir, HOMEDIR_PLACEHOLDER);
		}
		return result;
	}
}

function replaceAll(text: string, search: string, replacement: string): string {
	if (!search) {
		return text;
	}
	return text.split(search).join(replacement);
}

function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (value === undefined) {
			continue;
		}
		result[key] = Array.isArray(value) ? value.join(', ') : value;
	}
	return result;
}
