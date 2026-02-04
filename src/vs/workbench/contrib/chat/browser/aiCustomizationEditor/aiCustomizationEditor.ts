/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../../nls.js';
import { MenuId } from '../../../../../platform/actions/common/actions.js';

/**
 * Editor ID for the AI Customization Editor.
 */
export const AI_CUSTOMIZATION_EDITOR_ID = 'workbench.editor.aiCustomizationEditor';

/**
 * View type for registering the AI Customization Editor.
 */
export const AI_CUSTOMIZATION_EDITOR_VIEW_TYPE = 'aiCustomization.editor';

/**
 * Storage key for TOC width persistence.
 */
export const AI_CUSTOMIZATION_EDITOR_TOC_WIDTH_KEY = 'aiCustomizationEditor.tocWidth';

/**
 * Category for AI Customization Editor commands.
 */
export const AI_CUSTOMIZATION_EDITOR_CATEGORY = localize2('aiCustomizationEditor', "AI Customization Editor");

//#region Layout Constants

/**
 * Minimum width for the TOC panel.
 */
export const TOC_MIN_WIDTH = 140;

/**
 * Default width for the TOC panel.
 */
export const TOC_DEFAULT_WIDTH = 220;

/**
 * Minimum width for the field editor panel.
 */
export const EDITOR_MIN_WIDTH = 400;

/**
 * Threshold below which the TOC is hidden (narrow mode).
 */
export const NARROW_THRESHOLD = 660;

//#endregion

//#region Menu IDs

/**
 * Menu ID for the AI Customization Editor title bar.
 */
export const AICustomizationEditorTitleMenuId = new MenuId('aiCustomizationEditor.title');

/**
 * Menu ID for field-level context menus.
 */
export const AICustomizationEditorFieldMenuId = new MenuId('aiCustomizationEditor.field');

//#endregion
