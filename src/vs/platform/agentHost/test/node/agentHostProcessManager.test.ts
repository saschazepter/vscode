/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IChannel, IChannelClient } from '../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IAgentHostConnection, IAgentHostStarter } from '../../common/agent.js';
import { AgentHostProcessManager } from '../../node/agentHostService.js';
import { NullLoggerService, NullLogService } from '../../../log/common/log.js';

class TestAgentHostStarter extends Disposable implements IAgentHostStarter {
	private readonly _onRequestConnection = this._register(new Emitter<void>());
	readonly onRequestConnection = this._onRequestConnection.event;
	private readonly _onDidChangeActiveClientCount = this._register(new Emitter<number>());
	readonly onDidChangeActiveClientCount = this._onDidChangeActiveClientCount.event;
	private readonly _onDidProcessExit = this._register(new Emitter<{ code: number; signal: string }>());

	startCount = 0;
	disposeCount = 0;
	private readonly _startBarriers: DeferredPromise<void>[] = [];
	private startFailures = 0;

	readonly client: IChannelClient = {
		getChannel<T extends IChannel>(): T {
			throw new Error('Unexpected channel access in test');
		}
	};

	setActiveClientCount(count: number): void {
		this._onDidChangeActiveClientCount.fire(count);
	}

	requestConnection(): void {
		this._onRequestConnection.fire();
	}

	pauseNextStart(): DeferredPromise<void> {
		const barrier = new DeferredPromise<void>();
		this._startBarriers.push(barrier);
		return barrier;
	}

	failNextStart(): void {
		this.startFailures++;
	}

	async start(): Promise<IAgentHostConnection> {
		this.startCount++;
		await this._startBarriers.shift()?.p;
		if (this.startFailures > 0) {
			this.startFailures--;
			throw new Error('Test start failure');
		}
		const store = new DisposableStore();
		store.add(toDisposable(() => this.disposeCount++));
		return {
			client: this.client,
			store,
			onDidProcessExit: this._onDidProcessExit.event,
		};
	}
}

class TestAgentHostProcessManager extends AgentHostProcessManager {
	protected override _createLoggerClient(): IDisposable {
		return toDisposable(() => { });
	}
}

suite('AgentHostProcessManager', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('ignores connection requests while no enabled clients exist', async () => {
		const starter = disposables.add(new TestAgentHostStarter());
		disposables.add(new TestAgentHostProcessManager(starter, new NullLogService(), disposables.add(new NullLoggerService())));

		starter.requestConnection();
		await timeout(0);
		starter.setActiveClientCount(1);
		await timeout(0);

		assert.strictEqual(starter.startCount, 1);
	});

	test('does not retry a failed start without a new request', async () => {
		const starter = disposables.add(new TestAgentHostStarter());
		disposables.add(new TestAgentHostProcessManager(starter, new NullLogService(), disposables.add(new NullLoggerService())));
		starter.failNextStart();

		starter.setActiveClientCount(1);
		await timeout(0);
		await timeout(0);

		assert.strictEqual(starter.startCount, 1);
	});

	test('serializes a restart behind an in-flight start', async () => {
		const starter = disposables.add(new TestAgentHostStarter());
		disposables.add(new TestAgentHostProcessManager(starter, new NullLogService(), disposables.add(new NullLoggerService())));
		const firstStart = starter.pauseNextStart();

		starter.setActiveClientCount(1);
		await timeout(0);
		starter.setActiveClientCount(0);
		starter.setActiveClientCount(1);
		await timeout(0);
		const startCountWhilePaused = starter.startCount;

		await firstStart.complete();
		await timeout(0);
		await timeout(0);

		assert.deepStrictEqual({
			startCountWhilePaused,
			finalStartCount: starter.startCount,
			disposeCount: starter.disposeCount,
		}, {
			startCountWhilePaused: 1,
			finalStartCount: 2,
			disposeCount: 1,
		});
	});

	test('stops after the last enabled client disconnects and restarts when one returns', async () => {
		const starter = disposables.add(new TestAgentHostStarter());
		disposables.add(new TestAgentHostProcessManager(starter, new NullLogService(), disposables.add(new NullLoggerService())));

		starter.setActiveClientCount(2);
		await timeout(0);
		starter.setActiveClientCount(1);
		await timeout(0);
		starter.setActiveClientCount(0);
		await timeout(0);
		starter.setActiveClientCount(1);
		await timeout(0);

		assert.deepStrictEqual({
			startCount: starter.startCount,
			disposeCount: starter.disposeCount,
		}, {
			startCount: 2,
			disposeCount: 1,
		});
	});
});
