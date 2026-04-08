/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Command } from 'vscode';
import { DocumentId } from '../../../platform/inlineEdits/common/dataTypes/documentId';
import { StringReplacement } from '../../../util/vs/editor/common/core/edits/stringEdit';
import { Position } from '../../../util/vs/editor/common/core/position';
import { Range } from '../../../util/vs/editor/common/core/range';
import { StringText } from '../../../util/vs/editor/common/core/text/abstractText';
import { NextEditFetchRequest } from './nextEditProvider';

export interface INextEditDisplayLocation {
	range: Range;
	label: string;
}

export interface INextEditResult {
	requestId: number;
	result: {
		edit?: StringReplacement;
		displayLocation?: INextEditDisplayLocation;
		targetDocumentId?: DocumentId;
		isFromCursorJump?: boolean;
	} | undefined;
}

export class NextEditResult implements INextEditResult {
	constructor(
		public readonly requestId: number,
		public readonly source: NextEditFetchRequest,
		public readonly result: {
			edit?: StringReplacement;
			documentBeforeEdits: StringText | undefined;
			displayLocation?: INextEditDisplayLocation;
			targetDocumentId?: DocumentId;
			action?: Command;
			isFromCursorJump: boolean;
			jumpToPosition?: Position;
			isSubsequentEdit: boolean;
		} | undefined,
	) { }

	/**
	 * Release large document data that is no longer needed after the result
	 * has been consumed (speculative request triggered, telemetry scheduled).
	 */
	releaseDocumentData(): void {
		if (this.result) {
			(this.result as { documentBeforeEdits: StringText | undefined }).documentBeforeEdits = undefined;
		}
	}
}
