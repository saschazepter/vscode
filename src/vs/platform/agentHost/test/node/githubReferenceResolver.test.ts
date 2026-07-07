/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { buildGitHubReferencesBlock, extractGitHubReferences, GitHubReferenceResolver, type GitHubApiRequestFn, type IGitHubApiRequest, type IGitHubApiResponse } from '../../node/copilot/githubReferenceResolver.js';

/**
 * Routes a request to a canned response. REST GETs are keyed by URL; GraphQL
 * POSTs are keyed by `graphql:<owner>/<name>#<number>` parsed from the body.
 */
function keyFor(request: IGitHubApiRequest): string {
	if (request.method !== 'POST') {
		return request.url;
	}
	const variables = request.body ? (JSON.parse(request.body).variables ?? {}) : {};
	return `graphql:${variables.owner}/${variables.name}#${variables.number}`;
}

function createResolver(responses: Record<string, IGitHubApiResponse | undefined>, calls?: string[]): GitHubReferenceResolver {
	const request: GitHubApiRequestFn = async (req: IGitHubApiRequest) => {
		const key = keyFor(req);
		calls?.push(key);
		return responses[key];
	};
	return new GitHubReferenceResolver(request, new NullLogService());
}

suite('extractGitHubReferences', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('extracts issue/PR/discussion references, dedupes, and ignores non-github.com hosts', () => {
		const text = [
			'fix https://github.com/microsoft/vscode/issues/313987',
			'see https://github.com/microsoft/vscode/pull/42',
			'discuss https://github.com/microsoft/vscode/discussions/100',
			'dup https://github.com/microsoft/vscode/issues/313987',
			'enterprise https://github.example.com/org/repo/issues/7',
			'gitlab https://gitlab.com/org/repo/issues/8',
		].join('\n');

		assert.deepStrictEqual(extractGitHubReferences(text), [
			{ owner: 'microsoft', repo: 'vscode', number: 313987, referenceType: 'issue', url: 'https://github.com/microsoft/vscode/issues/313987' },
			{ owner: 'microsoft', repo: 'vscode', number: 42, referenceType: 'pr', url: 'https://github.com/microsoft/vscode/pull/42' },
			{ owner: 'microsoft', repo: 'vscode', number: 100, referenceType: 'discussion', url: 'https://github.com/microsoft/vscode/discussions/100' },
		]);
	});

	test('stops the number at a URL delimiter and rejects a trailing word character', () => {
		const text = [
			'end https://github.com/o/r/issues/1',
			'frag https://github.com/o/r/issues/2#issuecomment-9',
			'query https://github.com/o/r/pull/3?w=1',
			'paren (https://github.com/o/r/issues/4)',
			'bad https://github.com/o/r/issues/5abc',
		].join('\n');

		assert.deepStrictEqual(extractGitHubReferences(text), [
			{ owner: 'o', repo: 'r', number: 1, referenceType: 'issue', url: 'https://github.com/o/r/issues/1' },
			{ owner: 'o', repo: 'r', number: 2, referenceType: 'issue', url: 'https://github.com/o/r/issues/2' },
			{ owner: 'o', repo: 'r', number: 3, referenceType: 'pr', url: 'https://github.com/o/r/pull/3' },
			{ owner: 'o', repo: 'r', number: 4, referenceType: 'issue', url: 'https://github.com/o/r/issues/4' },
		]);
	});
});

suite('GitHubReferenceResolver', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('resolves issues and PRs, deriving merged state from merged_at and extracting label names', async () => {
		const resolver = createResolver({
			'https://api.github.com/repos/o/r/issues/1': { status: 200, body: { title: 'Open issue', state: 'open', labels: [{ name: 'bug' }, { name: 'confirmed' }] } },
			'https://api.github.com/repos/o/r/issues/2': { status: 200, body: { title: 'Closed issue', state: 'closed' } },
			'https://api.github.com/repos/o/r/pulls/3': { status: 200, body: { title: 'Merged PR', state: 'closed', merged_at: '2020-01-01T00:00:00Z' } },
			'https://api.github.com/repos/o/r/pulls/4': { status: 200, body: { title: 'Open PR', state: 'open', merged_at: null } },
		});
		const references = extractGitHubReferences([
			'https://github.com/o/r/issues/1',
			'https://github.com/o/r/issues/2',
			'https://github.com/o/r/pull/3',
			'https://github.com/o/r/pull/4',
		].join('\n'));

		const resolved = await resolver.resolveReferences(references, CancellationToken.None);

		assert.deepStrictEqual(resolved, [
			{ number: 1, title: 'Open issue', state: 'open', referenceType: 'issue', url: 'https://github.com/o/r/issues/1', labels: ['bug', 'confirmed'] },
			{ number: 2, title: 'Closed issue', state: 'closed', referenceType: 'issue', url: 'https://github.com/o/r/issues/2', labels: [] },
			{ number: 3, title: 'Merged PR', state: 'merged', referenceType: 'pr', url: 'https://github.com/o/r/pull/3', labels: [] },
			{ number: 4, title: 'Open PR', state: 'open', referenceType: 'pr', url: 'https://github.com/o/r/pull/4', labels: [] },
		]);
	});

	test('resolves discussions via GraphQL, mapping closed to state and reading label nodes', async () => {
		const resolver = createResolver({
			'graphql:o/r#5': { status: 200, body: { data: { repository: { discussion: { title: 'How do I X?', closed: false, labels: { nodes: [{ name: 'q-and-a' }] } } } } } },
			'graphql:o/r#6': { status: 200, body: { data: { repository: { discussion: { title: 'Answered', closed: true, labels: { nodes: [] } } } } } },
		});
		const references = extractGitHubReferences('https://github.com/o/r/discussions/5 https://github.com/o/r/discussions/6');

		const resolved = await resolver.resolveReferences(references, CancellationToken.None);

		assert.deepStrictEqual(resolved, [
			{ number: 5, title: 'How do I X?', state: 'open', referenceType: 'discussion', url: 'https://github.com/o/r/discussions/5', labels: ['q-and-a'] },
			{ number: 6, title: 'Answered', state: 'closed', referenceType: 'discussion', url: 'https://github.com/o/r/discussions/6', labels: [] },
		]);
	});

	test('skips references that fail to resolve (non-2xx, transport failure, or missing discussion)', async () => {
		const resolver = createResolver({
			'https://api.github.com/repos/o/r/issues/1': { status: 404, body: undefined },
			'https://api.github.com/repos/o/r/issues/2': undefined,
			'https://api.github.com/repos/o/r/issues/3': { status: 200, body: { title: 'Ok', state: 'open' } },
			'graphql:o/r#7': { status: 200, body: { data: { repository: { discussion: null } }, errors: [{ message: 'Not found' }] } },
		});
		const references = extractGitHubReferences('https://github.com/o/r/issues/1 https://github.com/o/r/issues/2 https://github.com/o/r/issues/3 https://github.com/o/r/discussions/7');

		const resolved = await resolver.resolveReferences(references, CancellationToken.None);

		assert.deepStrictEqual(resolved, [
			{ number: 3, title: 'Ok', state: 'open', referenceType: 'issue', url: 'https://github.com/o/r/issues/3', labels: [] },
		]);
	});

	test('caches resolved references but retries ones that did not resolve', async () => {
		const calls: string[] = [];
		const resolver = createResolver({
			'https://api.github.com/repos/o/r/issues/1': { status: 200, body: { title: 'A', state: 'open' } },
			'https://api.github.com/repos/o/r/issues/9': { status: 404, body: undefined },
		}, calls);
		const references = extractGitHubReferences('https://github.com/o/r/issues/1 https://github.com/o/r/issues/9');

		await resolver.resolveReferences(references, CancellationToken.None);
		await resolver.resolveReferences(references, CancellationToken.None);

		assert.deepStrictEqual(calls, [
			'https://api.github.com/repos/o/r/issues/1',
			'https://api.github.com/repos/o/r/issues/9',
			'https://api.github.com/repos/o/r/issues/9',
		]);
	});

	test('a reference whose request throws does not discard references that resolved', async () => {
		const request: GitHubApiRequestFn = async (req: IGitHubApiRequest) => {
			if (req.url === 'https://api.github.com/repos/o/r/issues/1') {
				throw new Error('network down');
			}
			return { status: 200, body: { title: 'Good', state: 'open' } };
		};
		const resolver = new GitHubReferenceResolver(request, new NullLogService());
		const references = extractGitHubReferences('https://github.com/o/r/issues/1 https://github.com/o/r/issues/2');

		const resolved = await resolver.resolveReferences(references, CancellationToken.None);

		assert.deepStrictEqual(resolved, [
			{ number: 2, title: 'Good', state: 'open', referenceType: 'issue', url: 'https://github.com/o/r/issues/2', labels: [] },
		]);
	});

	test('caps resolution at the maximum number of references', async () => {
		const calls: string[] = [];
		const urls: string[] = [];
		const responses: Record<string, IGitHubApiResponse> = {};
		for (let i = 1; i <= 6; i++) {
			urls.push(`https://github.com/o/r/issues/${i}`);
			responses[`https://api.github.com/repos/o/r/issues/${i}`] = { status: 200, body: { title: `T${i}`, state: 'open' } };
		}
		const resolver = createResolver(responses, calls);
		const references = extractGitHubReferences(urls.join('\n'));

		const resolved = await resolver.resolveReferences(references, CancellationToken.None);

		assert.strictEqual(resolved.length, 5);
		assert.strictEqual(calls.length, 5);
	});
});

suite('buildGitHubReferencesBlock', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns an empty string when there are no references', () => {
		assert.strictEqual(buildGitHubReferencesBlock([]), '');
	});

	test('formats references like github/github-app, escaping XML and listing labels', () => {
		const block = buildGitHubReferencesBlock([
			{ number: 313987, title: 'Dragging a pinned <tab> & "more"', state: 'open', referenceType: 'issue', url: 'https://github.com/microsoft/vscode/issues/313987', labels: ['bug', 'workbench-tabs'] },
			{ number: 42, title: 'Add feature', state: 'merged', referenceType: 'pr', url: 'https://github.com/microsoft/vscode/pull/42', labels: [] },
		]);

		assert.strictEqual(block, [
			'<github_references>',
			'#313987 - Dragging a pinned &lt;tab&gt; &amp; &quot;more&quot; [issue] [OPEN] (https://github.com/microsoft/vscode/issues/313987)',
			'  Labels: bug, workbench-tabs',
			'#42 - Add feature [pr] [MERGED] (https://github.com/microsoft/vscode/pull/42)',
			'</github_references>',
		].join('\n'));
	});
});
