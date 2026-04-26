/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * VS Code logo "fish" used by the Agents window aquarium. Each fish is a small
 * SVG element styled with `color:` so the silhouette inherits via `currentColor`,
 * with a tail group running a CSS wiggle animation.
 */

/** VS Code logo silhouette path (extracted from sessions/contrib/chat/browser/media/vscode-icon.svg). */
const VSCODE_LOGO_PATH = 'M65.566 89.4264C66.889 89.9418 68.3976 89.9087 69.7329 89.2662L87.0271 80.9446C88.8444 80.0701 90 78.231 90 76.2132V19.7872C90 17.7695 88.8444 15.9303 87.0271 15.0559L69.7329 6.73395C67.9804 5.89069 65.9295 6.09724 64.3914 7.21543C64.1716 7.37517 63.9624 7.55352 63.7659 7.75007L30.6583 37.9548L16.2372 27.0081C14.8948 25.9891 13.0171 26.0726 11.7702 27.2067L7.14495 31.4141C5.61986 32.8014 5.61811 35.2007 7.14117 36.5902L19.6476 48.0001L7.14117 59.4099C5.61811 60.7995 5.61986 63.1988 7.14495 64.5861L11.7702 68.7934C13.0171 69.9276 14.8948 70.0111 16.2372 68.9921L30.6583 58.0453L63.7659 88.2501C64.2897 88.7741 64.9046 89.1688 65.566 89.4264ZM69.0128 28.9311L43.8917 48.0001L69.0128 67.069V28.9311Z';

/** The three VS Code release channel colors used as fish "species". */
export const enum FishSpecies {
	Stable = 'stable',
	Insiders = 'insiders',
	Exploration = 'exploration',
}

const SPECIES_COLOR: Record<FishSpecies, string> = {
	[FishSpecies.Stable]: '#007ACC',
	[FishSpecies.Insiders]: '#24bfa5',
	[FishSpecies.Exploration]: '#E04F00',
};

/** Pick a random species, weighted Stable > Insiders > Exploration. */
export function pickRandomSpecies(): FishSpecies {
	const r = Math.random();
	if (r < 0.5) {
		return FishSpecies.Stable;
	}
	if (r < 0.8) {
		return FishSpecies.Insiders;
	}
	return FishSpecies.Exploration;
}

/**
 * Tear down the shared SVG defs container. Call when no fish are active.
 */
export function disposeSharedFishDefs(): void {
	if (sharedDefsContainer) {
		sharedDefsContainer.remove();
		sharedDefsContainer = undefined;
	}
}

export interface IFishOptions {
	readonly species: FishSpecies;
	readonly size: number;
	readonly x: number;
	readonly y: number;
	readonly vx: number;
	readonly vy: number;
}

/**
 * A swimming fish. Owns its DOM element and exposes mutable position/velocity
 * for the aquarium's RAF loop to update.
 */
export class Fish {

	readonly element: HTMLDivElement;
	private readonly innerElement: HTMLDivElement;

	x: number;
	y: number;
	vx: number;
	vy: number;
	readonly size: number;

	/** Timestamp until which this fish is in "panic" mode (faster, scattering). */
	panicUntil = 0;

	/** Last facing direction; only flip the element when it changes. */
	private facingRight = true;

	constructor(opts: IFishOptions, targetDocument: Document) {
		this.x = opts.x;
		this.y = opts.y;
		this.vx = opts.vx;
		this.vy = opts.vy;
		this.size = opts.size;

		this.element = targetDocument.createElement('div');
		this.element.className = 'agents-aquarium-fish';
		this.element.style.width = `${opts.size}px`;
		this.element.style.height = `${opts.size}px`;
		this.element.style.color = SPECIES_COLOR[opts.species];
		// Stagger the wiggle so fish aren't synchronized.
		this.element.style.setProperty('--fish-wiggle-delay', `${(Math.random() * -1).toFixed(2)}s`);

		// Inner element receives the directional flip so the wiggle keyframes
		// (applied to the tail) are unaffected by direction changes.
		this.innerElement = targetDocument.createElement('div');
		this.innerElement.className = 'agents-aquarium-fish-inner';
		this.innerElement.appendChild(buildFishSvg(targetDocument));
		this.element.appendChild(this.innerElement);

		this.applyTransform();
	}

	/** Write the current position/facing to the DOM. */
	applyTransform(): void {
		// Translate is on the outer element; flip is on the inner element so the
		// tail's CSS animation keeps spinning around its local origin.
		this.element.style.transform = `translate(${this.x.toFixed(1)}px, ${this.y.toFixed(1)}px)`;
		const wantFacingRight = this.vx >= 0;
		if (wantFacingRight !== this.facingRight) {
			this.facingRight = wantFacingRight;
			this.innerElement.style.transform = wantFacingRight ? '' : 'scaleX(-1)';
		}
	}
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Number of vertical strips the body is sliced into. More strips = smoother
 * wave (smaller per-strip phase delta), fewer visible seams. Kept moderate
 * because each strip = one path + one CSS animation per fish; with 50 fish
 * this contributes meaningfully to layer/animation work.
 */
const NUM_BODY_STRIPS = 10;

/** The body's bounding range in the original logo's user units. */
const BODY_X_START = 5;
const BODY_X_END = 90;

/**
 * Lazily-built shared SVG element holding the strip clipPath defs. All fish
 * reference these via `clip-path: url(#...)` instead of redefining their own.
 * Saves ~NUM_BODY_STRIPS * (FISH_COUNT - 1) clipPath nodes.
 */
let sharedDefsContainer: SVGSVGElement | undefined;

function ensureSharedDefs(targetDocument: Document): void {
	if (sharedDefsContainer) {
		return;
	}
	const stripWidth = (BODY_X_END - BODY_X_START) / NUM_BODY_STRIPS;
	const container = targetDocument.createElementNS(SVG_NS, 'svg');
	container.setAttribute('xmlns', SVG_NS);
	container.setAttribute('width', '0');
	container.setAttribute('height', '0');
	container.setAttribute('aria-hidden', 'true');
	container.style.position = 'absolute';
	container.style.width = '0';
	container.style.height = '0';
	container.style.overflow = 'hidden';
	container.style.pointerEvents = 'none';
	const defs = targetDocument.createElementNS(SVG_NS, 'defs');
	for (let i = 0; i < NUM_BODY_STRIPS; i++) {
		const clip = targetDocument.createElementNS(SVG_NS, 'clipPath');
		clip.setAttribute('id', `agents-aquarium-fish-clip-${i}`);
		clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
		const rect = targetDocument.createElementNS(SVG_NS, 'rect');
		rect.setAttribute('x', String(BODY_X_START + i * stripWidth));
		rect.setAttribute('y', '-20');
		// Larger overlap (0.8 user-units) hides seams when adjacent strips
		// are at slightly different translateY values.
		rect.setAttribute('width', String(stripWidth + 0.8));
		rect.setAttribute('height', '136');
		clip.appendChild(rect);
		defs.appendChild(clip);
	}
	container.appendChild(defs);
	targetDocument.body.appendChild(container);
	sharedDefsContainer = container;
}

/**
 * Build the inline SVG element tree for a fish:
 *   - VS Code logo body, sliced into N vertical strips that each oscillate in
 *     Y with a phase-offset CSS animation (the "swimming" sine wave)
 *
 * Colors come from `currentColor` on the parent element. Built with
 * `document.createElementNS` (no innerHTML) to satisfy Trusted Types.
 *
 * The strip clipPath defs are shared across all fish via {@link ensureSharedDefs}.
 */
function buildFishSvg(targetDocument: Document): SVGSVGElement {
	ensureSharedDefs(targetDocument);

	const svg = targetDocument.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('xmlns', SVG_NS);
	// viewBox 0..96 matches the original VS Code icon.
	svg.setAttribute('viewBox', '0 0 96 96');
	svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
	// Tell the rasterizer to optimize for visual quality, not speed: smoother
	// edges on the (potentially upscaled) logo paths.
	svg.setAttribute('shape-rendering', 'geometricPrecision');

	// Body: NUM_BODY_STRIPS overlapping copies of the full logo, each clipped
	// to its vertical band via shared clipPath defs. Each strip animates
	// translateY with a phase offset driven by --strip-index.
	const bodyGroup = targetDocument.createElementNS(SVG_NS, 'g');
	bodyGroup.setAttribute('class', 'agents-aquarium-fish-body');
	for (let i = 0; i < NUM_BODY_STRIPS; i++) {
		const stripG = targetDocument.createElementNS(SVG_NS, 'g');
		stripG.setAttribute('class', 'agents-aquarium-fish-strip');
		stripG.style.setProperty('--strip-index', String(i));
		const stripPath = targetDocument.createElementNS(SVG_NS, 'path');
		stripPath.setAttribute('d', VSCODE_LOGO_PATH);
		stripPath.setAttribute('fill', 'currentColor');
		// Use even-odd fill so the inner chevron sub-path of the VS Code logo
		// becomes a visible cutout (the iconic open V shape).
		stripPath.setAttribute('fill-rule', 'evenodd');
		stripPath.setAttribute('clip-path', `url(#agents-aquarium-fish-clip-${i})`);
		stripG.appendChild(stripPath);
		bodyGroup.appendChild(stripG);
	}
	svg.appendChild(bodyGroup);

	return svg;
}
