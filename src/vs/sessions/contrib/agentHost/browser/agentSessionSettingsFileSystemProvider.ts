/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter } from '../../../../base/common/event.js';
import { parse, ParseError } from '../../../../base/common/json.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import {
	createFileSystemProviderError,
	FileChangeType,
	FilePermission,
	FileSystemProviderCapabilities,
	FileSystemProviderErrorCode,
	FileType,
	IFileChange,
	IFileDeleteOptions,
	IFileOverwriteOptions,
	IFileSystemProviderWithFileReadWriteCapability,
	IFileWriteOptions,
	IStat,
	IWatchOptions,
} from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ISession, toSessionId } from '../../../services/sessions/common/session.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { IAgentHostSessionsProvider, isAgentHostProvider } from '../../../common/agentHostSessionsProvider.js';

/** Scheme for the synthetic agent-host session settings files. */
export const AGENT_SESSION_SETTINGS_SCHEME = 'agent-session-settings';

/**
 * Build the URI used to open the settings file for an agent-host session.
 *
 * URI shape: `agent-session-settings://{providerId}/{resourceScheme}{resourcePath}.jsonc`
 *
 * - `authority` = {@link ISession.providerId} (e.g. `local-agent-host`, `agenthost-<auth>`)
 * - path encodes the session's resource scheme and path so {@link parseSettingsUri}
 *   can reconstruct the full {@link ISession.sessionId} via {@link toSessionId}
 *   without having to look the session up on the provider.
 */
export function agentSessionSettingsUri(session: ISession): URI {
	// `resource.path` already starts with `/`, so splice it between the scheme and the `.jsonc` suffix.
	return URI.from({
		scheme: AGENT_SESSION_SETTINGS_SCHEME,
		authority: session.providerId,
		path: `/${session.resource.scheme}${session.resource.path}.jsonc`,
	});
}

interface IParsedSettingsUri {
	readonly providerId: string;
	/** Reconstructed {@link ISession.sessionId}. */
	readonly sessionId: string;
}

function parseSettingsUri(uri: URI): IParsedSettingsUri | undefined {
	if (uri.scheme !== AGENT_SESSION_SETTINGS_SCHEME) {
		return undefined;
	}
	const providerId = uri.authority;
	if (!providerId) {
		return undefined;
	}
	// Path: /{resourceScheme}/{rawId}.jsonc
	const path = uri.path.startsWith('/') ? uri.path.substring(1) : uri.path;
	const firstSlash = path.indexOf('/');
	if (firstSlash <= 0) {
		return undefined;
	}
	const resourceScheme = path.substring(0, firstSlash);
	let rest = path.substring(firstSlash); // includes leading '/'
	const lastDot = rest.lastIndexOf('.');
	if (lastDot > 0) {
		rest = rest.substring(0, lastDot);
	}
	if (!resourceScheme || rest === '/') {
		return undefined;
	}
	const resource = URI.from({ scheme: resourceScheme, path: rest });
	return { providerId, sessionId: toSessionId(providerId, resource) };
}

/**
 * Serialize the session-mutable config values for a session into a
 * commented, pretty-printed JSON document.
 */
export function serializeSessionSettings(provider: IAgentHostSessionsProvider, sessionId: string): string {
	const config = provider.getSessionConfig(sessionId);
	if (!config) {
		return `${headerComment(undefined)}{}\n`;
	}

	// Only include session-mutable, non-readOnly properties in the editable
	// document. Read-only / non-mutable properties (e.g. `isolation`, `branch`)
	// are preserved in the underlying config and round-tripped on write —
	// they just aren't surfaced for editing.
	const mutableProps = Object.entries(config.schema.properties).filter(([, schema]) => schema.sessionMutable && !schema.readOnly);
	const values: Record<string, unknown> = {};
	for (const [key] of mutableProps) {
		if (config.values[key] !== undefined) {
			values[key] = config.values[key];
		}
	}

	return `${headerComment(mutableProps)}${JSON.stringify(values, null, 2)}\n`;
}

function headerComment(props: readonly (readonly [string, { readonly title: string; readonly description?: string; readonly enum?: readonly string[] }])[] | undefined): string {
	const lines: string[] = [];
	lines.push(`// ${localize('agentSessionSettings.header', "Session settings for this agent host session.")}`);
	lines.push(`// ${localize('agentSessionSettings.saveHint', "Edit values below and save to apply. Unknown or non-mutable properties are ignored.")}`);
	if (props && props.length > 0) {
		lines.push('//');
		for (const [key, schema] of props) {
			const suffix = schema.enum && schema.enum.length > 0 ? ` (${schema.enum.join(' | ')})` : '';
			const title = schema.title || key;
			lines.push(`// ${key}: ${title}${suffix}`);
			if (schema.description) {
				lines.push(`//   ${schema.description}`);
			}
		}
	}
	lines.push('');
	return lines.join('\n');
}

/**
 * Filesystem provider serving synthetic JSONC documents that represent the
 * session-mutable config values of agent-host sessions.
 *
 * Reads render `IAgentHostSessionsProvider.getSessionConfig()` as pretty
 * JSONC. Writes parse the document with the JSONC parser and push the user's
 * full editable view to `replaceSessionConfig`, which atomically replaces
 * user-editable values while preserving non-mutable / readOnly properties
 * (e.g. `isolation`, `branch`) server-side.
 */
export class AgentSessionSettingsFileSystemProvider extends Disposable implements IFileSystemProviderWithFileReadWriteCapability {

	readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive;

	private readonly _onDidChangeCapabilities = this._register(new Emitter<void>());
	readonly onDidChangeCapabilities = this._onDidChangeCapabilities.event;

	private readonly _onDidChangeFile = this._register(new Emitter<readonly IFileChange[]>());
	readonly onDidChangeFile = this._onDidChangeFile.event;

	constructor(
		@ISessionsProvidersService private readonly _sessionsProvidersService: ISessionsProvidersService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	watch(resource: URI, _opts: IWatchOptions): IDisposable {
		// The underlying provider fires `onDidChangeSessionConfig` with a sessionId;
		// forward those into `onDidChangeFile` for the watched resource.
		const parsed = parseSettingsUri(resource);
		if (!parsed) {
			return Disposable.None;
		}
		const provider = this._lookupProvider(parsed.providerId);
		if (!provider) {
			return Disposable.None;
		}
		return provider.onDidChangeSessionConfig(changedSessionId => {
			if (changedSessionId === parsed.sessionId) {
				this._onDidChangeFile.fire([{ type: FileChangeType.UPDATED, resource }]);
			}
		});
	}

	async stat(resource: URI): Promise<IStat> {
		const parsed = parseSettingsUri(resource);
		if (!parsed) {
			throw createFileSystemProviderError(`Invalid agent-session-settings URI: ${resource.toString()}`, FileSystemProviderErrorCode.FileNotFound);
		}
		const { provider, sessionId } = this._resolve(parsed);
		const content = serializeSessionSettings(provider, sessionId);
		return {
			type: FileType.File,
			ctime: 0,
			mtime: 0,
			size: VSBuffer.fromString(content).byteLength,
			permissions: 0 as FilePermission,
		};
	}

	async readdir(): Promise<[string, FileType][]> {
		throw createFileSystemProviderError('readdir not supported', FileSystemProviderErrorCode.NoPermissions);
	}

	async readFile(resource: URI): Promise<Uint8Array> {
		const parsed = parseSettingsUri(resource);
		if (!parsed) {
			throw createFileSystemProviderError(`Invalid agent-session-settings URI: ${resource.toString()}`, FileSystemProviderErrorCode.FileNotFound);
		}
		const { provider, sessionId } = this._resolve(parsed);
		const content = serializeSessionSettings(provider, sessionId);
		return VSBuffer.fromString(content).buffer;
	}

	async writeFile(resource: URI, content: Uint8Array, _opts: IFileWriteOptions): Promise<void> {
		const parsed = parseSettingsUri(resource);
		if (!parsed) {
			throw createFileSystemProviderError(`Invalid agent-session-settings URI: ${resource.toString()}`, FileSystemProviderErrorCode.FileNotFound);
		}
		const { provider, sessionId } = this._resolve(parsed);

		const text = VSBuffer.wrap(content).toString();
		const errors: ParseError[] = [];
		const parsed_json = parse(text, errors);
		if (errors.length > 0) {
			throw createFileSystemProviderError(
				localize('agentSessionSettings.parseError', "Failed to parse agent session settings as JSON."),
				FileSystemProviderErrorCode.Unavailable,
			);
		}
		if (parsed_json === null || typeof parsed_json !== 'object' || Array.isArray(parsed_json)) {
			throw createFileSystemProviderError(
				localize('agentSessionSettings.notObject', "Agent session settings must be a JSON object."),
				FileSystemProviderErrorCode.Unavailable,
			);
		}

		const currentConfig = provider.getSessionConfig(sessionId);
		if (!currentConfig) {
			this._logService.trace(`[AgentSessionSettings] No config state for session ${sessionId}; ignoring write.`);
			this._onDidChangeFile.fire([{ type: FileChangeType.UPDATED, resource }]);
			return;
		}

		// The input is the user's full view of editable values. Dispatch as a
		// replace — `replaceSessionConfig` guarantees non-editable properties
		// (non-mutable or readOnly) are preserved regardless of what we send,
		// and unknown keys are ignored. This means:
		//   - Re-asserted editable keys overwrite the current value.
		//   - Omitted editable keys are unset (supports clearing via deletion).
		//   - Non-editable keys (e.g. `isolation`, `branch`) are round-tripped
		//     server-side even though we never read or write them here.
		await provider.replaceSessionConfig(sessionId, parsed_json as Record<string, unknown>);

		this._onDidChangeFile.fire([{ type: FileChangeType.UPDATED, resource }]);
	}

	async mkdir(): Promise<void> {
		throw createFileSystemProviderError('mkdir not supported', FileSystemProviderErrorCode.NoPermissions);
	}

	async delete(_resource: URI, _opts: IFileDeleteOptions): Promise<void> {
		throw createFileSystemProviderError('delete not supported', FileSystemProviderErrorCode.NoPermissions);
	}

	async rename(_from: URI, _to: URI, _opts: IFileOverwriteOptions): Promise<void> {
		throw createFileSystemProviderError('rename not supported', FileSystemProviderErrorCode.NoPermissions);
	}

	// ---- Helpers ------------------------------------------------------------

	private _lookupProvider(providerId: string): IAgentHostSessionsProvider | undefined {
		const provider = this._sessionsProvidersService.getProvider(providerId);
		if (!provider || !isAgentHostProvider(provider)) {
			return undefined;
		}
		return provider;
	}

	private _resolve(parsed: IParsedSettingsUri): { provider: IAgentHostSessionsProvider; sessionId: string } {
		const provider = this._lookupProvider(parsed.providerId);
		if (!provider) {
			throw createFileSystemProviderError(
				`Unknown agent host provider: ${parsed.providerId}`,
				FileSystemProviderErrorCode.FileNotFound,
			);
		}
		return { provider, sessionId: parsed.sessionId };
	}
}
