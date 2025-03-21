/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { SYMBOL_ICON_ENUMERATOR_FOREGROUND, SYMBOL_ICON_METHOD_FOREGROUND } from '../../../../editor/contrib/symbolIcons/browser/symbolIcons.js';
import { localize } from '../../../../nls.js';
import { registerColor } from '../../../../platform/theme/common/colorRegistry.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';

export const terminalViewIcon = registerIcon('terminal-view-icon', Codicon.terminal, localize('terminalViewIcon', 'View icon of the terminal view.'));

export const renameTerminalIcon = registerIcon('terminal-rename', Codicon.edit, localize('renameTerminalIcon', 'Icon for rename in the terminal quick menu.'));
export const killTerminalIcon = registerIcon('terminal-kill', Codicon.trash, localize('killTerminalIcon', 'Icon for killing a terminal instance.'));
export const newTerminalIcon = registerIcon('terminal-new', Codicon.add, localize('newTerminalIcon', 'Icon for creating a new terminal instance.'));

export const configureTerminalProfileIcon = registerIcon('terminal-configure-profile', Codicon.gear, localize('configureTerminalProfileIcon', 'Icon for creating a new terminal profile.'));

export const terminalDecorationMark = registerIcon('terminal-decoration-mark', Codicon.circleSmallFilled, localize('terminalDecorationMark', 'Icon for a terminal decoration mark.'));
export const terminalDecorationIncomplete = registerIcon('terminal-decoration-incomplete', Codicon.circle, localize('terminalDecorationIncomplete', 'Icon for a terminal decoration of a command that was incomplete.'));
export const terminalDecorationError = registerIcon('terminal-decoration-error', Codicon.errorSmall, localize('terminalDecorationError', 'Icon for a terminal decoration of a command that errored.'));
export const terminalDecorationSuccess = registerIcon('terminal-decoration-success', Codicon.circleFilled, localize('terminalDecorationSuccess', 'Icon for a terminal decoration of a command that was successful.'));

export const commandHistoryRemoveIcon = registerIcon('terminal-command-history-remove', Codicon.close, localize('terminalCommandHistoryRemove', 'Icon for removing a terminal command from command history.'));
export const commandHistoryOutputIcon = registerIcon('terminal-command-history-output', Codicon.output, localize('terminalCommandHistoryOutput', 'Icon for viewing output of a terminal command.'));
export const commandHistoryFuzzySearchIcon = registerIcon('terminal-command-history-fuzzy-search', Codicon.searchFuzzy, localize('terminalCommandHistoryFuzzySearch', 'Icon for toggling fuzzy search of command history.'));
export const commandHistoryOpenFileIcon = registerIcon('terminal-command-history-open-file', Codicon.symbolReference, localize('terminalCommandHistoryOpenFile', 'Icon for opening a shell history file.'));


export const TERMINAL_SYMBOL_ICON_FLAG_FOREGROUND = registerColor('terminalSymbolIcon.flagForeground', SYMBOL_ICON_ENUMERATOR_FOREGROUND, localize('terminalSymbolIcon.flagForeground', 'The foreground color for an flag icon. These icons will appear in the terminal suggest widget.'));

export const TERMINAL_SYMBOL_ICON_ALIAS_FOREGROUND = registerColor('terminalSymbolIcon.aliasForeground', SYMBOL_ICON_METHOD_FOREGROUND, localize('terminalSymbolIcon.aliasForeground', 'The foreground color for an alias icon. These icons will appear in the terminal suggest widget.'));

export const TERMINAL_SYMBOL_ICON_ENUM_MEMBER_FOREGROUND = registerColor('terminalSymbolIcon.enumMemberForeground', SYMBOL_ICON_ENUMERATOR_FOREGROUND, localize('terminalSymbolIcon.enumMemberForeground', 'The foreground color for an enum member icon. These icons will appear in the terminal suggest widget.'));

export const terminalSymbolFlagIcon = registerIcon('terminal-symbol-flag', Codicon.flag, localize('terminalSymbolFlagIcon', 'Icon for flags in the terminal suggest widget.'), TERMINAL_SYMBOL_ICON_FLAG_FOREGROUND);
export const terminalSymbolAliasIcon = registerIcon('terminal-symbol-alias', Codicon.symbolMethod, localize('terminalSymbolAliasIcon', 'Icon for aliases in the terminal suggest widget.'), TERMINAL_SYMBOL_ICON_ALIAS_FOREGROUND);
export const terminalSymbolEnumMember = registerIcon('symbol-enum-member', Codicon.symbolEnumMember, localize('terminalSymbolEnumMember', 'Icon for enum members in the terminal suggest widget.'), TERMINAL_SYMBOL_ICON_ENUM_MEMBER_FOREGROUND);
