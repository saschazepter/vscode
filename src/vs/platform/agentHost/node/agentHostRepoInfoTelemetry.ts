/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { ILogService } from '../../log/common/log.js';
import { AgentSession } from '../common/agentService.js';
import { IAgentHostGitService } from '../common/agentHostGitService.js';
import type { AgentHostTelemetryReporter } from './agentHostTelemetryReporter.js';

/**
 * Cap on the diff patch we attach to `request.repoInfo`. Aligned with the restricted sender's
 * `multiplexProperties` capacity (~50 * 8192 chars) so the patch is never silently truncated; a
 * larger diff reports `result='diffTooLarge'` with no `diffsJSON`, mirroring the extension's cap
 * behaviour (whose limit is the 1MB App-Insights payload instead).
 */
const MAX_DIFF_PATCH_SIZE = 380 * 1024;

/** Extracts the repo-relative changed file paths from a `git diff` patch's `diff --git` headers. */
function parsePatchPaths(patch: string): string[] {
	const paths = new Set<string>();
	const re = /^diff --git a\/.+? b\/(.+)$/gm;
	let match: RegExpExecArray | null;
	while ((match = re.exec(patch)) !== null) {
		paths.add(match[1]);
	}
	return [...paths];
}

/**
 * Gathers and emits the restricted `request.repoInfo` telemetry for an agent-host session — the
 * host-side analogue of the Copilot extension's `RepoInfoTelemetry`. Runs entirely off
 * {@link IAgentHostGitService}: the session git state supplies the repo identity and branches, and
 * {@link IAgentHostGitService.getSessionDiffPatch} supplies the branch/uncommitted diff. Fire and
 * forget — failures are logged, never thrown. See `agentHostTelemetryReporter.reportRepoInfo` for
 * the sink/schema details and the AH-vs-extension differences.
 */
export class AgentHostRepoInfoTelemetry {

	constructor(
		private readonly _reporter: AgentHostTelemetryReporter,
		@IAgentHostGitService private readonly _gitService: IAgentHostGitService,
		@ILogService private readonly _logService: ILogService,
	) { }

	/**
	 * Gathers repo info for the session's working tree and emits `request.repoInfo`. No-ops when
	 * there is no working directory or no GitHub remote (the AH only resolves GitHub repos).
	 *
	 * @param sessionUri The session URI string; its id becomes `conversationId`.
	 * @param workingDirectory The session's working directory, if any.
	 */
	async report(sessionUri: string, workingDirectory: URI | undefined): Promise<void> {
		if (!workingDirectory) {
			return;
		}
		try {
			const gitState = await this._gitService.getSessionGitState(workingDirectory);
			const owner = gitState?.githubOwner;
			const repo = gitState?.githubRepo;
			if (!owner || !repo) {
				return; // not a GitHub work tree
			}

			const baseBranch = gitState?.baseBranchName ?? await this._gitService.getDefaultBranch(workingDirectory);
			const [headBranchName, headCommitHash, patch] = await Promise.all([
				gitState?.branchName ? Promise.resolve(gitState.branchName) : this._gitService.getCurrentBranch(workingDirectory),
				this._gitService.resolveBranchBaselineCommit(workingDirectory, baseBranch),
				this._gitService.getSessionDiffPatch(workingDirectory, { baseBranch }),
			]);
			if (patch === undefined) {
				return; // not a git work tree
			}

			const paths = patch ? parsePatchPaths(patch) : [];
			const changedFileCount = paths.length;
			let diffsJSON: string | undefined;
			let diffSizeBytes = 0;
			let result: 'success' | 'noChanges' | 'diffTooLarge';
			if (changedFileCount === 0) {
				result = 'noChanges';
			} else {
				diffSizeBytes = Buffer.byteLength(patch, 'utf8');
				if (diffSizeBytes > MAX_DIFF_PATCH_SIZE) {
					result = 'diffTooLarge';
				} else {
					diffsJSON = patch;
					result = 'success';
				}
			}

			this._reporter.reportRepoInfo({
				conversationId: AgentSession.id(sessionUri),
				remoteUrl: `https://github.com/${owner}/${repo}`,
				repoId: `${owner}/${repo}`,
				repoType: 'github',
				headCommitHash,
				headBranchName,
				fileRelativePaths: changedFileCount > 0 ? JSON.stringify(paths) : undefined,
				diffsJSON,
				result,
				isActiveRepository: 'true',
				changedFileCount,
				diffSizeBytes,
			});
		} catch (err) {
			this._logService.warn(`[AgentHostRepoInfoTelemetry] failed to gather repo info: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
