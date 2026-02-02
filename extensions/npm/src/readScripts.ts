/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { JSONVisitor, visit } from 'jsonc-parser';
import { Location, Position, Range, TextDocument, Uri } from 'vscode';

export interface INpmScriptReference {
	name: string;
	value: string;
	nameRange: Range;
	valueRange: Range;
}

export interface INpmScriptInfo {
	location: Location;
	scripts: INpmScriptReference[];
}

/**
 * Computes a Position (line and character) from a byte offset in the given text.
 */
function positionAt(text: string, offset: number): Position {
	offset = Math.max(0, Math.min(offset, text.length));
	let line = 0;
	let lastLineStart = 0;

	for (let i = 0; i < offset; i++) {
		const ch = text.charCodeAt(i);
		if (ch === 13 /* \r */) {
			if (i + 1 < text.length && text.charCodeAt(i + 1) === 10 /* \n */) {
				i++; // Skip \n in \r\n
			}
			line++;
			lastLineStart = i + 1;
		} else if (ch === 10 /* \n */) {
			line++;
			lastLineStart = i + 1;
		}
	}

	return new Position(line, offset - lastLineStart);
}

export const readScripts = (document: TextDocument, buffer = document.getText()): INpmScriptInfo | undefined => {
	return readScriptsInternal(document.uri, buffer, (offset) => document.positionAt(offset));
};

/**
 * Reads scripts from a package.json file content without opening it as a TextDocument.
 * This avoids triggering textDocument/didOpen notifications to LSP servers.
 */
export const readScriptsFromText = (uri: Uri, buffer: string): INpmScriptInfo | undefined => {
	return readScriptsInternal(uri, buffer, (offset) => positionAt(buffer, offset));
};

const readScriptsInternal = (uri: Uri, buffer: string, offsetToPosition: (offset: number) => Position): INpmScriptInfo | undefined => {
	let start: Position | undefined;
	let end: Position | undefined;
	let inScripts = false;
	let buildingScript: { name: string; nameRange: Range } | void;
	let level = 0;

	const scripts: INpmScriptReference[] = [];
	const visitor: JSONVisitor = {
		onError() {
			// no-op
		},
		onObjectBegin() {
			level++;
		},
		onObjectEnd(offset) {
			if (inScripts) {
				end = offsetToPosition(offset);
				inScripts = false;
			}
			level--;
		},
		onLiteralValue(value: unknown, offset: number, length: number) {
			if (buildingScript && typeof value === 'string') {
				scripts.push({
					...buildingScript,
					value,
					valueRange: new Range(offsetToPosition(offset), offsetToPosition(offset + length)),
				});
				buildingScript = undefined;
			}
		},
		onObjectProperty(property: string, offset: number, length: number) {
			if (level === 1 && property === 'scripts') {
				inScripts = true;
				start = offsetToPosition(offset);
			} else if (inScripts) {
				buildingScript = {
					name: property,
					nameRange: new Range(offsetToPosition(offset), offsetToPosition(offset + length))
				};
			}
		},
	};

	visit(buffer, visitor);

	if (start === undefined) {
		return undefined;
	}

	return { location: new Location(uri, new Range(start, end ?? start)), scripts };
};
