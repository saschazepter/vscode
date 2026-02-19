/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Generic debug log infrastructure shared by the Copilot SDK and Cloud Task
 * debug logs. Provides a bounded entry buffer with add/clear operations
 * and a live event emitter.
 */

import { Disposable } from '../../base/common/lifecycle.js';
import { Emitter, Event } from '../../base/common/event.js';

const MAX_LOG_ENTRIES = 5000;

/**
 * Base fields shared by all debug log entry types.
 */
export interface IBaseDebugLogEntry {
	readonly id: number;
	readonly timestamp: string;
	readonly direction: string;   // '→' request, '←' response, '!' event, 'X' error
	readonly method: string;
	readonly detail: string;
	readonly tag?: string;
}

/**
 * Generic debug log buffer. Subclasses provide the concrete entry type
 * and call `createEntry()` to add entries. The base manages the buffer,
 * size limit, and event emission.
 */
export abstract class BaseDebugLog<TEntry extends IBaseDebugLogEntry> extends Disposable {

	private _nextId = 1;
	private readonly _entries: TEntry[] = [];

	private readonly _onDidAddEntry = this._register(new Emitter<TEntry>());
	readonly onDidAddEntry: Event<TEntry> = this._onDidAddEntry.event;

	get entries(): readonly TEntry[] {
		return this._entries;
	}

	/**
	 * Create and append a new log entry. The `id` and `timestamp` fields
	 * are set automatically.
	 */
	protected createEntry(fields: Omit<TEntry, 'id' | 'timestamp'>): TEntry {
		const entry: TEntry = {
			...fields,
			id: this._nextId++,
			timestamp: new Date().toLocaleTimeString(),
		};
		this._entries.push(entry);
		if (this._entries.length > MAX_LOG_ENTRIES) {
			this._entries.splice(0, this._entries.length - MAX_LOG_ENTRIES);
		}
		this._onDidAddEntry.fire(entry);
		return entry;
	}

	/**
	 * Clear log entries. If a predicate is provided, only matching entries
	 * are removed; otherwise all entries are cleared.
	 */
	clear(predicate?: (entry: TEntry) => boolean): void {
		if (predicate) {
			for (let i = this._entries.length - 1; i >= 0; i--) {
				if (predicate(this._entries[i])) {
					this._entries.splice(i, 1);
				}
			}
		} else {
			this._entries.length = 0;
		}
	}
}
