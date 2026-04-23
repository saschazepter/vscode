/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { type CustomizationRef } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { type URI as ProtocolURI } from '../../../../../../platform/agentHost/common/state/protocol/state.js';
import { resolveCustomizationRefs } from '../../../browser/agentSessions/agentHost/agentHostChatContribution.js';
import { IAgentPlugin } from '../../../common/plugins/agentPluginService.js';
import { PromptsType } from '../../../common/promptSyntax/promptTypes.js';

interface IBundleCall {
	readonly files: readonly { uri: URI; type: PromptsType }[];
}

function makeBundler(ref: CustomizationRef = { uri: 'vscode-synced-customization:///test/' as ProtocolURI, displayName: 'bundle' }) {
	const calls: IBundleCall[] = [];
	const bundler = {
		async bundle(files: readonly { uri: URI; type: PromptsType }[]) {
			calls.push({ files });
			return { ref };
		},
	};
	return { bundler, calls, ref };
}

function makePlugin(uri: URI, label = 'plugin'): IAgentPlugin {
	return {
		uri,
		label,
		description: undefined,
		version: undefined,
		hooks: [],
	} as unknown as IAgentPlugin;
}

suite('resolveCustomizationRefs', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns empty when there are no entries and no built-ins', async () => {
		const { bundler, calls } = makeBundler();
		const refs = await resolveCustomizationRefs([], [], [], bundler);
		assert.deepStrictEqual(refs, []);
		assert.strictEqual(calls.length, 0, 'bundler should not be invoked');
	});

	test('bundles built-in skills even when no user entries are selected', async () => {
		const { bundler, calls, ref } = makeBundler();
		const builtin = { uri: URI.file('/builtin/create-pr/SKILL.md'), type: PromptsType.skill };
		const refs = await resolveCustomizationRefs([], [builtin], [], bundler);
		assert.deepStrictEqual(refs, [ref]);
		assert.strictEqual(calls.length, 1);
		assert.deepStrictEqual(calls[0].files, [builtin]);
	});

	test('combines user file entries with built-in skills in a single bundle call', async () => {
		const { bundler, calls, ref } = makeBundler();
		const userFile = { uri: URI.file('/user/agents/foo.agent.md'), type: PromptsType.agent };
		const builtin = { uri: URI.file('/builtin/merge/SKILL.md'), type: PromptsType.skill };
		const refs = await resolveCustomizationRefs([userFile], [builtin], [], bundler);
		assert.deepStrictEqual(refs, [ref]);
		assert.strictEqual(calls.length, 1);
		assert.deepStrictEqual(calls[0].files, [userFile, builtin]);
	});

	test('classifies entries inside an installed plugin as plugin refs', async () => {
		const { bundler, calls } = makeBundler();
		const pluginUri = URI.file('/plugins/my-plugin');
		const insidePlugin = { uri: URI.joinPath(pluginUri, 'skills/my-skill/SKILL.md'), type: PromptsType.skill };
		const refs = await resolveCustomizationRefs(
			[insidePlugin],
			[],
			[makePlugin(pluginUri, 'My Plugin')],
			bundler,
		);
		assert.deepStrictEqual(refs, [{ uri: pluginUri.toString() as ProtocolURI, displayName: 'My Plugin' }]);
		assert.strictEqual(calls.length, 0, 'no individual files to bundle');
	});

	test('mixes plugin refs and bundled built-in skills', async () => {
		const { bundler, calls, ref } = makeBundler();
		const pluginUri = URI.file('/plugins/my-plugin');
		const insidePlugin = { uri: URI.joinPath(pluginUri, 'skills/my-skill/SKILL.md'), type: PromptsType.skill };
		const builtin = { uri: URI.file('/builtin/commit/SKILL.md'), type: PromptsType.skill };
		const refs = await resolveCustomizationRefs(
			[insidePlugin],
			[builtin],
			[makePlugin(pluginUri, 'My Plugin')],
			bundler,
		);
		assert.deepStrictEqual(refs, [
			{ uri: pluginUri.toString() as ProtocolURI, displayName: 'My Plugin' },
			ref,
		]);
		assert.strictEqual(calls.length, 1);
		assert.deepStrictEqual(calls[0].files, [builtin]);
	});
});
