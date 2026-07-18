/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { buildSkillInvocationPrompt } from '../../common/agentHostSkillInvocation.js';

suite('agentHostSkillInvocation - buildSkillInvocationPrompt', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('asks the model to use the skill tool for the named skill', () => {
		assert.strictEqual(
			buildSkillInvocationPrompt('review'),
			`Use the skill tool to invoke the 'review' skill, then follow the skill's instructions.`,
		);
	});

	test('appends trimmed user instructions as additional context', () => {
		assert.strictEqual(
			buildSkillInvocationPrompt('review', '  focus on error handling  '),
			`Use the skill tool to invoke the 'review' skill, then follow the skill's instructions.\n\nAdditional context from the user:\nfocus on error handling`,
		);
	});

	test('omits the context block for empty instructions', () => {
		assert.strictEqual(
			buildSkillInvocationPrompt('review', '   '),
			`Use the skill tool to invoke the 'review' skill, then follow the skill's instructions.`,
		);
	});
});
