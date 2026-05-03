/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AgentHostGenAiAttr, AgentHostGenAiOperationName, AgentHostSpanStatusCode, InMemoryAgentHostOTelService, NoopAgentHostOTelService, formatTraceParent, parseTraceParent, truncateForAgentHostOTel } from '../../common/otel/index.js';

suite('Agent Host OTel', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('parses and formats W3C traceparent', () => {
		const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
		const context = parseTraceParent(traceparent, 'vendor=value');

		assert.deepStrictEqual(context, {
			traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
			spanId: '00f067aa0ba902b7',
			traceFlags: 1,
			traceState: 'vendor=value',
		});
		assert.strictEqual(context && formatTraceParent(context), traceparent);
	});

	test('rejects invalid traceparents', () => {
		assert.deepStrictEqual([
			parseTraceParent(''),
			parseTraceParent('00-00000000000000000000000000000000-00f067aa0ba902b7-01'),
			parseTraceParent('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01'),
			parseTraceParent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-xx'),
			parseTraceParent('01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'),
		], [undefined, undefined, undefined, undefined, undefined]);
	});

	test('truncates free-form content when configured', () => {
		assert.deepStrictEqual([
			truncateForAgentHostOTel('abcdef', 0),
			truncateForAgentHostOTel('abcdef', -1),
			truncateForAgentHostOTel('abcdef', 3),
			truncateForAgentHostOTel('abcdef', 10),
		], ['abcdef', 'abcdef', 'abc', 'abcdef']);
	});

	test('noop service calls through without producing context', async () => {
		const result = await NoopAgentHostOTelService.INSTANCE.startActiveSpan('noop', {}, async span => {
			span.setAttribute(AgentHostGenAiAttr.OPERATION_NAME, AgentHostGenAiOperationName.INVOKE_AGENT);
			return {
				active: NoopAgentHostOTelService.INSTANCE.getActiveTraceContext(),
				span: span.getSpanContext(),
			};
		});

		assert.deepStrictEqual(result, { active: undefined, span: undefined });
	});

	test('in-memory service captures nested spans and remote parent context', async () => {
		const service = disposables.add(new InMemoryAgentHostOTelService({
			enabled: true,
			verboseTracing: true,
			captureContent: false,
			maxAttributeSizeChars: 0,
		}));
		const completed: { name: string; traceId: string; spanId: string; parentSpanId: string | undefined; status: AgentHostSpanStatusCode; eventNames: string[] }[] = [];
		disposables.add(service.onDidCompleteSpan(span => completed.push({
			name: span.name,
			traceId: span.traceId,
			spanId: span.spanId,
			parentSpanId: span.parentSpanId,
			status: span.status.code,
			eventNames: span.events.map(e => e.name),
		})));

		await service.runWithTraceContext({
			traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
			spanId: '00f067aa0ba902b7',
			traceFlags: 1,
		}, async () => {
			await service.startActiveSpan('invoke_agent copilotcli', {
				attributes: {
					[AgentHostGenAiAttr.OPERATION_NAME]: AgentHostGenAiOperationName.INVOKE_AGENT,
				},
			}, async span => {
				span.addEvent('session/turnStarted');
				await service.startActiveSpan('execute_tool bash', {
					attributes: {
						[AgentHostGenAiAttr.OPERATION_NAME]: AgentHostGenAiOperationName.EXECUTE_TOOL,
					},
				}, async () => { });
			});
		});

		assert.deepStrictEqual(completed.map(span => ({
			name: span.name,
			traceId: span.traceId,
			parentSpanId: span.parentSpanId,
			status: span.status,
			eventNames: span.eventNames,
		})), [
			{
				name: 'execute_tool bash',
				traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
				parentSpanId: completed[1].spanId,
				status: AgentHostSpanStatusCode.OK,
				eventNames: [],
			},
			{
				name: 'invoke_agent copilotcli',
				traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
				parentSpanId: '00f067aa0ba902b7',
				status: AgentHostSpanStatusCode.OK,
				eventNames: ['session/turnStarted'],
			},
		]);
	});

	test('in-memory service preserves remote context across async work', async () => {
		const service = disposables.add(new InMemoryAgentHostOTelService({
			enabled: true,
			verboseTracing: true,
			captureContent: false,
			maxAttributeSizeChars: 0,
		}));
		const traceContext = {
			traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
			spanId: '00f067aa0ba902b7',
			traceFlags: 1,
		};

		const observed = await service.runWithTraceContext(traceContext, async () => {
			await Promise.resolve();
			return service.getActiveTraceContext();
		});

		assert.deepStrictEqual({
			observed,
			after: service.getActiveTraceContext(),
		}, {
			observed: traceContext,
			after: undefined,
		});
	});
});
