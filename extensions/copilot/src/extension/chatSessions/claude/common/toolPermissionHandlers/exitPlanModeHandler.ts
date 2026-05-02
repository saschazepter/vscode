/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { INativeEnvService } from '../../../../../platform/env/common/envService';
import { FileType } from '../../../../../platform/filesystem/common/fileTypes';
import { IFileSystemService } from '../../../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../../../platform/log/common/logService';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { URI } from '../../../../../util/vs/base/common/uri';
import { LanguageModelTextPart } from '../../../../../vscodeTypes';
import { ToolName } from '../../../../tools/common/toolNames';
import { IToolsService } from '../../../../tools/common/toolsService';
import { ClaudeToolPermissionContext, ClaudeToolPermissionResult, IClaudeToolPermissionHandler } from '../claudeToolPermission';
import { registerToolPermissionHandler } from '../claudeToolPermissionRegistry';
import { ClaudeToolNames, ExitPlanModeInput } from '../claudeTools';

/**
 * Shape returned by the `vscode_reviewPlan` core tool. Mirrors
 * `IChatPlanReviewResult` from the workbench side.
 */
interface IReviewPlanResult {
	action?: string;
	rejected: boolean;
	feedback?: string;
}

const ApproveAction = l10n.t('Approve');
const ApproveBypassAction = l10n.t('Approve & Bypass Permissions');

/**
 * Handler for the ExitPlanMode tool. Renders the docked plan-review widget
 * with three outcomes:
 *  - Approve: continue in the current permission mode
 *  - Approve & Bypass Permissions: continue and switch to bypassPermissions
 *  - Reject (with optional feedback): deny so Claude revises the plan
 */
export class ExitPlanModeToolHandler implements IClaudeToolPermissionHandler<ClaudeToolNames.ExitPlanMode> {
	public readonly toolNames = [ClaudeToolNames.ExitPlanMode] as const;

	constructor(
		@IToolsService private readonly toolsService: IToolsService,
		@ILogService private readonly logService: ILogService,
		@INativeEnvService private readonly envService: INativeEnvService,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
	) { }

	public async handle(
		_toolName: ClaudeToolNames.ExitPlanMode,
		input: ExitPlanModeInput,
		{ toolInvocationToken }: ClaudeToolPermissionContext
	): Promise<ClaudeToolPermissionResult> {
		try {
			// Claude writes the plan markdown to ~/.claude/plans/*.md before
			// invoking ExitPlanMode. Find that file so the review widget can
			// surface inline editor comments.
			const planUri = await this.findPlanUri(input.plan);

			const reviewInput: {
				title: string;
				content: string;
				plan?: string;
				actions: Array<{ label: string; default?: boolean; description?: string; permissionLevel?: 'autopilot' }>;
				canProvideFeedback: boolean;
			} = {
				title: l10n.t("Claude's Plan"),
				content: input.plan ?? '',
				actions: [
					{ label: ApproveAction, default: true },
					{
						label: ApproveBypassAction,
						description: l10n.t('Bypass permission prompts for the rest of this session.'),
						permissionLevel: 'autopilot',
					},
				],
				canProvideFeedback: true,
			};
			if (planUri) {
				reviewInput.plan = planUri.toString();
			}

			const result = await this.toolsService.invokeTool(ToolName.CoreReviewPlan, {
				input: reviewInput,
				toolInvocationToken,
			}, CancellationToken.None);

			const firstResultPart = result.content.at(0);
			if (!(firstResultPart instanceof LanguageModelTextPart)) {
				return { behavior: 'deny', message: 'Plan review returned no result.' };
			}

			let parsed: IReviewPlanResult;
			try {
				parsed = JSON.parse(firstResultPart.value) as IReviewPlanResult;
			} catch (e) {
				this.logService.warn(`[ExitPlanMode] Failed to parse review result: ${e?.message ?? e}`);
				return { behavior: 'deny', message: 'Plan review returned an invalid result.' };
			}

			// Rejection (with or without feedback).
			if (parsed.rejected) {
				const feedback = parsed.feedback?.trim();
				return {
					behavior: 'deny',
					message: feedback
						? `The user rejected the plan with this feedback:\n\n${feedback}`
						: 'The user declined the plan, maybe ask why?',
				};
			}

			// Feedback supplied alongside an approval action: treat as deny so
			// Claude revises the plan rather than silently dropping the input.
			const feedback = parsed.feedback?.trim();
			if (feedback) {
				return {
					behavior: 'deny',
					message: `The user has feedback on the plan before proceeding:\n\n${feedback}`,
				};
			}

			// Plain approval. Switch into bypassPermissions for the rest of the
			// session if the user picked the bypass variant.
			if (parsed.action === ApproveBypassAction) {
				return {
					behavior: 'allow',
					updatedInput: input,
					updatedPermissions: [{
						type: 'setMode',
						mode: 'bypassPermissions',
						destination: 'session',
					}],
				};
			}

			return { behavior: 'allow', updatedInput: input };
		} catch (e) {
			this.logService.warn(`[ExitPlanMode] Failed to invoke review plan tool: ${e?.message ?? e}`);
			return { behavior: 'deny', message: 'Failed to show plan review.' };
		}
	}

	/**
	 * Locate the plan markdown file Claude wrote to `~/.claude/plans/`.
	 * Prefers an exact content match (so we pick the right file when the
	 * directory contains plans from prior sessions); falls back to the
	 * most recently modified `.md` file. Returns `undefined` if the
	 * directory is missing or no candidate is found — the review widget
	 * then renders content-only without inline-editor affordances.
	 */
	private async findPlanUri(planContent: string | undefined): Promise<URI | undefined> {
		const planDir = URI.joinPath(this.envService.userHome, '.claude', 'plans');
		let entries: [string, FileType][];
		try {
			entries = await this.fileSystemService.readDirectory(planDir);
		} catch {
			return undefined;
		}

		const candidates: URI[] = [];
		for (const [name, type] of entries) {
			if (type !== FileType.File || !name.toLowerCase().endsWith('.md')) {
				continue;
			}
			candidates.push(URI.joinPath(planDir, name));
		}
		if (candidates.length === 0) {
			return undefined;
		}

		// Prefer an exact content match.
		const target = planContent?.trim();
		if (target) {
			for (const uri of candidates) {
				try {
					const bytes = await this.fileSystemService.readFile(uri);
					if (new TextDecoder().decode(bytes).trim() === target) {
						return uri;
					}
				} catch {
					// Ignore unreadable candidates.
				}
			}
		}

		// Fall back to the most recently modified file.
		let newest: { uri: URI; mtime: number } | undefined;
		for (const uri of candidates) {
			try {
				const stat = await this.fileSystemService.stat(uri);
				if (!newest || stat.mtime > newest.mtime) {
					newest = { uri, mtime: stat.mtime };
				}
			} catch {
				// Ignore unstatable candidates.
			}
		}
		return newest?.uri;
	}
}

// Self-register the handler
registerToolPermissionHandler(
	[ClaudeToolNames.ExitPlanMode],
	ExitPlanModeToolHandler
);
