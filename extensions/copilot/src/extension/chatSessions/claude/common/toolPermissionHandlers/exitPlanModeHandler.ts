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
	actionId?: string;
	rejected: boolean;
	feedback?: string;
}

/** Stable identifiers for the approve actions. Compared programmatically
 * via `parsed.actionId` so they survive localization. */
const APPROVE_ID = 'approve';
const APPROVE_BYPASS_ID = 'approveBypass';

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
				actions: Array<{ id?: string; label: string; default?: boolean; description?: string; permissionLevel?: 'autopilot' }>;
				canProvideFeedback: boolean;
			} = {
				title: l10n.t("Claude's Plan"),
				content: input.plan ?? '',
				actions: [
					{ id: APPROVE_ID, label: l10n.t('Approve'), default: true },
					{
						id: APPROVE_BYPASS_ID,
						label: l10n.t('Approve & Bypass Permissions'),
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

			// Bypass-action wins regardless of accompanying feedback: the user
			// has explicitly opted to skip further permission prompts, so we
			// honour that and drop any feedback (no SDK affordance to attach
			// a message to an `allow` result). Plain Approve + feedback below
			// is treated as deny so Claude revises the plan.
			const feedback = parsed.feedback?.trim();
			if (parsed.actionId === APPROVE_BYPASS_ID) {
				if (feedback) {
					this.logService.info('[ExitPlanMode] User chose Approve & Bypass Permissions with feedback; feedback discarded.');
				}
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

			// Feedback alongside plain approval: treat as deny so Claude
			// revises the plan rather than silently dropping the input.
			if (feedback) {
				return {
					behavior: 'deny',
					message: `The user has feedback on the plan before proceeding:\n\n${feedback}`,
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
	 * Requires an exact content match against `planContent` so we only
	 * associate the review widget with the file Claude actually produced
	 * for *this* invocation — the directory commonly contains plans from
	 * prior sessions, and an mtime-based fallback could attach the widget
	 * (and any inline comments) to unrelated content. Returns `undefined`
	 * when no exact match is found; the review widget then renders
	 * content-only without inline-editor affordances.
	 *
	 * Performance / safety:
	 *  - Plain regular files only: symlinks are rejected so a malicious
	 *    `~/.claude/plans/foo.md -> /etc/passwd` cannot redirect the open.
	 *  - Skips files larger than `MAX_PLAN_FILE_BYTES` to bound the I/O
	 *    cost of stale logs accidentally dropped in the directory.
	 *  - Stats first, then sorts by mtime descending and short-circuits on
	 *    the first content match — Claude's just-written plan is almost
	 *    always the most recently modified entry.
	 *  - Length comparison precedes decoding so obvious mismatches pay no
	 *    decode cost.
	 */
	private async findPlanUri(planContent: string | undefined): Promise<URI | undefined> {
		const target = planContent?.trim();
		if (!target) {
			return undefined;
		}
		const targetByteLength = new TextEncoder().encode(target).byteLength;

		const planDir = URI.joinPath(this.envService.userHome, '.claude', 'plans');
		let entries: [string, FileType][];
		try {
			entries = await this.fileSystemService.readDirectory(planDir);
		} catch {
			return undefined;
		}

		// Stat candidates in parallel, filtering out non-regular files,
		// symlinks, and files larger than the size cap.
		const stats = await Promise.all(entries.map(async ([name, type]) => {
			if (type !== FileType.File || !name.toLowerCase().endsWith('.md')) {
				return undefined;
			}
			const uri = URI.joinPath(planDir, name);
			try {
				const stat = await this.fileSystemService.stat(uri);
				// Reject anything carrying the SymbolicLink bit (covers both
				// pure symlinks and `File | SymbolicLink`).
				if ((stat.type & FileType.SymbolicLink) !== 0) {
					return undefined;
				}
				if (stat.type !== FileType.File) {
					return undefined;
				}
				if (stat.size > MAX_PLAN_FILE_BYTES) {
					return undefined;
				}
				return { uri, mtime: stat.mtime, size: stat.size };
			} catch {
				return undefined;
			}
		}));

		const candidates = stats.filter((s): s is { uri: URI; mtime: number; size: number } => !!s);
		// Newest first — Claude's plan is almost always the most recent.
		candidates.sort((a, b) => b.mtime - a.mtime);

		for (const { uri, size } of candidates) {
			// Cheap length filter before decoding. UTF-8 byte length must
			// match the (trimmed) target byte length, so anything else is
			// guaranteed to mismatch. Files have surrounding whitespace so
			// allow a small slack.
			if (Math.abs(size - targetByteLength) > 8 && size < targetByteLength) {
				continue;
			}
			try {
				const bytes = await this.fileSystemService.readFile(uri);
				if (new TextDecoder().decode(bytes).trim() === target) {
					return uri;
				}
			} catch {
				// Ignore unreadable candidates.
			}
		}
		return undefined;
	}
}

/** Cap individual plan file reads (1 MB) to bound disk I/O on the
 * permission path. Plans are markdown summaries and never approach this. */
const MAX_PLAN_FILE_BYTES = 1024 * 1024;

// Self-register the handler
registerToolPermissionHandler(
	[ClaudeToolNames.ExitPlanMode],
	ExitPlanModeToolHandler
);
