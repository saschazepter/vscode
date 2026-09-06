/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export function shouldSkipInlineCompletion(isAutomatic: boolean, isMeteredConnection: boolean): boolean {
	return isAutomatic && isMeteredConnection;
}
