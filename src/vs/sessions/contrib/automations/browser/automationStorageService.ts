/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IIndexedDBStorageDatabase, IndexedDBStorageDatabase } from '../../../../workbench/services/storage/browser/storageService.js';
import { AUTOMATION_STORAGE_KEY, IAutomationStorageCompareAndSwapResult, IAutomationStorageService } from '../common/automationStorageService.js';

/**
 * Uses an IndexedDB transaction so automation writes remain atomic across browser tabs.
 */
export class BrowserAutomationStorageService extends Disposable implements IAutomationStorageService {

	declare readonly _serviceBrand: undefined;

	private readonly database: Promise<IIndexedDBStorageDatabase>;

	constructor(
		@ILogService logService: ILogService,
	) {
		super();
		// Keep the standard application-storage factory so this connection never requests a divergent store set.
		this.database = IndexedDBStorageDatabase.createApplicationStorage(logService).then(database => this._register(database));
	}

	async read(): Promise<string | undefined> {
		const database = await this.database;
		const items = await database.getItems();
		return items.get(AUTOMATION_STORAGE_KEY);
	}

	async compareAndSwap(expectedValue: string | undefined, newValue: string): Promise<IAutomationStorageCompareAndSwapResult> {
		return (await this.database).compareAndSwap(AUTOMATION_STORAGE_KEY, expectedValue, newValue);
	}
}
