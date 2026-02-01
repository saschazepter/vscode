/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { INotification, addDisposableListener } from '../../../../base/browser/dom.js';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';


function sanitizeNotificationText(text: string): string {
	return text.replace(/`/g, '\''); // convert backticks to single quotes
}

export async function triggerNotification(message: string, options?: { detail?: string; sticky?: boolean }): Promise<INotification | undefined> {
	const permission = await Notification.requestPermission();
	if (permission !== 'granted') {
		return;
	}

	const disposables = new DisposableStore();

	const notification = new Notification(sanitizeNotificationText(message), {
		body: options?.detail ? sanitizeNotificationText(options.detail) : undefined,
		requireInteraction: options?.sticky,
	});

	const onClick = new Emitter<void>();
	disposables.add(addDisposableListener(notification, 'click', () => onClick.fire()));
	disposables.add(addDisposableListener(notification, 'close', () => disposables.dispose()));

	disposables.add(toDisposable(() => notification.close()));

	return {
		onClick: onClick.event,
		dispose: () => disposables.dispose()
	};
}
