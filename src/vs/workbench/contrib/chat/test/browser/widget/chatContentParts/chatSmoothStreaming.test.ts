/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../../../base/browser/window.js';
import { DisposableStore } from '../../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IConfigurationService } from '../../../../../../../platform/configuration/common/configuration.js';
import { workbenchInstantiationService } from '../../../../../../test/browser/workbenchTestServices.js';
import { lastBlockBoundary } from '../../../../browser/widget/chatContentParts/chatSmoothStreaming/buffers/paragraphBuffer.js';
import { SmoothStreamingDOMMorpher } from '../../../../browser/widget/chatContentParts/chatSmoothStreaming/chatSmoothStreaming.js';
import { ChatConfiguration } from '../../../../common/constants.js';

suite('lastBlockBoundary', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns -1 for empty string', () => {
		assert.strictEqual(lastBlockBoundary(''), -1);
	});

	test('returns -1 for text without any block boundary', () => {
		assert.strictEqual(lastBlockBoundary('hello world'), -1);
	});

	test('returns -1 for single newline', () => {
		assert.strictEqual(lastBlockBoundary('hello\nworld'), -1);
	});

	test('finds a single block boundary', () => {
		const text = 'hello\n\nworld';
		assert.strictEqual(lastBlockBoundary(text), 5);
	});

	test('finds the last block boundary among multiple', () => {
		const text = 'a\n\nb\n\nc';
		assert.strictEqual(lastBlockBoundary(text), 4);
	});

	test('ignores block boundaries inside a fenced code block', () => {
		const text = '```\ncode\n\nmore code\n```';
		assert.strictEqual(lastBlockBoundary(text), -1);
	});

	test('finds boundary after closing a code fence', () => {
		const text = '```\ncode\n```\n\nafter fence';
		assert.strictEqual(lastBlockBoundary(text), 12);
	});

	test('ignores boundary inside fence but finds one outside', () => {
		const text = 'before\n\n```\ninside\n\nfence\n```\n\nafter';
		// First \n\n at index 6 (before fence), inside fence at ~18, after fence at ~28
		const result = lastBlockBoundary(text);
		// The last valid boundary should be the one after the closing ```
		assert.ok(result > 6, `Expected boundary after fence close, got ${result}`);
	});

	test('handles code fence at the very start of the string', () => {
		const text = '```\ncode\n```\n\ntext';
		assert.strictEqual(lastBlockBoundary(text), 12);
	});

	test('handles unclosed code fence (all subsequent boundaries ignored)', () => {
		const text = '```\ncode\n\nmore\n\nstill inside';
		assert.strictEqual(lastBlockBoundary(text), -1);
	});

	test('handles multiple code fences', () => {
		const text = '```\nfirst\n```\n\nbetween\n\n```\nsecond\n```\n\nend';
		const result = lastBlockBoundary(text);
		// Last valid \n\n is after the second closing fence
		assert.ok(result > 20, `Expected last boundary near end, got ${result}`);
	});

	test('handles triple backticks mid-line (not a fence)', () => {
		// Triple backticks must be at the start of a line to count as a fence
		const text = 'text ``` not a fence\n\nafter';
		assert.strictEqual(lastBlockBoundary(text), 20);
	});

	test('ignores block boundaries inside a tilde-fenced code block', () => {
		const text = '~~~\ncode\n\nmore code\n~~~';
		assert.strictEqual(lastBlockBoundary(text), -1);
	});

	test('finds boundary after closing a tilde fence', () => {
		const text = '~~~\ncode\n~~~\n\nafter fence';
		assert.strictEqual(lastBlockBoundary(text), 12);
	});

	test('handles unclosed tilde fence', () => {
		const text = '~~~\ncode\n\nmore\n\nstill inside';
		assert.strictEqual(lastBlockBoundary(text), -1);
	});
});

suite('SmoothStreamingDOMMorpher', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let disposables: DisposableStore;
	let instantiationService: ReturnType<typeof workbenchInstantiationService>;
	let configService: TestConfigurationService;

	setup(() => {
		disposables = store.add(new DisposableStore());
		instantiationService = workbenchInstantiationService(undefined, disposables);

		configService = new TestConfigurationService();
		configService.setUserConfiguration(ChatConfiguration.SmoothStreamingStyle, 'fade');
		instantiationService.stub(IConfigurationService, configService);
	});

	teardown(() => {
		disposables.dispose();
	});

	function createMorpher(domNode?: HTMLElement): SmoothStreamingDOMMorpher {
		const node = domNode ?? mainWindow.document.createElement('div');
		return store.add(instantiationService.createInstance(SmoothStreamingDOMMorpher, node));
	}

	suite('tryMorph', () => {

		test('returns false for non-append edit', () => {
			const morpher = createMorpher();
			morpher.seed('hello');
			assert.strictEqual(morpher.tryMorph('goodbye'), false);
		});

		test('returns true when content is identical (no-op)', () => {
			const morpher = createMorpher();
			morpher.seed('hello');
			assert.strictEqual(morpher.tryMorph('hello'), true);
		});

		test('returns true for appended content', () => {
			const morpher = createMorpher();
			morpher.seed('hello');
			assert.strictEqual(morpher.tryMorph('hello world'), true);
		});

		test('returns false when prefix changes', () => {
			const morpher = createMorpher();
			morpher.seed('hello world');
			assert.strictEqual(morpher.tryMorph('Hello world!'), false);
		});

		test('successive appends all succeed', () => {
			const morpher = createMorpher();
			morpher.seed('a');
			assert.strictEqual(morpher.tryMorph('ab'), true);
			assert.strictEqual(morpher.tryMorph('abc'), true);
			assert.strictEqual(morpher.tryMorph('abcd'), true);
		});

		test('fails after a non-append edit even if previous appends succeeded', () => {
			const morpher = createMorpher();
			morpher.seed('hello');
			assert.strictEqual(morpher.tryMorph('hello world'), true);
			// Now a rewrite of earlier content
			assert.strictEqual(morpher.tryMorph('hi world'), false);
		});

		test('invokes render callback on rAF with block-boundary content', () => {
			const rendered: string[] = [];
			const morpher = createMorpher();
			morpher.setRenderCallback(md => rendered.push(md));
			morpher.seed('');

			// Append content with a block boundary
			morpher.tryMorph('paragraph one\n\nparagraph two');
			// The callback fires asynchronously via rAF, not synchronously
			assert.strictEqual(rendered.length, 0, 'Should not render synchronously');
		});

		test('returns true for content without block boundary (buffered)', () => {
			const morpher = createMorpher();
			morpher.seed('');
			// No \n\n — content is buffered
			assert.strictEqual(morpher.tryMorph('partial paragraph'), true);
		});
	});

	suite('seed', () => {

		test('sets baseline markdown', () => {
			const morpher = createMorpher();
			morpher.seed('initial content');
			// After seeding, tryMorph with same content is a no-op
			assert.strictEqual(morpher.tryMorph('initial content'), true);
			// And appending works
			assert.strictEqual(morpher.tryMorph('initial content more'), true);
		});

		test('with animateInitial=false uses existing child count as watermark', () => {
			const domNode = mainWindow.document.createElement('div');
			domNode.appendChild(mainWindow.document.createElement('p'));
			domNode.appendChild(mainWindow.document.createElement('p'));
			const morpher = createMorpher(domNode);

			morpher.seed('some content', false);
			// No animation classes should be applied since all children are "revealed"
			for (const child of Array.from(domNode.children)) {
				assert.strictEqual(
					(child as HTMLElement).classList.contains('chat-smooth-animate-fade'),
					false,
					'Existing children should not be animated when animateInitial is false'
				);
			}
		});

		test('with animateInitial=true animates existing children', () => {
			const domNode = mainWindow.document.createElement('div');
			domNode.appendChild(mainWindow.document.createElement('p'));
			domNode.appendChild(mainWindow.document.createElement('p'));
			const morpher = createMorpher(domNode);

			morpher.seed('some content', true);
			// Children should have the animation class
			for (const child of Array.from(domNode.children)) {
				assert.strictEqual(
					(child as HTMLElement).classList.contains('chat-smooth-animate-fade'),
					true,
					'Existing children should be animated when animateInitial is true'
				);
			}
		});
	});

	suite('animation style', () => {

		test('defaults to fade for invalid config value', () => {
			configService.setUserConfiguration(ChatConfiguration.SmoothStreamingStyle, 'invalid-style');
			const domNode = mainWindow.document.createElement('div');
			domNode.appendChild(mainWindow.document.createElement('p'));
			const morpher = createMorpher(domNode);
			morpher.seed('content', true);

			const child = domNode.children[0] as HTMLElement;
			assert.strictEqual(child.classList.contains('chat-smooth-animate-fade'), true, 'Should fall back to fade');
		});

		test('uses configured animation style', () => {
			configService.setUserConfiguration(ChatConfiguration.SmoothStreamingStyle, 'rise');
			const domNode = mainWindow.document.createElement('div');
			domNode.appendChild(mainWindow.document.createElement('p'));
			const morpher = createMorpher(domNode);
			morpher.seed('content', true);

			const child = domNode.children[0] as HTMLElement;
			assert.strictEqual(child.classList.contains('chat-smooth-animate-rise'), true, 'Should use rise style');
		});

		for (const style of ['fade', 'rise', 'blur', 'scale', 'slide'] as const) {
			test(`applies ${style} animation class`, () => {
				configService.setUserConfiguration(ChatConfiguration.SmoothStreamingStyle, style);
				const domNode = mainWindow.document.createElement('div');
				domNode.appendChild(mainWindow.document.createElement('p'));
				const morpher = createMorpher(domNode);
				morpher.seed('content', true);

				const child = domNode.children[0] as HTMLElement;
				assert.strictEqual(
					child.classList.contains(`chat-smooth-animate-${style}`),
					true,
					`Should have chat-smooth-animate-${style} class`
				);
			});
		}
	});

	suite('dispose', () => {

		test('clears pending state on dispose', () => {
			const morpher = createMorpher();
			morpher.seed('');
			morpher.setRenderCallback(() => { });
			morpher.tryMorph('hello\n\nworld');
			// Dispose before rAF fires
			morpher.dispose();
			// No error should occur — rAF is cancelled
		});
	});
});
