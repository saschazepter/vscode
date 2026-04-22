/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../instantiation/test/common/instantiationServiceMock.js';
import { ISharedProcessService } from '../../../ipc/electron-browser/services.js';
import { NullLogService } from '../../../log/common/log.js';
import { SSHRemoteAgentHostService } from '../../electron-browser/sshRemoteAgentHostServiceImpl.js';
import { IRemoteAgentHostConnectionInfo, IRemoteAgentHostEntry, IRemoteAgentHostService } from '../../common/remoteAgentHostService.js';
import { getSSHConnectionKey, ISSHAgentHostConfig, ISSHConnectResult, ISSHRelayMessage, ISSHRemoteAgentHostMainService, SSHAuthMethod } from '../../common/sshRemoteAgentHost.js';
import type { RemoteAgentHostProtocolClient } from '../../browser/remoteAgentHostProtocolClient.js';
import type { IAgentConnection } from '../../common/agentService.js';

/**
 * Records every call to `connect()` along with the `replaceRelay` argument so tests
 * can assert that the renderer always passes `replaceRelay: true` when it has no
 * local handle (the regression that produced "Unknown method: initialize" after a
 * window reload).
 */
class MockMainService implements Partial<ISSHRemoteAgentHostMainService> {
	private readonly _onDidChangeConnections = new Emitter<void>();
	readonly onDidChangeConnections = this._onDidChangeConnections.event;
	readonly closeEmitter = new Emitter<string>();
	readonly onDidCloseConnection = this.closeEmitter.event;
	private readonly _onDidReportConnectProgress = new Emitter<{ connectionKey: string; message: string }>();
	readonly onDidReportConnectProgress = this._onDidReportConnectProgress.event;
	private readonly _onDidRelayMessage = new Emitter<ISSHRelayMessage>();
	readonly onDidRelayMessage = this._onDidRelayMessage.event;
	private readonly _onDidRelayClose = new Emitter<string>();
	readonly onDidRelayClose = this._onDidRelayClose.event;

	readonly connectCalls: { config: ISSHAgentHostConfig; replaceRelay: boolean | undefined }[] = [];
	readonly disconnectCalls: string[] = [];

	async connect(config: ISSHAgentHostConfig, replaceRelay?: boolean): Promise<ISSHConnectResult> {
		this.connectCalls.push({ config, replaceRelay });
		const key = getSSHConnectionKey(config);
		return {
			connectionId: key,
			address: `ssh:${config.host}`,
			name: config.name,
			connectionToken: 'tok',
			config: { host: config.host, port: config.port, username: config.username, authMethod: config.authMethod, name: config.name, sshConfigHost: config.sshConfigHost },
			sshConfigHost: config.sshConfigHost,
		};
	}

	async disconnect(host: string): Promise<void> { this.disconnectCalls.push(host); }
	async relaySend(): Promise<void> { }
	async listSSHConfigHosts(): Promise<string[]> { return []; }
	async resolveSSHConfig(): Promise<never> { throw new Error('not implemented'); }
	async reconnect(): Promise<never> { throw new Error('not implemented'); }

	dispose(): void {
		this._onDidChangeConnections.dispose();
		this.closeEmitter.dispose();
		this._onDidReportConnectProgress.dispose();
		this._onDidRelayMessage.dispose();
		this._onDidRelayClose.dispose();
	}
}

class FakeProtocolClient extends Disposable {
	connectCalled = 0;
	async connect(): Promise<void> { this.connectCalled++; }
}

class StubRemoteAgentHostService implements Partial<IRemoteAgentHostService> {
	readonly addedEntries: IRemoteAgentHostEntry[] = [];
	async addSSHConnection(entry: IRemoteAgentHostEntry, _connection: IAgentConnection): Promise<IRemoteAgentHostConnectionInfo> {
		this.addedEntries.push(entry);
		return { entry, connection: _connection } as unknown as IRemoteAgentHostConnectionInfo;
	}
}

/**
 * Subclass that bypasses ProxyChannel construction by overwriting the protected
 * `_mainService` field after `super(...)` runs, and replaces protocol client
 * creation with a fake so we don't need a live transport.
 */
class TestableSSHRemoteAgentHostService extends SSHRemoteAgentHostService {
	readonly fakeClients: FakeProtocolClient[] = [];

	constructor(
		mainServiceMock: MockMainService,
		remoteAgentHostService: IRemoteAgentHostService,
	) {
		const noopChannel: IChannel = {
			call: <T>() => Promise.resolve() as Promise<T>,
			listen: () => Event.None,
		};
		const sharedProcessService: ISharedProcessService = {
			_serviceBrand: undefined,
			getChannel: () => noopChannel,
			registerChannel: () => { },
			notifyRestored: () => { },
			createRawConnection: () => { throw new Error('not implemented'); },
		} as unknown as ISharedProcessService;
		const instantiationService = new TestInstantiationService();
		const configService = new TestConfigurationService();
		super(sharedProcessService, remoteAgentHostService, new NullLogService(), instantiationService, configService);
		// Replace the ProxyChannel-built service with our mock.
		const self = this as unknown as IMutableRendererService;
		self._mainService = mainServiceMock as unknown as ISSHRemoteAgentHostMainService;
		// onDidReportConnectProgress was bound from the no-op channel; rebind to mock.
		self.onDidReportConnectProgress = mainServiceMock.onDidReportConnectProgress;
		// Re-wire the close listener that the parent ctor registered against the no-op channel.
		this._register(mainServiceMock.onDidCloseConnection(connectionId => {
			const conns = self._connections;
			const handle = conns.get(connectionId);
			if (handle) { conns.delete(connectionId); handle.fireClose(); handle.dispose(); }
		}));
	}

	protected override _createRelayClient(_result: { connectionId: string; address: string }): RemoteAgentHostProtocolClient {
		const fake = this._register(new FakeProtocolClient());
		this.fakeClients.push(fake);
		return fake as unknown as RemoteAgentHostProtocolClient;
	}
}

/** Test-only view of SSHRemoteAgentHostService private state for fixture setup. */
interface IMutableRendererService {
	_mainService: ISSHRemoteAgentHostMainService;
	onDidReportConnectProgress: Event<{ connectionKey: string; message: string }>;
	readonly _connections: Map<string, { fireClose(): void; dispose(): void }>;
}

function makeConfig(overrides: Partial<ISSHAgentHostConfig> = {}): ISSHAgentHostConfig {
	return {
		host: 'macbook-air.local',
		username: 'rob',
		authMethod: SSHAuthMethod.Agent,
		name: 'macbook-air',
		sshConfigHost: 'macbook-air',
		...overrides,
	};
}

suite('SSHRemoteAgentHostService (renderer)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const main = new MockMainService();
		store.add(toDisposable(() => main.dispose()));
		const remote = new StubRemoteAgentHostService();
		const service = store.add(new TestableSSHRemoteAgentHostService(main, remote as unknown as IRemoteAgentHostService));
		return { main, remote, service };
	}

	test('connect on a fresh renderer always passes replaceRelay=true so the server gets a fresh transport (regression: "Unknown method: initialize" after window reload)', async () => {
		const { main, service } = setup();

		await service.connect(makeConfig());

		assert.deepStrictEqual(
			main.connectCalls.map(c => ({ key: getSSHConnectionKey(c.config), replaceRelay: c.replaceRelay })),
			[{ key: 'ssh:macbook-air', replaceRelay: true }],
		);
	});

	test('repeated connect calls short-circuit on the existing local handle without calling the main process again', async () => {
		const { main, service } = setup();

		const first = await service.connect(makeConfig());
		const second = await service.connect(makeConfig());

		assert.strictEqual(second, first, 'should return the same handle');
		assert.strictEqual(main.connectCalls.length, 1, 'main.connect should only be called once');
	});

	test('connect computes the same key as the main process, so result.connectionId matches the local handle key', async () => {
		const { main, service } = setup();

		const handle = await service.connect(makeConfig({ sshConfigHost: undefined, port: 2222 }));
		const expectedKey = getSSHConnectionKey({ ...makeConfig({ sshConfigHost: undefined, port: 2222 }) });

		// Returned handle and the main-side connectionId both use the same key, so a follow-up connect short-circuits.
		assert.strictEqual(main.connectCalls[0].replaceRelay, true);
		assert.strictEqual(handle.name, 'macbook-air');
		// Key parity: a second connect must short-circuit (proves the renderer's expectedKey matches result.connectionId).
		await service.connect(makeConfig({ sshConfigHost: undefined, port: 2222 }));
		assert.strictEqual(main.connectCalls.length, 1, `expected single main call when key=${expectedKey}`);
	});

	test('after main reports onDidCloseConnection the local handle is dropped and the next connect calls main again with replaceRelay=true', async () => {
		const { main, service } = setup();

		await service.connect(makeConfig());
		// Simulate the main process closing the connection (e.g., explicit disconnect, or loss).
		main.closeEmitter.fire('ssh:macbook-air');

		await service.connect(makeConfig());
		assert.deepStrictEqual(
			main.connectCalls.map(c => c.replaceRelay),
			[true, true],
		);
	});
});
