/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ILogService } from '../../../log/common/log.js';

/**
 * Maximum number of distinct GitHub references resolved for a single prompt.
 * Guards against a prompt with many URLs flooding the GitHub API.
 */
const MAX_GITHUB_REFERENCES = 5;

/**
 * Matches github.com issue, pull-request, and discussion web URLs. GitHub
 * Enterprise hosts are intentionally excluded — they would not resolve against
 * api.github.com.
 */
const GITHUB_REFERENCE_RE = /https?:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)\/(issues|pull|discussions)\/(\d+)(?!\w)/gi;

/** The kind of GitHub item a reference points at (matches gh-app's `itemType`). */
export type GitHubReferenceType = 'issue' | 'pr' | 'discussion';

const URL_KIND_TO_REFERENCE_TYPE: Record<string, GitHubReferenceType> = {
	issues: 'issue',
	pull: 'pr',
	discussions: 'discussion',
};

/** A github.com issue/PR/discussion reference parsed out of prompt text. */
export interface IParsedGitHubReference {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	readonly referenceType: GitHubReferenceType;
	readonly url: string;
}

/** A GitHub reference resolved to the fields needed to ground the agent. */
export interface IResolvedGitHubReference {
	readonly number: number;
	readonly title: string;
	readonly state: string;
	readonly referenceType: GitHubReferenceType;
	readonly url: string;
	readonly labels: readonly string[];
}

/** A GitHub API request: a REST GET or a GraphQL POST. */
export interface IGitHubApiRequest {
	readonly url: string;
	readonly method: 'GET' | 'POST';
	readonly body?: string;
}

/** Result of a GitHub API request: HTTP status plus the parsed JSON body. */
export interface IGitHubApiResponse {
	readonly status: number;
	readonly body: unknown;
}

/**
 * Performs an authenticated GitHub API request and returns the parsed JSON body.
 * Returns `undefined` on transport failure/cancellation.
 */
export type GitHubApiRequestFn = (request: IGitHubApiRequest, token: CancellationToken) => Promise<IGitHubApiResponse | undefined>;

/** Extracts unique github.com issue/PR/discussion references from prompt text. */
export function extractGitHubReferences(text: string): IParsedGitHubReference[] {
	const out: IParsedGitHubReference[] = [];
	const seen = new Set<string>();
	for (const match of text.matchAll(GITHUB_REFERENCE_RE)) {
		const [url, owner, repo, kind, numberText] = match;
		const number = Number(numberText);
		if (!Number.isSafeInteger(number) || number <= 0) {
			continue;
		}
		const referenceType = URL_KIND_TO_REFERENCE_TYPE[kind.toLowerCase()];
		if (!referenceType) {
			continue;
		}
		const key = `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}:${referenceType}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		out.push({ owner, repo, number, referenceType, url });
	}
	return out;
}

/**
 * Builds the `<github_references>` prompt block from resolved references, using
 * the same format as github/github-app so the Copilot runtime grounds the agent
 * identically. Returns an empty string when there is nothing to inject.
 */
export function buildGitHubReferencesBlock(references: readonly IResolvedGitHubReference[]): string {
	if (references.length === 0) {
		return '';
	}
	const lines = references.map(reference => {
		const title = reference.title || reference.referenceType;
		let line = `#${reference.number} - ${escapeXml(title)} [${reference.referenceType}] [${escapeXml(reference.state.toUpperCase())}] (${escapeXml(reference.url)})`;
		if (reference.labels.length > 0) {
			line += `\n  Labels: ${reference.labels.map(escapeXml).join(', ')}`;
		}
		return line;
	});
	return `<github_references>\n${lines.join('\n')}\n</github_references>`;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

interface IGitHubItemPayload {
	readonly title?: unknown;
	readonly state?: unknown;
	readonly merged_at?: unknown;
	readonly labels?: unknown;
}

interface IGitHubDiscussionResponse {
	readonly data?: {
		readonly repository?: {
			readonly discussion?: {
				readonly title?: unknown;
				readonly closed?: unknown;
				readonly labels?: { readonly nodes?: unknown };
			} | null;
		} | null;
	} | null;
}

const DISCUSSION_QUERY = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){discussion(number:$number){title closed labels(first:20){nodes{name}}}}}';

/**
 * Resolves github.com references to title/state/labels via the GitHub API so the
 * Copilot runtime can ground the agent (e.g. to produce a content-based session
 * title). Resolution is best-effort: any failure yields no reference and the
 * caller sends the message unchanged. Successful resolutions are cached per
 * `(owner, repo, number, type)` for the lifetime of the instance (one per
 * session); failures are not cached, so a later turn can retry.
 */
export class GitHubReferenceResolver {

	private readonly _cache = new Map<string, IResolvedGitHubReference>();

	constructor(
		private readonly _request: GitHubApiRequestFn,
		private readonly _logService: ILogService,
	) { }

	async resolveReferences(references: readonly IParsedGitHubReference[], token: CancellationToken): Promise<IResolvedGitHubReference[]> {
		const limited = references.slice(0, MAX_GITHUB_REFERENCES);
		const resolved = await Promise.all(limited.map(reference => this._resolveOne(reference, token)));
		return resolved.filter((reference): reference is IResolvedGitHubReference => !!reference);
	}

	private async _resolveOne(reference: IParsedGitHubReference, token: CancellationToken): Promise<IResolvedGitHubReference | undefined> {
		const key = `${reference.owner.toLowerCase()}/${reference.repo.toLowerCase()}#${reference.number}:${reference.referenceType}`;
		const cached = this._cache.get(key);
		if (cached) {
			return cached;
		}
		try {
			const resolved = reference.referenceType === 'discussion'
				? await this._fetchDiscussion(reference, token)
				: await this._fetchIssueOrPr(reference, token);
			// Cache only successful resolutions; a failure stays uncached so a later turn can retry.
			if (resolved) {
				this._cache.set(key, resolved);
			}
			return resolved;
		} catch {
			// A single failing reference must not reject the whole batch (Promise.all in resolveReferences).
			this._logService.trace(`[GitHubReferenceResolver] ${key} failed to resolve; skipping`);
			return undefined;
		}
	}

	private async _fetchIssueOrPr(reference: IParsedGitHubReference, token: CancellationToken): Promise<IResolvedGitHubReference | undefined> {
		const apiPath = reference.referenceType === 'pr' ? 'pulls' : 'issues';
		const url = `https://api.github.com/repos/${reference.owner}/${reference.repo}/${apiPath}/${reference.number}`;
		const response = await this._request({ url, method: 'GET' }, token);
		if (!this._isOk(response, url)) {
			return undefined;
		}
		const payload = response.body as IGitHubItemPayload | null | undefined;
		if (!payload || typeof payload.title !== 'string' || typeof payload.state !== 'string') {
			return undefined;
		}
		const state = reference.referenceType === 'pr' && typeof payload.merged_at === 'string'
			? 'merged'
			: payload.state;
		return {
			number: reference.number,
			title: payload.title,
			state,
			referenceType: reference.referenceType,
			url: reference.url,
			labels: extractLabelNames(payload.labels),
		};
	}

	private async _fetchDiscussion(reference: IParsedGitHubReference, token: CancellationToken): Promise<IResolvedGitHubReference | undefined> {
		const body = JSON.stringify({ query: DISCUSSION_QUERY, variables: { owner: reference.owner, name: reference.repo, number: reference.number } });
		const response = await this._request({ url: 'https://api.github.com/graphql', method: 'POST', body }, token);
		if (!this._isOk(response, `graphql discussion ${reference.owner}/${reference.repo}#${reference.number}`)) {
			return undefined;
		}
		const discussion = (response.body as IGitHubDiscussionResponse | null | undefined)?.data?.repository?.discussion;
		if (!discussion || typeof discussion.title !== 'string') {
			return undefined;
		}
		return {
			number: reference.number,
			title: discussion.title,
			state: discussion.closed === true ? 'closed' : 'open',
			referenceType: 'discussion',
			url: reference.url,
			labels: extractLabelNames(discussion.labels?.nodes),
		};
	}

	private _isOk(response: IGitHubApiResponse | undefined, label: string): response is IGitHubApiResponse {
		if (!response) {
			return false;
		}
		if (response.status < 200 || response.status >= 300) {
			this._logService.trace(`[GitHubReferenceResolver] ${label} → HTTP ${response.status}; skipping`);
			return false;
		}
		return true;
	}
}

/** Extracts label names from a REST `labels` array or a GraphQL `nodes` array. */
function extractLabelNames(raw: unknown): string[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const names: string[] = [];
	for (const entry of raw) {
		if (typeof entry === 'string') {
			names.push(entry);
		} else if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
			names.push((entry as { name: string }).name);
		}
	}
	return names;
}
