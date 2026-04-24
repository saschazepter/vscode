/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import { RemoteAgentHostConnectionStatus, IRemoteAgentHostService } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { TestStorageService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { IPreferencesService } from '../../../../../workbench/services/preferences/common/preferences.js';
import { IOutputService } from '../../../../../workbench/services/output/common/output.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { extUri } from '../../../../../base/common/resources.js';
import { ISessionsProvidersChangeEvent, ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsProvider } from '../../../../services/sessions/common/sessionsProvider.js';
import { IAgentHostSessionsProvider } from '../../../../common/agentHostSessionsProvider.js';
import { ISessionWorkspace } from '../../../../services/sessions/common/session.js';
import { WorkspacePicker, IWorkspaceSelection } from '../../browser/sessionWorkspacePicker.js';
import { IWorkspacesService } from '../../../../../platform/workspaces/common/workspaces.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';

// ---- Storage key (must match the one in sessionWorkspacePicker.ts) ----------
const STORAGE_KEY_RECENT_WORKSPACES = 'sessions.recentlyPickedWorkspaces';

// ---- Mock providers ---------------------------------------------------------

function createMockProvider(id: string, opts?: {
	connectionStatus?: ISettableObservable<RemoteAgentHostConnectionStatus>;
}): ISessionsProvider {
	const base = {
		id,
		label: `Provider ${id}`,
		icon: Codicon.remote,
		sessionTypes: [],
		onDidChangeSessionTypes: Event.None,
		browseActions: [],
		resolveWorkspace: (uri: URI): ISessionWorkspace => ({
			label: uri.path.substring(1) || uri.path,
			icon: Codicon.folder,
			repositories: [{ uri, workingDirectory: undefined, detail: undefined, baseBranchName: undefined, baseBranchProtected: undefined }],
			requiresWorkspaceTrust: false,
		}),
		onDidChangeSessions: Event.None,
		getSessions: () => [],
		createNewSession: () => { throw new Error('Not implemented'); },
		getSessionTypes: () => [],
		renameChat: async () => { },
		setModel: () => { },
		archiveSession: async () => { },
		unarchiveSession: async () => { },
		deleteSession: async () => { },
		deleteChat: async () => { },
		sendAndCreateChat: async () => { throw new Error('Not implemented'); },
		addChat: () => { throw new Error('Not implemented'); },
		sendRequest: async () => { throw new Error('Not implemented'); },
	};
	if (opts?.connectionStatus) {
		return {
			...base,
			connectionStatus: opts.connectionStatus,
			onDidChangeSessionConfig: Event.None,
			getSessionConfig: () => undefined,
			setSessionConfigValue: async () => { },
			replaceSessionConfig: async () => { },
			getSessionConfigCompletions: async () => [],
			getCreateSessionConfig: () => undefined,
			clearSessionConfig: () => { },
			onDidChangeRootConfig: Event.None,
			getRootConfig: () => undefined,
			setRootConfigValue: async () => { },
			replaceRootConfig: async () => { },
		} as unknown as IAgentHostSessionsProvider;
	}
	return base;
}

class MockSessionsProvidersService extends Disposable {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeProviders = this._register(new Emitter<ISessionsProvidersChangeEvent>());
	readonly onDidChangeProviders: Event<ISessionsProvidersChangeEvent> = this._onDidChangeProviders.event;

	private _providers: ISessionsProvider[] = [];

	setProviders(providers: ISessionsProvider[]): void {
		const oldProviders = this._providers;
		this._providers = providers;
		const oldIds = new Set(oldProviders.map(p => p.id));
		const newIds = new Set(providers.map(p => p.id));
		this._onDidChangeProviders.fire({
			added: providers.filter(p => !oldIds.has(p.id)),
			removed: oldProviders.filter(p => !newIds.has(p.id)),
		});
	}

	getProviders(): ISessionsProvider[] {
		return this._providers;
	}

	getProvider<T extends ISessionsProvider>(providerId: string): T | undefined {
		return this._providers.find(p => p.id === providerId) as T | undefined;
	}
}

// ---- Test helpers -----------------------------------------------------------

function seedStorage(storageService: IStorageService, entries: { uri: URI; providerId: string; checked: boolean }[]): void {
	const stored = entries.map(e => ({
		uri: e.uri.toJSON(),
		providerId: e.providerId,
		checked: e.checked,
	}));
	storageService.store(STORAGE_KEY_RECENT_WORKSPACES, JSON.stringify(stored), StorageScope.PROFILE, StorageTarget.MACHINE);
}

function createTestPicker(
	disposables: DisposableStore,
	providersService: MockSessionsProvidersService,
	storageService?: IStorageService,
): WorkspacePicker {
	const instantiationService = disposables.add(new TestInstantiationService());
	const storage = storageService ?? disposables.add(new TestStorageService());

	instantiationService.stub(IActionWidgetService, { isVisible: false, hide: () => { }, show: () => { } });
	instantiationService.stub(IStorageService, storage);
	instantiationService.stub(IUriIdentityService, { extUri });
	instantiationService.stub(ISessionsProvidersService, providersService);
	instantiationService.stub(IRemoteAgentHostService, {});
	instantiationService.stub(IQuickInputService, {});
	instantiationService.stub(IClipboardService, {});
	instantiationService.stub(IPreferencesService, {});
	instantiationService.stub(IOutputService, {});
	instantiationService.stub(IConfigurationService, { getValue: () => undefined });
	instantiationService.stub(ICommandService, { executeCommand: async () => { } });
	instantiationService.stub(IWorkspacesService, {
		getRecentlyOpened: async () => ({ workspaces: [], files: [] }),
		onDidChangeRecentlyOpened: Event.None,
	});

	return disposables.add(instantiationService.createInstance(WorkspacePicker));
}

// ---- Assertion helpers ------------------------------------------------------

function assertSelectedProvider(picker: WorkspacePicker, expectedProviderId: string | undefined, message?: string): void {
	assert.strictEqual(picker.selectedProject?.providerId, expectedProviderId, message);
}

// ---- Tests ------------------------------------------------------------------

suite('WorkspacePicker - Connection Status', () => {

	const disposables = new DisposableStore();
	let providersService: MockSessionsProvidersService;

	setup(() => {
		providersService = new MockSessionsProvidersService();
		disposables.add(providersService);
	});

	teardown(() => {
		disposables.clear();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('restore picks checked entry even when remote is disconnected', () => {
		// We honor the user's explicit pick across connection state changes.
		// The trigger renders grayed/offline; the gear menu lets them reconnect.
		const remoteStatus = observableValue<RemoteAgentHostConnectionStatus>('status', RemoteAgentHostConnectionStatus.Disconnected);
		const remoteProvider = createMockProvider('agenthost-remote-1', { connectionStatus: remoteStatus });
		const localProvider = createMockProvider('local-1');

		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: URI.file('/remote/project'), providerId: 'agenthost-remote-1', checked: true },
			{ uri: URI.file('/local/project'), providerId: 'local-1', checked: false },
		]);

		providersService.setProviders([remoteProvider, localProvider]);
		const picker = createTestPicker(disposables, providersService, storage);

		assertSelectedProvider(picker, 'agenthost-remote-1');
	});

	test('restore picks checked entry while remote is connecting (no fallback flicker)', () => {
		// SSH remote: provider registers in Connecting state. We restore the
		// checked entry immediately rather than falling back to a different
		// workspace and swapping later.
		const remoteStatus = observableValue<RemoteAgentHostConnectionStatus>('status', RemoteAgentHostConnectionStatus.Connecting);
		const remoteProvider = createMockProvider('agenthost-remote-1', { connectionStatus: remoteStatus });
		const localProvider = createMockProvider('local-1');

		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: URI.file('/remote/project'), providerId: 'agenthost-remote-1', checked: true },
			{ uri: URI.file('/local/project'), providerId: 'local-1', checked: false },
		]);

		providersService.setProviders([remoteProvider, localProvider]);
		const picker = createTestPicker(disposables, providersService, storage);

		assertSelectedProvider(picker, 'agenthost-remote-1');

		// After connection completes, selection is unchanged.
		remoteStatus.set(RemoteAgentHostConnectionStatus.Connected, undefined);
		assertSelectedProvider(picker, 'agenthost-remote-1');
	});

	test('connecting provider that fails falls back to no selection', () => {
		// When a checked SSH workspace is restored, the provider starts in Connecting.
		// If the SSH tunnel fails (Disconnected), the picker must clear the selection
		// and fire onDidSelectWorkspace(undefined) so the view pane can call unsetNewSession().
		const remoteStatus = observableValue<RemoteAgentHostConnectionStatus>('status', RemoteAgentHostConnectionStatus.Connecting);
		const remoteProvider = createMockProvider('agenthost-remote-1', { connectionStatus: remoteStatus });

		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: URI.file('/remote/project'), providerId: 'agenthost-remote-1', checked: true },
		]);

		providersService.setProviders([remoteProvider]);
		const picker = createTestPicker(disposables, providersService, storage);

		assertSelectedProvider(picker, 'agenthost-remote-1', 'Selection is restored while connecting');

		const events: Array<IWorkspaceSelection | undefined> = [];
		disposables.add(picker.onDidSelectWorkspace(e => events.push(e)));

		// SSH tunnel fails.
		remoteStatus.set(RemoteAgentHostConnectionStatus.Disconnected, undefined);

		assertSelectedProvider(picker, undefined, 'Selection cleared after connection failure');
		assert.deepStrictEqual(events, [undefined], 'onDidSelectWorkspace fired with undefined');
	});

	test('restore picks connected remote provider', () => {
		const remoteStatus = observableValue<RemoteAgentHostConnectionStatus>('status', RemoteAgentHostConnectionStatus.Connected);
		const remoteProvider = createMockProvider('agenthost-remote-1', { connectionStatus: remoteStatus });

		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: URI.file('/remote/project'), providerId: 'agenthost-remote-1', checked: true },
		]);

		providersService.setProviders([remoteProvider]);
		const picker = createTestPicker(disposables, providersService, storage);

		assertSelectedProvider(picker, 'agenthost-remote-1');
	});

	test('disconnect preserves selection (renders grayed; no auto-clear)', () => {
		const remoteStatus = observableValue<RemoteAgentHostConnectionStatus>('status', RemoteAgentHostConnectionStatus.Connected);
		const remoteProvider = createMockProvider('agenthost-remote-1', { connectionStatus: remoteStatus });

		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: URI.file('/remote/project'), providerId: 'agenthost-remote-1', checked: true },
		]);

		providersService.setProviders([remoteProvider]);
		const picker = createTestPicker(disposables, providersService, storage);
		assertSelectedProvider(picker, 'agenthost-remote-1');

		// Disconnect — selection is preserved (the user picked it; we keep honoring it).
		remoteStatus.set(RemoteAgentHostConnectionStatus.Disconnected, undefined);
		assertSelectedProvider(picker, 'agenthost-remote-1', 'Selection should be preserved on disconnect');
	});

	test('reconnect keeps the selection (no extra event fires)', () => {
		const remoteStatus = observableValue<RemoteAgentHostConnectionStatus>('status', RemoteAgentHostConnectionStatus.Connected);
		const remoteProvider = createMockProvider('agenthost-remote-1', { connectionStatus: remoteStatus });

		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: URI.file('/remote/project'), providerId: 'agenthost-remote-1', checked: true },
		]);

		providersService.setProviders([remoteProvider]);
		const picker = createTestPicker(disposables, providersService, storage);
		assertSelectedProvider(picker, 'agenthost-remote-1');

		// Disconnect / reconnect cycle — selection preserved throughout.
		remoteStatus.set(RemoteAgentHostConnectionStatus.Disconnected, undefined);
		remoteStatus.set(RemoteAgentHostConnectionStatus.Connected, undefined);
		assertSelectedProvider(picker, 'agenthost-remote-1');
		assert.strictEqual(
			picker.selectedProject?.workspace.repositories[0]?.uri.path,
			'/remote/project',
		);
	});

	test('checked is globally unique after persist', () => {
		const localProvider = createMockProvider('local-1');
		const remoteStatus = observableValue<RemoteAgentHostConnectionStatus>('status', RemoteAgentHostConnectionStatus.Connected);
		const remoteProvider = createMockProvider('agenthost-remote-1', { connectionStatus: remoteStatus });

		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: URI.file('/remote/project'), providerId: 'agenthost-remote-1', checked: true },
			{ uri: URI.file('/local/project'), providerId: 'local-1', checked: false },
		]);

		providersService.setProviders([remoteProvider, localProvider]);
		const picker = createTestPicker(disposables, providersService, storage);

		// Select the local workspace
		const resolvedWorkspace = localProvider.resolveWorkspace(URI.file('/local/project'));
		assert.ok(resolvedWorkspace, 'resolveWorkspace should resolve file:// URIs');
		const localWorkspace: IWorkspaceSelection = {
			providerId: 'local-1',
			workspace: resolvedWorkspace,
		};
		picker.setSelectedWorkspace(localWorkspace, false);

		// Verify storage: only the local entry should be checked
		const raw = storage.get(STORAGE_KEY_RECENT_WORKSPACES, StorageScope.PROFILE);
		assert.ok(raw, 'Storage should have recent workspaces');
		const stored = JSON.parse(raw!) as { providerId: string; checked: boolean }[];
		const checkedEntries = stored.filter(e => e.checked);
		assert.strictEqual(checkedEntries.length, 1, 'Only one entry should be checked');
		assert.strictEqual(checkedEntries[0].providerId, 'local-1', 'The local entry should be checked');
	});

	test('local provider is never treated as unavailable', () => {
		const localProvider = createMockProvider('local-1');

		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: URI.file('/local/project'), providerId: 'local-1', checked: true },
		]);

		providersService.setProviders([localProvider]);
		const picker = createTestPicker(disposables, providersService, storage);

		assertSelectedProvider(picker, 'local-1', 'Local provider workspace should always be selectable');
	});

	test('restore picks the stored workspace when its provider registers after another provider', () => {
		// Regression: previously the picker filtered restore through `activeProviderId`,
		// which auto-locked to whichever provider registered first. If the stored
		// workspace belonged to a provider that registered later than another available
		// provider (for example, local-agent-host registering after default-copilot),
		// the stored entry was filtered out and never restored.
		//
		// Realistic shape: storage holds BOTH a (non-checked) recent for the
		// early-registering provider and a (checked) recent for the late-registering
		// provider. The picker may briefly show the early recent as a fallback, but
		// once the checked entry's provider registers, the picker must upgrade to it.
		const copilotProvider = createMockProvider('default-copilot');

		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: URI.file('/copilot/old-project'), providerId: 'default-copilot', checked: false },
			{ uri: URI.file('/agent-host/project'), providerId: 'local-agent-host', checked: true },
		]);

		// Construct picker with only the early-registering provider available.
		providersService.setProviders([copilotProvider]);
		const picker = createTestPicker(disposables, providersService, storage);

		// The fallback may be selected initially (early provider's recent),
		// since the user's checked entry's provider isn't ready yet.
		// Now the late provider arrives.
		const agentHostProvider = createMockProvider('local-agent-host');
		providersService.setProviders([copilotProvider, agentHostProvider]);

		assertSelectedProvider(picker, 'local-agent-host', 'Stored workspace should be restored once its provider registers');
	});

	test('late-registering provider does not move selection out from under user', () => {
		// After the user has explicitly picked a workspace, a provider
		// registering later in the session must not switch the selection to its
		// stored "checked" entry. We only do that auto-upgrade during initial
		// startup before the user has acted.
		const copilotProvider = createMockProvider('default-copilot');

		const storage = disposables.add(new TestStorageService());
		seedStorage(storage, [
			{ uri: URI.file('/agent-host/project'), providerId: 'local-agent-host', checked: true },
		]);

		providersService.setProviders([copilotProvider]);
		const picker = createTestPicker(disposables, providersService, storage);

		// Suppression kicked in: no fallback selection while checked entry is pending.
		assertSelectedProvider(picker, undefined, 'No fallback while checked entry pending');

		// User explicitly picks a Copilot workspace.
		const copilotPick: IWorkspaceSelection = {
			providerId: 'default-copilot',
			workspace: copilotProvider.resolveWorkspace(URI.file('/copilot/picked'))!,
		};
		picker.setSelectedWorkspace(copilotPick, false);
		assertSelectedProvider(picker, 'default-copilot', 'User pick is honored');

		// Now the late provider for the (still-stored) checked entry arrives.
		const agentHostProvider = createMockProvider('local-agent-host');
		providersService.setProviders([copilotProvider, agentHostProvider]);

		assertSelectedProvider(picker, 'default-copilot', 'User selection is preserved across late provider registration');
	});
});
