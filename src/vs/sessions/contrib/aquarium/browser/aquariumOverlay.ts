/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableGenericMouseDownListener, addDisposableGenericMouseMoveListener, addDisposableListener, EventType, getWindow, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { createInstantHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IsNewChatSessionContext, SessionsAquariumActiveContext } from '../../../common/contextkeys.js';
import { disposeSharedFishDefs, Fish, pickRandomSpecies } from './fish.js';

const FISH_COUNT = 50;
const FISH_MIN_SIZE = 22;
const FISH_MAX_SIZE = 48;

/** Pixels around the cursor where fish flee. */
const SCATTER_RADIUS = 145;
/** Pixels around a food pellet where the fish considers it grabbable. */
const EAT_RADIUS = 14;
/** Maximum distance a fish will sense a food pellet from. Smaller = food
 *  must land near a fish to attract attention; larger = fish swim across
 *  the tank to it. */
const FOOD_DETECT_RADIUS = 160;
/** Maximum concurrent food pellets in the water. */
const MAX_FOOD = 12;
/** Soft margin around the aquarium bounds where fish start to turn back. */
const WALL_MARGIN = 36;

/** Base swimming speed (px/sec). */
const BASE_SPEED = 24;
/** Maximum normal swim speed (px/sec). */
const MAX_SPEED = 50;
/** Maximum panic swim speed (px/sec). */
const PANIC_MAX_SPEED = 240;
/** How long a fish stays in panic mode after being scattered. */
const PANIC_DURATION_MS = 600;

/** How long the exit animation runs before the aquarium is disposed. */
const EXIT_DURATION_MS = 900;

/**
 * Per-fish probability (per second) of starting a spontaneous "dart": a brief
 * burst of speed in a random direction with no external trigger. With FISH_COUNT
 * fish each rolling at this rate, the aquarium sees roughly
 * FISH_COUNT * DART_RATE_PER_SECOND darts/sec total.
 */
const DART_RATE_PER_SECOND = 0.04;
/** Random dart impulse strength (px/sec velocity boost). */
const DART_IMPULSE = 150;

/** Context keys we react to for visibility changes. */
const NEW_SESSION_KEY_SET = new Set<string>([IsNewChatSessionContext.key]);

/** Storage key for remembering whether the user wants the aquarium on. */
const AQUARIUM_ENABLED_STORAGE_KEY = 'workbench.sessions.aquarium.enabled';

interface IFoodPellet {
	readonly element: HTMLDivElement;
	x: number;
	y: number;
	/** Sink speed (px/sec). */
	vy: number;
}

/**
 * The aquarium overlay: a transparent absolutely-positioned layer mounted
 * inside the workbench main container. When activated, it fills the chat bar
 * region with VS Code logo "fish" that swim around, scatter from the cursor,
 * and chase food pellets dropped on click. Pointer events are not blocked,
 * so all underlying chat UI remains fully interactive.
 *
 * The overlay also owns a small floating toggle button anchored just above
 * the chat input box; the button persists across show/hide so users can
 * always switch the aquarium back on.
 */
export class AquariumOverlay extends Disposable {

	private readonly mainContainer: HTMLElement;

	/** The persistent toggle button. Always present once the overlay is created. */
	private readonly toggleButton: HTMLButtonElement;

	/** Per-activation state (DOM, RAF, listeners, fish, food). */
	private readonly activeRef = this._register(new MutableDisposable<IActiveAquarium>());

	private readonly activeContextKey: IContextKey<boolean>;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IHoverService private readonly hoverService: IHoverService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		this.mainContainer = layoutService.mainContainer;
		this.activeContextKey = SessionsAquariumActiveContext.bindTo(contextKeyService);

		this.toggleButton = this.createToggleButton();
		// Mount the button as a real child of the chat bar's part container so
		// CSS positioning (top-right) is relative to that element. No manual
		// bounding-rect math required.
		this.tryMountToggleButton(0);

		// Only show the button (and allow the aquarium) on the new-session view.
		// When the user opens an existing session, hide the button and tear down
		// any active aquarium. When they return, restore the previous state.
		this.applyNewSessionVisibility();
		this._register(this.contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(NEW_SESSION_KEY_SET)) {
				this.applyNewSessionVisibility();
			}
		}));
	}

	private isNewSession(): boolean {
		return this.contextKeyService.getContextKeyValue<boolean>(IsNewChatSessionContext.key) ?? true;
	}

	private isStoredEnabled(): boolean {
		return this.storageService.getBoolean(AQUARIUM_ENABLED_STORAGE_KEY, StorageScope.APPLICATION, false);
	}

	private setStoredEnabled(enabled: boolean): void {
		this.storageService.store(AQUARIUM_ENABLED_STORAGE_KEY, enabled, StorageScope.APPLICATION, StorageTarget.USER);
	}

	private applyNewSessionVisibility(): void {
		const isNew = this.isNewSession();
		this.toggleButton.style.display = isNew ? '' : 'none';
		if (!isNew) {
			// Leaving the new-session view: tear down without persisting (the
			// stored preference still reflects what the user wants on return).
			if (this.activeRef.value) {
				this.deactivate(/* persist */ false);
			}
		} else {
			// Returning to the new-session view: restore the saved state.
			if (this.isStoredEnabled() && !this.activeRef.value) {
				this.activate(/* persist */ false);
			}
		}
	}

	/**
	 * Attempt to mount the toggle button inside the chat bar's part container.
	 * Retries on the next animation frame while the chat bar is still being
	 * created during workbench restore.
	 */
	private tryMountToggleButton(attempt: number): void {
		const window = getWindow(this.mainContainer);
		const chatBarElement = this.layoutService.getContainer(window, Parts.CHATBAR_PART);
		if (chatBarElement && this.layoutService.isVisible(Parts.CHATBAR_PART, window) && chatBarElement.isConnected) {
			chatBarElement.appendChild(this.toggleButton);
			this._register(toDisposable(() => this.toggleButton.remove()));
			// Now that the chat bar is mountable, restore the saved state
			// (no-op if the user wasn't on the new-session view or had it off).
			if (this.isNewSession() && this.isStoredEnabled() && !this.activeRef.value) {
				this.activate(/* persist */ false);
			}
			return;
		}
		if (attempt >= 60) {
			return; // give up; nothing else to do
		}
		const sched = scheduleAtNextAnimationFrame(window, () => this.tryMountToggleButton(attempt + 1));
		this._register(sched);
	}

	private createToggleButton(): HTMLButtonElement {
		const doc = getWindow(this.mainContainer).document;
		const button = doc.createElement('button');
		button.className = 'agents-aquarium-toggle';
		button.type = 'button';
		this.updateToggleButtonVisual(button, false);

		this._register(addDisposableListener(button, EventType.CLICK, e => {
			// Don't let the click bubble into the chat bar's own handlers.
			e.preventDefault();
			e.stopPropagation();
			this.toggle();
		}));
		// Tooltip via the workbench hover service.
		const hoverDelegate = this._register(createInstantHoverDelegate());
		this._register(this.hoverService.setupManagedHover(
			hoverDelegate,
			button,
			() => this.activeRef.value ? localize('aquarium.hide', "Hide Aquarium") : localize('aquarium.show', "Show Aquarium"),
		));

		return button;
	}

	private updateToggleButtonVisual(button: HTMLButtonElement, active: boolean): void {
		button.classList.toggle('active', active);
		// Build the icon as a real DOM child instead of innerHTML to satisfy
		// the workbench Trusted Types policy.
		button.replaceChildren();
		const iconSpan = button.ownerDocument.createElement('span');
		const iconClasses = ThemeIcon.asClassName(active ? Codicon.close : Codicon.smiley).split(/\s+/).filter(Boolean);
		for (const cls of iconClasses) {
			iconSpan.classList.add(cls);
		}
		button.appendChild(iconSpan);
		button.setAttribute('aria-pressed', String(active));
		button.setAttribute('aria-label', active ? localize('aquarium.hide', "Hide Aquarium") : localize('aquarium.show', "Show Aquarium"));
	}

	/** User clicked the toggle button — flip state AND persist the choice. */
	private toggle(): void {
		if (this.activeRef.value) {
			this.deactivate(/* persist */ true);
		} else {
			this.activate(/* persist */ true);
		}
	}

	/**
	 * @param persist When true, store the new on-state so it's restored on
	 *                next visit. False is used by `applyNewSessionVisibility`
	 *                when restoring previously-stored state — we don't want
	 *                to write storage in that case.
	 */
	private activate(persist: boolean): void {
		if (this.activeRef.value) {
			return;
		}
		// Cancel any in-flight exit from a previous deactivation so its
		// delayed dispose can't tear down the new aquarium's shared SVG defs.
		this.pendingExit?.dispose();
		this.pendingExit = undefined;
		let active: IActiveAquarium;
		try {
			active = createActiveAquarium(this.mainContainer, this.layoutService);
		} catch (e) {
			// Defensively log and bail; never leave the overlay in a half-built
			// state that confuses the toggle button.
			console.error('[aquarium] failed to activate', e);
			return;
		}
		this.activeRef.value = active;
		this.activeContextKey.set(true);
		this.updateToggleButtonVisual(this.toggleButton, true);
		if (persist) {
			this.setStoredEnabled(true);
		}
	}

	/**
	 * @param persist When true, store the new off-state. False is used when
	 *                tearing down because we left the new-session view —
	 *                the stored preference should still reflect what the
	 *                user wants the next time they come back.
	 */
	private deactivate(persist: boolean): void {
		// Detach the active aquarium WITHOUT disposing it (clearAndLeak does
		// not call dispose) — otherwise the fish DOM would be torn down
		// synchronously and the exit animation would never run.
		const active = this.activeRef.clearAndLeak();
		if (!active) {
			return;
		}
		// Re-register the orphaned aquarium with the overlay so the lifecycle
		// tracker still sees a parent for it (clearAndLeak detaches the
		// disposable from its previous parent). The exit timer disposes it
		// when the animation completes; the _register here is purely a
		// backstop in case the overlay itself is disposed mid-exit.
		this._register(active);
		this.activeContextKey.set(false);
		this.updateToggleButtonVisual(this.toggleButton, false);
		// Run the exit animation, then dispose. Stash on the overlay so a
		// rapid re-activate during the exit can cancel the pending dispose.
		this.pendingExit?.dispose();
		const pending = active.exit();
		this.pendingExit = pending;
		this._register(pending);
		if (persist) {
			this.setStoredEnabled(false);
		}
	}

	private pendingExit: IDisposable | undefined;
}

interface IActiveAquarium extends IDisposable {
	/**
	 * Trigger the exit animation and dispose the aquarium when it completes.
	 * Returns a disposable that, if disposed before the animation finishes,
	 * will short-circuit and dispose the aquarium immediately.
	 */
	exit(): IDisposable;
}

/**
 * Build the live aquarium: water layer, fish, food, mouse handling, RAF loop.
 * All resources are owned by the returned disposable; `dispose()` removes
 * everything and stops the animation loop.
 */
function createActiveAquarium(mainContainer: HTMLElement, layoutService: IWorkbenchLayoutService): IActiveAquarium {
	const store = new DisposableStore();
	const targetWindow = getWindow(mainContainer);

	// Host the aquarium INSIDE the chat bar's part container so the chat
	// input UI (later DOM siblings) naturally paints on top. This avoids
	// any z-index gymnastics — water sits behind, fish included.
	const chatBar = layoutService.getContainer(targetWindow, Parts.CHATBAR_PART);
	if (!chatBar || !layoutService.isVisible(Parts.CHATBAR_PART, targetWindow)) {
		// No chat bar to host the aquarium — return an inert active aquarium.
		return {
			dispose: () => store.dispose(),
			exit: () => { store.dispose(); return store; },
		};
	}

	// --- DOM setup ---
	const doc = targetWindow.document;
	const water = doc.createElement('div');
	water.className = 'agents-aquarium-water';
	// Insert as the FIRST child so all subsequent chat bar content paints over it.
	chatBar.insertBefore(water, chatBar.firstChild);
	store.add(toDisposable(() => water.remove()));

	const fishLayer = doc.createElement('div');
	fishLayer.className = 'agents-aquarium-fish-layer';
	water.appendChild(fishLayer);

	const foodLayer = doc.createElement('div');
	foodLayer.className = 'agents-aquarium-food-layer';
	water.appendChild(foodLayer);

	// --- Bounds (the water element fills the chat bar via CSS inset:0) ---
	const bounds = { width: 0, height: 0 };
	// Cached water rect screen-space top/left so the per-mousemove handler
	// doesn't trigger a layout flush via getBoundingClientRect().
	const waterScreenOffset = { left: 0, top: 0 };
	const updateBounds = () => {
		bounds.width = water.clientWidth;
		bounds.height = water.clientHeight;
		const r = water.getBoundingClientRect();
		waterScreenOffset.left = r.left;
		waterScreenOffset.top = r.top;
	};

	// --- Spawn fish ---
	const fish: Fish[] = [];

	updateBounds();
	const resizeObserver = new ResizeObserver(() => {
		updateBounds();
		// Re-clamp fish if the bounds shrank below their position.
		for (const f of fish) {
			f.x = Math.min(f.x, Math.max(0, bounds.width - f.size));
			f.y = Math.min(f.y, Math.max(0, bounds.height - f.size));
		}
	});
	resizeObserver.observe(water);
	store.add(toDisposable(() => resizeObserver.disconnect()));

	for (let i = 0; i < FISH_COUNT; i++) {
		const size = randomBetween(FISH_MIN_SIZE, FISH_MAX_SIZE);
		const angle = Math.random() * Math.PI * 2;
		const speed = randomBetween(BASE_SPEED * 0.6, BASE_SPEED * 1.2);
		const f = new Fish({
			species: pickRandomSpecies(),
			size,
			x: randomBetween(0, Math.max(1, bounds.width - size)),
			y: randomBetween(0, Math.max(1, bounds.height - size)),
			vx: Math.cos(angle) * speed,
			vy: Math.sin(angle) * speed,
		}, targetWindow.document);
		fish.push(f);
	}
	// Spawn fish in two batches: the first half is appended synchronously
	// (via a DocumentFragment for a single layout pass), and the rest on
	// the next animation frame so the toggle click stays snappy. Each batch
	// gets the per-fish stagger applied in the fade-in pass below.
	const SYNC_BATCH = Math.ceil(FISH_COUNT / 2);
	const firstBatch = targetWindow.document.createDocumentFragment();
	for (let i = 0; i < Math.min(SYNC_BATCH, fish.length); i++) {
		firstBatch.appendChild(fish[i].element);
	}
	fishLayer.appendChild(firstBatch);
	if (SYNC_BATCH < fish.length) {
		const deferred = scheduleAtNextAnimationFrame(targetWindow, () => {
			const restBatch = targetWindow.document.createDocumentFragment();
			for (let i = SYNC_BATCH; i < fish.length; i++) {
				restBatch.appendChild(fish[i].element);
			}
			fishLayer.appendChild(restBatch);
			// Add `.visible` on the NEXT frame so the elements have one paint
			// at opacity:0 first — guarantees the CSS transition actually fires.
			const fadeIn = scheduleAtNextAnimationFrame(targetWindow, () => {
				for (let i = SYNC_BATCH; i < fish.length; i++) {
					const localIndex = i - SYNC_BATCH;
					const delay = Math.min(localIndex * 12, 400);
					fish[i].element.style.transitionDelay = `${delay}ms`;
					fish[i].element.classList.add('visible');
				}
			});
			store.add(fadeIn);
		});
		store.add(deferred);
	}
	store.add(toDisposable(() => {
		for (const f of fish) {
			f.element.remove();
		}
		// Tear down the shared SVG defs container along with the last
		// active aquarium so we don't leak it across reloads.
		disposeSharedFishDefs(targetWindow.document);
	}));

	// --- Food ---
	const food: IFoodPellet[] = [];
	const removeFood = (pellet: IFoodPellet) => {
		const idx = food.indexOf(pellet);
		if (idx !== -1) {
			food.splice(idx, 1);
			pellet.element.remove();
		}
	};

	// --- Mouse tracking & food drops on the main container ---
	// pointer-events:none on the water layer means the underlying chat UI
	// receives all events normally; we listen on the main container so we
	// always know cursor position even when over the chat input.
	//
	// `waterScreenOffset` is kept fresh by `updateBounds()` (called from the
	// ResizeObserver above). We also refresh on window scroll/resize since
	// those don't trigger our element-level ResizeObserver.
	store.add(addDisposableListener(targetWindow, EventType.RESIZE, updateBounds, { passive: true }));
	store.add(addDisposableListener(targetWindow, 'scroll', updateBounds, { passive: true, capture: true }));

	let mouseX = -1e6;
	let mouseY = -1e6;
	const resetMousePosition = () => {
		mouseX = -1e6;
		mouseY = -1e6;
	};
	// Use the generic mouse helpers so this works under iOS pointer events too.
	store.add(addDisposableGenericMouseMoveListener(mainContainer, (e: MouseEvent) => {
		mouseX = e.clientX - waterScreenOffset.left;
		mouseY = e.clientY - waterScreenOffset.top;
	}));
	// Listen to BOTH mouseleave and pointerleave so cursor reset works on
	// touch/pointer-only platforms (where mouseleave never fires).
	store.add(addDisposableListener(mainContainer, EventType.MOUSE_LEAVE, resetMousePosition, { passive: true }));
	store.add(addDisposableListener(mainContainer, EventType.POINTER_LEAVE, resetMousePosition, { passive: true }));

	store.add(addDisposableGenericMouseDownListener(mainContainer, (e: MouseEvent) => {
		// Only spawn food on plain left clicks against background-ish surfaces.
		if (e.button !== 0) {
			return;
		}
		const target = e.target as HTMLElement | null;
		if (!isBackgroundClick(target)) {
			return;
		}
		// Refresh once to be safe (mousedown is rare).
		updateBounds();
		const fx = e.clientX - waterScreenOffset.left;
		const fy = e.clientY - waterScreenOffset.top;
		if (fx < 0 || fy < 0 || fx > bounds.width || fy > bounds.height) {
			return;
		}
		spawnFood(fx, fy);
	}));

	function spawnFood(fx: number, fy: number): void {
		// Cap concurrent food: drop the oldest pellet to make room.
		while (food.length >= MAX_FOOD) {
			const oldest = food[0];
			removeFood(oldest);
		}
		const el = doc.createElement('div');
		el.className = 'agents-aquarium-food';
		el.style.transform = `translate(${fx}px, ${fy}px)`;
		foodLayer.appendChild(el);
		food.push({ element: el, x: fx, y: fy, vy: randomBetween(20, 35) });
	}

	// --- RAF loop ---
	const reduceMotion = targetWindow.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
	let lastFrame = performance.now();
	let rafDisposable: IDisposable | undefined;

	const tick = () => {
		const now = performance.now();
		const dtMs = Math.min(now - lastFrame, 100); // clamp big stalls
		const dt = dtMs / 1000;
		lastFrame = now;

		// Skip work when window is hidden (still keeps the RAF alive lazily).
		const visible = targetWindow.document.visibilityState !== 'hidden';
		if (visible && !reduceMotion) {
			updateFood(dt);
			updateFish(dt);
		}

		rafDisposable = scheduleAtNextAnimationFrame(targetWindow, tick);
	};

	function updateFood(dt: number): void {
		// Sink the pellets and remove any that fall off the bottom.
		for (let i = food.length - 1; i >= 0; i--) {
			const p = food[i];
			p.y += p.vy * dt;
			p.element.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
			if (p.y > bounds.height + 10) {
				removeFood(p);
			}
		}
	}

	function updateFish(dt: number): void {
		const now = performance.now();
		for (const f of fish) {
			const cx = f.x + f.size / 2;
			const cy = f.y + f.size / 2;

			// --- Wall steering: actively turn the heading away from any wall
			// the fish is approaching. Doing this on the heading (not just on
			// acceleration) prevents fish from parking against the edge with
			// their thrust pinning them in place.
			const targetAngleFromWall = computeWallAvoidAngle(cx, cy, bounds.width, bounds.height);
			if (targetAngleFromWall !== undefined) {
				// Turn at up to 4 rad/s toward the safe direction.
				const turn = shortestAngleDelta(f.wanderAngle, targetAngleFromWall);
				const maxTurn = 4 * dt;
				f.wanderAngle += Math.max(-maxTurn, Math.min(maxTurn, turn));
			} else {
				// Free water: drift the heading by a small random delta.
				f.wanderAngle += (Math.random() - 0.5) * 1.2 * dt + (Math.random() - 0.5) * 0.04;
			}

			// --- Steering: gentle thrust along the wander heading ---
			const thrust = 32;
			let ax = Math.cos(f.wanderAngle) * thrust;
			let ay = Math.sin(f.wanderAngle) * thrust;

			// --- Spontaneous dart ---
			// With probability DART_RATE_PER_SECOND * dt this frame, kick the
			// fish in a random direction and put it briefly into panic mode so
			// it can exceed normal max speed.
			if (Math.random() < DART_RATE_PER_SECOND * dt) {
				const dartAngle = Math.random() * Math.PI * 2;
				f.vx += Math.cos(dartAngle) * DART_IMPULSE;
				f.vy += Math.sin(dartAngle) * DART_IMPULSE;
				f.panicUntil = now + PANIC_DURATION_MS;
			}

			// --- Wall repel (soft, secondary) ---
			// Backstop the heading-based steering so a fish entering the
			// margin still gets pushed inward immediately.
			if (cx < WALL_MARGIN) {
				ax += (WALL_MARGIN - cx) * 6;
			} else if (cx > bounds.width - WALL_MARGIN) {
				ax -= (cx - (bounds.width - WALL_MARGIN)) * 6;
			}
			if (cy < WALL_MARGIN) {
				ay += (WALL_MARGIN - cy) * 6;
			} else if (cy > bounds.height - WALL_MARGIN) {
				ay -= (cy - (bounds.height - WALL_MARGIN)) * 6;
			}

			// --- Mouse scatter ---
			const dxM = cx - mouseX;
			const dyM = cy - mouseY;
			const distM2 = dxM * dxM + dyM * dyM;
			if (distM2 < SCATTER_RADIUS * SCATTER_RADIUS) {
				const distM = Math.max(Math.sqrt(distM2), 1);
				const force = (1 - distM / SCATTER_RADIUS) * 1100;
				ax += (dxM / distM) * force;
				ay += (dyM / distM) * force;
				f.panicUntil = now + PANIC_DURATION_MS;
			}

			// --- Seek nearest food (only within FOOD_DETECT_RADIUS) ---
			let nearest: IFoodPellet | undefined;
			let nearestDist2 = FOOD_DETECT_RADIUS * FOOD_DETECT_RADIUS;
			for (const p of food) {
				const dxF = (p.x) - cx;
				const dyF = (p.y) - cy;
				const d2 = dxF * dxF + dyF * dyF;
				if (d2 < nearestDist2) {
					nearestDist2 = d2;
					nearest = p;
				}
			}
			if (nearest) {
				const distF = Math.max(Math.sqrt(nearestDist2), 1);
				if (distF < EAT_RADIUS) {
					removeFood(nearest);
				} else {
					ax += ((nearest.x) - cx) / distF * 200;
					ay += ((nearest.y) - cy) / distF * 200;
				}
			}

			// --- Integrate ---
			f.vx += ax * dt;
			f.vy += ay * dt;

			// Cap speed based on panic state.
			const speed2 = f.vx * f.vx + f.vy * f.vy;
			const maxSpeed = now < f.panicUntil ? PANIC_MAX_SPEED : MAX_SPEED;
			if (speed2 > maxSpeed * maxSpeed) {
				const speed = Math.sqrt(speed2);
				f.vx = (f.vx / speed) * maxSpeed;
				f.vy = (f.vy / speed) * maxSpeed;
			}

			f.x += f.vx * dt;
			f.y += f.vy * dt;

			// Hard clamp as a safety net.
			f.x = clamp(f.x, -f.size * 0.25, bounds.width - f.size * 0.75);
			f.y = clamp(f.y, -f.size * 0.25, bounds.height - f.size * 0.75);

			f.applyTransform(dt);
		}
	}

	rafDisposable = scheduleAtNextAnimationFrame(targetWindow, tick);
	store.add(toDisposable(() => rafDisposable?.dispose()));

	// --- Fade-in: water + per-fish stagger (first batch only; the deferred
	// batch fades in inline when it's mounted next frame). ---
	scheduleAtNextAnimationFrame(targetWindow, () => {
		water.classList.add('visible');
		for (let i = 0; i < Math.min(SYNC_BATCH, fish.length); i++) {
			const f = fish[i];
			// Slight stagger so the school appears progressively rather than
			// all at once. Cap at ~400ms total so it doesn't drag on.
			const delay = Math.min(i * 12, 400);
			f.element.style.transitionDelay = `${delay}ms`;
			f.element.classList.add('visible');
		}
	});

	let exiting = false;

	const result: IActiveAquarium = {
		dispose: () => store.dispose(),
		exit: () => {
			if (exiting) {
				return store;
			}
			exiting = true;

			// Mirror of fade-in: per-fish stagger, then drop the `.visible`
			// class so the same CSS transition (`opacity 360ms ease-out`)
			// interpolates back to 0. Fish keep doing their normal swim
			// while fading — no choreographed "all swim one direction".
			for (let i = 0; i < fish.length; i++) {
				const f = fish[i];
				const delay = Math.min(i * 12, 400);
				f.element.style.transitionDelay = `${delay}ms`;
				f.element.classList.remove('visible');
			}
			water.classList.remove('visible');

			// After the animation completes, dispose everything.
			let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
				timer = undefined;
				store.dispose();
			}, EXIT_DURATION_MS);
			return toDisposable(() => {
				if (timer !== undefined) {
					clearTimeout(timer);
					timer = undefined;
					store.dispose();
				}
			});
		},
	};

	return result;
}

/** Determine whether a click target is "background-ish" (not on a control). */
function isBackgroundClick(target: HTMLElement | null): boolean {
	if (!target) {
		return false;
	}
	// Don't drop food when the user is clicking on an input, button, link,
	// or anything inside the chat input editor.
	if (target.closest('input, textarea, select, button, a, [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="menuitem"], [role="tab"], .monaco-editor, .scroll-decoration, .monaco-list-row')) {
		return false;
	}
	return true;
}

function randomBetween(min: number, max: number): number {
	return min + Math.random() * (max - min);
}

function clamp(value: number, min: number, max: number): number {
	if (max < min) {
		// Bounds smaller than the fish; keep it pinned to min.
		return min;
	}
	return Math.min(Math.max(value, min), max);
}

/**
 * If the fish is inside the wall margin, return the heading (radians) that
 * points back into the open water. Returns `undefined` when the fish is
 * comfortably away from all walls so the caller can apply free wandering.
 *
 * The chosen direction sums per-wall vectors weighted by how far inside the
 * margin the fish has crept, with a small randomized tangential bias so
 * neighbors don't all converge to the exact same heading.
 */
function computeWallAvoidAngle(cx: number, cy: number, width: number, height: number): number | undefined {
	let dx = 0;
	let dy = 0;
	if (cx < WALL_MARGIN) {
		dx += (WALL_MARGIN - cx) / WALL_MARGIN;
	} else if (cx > width - WALL_MARGIN) {
		dx -= (cx - (width - WALL_MARGIN)) / WALL_MARGIN;
	}
	if (cy < WALL_MARGIN) {
		dy += (WALL_MARGIN - cy) / WALL_MARGIN;
	} else if (cy > height - WALL_MARGIN) {
		dy -= (cy - (height - WALL_MARGIN)) / WALL_MARGIN;
	}
	if (dx === 0 && dy === 0) {
		return undefined;
	}
	// Add a small tangential perturbation so a row of fish hitting the same
	// wall don't all turn to the exact same angle.
	return Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.4;
}

/**
 * Smallest signed angular delta that takes `from` to `to`, in [-PI, PI].
 */
function shortestAngleDelta(from: number, to: number): number {
	let d = (to - from) % (Math.PI * 2);
	if (d > Math.PI) {
		d -= Math.PI * 2;
	} else if (d < -Math.PI) {
		d += Math.PI * 2;
	}
	return d;
}
