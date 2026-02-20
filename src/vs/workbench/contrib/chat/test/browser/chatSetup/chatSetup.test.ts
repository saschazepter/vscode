/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../../platform/log/common/log.js';
import { EnablementState } from '../../../../../services/extensionManagement/common/extensionManagement.js';
import { IExtension, IExtensionsWorkbenchService } from '../../../../extensions/common/extensions.js';
import { maybeEnableAuthExtension } from '../../../../chat/browser/chatSetup/chatSetup.js';
import product from '../../../../../../platform/product/common/product.js';

function createMockExtension(id: string, enablementState: EnablementState): IExtension {
	return {
		identifier: { id },
		enablementState,
	} as IExtension;
}

function createMockExtensionsWorkbenchService(localExtensions: IExtension[]): IExtensionsWorkbenchService & { setEnablementCalls: [IExtension[], EnablementState][]; updateRunningExtensionsCalls: string[] } {
	const setEnablementCalls: [IExtension[], EnablementState][] = [];
	const updateRunningExtensionsCalls: string[] = [];

	return {
		local: localExtensions,
		setEnablementCalls,
		updateRunningExtensionsCalls,
		async setEnablement(extensions: IExtension[], enablementState: EnablementState): Promise<void> {
			setEnablementCalls.push([extensions, enablementState]);
		},
		async updateRunningExtensions(message?: string): Promise<void> {
			updateRunningExtensionsCalls.push(message ?? '');
		},
	} as IExtensionsWorkbenchService & { setEnablementCalls: [IExtension[], EnablementState][]; updateRunningExtensionsCalls: string[] };
}

suite('maybeEnableAuthExtension', () => {

	const logService = new NullLogService();
	const providerExtensionId = product.defaultChatAgent?.providerExtensionId ?? '';

	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns false when the extension is not found locally', async () => {
		const service = createMockExtensionsWorkbenchService([]);
		const result = await maybeEnableAuthExtension(service, logService);

		assert.strictEqual(result, false);
		assert.strictEqual(service.setEnablementCalls.length, 0);
	});

	test('returns false when the extension is already enabled globally', async () => {
		const extension = createMockExtension(providerExtensionId, EnablementState.EnabledGlobally);
		const service = createMockExtensionsWorkbenchService([extension]);
		const result = await maybeEnableAuthExtension(service, logService);

		assert.strictEqual(result, false);
		assert.strictEqual(service.setEnablementCalls.length, 0);
	});

	test('returns false when the extension is already enabled in workspace', async () => {
		const extension = createMockExtension(providerExtensionId, EnablementState.EnabledWorkspace);
		const service = createMockExtensionsWorkbenchService([extension]);
		const result = await maybeEnableAuthExtension(service, logService);

		assert.strictEqual(result, false);
		assert.strictEqual(service.setEnablementCalls.length, 0);
	});

	test('returns true and re-enables when extension is DisabledGlobally', async () => {
		const extension = createMockExtension(providerExtensionId, EnablementState.DisabledGlobally);
		const service = createMockExtensionsWorkbenchService([extension]);
		const result = await maybeEnableAuthExtension(service, logService);

		assert.strictEqual(result, true);
		assert.strictEqual(service.setEnablementCalls.length, 1);
		assert.deepStrictEqual(service.setEnablementCalls[0], [[extension], EnablementState.EnabledGlobally]);
		assert.strictEqual(service.updateRunningExtensionsCalls.length, 1);
	});

	test('returns true and re-enables when extension is DisabledWorkspace', async () => {
		const extension = createMockExtension(providerExtensionId, EnablementState.DisabledWorkspace);
		const service = createMockExtensionsWorkbenchService([extension]);
		const result = await maybeEnableAuthExtension(service, logService);

		assert.strictEqual(result, true);
		assert.strictEqual(service.setEnablementCalls.length, 1);
		assert.deepStrictEqual(service.setEnablementCalls[0], [[extension], EnablementState.EnabledGlobally]);
		assert.strictEqual(service.updateRunningExtensionsCalls.length, 1);
	});

	test('does not attempt to enable extensions in system-managed disabled states', async () => {
		for (const state of [
			EnablementState.DisabledByTrustRequirement,
			EnablementState.DisabledByExtensionKind,
			EnablementState.DisabledByEnvironment,
			EnablementState.DisabledByMalicious,
			EnablementState.DisabledByVirtualWorkspace,
			EnablementState.DisabledByInvalidExtension,
			EnablementState.DisabledByExtensionDependency,
		]) {
			const extension = createMockExtension(providerExtensionId, state);
			const service = createMockExtensionsWorkbenchService([extension]);
			const result = await maybeEnableAuthExtension(service, logService);

			assert.strictEqual(result, false, `Expected false for EnablementState ${state}`);
			assert.strictEqual(service.setEnablementCalls.length, 0, `Expected no setEnablement calls for EnablementState ${state}`);
		}
	});

	test('returns false and does not throw when setEnablement fails', async () => {
		const extension = createMockExtension(providerExtensionId, EnablementState.DisabledGlobally);
		const service = createMockExtensionsWorkbenchService([extension]);
		service.setEnablement = async () => { throw new Error('setEnablement failed'); };
		const result = await maybeEnableAuthExtension(service, logService);

		assert.strictEqual(result, false);
	});
});
