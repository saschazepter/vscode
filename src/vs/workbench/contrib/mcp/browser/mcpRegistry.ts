/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { isEmptyObject } from '../../../../base/common/types.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IConfigurationResolverService } from '../../../services/configurationResolver/common/configurationResolver.js';
import { IMcpHostDelegate, IMcpRegistry } from '../common/mcpRegistry.js';
import { McpServerConnection } from '../common/mcpServerConnection.js';
import { IMcpCollectionDefinition, IMcpServerConnection, IMcpServerDefinition } from '../common/mcpTypes.js';

export class McpRegistry extends Disposable implements IMcpRegistry {
	readonly _serviceBrand: undefined;

	private readonly _collections = observableValue<readonly IMcpCollectionDefinition[]>('collections', []);
	private readonly _delegates: IMcpHostDelegate[] = [];

	public readonly collections: IObservable<readonly IMcpCollectionDefinition[]> = this._collections;

	public get delegates(): readonly IMcpHostDelegate[] {
		return this._delegates;
	}

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IConfigurationResolverService private readonly _configurationResolverService: IConfigurationResolverService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
	}

	public registerDelegate(delegate: IMcpHostDelegate): IDisposable {
		this._delegates.push(delegate);
		return {
			dispose: () => {
				const index = this._delegates.indexOf(delegate);
				if (index !== -1) {
					this._delegates.splice(index, 1);
				}
			}
		};
	}

	public registerCollection(collection: IMcpCollectionDefinition): IDisposable {
		const currentCollections = this._collections.get();
		this._collections.set([...currentCollections, collection], undefined);

		return {
			dispose: () => {
				const currentCollections = this._collections.get();
				this._collections.set(currentCollections.filter(c => c !== collection), undefined);
			}
		};
	}

	public hasSavedInputs(collection: IMcpCollectionDefinition, definition: IMcpServerDefinition): boolean {
		const stored = this.getInputStorageData(collection, definition);
		return !!stored && !isEmptyObject(stored.map);
	}

	public clearSavedInputs(collection: IMcpCollectionDefinition, definition: IMcpServerDefinition) {
		const stored = this.getInputStorageData(collection, definition);
		if (stored) {
			this._storageService.remove(stored.key, stored.scope);
		}
	}

	public async resolveConnection(
		collection: IMcpCollectionDefinition,
		definition: IMcpServerDefinition
	): Promise<IMcpServerConnection> {
		const delegate = this._delegates.find(d => d.canStart(collection, definition));
		if (!delegate) {
			throw new Error('No delegate found that can handle the connection');
		}

		let launch = definition.launch;

		const storage = this.getInputStorageData(collection, definition);
		if (definition.variableReplacement && storage) {
			const { folder, section, target } = definition.variableReplacement;
			// based on _configurationResolverService.resolveWithInteractionReplace
			launch = await this._configurationResolverService.resolveAnyAsync(folder, section);

			const newVariables = await this._configurationResolverService.resolveWithInteraction(folder, launch, section, storage.map, target);

			if (newVariables?.size) {
				launch = await this._configurationResolverService.resolveAnyAsync(folder, launch, Object.fromEntries(newVariables));
				this._storageService.store(storage.key, JSON.stringify(Object.fromEntries(newVariables)), storage.scope, StorageTarget.MACHINE);
			}
		}

		return this._instantiationService.createInstance(
			McpServerConnection,
			collection,
			definition,
			delegate,
			launch,
		);
	}

	private getInputStorageData(collection: IMcpCollectionDefinition, definition: IMcpServerDefinition) {
		if (!definition.variableReplacement) {
			return undefined;
		}

		const key = `mcpConfig.${collection.id}.${definition.id}`;
		const scope = definition.variableReplacement.folder ? StorageScope.WORKSPACE : StorageScope.APPLICATION;

		let map: Record<string, string> | undefined;
		try {
			map = JSON.parse(this._storageService.get(key, scope, '{}'));
		} catch {
			// ignord
		}

		return { key, scope, map };
	}
}

