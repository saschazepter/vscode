/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Color } from '../../../../base/common/color.js';
import { editorBackground, foreground } from '../../../../platform/theme/common/colorRegistry.js';
import { IColorTheme, IPartsSplash } from '../../../../platform/theme/common/themeService.js';
import * as themes from '../../../common/theme.js';

export function getPartsSplashColorInfo(theme: IColorTheme): IPartsSplash['colorInfo'] {
	const modernUIColorCustomizations = themes.getModernUIColorCustomizations(theme);
	const titleBarColorCustomizations = modernUIColorCustomizations.titleBar;

	return {
		foreground: theme.getColor(foreground)?.toString(),
		background: Color.Format.CSS.formatHex(theme.getColor(editorBackground) || themes.WORKBENCH_BACKGROUND(theme)),
		editorBackground: theme.getColor(editorBackground)?.toString(),
		titleBarBackground: theme.getColor(themes.TITLE_BAR_ACTIVE_BACKGROUND)?.toString(),
		titleBarInactiveBackground: theme.getColor(themes.TITLE_BAR_INACTIVE_BACKGROUND)?.toString(),
		titleBarForeground: theme.getColor(themes.TITLE_BAR_ACTIVE_FOREGROUND)?.toString(),
		titleBarInactiveForeground: theme.getColor(themes.TITLE_BAR_INACTIVE_FOREGROUND)?.toString(),
		titleBarBorder: theme.getColor(themes.TITLE_BAR_BORDER)?.toString(),
		titleBarColorCustomizations,
		titleBarColorsCustomized: Object.values(titleBarColorCustomizations).some(customized => customized),
		activityBarBackground: theme.getColor(themes.ACTIVITY_BAR_BACKGROUND)?.toString(),
		activityBarBorder: theme.getColor(themes.ACTIVITY_BAR_BORDER)?.toString(),
		sideBarBackground: theme.getColor(themes.SIDE_BAR_BACKGROUND)?.toString(),
		sideBarBorder: theme.getColor(themes.SIDE_BAR_BORDER)?.toString(),
		panelBackground: theme.getColor(themes.PANEL_BACKGROUND)?.toString(),
		editorGroupBorder: theme.getColor(themes.EDITOR_GROUP_BORDER)?.toString(),
		agentsPanelBackground: theme.getColor('agentsPanel.background')?.toString(),
		agentsPanelBorder: theme.getColor('agentsPanel.border')?.toString(),
		statusBarBackground: theme.getColor(themes.STATUS_BAR_BACKGROUND)?.toString(),
		statusBarBorder: theme.getColor(themes.STATUS_BAR_BORDER)?.toString(),
		statusBarNoFolderBackground: theme.getColor(themes.STATUS_BAR_NO_FOLDER_BACKGROUND)?.toString(),
		windowBorder: theme.getColor(themes.WINDOW_ACTIVE_BORDER)?.toString() ?? theme.getColor(themes.WINDOW_INACTIVE_BORDER)?.toString()
	};
}
