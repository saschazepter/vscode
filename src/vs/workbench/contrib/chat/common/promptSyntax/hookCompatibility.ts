/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { basename, dirname } from '../../../../../base/common/path.js';
import { HookType, IHookCommand, toHookType, resolveHookCommand } from './hookSchema.js';
import { parseClaudeHooks } from './hookClaudeCompat.js';
import { resolveCopilotCliHookType } from './hookCopilotCliCompat.js';

/**
 * Represents a hook source with its original and normalized properties.
 * Used to display hooks from different formats in a unified view.
 */
export interface IResolvedHookEntry {
	/** The normalized hook type (our canonical HookType enum) */
	readonly hookType: HookType;
	/** The original hook type ID as it appears in the source file */
	readonly originalHookTypeId: string;
	/** The source format this hook came from */
	readonly sourceFormat: HookSourceFormat;
	/** The resolved hook command */
	readonly command: IHookCommand;
	/** The index of this hook in its array (for editing) */
	readonly index: number;
}

/**
 * Supported hook file formats.
 */
export enum HookSourceFormat {
	/** GitHub Copilot hooks .json format */
	Copilot = 'copilot',
	/** Claude settings.json / settings.local.json format */
	Claude = 'claude',
}

/**
 * Determines the hook source format based on the file URI.
 */
export function getHookSourceFormat(fileUri: URI): HookSourceFormat {
	const filename = basename(fileUri.path).toLowerCase();
	const dir = dirname(fileUri.path);

	// Claude format: .claude/settings.json or .claude/settings.local.json
	if ((filename === 'settings.json' || filename === 'settings.local.json') && dir.endsWith('.claude')) {
		return HookSourceFormat.Claude;
	}

	// Default to Copilot format
	return HookSourceFormat.Copilot;
}

/**
 * Checks if a file is read-only based on its source format.
 * Claude settings files should be read-only from our perspective since they have a different format.
 */
export function isReadOnlyHookSource(format: HookSourceFormat): boolean {
	return format === HookSourceFormat.Claude;
}

/**
 * Result of parsing Copilot hooks file.
 */
export interface IParseCopilotHooksResult {
	/**
	 * The parsed hooks by type.
	 */
	readonly hooks: Map<HookType, { hooks: IHookCommand[]; originalId: string }>;
	/**
	 * Whether all hooks from this file were disabled via `disableAllHooks: true`.
	 */
	readonly disabledAllHooks: boolean;
}

/**
 * Parses hooks from a Copilot hooks .json file (our native format).
 */
export function parseCopilotHooks(
	json: unknown,
	workspaceRootUri: URI | undefined,
	userHome: string
): IParseCopilotHooksResult {
	const result = new Map<HookType, { hooks: IHookCommand[]; originalId: string }>();

	if (!json || typeof json !== 'object') {
		return { hooks: result, disabledAllHooks: false };
	}

	const root = json as Record<string, unknown>;

	// Check for disableAllHooks property at the top level
	if (root.disableAllHooks === true) {
		return { hooks: result, disabledAllHooks: true };
	}

	const hooks = root.hooks;
	if (!hooks || typeof hooks !== 'object') {
		return { hooks: result, disabledAllHooks: false };
	}

	const hooksObj = hooks as Record<string, unknown>;

	for (const originalId of Object.keys(hooksObj)) {
		const hookType = resolveCopilotCliHookType(originalId) ?? toHookType(originalId);
		if (!hookType) {
			continue;
		}

		const hookArray = hooksObj[originalId];
		if (!Array.isArray(hookArray)) {
			continue;
		}

		const commands: IHookCommand[] = [];

		for (const item of hookArray) {
			const resolved = resolveHookCommand(item as Record<string, unknown>, workspaceRootUri, userHome);
			if (resolved) {
				commands.push(resolved);
			}
		}

		if (commands.length > 0) {
			result.set(hookType, { hooks: commands, originalId });
		}
	}

	return { hooks: result, disabledAllHooks: false };
}

/**
 * Result of parsing hooks from a file.
 */
export interface IParseHooksFromFileResult {
	readonly format: HookSourceFormat;
	readonly hooks: Map<HookType, { hooks: IHookCommand[]; originalId: string }>;
	/**
	 * Whether all hooks from this file were disabled via `disableAllHooks: true`.
	 */
	readonly disabledAllHooks: boolean;
}

/**
 * Parses hooks from any supported format, auto-detecting the format from the file URI.
 */
export function parseHooksFromFile(
	fileUri: URI,
	json: unknown,
	workspaceRootUri: URI | undefined,
	userHome: string
): IParseHooksFromFileResult {
	const format = getHookSourceFormat(fileUri);

	let hooks: Map<HookType, { hooks: IHookCommand[]; originalId: string }>;
	let disabledAllHooks = false;

	switch (format) {
		case HookSourceFormat.Claude: {
			const result = parseClaudeHooks(json, workspaceRootUri, userHome);
			hooks = result.hooks;
			disabledAllHooks = result.disabledAllHooks;
			break;
		}
		case HookSourceFormat.Copilot:
		default: {
			const result = parseCopilotHooks(json, workspaceRootUri, userHome);
			hooks = result.hooks;
			disabledAllHooks = result.disabledAllHooks;
			break;
		}
	}

	return { format, hooks, disabledAllHooks };
}

/**
 * Gets a human-readable label for a hook source format.
 */
export function getHookSourceFormatLabel(format: HookSourceFormat): string {
	switch (format) {
		case HookSourceFormat.Claude:
			return 'Claude';
		case HookSourceFormat.Copilot:
			return 'GitHub Copilot';
	}
}
