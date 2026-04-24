/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Settings as ClaudeSettings } from '@anthropic-ai/claude-agent-sdk';
import { Event } from '../../../../util/vs/base/common/event';
import { URI } from '../../../../util/vs/base/common/uri';
import { createDecorator } from '../../../../util/vs/platform/instantiation/common/instantiation';

export const IClaudeSettingsService = createDecorator<IClaudeSettingsService>('claudeSettingsService');

export enum ClaudeSettingsLocationType {
	// ~/.claude/settings.json
	User = 'user',
	// <workspace>/.claude/settings.json
	Workspace = 'workspace',
	// <workspace>/.claude/settings.local.json
	WorkspaceLocal = 'workspaceLocal',
}

export interface ClaudeSettingsFile {
	type: ClaudeSettingsLocationType;
	settings: ClaudeSettings;
	uri: URI;
}

export interface IClaudeSettingsService {
	readonly _serviceBrand: undefined;

	/**
	 * Fires when any Claude settings file changes on disk.
	 */
	readonly onDidChange: Event<void>;

	/**
	 * Returns the settings from all settings files as separate objects.
	 * Each is an empty object if the file doesn't exist or can't be parsed.
	 * Returns it in order of precedence (workspaceLocal > workspace > user).
	 */
	readAllSettings(): Promise<Readonly<ClaudeSettingsFile[]>>;

	/**
	 * Reads a single settings file as a typed object.
	 * Returns an empty object if the file doesn't exist or can't be parsed.
	 */
	readSettingsFile(uri: URI): Promise<ClaudeSettings>;

	/**
	 * Writes settings to the given location.
	 */
	writeSettingsFile(uri: URI, settings: ClaudeSettings): Promise<void>;

	/**
	 * Returns known settings URIs. If location is provided, returns only the URIs for that location.
	 */
	getUris(location?: ClaudeSettingsLocationType): URI[];

	/**
	 * Returns the settings URI for the given location and a URI that belongs to a workspace folder.
	 */
	getUri(location: ClaudeSettingsLocationType, workspaceUri: URI): URI;
}
