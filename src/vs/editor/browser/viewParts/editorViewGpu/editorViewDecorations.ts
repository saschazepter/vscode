/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DecorationInput, DecorationKindInput } from '@vscode/editor-view';
import { Color } from '../../../../base/common/color.js';
import type { ViewModelDecoration } from '../../../common/viewModel/viewModelDecoration.js';

interface IResolvedDecorationPaint {
	readonly styleId: number;
	readonly kind: DecorationKindInput;
}

export function configureContentDecorationFallbackOverlay(domNode: HTMLElement): void {
	// The opaque GPU canvas must remain below fallback paint without allowing the
	// elevated overlay's line divs to intercept editor pointer input.
	domNode.style.zIndex = '1';
	domNode.style.pointerEvents = 'none';
}

/**
 * Resolves the browser's final CSS cascade for content decorations into the
 * narrow typed paint vocabulary supported by `@vscode/editor-view`.
 */
export class EditorViewDecorationResolver {

	private readonly _cache = new Map<string, IResolvedDecorationPaint | null>();
	private readonly _container: HTMLElement;
	private readonly _baseline: HTMLElement;
	private readonly _probe: HTMLElement;
	private _nextStyleId = 1;

	constructor(private readonly _editorRoot: HTMLElement) {
		const document = _editorRoot.ownerDocument;
		this._container = document.createElement('div');
		this._container.className = 'view-overlays';
		this._container.style.position = 'absolute';
		this._container.style.visibility = 'hidden';
		this._container.style.pointerEvents = 'none';
		this._container.style.width = '100px';
		this._container.style.height = '20px';

		const line = document.createElement('div');
		line.style.width = '100px';
		line.style.height = '20px';
		this._baseline = document.createElement('div');
		this._baseline.className = 'cdr';
		this._probe = document.createElement('div');
		line.append(this._baseline, this._probe);
		this._container.append(line);
	}

	public clear(): void {
		this._cache.clear();
		this._nextStyleId = 1;
	}

	public ownsContentDecoration(decoration: ViewModelDecoration): boolean {
		return this.resolve(decoration, 0) !== undefined;
	}

	public resolve(decoration: ViewModelDecoration, id: number): DecorationInput | undefined {
		const className = decoration.options.className?.trim();
		if (!className || decoration.options.inlineClassName) {
			return undefined;
		}

		const paint = this._resolvePaint(className);
		if (!paint) {
			return undefined;
		}

		return {
			id,
			styleId: paint.styleId,
			zIndex: decoration.options.zIndex,
			startLine: decoration.range.startLineNumber - 1,
			startColumn: decoration.range.startColumn - 1,
			endLine: decoration.range.endLineNumber - 1,
			endColumn: decoration.range.endColumn - 1,
			wholeLine: decoration.options.isWholeLine,
			fillLineBreak: decoration.options.shouldFillLineOnLineBreak ?? false,
			// This is the classic DOM renderer's existing geometry exception:
			// `linesVisibleRangesForRange(range, className === 'findMatch')`.
			includeNewLines: className === 'findMatch',
			showIfCollapsed: decoration.options.showIfCollapsed,
			kind: paint.kind,
		};
	}

	private _resolvePaint(className: string): IResolvedDecorationPaint | undefined {
		const cached = this._cache.get(className);
		if (cached !== undefined) {
			return cached ?? undefined;
		}

		const paint = this._readComputedPaint(className);
		const resolved = paint ? { styleId: this._nextStyleId++, kind: paint } : undefined;
		this._cache.set(className, resolved ?? null);
		return resolved;
	}

	private _readComputedPaint(className: string): DecorationKindInput | undefined {
		const window = this._editorRoot.ownerDocument.defaultView;
		if (!window) {
			return undefined;
		}

		this._probe.className = `cdr ${className}`;
		this._editorRoot.append(this._container);
		try {
			const baseline = window.getComputedStyle(this._baseline);
			const style = window.getComputedStyle(this._probe);
			const before = window.getComputedStyle(this._probe, '::before');
			const after = window.getComputedStyle(this._probe, '::after');

			if (this._hasUnsupportedPaint(style, baseline)
				|| this._pseudoElementPaints(before)
				|| this._pseudoElementPaints(after)) {
				return undefined;
			}

			const background = this._visibleColor(style.backgroundColor);
			const hasImage = style.backgroundImage !== 'none';
			if (background && hasImage) {
				return undefined;
			}
			if (background) {
				return { kind: 'background', color: this._packColor(background) };
			}
			if (!hasImage) {
				return undefined;
			}

			const waveColor = this._readWaveColor(style);
			return waveColor
				? { kind: 'underline', color: this._packColor(waveColor), wavy: true }
				: undefined;
		} finally {
			this._container.remove();
			this._probe.className = '';
		}
	}

	private _hasUnsupportedPaint(style: CSSStyleDeclaration, baseline: CSSStyleDeclaration): boolean {
		if (this._hasVisibleBorder(style) || this._hasVisibleOutline(style)) {
			return true;
		}

		const properties = [
			'opacity',
			'box-shadow',
			'text-shadow',
			'filter',
			'backdrop-filter',
			'transform',
			'mix-blend-mode',
			'clip-path',
			'mask-image',
			'border-radius',
			'padding-top',
			'padding-right',
			'padding-bottom',
			'padding-left',
			'text-decoration-line',
		];
		return properties.some(property =>
			style.getPropertyValue(property) !== baseline.getPropertyValue(property)
		);
	}

	private _pseudoElementPaints(style: CSSStyleDeclaration): boolean {
		const content = style.content;
		const hasText = content !== 'none' && content !== 'normal' && content !== '""' && content !== '\'\'';
		return hasText
			|| this._visibleColor(style.backgroundColor) !== undefined
			|| style.backgroundImage !== 'none'
			|| style.boxShadow !== 'none'
			|| this._hasVisibleBorder(style)
			|| this._hasVisibleOutline(style);
	}

	private _hasVisibleBorder(style: CSSStyleDeclaration): boolean {
		return ['top', 'right', 'bottom', 'left'].some(side => {
			const borderStyle = style.getPropertyValue(`border-${side}-style`);
			const width = Number.parseFloat(style.getPropertyValue(`border-${side}-width`));
			const color = this._visibleColor(style.getPropertyValue(`border-${side}-color`));
			return borderStyle !== 'none' && borderStyle !== 'hidden' && width > 0 && color !== undefined;
		});
	}

	private _hasVisibleOutline(style: CSSStyleDeclaration): boolean {
		const width = Number.parseFloat(style.outlineWidth);
		return style.outlineStyle !== 'none'
			&& width > 0
			&& this._visibleColor(style.outlineColor) !== undefined;
	}

	private _readWaveColor(style: CSSStyleDeclaration): Color | undefined {
		if (style.backgroundRepeat !== 'repeat-x'
			|| style.backgroundPositionX !== '0%'
			|| style.backgroundPositionY !== '100%'
			|| style.backgroundSize !== 'auto') {
			return undefined;
		}

		const image = style.backgroundImage;
		const prefix = 'data:image/svg+xml,';
		const prefixIndex = image.indexOf(prefix);
		if (!image.startsWith('url(') || prefixIndex === -1) {
			return undefined;
		}

		let payload = image.slice(prefixIndex + prefix.length);
		payload = payload.replace(/["']?\)$/, '');
		let svgText: string;
		try {
			svgText = decodeURIComponent(payload);
		} catch {
			return undefined;
		}

		const svgTag = svgText.match(/<svg\b(?<attributes>[^>]*)>/)?.groups?.attributes;
		const groupTag = svgText.match(/<g\b(?<attributes>[^>]*)>/)?.groups?.attributes;
		if (!svgTag
			|| this._readAttribute(svgTag, 'viewBox') !== '0 0 6 3'
			|| this._readAttribute(svgTag, 'width') !== '6'
			|| this._readAttribute(svgTag, 'height') !== '3') {
			return undefined;
		}

		const points = Array.from(svgText.matchAll(/<polygon\b[^>]*\bpoints=(?<quote>["'])(?<points>.*?)\k<quote>[^>]*\/?>/g))
			.map(match => match.groups?.points)
			.sort();
		const expected = [
			'0,2 1,3 2.4,3 0,0.6',
			'4,0 6,2 6,0.6 5.4,0',
			'5.5,0 2.5,3 1.1,3 4.1,0',
		].sort();
		if (points.length !== expected.length || points.some((point, index) => point !== expected[index])) {
			return undefined;
		}

		const fill = groupTag ? this._readAttribute(groupTag, 'fill') : undefined;
		return fill ? this._visibleColor(fill) : undefined;
	}

	private _readAttribute(attributes: string, name: string): string | undefined {
		const expression = new RegExp(`\\b${name}=(?<quote>[\"'])(?<value>.*?)\\k<quote>`);
		return attributes.match(expression)?.groups?.value;
	}

	private _visibleColor(value: string): Color | undefined {
		const color = Color.Format.CSS.parse(value);
		return color && !color.isTransparent() ? color : undefined;
	}

	private _packColor(color: Color): number {
		const { r, g, b, a } = color.rgba;
		return (((r & 0xff) << 24) | ((g & 0xff) << 16) | ((b & 0xff) << 8) | (Math.round(a * 255) & 0xff)) >>> 0;
	}
}
