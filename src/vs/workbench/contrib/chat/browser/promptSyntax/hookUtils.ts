/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { findNodeAtLocation, parseTree } from '../../../../../base/common/json.js';
import { ITextEditorSelection } from '../../../../../platform/editor/common/editor.js';

/**
 * Converts an offset in content to a 1-based line and column.
 */
function offsetToPosition(content: string, offset: number): { line: number; column: number } {
	let line = 1;
	let column = 1;
	for (let i = 0; i < offset && i < content.length; i++) {
		if (content[i] === '\n') {
			line++;
			column = 1;
		} else {
			column++;
		}
	}
	return { line, column };
}

/**
 * Finds the selection range for a hook command field value in JSON content.
 * @param content The JSON file content
 * @param hookType The hook type (e.g., "sessionStart")
 * @param index The index of the hook within the hook type array
 * @param fieldName The field name to find ('command', 'bash', or 'powershell')
 * @returns The selection range for the field value, or undefined if not found
 */
export function findHookCommandSelection(content: string, hookType: string, index: number, fieldName: string): ITextEditorSelection | undefined {
	const tree = parseTree(content);
	if (!tree) {
		return undefined;
	}

	const node = findNodeAtLocation(tree, [hookType, index, fieldName]);
	if (!node || node.type !== 'string') {
		return undefined;
	}

	// Node offset/length includes quotes, so adjust to select only the value content
	const valueStart = node.offset + 1; // After opening quote
	const valueEnd = node.offset + node.length - 1; // Before closing quote

	const start = offsetToPosition(content, valueStart);
	const end = offsetToPosition(content, valueEnd);

	return {
		startLineNumber: start.line,
		startColumn: start.column,
		endLineNumber: end.line,
		endColumn: end.column
	};
}
