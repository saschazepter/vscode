/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { summarizeGuardianReviewAction, toGuardianAssessmentEventJson } from '../../../node/codex/codexGuardianReview.js';
import type { ItemGuardianApprovalReviewCompletedNotification } from '../../../node/codex/protocol/generated/v2/ItemGuardianApprovalReviewCompletedNotification.js';

suite('codexGuardianReview', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const deniedNetworkReview: ItemGuardianApprovalReviewCompletedNotification = {
		threadId: 'thread-1',
		turnId: 'turn-1',
		startedAtMs: 1234,
		completedAtMs: 2345,
		reviewId: 'review-1',
		targetItemId: null,
		decisionSource: 'agent',
		review: {
			status: 'denied',
			riskLevel: 'critical',
			userAuthorization: 'unknown',
			rationale: 'Network access is not allowed for this prompt.',
		},
		action: {
			type: 'networkAccess',
			target: 'https://developers.openai.com/codex/app-server',
			host: 'developers.openai.com',
			protocol: 'https',
			port: 443,
		},
	};

	test('toGuardianAssessmentEventJson converts network review payloads to snake_case', () => {
		assert.deepStrictEqual(toGuardianAssessmentEventJson(deniedNetworkReview), {
			id: 'review-1',
			turn_id: 'turn-1',
			started_at_ms: 1234,
			completed_at_ms: 2345,
			status: 'denied',
			risk_level: 'critical',
			user_authorization: 'unknown',
			rationale: 'Network access is not allowed for this prompt.',
			decision_source: 'agent',
			action: {
				type: 'network_access',
				target: 'https://developers.openai.com/codex/app-server',
				host: 'developers.openai.com',
				protocol: 'https',
				port: 443,
			},
		});
	});

	test('summarizeGuardianReviewAction labels denied network access clearly', () => {
		assert.deepStrictEqual(summarizeGuardianReviewAction(deniedNetworkReview.action), {
			title: 'Network access',
			detail: 'https://developers.openai.com/codex/app-server',
			toolKind: 'search',
		});
	});
});
