/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import { URI } from '../../../base/common/uri.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { ISessionGitState } from '../common/state/sessionState.js';

export const IAgentHostGitService = createDecorator<IAgentHostGitService>('agentHostGitService');

export interface IAgentHostGitService {
	readonly _serviceBrand: undefined;
	isInsideWorkTree(workingDirectory: URI): Promise<boolean>;
	getCurrentBranch(workingDirectory: URI): Promise<string | undefined>;
	getDefaultBranch(workingDirectory: URI): Promise<string | undefined>;
	getBranches(workingDirectory: URI, options?: { readonly query?: string; readonly limit?: number }): Promise<string[]>;
	getRepositoryRoot(workingDirectory: URI): Promise<URI | undefined>;
	getWorktreeRoots(workingDirectory: URI): Promise<URI[]>;
	addWorktree(repositoryRoot: URI, worktree: URI, branchName: string, startPoint: string): Promise<void>;
	removeWorktree(repositoryRoot: URI, worktree: URI): Promise<void>;
	/**
	 * Computes the {@link ISessionGitState} for the working directory by
	 * shelling out to `git`. Returns undefined if the directory is not a
	 * git work tree. Results are cached briefly per working directory to
	 * absorb back-to-back `listSessions` calls.
	 */
	getSessionGitState(workingDirectory: URI): Promise<ISessionGitState | undefined>;
}

function getCommonBranchPriority(branch: string): number {
	if (branch === 'main') {
		return 0;
	}
	if (branch === 'master') {
		return 1;
	}
	return 2;
}

export function getBranchCompletions(branches: readonly string[], options?: { readonly query?: string; readonly limit?: number }): string[] {
	const normalizedQuery = options?.query?.toLowerCase();
	const filtered = normalizedQuery
		? branches.filter(branch => branch.toLowerCase().includes(normalizedQuery))
		: [...branches];

	filtered.sort((a, b) => getCommonBranchPriority(a) - getCommonBranchPriority(b));
	return options?.limit ? filtered.slice(0, options.limit) : filtered;
}

export class AgentHostGitService implements IAgentHostGitService {
	declare readonly _serviceBrand: undefined;

	async isInsideWorkTree(workingDirectory: URI): Promise<boolean> {
		return (await this._runGit(workingDirectory, ['rev-parse', '--is-inside-work-tree']))?.trim() === 'true';
	}

	async getCurrentBranch(workingDirectory: URI): Promise<string | undefined> {
		return (await this._runGit(workingDirectory, ['branch', '--show-current']))?.trim()
			|| (await this._runGit(workingDirectory, ['rev-parse', '--short', 'HEAD']))?.trim()
			|| undefined;
	}

	async getDefaultBranch(workingDirectory: URI): Promise<string | undefined> {
		// Try to read the default branch from the remote HEAD reference
		const remoteRef = (await this._runGit(workingDirectory, ['symbolic-ref', 'refs/remotes/origin/HEAD']))?.trim();
		if (remoteRef) {
			if (!remoteRef.startsWith('refs/remotes/origin/')) {
				return remoteRef;
			}

			const branch = remoteRef.substring('refs/remotes/origin/'.length);
			// Check whether a local branch exists; if not, use the remote-tracking ref
			// so that 'git worktree add ... <startPoint>' resolves correctly.
			const hasLocalBranch = (await this._runGit(workingDirectory, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) !== undefined;
			return hasLocalBranch ? branch : `origin/${branch}`;
		}
		return undefined;
	}

	async getBranches(workingDirectory: URI, options?: { readonly query?: string; readonly limit?: number }): Promise<string[]> {
		const args = ['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate'];
		args.push('refs/heads');

		const output = await this._runGit(workingDirectory, args);
		if (!output) {
			return [];
		}
		const branches = output.split(/\r?\n/g).map(line => line.trim()).filter(branch => branch.length > 0);
		return getBranchCompletions(branches, options);
	}

	async getRepositoryRoot(workingDirectory: URI): Promise<URI | undefined> {
		const repositoryRootPath = (await this._runGit(workingDirectory, ['rev-parse', '--show-toplevel']))?.trim();
		return repositoryRootPath ? URI.file(repositoryRootPath) : undefined;
	}

	async getWorktreeRoots(workingDirectory: URI): Promise<URI[]> {
		const output = await this._runGit(workingDirectory, ['worktree', 'list', '--porcelain']);
		if (!output) {
			return [];
		}
		return output.split(/\r?\n/g)
			.filter(line => line.startsWith('worktree '))
			.map(line => URI.file(line.substring('worktree '.length)));
	}

	async addWorktree(repositoryRoot: URI, worktree: URI, branchName: string, startPoint: string): Promise<void> {
		await this._runGit(repositoryRoot, ['worktree', 'add', '-b', branchName, worktree.fsPath, startPoint], { timeout: 30_000, throwOnError: true });
	}

	async removeWorktree(repositoryRoot: URI, worktree: URI): Promise<void> {
		await this._runGit(repositoryRoot, ['worktree', 'remove', '--force', worktree.fsPath], { timeout: 30_000, throwOnError: true });
	}

	/**
	 * Cached results of {@link getSessionGitState}, keyed by working
	 * directory fsPath. Each entry carries the timestamp when it was
	 * computed; entries older than {@link AgentHostGitService._GIT_STATE_TTL_MS}
	 * are recomputed on the next access. The cache also coalesces concurrent
	 * callers onto the same in-flight promise.
	 *
	 * The cache is bounded to {@link AgentHostGitService._GIT_STATE_CACHE_MAX}
	 * entries. Stale entries are pruned opportunistically on each insertion.
	 */
	private readonly _gitStateCache = new Map<string, { computedAt: number; promise: Promise<ISessionGitState | undefined> }>();
	private static readonly _GIT_STATE_TTL_MS = 5_000;
	private static readonly _GIT_STATE_CACHE_MAX = 256;

	async getSessionGitState(workingDirectory: URI): Promise<ISessionGitState | undefined> {
		const key = workingDirectory.fsPath;
		const cached = this._gitStateCache.get(key);
		const now = Date.now();
		if (cached && (now - cached.computedAt) < AgentHostGitService._GIT_STATE_TTL_MS) {
			return cached.promise;
		}
		this._pruneGitStateCache(now);
		const entry = { computedAt: now, promise: this._computeSessionGitState(workingDirectory) };
		this._gitStateCache.set(key, entry);
		// On rejection, evict so the next call retries. (Computation never throws,
		// but be defensive.)
		entry.promise.catch(() => {
			if (this._gitStateCache.get(key) === entry) {
				this._gitStateCache.delete(key);
			}
		});
		return entry.promise;
	}

	private _pruneGitStateCache(now: number): void {
		// Remove all entries past TTL.
		for (const [key, entry] of this._gitStateCache) {
			if (now - entry.computedAt > AgentHostGitService._GIT_STATE_TTL_MS) {
				this._gitStateCache.delete(key);
			}
		}
		// If still over the cap, evict oldest entries first.
		if (this._gitStateCache.size >= AgentHostGitService._GIT_STATE_CACHE_MAX) {
			const sorted = [...this._gitStateCache.entries()].sort((a, b) => a[1].computedAt - b[1].computedAt);
			const excess = this._gitStateCache.size - AgentHostGitService._GIT_STATE_CACHE_MAX + 1;
			for (let i = 0; i < excess; i++) {
				this._gitStateCache.delete(sorted[i][0]);
			}
		}
	}

	private async _computeSessionGitState(workingDirectory: URI): Promise<ISessionGitState | undefined> {
		// Bail fast if not inside a git work tree.
		const inside = await this._runGit(workingDirectory, ['rev-parse', '--is-inside-work-tree']);
		if (inside?.trim() !== 'true') {
			return undefined;
		}

		// Run all probes in parallel. Each handles its own errors and returns
		// undefined on failure so we can populate fields independently.
		const [
			statusOutput,
			remotesOutput,
			defaultBranchRef,
		] = await Promise.all([
			this._runGit(workingDirectory, ['status', '-b', '--porcelain=v2']),
			this._runGit(workingDirectory, ['remote', '-v']),
			this._runGit(workingDirectory, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']),
		]);

		const status = parseGitStatusV2(statusOutput);
		const hasGitHubRemote = parseHasGitHubRemote(remotesOutput);
		const baseBranchName = parseDefaultBranchRef(defaultBranchRef);

		const result: ISessionGitState = {
			hasGitHubRemote,
			branchName: status.branchName,
			baseBranchName,
			upstreamBranchName: status.upstreamBranchName,
			incomingChanges: status.incomingChanges,
			outgoingChanges: status.outgoingChanges,
			uncommittedChanges: status.uncommittedChanges,
		};
		// Strip undefined fields so the resulting object is the same regardless
		// of which probes succeeded — easier to compare in tests.
		return stripUndefined(result);
	}

	private _runGit(workingDirectory: URI, args: readonly string[], options?: { readonly timeout?: number; readonly throwOnError?: boolean }): Promise<string | undefined> {
		return new Promise((resolve, reject) => {
			cp.execFile('git', [...args], { cwd: workingDirectory.fsPath, timeout: options?.timeout ?? 5000 }, (error, stdout, stderr) => {
				if (error) {
					if (options?.throwOnError) {
						reject(new Error(stderr || error.message));
						return;
					}
					resolve(undefined);
					return;
				}
				resolve(stdout);
			});
		});
	}
}

/**
 * Parses output of `git status -b --porcelain=v2`. The format is documented
 * at https://git-scm.com/docs/git-status. We care about a few header lines:
 *
 *   # branch.head <name>
 *   # branch.upstream <name>
 *   # branch.ab +<ahead> -<behind>
 *
 * and the count of non-header lines (one per changed entry).
 *
 * Exported for tests.
 */
export function parseGitStatusV2(output: string | undefined): {
	branchName?: string;
	upstreamBranchName?: string;
	outgoingChanges?: number;
	incomingChanges?: number;
	uncommittedChanges?: number;
} {
	if (!output) {
		return {};
	}
	let branchName: string | undefined;
	let upstreamBranchName: string | undefined;
	let outgoingChanges: number | undefined;
	let incomingChanges: number | undefined;
	let uncommittedChanges = 0;
	for (const rawLine of output.split(/\r?\n/g)) {
		const line = rawLine.trimEnd();
		if (!line) { continue; }
		if (line.startsWith('# branch.head ')) {
			const head = line.substring('# branch.head '.length).trim();
			// `(detached)` is what git emits for a detached HEAD. Treat as no branch.
			branchName = head === '(detached)' ? undefined : head;
		} else if (line.startsWith('# branch.upstream ')) {
			upstreamBranchName = line.substring('# branch.upstream '.length).trim();
		} else if (line.startsWith('# branch.ab ')) {
			const m = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
			if (m) {
				outgoingChanges = Number(m[1]);
				incomingChanges = Number(m[2]);
			}
		} else if (!line.startsWith('#')) {
			uncommittedChanges++;
		}
	}
	return { branchName, upstreamBranchName, outgoingChanges, incomingChanges, uncommittedChanges };
}

/** Exported for tests. */
export function parseHasGitHubRemote(remotesOutput: string | undefined): boolean | undefined {
	if (remotesOutput === undefined) {
		return undefined;
	}
	if (!remotesOutput.trim()) {
		return false;
	}
	return /github\.com[:\/]/i.test(remotesOutput);
}

/** Exported for tests. */
export function parseDefaultBranchRef(symbolicRefOutput: string | undefined): string | undefined {
	const ref = symbolicRefOutput?.trim();
	if (!ref) { return undefined; }
	const prefix = 'refs/remotes/origin/';
	return ref.startsWith(prefix) ? ref.substring(prefix.length) : ref;
}

function stripUndefined<T extends object>(obj: T): T {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) { out[k] = v; }
	}
	return out as T;
}
