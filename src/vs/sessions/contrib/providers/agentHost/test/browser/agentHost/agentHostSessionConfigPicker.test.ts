/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../../../base/common/event.js';
import { observableValue } from '../../../../../../../base/common/observable.js';
import { mock } from '../../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { isIMenuItem, MenuId, MenuRegistry } from '../../../../../../../platform/actions/common/actions.js';
import { IActionWidgetService } from '../../../../../../../platform/actionWidget/browser/actionWidget.js';
import { SessionConfigKey } from '../../../../../../../platform/agentHost/common/sessionConfigKeys.js';
import { ResolveSessionConfigResult } from '../../../../../../../platform/agentHost/common/state/protocol/commands.js';
import { IConfigurationService } from '../../../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../../../../platform/hover/browser/hover.js';
import { TestInstantiationService } from '../../../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IStorageService } from '../../../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from '../../../../../../../platform/telemetry/common/telemetryUtils.js';
import { IWorkbenchLayoutService } from '../../../../../../../workbench/services/layout/browser/layoutService.js';
import { Menus } from '../../../../../../browser/menus.js';
import { IAgentHostSessionsProvider, LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../../../../common/agentHostSessionsProvider.js';
import { ISessionsProvidersService } from '../../../../../../services/sessions/browser/sessionsProvidersService.js';
import { IActiveSession } from '../../../../../../services/sessions/common/sessionsManagement.js';
import { ISessionsProvider } from '../../../../../../services/sessions/common/sessionsProvider.js';

import { AgentHostSessionConfigPicker } from '../../../browser/agentHostSessionConfigPicker.js';

const SESSION_ID = 'local-agent-host:s1';

/** A resolved schema exposing the two shared repo-config chips (isolation + branch). */
function makeRepoConfig(branchValue?: string): ResolveSessionConfigResult {
	return {
		schema: {
			type: 'object',
			properties: {
				[SessionConfigKey.Isolation]: {
					title: 'Isolation', description: '', type: 'string',
					enum: ['folder', 'worktree'], enumLabels: ['Folder', 'Worktree'],
					default: 'worktree',
				},
				[SessionConfigKey.Branch]: {
					title: 'Base Branch', description: '', type: 'string',
					enum: ['main', 'dev'],
				},
			},
		},
		values: { [SessionConfigKey.Isolation]: 'worktree', ...(branchValue ? { [SessionConfigKey.Branch]: branchValue } : {}) },
	} as ResolveSessionConfigResult;
}

/** The momentarily-empty schema a freshly created draft reports while resolving. */
function makeEmptyConfig(): ResolveSessionConfigResult {
	return {
		schema: { type: 'object', properties: {} },
		values: { [SessionConfigKey.Isolation]: 'worktree' },
	} as ResolveSessionConfigResult;
}

class FakeProvider implements Pick<IAgentHostSessionsProvider, 'id' | 'onDidChangeSessionConfig' | 'getSessionConfig' | 'getCreateSessionConfig' | 'isSessionConfigResolving' | 'setSessionConfigValue'> {
	readonly id = LOCAL_AGENT_HOST_PROVIDER_ID;
	readonly onDidChangeSessionConfig: Event<string>;
	config: ResolveSessionConfigResult = makeRepoConfig('main');
	readonly resolving = observableValue<boolean>('resolving', false);
	isNew = true;

	constructor(private readonly _emitter: Emitter<string>) {
		this.onDidChangeSessionConfig = _emitter.event;
	}

	getSessionConfig(): ResolveSessionConfigResult | undefined { return this.config; }
	getCreateSessionConfig(): Record<string, unknown> | undefined { return this.isNew ? {} : undefined; }
	isSessionConfigResolving() { return this.resolving; }
	async setSessionConfigValue(): Promise<void> { }

	/** Mimic the provider re-resolving: swap config + resolving flag, then pulse. */
	update(config: ResolveSessionConfigResult, resolving: boolean): void {
		this.config = config;
		this.resolving.set(resolving, undefined);
		this._emitter.fire(SESSION_ID);
	}
}

function isolationSlot(container: HTMLElement): HTMLElement | null {
	return container.querySelector<HTMLElement>('.sessions-chat-isolation-checkbox');
}

function branchSlot(container: HTMLElement): HTMLElement | undefined {
	return Array.from(container.querySelectorAll<HTMLElement>('.sessions-chat-picker-slot'))
		.find(slot => !slot.classList.contains('sessions-chat-isolation-checkbox'));
}

function branchLabel(container: HTMLElement): string | undefined {
	return branchSlot(container)?.querySelector<HTMLElement>('.sessions-chat-dropdown-label')?.textContent ?? undefined;
}

function setupPicker(store: Pick<ReturnType<typeof ensureNoDisposablesAreLeakedInTestSuite>, 'add'>) {
	const emitter = store.add(new Emitter<string>());
	const provider = new FakeProvider(emitter);

	const instantiationService = store.add(new TestInstantiationService());
	instantiationService.stub(IActionWidgetService, { isVisible: false, hide: () => { }, show: () => { } } as Partial<IActionWidgetService> as IActionWidgetService);
	instantiationService.stub(IHoverService, { setupDelayedHover: () => ({ dispose: () => { } }) } as Partial<IHoverService> as IHoverService);
	instantiationService.stub(ITelemetryService, NullTelemetryService);
	instantiationService.stub(IConfigurationService, new (class extends mock<IConfigurationService>() { })());
	instantiationService.stub(IDialogService, new (class extends mock<IDialogService>() { })());
	instantiationService.stub(IStorageService, new (class extends mock<IStorageService>() { })());
	instantiationService.stub(IContextKeyService, new (class extends mock<IContextKeyService>() {
		override readonly onDidChangeContext = Event.None;
	})());
	instantiationService.stub(IWorkbenchLayoutService, new (class extends mock<IWorkbenchLayoutService>() {
		// No `phone-layout` class → `isPhoneLayout` is false → isolation renders as a checkbox.
		override readonly mainContainer = document.createElement('div');
	})());
	instantiationService.set(ISessionsProvidersService, new (class extends mock<ISessionsProvidersService>() {
		override readonly onDidChangeProviders = Event.None;
		override getProviders(): ISessionsProvider[] { return [provider as unknown as ISessionsProvider]; }
		override getProvider<T extends ISessionsProvider>(id: string): T | undefined {
			return id === provider.id ? provider as unknown as T : undefined;
		}
	})());

	const sessionObs = observableValue<IActiveSession | undefined>('activeSession', { providerId: LOCAL_AGENT_HOST_PROVIDER_ID, sessionId: SESSION_ID } as IActiveSession);
	const picker = store.add(instantiationService.createInstance(AgentHostSessionConfigPicker, sessionObs));
	const container = document.createElement('div');
	picker.render(container);

	return { picker, container, provider };
}

suite('Agent Host Session Config Picker', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('places mode immediately before approvals in secondary toolbars', () => {
		const summarize = (menu: MenuId, ids: readonly string[]) => MenuRegistry.getMenuItems(menu)
			.filter(isIMenuItem)
			.filter(item => ids.includes(item.command.id))
			.map(item => ({ id: item.command.id, order: item.order }))
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

		const newSessionIds = [
			'sessions.agentHost.newSessionModePicker',
			'sessions.agentHost.newSessionApprovePicker',
			'sessions.agentHost.newSessionPermissionModePicker',
		];
		const runningSessionIds = [
			'sessions.agentHost.runningSessionModePicker',
			'sessions.agentHost.runningSessionConfigPicker',
			'sessions.agentHost.runningSessionPermissionModePicker',
		];

		assert.deepStrictEqual({
			newSessionPrimary: summarize(Menus.NewSessionConfig, newSessionIds),
			newSessionSecondary: summarize(Menus.NewSessionControl, newSessionIds),
			runningSessionPrimary: summarize(MenuId.ChatInput, runningSessionIds),
			runningSessionSecondary: summarize(MenuId.ChatInputSecondary, runningSessionIds),
		}, {
			newSessionPrimary: [],
			newSessionSecondary: [
				{ id: 'sessions.agentHost.newSessionModePicker', order: 0 },
				{ id: 'sessions.agentHost.newSessionApprovePicker', order: 1 },
				{ id: 'sessions.agentHost.newSessionPermissionModePicker', order: 2 },
			],
			runningSessionPrimary: [],
			runningSessionSecondary: [
				{ id: 'sessions.agentHost.runningSessionModePicker', order: 9 },
				{ id: 'sessions.agentHost.runningSessionConfigPicker', order: 10 },
				{ id: 'sessions.agentHost.runningSessionPermissionModePicker', order: 11 },
			],
		});
	});

	test('keeps isolation + branch chips visible (disabled) while a new draft re-resolves', () => {
		const { container, provider } = setupPicker(store);

		// 1. Resolved schema — chips present and enabled; this seeds the cache.
		assert.ok(isolationSlot(container), 'isolation checkbox should render for a resolved schema');
		assert.ok(branchSlot(container), 'branch chip should render for a resolved schema');
		assert.strictEqual(isolationSlot(container)!.classList.contains('disabled'), false);
		assert.strictEqual(branchSlot(container)!.classList.contains('disabled'), false);

		// 2. Fresh draft: empty schema + resolving. Both chips must stay visible
		// and disabled (the value is left untouched, not reset).
		provider.update(makeEmptyConfig(), true);
		assert.ok(isolationSlot(container), 'isolation checkbox should persist while resolving');
		assert.ok(branchSlot(container), 'branch chip should persist while resolving');
		assert.strictEqual(isolationSlot(container)!.classList.contains('disabled'), true, 'isolation should be disabled while resolving');
		assert.strictEqual(branchSlot(container)!.classList.contains('disabled'), true, 'branch should be disabled while resolving');
		assert.strictEqual(branchSlot(container)!.querySelector('a.action-label')?.getAttribute('aria-disabled'), 'true');

		// 3. Resolve lands — chips re-enable and reflect the new value.
		provider.update(makeRepoConfig('dev'), false);
		assert.strictEqual(isolationSlot(container)!.classList.contains('disabled'), false, 'isolation should re-enable after resolve');
		assert.strictEqual(branchSlot(container)!.classList.contains('disabled'), false, 'branch should re-enable after resolve');
		assert.strictEqual(branchLabel(container), 'dev', 'branch label reflects the resolved value');
	});

	test('stops injecting a repo chip once the resolved schema drops it', () => {
		const { container, provider } = setupPicker(store);
		assert.ok(branchSlot(container), 'branch chip present initially');

		// Authoritative resolve without a branch property (e.g. a non-git folder)
		// prunes it from the cache.
		provider.update({
			schema: { type: 'object', properties: { [SessionConfigKey.Isolation]: makeRepoConfig().schema.properties[SessionConfigKey.Isolation] } },
			values: { [SessionConfigKey.Isolation]: 'worktree' },
		} as ResolveSessionConfigResult, false);
		assert.strictEqual(branchSlot(container), undefined, 'branch chip gone after a resolve without branch');

		// A subsequent loading render must not resurrect the pruned branch chip.
		provider.update(makeEmptyConfig(), true);
		assert.ok(isolationSlot(container), 'isolation still injected while resolving');
		assert.strictEqual(branchSlot(container), undefined, 'pruned branch chip is not re-injected');
	});
});
