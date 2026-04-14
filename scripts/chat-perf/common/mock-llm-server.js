/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

/**
 * Local mock server that implements the OpenAI Chat Completions streaming API.
 * Used by the chat perf benchmark to replace the real LLM backend with
 * deterministic, zero-latency responses.
 *
 * Supports scenario-based responses: the `messages` array's last user message
 * content is matched against scenario IDs. Unknown scenarios get a default
 * text-only response.
 */

const http = require('http');
const { EventEmitter } = require('events');

// -- Scenario fixtures -------------------------------------------------------

/** @type {Record<string, string[]>} */
const SCENARIOS = {
	'text-only': [
		'Here is an explanation of the code you selected:\n\n',
		'The function `processItems` iterates over the input array and applies a transformation to each element. ',
		'It uses a `Map` to track previously seen values, which allows it to deduplicate results efficiently in O(n) time.\n\n',
		'The algorithm works in a single pass: for every element, it computes the transformed value, ',
		'checks membership in the set, and conditionally appends to the output array. ',
		'This is a common pattern in data processing pipelines where uniqueness constraints must be maintained.\n\n',
		'Edge cases to consider include empty arrays, duplicate transformations that produce the same key, ',
		'and items where the transform function itself is expensive.\n\n',
		'The time complexity is **O(n)** and the space complexity is **O(n)** in the worst case when all items are unique.\n',
	],
	'large-codeblock': [
		'Here is the refactored implementation:\n\n',
		'```typescript\n',
		'import { EventEmitter } from "events";\n\n',
		'interface CacheEntry<T> {\n  value: T;\n  expiresAt: number;\n  accessCount: number;\n}\n\n',
		'export class LRUCache<K, V> {\n',
		'  private readonly _map = new Map<K, CacheEntry<V>>();\n',
		'  private readonly _emitter = new EventEmitter();\n\n',
		'  constructor(\n    private readonly _maxSize: number,\n    private readonly _ttlMs: number = 60_000,\n  ) {}\n\n',
		'  get(key: K): V | undefined {\n    const entry = this._map.get(key);\n    if (!entry) { return undefined; }\n',
		'    if (Date.now() > entry.expiresAt) {\n      this._map.delete(key);\n      this._emitter.emit("evict", key);\n      return undefined;\n    }\n',
		'    entry.accessCount++;\n    this._map.delete(key);\n    this._map.set(key, entry);\n    return entry.value;\n  }\n\n',
		'  set(key: K, value: V): void {\n    if (this._map.size >= this._maxSize) {\n',
		'      const oldest = this._map.keys().next().value;\n      if (oldest !== undefined) {\n        this._map.delete(oldest);\n        this._emitter.emit("evict", oldest);\n      }\n    }\n',
		'    this._map.set(key, { value, expiresAt: Date.now() + this._ttlMs, accessCount: 0 });\n  }\n\n',
		'  clear(): void { this._map.clear(); this._emitter.emit("clear"); }\n',
		'  get size(): number { return this._map.size; }\n',
		'  onEvict(listener: (key: K) => void): void { this._emitter.on("evict", listener); }\n}\n',
		'```\n\n',
		'The key changes:\n- Added TTL-based expiry with configurable timeout\n- LRU eviction uses Map insertion order\n- EventEmitter notifies on evictions for cache observability\n',
	],
	'many-small-chunks': (() => {
		const chunks = ['Generating detailed analysis:\n\n'];
		for (let i = 0; i < 200; i++) {
			chunks.push(`Word${i} `);
		}
		chunks.push('\n\nAnalysis complete.\n');
		return chunks;
	})(),
	'mixed-content': [
		'## Issue Found\n\n',
		'The `DisposableStore` is not being disposed in the `deactivate` path, ',
		'which can lead to memory leaks.\n\n',
		'### Current Code\n\n',
		'```typescript\nclass MyService {\n  private store = new DisposableStore();\n  // missing dispose!\n}\n```\n\n',
		'### Suggested Fix\n\n',
		'```typescript\nclass MyService extends Disposable {\n',
		'  private readonly store = this._register(new DisposableStore());\n\n',
		'  override dispose(): void {\n    this.store.dispose();\n    super.dispose();\n  }\n}\n```\n\n',
		'This ensures the store is cleaned up when the service is disposed via the workbench lifecycle.\n',
	],

	// -- Stress-test scenarios --------------------------------------------

	// ~500 lines of code across 10 fenced blocks — stresses syntax
	// highlighting, code block rendering, and copy-button creation.
	'many-codeblocks': (() => {
		const chunks = ['Here are the implementations for each module:\n\n'];
		for (let i = 0; i < 10; i++) {
			chunks.push(`### Module ${i + 1}: \`handler${i}.ts\`\n\n`);
			chunks.push('```typescript\n');
			for (let j = 0; j < 15; j++) {
				chunks.push(`export function handle${i}_${j}(input: string): string {\n`);
				chunks.push(`  const result = input.trim().split('').reverse().join('');\n`);
				chunks.push(`  return \`[\${result}] processed by handler ${i}_${j}\`;\n`);
				chunks.push('}\n\n');
			}
			chunks.push('```\n\n');
		}
		chunks.push('All modules implement the same pattern with unique handler IDs.\n');
		return chunks;
	})(),

	// Very long prose — stresses markdown rendering, word wrapping,
	// and layout with ~3000 words of continuous text.
	'long-prose': (() => {
		const sentences = [
			'The architecture follows a layered dependency injection pattern where each service declares its dependencies through constructor parameters. ',
			'This approach ensures that circular dependencies are detected at compile time rather than at runtime, which significantly reduces debugging overhead. ',
			'When a service is instantiated, the instantiation service resolves all of its dependencies recursively, creating a directed acyclic graph of service instances. ',
			'Each service is a singleton within its scope, meaning that multiple consumers of the same service interface receive the same instance. ',
			'The workbench lifecycle manages the creation and disposal of these services through well-defined phases: creation, restoration, and eventual shutdown. ',
			'During the restoration phase, services that persist state across sessions reload their data from storage, which may involve asynchronous operations. ',
			'Contributors register their functionality through extension points, which are processed during the appropriate lifecycle phase. ',
			'This contribution model allows features to be added without modifying the core workbench code, maintaining a clean separation of concerns. ',
		];
		const chunks = ['# Detailed Architecture Analysis\n\n'];
		for (let para = 0; para < 15; para++) {
			chunks.push(`## Section ${para + 1}: ${['Overview', 'Design Patterns', 'Service Layer', 'Event System', 'State Management', 'Error Handling', 'Performance', 'Testing', 'Deployment', 'Monitoring', 'Security', 'Extensibility', 'Compatibility', 'Migration', 'Future Work'][para]}\n\n`);
			for (let s = 0; s < 25; s++) {
				chunks.push(sentences[s % sentences.length]);
			}
			chunks.push('\n\n');
		}
		return chunks;
	})(),

	// Deeply nested markdown — headers, ordered/unordered lists, bold,
	// italic, inline code, links, blockquotes. Exercises the full
	// markdown renderer pipeline.
	'rich-markdown': (() => {
		const chunks = ['# Comprehensive Code Review Report\n\n'];
		chunks.push('> **Summary**: Found 12 issues across 4 severity levels.\n\n');
		for (let section = 0; section < 6; section++) {
			chunks.push(`## ${section + 1}. ${['Critical Issues', 'Performance Concerns', 'Code Style', 'Documentation Gaps', 'Test Coverage', 'Security Review'][section]}\n\n`);
			for (let item = 0; item < 5; item++) {
				chunks.push(`${item + 1}. **Issue ${section * 5 + item + 1}**: \`${['useState', 'useEffect', 'useMemo', 'useCallback', 'useRef'][item]}\` in \`src/components/Widget${item}.tsx\`\n`);
				chunks.push(`   - Severity: ${['[Critical]', '[Warning]', '[Info]', '[Suggestion]', '[Note]'][item]}\n`);
				chunks.push(`   - The current implementation uses *unnecessary re-renders* due to missing dependency arrays.\n`);
				chunks.push(`   - See [React docs](https://react.dev/reference) and the [\`useMemo\` guide](https://react.dev/reference/react/useMemo).\n`);
				chunks.push(`   - Fix: wrap in \`useCallback\` or extract to a ***separate memoized component***.\n\n`);
			}
			chunks.push('---\n\n');
		}
		chunks.push('> *Report generated automatically. Please review all suggestions before applying.*\n');
		return chunks;
	})(),

	// A huge single code block (~200 lines) — stresses the syntax
	// highlighter and scroll virtualization within a code block.
	'giant-codeblock': (() => {
		const chunks = ['Here is the complete implementation:\n\n```typescript\n'];
		chunks.push('import { Disposable, DisposableStore } from "vs/base/common/lifecycle";\n');
		chunks.push('import { Emitter, Event } from "vs/base/common/event";\n');
		chunks.push('import { URI } from "vs/base/common/uri";\n\n');
		for (let i = 0; i < 40; i++) {
			chunks.push(`export class Service${i} extends Disposable {\n`);
			chunks.push(`  private readonly _onDidChange = this._register(new Emitter<void>());\n`);
			chunks.push(`  readonly onDidChange: Event<void> = this._onDidChange.event;\n\n`);
			chunks.push(`  private _value: string = '';\n`);
			chunks.push(`  get value(): string { return this._value; }\n\n`);
			chunks.push(`  async update(uri: URI): Promise<void> {\n`);
			chunks.push(`    this._value = uri.toString();\n`);
			chunks.push(`    this._onDidChange.fire();\n`);
			chunks.push(`  }\n`);
			chunks.push('}\n\n');
		}
		chunks.push('```\n\nThis defines 40 service classes following the standard VS Code pattern.\n');
		return chunks;
	})(),

	// 1000 very small chunks — stresses the streaming SSE pipeline
	// and incremental DOM updates with high chunk frequency.
	'rapid-stream': (() => {
		const chunks = [];
		for (let i = 0; i < 1000; i++) {
			chunks.push(`w${i} `);
		}
		return chunks;
	})(),

	// Many file URI references — stresses link detection, file
	// resolution, path rendering, hover providers, and inline
	// anchor widget creation.
	'file-links': (() => {
		const files = [
			'src/vs/workbench/contrib/chat/browser/chatListRenderer.ts',
			'src/vs/workbench/contrib/chat/common/chatService/chatServiceImpl.ts',
			'src/vs/workbench/contrib/chat/browser/widget/input/chatInputPart.ts',
			'src/vs/workbench/contrib/chat/common/chatPerf.ts',
			'src/vs/base/common/lifecycle.ts',
			'src/vs/base/common/event.ts',
			'src/vs/platform/instantiation/common/instantiation.ts',
			'src/vs/workbench/services/extensions/common/abstractExtensionService.ts',
			'src/vs/workbench/api/common/extHostLanguageModels.ts',
			'src/vs/workbench/contrib/chat/common/languageModels.ts',
			'src/vs/editor/browser/widget/codeEditor/editor.ts',
			'src/vs/workbench/browser/parts/editor/editorGroupView.ts',
		];
		const chunks = ['I found references to the disposable pattern across the following files:\n\n'];
		for (let i = 0; i < files.length; i++) {
			const line = Math.floor(Math.random() * 500) + 1;
			chunks.push(`${i + 1}. [${files[i]}](${files[i]}#L${line}) — `);
			chunks.push(`Line ${line}: uses \`DisposableStore\` with ${Math.floor(Math.random() * 10) + 1} registrations\n`);
		}
		chunks.push('\nAdditionally, the following files import from `vs/base/common/lifecycle`:\n\n');
		for (let i = 0; i < 20; i++) {
			const depth = ['base', 'platform', 'editor', 'workbench'][i % 4];
			const area = ['common', 'browser', 'node', 'electron-browser'][i % 4];
			const name = ['service', 'provider', 'contribution', 'handler', 'manager'][i % 5];
			const file = `src/vs/${depth}/${area}/${name}${i}.ts`;
			chunks.push(`- [${file}](${file}#L${i * 10 + 5})`);
			chunks.push(` — imports \`Disposable\`, \`DisposableStore\`\n`);
		}
		chunks.push('\nTotal: 32 files reference the disposable pattern.\n');
		return chunks;
	})(),
};

const DEFAULT_SCENARIO = 'text-only';

// -- SSE chunk builder -------------------------------------------------------

const MODEL = 'gpt-4o-2024-08-06';

/**
 * @param {string} content
 * @param {number} index
 * @param {boolean} finish
 */
function makeChunk(content, index, finish) {
	return {
		id: 'chatcmpl-perf-benchmark',
		object: 'chat.completion.chunk',
		created: Math.floor(Date.now() / 1000),
		model: MODEL,
		choices: [{
			index: 0,
			delta: finish ? {} : { content },
			finish_reason: finish ? 'stop' : null,
			content_filter_results: {},
		}],
		usage: null,
	};
}

function makeInitialChunk() {
	return {
		id: 'chatcmpl-perf-benchmark',
		object: 'chat.completion.chunk',
		created: Math.floor(Date.now() / 1000),
		model: MODEL,
		choices: [{
			index: 0,
			delta: { role: 'assistant', content: '' },
			finish_reason: null,
			content_filter_results: {},
		}],
		usage: null,
	};
}

// -- Request handler ---------------------------------------------------------

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
function handleRequest(req, res) {
	const contentLength = req.headers['content-length'] || '0';
	const ts = new Date().toISOString().slice(11, -1); // HH:MM:SS.mmm
	console.log(`[mock-llm] ${ts} ${req.method} ${req.url} (${contentLength} bytes)`);

	// CORS
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', '*');
	if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

	const url = new URL(req.url || '/', `http://${req.headers.host}`);
	const path = url.pathname;
	const json = (/** @type {number} */ status, /** @type {any} */ data) => {
		res.writeHead(status, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(data));
	};
	const readBody = () => new Promise(resolve => {
		let body = '';
		req.on('data', chunk => { body += chunk; });
		req.on('end', () => resolve(body));
	});

	// -- Health -------------------------------------------------------
	if (path === '/health') { res.writeHead(200); res.end('ok'); return; }

	// -- Token endpoints (DomainService.tokenURL / tokenNoAuthURL) ----
	// /copilot_internal/v2/token, /copilot_internal/v2/nltoken
	if (path.startsWith('/copilot_internal/')) {
		if (path.includes('/token') || path.includes('/nltoken')) {
			json(200, {
				token: 'perf-benchmark-fake-token',
				expires_at: Math.floor(Date.now() / 1000) + 3600,
				refresh_in: 1800,
				sku: 'free_limited_copilot',
				individual: true,
				copilot_plan: 'free',
				endpoints: {
					api: `http://${req.headers.host}`,
					proxy: `http://${req.headers.host}`,
				},
			});
		} else {
			// /copilot_internal/user, /copilot_internal/content_exclusion, etc.
			json(200, {});
		}
		return;
	}

	// -- Telemetry (DomainService.telemetryURL) ----------------------
	if (path === '/telemetry') { json(200, {}); return; }

	// -- Model Router (DomainService.capiModelRouterURL = /models/session/intent) --
	// The automode service POSTs here to get the best model for a request.
	if (path === '/models/session/intent' && req.method === 'POST') {
		readBody().then(() => {
			json(200, { model: MODEL });
		});
		return;
	}

	// -- Auto Models / Model Session (DomainService.capiAutoModelURL = /models/session) --
	// Returns AutoModeAPIResponse: { available_models, session_token, expires_at }
	if (path === '/models/session' && req.method === 'POST') {
		readBody().then(() => {
			json(200, {
				available_models: [MODEL, 'gpt-4o-mini'],
				session_token: 'perf-session-token-' + Date.now(),
				expires_at: Math.floor(Date.now() / 1000) + 3600,
				discounted_costs: {},
			});
		});
		return;
	}

	// -- Models (DomainService.capiModelsURL = /models) --------------
	if (path === '/models' && req.method === 'GET') {
		json(200, {
			data: [
				{
					id: MODEL,
					name: 'GPT-4o (Mock)',
					version: '2024-05-13',
					vendor: 'copilot',
					model_picker_enabled: true,
					is_chat_default: true,
					is_chat_fallback: true,
					billing: { is_premium: false, multiplier: 0 },
					capabilities: {
						type: 'chat',
						family: 'gpt-4o',
						tokenizer: 'o200k_base',
						limits: {
							max_prompt_tokens: 128000,
							max_output_tokens: 16384,
							max_context_window_tokens: 128000,
						},
						supports: {
							streaming: true,
							tool_calls: true,
							parallel_tool_calls: true,
							vision: false,
						},
					},
					supported_endpoints: ['/chat/completions'],
				},
				{
					id: 'gpt-4o-mini',
					name: 'GPT-4o mini (Mock)',
					version: '2024-07-18',
					vendor: 'copilot',
					model_picker_enabled: false,
					is_chat_default: false,
					is_chat_fallback: false,
					billing: { is_premium: false, multiplier: 0 },
					capabilities: {
						type: 'chat',
						family: 'gpt-4o-mini',
						tokenizer: 'o200k_base',
						limits: {
							max_prompt_tokens: 128000,
							max_output_tokens: 16384,
							max_context_window_tokens: 128000,
						},
						supports: {
							streaming: true,
							tool_calls: true,
							parallel_tool_calls: true,
							vision: false,
						},
					},
					supported_endpoints: ['/chat/completions'],
				},
			],
		});
		return;
	}

	// -- Model by ID (DomainService.capiModelsURL/{id}) --------------
	if (path.startsWith('/models/') && req.method === 'GET') {
		const modelId = path.split('/models/')[1]?.split('/')[0];
		if (path.endsWith('/policy')) {
			json(200, { state: 'accepted', terms: '' });
			return;
		}
		json(200, {
			id: modelId || MODEL,
			name: 'GPT-4o (Mock)',
			version: '2024-05-13',
			vendor: 'copilot',
			model_picker_enabled: true,
			is_chat_default: true,
			is_chat_fallback: true,
			capabilities: {
				type: 'chat',
				family: 'gpt-4o',
				tokenizer: 'o200k_base',
				limits: { max_prompt_tokens: 128000, max_output_tokens: 16384, max_context_window_tokens: 128000 },
				supports: { streaming: true, tool_calls: true, parallel_tool_calls: true, vision: false },
			},
		});
		return;
	}

	// -- Agents (DomainService.remoteAgentsURL = /agents) -------------
	if (path.startsWith('/agents')) {
		// /agents/sessions — CopilotSessions
		if (path.includes('/sessions')) {
			json(200, { sessions: [], total_count: 0, page_size: 20, page_number: 1 });
		}
		// /agents/swe/models — CCAModelsList
		else if (path.includes('/swe/models')) {
			json(200, {
				data: [{
					id: MODEL, name: 'GPT-4o (Mock)', vendor: 'copilot',
					capabilities: { type: 'chat', family: 'gpt-4o', supports: { streaming: true } }
				}]
			});
		}
		// /agents/swe/... — agent jobs, etc.
		else if (path.includes('/swe/')) {
			json(200, {});
		}
		// /agents — list agents
		else {
			json(200, { agents: [] });
		}
		return;
	}

	// -- Chat Completions (DomainService.capiChatURL = /chat/completions) --
	if (path === '/chat/completions' && req.method === 'POST') {
		readBody().then((/** @type {string} */ body) => handleChatCompletions(body, res));
		return;
	}

	// -- Responses API (DomainService.capiResponsesURL = /responses) --
	if (path === '/responses' && req.method === 'POST') {
		readBody().then((/** @type {string} */ body) => handleChatCompletions(body, res));
		return;
	}

	// -- Messages API (DomainService.capiMessagesURL = /v1/messages) --
	if (path === '/v1/messages' && req.method === 'POST') {
		readBody().then((/** @type {string} */ body) => handleChatCompletions(body, res));
		return;
	}

	// -- Proxy completions (/v1/engines/*/completions) ----------------
	if (path.includes('/v1/engines/') && req.method === 'POST') {
		readBody().then((/** @type {string} */ body) => handleChatCompletions(body, res));
		return;
	}

	// -- Skills, Search, Embeddings -----------------------------------
	if (path === '/skills' || path.startsWith('/search/') || path.startsWith('/embeddings')) {
		json(200, { data: [] });
		return;
	}

	// -- Catch-all: any remaining POST with messages → chat completions
	if (req.method === 'POST') {
		readBody().then((/** @type {string} */ body) => {
			try {
				const parsed = JSON.parse(/** @type {string} */(body));
				if (parsed.messages && Array.isArray(parsed.messages)) {
					handleChatCompletions(/** @type {string} */(body), res);
					return;
				}
			} catch { }
			json(200, {});
		});
		return;
	}

	// -- Catch-all GET → empty success --------------------------------
	json(200, {});
}

// -- Server lifecycle --------------------------------------------------------

/** Emitted when a scenario chat completion is fully served. */
const serverEvents = new EventEmitter();

/**
 * @param {string} body
 * @param {http.ServerResponse} res
 */
function handleChatCompletions(body, res) {
	let scenarioId = DEFAULT_SCENARIO;
	let isScenarioRequest = false;
	try {
		const parsed = JSON.parse(body);
		const messages = parsed.messages || [];
		// Log user messages for debugging
		const userMsgs = messages.filter((/** @type {any} */ m) => m.role === 'user');
		if (userMsgs.length > 0) {
			const lastContent = typeof userMsgs[userMsgs.length - 1].content === 'string'
				? userMsgs[userMsgs.length - 1].content.substring(0, 100)
				: '(structured)';
			const ts = new Date().toISOString().slice(11, -1);
			console.log(`[mock-llm]   ${ts} → ${messages.length} msgs, last user: "${lastContent}"`);
		}
		const lastUser = [...messages].reverse().find((/** @type {any} */ m) => m.role === 'user');
		if (lastUser) {
			// Extract scenario ID from user message content
			const content = typeof lastUser.content === 'string'
				? lastUser.content
				: Array.isArray(lastUser.content)
					? lastUser.content.map((/** @type {any} */ c) => c.text || '').join('')
					: '';
			const match = content.match(/\[scenario:([^\]]+)\]/);
			if (match && SCENARIOS[match[1]]) {
				scenarioId = match[1];
				isScenarioRequest = true;
			}
		}
	} catch { }

	const chunks = SCENARIOS[scenarioId] || SCENARIOS[DEFAULT_SCENARIO];

	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive',
		'X-Request-Id': 'perf-benchmark-' + Date.now(),
	});

	// Initial role chunk
	res.write(`data: ${JSON.stringify(makeInitialChunk())}\n\n`);

	// Content chunks
	for (const chunk of chunks) {
		res.write(`data: ${JSON.stringify(makeChunk(chunk, 0, false))}\n\n`);
	}

	// Finish chunk
	res.write(`data: ${JSON.stringify(makeChunk('', 0, true))}\n\n`);

	// Done
	res.write('data: [DONE]\n\n');
	res.end();

	if (isScenarioRequest) {
		serverEvents.emit('scenarioCompletion');
	}
}

/**
 * Start the mock server and return a handle.
 * @param {number} port
 */
function startServer(port = 0) {
	return new Promise((resolve, reject) => {
		let reqCount = 0;
		let completions = 0;
		/** @type {Array<() => boolean>} */
		let requestWaiters = [];
		/** @type {Array<() => boolean>} */
		let completionWaiters = [];

		serverEvents.on('scenarioCompletion', () => {
			completions++;
			completionWaiters = completionWaiters.filter(fn => !fn());
		});

		const server = http.createServer((req, res) => {
			reqCount++;
			requestWaiters = requestWaiters.filter(fn => !fn());
			handleRequest(req, res);
		});
		server.listen(port, '127.0.0.1', () => {
			const addr = server.address();
			const actualPort = typeof addr === 'object' && addr ? addr.port : port;
			const url = `http://127.0.0.1:${actualPort}`;
			resolve({
				port: actualPort,
				url,
				close: () => /** @type {Promise<void>} */(new Promise((resolve, reject) => {
					server.close(err => err ? reject(err) : resolve(undefined));
				})),
				/** Return total request count. */
				requestCount: () => reqCount,
				/**
				 * Wait until at least `n` requests have been received.
				 * @param {number} n
				 * @param {number} timeoutMs
				 * @returns {Promise<void>}
				 */
				waitForRequests: (n, timeoutMs) => new Promise((resolve, reject) => {
					if (reqCount >= n) { resolve(); return; }
					const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${n} requests (got ${reqCount})`)), timeoutMs);
					requestWaiters.push(() => {
						if (reqCount >= n) { clearTimeout(timer); resolve(); return true; }
						return false;
					});
				}),
				/** Return total scenario-completion count. */
				completionCount: () => completions,
				/**
				 * Wait until at least `n` scenario chat completions have been served.
				 * @param {number} n
				 * @param {number} timeoutMs
				 * @returns {Promise<void>}
				 */
				waitForCompletion: (n, timeoutMs) => new Promise((resolve, reject) => {
					if (completions >= n) { resolve(); return; }
					const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${n} completions (got ${completions})`)), timeoutMs);
					completionWaiters.push(() => {
						if (completions >= n) { clearTimeout(timer); resolve(); return true; }
						return false;
					});
				}),
			});
		});
		server.on('error', reject);
	});
}

// Allow running standalone for testing: node scripts/mock-llm-server.js
if (require.main === module) {
	const port = parseInt(process.argv[2] || '0', 10);
	startServer(port).then((/** @type {any} */ handle) => {
		console.log(`Mock LLM server listening at ${handle.url}`);
		console.log('Scenarios:', Object.keys(SCENARIOS).join(', '));
	});
}

module.exports = { startServer, SCENARIOS };
