/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ISmoothStreamingBuffer } from './buffer.js';

/**
 * Buffers content until a new visual line appears in the rendered
 * output. Uses a hidden shadow div to measure rendered height —
 * when `scrollHeight` increases, a new visual line has appeared and
 * the content is committed.
 *
 * Unlike text-based buffering, this correctly handles word wrap at
 * the container's actual width, so visual lines are always complete.
 *
 * The owner must call {@link setShadowRenderCallback} and provide
 * the DOM node via {@link setShadowNode} before this buffer is used.
 */
export class LineBuffer implements ISmoothStreamingBuffer {
	readonly handlesFlush = true;

	private _shadowRenderCallback: ((markdown: string) => void) | undefined;
	private _shadowNode: HTMLElement | undefined;
	private _domNode: HTMLElement | undefined;
	private _lastCommittedHeight: number = 0;
	private _lastCommittedMarkdown: string = '';
	private _prevShadowMarkdown: string = '';

	/**
	 * Initialize the line buffer with the DOM node it measures against.
	 */
	setDomNode(domNode: HTMLElement): void {
		this._domNode = domNode;
	}

	/**
	 * Register the callback that renders markdown into the shadow div.
	 */
	setShadowRenderCallback(cb: (markdown: string) => void): void {
		this._shadowRenderCallback = cb;
	}

	/**
	 * Returns (and lazily creates) the hidden shadow div used for
	 * measuring rendered height.
	 */
	getShadowNode(): HTMLElement {
		if (!this._shadowNode && this._domNode) {
			const doc = this._domNode.ownerDocument;
			this._shadowNode = doc.createElement('div');
			// Copy classes so CSS rules (font-size, line-height, margins)
			// match the real container.
			this._shadowNode.className = this._domNode.className;
			this._shadowNode.style.position = 'absolute';
			this._shadowNode.style.visibility = 'hidden';
			this._shadowNode.style.pointerEvents = 'none';
			this._shadowNode.style.overflow = 'hidden';
			// Height must be auto so scrollHeight reflects true content.
			this._shadowNode.style.height = 'auto';
			// Insert as sibling so it inherits the same container width.
			this._domNode.parentElement?.appendChild(this._shadowNode);
		}
		if (this._shadowNode && this._domNode) {
			// Sync width each time in case the container resized.
			this._shadowNode.style.width = `${this._domNode.clientWidth}px`;
		}
		return this._shadowNode!;
	}

	getRenderable(fullMarkdown: string, _lastRendered: string): string {
		// Line buffer passes everything through — actual buffering
		// happens in filterFlush() via shadow height measurement.
		return fullMarkdown;
	}

	filterFlush(markdown: string): string | undefined {
		if (!this._shadowRenderCallback) {
			return markdown; // No shadow render — commit everything.
		}

		this._shadowRenderCallback(markdown);
		const shadowHeight = this.getShadowNode().scrollHeight;

		if (shadowHeight <= this._lastCommittedHeight && this._lastCommittedHeight > 0) {
			// No new visual line — remember this content as the
			// "last good" state and keep buffering.
			this._prevShadowMarkdown = markdown;
			return undefined; // Skip commit.
		}

		// Height increased — a new visual line appeared. Commit
		// the previous content (complete lines only). If there's
		// no previous content (first render), commit current.
		const toCommit = this._prevShadowMarkdown.length > this._lastCommittedMarkdown.length
			? this._prevShadowMarkdown
			: markdown;
		this._lastCommittedHeight = shadowHeight;
		this._lastCommittedMarkdown = toCommit;
		this._prevShadowMarkdown = markdown;
		return toCommit;
	}

	dispose(): void {
		this._shadowRenderCallback = undefined;
		this._shadowNode?.remove();
		this._shadowNode = undefined;
	}
}
