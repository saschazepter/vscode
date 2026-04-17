/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ISmoothStreamingAnimation } from './animation.js';
import { BlockAnimation } from './blockAnimations.js';

/**
 * Registry of all available animation styles.
 * To add a new animation, add an entry here.
 */
export const ANIMATION_STYLES = {
	none: (): ISmoothStreamingAnimation => ({ animate() { } }),
	fade: (): ISmoothStreamingAnimation => new BlockAnimation('fade'),
	rise: (): ISmoothStreamingAnimation => new BlockAnimation('rise'),
	blur: (): ISmoothStreamingAnimation => new BlockAnimation('blur'),
	scale: (): ISmoothStreamingAnimation => new BlockAnimation('scale'),
	slide: (): ISmoothStreamingAnimation => new BlockAnimation('slide'),
	reveal: (): ISmoothStreamingAnimation => new BlockAnimation('reveal'),
} as const satisfies Record<string, () => ISmoothStreamingAnimation>;

export type AnimationStyleName = keyof typeof ANIMATION_STYLES;
