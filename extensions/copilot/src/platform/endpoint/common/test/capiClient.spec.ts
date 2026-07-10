/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CAPIClient } from '@vscode/copilot-api';
import { describe, expect, it, vi } from 'vitest';
import { BaseCAPIClientService } from '../capiClient';
import { IEnvService } from '../../../env/common/envService';
import { IFetcherService, WebSocketConnection } from '../../../networking/common/fetcherService';

class TestCAPIClientService extends BaseCAPIClientService {
	constructor() {
		const mockFetcherService = {} as IFetcherService;
		const mockEnvService = {
			machineId: 'test-machine',
			devDeviceId: 'test-device',
			sessionId: 'test-session',
			vscodeVersion: '1.0.0',
			getBuildType: () => 'dev',
			getName: () => 'test',
			getVersion: () => '1.0.0',
		} as unknown as IEnvService;
		super(undefined, undefined, mockFetcherService, mockEnvService);
	}
}

describe('BaseCAPIClientService', () => {
	describe('createResponsesWebSocket', () => {
		it('should inject X-Copilot-Client-Exp-Assignment-Context header when abExpContext is set', async () => {
			const service = new TestCAPIClientService();
			service.abExpContext = 'test-assignment-context';

			const capturedOptions: { headers?: Record<string, string> }[] = [];
			const mockConnection = {} as WebSocketConnection;
			vi.spyOn(CAPIClient.prototype, 'createResponsesWebSocket')
				.mockImplementation(async function (this: CAPIClient, options: { headers?: Record<string, string> }) {
					capturedOptions.push(options);
					return mockConnection;
				});

			await service.createResponsesWebSocket({ headers: { 'X-Request-Id': 'req-1' } });

			expect(capturedOptions).toHaveLength(1);
			expect(capturedOptions[0].headers).toEqual({
				'X-Request-Id': 'req-1',
				'X-Copilot-Client-Exp-Assignment-Context': 'test-assignment-context',
			});
		});

		it('should create headers object when none exists and abExpContext is set', async () => {
			const service = new TestCAPIClientService();
			service.abExpContext = 'test-assignment-context';

			const capturedOptions: { headers?: Record<string, string> }[] = [];
			const mockConnection = {} as WebSocketConnection;
			vi.spyOn(CAPIClient.prototype, 'createResponsesWebSocket')
				.mockImplementation(async function (this: CAPIClient, options: { headers?: Record<string, string> }) {
					capturedOptions.push(options);
					return mockConnection;
				});

			await service.createResponsesWebSocket({});

			expect(capturedOptions).toHaveLength(1);
			expect(capturedOptions[0].headers).toEqual({
				'X-Copilot-Client-Exp-Assignment-Context': 'test-assignment-context',
			});
		});

		it('should not modify headers when abExpContext is not set', async () => {
			const service = new TestCAPIClientService();
			service.abExpContext = undefined;

			const capturedOptions: { headers?: Record<string, string> }[] = [];
			const mockConnection = {} as WebSocketConnection;
			vi.spyOn(CAPIClient.prototype, 'createResponsesWebSocket')
				.mockImplementation(async function (this: CAPIClient, options: { headers?: Record<string, string> }) {
					capturedOptions.push(options);
					return mockConnection;
				});

			await service.createResponsesWebSocket({ headers: { 'X-Request-Id': 'req-1' } });

			expect(capturedOptions).toHaveLength(1);
			expect(capturedOptions[0].headers).toEqual({
				'X-Request-Id': 'req-1',
			});
		});
	});
});
