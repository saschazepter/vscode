/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { BrowserStorageService, IIndexedDBStorageDatabase } from '../../../../workbench/services/storage/browser/storageService.js';
import { AUTOMATION_STORAGE_KEY, IAutomationStorageCompareAndSwapResult, IAutomationStorageService } from '../common/automationStorageService.js';

/**
 * Uses an IndexedDB transaction so automation writes remain atomic across browser tabs.
 */
export class BrowserAutomationStorageService implements IAutomationStorageService {

	declare readonly _serviceBrand: undefined;

	private readonly database: Promise<IIndexedDBStorageDatabase>;

	constructor(
		@IStorageService storageService: IStorageService,
	) {
		if (!(storageService instanceof BrowserStorageService)) {
			throw new Error('Browser automation storage requires BrowserStorageService.');
		}
		this.database = storageService.getApplicationStorageDatabase();
	}

	async read(): Promise<string | undefined> {
		return (await this.database).getValue(AUTOMATION_STORAGE_KEY);
	}

	async compareAndSwap(expectedValue: string | undefined, newValue: string): Promise<IAutomationStorageCompareAndSwapResult> {
		return (await this.database).compareAndSwap(AUTOMATION_STORAGE_KEY, expectedValue, newValue);
	}
}
