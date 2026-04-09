/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { CircuitBreaker, CircuitState } from '../circuitBreaker';

describe('CircuitBreaker', () => {
	it('starts in CLOSED state', () => {
		const cb = new CircuitBreaker();
		expect(cb.getState()).toBe(CircuitState.CLOSED);
		expect(cb.canRequest()).toBe(true);
	});

	it('stays CLOSED below failure threshold', () => {
		const cb = new CircuitBreaker({ failureThreshold: 5 });
		for (let i = 0; i < 4; i++) {
			cb.recordFailure();
		}
		expect(cb.getState()).toBe(CircuitState.CLOSED);
		expect(cb.canRequest()).toBe(true);
	});

	it('opens after reaching failure threshold', () => {
		const cb = new CircuitBreaker({ failureThreshold: 3 });
		cb.recordFailure();
		cb.recordFailure();
		cb.recordFailure();
		expect(cb.getState()).toBe(CircuitState.OPEN);
		expect(cb.canRequest()).toBe(false);
	});

	it('transitions from OPEN to HALF_OPEN after reset timeout', () => {
		const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10 });
		cb.recordFailure();
		expect(cb.getState()).toBe(CircuitState.OPEN);

		// Wait for reset timeout
		return new Promise<void>(resolve => {
			setTimeout(() => {
				expect(cb.getState()).toBe(CircuitState.HALF_OPEN);
				resolve();
			}, 20);
		});
	});

	it('allows one probe in HALF_OPEN state', () => {
		const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 0 });
		cb.recordFailure();

		// Should be HALF_OPEN immediately with resetTimeoutMs=0
		expect(cb.getState()).toBe(CircuitState.HALF_OPEN);
		expect(cb.canRequest()).toBe(true); // first probe
		expect(cb.canRequest()).toBe(false); // second probe blocked
	});

	it('closes on success after HALF_OPEN probe', () => {
		const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 0 });
		cb.recordFailure();

		expect(cb.canRequest()).toBe(true); // probe
		cb.recordSuccess();
		expect(cb.getState()).toBe(CircuitState.CLOSED);
		expect(cb.getFailureCount()).toBe(0);
	});

	it('re-opens on failure during HALF_OPEN probe', () => {
		const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10 });
		cb.recordFailure();
		expect(cb.getState()).toBe(CircuitState.OPEN);

		return new Promise<void>(resolve => {
			setTimeout(() => {
				// Should have transitioned to HALF_OPEN
				expect(cb.getState()).toBe(CircuitState.HALF_OPEN);
				cb.canRequest(); // take probe
				cb.recordFailure(); // probe fails → back to OPEN
				expect(cb.getState()).toBe(CircuitState.OPEN);
				resolve();
			}, 15);
		});
	});

	it('resets to CLOSED state', () => {
		const cb = new CircuitBreaker({ failureThreshold: 1 });
		cb.recordFailure();
		expect(cb.getState()).toBe(CircuitState.OPEN);

		cb.reset();
		expect(cb.getState()).toBe(CircuitState.CLOSED);
		expect(cb.getFailureCount()).toBe(0);
		expect(cb.canRequest()).toBe(true);
	});

	it('resets failure count on success', () => {
		const cb = new CircuitBreaker({ failureThreshold: 5 });
		cb.recordFailure();
		cb.recordFailure();
		expect(cb.getFailureCount()).toBe(2);

		cb.recordSuccess();
		expect(cb.getFailureCount()).toBe(0);
	});

	it('applies exponential backoff on repeated HALF_OPEN failures', () => {
		const cb = new CircuitBreaker({
			failureThreshold: 1,
			resetTimeoutMs: 10,
			maxResetTimeoutMs: 100,
			probeTimeoutMs: 5,
		});

		// First failure → OPEN
		cb.recordFailure();
		expect(cb.getState()).toBe(CircuitState.OPEN);

		// Wait for first reset (10ms)
		return new Promise<void>(resolve => {
			setTimeout(() => {
				expect(cb.getState()).toBe(CircuitState.HALF_OPEN);
				cb.canRequest(); // take the probe
				cb.recordFailure(); // probe fails → back to OPEN

				expect(cb.getState()).toBe(CircuitState.OPEN);
				// Now timeout should be 20ms (doubled)

				// Wait 15ms — should still be OPEN (timeout is now 20ms)
				setTimeout(() => {
					expect(cb.getState()).toBe(CircuitState.OPEN);

					// Wait another 10ms — now past 20ms, should be HALF_OPEN
					setTimeout(() => {
						expect(cb.getState()).toBe(CircuitState.HALF_OPEN);
						resolve();
					}, 10);
				}, 15);
			}, 15);
		});
	});

	it('probe timeout prevents permanent deadlock', () => {
		const cb = new CircuitBreaker({
			failureThreshold: 1,
			resetTimeoutMs: 0,
			probeTimeoutMs: 10,
		});
		cb.recordFailure();

		// Take probe
		expect(cb.canRequest()).toBe(true);
		// Probe is in-flight, second request blocked
		expect(cb.canRequest()).toBe(false);

		// Wait for probe timeout
		return new Promise<void>(resolve => {
			setTimeout(() => {
				// Probe timed out, should allow another
				expect(cb.canRequest()).toBe(true);
				resolve();
			}, 15);
		});
	});
});
