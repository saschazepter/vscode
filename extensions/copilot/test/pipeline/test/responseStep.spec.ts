/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { describe, expect, test } from 'vitest';
import { formatAsEditWindowOnly } from '../responseStep';

/**
 * Compute the character offset of the first character of `line` (0-based) in `doc`.
 */
function lineOffset(doc: string, line: number): number {
	let off = 0;
	for (let i = 0; i < line; i++) {
		const nl = doc.indexOf('\n', off);
		off = nl + 1;
	}
	return off;
}

describe('formatAsEditWindowOnly (xtab-275)', () => {

	const docLines = Array.from({ length: 20 }, (_, i) => `L${i}`);
	const docContent = docLines.join('\n');

	test('drops oracle edits outside the prompt edit window and all edits after them', () => {
		// Edit window covers lines [5, 10): L5..L9
		const windowStart = 5;
		const windowLineCount = 5;

		// First edit is inside the window: replace "L6" → "EDITED"
		const inWindowStart = lineOffset(docContent, 6);
		const inWindowEnd = inWindowStart + 'L6'.length;

		// Second edit is outside the window: replace "L15" → "OUTSIDE"
		const outOfWindowStart = lineOffset(docContent, 15);
		const outOfWindowEnd = outOfWindowStart + 'L15'.length;

		// Third edit is back inside the window — must still be dropped, since
		// its offset assumes the second (out-of-window) edit was applied first.
		const inWindowStart2 = lineOffset(docContent, 8);
		const inWindowEnd2 = inWindowStart2 + 'L8'.length;

		const edits: [number, number, string][] = [
			[inWindowStart, inWindowEnd, 'EDITED'],
			[outOfWindowStart, outOfWindowEnd, 'OUTSIDE'],
			[inWindowStart2, inWindowEnd2, 'ALSO_DROPPED'],
		];

		const result = formatAsEditWindowOnly(edits, docContent, windowStart, windowLineCount);

		// Expected: only the in-window slice with the first edit applied.
		// "OUTSIDE" / "ALSO_DROPPED" / line L15 must not appear.
		expect(result).toBe(['L5', 'EDITED', 'L7', 'L8', 'L9'].join('\n'));
	});

	test('keeps all edits when every edit lies inside the window', () => {
		const windowStart = 5;
		const windowLineCount = 5;

		const edit1Start = lineOffset(docContent, 6);
		const edit1End = edit1Start + 'L6'.length;

		const edit2Start = lineOffset(docContent, 8);
		const edit2End = edit2Start + 'L8'.length;

		const edits: [number, number, string][] = [
			[edit1Start, edit1End, 'EDITED6'],
			[edit2Start, edit2End, 'EDITED8'],
		];

		const result = formatAsEditWindowOnly(edits, docContent, windowStart, windowLineCount);

		expect(result).toBe(['L5', 'EDITED6', 'L7', 'EDITED8', 'L9'].join('\n'));
	});
});
