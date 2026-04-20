/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { agentHostAuthority } from '../../../../../platform/agentHost/common/agentHostUri.js';
import { IRemoteAgentHostConnectionInfo, IRemoteAgentHostEntry, IRemoteAgentHostService, RemoteAgentHostConnectionStatus, RemoteAgentHostEntryType } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { InMemoryStorageService, IStorageService } from '../../../../../platform/storage/common/storage.js';
import { AgentHostFilterService } from '../../browser/agentHostFilterService.js';
import { ALL_HOSTS_FILTER } from '../../common/agentHostFilter.js';

class StubRemoteAgentHostService implements Partial<IRemoteAgentHostService> {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeConnections = new Emitter<void>();
	readonly onDidChangeConnections = this._onDidChangeConnections.event;

	connections: readonly IRemoteAgentHostConnectionInfo[] = [];
	configuredEntries: readonly IRemoteAgentHostEntry[] = [];

	update(
		connections: readonly IRemoteAgentHostConnectionInfo[],
		configuredEntries: readonly IRemoteAgentHostEntry[] = [],
	): void {
		this.connections = connections;
		this.configuredEntries = configuredEntries;
		this._onDidChangeConnections.fire();
	}
}

function connection(address: string, name: string, status = RemoteAgentHostConnectionStatus.Connected): IRemoteAgentHostConnectionInfo {
	return { address, name, clientId: `client-${address}`, status };
}

function entry(address: string, name: string): IRemoteAgentHostEntry {
	return { name, connection: { type: RemoteAgentHostEntryType.WebSocket, address } };
}

function pid(address: string): string {
	return `agenthost-${agentHostAuthority(address)}`;
}

suite('AgentHostFilterService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(stub: StubRemoteAgentHostService, storage = new InMemoryStorageService()) {
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IRemoteAgentHostService, stub as unknown as IRemoteAgentHostService);
		instantiationService.stub(IStorageService, storage);
		return store.add(instantiationService.createInstance(AgentHostFilterService));
	}

	test('defaults to ALL when no selection persisted and no hosts', () => {
		const stub = new StubRemoteAgentHostService();
		const service = createService(stub);
		assert.strictEqual(service.selectedProviderId, ALL_HOSTS_FILTER);
		assert.deepStrictEqual([...service.hosts], []);
	});

	test('merges connections and configured entries, preferring live info', () => {
		const stub = new StubRemoteAgentHostService();
		stub.connections = [connection('localhost:4321', 'Host A')];
		stub.configuredEntries = [
			entry('localhost:4321', 'Host A (stale name)'),
			entry('localhost:9999', 'Host B'),
		];
		const service = createService(stub);

		const hosts = [...service.hosts].map(h => ({ label: h.label, connected: h.connected, providerId: h.providerId }));
		assert.deepStrictEqual(hosts, [
			{ label: 'Host A', connected: true, providerId: pid('localhost:4321') },
			{ label: 'Host B', connected: false, providerId: pid('localhost:9999') },
		]);
	});

	test('setSelectedProviderId persists and fires change', () => {
		const stub = new StubRemoteAgentHostService();
		stub.connections = [connection('localhost:4321', 'Host A')];
		const storage = new InMemoryStorageService();
		const service = createService(stub, storage);

		let events = 0;
		store.add(service.onDidChange(() => events++));

		service.setSelectedProviderId(pid('localhost:4321'));
		assert.strictEqual(service.selectedProviderId, pid('localhost:4321'));
		assert.strictEqual(events, 1);

		// Recreate service with same storage — selection should persist
		const service2 = store.add(new AgentHostFilterService(stub as unknown as IRemoteAgentHostService, storage));
		assert.strictEqual(service2.selectedProviderId, pid('localhost:4321'));
	});

	test('falls back to ALL when selected host disappears', () => {
		const stub = new StubRemoteAgentHostService();
		stub.connections = [connection('localhost:4321', 'Host A')];
		const service = createService(stub);

		service.setSelectedProviderId(pid('localhost:4321'));
		assert.strictEqual(service.selectedProviderId, pid('localhost:4321'));

		// Disconnect + remove configured entry
		stub.update([], []);
		assert.strictEqual(service.selectedProviderId, ALL_HOSTS_FILTER);
	});

	test('setSelectedProviderId ignores unknown hosts', () => {
		const stub = new StubRemoteAgentHostService();
		stub.connections = [connection('localhost:4321', 'Host A')];
		const service = createService(stub);
		service.setSelectedProviderId('agenthost-nonexistent');
		assert.strictEqual(service.selectedProviderId, ALL_HOSTS_FILTER);
	});
});
