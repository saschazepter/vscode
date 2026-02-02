/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ITextEditorSelection } from '../../../../../platform/editor/common/editor.js';

/**
 * Finds the selection range for a hook command field value in JSON content.
 * @param content The JSON file content
 * @param hookType The hook type (e.g., "sessionStart")
 * @param index The index of the hook within the hook type array
 * @param fieldName The field name to find ('command', 'bash', or 'powershell')
 * @returns The selection range for the field value, or undefined if not found
 */
export function findHookCommandSelection(content: string, hookType: string, index: number, fieldName: string): ITextEditorSelection | undefined {
	const lines = content.split('\n');

	// Find the hook type key
	let hookTypeLineIndex = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].includes(`"${hookType}"`) && lines[i].includes(':')) {
			hookTypeLineIndex = i;
			break;
		}
	}

	if (hookTypeLineIndex === -1) {
		return undefined;
	}

	// Find the array start
	let arrayStartLine = hookTypeLineIndex;
	while (arrayStartLine < lines.length && !lines[arrayStartLine].includes('[')) {
		arrayStartLine++;
	}

	if (arrayStartLine >= lines.length) {
		return undefined;
	}

	// Count through objects to find the right index
	let currentIndex = -1;
	let bracketDepth = 0;
	let inTargetObject = false;
	let targetObjectStartLine = -1;

	for (let i = arrayStartLine; i < lines.length; i++) {
		const line = lines[i];

		for (const char of line) {
			if (char === '[') {
				bracketDepth++;
			} else if (char === ']') {
				bracketDepth--;
				if (bracketDepth === 0) {
					// End of the array
					return undefined;
				}
			} else if (char === '{' && bracketDepth === 1) {
				// Start of an object in the array
				currentIndex++;
				if (currentIndex === index) {
					inTargetObject = true;
					targetObjectStartLine = i;
				}
			} else if (char === '}' && inTargetObject && bracketDepth === 1) {
				// End of the target object, search for field within this object
				for (let j = targetObjectStartLine; j <= i; j++) {
					const fieldLine = lines[j];
					const fieldPattern = `"${fieldName}"`;
					const fieldIndex = fieldLine.indexOf(fieldPattern);
					if (fieldIndex !== -1) {
						// Find the value after the colon
						const colonIndex = fieldLine.indexOf(':', fieldIndex);
						if (colonIndex !== -1) {
							// Find the opening quote of the value
							const valueStartQuote = fieldLine.indexOf('"', colonIndex + 1);
							if (valueStartQuote !== -1) {
								// Find the closing quote
								let valueEndQuote = valueStartQuote + 1;
								while (valueEndQuote < fieldLine.length) {
									if (fieldLine[valueEndQuote] === '"' && fieldLine[valueEndQuote - 1] !== '\\') {
										break;
									}
									valueEndQuote++;
								}
								// Select the value content (inside the quotes)
								return {
									startLineNumber: j + 1, // 1-based
									startColumn: valueStartQuote + 2, // 1-based, after the opening quote
									endLineNumber: j + 1,
									endColumn: valueEndQuote + 1 // 1-based, before the closing quote
								};
							}
						}
					}
				}
				return undefined;
			}
		}
	}

	return undefined;
}
