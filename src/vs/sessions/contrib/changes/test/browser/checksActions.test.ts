/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { getPullRequestCIModelForPullRequest } from '../../browser/checksActions.js';
import { IGitHubService } from '../../../github/browser/githubService.js';
import { GitHubPullRequestCIModel } from '../../../github/browser/models/githubPullRequestCIModel.js';
import { GitHubPullRequestState, IGitHubPullRequest } from '../../../github/common/types.js';

suite('ChecksActions', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses the pull request head SHA for CI model lookup', () => {
		const gitHubService = new TestGitHubService();

		getPullRequestCIModelForPullRequest(gitHubService, 'owner', 'repo', 1, makePullRequest({ headRef: 'feature-branch', headSha: 'abc123' }));

		assert.deepStrictEqual(gitHubService.lastPullRequestCIRequest, {
			owner: 'owner',
			repo: 'repo',
			prNumber: 1,
			headRefOrSha: 'abc123',
		});
	});
});

class TestGitHubService extends mock<IGitHubService>() {

	lastPullRequestCIRequest: { owner: string; repo: string; prNumber: number; headRefOrSha: string } | undefined;

	override getPullRequestCI(owner: string, repo: string, prNumber: number, headRefOrSha: string): GitHubPullRequestCIModel {
		this.lastPullRequestCIRequest = { owner, repo, prNumber, headRefOrSha };
		return {} as GitHubPullRequestCIModel;
	}
}

function makePullRequest(overrides: Pick<IGitHubPullRequest, 'headRef' | 'headSha'>): IGitHubPullRequest {
	return {
		number: 1,
		title: 'Pull Request',
		body: '',
		state: GitHubPullRequestState.Open,
		author: { login: 'octocat', avatarUrl: '' },
		headRef: overrides.headRef,
		headSha: overrides.headSha,
		baseRef: 'main',
		isDraft: false,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		mergedAt: undefined,
		mergeable: true,
		mergeableState: 'clean',
	};
}
