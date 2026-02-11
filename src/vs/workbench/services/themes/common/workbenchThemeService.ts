/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { refineServiceDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { Color } from '../../../../base/common/color.js';
import { IColorTheme, IThemeService, IFileIconTheme, IProductIconTheme } from '../../../../platform/theme/common/themeService.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { isBoolean, isString } from '../../../../base/common/types.js';
import { IconContribution, IconDefinition } from '../../../../platform/theme/common/iconRegistry.js';
import { ColorScheme, ThemeTypeSelector } from '../../../../platform/theme/common/theme.js';

export const IWorkbenchThemeService = refineServiceDecorator<IThemeService, IWorkbenchThemeService>(IThemeService);

export const THEME_SCOPE_OPEN_PAREN = '[';
export const THEME_SCOPE_CLOSE_PAREN = ']';
export const THEME_SCOPE_WILDCARD = '*';

export const themeScopeRegex = /\[(.+?)\]/g;

export enum ThemeSettings {
	COLOR_THEME = 'workbench.colorTheme',
	FILE_ICON_THEME = 'workbench.iconTheme',
	PRODUCT_ICON_THEME = 'workbench.productIconTheme',
	COLOR_CUSTOMIZATIONS = 'workbench.colorCustomizations',
	TOKEN_COLOR_CUSTOMIZATIONS = 'editor.tokenColorCustomizations',
	SEMANTIC_TOKEN_COLOR_CUSTOMIZATIONS = 'editor.semanticTokenColorCustomizations',

	PREFERRED_DARK_THEME = 'workbench.preferredDarkColorTheme',
	PREFERRED_LIGHT_THEME = 'workbench.preferredLightColorTheme',
	PREFERRED_HC_DARK_THEME = 'workbench.preferredHighContrastColorTheme', /* id kept for compatibility reasons */
	PREFERRED_HC_LIGHT_THEME = 'workbench.preferredHighContrastLightColorTheme',
	DETECT_COLOR_SCHEME = 'window.autoDetectColorScheme',
	DETECT_HC = 'window.autoDetectHighContrast',

	SYSTEM_COLOR_THEME = 'window.systemColorTheme'
}

export enum ThemeSettingDefaults {
	COLOR_THEME_DARK = 'Default Dark Modern',
	COLOR_THEME_LIGHT = 'Default Light Modern',
	COLOR_THEME_HC_DARK = 'Default High Contrast',
	COLOR_THEME_HC_LIGHT = 'Default High Contrast Light',

	COLOR_THEME_DARK_OLD = 'Default Dark+',
	COLOR_THEME_LIGHT_OLD = 'Default Light+',

	FILE_ICON_THEME = 'vs-seti',
	PRODUCT_ICON_THEME = 'Default',
}

export const COLOR_THEME_DARK_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#383a49',
	'activityBar.activeBorder': '#0078D4',
	'activityBar.background': '#181818',
	'activityBar.border': '#2B2B2B',
	'activityBar.foreground': '#D7D7D7',
	'activityBar.inactiveForeground': '#868686',
	'activityBarBadge.background': '#0078D4',
	'activityBarBadge.foreground': '#FFFFFF',
	'badge.background': '#616161',
	'badge.foreground': '#F8F8F8',
	'button.background': '#0078D4',
	'button.border': '#FFFFFF12',
	'button.foreground': '#FFFFFF',
	'button.hoverBackground': '#026EC1',
	'button.secondaryBackground': '#313131',
	'button.secondaryForeground': '#CCCCCC',
	'button.secondaryHoverBackground': '#3C3C3C',
	'chat.slashCommandBackground': '#26477866',
	'chat.slashCommandForeground': '#85B6FF',
	'chat.editedFileForeground': '#E2C08D',
	'checkbox.background': '#313131',
	'checkbox.border': '#3C3C3C',
	'debugToolBar.background': '#181818',
	'descriptionForeground': '#9D9D9D',
	'dropdown.background': '#313131',
	'dropdown.border': '#3C3C3C',
	'dropdown.foreground': '#CCCCCC',
	'dropdown.listBackground': '#1F1F1F',
	'editor.background': '#1F1F1F',
	'editor.findMatchBackground': '#9E6A03',
	'editor.foreground': '#CCCCCC',
	'editor.inactiveSelectionBackground': '#3A3D41',
	'editor.selectionHighlightBackground': '#ADD6FF26',
	'editorGroup.border': '#FFFFFF17',
	'editorGroupHeader.tabsBackground': '#181818',
	'editorGroupHeader.tabsBorder': '#2B2B2B',
	'editorGutter.addedBackground': '#2EA043',
	'editorGutter.deletedBackground': '#F85149',
	'editorGutter.modifiedBackground': '#0078D4',
	'editorIndentGuide.activeBackground1': '#707070',
	'editorIndentGuide.background1': '#404040',
	'editorLineNumber.activeForeground': '#CCCCCC',
	'editorLineNumber.foreground': '#6E7681',
	'editorOverviewRuler.border': '#010409',
	'editorWidget.background': '#202020',
	'errorForeground': '#F85149',
	'focusBorder': '#0078D4',
	'foreground': '#CCCCCC',
	'icon.foreground': '#CCCCCC',
	'input.background': '#313131',
	'input.border': '#3C3C3C',
	'input.foreground': '#CCCCCC',
	'input.placeholderForeground': '#989898',
	'inputOption.activeBackground': '#2489DB82',
	'inputOption.activeBorder': '#2488DB',
	'keybindingLabel.foreground': '#CCCCCC',
	'list.activeSelectionIconForeground': '#FFF',
	'list.dropBackground': '#383B3D',
	'menu.background': '#1F1F1F',
	'menu.border': '#454545',
	'menu.foreground': '#CCCCCC',
	'menu.selectionBackground': '#0078d4',
	'menu.separatorBackground': '#454545',
	'notificationCenterHeader.background': '#1F1F1F',
	'notificationCenterHeader.foreground': '#CCCCCC',
	'notifications.background': '#1F1F1F',
	'notifications.border': '#2B2B2B',
	'notifications.foreground': '#CCCCCC',
	'panel.background': '#181818',
	'panel.border': '#2B2B2B',
	'panelInput.border': '#2B2B2B',
	'panelTitle.activeBorder': '#0078D4',
	'panelTitle.activeForeground': '#CCCCCC',
	'panelTitle.inactiveForeground': '#9D9D9D',
	'peekViewEditor.background': '#1F1F1F',
	'peekViewEditor.matchHighlightBackground': '#BB800966',
	'peekViewResult.background': '#1F1F1F',
	'peekViewResult.matchHighlightBackground': '#BB800966',
	'pickerGroup.border': '#3C3C3C',
	'ports.iconRunningProcessForeground': '#369432',
	'progressBar.background': '#0078D4',
	'quickInput.background': '#222222',
	'quickInput.foreground': '#CCCCCC',
	'settings.dropdownBackground': '#313131',
	'settings.dropdownBorder': '#3C3C3C',
	'settings.headerForeground': '#FFFFFF',
	'settings.modifiedItemIndicator': '#BB800966',
	'sideBar.background': '#181818',
	'sideBar.border': '#2B2B2B',
	'sideBar.foreground': '#CCCCCC',
	'sideBarSectionHeader.background': '#181818',
	'sideBarSectionHeader.border': '#2B2B2B',
	'sideBarSectionHeader.foreground': '#CCCCCC',
	'sideBarTitle.foreground': '#CCCCCC',
	'statusBar.background': '#181818',
	'statusBar.border': '#2B2B2B',
	'statusBar.debuggingBackground': '#0078D4',
	'statusBar.debuggingForeground': '#FFFFFF',
	'statusBar.focusBorder': '#0078D4',
	'statusBar.foreground': '#CCCCCC',
	'statusBar.noFolderBackground': '#1F1F1F',
	'statusBarItem.focusBorder': '#0078D4',
	'statusBarItem.prominentBackground': '#6E768166',
	'statusBarItem.remoteBackground': '#0078D4',
	'statusBarItem.remoteForeground': '#FFFFFF',
	'tab.activeBackground': '#1F1F1F',
	'tab.activeBorder': '#1F1F1F',
	'tab.activeBorderTop': '#0078D4',
	'tab.activeForeground': '#FFFFFF',
	'tab.border': '#2B2B2B',
	'tab.hoverBackground': '#1F1F1F',
	'tab.inactiveBackground': '#181818',
	'tab.inactiveForeground': '#9D9D9D',
	'tab.lastPinnedBorder': '#ccc3',
	'tab.selectedBackground': '#222222',
	'tab.selectedBorderTop': '#6caddf',
	'tab.selectedForeground': '#ffffffa0',
	'tab.unfocusedActiveBorder': '#1F1F1F',
	'tab.unfocusedActiveBorderTop': '#2B2B2B',
	'tab.unfocusedHoverBackground': '#1F1F1F',
	'terminal.foreground': '#CCCCCC',
	'terminal.inactiveSelectionBackground': '#3A3D41',
	'terminal.tab.activeBorder': '#0078D4',
	'textBlockQuote.background': '#2B2B2B',
	'textBlockQuote.border': '#616161',
	'textCodeBlock.background': '#2B2B2B',
	'textLink.activeForeground': '#4daafc',
	'textLink.foreground': '#4daafc',
	'textPreformat.background': '#3C3C3C',
	'textPreformat.foreground': '#D0D0D0',
	'textSeparator.foreground': '#21262D',
	'titleBar.activeBackground': '#181818',
	'titleBar.activeForeground': '#CCCCCC',
	'titleBar.border': '#2B2B2B',
	'titleBar.inactiveBackground': '#1F1F1F',
	'titleBar.inactiveForeground': '#9D9D9D',
	'welcomePage.progress.foreground': '#0078D4',
	'welcomePage.tileBackground': '#2B2B2B',
	'widget.border': '#313131'
};

export const COLOR_THEME_LIGHT_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#dddddd',
	'activityBar.activeBorder': '#005FB8',
	'activityBar.background': '#F8F8F8',
	'activityBar.border': '#E5E5E5',
	'activityBar.foreground': '#1F1F1F',
	'activityBar.inactiveForeground': '#616161',
	'activityBarBadge.background': '#005FB8',
	'activityBarBadge.foreground': '#FFFFFF',
	'badge.background': '#CCCCCC',
	'badge.foreground': '#3B3B3B',
	'button.background': '#005FB8',
	'button.border': '#0000001a',
	'button.foreground': '#FFFFFF',
	'button.hoverBackground': '#0258A8',
	'button.secondaryBackground': '#E5E5E5',
	'button.secondaryForeground': '#3B3B3B',
	'button.secondaryHoverBackground': '#CCCCCC',
	'chat.slashCommandBackground': '#ADCEFF7A',
	'chat.slashCommandForeground': '#26569E',
	'chat.editedFileForeground': '#895503',
	'checkbox.background': '#F8F8F8',
	'checkbox.border': '#CECECE',
	'descriptionForeground': '#3B3B3B',
	'diffEditor.unchangedRegionBackground': '#f8f8f8',
	'dropdown.background': '#FFFFFF',
	'dropdown.border': '#CECECE',
	'dropdown.foreground': '#3B3B3B',
	'dropdown.listBackground': '#FFFFFF',
	'editor.background': '#FFFFFF',
	'editor.foreground': '#3B3B3B',
	'editor.inactiveSelectionBackground': '#E5EBF1',
	'editor.selectionHighlightBackground': '#ADD6FF80',
	'editorGroup.border': '#E5E5E5',
	'editorGroupHeader.tabsBackground': '#F8F8F8',
	'editorGroupHeader.tabsBorder': '#E5E5E5',
	'editorGutter.addedBackground': '#2EA043',
	'editorGutter.deletedBackground': '#F85149',
	'editorGutter.modifiedBackground': '#005FB8',
	'editorIndentGuide.activeBackground1': '#939393',
	'editorIndentGuide.background1': '#D3D3D3',
	'editorLineNumber.activeForeground': '#171184',
	'editorLineNumber.foreground': '#6E7681',
	'editorOverviewRuler.border': '#E5E5E5',
	'editorSuggestWidget.background': '#F8F8F8',
	'editorWidget.background': '#F8F8F8',
	'errorForeground': '#F85149',
	'focusBorder': '#005FB8',
	'foreground': '#3B3B3B',
	'icon.foreground': '#3B3B3B',
	'input.background': '#FFFFFF',
	'input.border': '#CECECE',
	'input.foreground': '#3B3B3B',
	'input.placeholderForeground': '#767676',
	'inputOption.activeBackground': '#BED6ED',
	'inputOption.activeBorder': '#005FB8',
	'inputOption.activeForeground': '#000000',
	'keybindingLabel.foreground': '#3B3B3B',
	'list.activeSelectionBackground': '#E8E8E8',
	'list.activeSelectionForeground': '#000000',
	'list.activeSelectionIconForeground': '#000000',
	'list.focusAndSelectionOutline': '#005FB8',
	'list.hoverBackground': '#F2F2F2',
	'menu.border': '#CECECE',
	'menu.selectionBackground': '#005FB8',
	'menu.selectionForeground': '#ffffff',
	'notebook.cellBorderColor': '#E5E5E5',
	'notebook.selectedCellBackground': '#C8DDF150',
	'notificationCenterHeader.background': '#FFFFFF',
	'notificationCenterHeader.foreground': '#3B3B3B',
	'notifications.background': '#FFFFFF',
	'notifications.border': '#E5E5E5',
	'notifications.foreground': '#3B3B3B',
	'panel.background': '#F8F8F8',
	'panel.border': '#E5E5E5',
	'panelInput.border': '#E5E5E5',
	'panelTitle.activeBorder': '#005FB8',
	'panelTitle.activeForeground': '#3B3B3B',
	'panelTitle.inactiveForeground': '#3B3B3B',
	'peekViewEditor.matchHighlightBackground': '#BB800966',
	'peekViewResult.background': '#FFFFFF',
	'peekViewResult.matchHighlightBackground': '#BB800966',
	'pickerGroup.border': '#E5E5E5',
	'pickerGroup.foreground': '#8B949E',
	'ports.iconRunningProcessForeground': '#369432',
	'progressBar.background': '#005FB8',
	'quickInput.background': '#F8F8F8',
	'quickInput.foreground': '#3B3B3B',
	'searchEditor.textInputBorder': '#CECECE',
	'settings.dropdownBackground': '#FFFFFF',
	'settings.dropdownBorder': '#CECECE',
	'settings.headerForeground': '#1F1F1F',
	'settings.modifiedItemIndicator': '#BB800966',
	'settings.numberInputBorder': '#CECECE',
	'settings.textInputBorder': '#CECECE',
	'sideBar.background': '#F8F8F8',
	'sideBar.border': '#E5E5E5',
	'sideBar.foreground': '#3B3B3B',
	'sideBarSectionHeader.background': '#F8F8F8',
	'sideBarSectionHeader.border': '#E5E5E5',
	'sideBarSectionHeader.foreground': '#3B3B3B',
	'sideBarTitle.foreground': '#3B3B3B',
	'statusBar.background': '#F8F8F8',
	'statusBar.border': '#E5E5E5',
	'statusBar.debuggingBackground': '#FD716C',
	'statusBar.debuggingForeground': '#000000',
	'statusBar.focusBorder': '#005FB8',
	'statusBar.foreground': '#3B3B3B',
	'statusBar.noFolderBackground': '#F8F8F8',
	'statusBarItem.compactHoverBackground': '#CCCCCC',
	'statusBarItem.errorBackground': '#C72E0F',
	'statusBarItem.focusBorder': '#005FB8',
	'statusBarItem.hoverBackground': '#B8B8B850',
	'statusBarItem.prominentBackground': '#6E768166',
	'statusBarItem.remoteBackground': '#005FB8',
	'statusBarItem.remoteForeground': '#FFFFFF',
	'tab.activeBackground': '#FFFFFF',
	'tab.activeBorder': '#F8F8F8',
	'tab.activeBorderTop': '#005FB8',
	'tab.activeForeground': '#3B3B3B',
	'tab.border': '#E5E5E5',
	'tab.hoverBackground': '#FFFFFF',
	'tab.inactiveBackground': '#F8F8F8',
	'tab.inactiveForeground': '#868686',
	'tab.lastPinnedBorder': '#D4D4D4',
	'tab.selectedBackground': '#ffffffa5',
	'tab.selectedBorderTop': '#68a3da',
	'tab.selectedForeground': '#333333b3',
	'tab.unfocusedActiveBorder': '#F8F8F8',
	'tab.unfocusedActiveBorderTop': '#E5E5E5',
	'tab.unfocusedHoverBackground': '#F8F8F8',
	'terminal.foreground': '#3B3B3B',
	'terminal.inactiveSelectionBackground': '#E5EBF1',
	'terminal.tab.activeBorder': '#005FB8',
	'terminalCursor.foreground': '#005FB8',
	'textBlockQuote.background': '#F8F8F8',
	'textBlockQuote.border': '#E5E5E5',
	'textCodeBlock.background': '#F8F8F8',
	'textLink.activeForeground': '#005FB8',
	'textLink.foreground': '#005FB8',
	'textPreformat.background': '#0000001F',
	'textPreformat.foreground': '#3B3B3B',
	'textSeparator.foreground': '#21262D',
	'titleBar.activeBackground': '#F8F8F8',
	'titleBar.activeForeground': '#1E1E1E',
	'titleBar.border': '#E5E5E5',
	'titleBar.inactiveBackground': '#F8F8F8',
	'titleBar.inactiveForeground': '#8B949E',
	'welcomePage.tileBackground': '#F3F3F3',
	'widget.border': '#E5E5E5'
};

export const COLOR_THEME_2026_DARK_INITIAL_COLORS = {
	'activityBar.activeBorder': '#bfbfbf',
	'activityBar.background': '#191A1B',
	'activityBar.border': '#2A2B2CFF',
	'activityBar.foreground': '#bfbfbf',
	'activityBar.inactiveForeground': '#888888',
	'activityBarBadge.background': '#3994BC',
	'activityBarBadge.foreground': '#FFFFFF',
	'badge.background': '#3994BCF0',
	'badge.foreground': '#FFFFFF',
	'button.background': '#3994BCF2',
	'button.border': '#333536FF',
	'button.foreground': '#FFFFFF',
	'button.hoverBackground': '#3E9BC4',
	'button.secondaryHoverBackground': '#FFFFFF10',
	'checkbox.background': '#242526',
	'checkbox.border': '#333536',
	'descriptionForeground': '#999999',
	'dropdown.background': '#191A1B',
	'dropdown.border': '#333536',
	'dropdown.foreground': '#bfbfbf',
	'dropdown.listBackground': '#202122',
	'editor.background': '#121314',
	'editor.findMatchBackground': '#3994BC4D',
	'editor.foreground': '#BBBEBF',
	'editor.inactiveSelectionBackground': '#3994BC80',
	'editor.selectionHighlightBackground': '#3994BC1A',
	'editorGroup.border': '#2A2B2CFF',
	'editorGroupHeader.tabsBackground': '#191A1B',
	'editorGroupHeader.tabsBorder': '#2A2B2CFF',
	'editorGutter.addedBackground': '#72C892',
	'editorGutter.deletedBackground': '#F28772',
	'editorIndentGuide.activeBackground1': '#838485',
	'editorIndentGuide.background1': '#8384854D',
	'editorLineNumber.activeForeground': '#BBBEBF',
	'editorLineNumber.foreground': '#858889',
	'editorOverviewRuler.border': '#2A2B2CFF',
	'editorWidget.background': '#202122',
	'errorForeground': '#f48771',
	'focusBorder': '#3994BCB3',
	'foreground': '#bfbfbf',
	'icon.foreground': '#888888',
	'input.background': '#191A1B',
	'input.border': '#333536FF',
	'input.foreground': '#bfbfbf',
	'input.placeholderForeground': '#777777',
	'inputOption.activeBackground': '#3994BC33',
	'inputOption.activeBorder': '#2A2B2CFF',
	'list.dropBackground': '#3994BC1A',
	'menu.background': '#202122',
	'menu.border': '#2A2B2CFF',
	'menu.foreground': '#bfbfbf',
	'menu.selectionBackground': '#3994BC26',
	'menu.separatorBackground': '#838485',
	'notificationCenterHeader.background': '#242526',
	'notificationCenterHeader.foreground': '#bfbfbf',
	'notifications.background': '#202122',
	'notifications.border': '#2A2B2CFF',
	'notifications.foreground': '#bfbfbf',
	'panel.background': '#191A1B',
	'panel.border': '#2A2B2CFF',
	'panelTitle.activeBorder': '#3994BC',
	'panelTitle.activeForeground': '#bfbfbf',
	'panelTitle.inactiveForeground': '#888888',
	'peekViewEditor.background': '#191A1B',
	'peekViewEditor.matchHighlightBackground': '#3994BC33',
	'peekViewResult.background': '#191A1B',
	'peekViewResult.matchHighlightBackground': '#3994BC33',
	'pickerGroup.border': '#2A2B2CFF',
	'progressBar.background': '#878889',
	'quickInput.background': '#202122',
	'quickInput.foreground': '#bfbfbf',
	'settings.dropdownBackground': '#191A1B',
	'settings.dropdownBorder': '#333536',
	'settings.headerForeground': '#bfbfbf',
	'settings.modifiedItemIndicator': '#3994BC33',
	'sideBar.background': '#191A1B',
	'sideBar.border': '#2A2B2CFF',
	'sideBar.foreground': '#bfbfbf',
	'sideBarSectionHeader.background': '#191A1B',
	'sideBarSectionHeader.border': '#2A2B2CFF',
	'sideBarSectionHeader.foreground': '#bfbfbf',
	'sideBarTitle.foreground': '#bfbfbf',
	'statusBar.background': '#191A1B',
	'statusBar.border': '#2A2B2CFF',
	'statusBar.debuggingBackground': '#3994BC',
	'statusBar.debuggingForeground': '#FFFFFF',
	'statusBar.focusBorder': '#3994BCB3',
	'statusBar.foreground': '#888888',
	'statusBar.noFolderBackground': '#191A1B',
	'statusBarItem.focusBorder': '#3994BCB3',
	'statusBarItem.prominentBackground': '#3994BC',
	'tab.activeBackground': '#121314',
	'tab.activeBorder': '#121314',
	'tab.activeBorderTop': '#3994BC',
	'tab.activeForeground': '#bfbfbf',
	'tab.border': '#2A2B2CFF',
	'tab.hoverBackground': '#262728',
	'tab.inactiveBackground': '#191A1B',
	'tab.inactiveForeground': '#888888',
	'tab.lastPinnedBorder': '#2A2B2CFF',
	'terminal.foreground': '#bfbfbf',
	'terminal.tab.activeBorder': '#3994BC00',
	'textBlockQuote.background': '#242526',
	'textBlockQuote.border': '#2A2B2CFF',
	'textCodeBlock.background': '#242526',
	'textLink.activeForeground': '#53A5CA',
	'textLink.foreground': '#48A0C7',
	'textPreformat.background': '#262626',
	'textPreformat.foreground': '#888888',
	'textSeparator.foreground': '#2a2a2aFF',
	'titleBar.activeBackground': '#191A1B',
	'titleBar.activeForeground': '#bfbfbf',
	'titleBar.border': '#2A2B2CFF',
	'titleBar.inactiveBackground': '#191A1B',
	'titleBar.inactiveForeground': '#888888',
	'widget.border': '#2A2B2CFF'
};

export const COLOR_THEME_2026_LIGHT_INITIAL_COLORS = {
	'activityBar.activeBorder': '#000000',
	'activityBar.background': '#FAFAFD',
	'activityBar.border': '#F2F3F4FF',
	'activityBar.foreground': '#202020',
	'activityBar.inactiveForeground': '#666666',
	'activityBarBadge.background': '#0069CC',
	'activityBarBadge.foreground': '#FFFFFF',
	'badge.background': '#0069CC',
	'badge.foreground': '#FFFFFF',
	'button.background': '#0069CC',
	'button.border': '#F2F3F4FF',
	'button.foreground': '#FFFFFF',
	'button.hoverBackground': '#0063C1',
	'button.secondaryBackground': '#EDEDED',
	'button.secondaryForeground': '#202020',
	'button.secondaryHoverBackground': '#F3F3F3',
	'checkbox.background': '#EDEDED',
	'checkbox.border': '#D8D8D8',
	'descriptionForeground': '#555555',
	'dropdown.background': '#FFFFFF',
	'dropdown.border': '#D8D8D8',
	'dropdown.foreground': '#202020',
	'dropdown.listBackground': '#FFFFFF',
	'editor.background': '#FFFFFF',
	'editor.foreground': '#202020',
	'editor.inactiveSelectionBackground': '#0069CC1A',
	'editor.selectionHighlightBackground': '#0069CC15',
	'editorGroup.border': '#F2F3F4FF',
	'editorGroupHeader.tabsBackground': '#FAFAFD',
	'editorGroupHeader.tabsBorder': '#F2F3F4FF',
	'editorGutter.addedBackground': '#587c0c',
	'editorGutter.deletedBackground': '#ad0707',
	'editorIndentGuide.activeBackground1': '#F3F3F3',
	'editorIndentGuide.background1': '#F7F7F740',
	'editorLineNumber.activeForeground': '#202020',
	'editorLineNumber.foreground': '#666666',
	'editorOverviewRuler.border': '#F2F3F4FF',
	'editorSuggestWidget.background': '#F0F0F3',
	'editorWidget.background': '#F0F0F3',
	'errorForeground': '#ad0707',
	'focusBorder': '#0069CCFF',
	'foreground': '#202020',
	'icon.foreground': '#666666',
	'input.background': '#FFFFFF',
	'input.border': '#D8D8D866',
	'input.foreground': '#202020',
	'input.placeholderForeground': '#999999',
	'inputOption.activeBackground': '#0069CC26',
	'inputOption.activeBorder': '#F2F3F4FF',
	'inputOption.activeForeground': '#202020',
	'list.activeSelectionBackground': '#0069CC44',
	'list.activeSelectionForeground': '#202020',
	'list.focusAndSelectionOutline': '#0069CCFF',
	'list.hoverBackground': '#F3F3F3',
	'menu.border': '#F2F3F4FF',
	'menu.selectionBackground': '#0069CC1A',
	'menu.selectionForeground': '#202020',
	'notificationCenterHeader.background': '#F0F0F3',
	'notificationCenterHeader.foreground': '#202020',
	'notifications.background': '#F0F0F3',
	'notifications.border': '#F2F3F4FF',
	'notifications.foreground': '#202020',
	'panel.background': '#FAFAFD',
	'panel.border': '#F2F3F4FF',
	'panelTitle.activeBorder': '#000000',
	'panelTitle.activeForeground': '#202020',
	'panelTitle.inactiveForeground': '#666666',
	'peekViewEditor.matchHighlightBackground': '#0069CC33',
	'peekViewResult.background': '#F0F0F3',
	'peekViewResult.matchHighlightBackground': '#0069CC33',
	'pickerGroup.border': '#F2F3F4FF',
	'pickerGroup.foreground': '#202020',
	'progressBar.background': '#0069CC',
	'quickInput.background': '#F0F0F3',
	'quickInput.foreground': '#202020',
	'settings.dropdownBackground': '#FFFFFF',
	'settings.dropdownBorder': '#D8D8D8',
	'settings.headerForeground': '#202020',
	'settings.modifiedItemIndicator': '#0069CC33',
	'sideBar.background': '#FAFAFD',
	'sideBar.border': '#F2F3F4FF',
	'sideBar.foreground': '#202020',
	'sideBarSectionHeader.background': '#FAFAFD',
	'sideBarSectionHeader.border': '#F2F3F4FF',
	'sideBarSectionHeader.foreground': '#202020',
	'sideBarTitle.foreground': '#202020',
	'statusBar.background': '#FAFAFD',
	'statusBar.border': '#F2F3F4FF',
	'statusBar.debuggingBackground': '#0069CC',
	'statusBar.debuggingForeground': '#FFFFFF',
	'statusBar.focusBorder': '#0069CCFF',
	'statusBar.foreground': '#666666',
	'statusBar.noFolderBackground': '#F0F0F3',
	'statusBarItem.focusBorder': '#0069CCFF',
	'statusBarItem.prominentBackground': '#0069CCDD',
	'tab.activeBackground': '#FFFFFF',
	'tab.activeBorder': '#FAFAFD',
	'tab.activeBorderTop': '#000000',
	'tab.activeForeground': '#202020',
	'tab.border': '#F2F3F4FF',
	'tab.hoverBackground': '#F3F3F3',
	'tab.inactiveBackground': '#FAFAFD',
	'tab.inactiveForeground': '#666666',
	'tab.lastPinnedBorder': '#F2F3F4FF',
	'tab.unfocusedActiveBorder': '#FAFAFD',
	'tab.unfocusedActiveBorderTop': '#F2F3F4FF',
	'tab.unfocusedHoverBackground': '#F3F3F3',
	'terminal.foreground': '#202020',
	'terminalCursor.foreground': '#202020',
	'textBlockQuote.background': '#EDEDED',
	'textBlockQuote.border': '#F2F3F4FF',
	'textCodeBlock.background': '#EDEDED',
	'textLink.activeForeground': '#0069CC',
	'textLink.foreground': '#0069CC',
	'textPreformat.foreground': '#666666',
	'textSeparator.foreground': '#EEEEEEFF',
	'titleBar.activeBackground': '#FAFAFD',
	'titleBar.activeForeground': '#424242',
	'titleBar.border': '#F2F3F4FF',
	'titleBar.inactiveBackground': '#FAFAFD',
	'titleBar.inactiveForeground': '#666666',
	'widget.border': '#EEEEF1'
};

export interface IWorkbenchTheme {
	readonly id: string;
	readonly label: string;
	readonly extensionData?: ExtensionData;
	readonly description?: string;
	readonly settingsId: string | null;
}

export interface IWorkbenchColorTheme extends IWorkbenchTheme, IColorTheme {
	readonly settingsId: string;
	readonly tokenColors: ITextMateThemingRule[];
}

export interface IColorMap {
	[id: string]: Color;
}

export interface IWorkbenchFileIconTheme extends IWorkbenchTheme, IFileIconTheme {
}

export interface IWorkbenchProductIconTheme extends IWorkbenchTheme, IProductIconTheme {
	readonly settingsId: string;

	getIcon(icon: IconContribution): IconDefinition | undefined;
}

export type ThemeSettingTarget = ConfigurationTarget | undefined | 'auto' | 'preview';


export interface IWorkbenchThemeService extends IThemeService {
	readonly _serviceBrand: undefined;
	setColorTheme(themeId: string | undefined | IWorkbenchColorTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchColorTheme | null>;
	getColorTheme(): IWorkbenchColorTheme;
	getColorThemes(): Promise<IWorkbenchColorTheme[]>;
	getMarketplaceColorThemes(publisher: string, name: string, version: string): Promise<IWorkbenchColorTheme[]>;
	readonly onDidColorThemeChange: Event<IWorkbenchColorTheme>;

	getPreferredColorScheme(): ColorScheme | undefined;

	setFileIconTheme(iconThemeId: string | undefined | IWorkbenchFileIconTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchFileIconTheme>;
	getFileIconTheme(): IWorkbenchFileIconTheme;
	getFileIconThemes(): Promise<IWorkbenchFileIconTheme[]>;
	getMarketplaceFileIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchFileIconTheme[]>;
	readonly onDidFileIconThemeChange: Event<IWorkbenchFileIconTheme>;

	setProductIconTheme(iconThemeId: string | undefined | IWorkbenchProductIconTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchProductIconTheme>;
	getProductIconTheme(): IWorkbenchProductIconTheme;
	getProductIconThemes(): Promise<IWorkbenchProductIconTheme[]>;
	getMarketplaceProductIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchProductIconTheme[]>;
	readonly onDidProductIconThemeChange: Event<IWorkbenchProductIconTheme>;
}

export interface IThemeScopedColorCustomizations {
	[colorId: string]: string;
}

export interface IColorCustomizations {
	[colorIdOrThemeScope: string]: IThemeScopedColorCustomizations | string;
}

export interface IThemeScopedTokenColorCustomizations {
	[groupId: string]: ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface ITokenColorCustomizations {
	[groupIdOrThemeScope: string]: IThemeScopedTokenColorCustomizations | ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface IThemeScopedSemanticTokenColorCustomizations {
	[styleRule: string]: ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface ISemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]: IThemeScopedSemanticTokenColorCustomizations | ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface IThemeScopedExperimentalSemanticTokenColorCustomizations {
	[themeScope: string]: ISemanticTokenRules | undefined;
}

export interface IExperimentalSemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]: IThemeScopedExperimentalSemanticTokenColorCustomizations | ISemanticTokenRules | undefined;
}

export type IThemeScopedCustomizations =
	IThemeScopedColorCustomizations
	| IThemeScopedTokenColorCustomizations
	| IThemeScopedExperimentalSemanticTokenColorCustomizations
	| IThemeScopedSemanticTokenColorCustomizations;

export type IThemeScopableCustomizations =
	IColorCustomizations
	| ITokenColorCustomizations
	| IExperimentalSemanticTokenColorCustomizations
	| ISemanticTokenColorCustomizations;

export interface ISemanticTokenRules {
	[selector: string]: string | ISemanticTokenColorizationSetting | undefined;
}

export interface ITextMateThemingRule {
	name?: string;
	scope?: string | string[];
	settings: ITokenColorizationSetting;
}

export interface ITokenColorizationSetting {
	foreground?: string;
	background?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	fontFamily?: string;
	fontSize?: number;
	lineHeight?: number;
}

export interface ISemanticTokenColorizationSetting {
	foreground?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	bold?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	italic?: boolean;
}

export interface ExtensionData {
	extensionId: string;
	extensionPublisher: string;
	extensionName: string;
	extensionIsBuiltin: boolean;
}

export namespace ExtensionData {
	export function toJSONObject(d: ExtensionData | undefined): any {
		return d && { _extensionId: d.extensionId, _extensionIsBuiltin: d.extensionIsBuiltin, _extensionName: d.extensionName, _extensionPublisher: d.extensionPublisher };
	}
	export function fromJSONObject(o: any): ExtensionData | undefined {
		if (o && isString(o._extensionId) && isBoolean(o._extensionIsBuiltin) && isString(o._extensionName) && isString(o._extensionPublisher)) {
			return { extensionId: o._extensionId, extensionIsBuiltin: o._extensionIsBuiltin, extensionName: o._extensionName, extensionPublisher: o._extensionPublisher };
		}
		return undefined;
	}
	export function fromName(publisher: string, name: string, isBuiltin = false): ExtensionData {
		return { extensionPublisher: publisher, extensionId: `${publisher}.${name}`, extensionName: name, extensionIsBuiltin: isBuiltin };
	}
}

export interface IThemeExtensionPoint {
	id: string;
	label?: string;
	description?: string;
	path: string;
	uiTheme?: ThemeTypeSelector;
	_watch: boolean; // unsupported options to watch location
}
