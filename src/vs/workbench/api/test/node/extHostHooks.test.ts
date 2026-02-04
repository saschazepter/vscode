/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../platform/log/common/log.js';
import { NodeExtHostHooks } from '../../node/extHostHooksNode.js';
import { HookType, IChatRequestHooks, IHookCommand } from '../../../contrib/chat/common/promptSyntax/hookSchema.js';
import { ExtHostChatAgents2 } from '../../common/extHostChatAgents2.js';
import { IToolInvocationContext } from '../../../contrib/chat/common/tools/languageModelToolsService.js';
import { ChatHookResultKind } from '../../common/extHostTypes.js';

function createHookCommand(command: string, options?: Partial<Omit<IHookCommand, 'type' | 'command'>>): IHookCommand {
	return {
		type: 'command',
		command,
		...options,
	};
}

function createMockToolInvocationContext(sessionResource: URI): IToolInvocationContext {
	return {
		sessionId: 'test-session-id',
		sessionResource,
	};
}

function createMockExtHostChatAgents(hooks: IChatRequestHooks | undefined): Pick<ExtHostChatAgents2, 'getHooksForSession'> {
	return {
		getHooksForSession(_sessionResource: URI): IChatRequestHooks | undefined {
			return hooks;
		}
	};
}

suite.skip('ExtHostHooks', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let hooksService: NodeExtHostHooks;
	let sessionResource: URI;

	setup(() => {
		hooksService = new NodeExtHostHooks(new NullLogService());
		sessionResource = URI.parse('vscode-chat-session://test-session');
	});

	test('executeHook throws when not initialized', async () => {
		const toolInvocationToken = createMockToolInvocationContext(sessionResource);

		await assert.rejects(
			() => hooksService.executeHook(
				HookType.SessionStart,
				{ toolInvocationToken },
				undefined
			),
			/ExtHostHooks not initialized/
		);
	});

	test('executeHook throws with invalid tool invocation token', async () => {
		hooksService.initialize(createMockExtHostChatAgents(undefined) as ExtHostChatAgents2);

		await assert.rejects(
			() => hooksService.executeHook(
				HookType.SessionStart,
				{ toolInvocationToken: undefined },
				undefined
			),
			/Invalid or missing tool invocation token/
		);

		await assert.rejects(
			() => hooksService.executeHook(
				HookType.SessionStart,
				{ toolInvocationToken: { invalid: 'token' } },
				undefined
			),
			/Invalid or missing tool invocation token/
		);
	});

	test('executeHook returns empty array when no hooks found for session', async () => {
		hooksService.initialize(createMockExtHostChatAgents(undefined) as ExtHostChatAgents2);

		const toolInvocationToken = createMockToolInvocationContext(sessionResource);
		const results = await hooksService.executeHook(
			HookType.SessionStart,
			{ toolInvocationToken },
			undefined
		);

		assert.deepStrictEqual(results, []);
	});

	test('executeHook returns empty array when no hooks of specified type exist', async () => {
		const hooks: IChatRequestHooks = {
			// Only preToolUse hooks, no sessionStart
			[HookType.PreToolUse]: [createHookCommand('echo "pre-tool"')]
		};
		hooksService.initialize(createMockExtHostChatAgents(hooks) as ExtHostChatAgents2);

		const toolInvocationToken = createMockToolInvocationContext(sessionResource);
		const results = await hooksService.executeHook(
			HookType.SessionStart,
			{ toolInvocationToken },
			undefined
		);

		assert.deepStrictEqual(results, []);
	});

	test('executeHook runs command and returns success result', async () => {
		const hooks: IChatRequestHooks = {
			[HookType.SessionStart]: [createHookCommand('echo "hello world"')]
		};
		hooksService.initialize(createMockExtHostChatAgents(hooks) as ExtHostChatAgents2);

		const toolInvocationToken = createMockToolInvocationContext(sessionResource);
		const results = await hooksService.executeHook(
			HookType.SessionStart,
			{ toolInvocationToken },
			undefined
		);

		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].kind, ChatHookResultKind.Success);
		assert.strictEqual((results[0].result as string).trim(), 'hello world');
	});

	test('executeHook parses JSON output', async () => {
		const hooks: IChatRequestHooks = {
			[HookType.SessionStart]: [createHookCommand('echo \'{"key": "value"}\'')]
		};
		hooksService.initialize(createMockExtHostChatAgents(hooks) as ExtHostChatAgents2);

		const toolInvocationToken = createMockToolInvocationContext(sessionResource);
		const results = await hooksService.executeHook(
			HookType.SessionStart,
			{ toolInvocationToken },
			undefined
		);

		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].kind, ChatHookResultKind.Success);
		assert.deepStrictEqual(results[0].result, { key: 'value' });
	});

	test('executeHook returns error result for non-zero exit code', async () => {
		const hooks: IChatRequestHooks = {
			[HookType.SessionStart]: [createHookCommand('exit 1')]
		};
		hooksService.initialize(createMockExtHostChatAgents(hooks) as ExtHostChatAgents2);

		const toolInvocationToken = createMockToolInvocationContext(sessionResource);
		const results = await hooksService.executeHook(
			HookType.SessionStart,
			{ toolInvocationToken },
			undefined
		);

		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].kind, ChatHookResultKind.Error);
	});

	test('executeHook captures stderr on failure', async () => {
		const hooks: IChatRequestHooks = {
			[HookType.SessionStart]: [createHookCommand('echo "error message" >&2 && exit 1')]
		};
		hooksService.initialize(createMockExtHostChatAgents(hooks) as ExtHostChatAgents2);

		const toolInvocationToken = createMockToolInvocationContext(sessionResource);
		const results = await hooksService.executeHook(
			HookType.SessionStart,
			{ toolInvocationToken },
			undefined
		);

		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].kind, ChatHookResultKind.Error);
		assert.strictEqual((results[0].result as string).trim(), 'error message');
	});

	test('executeHook handles multiple hooks', async () => {
		const hooks: IChatRequestHooks = {
			[HookType.SessionStart]: [
				createHookCommand('echo "first"'),
				createHookCommand('echo "second"'),
				createHookCommand('echo "third"')
			]
		};
		hooksService.initialize(createMockExtHostChatAgents(hooks) as ExtHostChatAgents2);

		const toolInvocationToken = createMockToolInvocationContext(sessionResource);
		const results = await hooksService.executeHook(
			HookType.SessionStart,
			{ toolInvocationToken },
			undefined
		);

		assert.strictEqual(results.length, 3);
		assert.strictEqual(results[0].kind, ChatHookResultKind.Success);
		assert.strictEqual((results[0].result as string).trim(), 'first');
		assert.strictEqual(results[1].kind, ChatHookResultKind.Success);
		assert.strictEqual((results[1].result as string).trim(), 'second');
		assert.strictEqual(results[2].kind, ChatHookResultKind.Success);
		assert.strictEqual((results[2].result as string).trim(), 'third');
	});

	test('executeHook passes input to stdin as JSON', async () => {
		const hooks: IChatRequestHooks = {
			[HookType.PreToolUse]: [createHookCommand('cat')]
		};
		hooksService.initialize(createMockExtHostChatAgents(hooks) as ExtHostChatAgents2);

		const toolInvocationToken = createMockToolInvocationContext(sessionResource);
		const input = { tool: 'bash', args: { command: 'ls' } };
		const results = await hooksService.executeHook(
			HookType.PreToolUse,
			{ toolInvocationToken, input },
			undefined
		);

		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].kind, ChatHookResultKind.Success);
		assert.deepStrictEqual(results[0].result, input);
	});

	test('executeHook respects cancellation', async () => {
		const hooks: IChatRequestHooks = {
			[HookType.SessionStart]: [createHookCommand('sleep 10')]
		};
		hooksService.initialize(createMockExtHostChatAgents(hooks) as ExtHostChatAgents2);

		const toolInvocationToken = createMockToolInvocationContext(sessionResource);
		const cts = disposables.add(new CancellationTokenSource());

		const resultPromise = hooksService.executeHook(
			HookType.SessionStart,
			{ toolInvocationToken },
			cts.token
		);

		// Cancel after a short delay
		setTimeout(() => cts.cancel(), 50);

		const results = await resultPromise;
		assert.strictEqual(results.length, 1);
		// Cancelled commands return error result
		assert.strictEqual(results[0].kind, ChatHookResultKind.Error);
	});

	test('executeHook returns error for invalid command', async () => {
		const hooks: IChatRequestHooks = {
			[HookType.SessionStart]: [createHookCommand('/nonexistent/command/that/does/not/exist')]
		};
		hooksService.initialize(createMockExtHostChatAgents(hooks) as ExtHostChatAgents2);

		const toolInvocationToken = createMockToolInvocationContext(sessionResource);
		const results = await hooksService.executeHook(
			HookType.SessionStart,
			{ toolInvocationToken },
			undefined
		);

		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].kind, ChatHookResultKind.Error);
	});

	test('executeHook uses custom environment variables', async () => {
		const hooks: IChatRequestHooks = {
			[HookType.SessionStart]: [createHookCommand('echo $MY_VAR', { env: { MY_VAR: 'custom_value' } })]
		};
		hooksService.initialize(createMockExtHostChatAgents(hooks) as ExtHostChatAgents2);

		const toolInvocationToken = createMockToolInvocationContext(sessionResource);
		const results = await hooksService.executeHook(
			HookType.SessionStart,
			{ toolInvocationToken },
			undefined
		);

		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].kind, ChatHookResultKind.Success);
		assert.strictEqual((results[0].result as string).trim(), 'custom_value');
	});
});
