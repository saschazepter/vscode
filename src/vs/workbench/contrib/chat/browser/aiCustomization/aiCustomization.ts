/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../../nls.js';
import { MenuId } from '../../../../../platform/actions/common/actions.js';

/**
 * View container ID for the AI Customization sidebar.
 */
export const AI_CUSTOMIZATION_VIEWLET_ID = 'workbench.view.aiCustomization';

/**
 * View IDs for individual views within the AI Customization container.
 */
export const AI_CUSTOMIZATION_AGENTS_VIEW_ID = 'aiCustomization.agents';
export const AI_CUSTOMIZATION_SKILLS_VIEW_ID = 'aiCustomization.skills';
export const AI_CUSTOMIZATION_INSTRUCTIONS_VIEW_ID = 'aiCustomization.instructions';
export const AI_CUSTOMIZATION_PROMPTS_VIEW_ID = 'aiCustomization.prompts';

/**
 * Storage IDs for view state persistence.
 */
export const AI_CUSTOMIZATION_STORAGE_ID = 'workbench.aiCustomization.views.state';

/**
 * Category for AI Customization commands.
 */
export const AI_CUSTOMIZATION_CATEGORY = localize2('aiCustomization', "AI Customization");

//#region Menu IDs

// View title menus (toolbar)
export const AgentsViewTitleMenuId = new MenuId('aiCustomization.agents.title');
export const SkillsViewTitleMenuId = new MenuId('aiCustomization.skills.title');
export const InstructionsViewTitleMenuId = new MenuId('aiCustomization.instructions.title');
export const PromptsViewTitleMenuId = new MenuId('aiCustomization.prompts.title');

// Context menus (right-click on items)
export const AgentsViewItemMenuId = new MenuId('aiCustomization.agents.item');
export const SkillsViewItemMenuId = new MenuId('aiCustomization.skills.item');
export const InstructionsViewItemMenuId = new MenuId('aiCustomization.instructions.item');
export const PromptsViewItemMenuId = new MenuId('aiCustomization.prompts.item');

//#endregion
