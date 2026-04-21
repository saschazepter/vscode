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
import { AgentHostFilterConnectionStatus } from '../../common/agentHostFilter.js';

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

	test('defaults to undefined when no selection persisted and no hosts', () => {
		const stub = new StubRemoteAgentHostService();
		const service = createService(stub);
		assert.strictEqual(service.selectedProviderId, undefined);
		assert.deepStrictEqual([...service.hosts], []);
	});

	test('defaults to first host when none persisted', () => {
		const stub = new StubRemoteAgentHostService();
		stub.connections = [connection('localhost:9999', 'Host B')];
		stub.configuredEntries = [entry('localhost:4321', 'Host A')];
		const service = createService(stub);
		// Hosts are sorted alphabetically by label, so "Host A" comes first.
		assert.strictEqual(service.selectedProviderId, pid('localhost:4321'));
	});

	test('merges connections and configured entries, preferring live info', () => {
		const stub = new StubRemoteAgentHostService();
		stub.connections = [connection('localhost:4321', 'Host A')];
		stub.configuredEntries = [
			entry('localhost:4321', 'Host A (stale name)'),
			entry('localhost:9999', 'Host B'),
		];
		const service = createService(stub);

		const hosts = [...service.hosts].map(h => ({ label: h.label, status: h.status, providerId: h.providerId }));
		assert.deepStrictEqual(hosts, [
			{ label: 'Host A', status: AgentHostFilterConnectionStatus.Connected, providerId: pid('localhost:4321') },
			{ label: 'Host B', status: AgentHostFilterConnectionStatus.Disconnected, providerId: pid('localhost:9999') },
		]);
	});

	test('setSelectedProviderId persists and fires change', () => {
		const stub = new StubRemoteAgentHostService();
		stub.connections = [
			connection('localhost:4321', 'Host A'),
			connection('localhost:9999', 'Host B'),
		];
		const storage = new InMemoryStorageService();
		const service = createService(stub, storage);

		let events = 0;
		store.add(service.onDidChange(() => events++));

		service.setSelectedProviderId(pid('localhost:9999'));
		assert.strictEqual(service.selectedProviderId, pid('localhost:9999'));
		assert.strictEqual(events, 1);

		// Recreate service with same storage — selection should persist
		const service2 = store.add(new AgentHostFilterService(stub as unknown as IRemoteAgentHostService, storage));
		assert.strictEqual(service2.selectedProviderId, pid('localhost:9999'));
	});

	test('falls back to first remaining host when selected host disappears', () => {
		const stub = new StubRemoteAgentHostService();
		stub.connections = [
			connection('localhost:4321', 'Host A'),
			connection('localhost:9999', 'Host B'),
		];
		const service = createService(stub);

		service.setSelectedProviderId(pid('localhost:9999'));
		assert.strictEqual(service.selectedProviderId, pid('localhost:9999'));

		// Remove Host B — selection should fall back to Host A (first remaining).
		stub.update([connection('localhost:4321', 'Host A')], []);
		assert.strictEqual(service.selectedProviderId, pid('localhost:4321'));

		// Remove all hosts — selection should become undefined.
		stub.update([], []);
		assert.strictEqual(service.selectedProviderId, undefined);
	});

	test('setSelectedProviderId ignores unknown hosts', () => {
		const stub = new StubRemoteAgentHostService();
		stub.connections = [connection('localhost:4321', 'Host A')];
		const service = createService(stub);
		// Default selection is the first (only) host.
		assert.strictEqual(service.selectedProviderId, pid('localhost:4321'));
		service.setSelectedProviderId('agenthost-nonexistent');
		assert.strictEqual(service.selectedProviderId, pid('localhost:4321'));
	});
});
