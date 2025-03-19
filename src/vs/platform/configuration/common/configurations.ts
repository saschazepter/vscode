/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { coalesce } from '../../../base/common/arrays.js';
import { IStringDictionary } from '../../../base/common/collections.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { equals } from '../../../base/common/objects.js';
import { isEmptyObject, isString } from '../../../base/common/types.js';
import { ConfigurationModel } from './configurationModels.js';
import { Extensions, IConfigurationRegistry, IRegisteredConfigurationPropertySchema } from './configurationRegistry.js';
import { ILogService, NullLogService } from '../../log/common/log.js';
import { IPolicyService, PolicyDefinition, PolicyName } from '../../policy/common/policy.js';
import { Registry } from '../../registry/common/platform.js';
import { getErrorMessage } from '../../../base/common/errors.js';
import * as json from '../../../base/common/json.js';
import { IContextKeyService } from '../../contextkey/common/contextkey.js';

export class DefaultConfiguration extends Disposable {

	private readonly _onDidChangeConfiguration = this._register(new Emitter<{ defaults: ConfigurationModel; properties: string[] }>());
	readonly onDidChangeConfiguration = this._onDidChangeConfiguration.event;

	private _configurationModel = ConfigurationModel.createEmptyModel(this.logService);
	get configurationModel(): ConfigurationModel {
		return this._configurationModel;
	}

	constructor(private readonly logService: ILogService) {
		super();
	}

	async initialize(): Promise<ConfigurationModel> {
		this.resetConfigurationModel();
		this._register(Registry.as<IConfigurationRegistry>(Extensions.Configuration).onDidUpdateConfiguration(({ properties, defaultsOverrides }) => this.onDidUpdateConfiguration(Array.from(properties), defaultsOverrides)));
		return this.configurationModel;
	}

	reload(): ConfigurationModel {
		this.resetConfigurationModel();
		return this.configurationModel;
	}

	protected onDidUpdateConfiguration(properties: string[], defaultsOverrides?: boolean): void {
		this.updateConfigurationModel(properties, Registry.as<IConfigurationRegistry>(Extensions.Configuration).getConfigurationProperties());
		this._onDidChangeConfiguration.fire({ defaults: this.configurationModel, properties });
	}

	protected getConfigurationDefaultOverrides(): IStringDictionary<any> {
		return {};
	}

	private resetConfigurationModel(): void {
		this._configurationModel = ConfigurationModel.createEmptyModel(this.logService);
		const properties = Registry.as<IConfigurationRegistry>(Extensions.Configuration).getConfigurationProperties();
		this.updateConfigurationModel(Object.keys(properties), properties);
	}

	private updateConfigurationModel(properties: string[], configurationProperties: IStringDictionary<IRegisteredConfigurationPropertySchema>): void {
		const configurationDefaultsOverrides = this.getConfigurationDefaultOverrides();
		for (const key of properties) {
			const defaultOverrideValue = configurationDefaultsOverrides[key];
			const propertySchema = configurationProperties[key];
			if (defaultOverrideValue !== undefined) {
				this._configurationModel.setValue(key, defaultOverrideValue);
			} else if (propertySchema) {
				this._configurationModel.setValue(key, propertySchema.default);
			} else {
				this._configurationModel.removeValue(key);
			}
		}
	}

}

export interface IPolicyConfiguration {
	readonly onDidChangeConfiguration: Event<ConfigurationModel>;
	readonly configurationModel: ConfigurationModel;
	initialize(): Promise<ConfigurationModel>;
	acquireContextKeyService(contextKeyService: IContextKeyService): void;
}

export class NullPolicyConfiguration implements IPolicyConfiguration {
	acquireContextKeyService(contextKeyService: IContextKeyService): void {
		// no-op
	}
	readonly onDidChangeConfiguration = Event.None;
	readonly configurationModel = ConfigurationModel.createEmptyModel(new NullLogService());
	async initialize() { return this.configurationModel; }
}

export class PolicyConfiguration extends Disposable implements IPolicyConfiguration {

	private readonly _onDidChangeConfiguration = this._register(new Emitter<ConfigurationModel>());
	readonly onDidChangeConfiguration = this._onDidChangeConfiguration.event;
	private contextKeyService: IContextKeyService | undefined;
	private readonly configurationRegistry: IConfigurationRegistry;

	private _configurationModel = ConfigurationModel.createEmptyModel(this.logService);
	get configurationModel() { return this._configurationModel; }

	constructor(
		private readonly defaultConfiguration: DefaultConfiguration,
		@IPolicyService private readonly policyService: IPolicyService,
		@ILogService private readonly logService: ILogService,
		////// @IContextKeyService private readonly contextKeyService: IContextKeyService,
	) {
		super();
		this.configurationRegistry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
	}

	async initialize(): Promise<ConfigurationModel> {
		this.logService.trace('PolicyConfiguration#initialize');

		this.update(await this.updatePolicyDefinitions(this.defaultConfiguration.configurationModel.keys), false, false);
		this.update(await this.updatePolicyDefinitions(Object.keys(this.configurationRegistry.getExcludedConfigurationProperties())), false, false);
		this.update(await this.applyInternalPolicy(this.defaultConfiguration.configurationModel.keys), false, true);
		this._register(this.policyService.onDidChange(policyNames => this.onDidChangePolicies(policyNames)));
		this._register(this.defaultConfiguration.onDidChangeConfiguration(async ({ properties }) => {
			this.update(await this.updatePolicyDefinitions(properties), true, false);
			this.update(await this.applyInternalPolicy(properties), true, true);
		}));
		return this._configurationModel;
	}

	acquireContextKeyService(contextKeyService: IContextKeyService): void {
		this.logService.trace('PolicyConfiguration#acquireInstantiationService');
		this.contextKeyService = contextKeyService;


		// TODO: This doesn't work
		//       'abc' and 'def' are undefined and the debugger shows that contextKeyService is a 'proxy' value

		// this._register(this.contextKeyService.onDidChangeContext(() => {
		// 	this.logService.trace('PolicyConfiguration#onDidChangeContext');
		// 	this.updatePolicyDefinitions(this.configurationRegistry.getPolicyConfigurations().keys());
		// }));
		const abc = this.contextKeyService.getContextKeyValue<boolean>('github.copilot.previewFeaturesDisabled');
		const def = this.contextKeyService.getContextKeyValue<boolean>('github.copilot.debugReportFeedback');
		this.logService.trace('PolicyConfiguration#acquireInstantiationService', abc, def);
	}

	private async applyInternalPolicy(properties: string[]): Promise<string[]> {
		// TODO: Check context key here: https://github.com/microsoft/vscode-copilot/blob/main/src/extension/contextKeys/vscode-node/contextKeys.contribution.ts#L152-L163
		this.logService.trace('PolicyConfiguration#applyInternalPolicyRules', properties);
		const configurationProperties = this.configurationRegistry.getConfigurationProperties();
		const excludedConfigurationProperties = this.configurationRegistry.getExcludedConfigurationProperties();
		const keys: string[] = [];
		for (const property of properties) {
			if (property.startsWith('chat') || property.startsWith('github')) {
				const config = configurationProperties[property] ?? excludedConfigurationProperties[property];
				const { tags } = config;
				if (tags && (tags.includes('experimental') || tags.includes('preview'))) {
					keys.push(property);
				}
			}
		}
		return keys;
	}

	private async updatePolicyDefinitions(properties: string[]): Promise<string[]> {
		this.logService.trace('PolicyConfiguration#updatePolicyDefinitions', properties);
		const policyDefinitions: IStringDictionary<PolicyDefinition> = {};
		const keys: string[] = [];
		const configurationProperties = this.configurationRegistry.getConfigurationProperties();
		const excludedConfigurationProperties = this.configurationRegistry.getExcludedConfigurationProperties();

		for (const key of properties) {
			const config = configurationProperties[key] ?? excludedConfigurationProperties[key];
			if (!config) {
				// Config is removed. So add it to the list if in case it was registered as policy before
				keys.push(key);
				continue;
			}
			if (config.policy) {
				if (config.type !== 'string' && config.type !== 'number' && config.type !== 'array' && config.type !== 'object' && config.type !== 'boolean') {
					this.logService.warn(`Policy ${config.policy.name} has unsupported type ${config.type}`);
					continue;
				}
				keys.push(key);
				policyDefinitions[config.policy.name] = { type: config.type === 'number' ? 'number' : config.type === 'boolean' ? 'boolean' : 'string' };
			}
		}

		if (!isEmptyObject(policyDefinitions)) {
			await this.policyService.updatePolicyDefinitions(policyDefinitions);
		}

		return keys;
	}

	private onDidChangePolicies(policyNames: readonly PolicyName[]): void {
		this.logService.trace('PolicyConfiguration#onDidChangePolicies', policyNames);
		const policyConfigurations = this.configurationRegistry.getPolicyConfigurations();
		const keys = coalesce(policyNames.map(policyName => policyConfigurations.get(policyName)));
		this.update(keys, true, false);
	}

	private update(keys: string[], trigger: boolean, internal: boolean): void {
		this.logService.trace('PolicyConfiguration#update', keys);
		const configurationProperties = this.configurationRegistry.getConfigurationProperties();
		const excludedConfigurationProperties = this.configurationRegistry.getExcludedConfigurationProperties();
		const changed: [string, any][] = [];
		const wasEmpty = this._configurationModel.isEmpty();

		for (const key of keys) {
			const proprety = configurationProperties[key] ?? excludedConfigurationProperties[key];
			const policyName = proprety?.policy?.name;
			if (policyName) {
				let policyValue = this.policyService.getPolicyValue(policyName);
				if (isString(policyValue) && proprety.type !== 'string') {
					try {
						policyValue = this.parse(policyValue);
					} catch (e) {
						this.logService.error(`Error parsing policy value ${policyName}:`, getErrorMessage(e));
						continue;
					}
				}
				if (wasEmpty ? policyValue !== undefined : !equals(this._configurationModel.getValue(key), policyValue)) {
					changed.push([key, policyValue]);
				}
			} else if (internal) {
				let disabledValue = undefined;
				// TODO: Think more about what 'disabled' means, just roll with this for now.
				switch (proprety.type) {
					case 'boolean':
						disabledValue = false;
						break;
					case 'array':
						disabledValue = [];
						break;
					case 'object':
						disabledValue = {};
						break;
					// default:
					// disabledValue = undefined;
				}
				if (wasEmpty ? disabledValue !== undefined : !equals(this._configurationModel.getValue(key), disabledValue)) {
					changed.push([key, disabledValue]);
				}
			} else {
				if (this._configurationModel.getValue(key) !== undefined) {
					changed.push([key, undefined]);
				}
			}
		}

		if (changed.length) {
			this.logService.trace('PolicyConfiguration#changed', changed);
			const old = this._configurationModel;
			this._configurationModel = ConfigurationModel.createEmptyModel(this.logService);
			for (const key of old.keys) {
				this._configurationModel.setValue(key, old.getValue(key));
			}
			for (const [key, policyValue] of changed) {
				if (policyValue === undefined) {
					this._configurationModel.removeValue(key);
				} else {
					this._configurationModel.setValue(key, policyValue);
				}
			}
			if (trigger) {
				this._onDidChangeConfiguration.fire(this._configurationModel);
			}
		}
	}

	private parse(content: string): any {
		let raw: any = {};
		let currentProperty: string | null = null;
		let currentParent: any = [];
		const previousParents: any[] = [];
		const parseErrors: json.ParseError[] = [];

		function onValue(value: any) {
			if (Array.isArray(currentParent)) {
				(<any[]>currentParent).push(value);
			} else if (currentProperty !== null) {
				if (currentParent[currentProperty] !== undefined) {
					throw new Error(`Duplicate property found: ${currentProperty}`);
				}
				currentParent[currentProperty] = value;
			}
		}

		const visitor: json.JSONVisitor = {
			onObjectBegin: () => {
				const object = {};
				onValue(object);
				previousParents.push(currentParent);
				currentParent = object;
				currentProperty = null;
			},
			onObjectProperty: (name: string) => {
				currentProperty = name;
			},
			onObjectEnd: () => {
				currentParent = previousParents.pop();
			},
			onArrayBegin: () => {
				const array: any[] = [];
				onValue(array);
				previousParents.push(currentParent);
				currentParent = array;
				currentProperty = null;
			},
			onArrayEnd: () => {
				currentParent = previousParents.pop();
			},
			onLiteralValue: onValue,
			onError: (error: json.ParseErrorCode, offset: number, length: number) => {
				parseErrors.push({ error, offset, length });
			}
		};

		if (content) {
			json.visit(content, visitor);
			raw = currentParent[0] || {};
		}

		if (parseErrors.length > 0) {
			throw new Error(parseErrors.map(e => getErrorMessage(e.error)).join('\n'));
		}

		return raw;
	}
}
