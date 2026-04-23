/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../base/common/lifecycle.js';
import { observableValue, derived, IObservable } from '../../base/common/observable.js';
import { isIOS } from '../../base/common/platform.js';
import { isAndroid } from '../../base/browser/browser.js';
import { Gesture } from '../../base/browser/touch.js';

/** Viewport classification based on container width. */
export type ViewportClass = 'phone' | 'tablet' | 'desktop';

/** Default visibility for each workbench part. */
export interface IPartVisibilityDefaults {
	readonly sidebar: boolean;
	readonly auxiliaryBar: boolean;
	readonly panel: boolean;
	readonly chatBar: boolean;
	readonly editor: boolean;
}

/** Default sizes (in pixels) for each workbench part. */
export interface IPartSizeDefaults {
	readonly sideBarSize: number;
	readonly auxiliaryBarSize: number;
	readonly panelSize: number;
	readonly chatBarWidth: number;
}

const PHONE_MAX_WIDTH = 640;
const TABLET_MAX_WIDTH = 1024;

/**
 * Classifies the viewport into one of three classes based on width.
 */
function classifyViewport(width: number): ViewportClass {
	if (width < PHONE_MAX_WIDTH) {
		return 'phone';
	}
	if (width < TABLET_MAX_WIDTH) {
		return 'tablet';
	}
	return 'desktop';
}

/**
 * Observable-based viewport classification and layout policy for
 * the Sessions workbench. Consumed by `SessionsWorkbench` to drive
 * part visibility, sizing, and behavior based on viewport dimensions
 * and platform.
 */
export class SessionsLayoutPolicy extends Disposable {

	// --- Platform flags (static, read once) ---

	/** Whether the current platform is iOS. */
	readonly isIOS: boolean;

	/** Whether the current platform is Android. */
	readonly isAndroid: boolean;

	/** Whether the current device supports touch input. */
	readonly isTouchDevice: boolean;

	// --- Observables ---

	private readonly _viewportClass = observableValue<ViewportClass>(this, 'desktop');

	/** Current viewport class derived from the most recent `update()` call. */
	readonly viewportClass: IObservable<ViewportClass> = this._viewportClass;

	/** `true` when the viewport class is `phone`. */
	readonly isPhoneLayout: IObservable<boolean> = derived(this, reader => {
		return this._viewportClass.read(reader) === 'phone';
	});

	constructor() {
		super();

		this.isIOS = isIOS;
		this.isAndroid = isAndroid;
		this.isTouchDevice = Gesture.isTouchDevice();
	}

	/**
	 * Update the viewport classification. Call this from the workbench
	 * `layout()` method whenever the container dimensions change.
	 *
	 * @param width  Container width in pixels.
	 * @param height Container height in pixels (reserved for future use).
	 */
	update(width: number, _height: number): void {
		const next = classifyViewport(width);
		if (this._viewportClass.get() !== next) {
			this._viewportClass.set(next, undefined);
		}
	}

	/**
	 * Returns the default part visibility for the given viewport class.
	 * If no class is supplied the current observed class is used.
	 */
	getPartVisibilityDefaults(viewportClass?: ViewportClass): IPartVisibilityDefaults {
		const vc = viewportClass ?? this._viewportClass.get();
		switch (vc) {
			case 'phone':
				return { sidebar: false, auxiliaryBar: false, panel: false, chatBar: true, editor: false };
			case 'tablet':
				return { sidebar: true, auxiliaryBar: false, panel: false, chatBar: true, editor: false };
			case 'desktop':
				return { sidebar: true, auxiliaryBar: false, panel: false, chatBar: true, editor: false };
		}
	}

	/**
	 * Returns the default part sizes for the given viewport dimensions.
	 * If no viewport class is supplied the current observed class is used.
	 *
	 * @param width  Container width in pixels.
	 * @param height Container height in pixels (reserved for future use).
	 * @param viewportClass Optional explicit viewport class override.
	 */
	getPartSizes(width: number, _height: number, viewportClass?: ViewportClass): IPartSizeDefaults {
		const vc = viewportClass ?? this._viewportClass.get();
		switch (vc) {
			case 'phone':
				return {
					sideBarSize: 0,
					auxiliaryBarSize: 0,
					panelSize: 0,
					chatBarWidth: width,
				};
			case 'tablet':
				return {
					sideBarSize: 250,
					auxiliaryBarSize: 300,
					panelSize: 250,
					chatBarWidth: width - 250,
				};
			case 'desktop':
				return {
					sideBarSize: 300,
					auxiliaryBarSize: 380,
					panelSize: 300,
					chatBarWidth: width - 300,
				};
		}
	}
}
