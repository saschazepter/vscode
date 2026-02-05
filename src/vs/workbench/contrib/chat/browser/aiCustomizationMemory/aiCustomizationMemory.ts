/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';

/**
 * ID for the Memory section in the AI Customization Management Editor.
 */
export const AI_CUSTOMIZATION_MEMORY_SECTION_ID = 'memory';

/**
 * Context key for whether we're in the memory section.
 */
export const CONTEXT_IN_MEMORY_SECTION = new RawContextKey<boolean>('chatMemorySection', false, localize('chatMemorySection', "Whether the memory section is active in the AI Customization Management Editor"));

/**
 * Icon for the memory feature.
 */
export const memoryIcon = registerIcon('ai-customization-memory', Codicon.lightbulbSparkle, localize('memoryIcon', "Icon for AI memory and suggestions."));

/**
 * Commands for memory feature.
 */
export const ChatMemoryCommandIds = {
	Reconcile: 'chat.memory.reconcile',
	OpenMemorySection: 'chat.memory.openSection',
	ApplySuggestion: 'chat.memory.applySuggestion',
	DismissSuggestion: 'chat.memory.dismissSuggestion',
	ClearSuggestions: 'chat.memory.clearSuggestions',
} as const;
