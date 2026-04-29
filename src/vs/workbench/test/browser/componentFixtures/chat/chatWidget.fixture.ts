/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { OffsetRange } from '../../../../../editor/common/core/ranges/offsetRange.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { ChatRequestTextPart } from '../../../../contrib/chat/common/requestParser/chatParserTypes.js';
import { ChatModel } from '../../../../contrib/chat/common/model/chatModel.js';
import { ChatViewModel } from '../../../../contrib/chat/common/model/chatViewModel.js';
import { ChatListWidget } from '../../../../contrib/chat/browser/widget/chatListWidget.js';
import { IChatService } from '../../../../contrib/chat/common/chatService/chatService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ChatAgentLocation, ChatModeKind } from '../../../../contrib/chat/common/constants.js';
import { MockChatService } from '../../../../contrib/chat/test/common/chatService/mockChatService.js';
import { ComponentFixtureContext, createEditorServices, defineComponentFixture, defineThemedFixtureGroup } from '../fixtureUtils.js';
import { registerChatFixtureServices } from './chatFixtureUtils.js';

import '../../../../contrib/chat/browser/widget/media/chat.css';

interface IFixtureMessage {
	readonly user: string; // user prompt text
	readonly assistant?: ReadonlyArray<{ kind: 'markdown'; text: string } | { kind: 'progress'; text: string } | { kind: 'confirmation'; title: string; message: string; buttons?: string[] }>;
	readonly responseComplete?: boolean;
}

interface IChatWidgetFixtureOptions {
	readonly messages: ReadonlyArray<IFixtureMessage>;
}

function makeUserMessage(text: string) {
	return {
		text,
		parts: [new ChatRequestTextPart(new OffsetRange(0, text.length), new Range(1, 1, 1, text.length + 1), text)],
	};
}

async function renderChatWidget(context: ComponentFixtureContext, options: IChatWidgetFixtureOptions): Promise<void> {
	const { container, disposableStore } = context;

	const instantiationService = createEditorServices(disposableStore, {
		colorTheme: context.theme,
		additionalServices: (reg) => {
			registerChatFixtureServices(reg);
		},
	});

	const configService = instantiationService.get(IConfigurationService) as TestConfigurationService;
	await configService.setUserConfiguration('chat', {
		editor: { fontSize: 13, fontFamily: 'default', fontWeight: 'default', lineHeight: 0, wordWrap: 'off' },
	});
	await configService.setUserConfiguration('editor', { fontFamily: 'monospace', fontLigatures: false });

	// Build a real ChatModel populated with hand-crafted requests/responses, then drive a
	// real ChatViewModel + ChatListWidget — the same components used in production.
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
			} else if (part.kind === 'progress') {
				model.acceptResponseProgress(request, { kind: 'progressMessage', content: new MarkdownString(part.text) });
			} else if (part.kind === 'confirmation') {
				model.acceptResponseProgress(request, { kind: 'confirmation', title: part.title, message: new MarkdownString(part.message), data: {}, buttons: part.buttons ?? ['Allow', 'Cancel'] });
			}
		}
		if (message.responseComplete !== false) {
			response.complete();
		}
	}

	const viewModel = disposableStore.add(instantiationService.createInstance(ChatViewModel, model, undefined));

	// Use plain block layout for the outer container: `.interactive-session` has
	// `margin: auto` in chat.css which collapses to width 0 inside a flex parent.
	container.style.width = '720px';
	container.style.height = '600px';
	container.style.backgroundColor = 'var(--vscode-sideBar-background, var(--vscode-editor-background))';
	container.classList.add('monaco-workbench');

	const session = dom.$('.interactive-session');
	container.appendChild(session);

	const listContainer = dom.$('.interactive-list');
	listContainer.style.flex = '1 1 auto';
	listContainer.style.minHeight = '0';
	listContainer.style.position = 'relative';
	session.appendChild(listContainer);

	const listWidget = disposableStore.add(instantiationService.createInstance(
		ChatListWidget,
		listContainer,
		{
			currentChatMode: () => ChatModeKind.Agent,
			defaultElementHeight: 120,
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
	listWidget.layout(600, 720);

	// Allow the renderer to flush its async progressive rendering pass.
	await new Promise(r => setTimeout(r, 100));
	listWidget.layout(600, 720);
	listWidget.scrollTop = 0;
}

const SIMPLE_QA: IFixtureMessage[] = [
	{
		user: 'Add a fibonacci function to fibon.ts',
		assistant: [
			{ kind: 'markdown', text: 'I added a recursive `fibonacci(n)` to `fibon.ts`. Note that recursion is exponential — for large `n` consider an iterative version.' },
		],
	},
];

const PENDING_TOOL_APPROVAL: IFixtureMessage[] = [
	{
		user: 'Run the test suite',
		assistant: [
			{ kind: 'markdown', text: 'I will run the tests now.' },
			{
				kind: 'confirmation',
				title: 'Run command in terminal?',
				message: '`npm test`',
				buttons: ['Allow', 'Allow in this Workspace', 'Cancel'],
			},
		],
		responseComplete: false,
	},
];

const STREAMING: IFixtureMessage[] = [
	{
		user: 'Search the workspace for TODO comments',
		assistant: [
			{ kind: 'progress', text: 'Searching workspace for `TODO` comments...' },
		],
		responseComplete: false,
	},
];

const MULTI_TURN: IFixtureMessage[] = [
	{
		user: 'What does this project do?',
		assistant: [
			{ kind: 'markdown', text: 'This project is **Visual Studio Code**, a free source-code editor made by Microsoft for Windows, Linux and macOS.' },
		],
	},
	{
		user: 'Where is the entrypoint?',
		assistant: [
			{ kind: 'markdown', text: 'The desktop entrypoint is in `src/vs/code/electron-main/main.ts`. The browser/server entrypoints live under `src/vs/server/`.' },
		],
	},
	{
		user: 'Thanks!',
		assistant: [
			{ kind: 'markdown', text: 'You are welcome — let me know if you have more questions.' },
		],
	},
];

export default defineThemedFixtureGroup({ path: 'chat/widget/' }, {
	SimpleQA: defineComponentFixture({ render: ctx => renderChatWidget(ctx, { messages: SIMPLE_QA }) }),
	Streaming: defineComponentFixture({ labels: { kind: 'animated' }, render: ctx => renderChatWidget(ctx, { messages: STREAMING }) }),
	PendingToolApproval: defineComponentFixture({ render: ctx => renderChatWidget(ctx, { messages: PENDING_TOOL_APPROVAL }) }),
	MultiTurn: defineComponentFixture({ render: ctx => renderChatWidget(ctx, { messages: MULTI_TURN }) }),
});
