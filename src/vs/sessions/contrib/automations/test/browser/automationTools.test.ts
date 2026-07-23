/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { constObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock, upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ConfirmationOptionKind } from '../../../../../platform/agentHost/common/state/protocol/channels-chat/state.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ChatContextKeys } from '../../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { AutomationTarget, IAutomation, IAutomationSchedule } from '../../../../../workbench/contrib/chat/common/automations/automation.js';
import { IAutomationDialogResult, IAutomationDialogService, IShowAutomationDialogOptions } from '../../../../../workbench/contrib/chat/common/automations/automationDialogService.js';
import { IAutomationService, ICreateAutomationOptions, IGuardedAutomationUpdateResult, IUpdateAutomationOptions } from '../../../../../workbench/contrib/chat/common/automations/automationService.js';
import { ChatAutomationsEnabledContext, CHAT_AUTOMATIONS_ENABLED_SETTING } from '../../../../../workbench/contrib/chat/common/automations/automationsEnabled.js';
import { IToolImpl, IToolResult, ToolProgress } from '../../../../../workbench/contrib/chat/common/tools/languageModelToolsService.js';
import { IChat, ISession, ISessionWorkspace } from '../../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { ConfigureAutomationTool, ConfigureAutomationToolId, DeleteAutomationTool, DeleteAutomationToolId, ListAutomationsTool, ListAutomationsToolId } from '../../browser/automationTools.js';

const FOLDER = URI.parse('file:///workspace');
const SESSION_RESOURCE = URI.parse('agent-session://local/session');
const CHAT_RESOURCE = URI.parse('agent-chat://local/chat');
const NOW = '2026-01-01T00:00:00.000Z';
const progress: ToolProgress = { report: () => { } };

function createAutomation(overrides?: Partial<IAutomation>): IAutomation {
	return {
		id: 'automation-1',
		name: 'Daily review',
		prompt: 'Review the repository',
		schedule: { interval: 'daily', scheduleHour: 9, scheduleMinute: 0, scheduleDay: 1 },
		target: {
			kind: 'workspace',
			folderUri: FOLDER,
			providerId: 'local-agent-host',
			sessionTypeId: 'copilot',
			isolation: { kind: 'default' },
		},
		modelId: 'gpt-test',
		mode: 'agent',
		permissionLevel: 'default',
		enabled: true,
		createdAt: NOW,
		updatedAt: NOW,
		nextRunAt: '2026-01-02T09:00:00.000Z',
		...overrides,
	};
}

class FakeAutomationService extends mock<IAutomationService>() {
	override readonly automations = observableValue<readonly IAutomation[]>(this, []);
	readonly created: ICreateAutomationOptions[] = [];
	readonly updated: Array<{ readonly id: string; readonly patch: IUpdateAutomationOptions }> = [];
	readonly deleted: string[] = [];

	constructor(automations: readonly IAutomation[] = []) {
		super();
		this.automations.set(automations, undefined);
	}

	override getAutomation(id: string): IAutomation | undefined {
		return this.automations.get().find(automation => automation.id === id);
	}

	override async createAutomation(options: ICreateAutomationOptions): Promise<IAutomation> {
		this.created.push(options);
		return {
			...options,
			id: 'created-automation',
			enabled: options.enabled ?? true,
			createdAt: NOW,
			updatedAt: NOW,
		};
	}

	override async updateAutomation(id: string, patch: IUpdateAutomationOptions): Promise<IAutomation> {
		this.updated.push({ id, patch });
		const existing = this.getAutomation(id);
		assert.ok(existing);
		return {
			...existing,
			name: patch.name ?? existing.name,
			prompt: patch.prompt ?? existing.prompt,
			schedule: patch.schedule ?? existing.schedule,
			target: patch.target ?? existing.target,
			modelId: patch.modelId === null ? undefined : patch.modelId ?? existing.modelId,
			mode: patch.mode === null ? undefined : patch.mode ?? existing.mode,
			permissionLevel: patch.permissionLevel === null ? undefined : patch.permissionLevel ?? existing.permissionLevel,
			enabled: patch.enabled ?? existing.enabled,
			updatedAt: NOW,
		};
	}

	override async updateAutomationIfUnchanged(id: string, patch: IUpdateAutomationOptions, expected: IAutomation): Promise<IGuardedAutomationUpdateResult> {
		const current = this.getAutomation(id);
		if (!current || editableAutomationKey(current) !== editableAutomationKey(expected)) {
			return { kind: 'conflict', current };
		}
		return { kind: 'updated', automation: await this.updateAutomation(id, patch) };
	}

	override async deleteAutomation(id: string): Promise<void> {
		this.deleted.push(id);
		this.automations.set(this.automations.get().filter(automation => automation.id !== id), undefined);
	}
}

function editableAutomationKey(automation: IAutomation): string {
	return JSON.stringify({
		name: automation.name,
		prompt: automation.prompt,
		schedule: automation.schedule,
		target: automation.target.kind === 'workspace'
			? { ...automation.target, folderUri: automation.target.folderUri.toString() }
			: automation.target,
		modelId: automation.modelId,
		mode: automation.mode,
		permissionLevel: automation.permissionLevel,
		enabled: automation.enabled,
	});
}

class RecordingAutomationDialogService extends mock<IAutomationDialogService>() {
	result: IAutomationDialogResult | undefined;
	resultPromise: Promise<IAutomationDialogResult | undefined> | undefined;
	lastOptions: IShowAutomationDialogOptions | undefined;
	callCount = 0;
	beforeReturn: (() => void) | undefined;

	override async showAutomationDialog(options: IShowAutomationDialogOptions): Promise<IAutomationDialogResult | undefined> {
		this.callCount++;
		this.lastOptions = options;
		this.beforeReturn?.();
		return this.resultPromise ?? this.result;
	}
}

class FakeSessionsManagementService extends mock<ISessionsManagementService>() {

	constructor(
		private readonly session: ISession | undefined,
		private readonly resolveFromChatResource = false,
	) {
		super();
	}

	override getSession(): ISession | undefined {
		return this.resolveFromChatResource ? undefined : this.session;
	}

	override getSessionForChatResource(): { session: ISession; chat: IChat } | undefined {
		return this.resolveFromChatResource && this.session
			? { session: this.session, chat: upcastPartial<IChat>({ resource: CHAT_RESOURCE }) }
			: undefined;
	}
}

function createConfigurationService(enabled = true): TestConfigurationService {
	const configurationService = new TestConfigurationService();
	configurationService.setUserConfiguration(CHAT_AUTOMATIONS_ENABLED_SETTING, enabled);
	return configurationService;
}

function createSession(options?: { readonly quickChat?: boolean; readonly workspace?: URI }): ISession {
	const workspace = options?.workspace === undefined
		? undefined
		: upcastPartial<ISessionWorkspace>({ uri: options.workspace });
	return upcastPartial<ISession>({
		resource: SESSION_RESOURCE,
		providerId: 'local-agent-host',
		sessionType: 'copilot',
		workspace: constObservable(workspace),
		isQuickChat: constObservable(options?.quickChat === true),
	});
}

async function invoke(tool: IToolImpl, parameters: Record<string, unknown>, sessionResource = SESSION_RESOURCE, token = CancellationToken.None, selectedCustomButton?: string): Promise<IToolResult> {
	return tool.invoke({
		callId: 'call-1',
		toolId: 'tool-1',
		parameters,
		context: { sessionResource },
		selectedCustomButton,
	}, async () => 0, progress, token);
}

function getText(result: IToolResult): string {
	const part = result.content[0];
	if (!part || part.kind !== 'text') {
		assert.fail('Expected a text tool result.');
	}
	return part.value;
}

suite('AutomationTools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('tool data is gated by AI and Automations context keys', () => {
		const automationService = new FakeAutomationService();
		const configurationService = createConfigurationService();
		const listData = new ListAutomationsTool(automationService, configurationService).getToolData();
		const deleteData = new DeleteAutomationTool(automationService, configurationService).getToolData();
		const configureData = new ConfigureAutomationTool(
			automationService,
			new RecordingAutomationDialogService(),
			new FakeSessionsManagementService(undefined),
			configurationService,
		).getToolData();

		const serialize = (tool: typeof listData) => tool.when?.serialize() ?? '';
		assert.deepStrictEqual([listData, configureData, deleteData].map(tool => ({
			id: tool.id,
			referenceName: tool.toolReferenceName,
			aiEnabledGate: serialize(tool).includes(ChatContextKeys.enabled.key),
			automationsEnabledGate: serialize(tool).includes(ChatAutomationsEnabledContext.key),
			runsInWorkspace: tool.runsInWorkspace,
			requiresUserConfirmation: tool.requiresUserConfirmation,
		})), [
			{
				id: ListAutomationsToolId,
				referenceName: 'listAutomations',
				aiEnabledGate: true,
				automationsEnabledGate: true,
				runsInWorkspace: false,
				requiresUserConfirmation: undefined,
			},
			{
				id: ConfigureAutomationToolId,
				referenceName: 'configureAutomation',
				aiEnabledGate: true,
				automationsEnabledGate: true,
				runsInWorkspace: false,
				requiresUserConfirmation: undefined,
			},
			{
				id: DeleteAutomationToolId,
				referenceName: 'deleteAutomation',
				aiEnabledGate: true,
				automationsEnabledGate: true,
				runsInWorkspace: false,
				requiresUserConfirmation: true,
			},
		]);
	});

	test('listAutomations returns stable IDs and editable fields', async () => {
		const automation = createAutomation();
		const tool = new ListAutomationsTool(new FakeAutomationService([automation]), createConfigurationService());

		const result = await invoke(tool, {});

		assert.deepStrictEqual(JSON.parse(getText(result)), {
			automations: [{
				id: 'automation-1',
				name: 'Daily review',
				prompt: 'Review the repository',
				schedule: { interval: 'daily', scheduleHour: 9, scheduleMinute: 0, scheduleDay: 1 },
				target: {
					kind: 'workspace',
					folderUri: 'file:///workspace',
					providerId: 'local-agent-host',
					sessionTypeId: 'copilot',
					isolation: { kind: 'default' },
				},
				modelId: 'gpt-test',
				mode: 'agent',
				permissionLevel: 'default',
				enabled: true,
				createdAt: NOW,
				updatedAt: NOW,
				lastRunAt: null,
				nextRunAt: '2026-01-02T09:00:00.000Z',
			}],
		});
	});

	test('deleteAutomation requires an explicit Delete confirmation', async () => {
		const automation = createAutomation();
		const automationService = new FakeAutomationService([automation]);
		const tool = new DeleteAutomationTool(automationService, createConfigurationService());
		const parameters = { automationId: automation.id };

		const prepared = await tool.prepareToolInvocation!({
			parameters,
			toolCallId: 'call-1',
			chatSessionResource: SESSION_RESOURCE,
		}, CancellationToken.None);
		const message = prepared?.confirmationMessages?.message;
		const result = await invoke(tool, parameters, SESSION_RESOURCE, CancellationToken.None, 'delete');

		assert.deepStrictEqual({
			confirmationTitle: prepared?.confirmationMessages?.title,
			confirmationMessage: typeof message === 'string' ? message : message?.value,
			allowAutoConfirm: prepared?.confirmationMessages?.allowAutoConfirm,
			options: prepared?.confirmationMessages?.customOptions,
			deleted: automationService.deleted,
			automations: automationService.automations.get(),
			result: JSON.parse(getText(result)),
		}, {
			confirmationTitle: 'Delete Automation?',
			confirmationMessage: 'Delete **Daily review** (`automation-1`)? Its saved configuration and run history will be permanently removed. Runs already in flight will continue.',
			allowAutoConfirm: false,
			options: [
				{ id: 'delete', label: 'Delete', kind: ConfirmationOptionKind.Approve },
				{ id: 'cancel', label: 'Cancel', kind: ConfirmationOptionKind.Deny },
			],
			deleted: ['automation-1'],
			automations: [],
			result: {
				status: 'deleted',
				automation: { id: 'automation-1', name: 'Daily review' },
			},
		});
	});

	test('deleteAutomation rejects stale IDs before confirmation', async () => {
		const automationService = new FakeAutomationService();
		const tool = new DeleteAutomationTool(automationService, createConfigurationService());
		const parameters = { automationId: 'missing' };

		await assert.rejects(
			tool.prepareToolInvocation!({
				parameters,
				toolCallId: 'call-1',
				chatSessionResource: SESSION_RESOURCE,
			}, CancellationToken.None),
			/Automation "missing" does not exist/,
		);
		const result = await invoke(tool, parameters, SESSION_RESOURCE, CancellationToken.None, 'delete');

		assert.deepStrictEqual({
			error: result.toolResultError,
			deleted: automationService.deleted,
		}, {
			error: 'Automation "missing" does not exist. Call listAutomations to refresh the available IDs.',
			deleted: [],
		});
	});

	test('deleteAutomation Cancel option makes no changes', async () => {
		const automation = createAutomation();
		const automationService = new FakeAutomationService([automation]);
		const tool = new DeleteAutomationTool(automationService, createConfigurationService());

		const result = await invoke(tool, { automationId: automation.id }, SESSION_RESOURCE, CancellationToken.None, 'cancel');

		assert.deepStrictEqual({
			result: JSON.parse(getText(result)),
			deleted: automationService.deleted,
			automations: automationService.automations.get(),
		}, {
			result: {
				status: 'cancelled',
				message: 'The automation was not deleted.',
			},
			deleted: [],
			automations: [automation],
		});
	});

	test('deleteAutomation cancellation makes no changes', async () => {
		const automation = createAutomation();
		const automationService = new FakeAutomationService([automation]);
		const tokenSource = new CancellationTokenSource();
		tokenSource.cancel();
		const tool = new DeleteAutomationTool(automationService, createConfigurationService());

		const result = await invoke(tool, { automationId: automation.id }, SESSION_RESOURCE, tokenSource.token, 'delete');
		tokenSource.dispose();

		assert.deepStrictEqual({
			result: JSON.parse(getText(result)),
			deleted: automationService.deleted,
			automations: automationService.automations.get(),
		}, {
			result: {
				status: 'cancelled',
				message: 'The automation was not deleted.',
			},
			deleted: [],
			automations: [automation],
		});
	});

	test('configureAutomation reviews a create proposal using the invoking chat session target', async () => {
		const automationService = new FakeAutomationService();
		const dialogService = new RecordingAutomationDialogService();
		const session = createSession({ quickChat: true });
		const target: AutomationTarget = {
			kind: 'quickChat',
			providerId: 'local-agent-host',
			sessionTypeId: 'copilot',
		};
		const schedule: IAutomationSchedule = { interval: 'daily', scheduleHour: 8, scheduleMinute: 30, scheduleDay: 1 };
		dialogService.result = {
			kind: 'create',
			value: {
				name: 'Morning review',
				prompt: 'Review open pull requests',
				schedule,
				target,
				enabled: true,
			},
		};
		const tool = new ConfigureAutomationTool(
			automationService,
			dialogService,
			new FakeSessionsManagementService(session, true),
			createConfigurationService(),
		);

		const result = await invoke(tool, {
			name: 'Morning review',
			prompt: 'Review open pull requests',
			schedule: { interval: 'daily', scheduleHour: 8, scheduleMinute: 30 },
		}, CHAT_RESOURCE);

		assert.deepStrictEqual({
			dialog: {
				existing: dialogService.lastOptions?.existing,
				initialValues: dialogService.lastOptions?.initialValues,
				isAgentProposal: dialogService.lastOptions?.isAgentProposal,
				preserveUnavailableInitialTarget: dialogService.lastOptions?.preserveUnavailableInitialTarget,
				hasCancellationToken: dialogService.lastOptions?.cancellationToken === CancellationToken.None,
			},
			created: automationService.created,
			result: JSON.parse(getText(result)),
		}, {
			dialog: {
				existing: undefined,
				initialValues: {
					name: 'Morning review',
					prompt: 'Review open pull requests',
					schedule,
					target,
				},
				isAgentProposal: true,
				preserveUnavailableInitialTarget: true,
				hasCancellationToken: true,
			},
			created: [{
				name: 'Morning review',
				prompt: 'Review open pull requests',
				schedule,
				target,
				enabled: true,
			}],
			result: {
				status: 'created',
				automation: {
					id: 'created-automation',
					name: 'Morning review',
					prompt: 'Review open pull requests',
					schedule,
					target,
					modelId: null,
					mode: null,
					permissionLevel: null,
					enabled: true,
					createdAt: NOW,
					updatedAt: NOW,
					lastRunAt: null,
					nextRunAt: null,
				},
			},
		});
	});

	test('configureAutomation merges partial update schedule values and nullable defaults before review', async () => {
		const existing = createAutomation();
		const automationService = new FakeAutomationService([existing]);
		const dialogService = new RecordingAutomationDialogService();
		const reviewedPatch: IUpdateAutomationOptions = {
			name: 'Updated review',
			prompt: existing.prompt,
			schedule: { ...existing.schedule, scheduleMinute: 45 },
			target: existing.target,
			modelId: null,
			mode: null,
			permissionLevel: null,
			enabled: existing.enabled,
		};
		dialogService.result = { kind: 'update', id: existing.id, value: reviewedPatch };
		const tool = new ConfigureAutomationTool(
			automationService,
			dialogService,
			new FakeSessionsManagementService(undefined),
			createConfigurationService(),
		);

		await invoke(tool, {
			automationId: existing.id,
			name: 'Updated review',
			schedule: { scheduleMinute: 45 },
			modelId: null,
			mode: null,
			permissionLevel: null,
		});

		assert.deepStrictEqual({
			existing: dialogService.lastOptions?.existing,
			initialValues: dialogService.lastOptions?.initialValues,
			updated: automationService.updated,
		}, {
			existing,
			initialValues: {
				name: 'Updated review',
				schedule: { ...existing.schedule, scheduleMinute: 45 },
				modelId: null,
				mode: null,
				permissionLevel: null,
			},
			updated: [{ id: existing.id, patch: reviewedPatch }],
		});
	});

	test('configureAutomation cancellation makes no changes', async () => {
		const automationService = new FakeAutomationService();
		const dialogService = new RecordingAutomationDialogService();
		const tool = new ConfigureAutomationTool(
			automationService,
			dialogService,
			new FakeSessionsManagementService(createSession({ workspace: FOLDER })),
			createConfigurationService(),
		);

		const result = await invoke(tool, {
			name: 'Cancelled',
			prompt: 'Do not save',
			schedule: { interval: 'manual' },
		});

		assert.deepStrictEqual({
			result: JSON.parse(getText(result)),
			created: automationService.created,
			updated: automationService.updated,
		}, {
			result: {
				status: 'cancelled',
				message: 'The user cancelled the automation review. No changes were made.',
			},
			created: [],
			updated: [],
		});
	});

	test('configureAutomation serializes concurrent proposal reviews', async () => {
		const automationService = new FakeAutomationService();
		const dialogService = new RecordingAutomationDialogService();
		const firstDialog = new DeferredPromise<IAutomationDialogResult | undefined>();
		dialogService.resultPromise = firstDialog.p;
		const tool = new ConfigureAutomationTool(
			automationService,
			dialogService,
			new FakeSessionsManagementService(createSession({ workspace: FOLDER })),
			createConfigurationService(),
		);

		const firstResult = invoke(tool, {
			name: 'First',
			prompt: 'First prompt',
			schedule: { interval: 'manual' },
		});
		await timeout(0);
		const secondResult = invoke(tool, {
			name: 'Second',
			prompt: 'Second prompt',
			schedule: { interval: 'manual' },
		});
		await timeout(0);

		assert.strictEqual(dialogService.callCount, 1);
		await firstDialog.complete(undefined);
		const results = await Promise.all([firstResult, secondResult]);

		assert.deepStrictEqual({
			dialogCalls: dialogService.callCount,
			statuses: results.map(result => JSON.parse(getText(result)).status),
			created: automationService.created,
		}, {
			dialogCalls: 2,
			statuses: ['cancelled', 'cancelled'],
			created: [],
		});
	});

	test('configureAutomation does not open the dialog for an already cancelled invocation', async () => {
		const automationService = new FakeAutomationService();
		const dialogService = new RecordingAutomationDialogService();
		const tokenSource = new CancellationTokenSource();
		tokenSource.cancel();
		const tool = new ConfigureAutomationTool(
			automationService,
			dialogService,
			new FakeSessionsManagementService(createSession({ workspace: FOLDER })),
			createConfigurationService(),
		);

		const result = await invoke(tool, {
			name: 'Cancelled',
			prompt: 'Do not save',
			schedule: { interval: 'manual' },
		}, SESSION_RESOURCE, tokenSource.token);
		tokenSource.dispose();

		assert.deepStrictEqual({
			result: JSON.parse(getText(result)),
			dialogCalls: dialogService.callCount,
			created: automationService.created,
		}, {
			result: {
				status: 'cancelled',
				message: 'The user cancelled the automation review. No changes were made.',
			},
			dialogCalls: 0,
			created: [],
		});
	});

	test('configureAutomation does not save when cancelled while the dialog is open', async () => {
		const automationService = new FakeAutomationService();
		const dialogService = new RecordingAutomationDialogService();
		const tokenSource = new CancellationTokenSource();
		const target: AutomationTarget = {
			kind: 'workspace',
			folderUri: FOLDER,
			providerId: 'local-agent-host',
			sessionTypeId: 'copilot',
			isolation: { kind: 'folder' },
		};
		dialogService.result = {
			kind: 'create',
			value: {
				name: 'Cancelled',
				prompt: 'Do not save',
				schedule: { interval: 'manual', scheduleHour: 9, scheduleMinute: 0, scheduleDay: 1 },
				target,
			},
		};
		dialogService.beforeReturn = () => tokenSource.cancel();
		const tool = new ConfigureAutomationTool(
			automationService,
			dialogService,
			new FakeSessionsManagementService(createSession({ workspace: FOLDER })),
			createConfigurationService(),
		);

		const result = await invoke(tool, {
			name: 'Cancelled',
			prompt: 'Do not save',
			schedule: { interval: 'manual' },
		}, SESSION_RESOURCE, tokenSource.token);
		tokenSource.dispose();

		assert.deepStrictEqual({
			result: JSON.parse(getText(result)),
			dialogCalls: dialogService.callCount,
			created: automationService.created,
		}, {
			result: {
				status: 'cancelled',
				message: 'The user cancelled the automation review. No changes were made.',
			},
			dialogCalls: 1,
			created: [],
		});
	});

	test('configureAutomation does not save when Automations are disabled during review', async () => {
		const automationService = new FakeAutomationService();
		const dialogService = new RecordingAutomationDialogService();
		const configurationService = createConfigurationService();
		const target: AutomationTarget = {
			kind: 'workspace',
			folderUri: FOLDER,
			providerId: 'local-agent-host',
			sessionTypeId: 'copilot',
			isolation: { kind: 'folder' },
		};
		dialogService.result = {
			kind: 'create',
			value: {
				name: 'Disabled',
				prompt: 'Do not save',
				schedule: { interval: 'manual', scheduleHour: 9, scheduleMinute: 0, scheduleDay: 1 },
				target,
			},
		};
		dialogService.beforeReturn = () => configurationService.setUserConfiguration(CHAT_AUTOMATIONS_ENABLED_SETTING, false);
		const tool = new ConfigureAutomationTool(
			automationService,
			dialogService,
			new FakeSessionsManagementService(createSession({ workspace: FOLDER })),
			configurationService,
		);

		const result = await invoke(tool, {
			name: 'Disabled',
			prompt: 'Do not save',
			schedule: { interval: 'manual' },
		});

		assert.deepStrictEqual({
			error: result.toolResultError,
			dialogCalls: dialogService.callCount,
			created: automationService.created,
		}, {
			error: 'Automations were disabled before the proposal was saved. No changes were made.',
			dialogCalls: 1,
			created: [],
		});
	});

	test('configureAutomation does not update an automation deleted during review', async () => {
		const existing = createAutomation();
		const automationService = new FakeAutomationService([existing]);
		const dialogService = new RecordingAutomationDialogService();
		const reviewedPatch: IUpdateAutomationOptions = {
			name: 'Deleted automation',
			prompt: existing.prompt,
			schedule: existing.schedule,
			target: existing.target,
			enabled: existing.enabled,
		};
		dialogService.result = { kind: 'update', id: existing.id, value: reviewedPatch };
		dialogService.beforeReturn = () => automationService.automations.set([], undefined);
		const tool = new ConfigureAutomationTool(
			automationService,
			dialogService,
			new FakeSessionsManagementService(undefined),
			createConfigurationService(),
		);

		const result = await invoke(tool, { automationId: existing.id, name: 'Deleted automation' });

		assert.deepStrictEqual({
			error: result.toolResultError,
			dialogCalls: dialogService.callCount,
			updated: automationService.updated,
		}, {
			error: 'Automation "automation-1" was deleted during review. No changes were made.',
			dialogCalls: 1,
			updated: [],
		});
	});

	test('configureAutomation does not overwrite an automation changed during review', async () => {
		const existing = createAutomation();
		const automationService = new FakeAutomationService([existing]);
		const dialogService = new RecordingAutomationDialogService();
		dialogService.result = {
			kind: 'update',
			id: existing.id,
			value: {
				name: 'Proposed name',
				prompt: existing.prompt,
				schedule: existing.schedule,
				target: existing.target,
				enabled: existing.enabled,
			},
		};
		dialogService.beforeReturn = () => automationService.automations.set([
			{ ...existing, prompt: 'Changed in another window', updatedAt: '2026-01-01T00:01:00.000Z' },
		], undefined);
		const tool = new ConfigureAutomationTool(
			automationService,
			dialogService,
			new FakeSessionsManagementService(undefined),
			createConfigurationService(),
		);

		const result = await invoke(tool, { automationId: existing.id, name: 'Proposed name' });

		assert.deepStrictEqual({
			error: result.toolResultError,
			updated: automationService.updated,
		}, {
			error: 'Automation "automation-1" changed during review. Call listAutomations to refresh it before proposing new changes. No changes were made.',
			updated: [],
		});
	});

	test('configureAutomation permits runtime metadata changes during review', async () => {
		const existing = createAutomation();
		const automationService = new FakeAutomationService([existing]);
		const dialogService = new RecordingAutomationDialogService();
		const reviewedPatch: IUpdateAutomationOptions = {
			name: 'Proposed name',
			prompt: existing.prompt,
			schedule: existing.schedule,
			target: existing.target,
			enabled: existing.enabled,
		};
		dialogService.result = { kind: 'update', id: existing.id, value: reviewedPatch };
		dialogService.beforeReturn = () => automationService.automations.set([{
			...existing,
			updatedAt: '2026-01-01T00:01:00.000Z',
			lastRunAt: '2026-01-01T00:01:00.000Z',
			nextRunAt: '2026-01-02T09:00:00.000Z',
		}], undefined);
		const tool = new ConfigureAutomationTool(
			automationService,
			dialogService,
			new FakeSessionsManagementService(undefined),
			createConfigurationService(),
		);

		const result = await invoke(tool, { automationId: existing.id, name: 'Proposed name' });

		assert.deepStrictEqual({
			status: JSON.parse(getText(result)).status,
			updated: automationService.updated,
		}, {
			status: 'updated',
			updated: [{ id: existing.id, patch: reviewedPatch }],
		});
	});

	test('configureAutomation rejects stale IDs before opening the dialog', async () => {
		const dialogService = new RecordingAutomationDialogService();
		const tool = new ConfigureAutomationTool(
			new FakeAutomationService(),
			dialogService,
			new FakeSessionsManagementService(undefined),
			createConfigurationService(),
		);

		const result = await invoke(tool, { automationId: 'missing', name: 'Updated' });

		assert.deepStrictEqual({
			error: result.toolResultError,
			dialogCalls: dialogService.callCount,
		}, {
			error: 'Automation "missing" does not exist. Call listAutomations to refresh the available IDs.',
			dialogCalls: 0,
		});
	});

	test('configureAutomation rejects invalid targets before opening the dialog', async () => {
		const dialogService = new RecordingAutomationDialogService();
		const tool = new ConfigureAutomationTool(
			new FakeAutomationService(),
			dialogService,
			new FakeSessionsManagementService(undefined),
			createConfigurationService(),
		);

		const result = await invoke(tool, {
			name: 'Invalid target',
			prompt: 'Do not open',
			schedule: { interval: 'weekly' },
			target: {
				kind: 'workspace',
				folderUri: 'not-an-absolute-uri',
				isolation: 'worktree',
				branch: 'main',
			},
		});

		assert.deepStrictEqual({
			error: result.toolResultError,
			dialogCalls: dialogService.callCount,
		}, {
			error: '"target.folderUri" must be a valid absolute URI.',
			dialogCalls: 0,
		});
	});

	test('configureAutomation requires explicit targets to resolve through the dialog picker', async () => {
		const dialogService = new RecordingAutomationDialogService();
		const tool = new ConfigureAutomationTool(
			new FakeAutomationService(),
			dialogService,
			new FakeSessionsManagementService(undefined),
			createConfigurationService(),
		);

		const result = await invoke(tool, {
			name: 'Explicit target',
			prompt: 'Review the target',
			schedule: { interval: 'manual' },
			target: {
				kind: 'quickChat',
				providerId: 'proposed-provider',
				sessionTypeId: 'proposed-session',
			},
		});

		assert.deepStrictEqual({
			result: JSON.parse(getText(result)),
			target: dialogService.lastOptions?.initialValues?.target,
			preserveUnavailableInitialTarget: dialogService.lastOptions?.preserveUnavailableInitialTarget,
		}, {
			result: {
				status: 'cancelled',
				message: 'The user cancelled the automation review. No changes were made.',
			},
			target: {
				kind: 'quickChat',
				providerId: 'proposed-provider',
				sessionTypeId: 'proposed-session',
			},
			preserveUnavailableInitialTarget: false,
		});
	});

	test('disabled Automations cannot be listed, configured, or deleted', async () => {
		const automationService = new FakeAutomationService([createAutomation()]);
		const dialogService = new RecordingAutomationDialogService();
		const configurationService = createConfigurationService(false);
		const listResult = await invoke(new ListAutomationsTool(automationService, configurationService), {});
		const configureResult = await invoke(new ConfigureAutomationTool(
			automationService,
			dialogService,
			new FakeSessionsManagementService(createSession({ workspace: FOLDER })),
			configurationService,
		), {
			name: 'Disabled',
			prompt: 'Do not save',
			schedule: { interval: 'manual' },
		});
		const deleteResult = await invoke(
			new DeleteAutomationTool(automationService, configurationService),
			{ automationId: 'automation-1' },
			SESSION_RESOURCE,
			CancellationToken.None,
			'delete',
		);

		assert.deepStrictEqual({
			listError: listResult.toolResultError,
			configureError: configureResult.toolResultError,
			deleteError: deleteResult.toolResultError,
			dialogCalls: dialogService.callCount,
			deleted: automationService.deleted,
		}, {
			listError: 'Automations are disabled.',
			configureError: 'Automations are disabled.',
			deleteError: 'Automations are disabled.',
			dialogCalls: 0,
			deleted: [],
		});
	});
});
