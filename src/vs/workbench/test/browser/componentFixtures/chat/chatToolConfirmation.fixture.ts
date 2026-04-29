/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { OffsetRange } from '../../../../../editor/common/core/ranges/offsetRange.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { IMenuService, MenuId } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IMarkerService } from '../../../../../platform/markers/common/markers.js';
import { URI } from '../../../../../base/common/uri.js';
import { IChatWidget } from '../../../../contrib/chat/browser/chat.js';
import { IChatToolRiskAssessmentService, IToolRiskAssessment, ToolActionKind, ToolBlastRadius, ToolReversibility, ToolRiskLevel } from '../../../../contrib/chat/browser/tools/chatToolRiskAssessmentService.js';
import { ChatInputPart, IChatInputPartOptions, IChatInputStyles } from '../../../../contrib/chat/browser/widget/input/chatInputPart.js';
import { ChatListWidget } from '../../../../contrib/chat/browser/widget/chatListWidget.js';
import { ChatAgentLocation, ChatModeKind } from '../../../../contrib/chat/common/constants.js';
import { ChatModel } from '../../../../contrib/chat/common/model/chatModel.js';
import { ChatToolInvocation } from '../../../../contrib/chat/common/model/chatProgressTypes/chatToolInvocation.js';
import { ChatViewModel } from '../../../../contrib/chat/common/model/chatViewModel.js';
import { IChatService } from '../../../../contrib/chat/common/chatService/chatService.js';
import { ChatRequestTextPart } from '../../../../contrib/chat/common/requestParser/chatParserTypes.js';
import { IPreparedToolInvocation, IToolData, ILanguageModelToolsService } from '../../../../contrib/chat/common/tools/languageModelToolsService.js';
import { ILanguageModelToolsConfirmationService } from '../../../../contrib/chat/common/tools/languageModelToolsConfirmationService.js';
import { MockChatService } from '../../../../contrib/chat/test/common/chatService/mockChatService.js';
import { IChatInputNotificationService } from '../../../../contrib/chat/browser/widget/input/chatInputNotificationService.js';
import { ITerminalChatService } from '../../../../contrib/terminal/browser/terminal.js';
import { IPreferencesService } from '../../../../services/preferences/common/preferences.js';
import { ComponentFixtureContext, createEditorServices, defineComponentFixture, defineThemedFixtureGroup } from '../fixtureUtils.js';
import { FixtureMenuService, registerChatFixtureServices } from './chatFixtureUtils.js';

import '../../../../contrib/chat/browser/widget/media/chat.css';

type RiskKind = 'green-clear' | 'green-unclear' | 'orange' | 'red' | 'loading' | 'none';

interface IFixtureMessage {
	readonly user: string;
	readonly assistant?: ReadonlyArray<
		| { kind: 'markdown'; text: string }
		| { kind: 'terminalConfirmation'; command: string; language?: string; title?: string; risk: RiskKind }
	>;
	readonly responseComplete?: boolean;
}

interface IRenderOptions {
	readonly messages: ReadonlyArray<IFixtureMessage>;
	readonly inputDraft?: string;
	readonly height?: number;
	readonly width?: number;
	readonly showInput?: boolean;
}

const ASSESSMENTS: Record<Exclude<RiskKind, 'loading' | 'none'>, IToolRiskAssessment> = {
	'green-clear': {
		risk: ToolRiskLevel.Green,
		kind: ToolActionKind.Read,
		reversibility: ToolReversibility.Trivial,
		blastRadius: ToolBlastRadius.Account,
		needsExplanation: false,
		explanation: 'Lists VMs in the current Azure subscription.',
		suggestedRules: [{ kind: 'thisTool', scope: 'profile', label: 'Always allow this tool', rationale: 'Read-only.' }],
	},
	'green-unclear': {
		risk: ToolRiskLevel.Green,
		kind: ToolActionKind.Read,
		reversibility: ToolReversibility.Trivial,
		blastRadius: ToolBlastRadius.Account,
		needsExplanation: true,
		explanation: 'Lists running VMs in the current Azure subscription.',
		suggestedRules: [{ kind: 'thisTool', scope: 'profile', label: 'Always allow this tool', rationale: 'Read-only.' }],
	},
	orange: {
		risk: ToolRiskLevel.Orange,
		kind: ToolActionKind.WriteRemote,
		reversibility: ToolReversibility.Reversible,
		blastRadius: ToolBlastRadius.Public,
		needsExplanation: true,
		explanation: 'Force-pushes to `main` — will overwrite remote history.',
		suggestedRules: [
			{ kind: 'once', scope: 'session', label: 'Allow this once', rationale: 'Approve only this single call.' },
		],
	},
	red: {
		risk: ToolRiskLevel.Red,
		kind: ToolActionKind.Destructive,
		reversibility: ToolReversibility.Irreversible,
		blastRadius: ToolBlastRadius.Account,
		needsExplanation: true,
		explanation: 'Permanently deletes every file under your home directory — cannot be undone.',
		suggestedRules: [],
	},
};

class FixtureRiskAssessmentService implements IChatToolRiskAssessmentService {
	declare readonly _serviceBrand: undefined;
	private readonly _byToolCallId = new Map<string, IToolRiskAssessment>();
	private readonly _loading = new Set<string>();

	setAssessment(toolCallId: string, assessment: IToolRiskAssessment): void {
		this._byToolCallId.set(toolCallId, assessment);
	}
	setLoading(toolCallId: string): void {
		this._loading.add(toolCallId);
	}
	isEnabled(): boolean { return true; }
	getCached(_tool: IToolData, parameters: unknown): IToolRiskAssessment | undefined {
		const id = (parameters as { __toolCallId?: string })?.__toolCallId;
		if (id && this._loading.has(id)) {
			return undefined;
		}
		return id ? this._byToolCallId.get(id) : undefined;
	}
	async assess(_tool: IToolData, parameters: unknown): Promise<IToolRiskAssessment | undefined> {
		const id = (parameters as { __toolCallId?: string })?.__toolCallId;
		if (id && this._loading.has(id)) {
			return new Promise(() => { /* never resolves — fixture freezes loading state */ });
		}
		return id ? this._byToolCallId.get(id) : undefined;
	}
}

const TERMINAL_TOOL_DATA: IToolData = {
	id: 'runInTerminal',
	source: { type: 'extension', label: 'Built-in', extensionId: new ExtensionIdentifier('vscode.builtin') },
	displayName: 'Run command in terminal',
	modelDescription: 'Runs a command in the integrated terminal.',
	icon: Codicon.terminal,
	tags: [],
};

function makeUserMessage(text: string) {
	return {
		text,
		parts: [new ChatRequestTextPart(new OffsetRange(0, text.length), new Range(1, 1, 1, text.length + 1), text)],
	};
}

function makeTerminalToolInvocation(toolCallId: string, command: string, language: string, _title: string, requestId: string): ChatToolInvocation {
	const prepared: IPreparedToolInvocation = {
		invocationMessage: new MarkdownString(`Run \`${command}\``),
		confirmationMessages: {
			title: new MarkdownString('Run `pwsh` command?'),
			message: new MarkdownString('Run the following command in a pwsh terminal?'),
		},
		toolSpecificData: {
			kind: 'terminal',
			commandLine: { original: command },
			language,
		},
		icon: Codicon.terminal,
	};
	return new ChatToolInvocation(prepared, TERMINAL_TOOL_DATA, toolCallId, undefined, { __toolCallId: toolCallId }, undefined, requestId);
}

async function renderFixture(context: ComponentFixtureContext, options: IRenderOptions): Promise<void> {
	const { container, disposableStore } = context;

	const riskService = new FixtureRiskAssessmentService();

	const instantiationService = createEditorServices(disposableStore, {
		colorTheme: context.theme,
		additionalServices: (reg) => {
			registerChatFixtureServices(reg);
			// Register replacements AFTER registerChatFixtureServices so they win
			// (the registration callback unconditionally overwrites).
			reg.defineInstance(IFileService, new class extends mock<IFileService>() {
				override readonly onDidFilesChange = Event.None;
				override readonly onDidRunOperation = Event.None;
				override readonly onDidChangeFileSystemProviderRegistrations = Event.None;
				override readonly onDidChangeFileSystemProviderCapabilities = Event.None;
				override hasProvider() { return false; }
				override hasCapability() { return false; }
			}());
			reg.defineInstance(ILanguageModelToolsService, new class extends mock<ILanguageModelToolsService>() {
				override readonly onDidChangeTools = Event.None;
				override getTools() { return [TERMINAL_TOOL_DATA]; }
				override getTool(id: string) { return id === TERMINAL_TOOL_DATA.id ? TERMINAL_TOOL_DATA : undefined; }
				override getToolByName(name: string) { return name === TERMINAL_TOOL_DATA.id ? TERMINAL_TOOL_DATA : undefined; }
			}());
			reg.defineInstance(IChatToolRiskAssessmentService, riskService);
			reg.defineInstance(IPreferencesService, new class extends mock<IPreferencesService>() { override openSettings() { return Promise.resolve(undefined); } }());
			reg.defineInstance(ITerminalChatService, new class extends mock<ITerminalChatService>() {
				override readonly onDidRegisterTerminalInstanceWithToolSession = Event.None;
				override registerTerminalInstanceWithToolSession() { }
				override async getTerminalInstanceByToolSessionId() { return undefined; }
				override getToolSessionTerminalInstances() { return []; }
			}());
			reg.defineInstance(IDialogService, new class extends mock<IDialogService>() {
				override async confirm() { return { confirmed: false }; }
				override readonly onWillShowDialog = Event.None;
				override readonly onDidShowDialog = Event.None;
			}());
			reg.defineInstance(IMarkerService, new class extends mock<IMarkerService>() {
				override readonly onMarkerChanged = Event.None;
				override read() { return []; }
			}());
			reg.defineInstance(ILanguageModelToolsConfirmationService, new class extends mock<ILanguageModelToolsConfirmationService>() { }());
			reg.defineInstance(IChatInputNotificationService, new class extends mock<IChatInputNotificationService>() {
				override readonly onDidChange = Event.None;
				override getActiveNotification() { return undefined; }
				override handleMessageSent() { }
				override setNotification() { }
				override deleteNotification() { }
				override dismissNotification() { }
			}());
		},
	});

	const configService = instantiationService.get(IConfigurationService) as TestConfigurationService;
	await configService.setUserConfiguration('chat', {
		editor: { fontSize: 13, fontFamily: 'default', fontWeight: 'default', lineHeight: 0, wordWrap: 'off' },
	});
	await configService.setUserConfiguration('editor', { fontFamily: 'monospace', fontLigatures: false });

	const chatService = instantiationService.get(IChatService) as MockChatService;
	const model = disposableStore.add(instantiationService.createInstance(
		ChatModel,
		undefined,
		{ initialLocation: ChatAgentLocation.Chat, canUseTools: true }
	));
	chatService.addSession(model);

	for (const message of options.messages) {
		const request = model.addRequest(makeUserMessage(message.user), { variables: [] }, 0);
		const response = request.response!;
		for (const part of message.assistant ?? []) {
			if (part.kind === 'markdown') {
				model.acceptResponseProgress(request, { kind: 'markdownContent', content: new MarkdownString(part.text) });
			} else if (part.kind === 'terminalConfirmation') {
				const toolCallId = `tc-${Math.random().toString(36).slice(2, 10)}`;
				if (part.risk === 'loading') {
					riskService.setLoading(toolCallId);
				} else if (part.risk !== 'none') {
					riskService.setAssessment(toolCallId, ASSESSMENTS[part.risk]);
				}
				const invocation = makeTerminalToolInvocation(
					toolCallId,
					part.command,
					part.language ?? 'pwsh',
					part.title ?? 'Run pwsh command?',
					request.id,
				);
				model.acceptResponseProgress(request, invocation);
			}
		}
		if (message.responseComplete !== false) {
			response.complete();
		}
	}

	const viewModel = disposableStore.add(instantiationService.createInstance(ChatViewModel, model, undefined));

	const width = options.width ?? 720;
	const height = options.height ?? 700;

	container.style.width = `${width}px`;
	container.style.height = `${height}px`;
	container.style.display = 'flex';
	container.style.flexDirection = 'column';
	container.style.backgroundColor = 'var(--vscode-sideBar-background, var(--vscode-editor-background))';
	container.classList.add('monaco-workbench');

	const session = dom.$('.interactive-session');
	session.style.flex = '1 1 auto';
	session.style.display = 'flex';
	session.style.flexDirection = 'column';
	session.style.minHeight = '0';
	container.appendChild(session);

	// Spacer that pushes the list to the bottom of the available space, mirroring
	// the live workbench where the chat list is normally scrolled to its tail.
	const topSpacer = dom.$('div.fixture-chat-top-spacer');
	topSpacer.style.flex = '1 1 auto';
	topSpacer.style.minHeight = '0';
	session.appendChild(topSpacer);

	const listContainer = dom.$('.interactive-list');
	listContainer.style.flex = '0 0 auto';
	listContainer.style.position = 'relative';
	session.appendChild(listContainer);

	const listWidget = disposableStore.add(instantiationService.createInstance(
		ChatListWidget,
		listContainer,
		{
			currentChatMode: () => ChatModeKind.Agent,
			defaultElementHeight: 200,
			renderStyle: 'compact',
			styles: {
				listForeground: 'var(--vscode-foreground)',
				listBackground: 'var(--vscode-editor-background)',
			},
			location: ChatAgentLocation.Chat,
		},
	));
	listWidget.setViewModel(viewModel);
	listWidget.setVisible(true);
	listWidget.refresh();

	if (options.showInput !== false) {
		const menuService = instantiationService.get(IMenuService) as FixtureMenuService;
		menuService.addItem(MenuId.ChatInput, { command: { id: 'workbench.action.chat.attachContext', title: '+', icon: Codicon.add }, group: 'navigation', order: -1 });
		menuService.addItem(MenuId.ChatInput, { command: { id: 'workbench.action.chat.openModePicker', title: 'Agent' }, group: 'navigation', order: 1 });
		menuService.addItem(MenuId.ChatInput, { command: { id: 'workbench.action.chat.openModelPicker', title: 'GPT-5.3-Codex' }, group: 'navigation', order: 3 });
		menuService.addItem(MenuId.ChatExecute, { command: { id: 'workbench.action.chat.submit', title: 'Send', icon: Codicon.arrowUp }, group: 'navigation', order: 4 });

		const inputOptions: IChatInputPartOptions = {
			renderFollowups: false,
			renderInputToolbarBelowInput: false,
			renderWorkingSet: false,
			menus: { executeToolbar: MenuId.ChatExecute, telemetrySource: 'fixture' },
			widgetViewKindTag: 'view',
			inputEditorMinLines: 2,
		};
		const inputStyles: IChatInputStyles = {
			overlayBackground: 'var(--vscode-editor-background)',
			listForeground: 'var(--vscode-foreground)',
			listBackground: 'var(--vscode-editor-background)',
		};

		const inputPart = disposableStore.add(instantiationService.createInstance(ChatInputPart, ChatAgentLocation.Chat, inputOptions, inputStyles, false));
		const mockWidget = new class extends mock<IChatWidget>() {
			override readonly onDidChangeViewModel = new Emitter<never>().event;
			override readonly viewModel = undefined;
			override readonly contribs = [];
			override readonly location = ChatAgentLocation.Chat;
			override readonly viewContext = {};
		}();
		inputPart.render(session, options.inputDraft ?? '', mockWidget);
		inputPart.layout(width);
		await new Promise(r => setTimeout(r, 80));
		inputPart.layout(width);
		inputPart.renderArtifactsWidget(URI.parse('chat-session:fixture'));
		await inputPart.renderChatTodoListWidget(URI.parse('chat-session:fixture'));
	}

	// Two passes to allow async progressive rendering to settle. After the first
	// pass we measure the actual content height and shrink the list to it so the
	// top spacer can push the conversation to the bottom of the viewport.
	const inputReserved = options.showInput === false ? 0 : 140;
	const maxListHeight = height - inputReserved;
	listWidget.layout(maxListHeight, width);
	await new Promise(r => setTimeout(r, 100));
	const contentHeight = Math.min(maxListHeight, Math.max(120, listWidget.scrollHeight));
	listWidget.layout(contentHeight, width);
	listContainer.style.height = `${contentHeight}px`;
	await new Promise(r => setTimeout(r, 50));
	listWidget.scrollTop = listWidget.scrollHeight;
}

const PRIOR_FORCE_PUSH: IFixtureMessage[] = [
	{
		user: 'Update the remote `main` branch with my local rewritten history.',
		assistant: [
			{ kind: 'markdown', text: 'I will run a force-push so the remote `main` matches the local branch. Please confirm — this rewrites shared history and other collaborators may lose work.' },
			{ kind: 'terminalConfirmation', command: 'git push --force origin main', risk: 'orange' },
		],
		responseComplete: false,
	},
];

const PRIOR_DELETE: IFixtureMessage[] = [
	{
		user: 'Free up some disk space.',
		assistant: [
			{ kind: 'markdown', text: 'I will remove the home directory caches. Please review the command before approving.' },
			{ kind: 'terminalConfirmation', command: 'rm -rf $HOME', risk: 'red' },
		],
		responseComplete: false,
	},
];

const PRIOR_SAFE: IFixtureMessage[] = [
	{
		user: 'List files in the workspace root.',
		assistant: [
			{ kind: 'markdown', text: 'I will use `ls` to list the contents of the workspace root.' },
			{ kind: 'terminalConfirmation', command: 'ls -lh', risk: 'green-clear' },
		],
		responseComplete: false,
	},
];

// Read-only command that uses an unfamiliar query language (JMESPath). The badge
// stays visible with a neutral icon and explains what the call actually does.
const PRIOR_AZ_QUERY: IFixtureMessage[] = [
	{
		user: 'Which of my Azure VMs are currently running?',
		assistant: [
			{ kind: 'markdown', text: 'I will query Azure for running VMs in the current subscription.' },
			{ kind: 'terminalConfirmation', command: `az vm list --query "[?powerState=='VM running'].name" -o tsv`, risk: 'green-unclear' },
		],
		responseComplete: false,
	},
];

// Plain `az ... list`: read-only and obvious to a developer — no badge at all.
const PRIOR_AZ_LIST: IFixtureMessage[] = [
	{
		user: 'Show me my Azure VMs.',
		assistant: [
			{ kind: 'markdown', text: 'I will list the VMs in the current Azure subscription.' },
			{ kind: 'terminalConfirmation', command: 'az vm list -o table', risk: 'green-clear' },
		],
		responseComplete: false,
	},
];

const PRIOR_LOADING: IFixtureMessage[] = [
	{
		user: 'Run the migration script.',
		assistant: [
			{ kind: 'markdown', text: 'About to run the migration. Assessing risk...' },
			{ kind: 'terminalConfirmation', command: 'node scripts/migrate.js --apply', risk: 'loading' },
		],
		responseComplete: false,
	},
];

const PRIOR_NO_BADGE: IFixtureMessage[] = [
	{
		user: 'Check if google.com is reachable from this machine.',
		assistant: [
			{ kind: 'markdown', text: 'I will run `ping google.com` to verify the network path. This sends a few ICMP echo requests and prints the round-trip times — it is a read-only diagnostic.' },
			{ kind: 'terminalConfirmation', command: 'ping google.com', risk: 'none' },
		],
		responseComplete: false,
	},
];

export default defineThemedFixtureGroup({ path: 'chat/toolConfirmation/' }, {
	'In context - Orange': defineComponentFixture({
		labels: { kind: 'screenshot' },
		render: ctx => renderFixture(ctx, { messages: PRIOR_FORCE_PUSH }),
	}),
	'In context - Red': defineComponentFixture({
		labels: { kind: 'screenshot' },
		render: ctx => renderFixture(ctx, { messages: PRIOR_DELETE }),
	}),
	'In context - Green': defineComponentFixture({
		labels: { kind: 'screenshot' },
		render: ctx => renderFixture(ctx, { messages: PRIOR_SAFE }),
	}),
	'In context - Green clear (az list)': defineComponentFixture({
		labels: { kind: 'screenshot' },
		render: ctx => renderFixture(ctx, { messages: PRIOR_AZ_LIST }),
	}),
	'In context - Green unclear (az query)': defineComponentFixture({
		labels: { kind: 'screenshot' },
		render: ctx => renderFixture(ctx, { messages: PRIOR_AZ_QUERY }),
	}),
	'In context - Loading': defineComponentFixture({
		labels: { kind: 'animated' },
		render: ctx => renderFixture(ctx, { messages: PRIOR_LOADING }),
	}),
	'In context - No badge': defineComponentFixture({
		labels: { kind: 'screenshot' },
		render: ctx => renderFixture(ctx, { messages: PRIOR_NO_BADGE }),
	}),
});
