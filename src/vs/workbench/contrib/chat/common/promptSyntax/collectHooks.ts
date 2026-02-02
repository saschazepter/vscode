/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IPromptsService } from './service/promptsService.js';
import { PromptsType } from './promptTypes.js';
import { HookTypeId, IChatRequestHooks, IHookCommand } from './hookSchema.js';

/**
 * Collects all hooks from hooks.json files in the workspace and user directories.
 * This is used to pass hook configuration to the extension host when sending a chat request.
 */
export class CollectHooks {

	constructor(
		@IPromptsService private readonly _promptsService: IPromptsService,
		@ILogService private readonly _logService: ILogService,
		@IFileService private readonly _fileService: IFileService,
	) {
	}

	/**
	 * Collects all hooks from configured hook files.
	 * @returns The collected hooks organized by hook type, or undefined if no hooks are configured.
	 */
	public async collect(token: CancellationToken): Promise<IChatRequestHooks | undefined> {
		const hookFiles = await this._promptsService.listPromptFiles(PromptsType.hook, token);

		if (hookFiles.length === 0) {
			this._logService.trace('[CollectHooks] No hook files found.');
			return undefined;
		}

		this._logService.trace(`[CollectHooks] Found ${hookFiles.length} hook file(s).`);

		const collectedHooks: {
			sessionStart: IHookCommand[];
			sessionEnd: IHookCommand[];
			userPromptSubmitted: IHookCommand[];
			preToolUse: IHookCommand[];
			postToolUse: IHookCommand[];
			errorOccurred: IHookCommand[];
		} = {
			sessionStart: [],
			sessionEnd: [],
			userPromptSubmitted: [],
			preToolUse: [],
			postToolUse: [],
			errorOccurred: [],
		};

		for (const hookFile of hookFiles) {
			try {
				const content = await this._fileService.readFile(hookFile.uri);
				const json = JSON.parse(content.value.toString());

				if (json.version !== 1) {
					this._logService.warn(`[CollectHooks] Unsupported hook file version: ${json.version} in ${hookFile.uri}`);
					continue;
				}

				const hooks = json.hooks;
				if (!hooks || typeof hooks !== 'object') {
					this._logService.trace(`[CollectHooks] No hooks object in ${hookFile.uri}`);
					continue;
				}

				// Collect hooks by type
				for (const hookTypeId of Object.keys(hooks) as HookTypeId[]) {
					const hookArray = hooks[hookTypeId];
					if (!Array.isArray(hookArray)) {
						continue;
					}

					for (const rawHookCommand of hookArray) {
						const normalized = this._normalizeHookCommand(rawHookCommand as Record<string, unknown>);
						if (normalized) {
							collectedHooks[hookTypeId].push(normalized);
							this._logService.trace(`[CollectHooks] Collected ${hookTypeId} hook from ${hookFile.uri}`);
						}
					}
				}
			} catch (error) {
				this._logService.warn(`[CollectHooks] Failed to parse hook file: ${hookFile.uri}`, error);
			}
		}

		// Check if any hooks were collected
		const hasHooks = Object.values(collectedHooks).some(arr => arr.length > 0);
		if (!hasHooks) {
			this._logService.trace('[CollectHooks] No valid hooks collected.');
			return undefined;
		}

		// Build the result, only including hook types that have entries
		const result: IChatRequestHooks = {
			...(collectedHooks.sessionStart.length > 0 && { sessionStart: collectedHooks.sessionStart }),
			...(collectedHooks.sessionEnd.length > 0 && { sessionEnd: collectedHooks.sessionEnd }),
			...(collectedHooks.userPromptSubmitted.length > 0 && { userPromptSubmitted: collectedHooks.userPromptSubmitted }),
			...(collectedHooks.preToolUse.length > 0 && { preToolUse: collectedHooks.preToolUse }),
			...(collectedHooks.postToolUse.length > 0 && { postToolUse: collectedHooks.postToolUse }),
			...(collectedHooks.errorOccurred.length > 0 && { errorOccurred: collectedHooks.errorOccurred }),
		};

		this._logService.trace(`[CollectHooks] Collected hooks: ${JSON.stringify(Object.keys(result))}`);
		return result;
	}

	/**
	 * Normalizes a raw hook command from JSON, converting bash/powershell to command.
	 */
	private _normalizeHookCommand(raw: Record<string, unknown>): IHookCommand | undefined {
		if (raw.type !== 'command') {
			return undefined;
		}

		let command: string | undefined;

		if (typeof raw.command === 'string' && raw.command.length > 0) {
			command = raw.command;
		} else if (typeof raw.bash === 'string' && raw.bash.length > 0) {
			// Convert bash to command by prefixing with 'bash -c'
			command = `bash -c ${JSON.stringify(raw.bash)}`;
		} else if (typeof raw.powershell === 'string' && raw.powershell.length > 0) {
			// Convert powershell to command by prefixing with 'powershell -Command'
			command = `powershell -Command ${JSON.stringify(raw.powershell)}`;
		}

		if (!command) {
			return undefined;
		}

		return {
			type: 'command',
			command,
			...(typeof raw.cwd === 'string' && { cwd: raw.cwd }),
			...(typeof raw.env === 'object' && raw.env !== null && { env: raw.env as Record<string, string> }),
			...(typeof raw.timeoutSec === 'number' && { timeoutSec: raw.timeoutSec }),
		};
	}
}
