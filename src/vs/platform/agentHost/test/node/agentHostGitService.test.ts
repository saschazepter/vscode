/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as cp from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AgentHostGitService, getBranchCompletions, parseDefaultBranchRef, parseGitStatusV2, parseHasGitHubRemote } from '../../node/agentHostGitService.js';

suite('AgentHostGitService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('sorts common branch names to the top before applying limit', () => {
		assert.deepStrictEqual(
			getBranchCompletions(['feature/recent', 'release', 'master', 'main', 'feature/older'], { limit: 3 }),
			['main', 'master', 'feature/recent'],
		);
	});

	test('preserves git order for non-common branches', () => {
		assert.deepStrictEqual(
			getBranchCompletions(['feature/recent', 'release', 'feature/older']),
			['feature/recent', 'release', 'feature/older'],
		);
	});

	test('filters before sorting common branch names', () => {
		assert.deepStrictEqual(
			getBranchCompletions(['feature/recent', 'master', 'main', 'maintenance'], { query: 'ma' }),
			['main', 'master', 'maintenance'],
		);
	});

	suite('parseGitStatusV2', () => {
		test('parses a clean checkout with upstream', () => {
			const out = [
				'# branch.oid 0123456789abcdef0123456789abcdef01234567',
				'# branch.head main',
				'# branch.upstream origin/main',
				'# branch.ab +0 -0',
			].join('\n');
			assert.deepStrictEqual(parseGitStatusV2(out), {
				branchName: 'main',
				upstreamBranchName: 'origin/main',
				outgoingChanges: 0,
				incomingChanges: 0,
				uncommittedChanges: 0,
			});
		});

		test('parses a dirty branch ahead and behind upstream', () => {
			const out = [
				'# branch.oid 0123456789abcdef0123456789abcdef01234567',
				'# branch.head feature',
				'# branch.upstream origin/feature',
				'# branch.ab +3 -2',
				'1 .M N... 100644 100644 100644 abc abc src/a.ts',
				'2 R. N... 100644 100644 100644 abc abc R100 src/b.ts\tsrc/old-b.ts',
				'? src/untracked.ts',
			].join('\n');
			assert.deepStrictEqual(parseGitStatusV2(out), {
				branchName: 'feature',
				upstreamBranchName: 'origin/feature',
				outgoingChanges: 3,
				incomingChanges: 2,
				uncommittedChanges: 3,
			});
		});

		test('treats (detached) HEAD as no branch and omits upstream/ab when absent', () => {
			const out = [
				'# branch.oid 0123456789abcdef0123456789abcdef01234567',
				'# branch.head (detached)',
			].join('\n');
			assert.deepStrictEqual(parseGitStatusV2(out), {
				branchName: undefined,
				upstreamBranchName: undefined,
				outgoingChanges: undefined,
				incomingChanges: undefined,
				uncommittedChanges: 0,
			});
		});

		test('returns empty object for undefined input', () => {
			assert.deepStrictEqual(parseGitStatusV2(undefined), {});
		});
	});

	suite('parseHasGitHubRemote', () => {
		test('detects ssh github remote', () => {
			assert.strictEqual(parseHasGitHubRemote('origin\tgit@github.com:owner/repo.git (fetch)\n'), true);
		});
		test('detects https github remote', () => {
			assert.strictEqual(parseHasGitHubRemote('origin\thttps://github.com/owner/repo.git (fetch)\n'), true);
		});
		test('returns false for non-github remotes', () => {
			assert.strictEqual(parseHasGitHubRemote('origin\thttps://gitlab.com/owner/repo.git (fetch)\n'), false);
		});
		test('returns false when there are no remotes', () => {
			assert.strictEqual(parseHasGitHubRemote(''), false);
		});
		test('returns undefined when probe failed (output absent)', () => {
			assert.strictEqual(parseHasGitHubRemote(undefined), undefined);
		});
	});

	suite('parseDefaultBranchRef', () => {
		test('strips refs/remotes/origin/ prefix', () => {
			assert.strictEqual(parseDefaultBranchRef('refs/remotes/origin/main\n'), 'main');
		});
		test('returns the ref as-is when prefix is not present', () => {
			assert.strictEqual(parseDefaultBranchRef('main'), 'main');
		});
		test('returns undefined for empty/missing output', () => {
			assert.strictEqual(parseDefaultBranchRef(undefined), undefined);
			assert.strictEqual(parseDefaultBranchRef('   '), undefined);
		});
	});

	suite('getSessionGitState', () => {
		// Skip the on-disk git tests when `git` is not on PATH (e.g. minimal CI).
		const hasGit = (() => {
			try { cp.execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
		})();

		let tmpRoot: string | undefined;
		let svc: AgentHostGitService | undefined;

		setup(() => {
			tmpRoot = undefined;
			svc = new AgentHostGitService();
		});

		teardown(() => {
			if (tmpRoot) {
				rmSync(tmpRoot, { recursive: true, force: true });
			}
		});

		function initRepo(opts?: { remote?: string; baseBranch?: string }): string {
			tmpRoot = mkdtempSync(join(tmpdir(), 'agent-host-git-'));
			const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
			const run = (...args: string[]) => cp.execFileSync('git', args, { cwd: tmpRoot!, env, stdio: 'pipe' });
			run('init', '-q', '-b', opts?.baseBranch ?? 'main');
			run('commit', '-q', '--allow-empty', '-m', 'initial');
			if (opts?.remote) {
				run('remote', 'add', 'origin', opts.remote);
			}
			return tmpRoot!;
		}

		(hasGit ? test : test.skip)('returns undefined for a non-git directory', async () => {
			const dir = mkdtempSync(join(tmpdir(), 'agent-host-nongit-'));
			tmpRoot = dir;
			const result = await svc!.getSessionGitState(URI.file(dir));
			assert.strictEqual(result, undefined);
		});

		(hasGit ? test : test.skip)('reports branch, github remote and clean state for a fresh repo', async () => {
			const dir = initRepo({ remote: 'https://github.com/owner/repo.git' });
			const result = await svc!.getSessionGitState(URI.file(dir));
			assert.ok(result, 'expected git state');
			assert.strictEqual(result.branchName, 'main');
			assert.strictEqual(result.hasGitHubRemote, true);
			assert.strictEqual(result.uncommittedChanges, 0);
			// No upstream configured for the fresh local branch.
			assert.strictEqual(result.upstreamBranchName, undefined);
			assert.strictEqual(result.outgoingChanges, undefined);
			assert.strictEqual(result.incomingChanges, undefined);
		});

		(hasGit ? test : test.skip)('counts uncommitted changes', async () => {
			const dir = initRepo({ remote: 'git@gitlab.com:owner/repo.git' });
			const fs = await import('fs/promises');
			await fs.writeFile(join(dir, 'a.txt'), 'hello');
			await fs.writeFile(join(dir, 'b.txt'), 'world');
			const result = await svc!.getSessionGitState(URI.file(dir));
			assert.ok(result);
			assert.strictEqual(result.uncommittedChanges, 2);
			assert.strictEqual(result.hasGitHubRemote, false);
		});

		(hasGit ? test : test.skip)('caches results across rapid calls', async () => {
			const dir = initRepo();
			const a = await svc!.getSessionGitState(URI.file(dir));
			const b = await svc!.getSessionGitState(URI.file(dir));
			// Same identity proves the cached promise was returned.
			assert.strictEqual(a, b);
		});
	});
});

