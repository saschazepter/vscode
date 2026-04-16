/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ISmoothStreamingBuffer } from './buffer.js';
import { LineBuffer } from './lineBuffer.js';
import { OffBuffer } from './offBuffer.js';
import { ParagraphBuffer } from './paragraphBuffer.js';

/**
 * Registry of all available buffering strategies.
 * To add a new buffer, add an entry here.
 */
export const BUFFER_MODES = {
	off: (_domNode: HTMLElement): ISmoothStreamingBuffer => new OffBuffer(),
	line: (domNode: HTMLElement): ISmoothStreamingBuffer => {
		const buf = new LineBuffer();
		buf.setDomNode(domNode);
		return buf;
	},
	paragraph: (_domNode: HTMLElement): ISmoothStreamingBuffer => new ParagraphBuffer(),
} as const satisfies Record<string, (domNode: HTMLElement) => ISmoothStreamingBuffer>;

export type BufferModeName = keyof typeof BUFFER_MODES;
