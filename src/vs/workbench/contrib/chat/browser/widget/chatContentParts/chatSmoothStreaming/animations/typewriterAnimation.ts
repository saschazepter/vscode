/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ISmoothStreamingAnimation } from './animation.js';

/** Per-word stagger (ms) for the typewriter animation. */
const TYPEWRITER_WORD_STAGGER_MS = 60;

/**
 * Typewriter animation: walks text nodes of new children (skipping
 * `<code>`, `<pre>`, `<table>` content), wraps each word in a
 * `<span>` with a staggered opacity animation so words fade in
 * sequentially.
 *
 * The word spans are temporary — they are destroyed when
 * `doRenderMarkdown()` tears down the DOM on the next render.
 * On re-render, this method re-wraps with a negative elapsed offset
 * so already-visible words appear instantly.
 */
export class TypewriterAnimation implements ISmoothStreamingAnimation {

	animate(children: HTMLCollection, fromIndex: number, currentCount: number, elapsed: number): void {
		for (let i = fromIndex; i < currentCount; i++) {
			const child = children[i] as HTMLElement;
			if (!child.classList) {
				continue;
			}
			this._wrapWords(child, elapsed);
		}
	}

	private _wrapWords(element: HTMLElement, elapsed: number): void {
		const doc = element.ownerDocument;

		// Collect text nodes upfront to avoid mutation during iteration.
		const textNodes: Text[] = [];
		const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
			acceptNode(node: Node): number {
				// Skip text inside code, pre, and table elements.
				let parent = node.parentElement;
				while (parent && parent !== element) {
					const tag = parent.tagName;
					if (tag === 'CODE' || tag === 'PRE' || tag === 'TABLE') {
						return NodeFilter.FILTER_REJECT;
					}
					parent = parent.parentElement;
				}
				return NodeFilter.FILTER_ACCEPT;
			}
		});

		let n: Node | null;
		while ((n = walker.nextNode())) {
			textNodes.push(n as Text);
		}

		let wordIndex = 0;

		for (const textNode of textNodes) {
			const text = textNode.textContent || '';
			// Split into words and whitespace, preserving both.
			const parts = text.split(/(\s+)/);
			const frag = doc.createDocumentFragment();

			for (const part of parts) {
				if (!part) {
					continue;
				}
				if (/^\s+$/.test(part)) {
					frag.appendChild(doc.createTextNode(part));
				} else {
					const span = doc.createElement('span');
					span.textContent = part;
					span.classList.add('chat-smooth-typewriter-word');
					const wordDelay = -elapsed + (wordIndex * TYPEWRITER_WORD_STAGGER_MS);
					span.style.setProperty('--chat-smooth-delay', `${wordDelay}ms`);
					wordIndex++;
					frag.appendChild(span);
				}
			}

			textNode.parentNode!.replaceChild(frag, textNode);
		}
	}
}
