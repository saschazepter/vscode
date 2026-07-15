/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { McpServerType, type IMcpServerConfiguration } from '../../../mcp/common/mcpPlatformTypes.js';
import { McpServerStatus, type McpServerState } from '../../common/state/protocol/channels-session/state.js';
import type { ISdkMcpServer } from '../shared/mcpCustomizationController.js';
import type { McpServerStartupState } from './protocol/generated/v2/McpServerStartupState.js';
import type { McpServerStatus as CodexMcpServerStatus } from './protocol/generated/v2/McpServerStatus.js';
import type { Resource } from './protocol/generated/Resource.js';
import type { ResourceTemplate } from './protocol/generated/ResourceTemplate.js';
import type { Tool } from './protocol/generated/Tool.js';

/**
 * Cached inventory entry for a single MCP server reported by the codex
 * app-server. {@link state} drives the AHP customization surface while
 * {@link tools} / {@link resources} / {@link resourceTemplates} back the
 * read-only `tools/list`, `resources/list` and `resources/templates/list`
 * MCP methods so the host can answer them from cache without
 * round-tripping to codex.
 */
export interface ICodexMcpServerEntry {
	readonly state: McpServerState;
	readonly tools: readonly Tool[];
	readonly resources: readonly Resource[];
	readonly resourceTemplates: readonly ResourceTemplate[];
}

/**
 * Translates a codex `mcpServer/startupStatus/updated` lifecycle state
 * into the AHP {@link McpServerState} union.
 *
 * V1 scope: codex's auth states are not surfaced as
 * {@link McpServerStatus.AuthRequired}; a connected server is reported as
 * {@link McpServerStatus.Ready} regardless of `authStatus`.
 */
export function translateCodexMcpStartupState(status: McpServerStartupState, error: string | null | undefined): McpServerState {
	switch (status) {
		case 'ready':
			return { kind: McpServerStatus.Ready };
		case 'starting':
			return { kind: McpServerStatus.Starting };
		case 'failed':
			return {
				kind: McpServerStatus.Error,
				error: { errorType: 'mcp-server-failed', message: error ?? 'MCP server failed to start' },
			};
		case 'cancelled':
			return { kind: McpServerStatus.Stopped };
		default:
			return { kind: McpServerStatus.Stopped };
	}
}

/**
 * Flattens the codex `McpServerStatus.tools` map (`{ [name]: Tool }`)
 * into a name-sorted array, dropping any holes the map type allows.
 */
export function codexToolMapToArray(tools: CodexMcpServerStatus['tools']): Tool[] {
	const out: Tool[] = [];
	for (const key of Object.keys(tools)) {
		const tool = tools[key];
		if (tool) {
			out.push(tool);
		}
	}
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}

/**
 * Builds an {@link ICodexMcpServerEntry} from a codex `mcpServerStatus/list`
 * entry. Servers returned by `mcpServerStatus/list` are connected and
 * serving, so they map to {@link McpServerStatus.Ready}.
 */
export function codexMcpStatusToEntry(status: CodexMcpServerStatus): ICodexMcpServerEntry {
	return {
		state: { kind: McpServerStatus.Ready },
		tools: codexToolMapToArray(status.tools),
		resources: status.resources,
		resourceTemplates: status.resourceTemplates,
	};
}

/**
 * Builds a name-keyed inventory snapshot from a codex `mcpServerStatus/list`
 * response page (or the concatenation of all paginated pages).
 */
export function codexMcpListToInventory(data: readonly CodexMcpServerStatus[]): Map<string, ICodexMcpServerEntry> {
	const inventory = new Map<string, ICodexMcpServerEntry>();
	for (const status of data) {
		inventory.set(status.name, codexMcpStatusToEntry(status));
	}
	return inventory;
}

/**
 * Projects an inventory snapshot to the SDK-neutral
 * {@link ISdkMcpServer} list the {@link McpCustomizationController}
 * consumes (name + state only — tool/resource payloads stay in the
 * inventory and back {@link buildCodexMcpReadResult}).
 */
export function inventoryToSdkServers(inventory: ReadonlyMap<string, ICodexMcpServerEntry>): ISdkMcpServer[] {
	const out: ISdkMcpServer[] = [];
	for (const [name, entry] of inventory) {
		out.push({ name, state: entry.state });
	}
	return out;
}

/**
 * Answers the read-only MCP methods (`tools/list`, `resources/list`,
 * `resources/templates/list`) from a cached inventory entry without a
 * round-trip to codex. Returns `{ handled: false }` for any other method
 * so the caller can forward it as an RPC (`tools/call`, `resources/read`)
 * or reject it.
 */
export function buildCodexMcpReadResult(method: string, entry: ICodexMcpServerEntry): { readonly handled: true; readonly result: unknown } | { readonly handled: false } {
	switch (method) {
		case 'tools/list':
			return { handled: true, result: { tools: entry.tools } };
		case 'resources/list':
			return { handled: true, result: { resources: entry.resources } };
		case 'resources/templates/list':
			return { handled: true, result: { resourceTemplates: entry.resourceTemplates } };
		default:
			return { handled: false };
	}
}

/**
 * Whether two inventory entries expose a different tool set (compared by
 * name). Drives the decision to fire `notifications/tools/list_changed`.
 */
export function codexMcpToolsChanged(previous: ICodexMcpServerEntry | undefined, next: ICodexMcpServerEntry | undefined): boolean {
	const a = (previous?.tools ?? []).map(t => t.name).sort();
	const b = (next?.tools ?? []).map(t => t.name).sort();
	if (a.length !== b.length) {
		return true;
	}
	return a.some((name, i) => name !== b[i]);
}

// #region MCP server config → codex `-c` overrides
//
// Codex's `app-server` accepts `-c key=value` config overrides whose value is
// parsed as TOML (see `codex-rs/utils/cli/src/config_override.rs`). We use
// these to inject the workbench's configured MCP servers (the root
// `mcpServers` config, keyed by server name) into codex so it launches them —
// the same set Copilot passes to its SDK via `toSdkMcpServersFromConfigMap`.
//
// Each server becomes one `mcp_servers.<name>=<inline-table>` override, which
// *merges* with (rather than replaces) any servers in the user's global
// `~/.codex/config.toml`. Codex's override parser splits the key path on `.`
// and separates key/value on the first `=`, so a server name containing either
// character cannot be targeted and is skipped by
// {@link isCodexOverrideSafeServerName}.
//
// The codex MCP TOML schema (`codex-rs/config/src/mcp_types.rs`,
// `RawMcpServerConfig`, `deny_unknown_fields`) infers the transport from the
// presence of `command` (stdio) vs `url` (streamable http) and does not accept
// a `type` field, so we drop the workbench `type` discriminator and map
// `headers` → `http_headers`.

/** A TOML-encodable value: a string, a string array, or a flat string map. */
type CodexTomlValue = string | readonly string[] | Readonly<Record<string, string>>;

/**
 * Encodes a string as a TOML basic (double-quoted) string, escaping the
 * control characters TOML requires plus `"` and `\`.
 */
function encodeCodexTomlString(value: string): string {
	let out = '"';
	for (const ch of value) {
		const code = ch.codePointAt(0)!;
		switch (ch) {
			case '\\': out += '\\\\'; break;
			case '"': out += '\\"'; break;
			case '\b': out += '\\b'; break;
			case '\t': out += '\\t'; break;
			case '\n': out += '\\n'; break;
			case '\f': out += '\\f'; break;
			case '\r': out += '\\r'; break;
			default:
				out += code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : ch;
		}
	}
	return `${out}"`;
}

/**
 * Encodes a TOML inline-table key: bare when it is a safe identifier,
 * otherwise a quoted basic string.
 */
function encodeCodexTomlKey(key: string): string {
	return /^[A-Za-z0-9_-]+$/.test(key) ? key : encodeCodexTomlString(key);
}

/** Encodes a single {@link CodexTomlValue}. */
function encodeCodexTomlValue(value: CodexTomlValue): string {
	if (typeof value === 'string') {
		return encodeCodexTomlString(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(v => encodeCodexTomlString(v)).join(', ')}]`;
	}
	const entries = Object.entries(value as Record<string, string>);
	return `{ ${entries.map(([k, v]) => `${encodeCodexTomlKey(k)} = ${encodeCodexTomlString(v)}`).join(', ')} }`;
}

/** Encodes an ordered list of fields as a TOML inline table. */
function encodeCodexInlineTable(fields: ReadonlyArray<readonly [string, CodexTomlValue]>): string {
	return `{ ${fields.map(([k, v]) => `${encodeCodexTomlKey(k)} = ${encodeCodexTomlValue(v)}`).join(', ')} }`;
}

/**
 * Narrows an untrusted root-config value to a supported
 * {@link IMcpServerConfiguration}: a `stdio` server with a string `command`,
 * or an `http` server with a string `url`. Mirrors Copilot's
 * `isSupportedMcpServerConfiguration` so a malformed entry can't surface as a
 * `command`/`url: undefined` override.
 */
function isSupportedMcpServerConfiguration(value: unknown): value is IMcpServerConfiguration {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const candidate = value as { type?: unknown; command?: unknown; url?: unknown };
	if (candidate.type === McpServerType.LOCAL) {
		return typeof candidate.command === 'string';
	}
	if (candidate.type === McpServerType.REMOTE) {
		return typeof candidate.url === 'string';
	}
	return false;
}

/**
 * Whether a server name can be targeted by a `mcp_servers.<name>=…` override.
 * Codex splits the override key path on `.` and separates key/value on the
 * first `=`, and trims the key, so names containing `.`/`=` or with
 * surrounding whitespace cannot be addressed and are skipped.
 */
function isCodexOverrideSafeServerName(name: string): boolean {
	return name.length > 0 && name === name.trim() && !/[.=]/.test(name);
}

/** Ensures all env values are strings (codex's `env` is a `Map<string, string>`). */
function toCodexStringEnv(env: Record<string, string | number | null>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== null) {
			result[key] = String(value);
		}
	}
	return result;
}

/** Builds the codex inline-table fields for a single supported server. */
function codexMcpServerFields(config: IMcpServerConfiguration): ReadonlyArray<readonly [string, CodexTomlValue]> {
	const fields: (readonly [string, CodexTomlValue])[] = [];
	if (config.type === McpServerType.LOCAL) {
		fields.push(['command', config.command]);
		if (config.args && config.args.length > 0) {
			fields.push(['args', [...config.args]]);
		}
		if (config.env) {
			const env = toCodexStringEnv(config.env);
			if (Object.keys(env).length > 0) {
				fields.push(['env', env]);
			}
		}
		if (config.cwd) {
			fields.push(['cwd', config.cwd]);
		}
		return fields;
	}
	fields.push(['url', config.url]);
	if (config.headers && Object.keys(config.headers).length > 0) {
		fields.push(['http_headers', { ...config.headers }]);
	}
	return fields;
}

/**
 * The result of {@link buildCodexMcpServerOverrides}: the ready-to-pass
 * `mcp_servers.<name>=<toml>` override strings, plus the names that were
 * dropped because they are malformed or cannot be addressed by a codex
 * override key (so the caller can log a diagnostic).
 */
export interface ICodexMcpServerOverrides {
	readonly overrides: readonly string[];
	readonly skipped: readonly string[];
}

/**
 * Converts the workbench root `mcpServers` config (server name →
 * {@link IMcpServerConfiguration}) into codex `-c` config overrides that make
 * the app-server launch those servers. Unsupported/malformed entries and
 * names that cannot be addressed by an override key are skipped. Returns
 * `key=value` strings ready to be expanded as `-c <override>` spawn args.
 */
export function buildCodexMcpServerOverrides(servers: Record<string, unknown> | undefined): ICodexMcpServerOverrides {
	const overrides: string[] = [];
	const skipped: string[] = [];
	for (const [name, config] of Object.entries(servers ?? {})) {
		if (!isSupportedMcpServerConfiguration(config) || !isCodexOverrideSafeServerName(name)) {
			skipped.push(name);
			continue;
		}
		const table = encodeCodexInlineTable(codexMcpServerFields(config));
		overrides.push(`mcp_servers.${name}=${table}`);
	}
	return { overrides, skipped };
}

// #endregion
