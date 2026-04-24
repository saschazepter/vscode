/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { GenAiAttr } from '../../../../platform/otel/common/genAiAttributes';
import { extractAgentName } from '../sessionStoreTracking';

describe('extractAgentName', () => {
	it('returns gen_ai.agent.name attribute when present', () => {
		const span = {
			name: 'invoke_agent copilot',
			attributes: { [GenAiAttr.AGENT_NAME]: 'copilot' },
		};
		expect(extractAgentName(span)).toBe('copilot');
	});

	it('returns gen_ai.agent.name even when it differs from span name', () => {
		const span = {
			name: 'invoke_agent somethingelse',
			attributes: { [GenAiAttr.AGENT_NAME]: 'github.copilot.editsAgent' },
		};
		expect(extractAgentName(span)).toBe('github.copilot.editsAgent');
	});

	it('falls back to parsing span name when gen_ai.agent.name is absent', () => {
		const span = {
			name: 'invoke_agent copilot',
			attributes: {},
		};
		expect(extractAgentName(span)).toBe('copilot');
	});

	it('falls back to parsing span name with extra whitespace', () => {
		const span = {
			name: 'invoke_agent  editsAgent',
			attributes: {},
		};
		expect(extractAgentName(span)).toBe('editsAgent');
	});

	it('returns "unknown" when no attribute and span name has no suffix', () => {
		const span = {
			name: 'invoke_agent',
			attributes: {},
		};
		expect(extractAgentName(span)).toBe('unknown');
	});

	it('returns "unknown" when no attribute and span name is whitespace-only after prefix', () => {
		const span = {
			name: 'invoke_agent   ',
			attributes: {},
		};
		expect(extractAgentName(span)).toBe('unknown');
	});

	it('returns gen_ai.agent.name for subagent spans', () => {
		const span = {
			name: 'invoke_agent execution',
			attributes: { [GenAiAttr.AGENT_NAME]: 'execution' },
		};
		expect(extractAgentName(span)).toBe('execution');
	});

	it('uses span name fallback for non-standard span names', () => {
		const span = {
			name: 'invoke_agent search',
			attributes: {},
		};
		expect(extractAgentName(span)).toBe('search');
	});
});
