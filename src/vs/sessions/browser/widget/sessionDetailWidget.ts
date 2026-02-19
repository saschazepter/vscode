/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../../base/common/lifecycle.js';
import type { ISessionListItem } from '../../common/sessionListItem.js';

/**
 * Interface for detail view widgets that display a selected session or task.
 * Both {@link SdkChatWidget} and {@link CloudTaskWidget} implement this so
 * the view pane can treat them uniformly.
 */
export interface ISessionDetailWidget extends IDisposable {
	/** Root DOM element of the widget. */
	readonly element: HTMLElement;

	/**
	 * Load and display the given item. The widget uses `item.loadData`
	 * to determine what to fetch and render.
	 */
	load(item: ISessionListItem): Promise<void>;

	/** Clear the widget and return to the empty/welcome state. */
	clear(): void;

	/** Set keyboard focus to the widget's primary input. */
	focus(): void;
}
