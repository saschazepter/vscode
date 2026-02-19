/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const chatDebugStyles = `
.chat-debug-editor {
	display: flex;
	flex-direction: column;
	overflow: hidden;
}

/* ---- Home view ---- */
.chat-debug-home {
	display: flex;
	flex-direction: column;
	align-items: center;
	padding: 48px 24px;
	overflow-y: auto;
	flex: 1;
}
.chat-debug-home-title {
	font-size: 18px;
	font-weight: 600;
	margin: 0 0 8px;
}
.chat-debug-home-subtitle {
	font-size: 13px;
	color: var(--vscode-descriptionForeground);
	margin: 0 0 24px;
}
.chat-debug-home-empty {
	font-size: 13px;
	color: var(--vscode-descriptionForeground);
	margin: 0;
}
.chat-debug-home-session-list {
	display: flex;
	flex-direction: column;
	gap: 4px;
	width: 100%;
	max-width: 400px;
}
.chat-debug-home-session-item {
	display: flex;
	align-items: center;
	width: 100%;
	text-align: left;
	padding: 8px 12px;
	border: 1px solid var(--vscode-widget-border, transparent);
	background: transparent;
	color: var(--vscode-foreground);
	border-radius: 4px;
	cursor: pointer;
	font-size: 13px;
	gap: 8px;
}
.chat-debug-home-session-item:hover {
	background: var(--vscode-list-hoverBackground);
}
.chat-debug-home-session-item-active {
	border-color: var(--vscode-focusBorder);
}
.chat-debug-home-session-item-title {
	flex: 1;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.chat-debug-home-session-item-shimmer {
	height: 14px;
	min-width: 160px;
	border-radius: 3px;
	background: linear-gradient(
		90deg,
		var(--vscode-descriptionForeground) 25%,
		var(--vscode-chat-thinkingShimmer, rgba(255, 255, 255, 0.3)) 50%,
		var(--vscode-descriptionForeground) 75%
	);
	background-size: 200% 100%;
	animation: chat-debug-shimmer 2s linear infinite;
	opacity: 0.15;
}
.chat-debug-home-session-badge {
	flex-shrink: 0;
	padding: 2px 8px;
	border-radius: 10px;
	background: var(--vscode-badge-background);
	color: var(--vscode-badge-foreground);
	font-size: 11px;
	font-weight: 500;
}

@keyframes chat-debug-shimmer {
	0% { background-position: 120% 0; }
	100% { background-position: -120% 0; }
}

/* ---- Breadcrumb ---- */
.chat-debug-breadcrumb {
	flex-shrink: 0;
	border-bottom: 1px solid var(--vscode-widget-border, transparent);
}
.chat-debug-breadcrumb .monaco-breadcrumbs {
	height: 22px;
}
.chat-debug-breadcrumb .monaco-breadcrumb-item {
	display: flex;
	align-items: center;
	font-size: 12px;
}
.chat-debug-breadcrumb .monaco-breadcrumb-item::before {
	width: 16px;
	height: 22px;
	display: flex;
	align-items: center;
	justify-content: center;
}
.chat-debug-breadcrumb-item-link {
	cursor: pointer;
}
.chat-debug-breadcrumb .monaco-breadcrumb-item:last-child .codicon:last-child {
	display: none;
}

/* ---- Overview view ---- */
.chat-debug-overview {
	display: flex;
	flex-direction: column;
	overflow-y: auto;
	flex: 1;
}
.chat-debug-overview-content {
	padding: 16px 24px;
}
.chat-debug-overview-title-row {
	display: flex;
	align-items: center;
	gap: 12px;
	margin-bottom: 20px;
}
.chat-debug-overview-title {
	font-size: 16px;
	font-weight: 600;
	margin: 0;
	flex: 1;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.chat-debug-overview-title-actions {
	display: flex;
	align-items: center;
	gap: 4px;
	flex-shrink: 0;
}
.chat-debug-overview-section {
	margin-bottom: 24px;
}
.chat-debug-overview-section-label {
	font-size: 13px;
	font-weight: 600;
	margin: 0 0 10px;
	color: var(--vscode-foreground);
}
.chat-debug-overview-metrics {
	display: flex;
	gap: 12px;
	flex-wrap: wrap;
}
.chat-debug-overview-metric-card {
	border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
	border-radius: 4px;
	padding: 12px 16px;
	min-width: 120px;
}
.chat-debug-overview-metric-label {
	font-size: 11px;
	color: var(--vscode-descriptionForeground);
	margin-bottom: 4px;
}
.chat-debug-overview-metric-value {
	font-size: 16px;
	font-weight: 600;
}
.chat-debug-overview-details {
	display: grid;
	grid-template-columns: auto 1fr;
	gap: 6px 16px;
	font-size: 13px;
}
.chat-debug-overview-detail-row {
	display: contents;
}
.chat-debug-overview-detail-label {
	color: var(--vscode-descriptionForeground);
	white-space: nowrap;
}
.chat-debug-overview-detail-value {
	color: var(--vscode-foreground);
}
.chat-debug-overview-actions {
	display: flex;
	gap: 10px;
	flex-wrap: wrap;
}
.chat-debug-overview-action-button {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 8px 16px;
	border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, transparent));
	background: var(--vscode-button-secondaryBackground);
	color: var(--vscode-button-secondaryForeground);
	border-radius: 2px;
	cursor: pointer;
	font-size: 13px;
}
.chat-debug-overview-action-button:hover {
	background: var(--vscode-button-secondaryHoverBackground);
}
.chat-debug-icon-button {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 26px;
	height: 26px;
	border: none;
	background: transparent;
	color: var(--vscode-foreground);
	border-radius: 4px;
	cursor: pointer;
	opacity: 0.7;
	flex-shrink: 0;
}
.chat-debug-icon-button:hover {
	opacity: 1;
	background: var(--vscode-toolbar-hoverBackground);
}
.chat-debug-overview-action-button-primary {
	background: var(--vscode-button-background);
	color: var(--vscode-button-foreground);
}
.chat-debug-overview-action-button-primary:hover {
	background: var(--vscode-button-hoverBackground);
}

/* ---- Logs view ---- */
.chat-debug-logs {
	display: flex;
	flex-direction: column;
	overflow: hidden;
	flex: 1;
}
.chat-debug-editor-header {
	display: flex;
	align-items: center;
	padding: 8px 16px;
	gap: 12px;
	flex-shrink: 0;
}
.chat-debug-editor-header .viewpane-filter-container {
	flex: 1;
	max-width: 500px;
}
.chat-debug-view-mode-toggle {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 4px 8px;
	border: 1px solid var(--vscode-input-border, transparent);
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	border-radius: 2px;
	outline: none;
	font-size: 12px;
	cursor: pointer;
}
.chat-debug-view-mode-toggle:hover {
	background: var(--vscode-list-hoverBackground);
}
.chat-debug-view-mode-toggle:focus {
	border-color: var(--vscode-focusBorder);
}
.chat-debug-table-header {
	display: flex;
	padding: 4px 16px;
	font-weight: 600;
	font-size: 12px;
	border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
	flex-shrink: 0;
	color: var(--vscode-foreground);
	opacity: 0.8;
}
.chat-debug-table-header .chat-debug-col-created {
	width: 160px;
	flex-shrink: 0;
}
.chat-debug-table-header .chat-debug-col-name {
	width: 200px;
	flex-shrink: 0;
}
.chat-debug-table-header .chat-debug-col-details {
	flex: 1;
}
.chat-debug-logs-body {
	display: flex;
	flex-direction: row;
	flex: 1;
	overflow: hidden;
}
.chat-debug-list-container {
	flex: 1;
	overflow: hidden;
}
.chat-debug-log-row {
	display: flex;
	align-items: center;
	padding: 0 16px;
	height: 28px;
	border-bottom: 1px solid var(--vscode-widget-border, transparent);
	font-size: 12px;
}
.chat-debug-log-row .chat-debug-log-created {
	width: 160px;
	flex-shrink: 0;
	color: var(--vscode-descriptionForeground);
}
.chat-debug-log-row .chat-debug-log-name {
	width: 200px;
	flex-shrink: 0;
	font-weight: 500;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.chat-debug-log-row .chat-debug-log-details {
	flex: 1;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.chat-debug-log-row.chat-debug-log-error {
	background-color: var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.1));
	color: var(--vscode-errorForeground);
}
.chat-debug-log-row.chat-debug-log-warning {
	background-color: var(--vscode-inputValidation-warningBackground, rgba(255, 204, 0, 0.1));
}
.chat-debug-log-row.chat-debug-log-trace {
	opacity: 0.7;
}
.chat-debug-detail-panel {
	flex-shrink: 0;
	width: 350px;
	overflow-y: auto;
	padding: 8px 16px;
	border-left: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
	box-shadow: -6px 0 6px -6px var(--vscode-widget-shadow);
	background: var(--vscode-editorWidget-background);
	font-size: 12px;
	position: relative;
}
.chat-debug-detail-header {
	display: flex;
	justify-content: flex-end;
	position: sticky;
	top: 0;
}
.chat-debug-detail-button {
	border: none;
	background: transparent;
	color: var(--vscode-foreground);
	cursor: pointer;
	font-size: 16px;
	line-height: 1;
	padding: 2px 6px;
	border-radius: 4px;
	opacity: 0.7;
}
.chat-debug-detail-button:hover {
	opacity: 1;
	background: var(--vscode-toolbar-hoverBackground);
}
.chat-debug-detail-panel pre {
	margin: 0;
	white-space: pre-wrap;
	word-break: break-word;
	font-size: 12px;
	user-select: text;
	-webkit-user-select: text;
	cursor: text;
	outline: none;
}
.chat-debug-detail-panel pre:focus {
	outline: 1px solid var(--vscode-focusBorder);
	outline-offset: -1px;
}

/* ---- Subagent Chart view ---- */
.chat-debug-subagent-chart {
	display: flex;
	flex-direction: column;
	overflow-y: auto;
	flex: 1;
}
.chat-debug-subagent-chart-content {
	padding: 16px 24px;
}
.chat-debug-subagent-chart-title {
	font-size: 14px;
	font-weight: 600;
	margin: 0 0 6px;
}
.chat-debug-subagent-chart-desc {
	font-size: 12px;
	color: var(--vscode-descriptionForeground);
	margin: 0 0 16px;
}
.chat-debug-subagent-chart-actions {
	display: flex;
	gap: 8px;
	margin-bottom: 20px;
}
.chat-debug-subagent-flow-visual {
	display: flex;
	flex-direction: column;
	align-items: center;
	padding: 16px 0;
	margin-bottom: 24px;
}
.chat-debug-flow-node {
	padding: 10px 20px;
	border-radius: 6px;
	font-size: 13px;
	font-weight: 500;
	text-align: center;
	min-width: 180px;
	max-width: 360px;
}
.chat-debug-flow-main {
	background: var(--vscode-button-background);
	color: var(--vscode-button-foreground);
}
.chat-debug-flow-subagent {
	background: var(--vscode-editorWidget-background);
	border: 2px solid var(--vscode-focusBorder);
	color: var(--vscode-foreground);
}
.chat-debug-flow-subagent-name {
	font-weight: 600;
	margin-bottom: 4px;
}
.chat-debug-flow-subagent-desc {
	font-size: 11px;
	color: var(--vscode-descriptionForeground);
	margin-bottom: 4px;
}
.chat-debug-flow-subagent-stats {
	font-size: 11px;
	color: var(--vscode-descriptionForeground);
}
.chat-debug-flow-tool-chips {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
	margin-top: 6px;
}
.chat-debug-flow-tool-chip {
	display: inline-block;
	font-size: 10px;
	line-height: 1;
	padding: 3px 7px;
	border-radius: 10px;
	background: var(--vscode-badge-background);
	color: var(--vscode-badge-foreground);
	white-space: nowrap;
	opacity: 0.85;
}
.chat-debug-flow-tool-chip-more {
	opacity: 0.6;
	font-style: italic;
}
.chat-debug-flow-end {
	background: var(--vscode-badge-background);
	color: var(--vscode-badge-foreground);
}
.chat-debug-flow-arrow {
	font-size: 20px;
	line-height: 1;
	padding: 4px 0;
	color: var(--vscode-foreground);
	opacity: 0.5;
}
.chat-debug-flow-arrow-return {
	opacity: 0.3;
}
.chat-debug-subagent-flow-empty {
	font-size: 13px;
	color: var(--vscode-descriptionForeground);
	text-align: center;
	padding: 32px 0;
}
.chat-debug-subagent-chart-code-section {
	border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
	padding-top: 16px;
}
.chat-debug-subagent-chart-code-label {
	font-size: 13px;
	font-weight: 600;
	margin: 0 0 8px;
}
.chat-debug-subagent-chart-code {
	background: var(--vscode-textCodeBlock-background);
	border: 1px solid var(--vscode-widget-border, transparent);
	border-radius: 4px;
	padding: 12px;
	margin: 0;
	overflow-x: auto;
	font-family: var(--vscode-editor-font-family, monospace);
	font-size: 12px;
	white-space: pre;
	user-select: text;
	-webkit-user-select: text;
	cursor: text;
}
`;
