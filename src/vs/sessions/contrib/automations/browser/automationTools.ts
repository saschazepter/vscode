/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceCancellation, Sequencer } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ConfirmationOptionKind } from '../../../../platform/agentHost/common/state/protocol/channels-chat/state.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { ChatContextKeys } from '../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { AutomationInterval, AutomationTarget, AutomationWorkspaceIsolation, IAutomation, IAutomationSchedule } from '../../../../workbench/contrib/chat/common/automations/automation.js';
import { IAutomationDialogService } from '../../../../workbench/contrib/chat/common/automations/automationDialogService.js';
import { IAutomationService, IUpdateAutomationOptions } from '../../../../workbench/contrib/chat/common/automations/automationService.js';
import { ChatAutomationsEnabledContext, CHAT_AUTOMATIONS_ENABLED_SETTING } from '../../../../workbench/contrib/chat/common/automations/automationsEnabled.js';
import { ChatModeKind, ChatPermissionLevel } from '../../../../workbench/contrib/chat/common/constants.js';
import { CountTokensCallback, ILanguageModelToolsService, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolProgress } from '../../../../workbench/contrib/chat/common/tools/languageModelToolsService.js';
import { ISession } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';

export const ListAutomationsToolId = 'vscode_listAutomations';
export const ConfigureAutomationToolId = 'vscode_configureAutomation';
export const DeleteAutomationToolId = 'vscode_deleteAutomation';

const automationToolWhen = ContextKeyExpr.and(ChatContextKeys.enabled, ChatAutomationsEnabledContext);
const deleteAutomationConfirmationId = 'delete';
const automationIntervals: readonly AutomationInterval[] = ['manual', 'hourly', 'daily', 'weekly'];
const automationIsolationKinds: readonly AutomationWorkspaceIsolation['kind'][] = ['default', 'folder', 'worktree'];
const chatModes: readonly ChatModeKind[] = [ChatModeKind.Agent, ChatModeKind.Ask, ChatModeKind.Edit];
const chatPermissionLevels: readonly ChatPermissionLevel[] = [ChatPermissionLevel.Default, ChatPermissionLevel.Assisted, ChatPermissionLevel.AutoApprove, ChatPermissionLevel.Autopilot];

interface IAutomationToolOutput {
	readonly id: string;
	readonly name: string;
	readonly prompt: string;
	readonly schedule: IAutomationSchedule;
	readonly target:
	| {
		readonly kind: 'workspace';
		readonly folderUri: string;
		readonly providerId: string | null;
		readonly sessionTypeId: string | null;
		readonly isolation: AutomationWorkspaceIsolation;
	}
	| {
		readonly kind: 'quickChat';
		readonly providerId: string;
		readonly sessionTypeId: string;
	};
	readonly modelId: string | null;
	readonly mode: string | null;
	readonly permissionLevel: string | null;
	readonly enabled: boolean;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly lastRunAt: string | null;
	readonly nextRunAt: string | null;
}

interface IAutomationDialogProposal {
	readonly existing: IAutomation | undefined;
	readonly initialValues: IUpdateAutomationOptions;
	readonly preserveUnavailableInitialTarget: boolean | undefined;
}

class AutomationToolInputError extends Error { }

export class ListAutomationsTool implements IToolImpl {

	constructor(
		@IAutomationService private readonly automationService: IAutomationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) { }

	getToolData(): IToolData {
		return {
			id: ListAutomationsToolId,
			toolReferenceName: 'listAutomations',
			canBeReferencedInPrompt: false,
			icon: Codicon.watch,
			displayName: localize('automation.tool.list.displayName', "List Automations"),
			userDescription: localize('automation.tool.list.userDescription', "List scheduled agent automations"),
			modelDescription: 'List all configured scheduled automations and their stable IDs, editable fields, targets, and timing metadata. Use this before configureAutomation or deleteAutomation when changing an existing automation. This tool never changes automation state.',
			source: ToolDataSource.Internal,
			when: automationToolWhen,
			runsInWorkspace: false,
			inputSchema: {
				type: 'object',
				properties: {},
				additionalProperties: false,
			},
		};
	}

	async prepareToolInvocation(_context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation> {
		return {
			invocationMessage: localize('automation.tool.list.invocationMessage', "Reading automations"),
			pastTenseMessage: localize('automation.tool.list.pastTenseMessage', "Read automations"),
		};
	}

	async invoke(_invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		if (!isAutomationsEnabled(this.configurationService)) {
			return automationToolError('Automations are disabled.');
		}

		const automations = this.automationService.automations.get().map(toAutomationToolOutput);
		const result = automationToolResult(JSON.stringify({ automations }, undefined, 2));
		result.toolResultMessage = automations.length === 1
			? localize('automation.tool.list.result.singular', "Listed 1 automation")
			: localize('automation.tool.list.result.plural', "Listed {0} automations", automations.length);
		return result;
	}
}

export class DeleteAutomationTool implements IToolImpl {

	constructor(
		@IAutomationService private readonly automationService: IAutomationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) { }

	getToolData(): IToolData {
		return {
			id: DeleteAutomationToolId,
			toolReferenceName: 'deleteAutomation',
			canBeReferencedInPrompt: false,
			icon: Codicon.trash,
			displayName: localize('automation.tool.delete.displayName', "Delete Automation"),
			userDescription: localize('automation.tool.delete.userDescription', "Delete a scheduled agent automation"),
			modelDescription: 'Delete an automation by stable ID after explicit user confirmation. Call listAutomations first to obtain the current ID. The user must activate Delete in the confirmation; this action cannot be auto-approved.',
			source: ToolDataSource.Internal,
			requiresUserConfirmation: true,
			when: automationToolWhen,
			runsInWorkspace: false,
			inputSchema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					automationId: {
						type: 'string',
						description: 'Stable automation ID from listAutomations.',
					},
				},
				required: ['automationId'],
			},
		};
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation> {
		if (!isAutomationsEnabled(this.configurationService)) {
			throw new AutomationToolInputError('Automations are disabled.');
		}
		const automation = this.resolveAutomation(context.parameters);
		return {
			invocationMessage: localize('automation.tool.delete.invocationMessage', "Deleting automation {0}", automation.name),
			pastTenseMessage: localize('automation.tool.delete.pastTenseMessage', "Deleted automation {0}", automation.name),
			confirmationMessages: {
				title: localize('automation.tool.delete.confirmationTitle', "Delete Automation?"),
				message: new MarkdownString(localize(
					'automation.tool.delete.confirmationMessage',
					"Delete **{0}** (`{1}`)? Its saved configuration and run history will be permanently removed. Runs already in flight will continue.",
					automation.name,
					automation.id,
				)),
				allowAutoConfirm: false,
				customOptions: [
					{ id: deleteAutomationConfirmationId, label: localize('automation.tool.delete.confirm', "Delete"), kind: ConfirmationOptionKind.Approve },
					{ id: 'cancel', label: localize('automation.tool.delete.cancel', "Cancel"), kind: ConfirmationOptionKind.Deny },
				],
			},
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		if (!isAutomationsEnabled(this.configurationService)) {
			return automationToolError('Automations are disabled.');
		}
		if (token.isCancellationRequested) {
			return automationDeleteCancelled();
		}

		let automation: IAutomation;
		try {
			automation = this.resolveAutomation(invocation.parameters);
		} catch (error) {
			if (error instanceof AutomationToolInputError) {
				return automationToolError(error.message);
			}
			throw error;
		}

		if (invocation.selectedCustomButton !== deleteAutomationConfirmationId) {
			return automationDeleteCancelled();
		}

		await this.automationService.deleteAutomation(automation.id);
		const result = automationToolResult(JSON.stringify({
			status: 'deleted',
			automation: { id: automation.id, name: automation.name },
		}));
		result.toolResultMessage = localize('automation.tool.delete.deleted', "Deleted automation {0}", automation.name);
		return result;
	}

	private resolveAutomation(rawInput: unknown): IAutomation {
		if (!isRecord(rawInput)) {
			throw new AutomationToolInputError('deleteAutomation input must be an object.');
		}
		assertKnownProperties(rawInput, ['automationId'], 'deleteAutomation input');
		const automationId = readOptionalNonEmptyString(rawInput, 'automationId');
		if (!automationId) {
			throw new AutomationToolInputError('"automationId" is required.');
		}
		const automation = this.automationService.getAutomation(automationId);
		if (!automation) {
			throw new AutomationToolInputError(`Automation "${automationId}" does not exist. Call listAutomations to refresh the available IDs.`);
		}
		return automation;
	}
}

export class ConfigureAutomationTool implements IToolImpl {

	private readonly sequencer = new Sequencer();

	constructor(
		@IAutomationService private readonly automationService: IAutomationService,
		@IAutomationDialogService private readonly automationDialogService: IAutomationDialogService,
		@ISessionsManagementService private readonly sessionsManagementService: ISessionsManagementService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) { }

	getToolData(): IToolData {
		return {
			id: ConfigureAutomationToolId,
			toolReferenceName: 'configureAutomation',
			canBeReferencedInPrompt: false,
			icon: Codicon.watch,
			displayName: localize('automation.tool.configure.displayName', "Configure Automation"),
			userDescription: localize('automation.tool.configure.userDescription', "Propose creating or updating an automation"),
			modelDescription: `Open a user-review dialog prefilled with a proposed automation creation or update.

Omit "automationId" to create an automation; "name", "prompt", and "schedule.interval" are then required. If "target" is omitted, the automation targets the current Agents window session.
Include "automationId" to update an existing automation, and only provide fields that should change. Call listAutomations first to obtain the stable ID and current values.
The proposal is not persisted unless the user explicitly selects Create or Save in the review dialog. If the user cancels, do not retry unless they ask you to.`,
			source: ToolDataSource.Internal,
			when: automationToolWhen,
			runsInWorkspace: false,
			inputSchema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					automationId: {
						type: 'string',
						description: 'Stable automation ID from listAutomations. Omit to create a new automation.',
					},
					name: {
						type: 'string',
						description: 'Automation name. Required when creating.',
					},
					prompt: {
						type: 'string',
						description: 'Prompt sent when the automation runs. Required when creating.',
					},
					schedule: {
						type: 'object',
						additionalProperties: false,
						description: 'Schedule proposal. Required when creating. Omitted fields preserve existing values when updating; create defaults are 09:00 Monday.',
						properties: {
							interval: {
								type: 'string',
								enum: [...automationIntervals],
								description: 'manual, hourly, daily, or weekly.',
							},
							scheduleHour: {
								type: 'integer',
								minimum: 0,
								maximum: 23,
								description: 'Local hour, used for daily and weekly schedules.',
							},
							scheduleMinute: {
								type: 'integer',
								minimum: 0,
								maximum: 59,
								description: 'Local minute, used for daily and weekly schedules.',
							},
							scheduleDay: {
								type: 'integer',
								minimum: 0,
								maximum: 6,
								description: 'Day of week for weekly schedules: 0 is Sunday and 6 is Saturday.',
							},
						},
					},
					target: {
						type: 'object',
						additionalProperties: false,
						description: 'Run target. Omit when creating to use the current session, or omit when updating to preserve the existing target.',
						properties: {
							kind: {
								type: 'string',
								enum: ['currentSession', 'workspace', 'quickChat'],
							},
							folderUri: {
								type: 'string',
								description: 'Full workspace URI for a workspace target.',
							},
							providerId: {
								type: 'string',
								description: 'Sessions provider ID.',
							},
							sessionTypeId: {
								type: 'string',
								description: 'Sessions provider session-type ID.',
							},
							isolation: {
								type: 'string',
								enum: [...automationIsolationKinds],
								description: 'Workspace isolation: default, folder, or worktree.',
							},
							branch: {
								type: 'string',
								description: 'Base branch, required for worktree isolation.',
							},
						},
						required: ['kind'],
					},
					modelId: {
						type: ['string', 'null'],
						description: 'Language model ID, or null to use the provider default.',
					},
					mode: {
						enum: [...chatModes, null],
						description: 'Chat mode, or null to use the provider default.',
					},
					permissionLevel: {
						enum: [...chatPermissionLevels, null],
						description: 'Permission level, or null to use the provider default.',
					},
					enabled: {
						type: 'boolean',
						description: 'Whether scheduled runs are enabled. Defaults to true when creating.',
					},
				},
			},
		};
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation> {
		const isUpdate = typeof context.parameters?.automationId === 'string';
		return {
			invocationMessage: isUpdate
				? localize('automation.tool.configure.update.invocationMessage', "Opening automation changes for review")
				: localize('automation.tool.configure.create.invocationMessage', "Opening a new automation for review"),
			pastTenseMessage: isUpdate
				? localize('automation.tool.configure.update.pastTenseMessage', "Reviewed automation changes")
				: localize('automation.tool.configure.create.pastTenseMessage', "Reviewed a new automation"),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const result = await raceCancellation(this.sequencer.queue(() => this.invokeSequentially(invocation, token)), token);
		return result ?? automationToolCancelled();
	}

	private async invokeSequentially(invocation: IToolInvocation, token: CancellationToken): Promise<IToolResult> {
		if (!isAutomationsEnabled(this.configurationService)) {
			return automationToolError('Automations are disabled.');
		}
		if (token.isCancellationRequested) {
			return automationToolCancelled();
		}

		let proposal: IAutomationDialogProposal;
		try {
			proposal = this.parseProposal(invocation);
		} catch (error) {
			if (error instanceof AutomationToolInputError) {
				return automationToolError(error.message);
			}
			throw error;
		}

		const dialogResult = await this.automationDialogService.showAutomationDialog({
			existing: proposal.existing,
			initialValues: proposal.initialValues,
			isAgentProposal: true,
			preserveUnavailableInitialTarget: proposal.preserveUnavailableInitialTarget,
			cancellationToken: token,
		});
		if (!dialogResult || token.isCancellationRequested) {
			return automationToolCancelled();
		}
		if (!isAutomationsEnabled(this.configurationService)) {
			return automationToolError('Automations were disabled before the proposal was saved. No changes were made.');
		}

		if (proposal.existing) {
			if (dialogResult.kind !== 'update' || dialogResult.id !== proposal.existing.id) {
				throw new Error('Automation review returned an unexpected update target.');
			}
			const updateResult = await this.automationService.updateAutomationIfUnchanged(proposal.existing.id, dialogResult.value, proposal.existing);
			if (updateResult.kind === 'conflict' && !updateResult.current) {
				return automationToolError(`Automation "${proposal.existing.id}" was deleted during review. No changes were made.`);
			}
			if (updateResult.kind === 'conflict') {
				return automationToolError(`Automation "${proposal.existing.id}" changed during review. Call listAutomations to refresh it before proposing new changes. No changes were made.`);
			}
			const updated = updateResult.automation;
			const result = automationToolResult(JSON.stringify({ status: 'updated', automation: toAutomationToolOutput(updated) }, undefined, 2));
			result.toolResultMessage = localize('automation.tool.configure.updated', "Updated automation {0}", updated.name);
			return result;
		}

		if (dialogResult.kind !== 'create') {
			throw new Error('Automation review returned an unexpected create result.');
		}
		const created = await this.automationService.createAutomation(dialogResult.value);
		const result = automationToolResult(JSON.stringify({ status: 'created', automation: toAutomationToolOutput(created) }, undefined, 2));
		result.toolResultMessage = localize('automation.tool.configure.created', "Created automation {0}", created.name);
		return result;
	}

	private parseProposal(invocation: IToolInvocation): IAutomationDialogProposal {
		const rawInput: unknown = invocation.parameters;
		if (!isRecord(rawInput)) {
			throw new AutomationToolInputError('configureAutomation input must be an object.');
		}
		const input = rawInput;
		assertKnownProperties(input, ['automationId', 'name', 'prompt', 'schedule', 'target', 'modelId', 'mode', 'permissionLevel', 'enabled'], 'configureAutomation input');

		const automationId = readOptionalNonEmptyString(input, 'automationId');
		const existing = automationId ? this.automationService.getAutomation(automationId) : undefined;
		if (automationId && !existing) {
			throw new AutomationToolInputError(`Automation "${automationId}" does not exist. Call listAutomations to refresh the available IDs.`);
		}

		const name = readOptionalRequiredText(input, 'name');
		const prompt = readOptionalRequiredText(input, 'prompt');
		if (!existing && name === undefined) {
			throw new AutomationToolInputError('"name" is required when creating an automation.');
		}
		if (!existing && prompt === undefined) {
			throw new AutomationToolInputError('"prompt" is required when creating an automation.');
		}

		const schedule = parseSchedule(input, existing?.schedule, !existing);
		const currentTarget = this.getCurrentSessionTarget(invocation);
		const target = parseTarget(input, existing, currentTarget);
		if (!existing && !target) {
			throw new AutomationToolInputError('A target could not be derived from the current session. Provide an explicit "target".');
		}

		const modelId = readOptionalNullableNonEmptyString(input, 'modelId');
		const mode = readOptionalNullableEnum(input, 'mode', chatModes);
		const permissionLevel = readOptionalNullableEnum(input, 'permissionLevel', chatPermissionLevels);
		const enabled = readOptionalBoolean(input, 'enabled');

		const initialValues: IUpdateAutomationOptions = {
			...(name !== undefined ? { name } : {}),
			...(prompt !== undefined ? { prompt } : {}),
			...(schedule ? { schedule } : {}),
			...(target ? { target } : {}),
			...(modelId !== undefined ? { modelId } : {}),
			...(mode !== undefined ? { mode } : {}),
			...(permissionLevel !== undefined ? { permissionLevel } : {}),
			...(enabled !== undefined ? { enabled } : {}),
		};
		const preserveUnavailableInitialTarget = input.target === undefined
			? existing ? undefined : true
			: isRecord(input.target) && input.target.kind === 'currentSession';
		return { existing, initialValues, preserveUnavailableInitialTarget };
	}

	private getCurrentSessionTarget(invocation: IToolInvocation): AutomationTarget | undefined {
		const resource = invocation.context?.sessionResource;
		if (!resource) {
			return undefined;
		}
		const session = this.sessionsManagementService.getSession(resource)
			?? this.sessionsManagementService.getSessionForChatResource(resource)?.session;
		return session ? automationTargetFromSession(session) : undefined;
	}
}

export class AutomationToolsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.contrib.automationTools';

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		const listTool = instantiationService.createInstance(ListAutomationsTool);
		const configureTool = instantiationService.createInstance(ConfigureAutomationTool);
		const deleteTool = instantiationService.createInstance(DeleteAutomationTool);
		this._register(toolsService.registerTool(listTool.getToolData(), listTool));
		this._register(toolsService.registerTool(configureTool.getToolData(), configureTool));
		this._register(toolsService.registerTool(deleteTool.getToolData(), deleteTool));
	}
}

function isAutomationsEnabled(configurationService: IConfigurationService): boolean {
	return configurationService.getValue<boolean>(CHAT_AUTOMATIONS_ENABLED_SETTING) === true;
}

function automationTargetFromSession(session: ISession): AutomationTarget | undefined {
	if (session.isQuickChat?.get() === true) {
		return {
			kind: 'quickChat',
			providerId: session.providerId,
			sessionTypeId: session.sessionType,
		};
	}
	const workspace = session.workspace.get();
	return workspace ? {
		kind: 'workspace',
		folderUri: workspace.uri,
		providerId: session.providerId,
		sessionTypeId: session.sessionType,
		isolation: { kind: 'default' },
	} : undefined;
}

function parseSchedule(input: Record<string, unknown>, existing: IAutomationSchedule | undefined, required: boolean): IAutomationSchedule | undefined {
	const value = readOptionalObject(input, 'schedule');
	if (!value) {
		if (required) {
			throw new AutomationToolInputError('"schedule" is required when creating an automation.');
		}
		return undefined;
	}

	assertKnownProperties(value, ['interval', 'scheduleHour', 'scheduleMinute', 'scheduleDay'], '"schedule"');
	const interval = readOptionalEnum(value, 'interval', automationIntervals) ?? existing?.interval;
	if (!interval) {
		throw new AutomationToolInputError('"schedule.interval" is required when creating an automation.');
	}
	const scheduleHour = readOptionalInteger(value, 'scheduleHour', 0, 23) ?? existing?.scheduleHour ?? 9;
	const scheduleMinute = readOptionalInteger(value, 'scheduleMinute', 0, 59) ?? existing?.scheduleMinute ?? 0;
	const scheduleDay = readOptionalInteger(value, 'scheduleDay', 0, 6) ?? existing?.scheduleDay ?? 1;

	return { interval, scheduleHour, scheduleMinute, scheduleDay };
}

function parseTarget(input: Record<string, unknown>, existing: IAutomation | undefined, currentTarget: AutomationTarget | undefined): AutomationTarget | undefined {
	const value = readOptionalObject(input, 'target');
	if (!value) {
		return existing ? undefined : currentTarget;
	}

	assertKnownProperties(value, ['kind', 'folderUri', 'providerId', 'sessionTypeId', 'isolation', 'branch'], '"target"');
	const kind = readRequiredEnum(value, 'kind', ['currentSession', 'workspace', 'quickChat'] as const);
	if (kind === 'currentSession') {
		assertPropertiesAbsent(value, ['folderUri', 'providerId', 'sessionTypeId', 'isolation', 'branch'], 'A currentSession target');
		if (!currentTarget) {
			throw new AutomationToolInputError('The current session does not have a resolved automation target.');
		}
		return currentTarget;
	}

	if (kind === 'quickChat') {
		assertPropertiesAbsent(value, ['folderUri', 'isolation', 'branch'], 'A quickChat target');
		const existingTarget = existing?.target.kind === 'quickChat' ? existing.target : undefined;
		const providerId = readOptionalNonEmptyString(value, 'providerId') ?? existingTarget?.providerId ?? currentTarget?.providerId;
		const sessionTypeId = readOptionalNonEmptyString(value, 'sessionTypeId') ?? existingTarget?.sessionTypeId ?? currentTarget?.sessionTypeId;
		if (!providerId || !sessionTypeId) {
			throw new AutomationToolInputError('A quickChat target requires "providerId" and "sessionTypeId".');
		}
		return { kind: 'quickChat', providerId, sessionTypeId };
	}

	const existingTarget = existing?.target.kind === 'workspace' ? existing.target : undefined;
	const sessionTarget = currentTarget?.kind === 'workspace' ? currentTarget : undefined;
	const baseTarget = existingTarget ?? sessionTarget;
	const folderUriValue = readOptionalNonEmptyString(value, 'folderUri');
	const folderUri = folderUriValue ? parseUri(folderUriValue, 'target.folderUri') : baseTarget?.folderUri;
	if (!folderUri) {
		throw new AutomationToolInputError('A workspace target requires "folderUri".');
	}
	const providerId = readOptionalNonEmptyString(value, 'providerId') ?? baseTarget?.providerId;
	const sessionTypeId = readOptionalNonEmptyString(value, 'sessionTypeId') ?? baseTarget?.sessionTypeId;
	const isolationKind = readOptionalEnum(value, 'isolation', automationIsolationKinds) ?? baseTarget?.isolation.kind ?? 'default';
	const branch = readOptionalNonEmptyString(value, 'branch')
		?? (baseTarget?.isolation.kind === 'worktree' ? baseTarget.isolation.branch : undefined);
	if (isolationKind !== 'worktree' && readOptionalNonEmptyString(value, 'branch') !== undefined) {
		throw new AutomationToolInputError('"target.branch" is only valid with worktree isolation.');
	}
	let isolation: AutomationWorkspaceIsolation;
	if (isolationKind === 'worktree') {
		if (!branch) {
			throw new AutomationToolInputError('A workspace target with worktree isolation requires "branch".');
		}
		isolation = { kind: 'worktree', branch };
	} else {
		isolation = { kind: isolationKind };
	}
	return { kind: 'workspace', folderUri, providerId, sessionTypeId, isolation };
}

function parseUri(value: string, field: string): URI {
	try {
		const uri = URI.parse(value, true);
		if (!uri.scheme) {
			throw new Error('URI has no scheme.');
		}
		return uri;
	} catch {
		throw new AutomationToolInputError(`"${field}" must be a valid absolute URI.`);
	}
}

function toAutomationToolOutput(automation: IAutomation): IAutomationToolOutput {
	const target: IAutomationToolOutput['target'] = automation.target.kind === 'workspace'
		? {
			kind: 'workspace',
			folderUri: automation.target.folderUri.toString(),
			providerId: automation.target.providerId ?? null,
			sessionTypeId: automation.target.sessionTypeId ?? null,
			isolation: automation.target.isolation,
		}
		: {
			kind: 'quickChat',
			providerId: automation.target.providerId,
			sessionTypeId: automation.target.sessionTypeId,
		};
	return {
		id: automation.id,
		name: automation.name,
		prompt: automation.prompt,
		schedule: automation.schedule,
		target,
		modelId: automation.modelId ?? null,
		mode: automation.mode ?? null,
		permissionLevel: automation.permissionLevel ?? null,
		enabled: automation.enabled,
		createdAt: automation.createdAt,
		updatedAt: automation.updatedAt,
		lastRunAt: automation.lastRunAt ?? null,
		nextRunAt: automation.nextRunAt ?? null,
	};
}

function automationToolResult(value: string): IToolResult {
	return { content: [{ kind: 'text', value }] };
}

function automationToolError(message: string): IToolResult {
	return {
		content: [{ kind: 'text', value: message }],
		toolResultError: message,
		toolResultMessage: localize('automation.tool.error', "Automation request failed"),
	};
}

function automationToolCancelled(): IToolResult {
	const result = automationToolResult(JSON.stringify({
		status: 'cancelled',
		message: 'The user cancelled the automation review. No changes were made.',
	}));
	result.toolResultMessage = localize('automation.tool.cancelled', "Automation change cancelled");
	return result;
}

function automationDeleteCancelled(): IToolResult {
	const result = automationToolResult(JSON.stringify({
		status: 'cancelled',
		message: 'The automation was not deleted.',
	}));
	result.toolResultMessage = localize('automation.tool.delete.cancelled', "Automation deletion cancelled");
	return result;
}

function assertKnownProperties(value: Record<string, unknown>, properties: readonly string[], field: string): void {
	const known = new Set(properties);
	const unexpected = Object.keys(value).find(key => !known.has(key));
	if (unexpected) {
		throw new AutomationToolInputError(`${field} has an unsupported "${unexpected}" property.`);
	}
}

function assertPropertiesAbsent(value: Record<string, unknown>, properties: readonly string[], field: string): void {
	const present = properties.find(property => value[property] !== undefined);
	if (present) {
		throw new AutomationToolInputError(`${field} cannot include "${present}".`);
	}
}

function readOptionalObject(value: Record<string, unknown>, property: string): Record<string, unknown> | undefined {
	const candidate = value[property];
	if (candidate === undefined) {
		return undefined;
	}
	if (!isRecord(candidate)) {
		throw new AutomationToolInputError(`"${property}" must be an object.`);
	}
	return candidate;
}

function readOptionalRequiredText(value: Record<string, unknown>, property: string): string | undefined {
	const candidate = value[property];
	if (candidate === undefined) {
		return undefined;
	}
	if (typeof candidate !== 'string' || candidate.trim() === '') {
		throw new AutomationToolInputError(`"${property}" must be a non-empty string.`);
	}
	return candidate;
}

function readOptionalNonEmptyString(value: Record<string, unknown>, property: string): string | undefined {
	const candidate = readOptionalRequiredText(value, property);
	return candidate?.trim();
}

function readOptionalNullableNonEmptyString(value: Record<string, unknown>, property: string): string | null | undefined {
	const candidate = value[property];
	if (candidate === undefined || candidate === null) {
		return candidate;
	}
	if (typeof candidate !== 'string' || candidate.trim() === '') {
		throw new AutomationToolInputError(`"${property}" must be a non-empty string or null.`);
	}
	return candidate.trim();
}

function readOptionalBoolean(value: Record<string, unknown>, property: string): boolean | undefined {
	const candidate = value[property];
	if (candidate === undefined) {
		return undefined;
	}
	if (typeof candidate !== 'boolean') {
		throw new AutomationToolInputError(`"${property}" must be a boolean.`);
	}
	return candidate;
}

function readOptionalInteger(value: Record<string, unknown>, property: string, minimum: number, maximum: number): number | undefined {
	const candidate = value[property];
	if (candidate === undefined) {
		return undefined;
	}
	if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
		throw new AutomationToolInputError(`"${property}" must be an integer from ${minimum} through ${maximum}.`);
	}
	return candidate;
}

function readRequiredEnum<const T extends string>(value: Record<string, unknown>, property: string, allowed: readonly T[]): T {
	const candidate = readOptionalEnum(value, property, allowed);
	if (candidate === undefined) {
		throw new AutomationToolInputError(`"${property}" is required.`);
	}
	return candidate;
}

function readOptionalEnum<const T extends string>(value: Record<string, unknown>, property: string, allowed: readonly T[]): T | undefined {
	const candidate = value[property];
	if (candidate === undefined) {
		return undefined;
	}
	if (!isAllowedString(candidate, allowed)) {
		throw new AutomationToolInputError(`"${property}" must be one of: ${allowed.join(', ')}.`);
	}
	return candidate;
}

function readOptionalNullableEnum<const T extends string>(value: Record<string, unknown>, property: string, allowed: readonly T[]): T | null | undefined {
	const candidate = value[property];
	if (candidate === undefined || candidate === null) {
		return candidate;
	}
	if (!isAllowedString(candidate, allowed)) {
		throw new AutomationToolInputError(`"${property}" must be null or one of: ${allowed.join(', ')}.`);
	}
	return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isAllowedString<const T extends string>(value: unknown, allowed: readonly T[]): value is T {
	return typeof value === 'string' && allowed.some(candidate => candidate === value);
}
