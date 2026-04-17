/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ISmoothStreamingBuffer } from './buffer.js';

/**
 * Buffers content until a new visual line appears in the rendered
 * output. Uses a hidden shadow div to measure rendered height.
 * When scrollHeight increases, a new visual line has wrapped and
 * the previous content (which had only complete lines) is committed.
 *
 * This buffer is event-driven: it only shadow-renders when new
 * tokens arrive (no rAF spin loop).
 */
export class LineBuffer implements ISmoothStreamingBuffer {
	readonly handlesFlush = true;

	private _shadowRenderCallback: ((markdown: string) => void) | undefined;
	private _shadowNode: HTMLElement | undefined;
	private _domNode: HTMLElement | undefined;
	private _committedHeight: number = 0;
	private _committedMarkdown: string = '';
	private _bufferedMarkdown: string = '';
	private _lastShadowedMarkdown: string = '';

	setDomNode(domNode: HTMLElement): void {
		this._domNode = domNode;
	}

	setShadowRenderCallback(cb: (markdown: string) => void): void {
		this._shadowRenderCallback = cb;
	}

	getShadowNode(): HTMLElement {
		if (!this._shadowNode && this._domNode) {
			const doc = this._domNode.ownerDocument;
			this._shadowNode = doc.createElement('div');
			this._shadowNode.className = this._domNode.className;
			this._shadowNode.style.position = 'absolute';
			this._shadowNode.style.visibility = 'hidden';
			this._shadowNode.style.pointerEvents = 'none';
			this._shadowNode.style.overflow = 'hidden';
			this._shadowNode.style.height = 'auto';
			this._domNode.parentElement?.appendChild(this._shadowNode);
		}
		if (this._shadowNode && this._domNode) {
			this._shadowNode.style.width = `${this._domNode.clientWidth}px`;
		}
		return this._shadowNode!;
	}

	getRenderable(fullMarkdown: string, _lastRendered: string): string {
		return fullMarkdown;
	}

	filterFlush(markdown: string): string | undefined {
		if (!this._shadowRenderCallback) {
			return markdown;
		}

		if (markdown === this._lastShadowedMarkdown) {
			return undefined;
		}

		this._lastShadowedMarkdown = markdown;
		this._shadowRenderCallback(markdown);
		const currentHeight = this.getShadowNode().scrollHeight;

		if (this._committedHeight === 0) {
			this._committedHeight = currentHeight;
			this._committedMarkdown = markdown;
			this._bufferedMarkdown = markdown;
			return markdown;
		}

		if (currentHeight <= this._committedHeight) {
			this._bufferedMarkdown = markdown;
			return undefined;
		}

		const toCommit = this._bufferedMarkdown.length > this._committedMarkdown.length
			? this._bufferedMarkdown
			: markdown;

		if (toCommit !== markdown) {
			this._shadowRenderCallback(toCommit);
			this._committedHeight = this.getShadowNode().scrollHeight;
			this._lastShadowedMarkdown = toCommit;
		} else {
			this._committedHeight = currentHeight;
		}

		this._committedMarkdown = toCommit;
		this._bufferedMarkdown = markdown;
		return toCommit;
	}

	dispose(): void {
		this._shadowRenderCallback = undefined;
		this._shadowNode?.remove();
		this._shadowNode = undefined;
	}
}
