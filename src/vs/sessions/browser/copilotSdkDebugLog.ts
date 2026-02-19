/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Always-on debug log for the Copilot SDK. Subscribes to all SDK events
 * at startup and buffers them so the debug panel can show the full history
 * regardless of when it is opened.
 *
 * Registered as a workbench contribution in `chat.contribution.ts`.
 */

import { ICopilotSdkService } from '../../platform/copilotSdk/common/copilotSdkService.js';
import { BaseDebugLog, IBaseDebugLogEntry } from './debugLog.js';

export interface IDebugLogEntry extends IBaseDebugLogEntry {
	readonly stream: 'rpc' | 'process';
}

export class CopilotSdkDebugLog extends BaseDebugLog<IDebugLogEntry> {

	private static _instance: CopilotSdkDebugLog | undefined;
	static get instance(): CopilotSdkDebugLog | undefined { return CopilotSdkDebugLog._instance; }

	constructor(
		@ICopilotSdkService private readonly _sdk: ICopilotSdkService,
	) {
		super();
		CopilotSdkDebugLog._instance = this;
		this._register({ dispose: () => { if (CopilotSdkDebugLog._instance === this) { CopilotSdkDebugLog._instance = undefined; } } });
		this._subscribe();
	}

	/**
	 * Add a log entry programmatically (used by the debug panel for manual RPC calls).
	 */
	addEntry(direction: string, method: string, detail: string, tag?: string, stream: 'rpc' | 'process' = 'rpc'): void {
		this.createEntry({ direction, method, detail, tag, stream });
	}

	override clear(predicate?: ((entry: IDebugLogEntry) => boolean) | 'rpc' | 'process'): void {
		if (typeof predicate === 'string') {
			const stream = predicate;
			super.clear(e => e.stream === stream);
		} else {
			super.clear(predicate);
		}
	}

	private _subscribe(): void {
		this._register(this._sdk.onSessionEvent(event => {
			const data = JSON.stringify(event.data ?? {});
			const truncated = data.length > 300 ? data.substring(0, 300) + '...' : data;
			this.addEntry('!', `event:${event.type}`, truncated, event.sessionId.substring(0, 8));
		}));

		this._register(this._sdk.onSessionLifecycle(event => {
			this.addEntry('!', `lifecycle:${event.type}`, '', event.sessionId.substring(0, 8));
		}));

		this._register(this._sdk.onProcessOutput(output => {
			this.addEntry('', output.stream, output.data, undefined, 'process');
		}));
	}
}
