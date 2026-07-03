/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SequencerByKey } from '../../../base/common/async.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { relativePath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { ILogService } from '../../log/common/log.js';
import { AgentSession } from '../common/agentService.js';
import { EMPTY_TREE_OBJECT, IAgentHostGitService } from '../common/agentHostGitService.js';
import { buildReviewedRefName, IAgentHostReviewService, META_REVIEW_WORKING_DIR } from '../common/agentHostReviewService.js';
import { ISessionDataService } from '../common/sessionDataService.js';

/**
 * Resolved git context shared by the review operations: the repository root,
 * the Branch Changes baseline tree, and the current reviewed ref/tree.
 */
interface IReviewContext {
	readonly repoRoot: URI;
	/** Commit-ish the baseline is anchored on (may be the empty-tree object). */
	readonly baselineCommit: string;
	/** Tree object of the baseline. */
	readonly baselineTree: string;
	/** Name of the session's reviewed ref. */
	readonly reviewedRef: string;
	/** Current reviewed commit, or `undefined` when the ref does not exist yet. */
	readonly reviewedCommit: string | undefined;
	/** Current reviewed tree; equals `baselineTree` when the ref does not exist. */
	readonly reviewedTree: string;
}

export class AgentHostReviewService extends Disposable implements IAgentHostReviewService {
	declare readonly _serviceBrand: undefined;

	/**
	 * Serializes mark/unmark/read per session so back-to-back mutations don't
	 * race on the reviewed ref rebuild and reads observe a consistent ref.
	 * Keyed by session URI string.
	 */
	private readonly _sequencer = new SequencerByKey<string>();

	constructor(
		@IAgentHostGitService private readonly _gitService: IAgentHostGitService,
		@ISessionDataService private readonly _sessionDataService: ISessionDataService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		// When a session's data directory is about to be deleted, delete the
		// reviewed ref we created for it BEFORE the database file disappears
		// (the working directory needed to resolve the repo is read from it).
		this._register(this._sessionDataService.onWillDeleteSessionData(e => {
			e.waitUntil(this.disposeSessionData(e.session));
		}));
	}

	markFileReviewed(sessionUri: URI, workingDirectory: URI, baseBranch: string | undefined, resource: URI): Promise<void> {
		return this._sequencer.queue(sessionUri.toString(), () => this._setReviewed(sessionUri, workingDirectory, baseBranch, resource, true));
	}

	unmarkFileReviewed(sessionUri: URI, workingDirectory: URI, baseBranch: string | undefined, resource: URI): Promise<void> {
		return this._sequencer.queue(sessionUri.toString(), () => this._setReviewed(sessionUri, workingDirectory, baseBranch, resource, false));
	}

	getReviewedPaths(sessionUri: URI, workingDirectory: URI, baseBranch: string | undefined): Promise<ReadonlySet<string>> {
		return this._sequencer.queue(sessionUri.toString(), () => this._getReviewedPaths(sessionUri, workingDirectory, baseBranch));
	}

	private async _setReviewed(sessionUri: URI, workingDirectory: URI, baseBranch: string | undefined, resource: URI, reviewed: boolean): Promise<void> {
		const context = await this._resolveContext(sessionUri, workingDirectory, baseBranch);
		if (!context) {
			return;
		}

		const path = relativePath(context.repoRoot, resource);
		if (!path) {
			this._logService.warn(`[AgentHostReview] '${resource.toString()}' is not under the repository root '${context.repoRoot.toString()}'; skipping`);
			return;
		}

		// To mark a file reviewed, overlay its current working-tree content into
		// the reviewed tree; to unmark, reset it to the baseline content.
		let source: string | undefined;
		if (reviewed) {
			source = await this._gitService.captureWorkingTreeAsTree(workingDirectory);
		} else {
			source = context.baselineTree;
		}
		if (!source) {
			return;
		}

		const newTree = await this._gitService.overlayPathIntoTree(context.repoRoot, context.reviewedTree, path, source);
		if (!newTree) {
			return;
		}
		if (newTree === context.reviewedTree) {
			// No change (already reviewed / already unreviewed) — don't grow the
			// reviewed ref chain with a no-op commit.
			return;
		}

		// The chain's first commit is parented on the baseline commit; the empty
		// tree object is not a commit, so it becomes a parentless root instead.
		const parent = context.reviewedCommit ?? (context.baselineCommit === EMPTY_TREE_OBJECT ? undefined : context.baselineCommit);
		const message = `review: ${reviewed ? 'mark' : 'unmark'} ${path}`;
		const commit = await this._gitService.commitTree(context.repoRoot, newTree, parent, message);
		if (!commit) {
			return;
		}
		await this._gitService.updateRef(context.repoRoot, context.reviewedRef, commit);
		await this._persistWorkingDirectory(sessionUri, workingDirectory);
		this._logService.trace(`[AgentHostReview] ${message} for ${sessionUri.toString()} -> ${context.reviewedRef}@${commit}`);
	}

	private async _getReviewedPaths(sessionUri: URI, workingDirectory: URI, baseBranch: string | undefined): Promise<ReadonlySet<string>> {
		const context = await this._resolveContext(sessionUri, workingDirectory, baseBranch);
		if (!context || !context.reviewedCommit) {
			// No reviewed ref yet means nothing has been reviewed.
			return new Set();
		}

		const workingTree = await this._gitService.captureWorkingTreeAsTree(workingDirectory);
		if (!workingTree) {
			return new Set();
		}

		// Changed = files that differ between the baseline and the working tree
		// (the Branch Changes universe). Unreviewed = files that still differ
		// between the reviewed tree and the working tree. Reviewed is the
		// difference: changed files whose reviewed content already matches the
		// working tree.
		const [changed, unreviewed] = await Promise.all([
			this._gitService.diffTreePaths(context.repoRoot, context.baselineTree, workingTree),
			this._gitService.diffTreePaths(context.repoRoot, context.reviewedTree, workingTree),
		]);
		if (!changed) {
			return new Set();
		}
		const unreviewedSet = new Set(unreviewed ?? []);
		return new Set(changed.filter(path => !unreviewedSet.has(path)));
	}

	private async _resolveContext(sessionUri: URI, workingDirectory: URI, baseBranch: string | undefined): Promise<IReviewContext | undefined> {
		const repoRoot = await this._gitService.getRepositoryRoot(workingDirectory);
		if (!repoRoot) {
			return undefined;
		}
		const baselineCommit = await this._gitService.resolveBranchBaselineCommit(workingDirectory, baseBranch);
		if (!baselineCommit) {
			return undefined;
		}
		const baselineTree = baselineCommit === EMPTY_TREE_OBJECT
			? EMPTY_TREE_OBJECT
			: await this._gitService.revParse(repoRoot, `${baselineCommit}^{tree}`);
		if (!baselineTree) {
			return undefined;
		}
		const reviewedRef = buildReviewedRefName(this._sanitizedSessionId(sessionUri));
		const reviewedCommit = await this._gitService.revParse(repoRoot, reviewedRef);
		const reviewedTree = reviewedCommit
			? await this._gitService.revParse(repoRoot, `${reviewedCommit}^{tree}`) ?? baselineTree
			: baselineTree;
		return { repoRoot, baselineCommit, baselineTree, reviewedRef, reviewedCommit, reviewedTree };
	}

	async disposeSessionData(sessionUri: URI): Promise<void> {
		await this._sequencer.queue(sessionUri.toString(), () => this._disposeSessionData(sessionUri));
	}

	private async _disposeSessionData(sessionUri: URI): Promise<void> {
		const refHandle = await this._sessionDataService.tryOpenDatabase(sessionUri);
		if (!refHandle) {
			return;
		}
		try {
			const workingDirRaw = await refHandle.object.getMetadata(META_REVIEW_WORKING_DIR);
			if (!workingDirRaw) {
				return;
			}
			const repoRoot = await this._gitService.getRepositoryRoot(URI.parse(workingDirRaw));
			if (!repoRoot) {
				return;
			}
			const reviewedRef = buildReviewedRefName(this._sanitizedSessionId(sessionUri));
			await this._gitService.deleteRefs(repoRoot, [reviewedRef]);
			this._logService.trace(`[AgentHostReview] Deleted reviewed ref for ${sessionUri.toString()}`);
		} catch (err) {
			this._logService.warn(`[AgentHostReview] Failed to dispose reviewed ref for ${sessionUri.toString()}`, err);
		} finally {
			refHandle.dispose();
		}
	}

	private async _persistWorkingDirectory(sessionUri: URI, workingDirectory: URI): Promise<void> {
		const ref = this._sessionDataService.openDatabase(sessionUri);
		try {
			if (await ref.object.getMetadata(META_REVIEW_WORKING_DIR) !== workingDirectory.toString()) {
				await ref.object.setMetadata(META_REVIEW_WORKING_DIR, workingDirectory.toString());
			}
		} finally {
			ref.dispose();
		}
	}

	private _sanitizedSessionId(sessionUri: URI): string {
		return AgentSession.id(sessionUri).replace(/[^a-zA-Z0-9_.-]/g, '-');
	}
}
