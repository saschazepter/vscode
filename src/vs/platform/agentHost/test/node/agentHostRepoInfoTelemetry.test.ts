/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { AgentSession } from '../../common/agentService.js';
import { IAgentHostGitService } from '../../common/agentHostGitService.js';
import type { ISessionGitState } from '../../common/state/sessionState.js';
import { AgentHostRepoInfoTelemetry } from '../../node/agentHostRepoInfoTelemetry.js';
import type { AgentHostTelemetryReporter, IAgentHostRepoInfoReport } from '../../node/agentHostTelemetryReporter.js';

function makeGitService(gitState: ISessionGitState | undefined, patch: string | undefined): IAgentHostGitService {
	return {
		_serviceBrand: undefined,
		getSessionGitState: async () => gitState,
		getDefaultBranch: async () => 'main',
		getCurrentBranch: async () => 'feature',
		resolveBranchBaselineCommit: async () => 'abc123',
		getSessionDiffPatch: async () => patch,
	} as unknown as IAgentHostGitService;
}

suite('AgentHostRepoInfoTelemetry', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const wd = URI.file('/repo');
	const session = 'agent-session://copilot/s1';
	const ghState: ISessionGitState = { githubOwner: 'o', githubRepo: 'r', branchName: 'feature', baseBranchName: 'main' };

	async function run(git: IAgentHostGitService, workingDirectory: URI | undefined = wd): Promise<IAgentHostRepoInfoReport[]> {
		const reports: IAgentHostRepoInfoReport[] = [];
		const reporter = { reportRepoInfo: (r: IAgentHostRepoInfoReport) => reports.push(r) } as unknown as AgentHostTelemetryReporter;
		await new AgentHostRepoInfoTelemetry(reporter, git, new NullLogService()).report(session, workingDirectory);
		return reports;
	}

	test('emits success with the patch as diffsJSON and parsed changed paths', async () => {
		const patch = 'diff --git a/foo.ts b/foo.ts\n@@ -1 +1 @@\n-old\n+new\n';
		const reports = await run(makeGitService(ghState, patch));
		assert.deepStrictEqual(reports, [{
			conversationId: AgentSession.id(session),
			remoteUrl: 'https://github.com/o/r',
			repoId: 'o/r',
			repoType: 'github',
			headCommitHash: 'abc123',
			headBranchName: 'feature',
			fileRelativePaths: JSON.stringify(['foo.ts']),
			diffsJSON: patch,
			result: 'success',
			isActiveRepository: 'true',
			changedFileCount: 1,
			diffSizeBytes: Buffer.byteLength(patch, 'utf8'),
		} satisfies IAgentHostRepoInfoReport]);
	});

	test('emits noChanges for an empty patch', async () => {
		const reports = await run(makeGitService(ghState, ''));
		assert.strictEqual(reports.length, 1);
		assert.strictEqual(reports[0].result, 'noChanges');
		assert.strictEqual(reports[0].diffsJSON, undefined);
		assert.strictEqual(reports[0].changedFileCount, 0);
		assert.strictEqual(reports[0].fileRelativePaths, undefined);
	});

	test('emits diffTooLarge (and drops diffsJSON) when the patch exceeds the cap', async () => {
		const big = 'diff --git a/x b/x\n' + 'x'.repeat(400 * 1024);
		const reports = await run(makeGitService(ghState, big));
		assert.strictEqual(reports[0].result, 'diffTooLarge');
		assert.strictEqual(reports[0].diffsJSON, undefined);
		assert.strictEqual(reports[0].changedFileCount, 1);
	});

	test('no-ops without a GitHub remote', async () => {
		const reports = await run(makeGitService({ branchName: 'feature' }, 'diff --git a/x b/x\n'));
		assert.strictEqual(reports.length, 0);
	});

	test('no-ops when not a git work tree (undefined patch)', async () => {
		const reports = await run(makeGitService(ghState, undefined));
		assert.strictEqual(reports.length, 0);
	});

	test('no-ops without a working directory', async () => {
		const reports: IAgentHostRepoInfoReport[] = [];
		const reporter = { reportRepoInfo: (r: IAgentHostRepoInfoReport) => reports.push(r) } as unknown as AgentHostTelemetryReporter;
		// Call directly with `undefined` (the `run` helper's default param would otherwise substitute `wd`).
		await new AgentHostRepoInfoTelemetry(reporter, makeGitService(ghState, 'diff --git a/x b/x\n'), new NullLogService()).report(session, undefined);
		assert.strictEqual(reports.length, 0);
	});
});
