/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Range } from '../../../../common/core/range.js';
import { ModelDecorationOptions } from '../../../../common/model/textModel.js';
import { ViewModelDecoration } from '../../../../common/viewModel/viewModelDecoration.js';
import { configureContentDecorationFallbackOverlay, EditorViewDecorationResolver } from '../../../../browser/viewParts/editorViewGpu/editorViewDecorations.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('EditorViewDecorationResolver', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let editorRoot: HTMLElement;
	let styleElement: HTMLStyleElement;

	setup(() => {
		editorRoot = document.createElement('div');
		editorRoot.className = 'monaco-editor test-theme';
		document.body.append(editorRoot);
		styleElement = document.createElement('style');
		document.head.append(styleElement);
	});

	teardown(() => {
		styleElement.remove();
		editorRoot.remove();
	});

	function resolver(css: string): EditorViewDecorationResolver {
		styleElement.textContent = css;
		return new EditorViewDecorationResolver(editorRoot);
	}

	test('keeps the elevated DOM fallback overlay transparent to pointer input', () => {
		const domNode = document.createElement('div');

		configureContentDecorationFallbackOverlay(domNode);

		assert.deepStrictEqual({
			zIndex: domNode.style.zIndex,
			pointerEvents: domNode.style.pointerEvents,
		}, {
			zIndex: '1',
			pointerEvents: 'none',
		});
	});

	function decoration(className: string, extra: Partial<{
		inlineClassName: string;
		isWholeLine: boolean;
		showIfCollapsed: boolean;
		zIndex: number;
	}> = {}): ViewModelDecoration {
		return new ViewModelDecoration(
			new Range(2, 3, 4, 5),
			ModelDecorationOptions.register({
				description: 'test',
				className,
				...extra,
			}),
		);
	}

	test('resolves the computed cascade without class-name semantics and caches it', () => {
		const cssResolver = resolver(`
			.monaco-editor .extension-background { background-color: rgb(1, 2, 3); }
			.monaco-editor.test-theme .extension-background.emphasized { background-color: rgba(10, 20, 30, 0.5); }
		`);
		const extensionDecoration = decoration('extension-background emphasized', { showIfCollapsed: true, zIndex: 30 });

		assert.deepStrictEqual(cssResolver.resolve(extensionDecoration, 7), {
			id: 7,
			styleId: 1,
			zIndex: 30,
			startLine: 1,
			startColumn: 2,
			endLine: 3,
			endColumn: 4,
			wholeLine: false,
			fillLineBreak: false,
			includeNewLines: false,
			showIfCollapsed: true,
			kind: { kind: 'background', color: 0x0a141e80 },
		});
		styleElement.textContent = '.monaco-editor .extension-background.emphasized { background-color: red; }';
		assert.deepStrictEqual(cssResolver.resolve(extensionDecoration, 8)?.kind, {
			kind: 'background',
			color: 0x0a141e80,
		});
		cssResolver.clear();
		assert.deepStrictEqual(cssResolver.resolve(extensionDecoration, 9)?.kind, {
			kind: 'background',
			color: 0xff0000ff,
		});
	});

	test('keeps only the classic DOM newline geometry exception for findMatch', () => {
		const cssResolver = resolver('.monaco-editor .findMatch { background-color: rgba(234, 92, 0, 0.333); }');
		const result = cssResolver.resolve(decoration('findMatch'), 1);
		assert.deepStrictEqual(result?.kind, { kind: 'background', color: 0xea5c0055 });
		assert.strictEqual(result?.includeNewLines, true);
	});

	test('recognizes the supported SVG wave by computed paint shape', () => {
		const svg = encodeURIComponent(
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 6 3" height="3" width="6">'
			+ '<g fill="#f14c4c"><polygon points="5.5,0 2.5,3 1.1,3 4.1,0"/>'
			+ '<polygon points="4,0 6,2 6,0.6 5.4,0"/><polygon points="0,2 1,3 2.4,3 0,0.6"/></g></svg>'
		);
		const cssResolver = resolver(`
			.monaco-editor .extension-wave {
				background: url("data:image/svg+xml,${svg}") repeat-x bottom left;
			}
		`);

		assert.deepStrictEqual(cssResolver.resolve(decoration('extension-wave'), 1)?.kind, {
			kind: 'underline',
			color: 0xf14c4cff,
			wavy: true,
		});
	});

	test('keeps unsupported computed paint and inline text changes on the DOM fallback', () => {
		const cssResolver = resolver(`
			.monaco-editor .bordered { background-color: #123456; border: 1px solid red; }
			.monaco-editor .pseudo::before { content: ""; display: block; background-color: red; }
			.monaco-editor .plain-background { background-color: #123456; }
		`);

		assert.strictEqual(cssResolver.resolve(decoration('bordered'), 1), undefined, 'bordered background');
		assert.strictEqual(cssResolver.resolve(decoration('pseudo'), 2), undefined, 'painted pseudo-element');
		assert.strictEqual(cssResolver.resolve(decoration('missing-rule'), 3), undefined, 'unknown CSS');
		assert.strictEqual(cssResolver.resolve(decoration('plain-background', { inlineClassName: 'changes-opacity' }), 4), undefined, 'inline text style');
	});
});
