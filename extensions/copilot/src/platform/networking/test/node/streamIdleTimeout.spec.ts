/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { afterEach, beforeEach, suite, test, vi } from 'vitest';
import { DestroyableStream, StreamIdleTimeoutError, SSE_FIRST_CHUNK_TIMEOUT_MS, SSE_IDLE_TIMEOUT_MS, withStreamIdleTimeout } from '../../common/fetcherService';

/**
 * Creates a DestroyableStream backed by a ReadableStream whose enqueue/close
 * are exposed so the test can push chunks on demand.
 */
interface ControllableStream<T> {
	stream: DestroyableStream<T>;
	push: (value: T) => void;
	close: () => void;
}

function createControllableStream<T>(): ControllableStream<T> {
	let ctrl!: ReadableStreamDefaultController<T>;
	const readable = new ReadableStream<T>({ start(c) { ctrl = c; } });
	return {
		stream: new DestroyableStream(readable),
		push: (value: T) => ctrl.enqueue(value),
		close: () => ctrl.close(),
	};
}

suite('withStreamIdleTimeout', () => {

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test('yields all chunks from a fast stream without delay', async () => {
		const { stream, push, close } = createControllableStream<string>();
		push('a');
		push('b');
		push('c');
		close();

		const result: string[] = [];
		for await (const chunk of withStreamIdleTimeout(stream)) {
			result.push(chunk);
		}

		assert.deepStrictEqual(result, ['a', 'b', 'c']);
	});

	test('throws StreamIdleTimeoutError when first chunk never arrives', async () => {
		const { stream } = createControllableStream<string>();

		const iter = withStreamIdleTimeout(stream);
		const nextPromise = iter.next();

		// Advance past the first-chunk timeout
		await vi.advanceTimersByTimeAsync(SSE_FIRST_CHUNK_TIMEOUT_MS + 1);

		await assert.rejects(
			() => nextPromise,
			(err: StreamIdleTimeoutError) => {
				assert.strictEqual(err.name, 'StreamIdleTimeoutError');
				assert.ok(err.message.includes('first chunk'));
				return true;
			}
		);
	});

	test('throws StreamIdleTimeoutError when a subsequent chunk stalls', async () => {
		const { stream, push } = createControllableStream<string>();

		const iter = withStreamIdleTimeout(stream);

		// First chunk arrives immediately
		push('first');
		const first = await iter.next();
		assert.deepStrictEqual(first, { value: 'first', done: false });

		// Now no more chunks — advance past the idle timeout
		const nextPromise = iter.next();
		await vi.advanceTimersByTimeAsync(SSE_IDLE_TIMEOUT_MS + 1);

		await assert.rejects(
			() => nextPromise,
			(err: StreamIdleTimeoutError) => {
				assert.strictEqual(err.name, 'StreamIdleTimeoutError');
				assert.ok(err.message.includes('inactivity'));
				return true;
			}
		);
	});

	test('does not time out when chunks arrive within the deadline', async () => {
		const { stream, push, close } = createControllableStream<string>();

		const collected: string[] = [];
		const done = (async () => {
			for await (const chunk of withStreamIdleTimeout(stream)) {
				collected.push(chunk);
			}
		})();

		// Deliver chunks just inside the timeout windows
		push('a');
		await vi.advanceTimersByTimeAsync(SSE_IDLE_TIMEOUT_MS - 100);
		push('b');
		await vi.advanceTimersByTimeAsync(SSE_IDLE_TIMEOUT_MS - 100);
		push('c');
		await vi.advanceTimersByTimeAsync(1);
		close();

		await done;
		assert.deepStrictEqual(collected, ['a', 'b', 'c']);
	});

	test('uses the longer first-chunk timeout before first chunk', async () => {
		const { stream, push, close } = createControllableStream<string>();

		const collected: string[] = [];
		const done = (async () => {
			for await (const chunk of withStreamIdleTimeout(stream)) {
				collected.push(chunk);
			}
		})();

		// Advance past the idle timeout but before the first-chunk timeout — should NOT throw
		await vi.advanceTimersByTimeAsync(SSE_IDLE_TIMEOUT_MS + 100);
		push('delayed-first');
		await vi.advanceTimersByTimeAsync(1);
		close();

		await done;
		assert.deepStrictEqual(collected, ['delayed-first']);
	});
});
