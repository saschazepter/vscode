/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IExtendedConfiguration, IExtendedTelemetryItem, ITelemetryItem, ITelemetryUnloadState } from '@microsoft/1ds-core-js';
import type { IChannelConfiguration, IXHROverride, PostChannel } from '@microsoft/1ds-post-js';
import { importAMDNodeModule } from '../../../amdX.js';
import { onUnexpectedError } from '../../../base/common/errors.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { mixin } from '../../../base/common/objects.js';
import { isWeb } from '../../../base/common/platform.js';
import { IMeteredConnectionService } from '../../meteredConnection/common/meteredConnection.js';
import { ITelemetryAppender, validateTelemetryData } from './telemetryUtils.js';

// Interface type which is a subset of @microsoft/1ds-core-js AppInsightsCore.
// Allows us to more easily build mock objects for testing as the interface is quite large and we only need a few properties.
export interface IAppInsightsCore {
	pluginVersionString: string;
	track(item: ITelemetryItem | IExtendedTelemetryItem): void;
	unload(isAsync: boolean, unloadComplete: (unloadState: ITelemetryUnloadState) => void): void;
}

const endpointUrl = 'https://mobile.events.data.microsoft.com/OneCollector/1.0';
const endpointHealthUrl = 'https://mobile.events.data.microsoft.com/ping';

async function getClient(instrumentationKey: string, addInternalFlag?: boolean, xhrOverride?: IXHROverride): Promise<IAppInsightsCore> {
	// eslint-disable-next-line local/code-amd-node-module
	const oneDs = isWeb ? await importAMDNodeModule<typeof import('@microsoft/1ds-core-js')>('@microsoft/1ds-core-js', 'bundle/ms.core.min.js') : await import('@microsoft/1ds-core-js');
	// eslint-disable-next-line local/code-amd-node-module
	const postPlugin = isWeb ? await importAMDNodeModule<typeof import('@microsoft/1ds-post-js')>('@microsoft/1ds-post-js', 'bundle/ms.post.min.js') : await import('@microsoft/1ds-post-js');

	const appInsightsCore = new oneDs.AppInsightsCore();
	const collectorChannelPlugin: PostChannel = new postPlugin.PostChannel();
	// Configure the app insights core to send to collector++ and disable logging of debug info
	const coreConfig: IExtendedConfiguration = {
		instrumentationKey,
		endpointUrl,
		loggingLevelTelemetry: 0,
		loggingLevelConsole: 0,
		disableCookiesUsage: true,
		disableDbgExt: true,
		disableInstrumentationKeyValidation: true,
		channels: [[
			collectorChannelPlugin
		]]
	};

	if (xhrOverride) {
		coreConfig.extensionConfig = {};
		// Configure the channel to use a XHR Request override since it's not available in node
		const channelConfig: IChannelConfiguration = {
			alwaysUseXhrOverride: true,
			ignoreMc1Ms0CookieProcessing: true,
			httpXHROverride: xhrOverride
		};
		coreConfig.extensionConfig[collectorChannelPlugin.identifier] = channelConfig;
	}

	appInsightsCore.initialize(coreConfig, []);

	appInsightsCore.addTelemetryInitializer((envelope) => {
		// Opt the user out of 1DS data sharing
		envelope['ext'] = envelope['ext'] ?? {};
		envelope['ext']['web'] = envelope['ext']['web'] ?? {};
		envelope['ext']['web']['consentDetails'] = '{"GPC_DataSharingOptIn":false}';

		if (addInternalFlag) {
			envelope['ext']['utc'] = envelope['ext']['utc'] ?? {};
			// Sets it to be internal only based on Windows UTC flagging
			envelope['ext']['utc']['flags'] = 0x0000811ECD;
		}
	});

	return appInsightsCore;
}

interface IBufferedEvent {
	eventName: string;
	data: unknown;
}

// TODO @lramos15 maybe make more in line with src/vs/platform/telemetry/browser/appInsightsAppender.ts with caching support
export abstract class AbstractOneDataSystemAppender extends Disposable implements ITelemetryAppender {

	private static readonly MAX_BUFFER_SIZE = 1000;

	protected _aiCoreOrKey: IAppInsightsCore | string | undefined;
	private _asyncAiCore: Promise<IAppInsightsCore> | null;
	protected readonly endPointUrl = endpointUrl;
	protected readonly endPointHealthUrl = endpointHealthUrl;

	private readonly _meteredConnectionService: IMeteredConnectionService | undefined;
	private _meteredBufferedEvents: IBufferedEvent[] = [];

	constructor(
		private readonly _isInternalTelemetry: boolean,
		private _eventPrefix: string,
		private _defaultData: { [key: string]: unknown } | null,
		iKeyOrClientFactory: string | (() => IAppInsightsCore), // allow factory function for testing
		private _xhrOverride?: IXHROverride,
		meteredConnectionService?: IMeteredConnectionService
	) {
		super();

		if (!this._defaultData) {
			this._defaultData = {};
		}

		if (typeof iKeyOrClientFactory === 'function') {
			this._aiCoreOrKey = iKeyOrClientFactory();
		} else {
			this._aiCoreOrKey = iKeyOrClientFactory;
		}
		this._asyncAiCore = null;

		// Set up metered connection handling - buffer events when metered, flush when recovered
		this._meteredConnectionService = meteredConnectionService;
		if (this._meteredConnectionService) {
			this._register(this._meteredConnectionService.onDidChangeIsConnectionMetered(() => {
				if (!this._meteredConnectionService!.isConnectionMetered) {
					this._flushMeteredBufferedEvents();
				}
			}));
		}
	}

	private _withAIClient(callback: (aiCore: IAppInsightsCore) => void): void {
		if (!this._aiCoreOrKey) {
			return;
		}

		if (typeof this._aiCoreOrKey !== 'string') {
			callback(this._aiCoreOrKey);
			return;
		}

		if (!this._asyncAiCore) {
			this._asyncAiCore = getClient(this._aiCoreOrKey, this._isInternalTelemetry, this._xhrOverride);
		}

		this._asyncAiCore.then(
			(aiClient) => {
				callback(aiClient);
			},
			(err) => {
				onUnexpectedError(err);
				console.error(err);
			}
		);
	}

	log(eventName: string, data?: unknown): void {
		if (!this._aiCoreOrKey) {
			return;
		}

		// Buffer events when connection is metered
		if (this._meteredConnectionService?.isConnectionMetered) {
			if (this._meteredBufferedEvents.length < AbstractOneDataSystemAppender.MAX_BUFFER_SIZE) {
				this._meteredBufferedEvents.push({ eventName, data });
			}
			return;
		}

		this._doLog(eventName, data);
	}

	private _doLog(eventName: string, data?: unknown): void {
		if (!this._aiCoreOrKey) {
			return;
		}

		data = mixin(data, this._defaultData);
		const validatedData = validateTelemetryData(data);
		const name = this._eventPrefix + '/' + eventName;

		try {
			this._withAIClient((aiClient) => {
				aiClient.pluginVersionString = validatedData?.properties.version ?? 'Unknown';
				aiClient.track({
					name,
					baseData: { name, properties: validatedData?.properties, measurements: validatedData?.measurements }
				});
			});
		} catch { }
	}

	private _flushMeteredBufferedEvents(): void {
		for (const event of this._meteredBufferedEvents) {
			this._doLog(event.eventName, event.data);
		}
		this._meteredBufferedEvents = [];
	}

	flush(): Promise<void> {
		// Flush any remaining buffered events before disposing
		this._flushMeteredBufferedEvents();

		if (this._aiCoreOrKey) {
			return new Promise(resolve => {
				this._withAIClient((aiClient) => {
					aiClient.unload(true, () => {
						this._aiCoreOrKey = undefined;
						resolve(undefined);
					});
				});
			});
		}
		return Promise.resolve(undefined);
	}

	override dispose(): void {
		this.flush();
		super.dispose();
	}
}
