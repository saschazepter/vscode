/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { mainWindow } from '../../../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { DisposableStore, DisposableTracker, IDisposable, setDisposableTracker, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { observableValue, constObservable } from '../../../../../../base/common/observable.js';
import { URI } from '../../../../../../base/common/uri.js';
import { mock } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { Range } from '../../../../../../editor/common/core/range.js';
import { OffsetRange } from '../../../../../../editor/common/core/ranges/offsetRange.js';
import { ServiceCollection } from '../../../../../../platform/instantiation/common/serviceCollection.js';
import { ILogService, NullLogService } from '../../../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { MockContextKeyService } from '../../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { TestStorageService, TestExtensionService } from '../../../../../test/common/workbenchTestServices.js';
import { workbenchInstantiationService } from '../../../../../test/browser/workbenchTestServices.js';
import { IExtensionService } from '../../../../../services/extensions/common/extensions.js';
import { IViewDescriptorService } from '../../../../../common/views.js';
import { IChatWidgetHistoryService } from '../../../common/widget/chatWidgetHistoryService.js';
import { ILanguageModelsService } from '../../../common/languageModels.js';
import { IChatContextService } from '../../../browser/contextContrib/chatContextService.js';
import { IChatAttachmentWidgetRegistry } from '../../../browser/attachments/chatAttachmentWidgetRegistry.js';
import { ISharedWebContentExtractorService } from '../../../../../../platform/webContentExtractor/common/webContentExtractor.js';
import { ISCMService } from '../../../../scm/common/scm.js';
import { IUserInteractionService, MockUserInteractionService } from '../../../../../../platform/userInteraction/browser/userInteractionService.js';
import { IAccessibleViewService } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import { IChatMarkdownAnchorService } from '../../../browser/widget/chatContentParts/chatMarkdownAnchorService.js';
import { IChatAgentService } from '../../../common/participants/chatAgents.js';
import { ChatModel } from '../../../common/model/chatModel.js';
import { ChatRequestTextPart } from '../../../common/requestParser/chatParserTypes.js';
import { ElicitationState, IChatContentReference, IChatService, IChatTask, IChatToolInvocation, IChatWarningMessage, ToolConfirmKind, ChatMultiDiffData } from '../../../common/chatService/chatService.js';
import { ChatAgentLocation } from '../../../common/constants.js';
import { ChatToolInvocation } from '../../../common/model/chatProgressTypes/chatToolInvocation.js';
import { ChatElicitationRequestPart } from '../../../common/model/chatProgressTypes/chatElicitationRequestPart.js';
import { MockChatService } from '../../common/chatService/mockChatService.js';
import { IChatEditingService } from '../../../common/editing/chatEditingService.js';
import { IChatSlashCommandService } from '../../../common/participants/chatSlashCommands.js';
import { IChatAccessibilityService } from '../../../browser/chat.js';
import { IChatLayoutService } from '../../../common/widget/chatLayoutService.js';
import { IChatModeService } from '../../../common/chatModes.js';
import { MockChatModeService } from '../../common/mockChatModeService.js';
import { IChatSessionsService } from '../../../common/chatSessionsService.js';
import { MockChatSessionsService } from '../../common/mockChatSessionsService.js';
import { IAgentSessionsService } from '../../../browser/agentSessions/agentSessionsService.js';
import { IAgentSessionsModel } from '../../../browser/agentSessions/agentSessionsModel.js';
import { IChatTodoListService } from '../../../common/tools/chatTodoListService.js';
import { IChatAttachmentResolveService } from '../../../browser/attachments/chatAttachmentResolveService.js';
import { IChatTipService } from '../../../browser/chatTipService.js';
import { IChatDebugService } from '../../../common/chatDebugService.js';
import { ChatDebugServiceImpl } from '../../../common/chatDebugServiceImpl.js';
import { IPromptsService } from '../../../common/promptSyntax/service/promptsService.js';
import { MockPromptsService } from '../../common/promptSyntax/service/mockPromptsService.js';
import { ILanguageModelToolsService, ToolDataSource } from '../../../common/tools/languageModelToolsService.js';
import { ChatWidget, IChatWidgetStyles } from '../../../browser/widget/chatWidget.js';
import { ChatInputBoxContentProvider } from '../../../browser/widget/input/editor/chatEditorInputContentProvider.js';
import { ChatCodeBlockContentProvider } from '../../../browser/widget/chatContentParts/codeBlockPart.js';
import { TestInstantiationService } from '../../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { ITerminalService, ITerminalChatService, ITerminalEditorService, ITerminalGroupService } from '../../../../terminal/browser/terminal.js';
import { IAiEditTelemetryService } from '../../../../editTelemetry/browser/telemetry/aiEditTelemetry/aiEditTelemetryService.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import type { IManagedHoverContent, IManagedHoverOptions } from '../../../../../../base/browser/ui/hover/hover.js';

function createChatServiceCollection(disposables: DisposableStore): ServiceCollection {
	const collection = new ServiceCollection();
	collection.set(ILogService, new NullLogService());
	collection.set(IStorageService, disposables.add(new TestStorageService()));
	collection.set(IExtensionService, new TestExtensionService());
	const configService = new TestConfigurationService();
	configService.setUserConfiguration('chat', {
		editor: {
			fontSize: 13,
			fontFamily: 'default',
			fontWeight: 'normal',
			lineHeight: 0,
			wordWrap: 'on',
		},
		agent: {
			thinking: {
				collapsedTools: 'off',
			},
		},
	});
	configService.setUserConfiguration('editor', {
		fontSize: 13,
		fontFamily: 'Consolas',
		fontLigatures: false,
		accessibilitySupport: 'auto',
		bracketPairColorization: {
			enabled: true,
			independentColorPoolPerBracketType: false,
		},
	});
	collection.set(IConfigurationService, configService);
	collection.set(IContextKeyService, disposables.add(new MockContextKeyService()));
	collection.set(IChatService, new MockChatService());
	collection.set(IChatAgentService, new class extends mock<IChatAgentService>() {
		override readonly onDidChangeAgents = Event.None;
		override getAgents() { return []; }
		override getDefaultAgent() { return undefined; }
		override getActivatedAgents() { return []; }
		override getAgent(_id: string) { return undefined; }
	}());
	collection.set(IChatSlashCommandService, new class extends mock<IChatSlashCommandService>() {
		override readonly onDidChangeCommands = Event.None;
		override getCommands() { return []; }
	}());
	collection.set(IChatAccessibilityService, new class extends mock<IChatAccessibilityService>() {
		override acceptRequest() { }
		override acceptResponse() { }
		override disposeRequest() { }
		override acceptElicitation() { }
	}());
	collection.set(IChatEditingService, new class extends mock<IChatEditingService>() {
		override getEditingSession() { return undefined; }
		override readonly editingSessionsObs = constObservable([]);
	}());
	collection.set(IViewDescriptorService, new class extends mock<IViewDescriptorService>() {
		override readonly onDidChangeLocation = Event.None;
		override readonly onDidChangeContainer = Event.None;
		override getViewLocationById() { return null; }
	}());
	collection.set(IChatLayoutService, {
		_serviceBrand: undefined,
		fontFamily: observableValue('fontFamily', null),
		fontSize: observableValue('fontSize', 13),
	});
	collection.set(IChatModeService, new MockChatModeService());
	collection.set(IChatSessionsService, new MockChatSessionsService());
	collection.set(IAgentSessionsService, new class extends mock<IAgentSessionsService>() {
		override readonly onDidChangeSessionArchivedState = Event.None;
		override getSession() { return undefined; }
		override readonly model: IAgentSessionsModel = {
			onWillResolve: Event.None,
			onDidResolve: Event.None,
			onDidChangeSessions: Event.None,
			onDidChangeSessionArchivedState: Event.None,
			resolved: true,
			sessions: [],
			getSession() { return undefined; },
			resolve: () => Promise.resolve(),
		};
	}());
	collection.set(IChatTodoListService, new class extends mock<IChatTodoListService>() {
		override readonly onDidUpdateTodos = Event.None;
		override getTodos() { return []; }
	}());
	collection.set(IChatAttachmentResolveService, new class extends mock<IChatAttachmentResolveService>() {
	}());
	collection.set(IChatTipService, new class extends mock<IChatTipService>() {
		override readonly onDidDismissTip = Event.None;
		override readonly onDidNavigateTip = Event.None;
		override readonly onDidHideTip = Event.None;
		override readonly onDidDisableTips = Event.None;
		override getWelcomeTip() { return undefined; }
		override resetSession() { }
		override dismissTip() { }
		override dismissTipForSession() { }
	}());
	collection.set(IChatDebugService, disposables.add(new ChatDebugServiceImpl()));
	collection.set(IPromptsService, new MockPromptsService());
	collection.set(ILanguageModelToolsService, new class extends mock<ILanguageModelToolsService>() {
		override readonly onDidChangeTools = Event.None;
		override getTools() { return []; }
		override getTool() { return undefined; }
		override observeTools() { return constObservable([]); }
		override readonly toolSets = constObservable([]);
		override getToolSetsForModel() { return []; }
	}());
	collection.set(IChatWidgetHistoryService, new class extends mock<IChatWidgetHistoryService>() {
		override readonly onDidChangeHistory = Event.None;
		override getHistory() { return []; }
		override clearHistory() { }
		override append() { }
	}());
	collection.set(ILanguageModelsService, new class extends mock<ILanguageModelsService>() {
		override readonly onDidChangeLanguageModels = Event.None;
		override readonly onDidChangeLanguageModelVendors = Event.None;
		override getLanguageModelIds() { return []; }
		override getVendors() { return []; }
	}());
	collection.set(IChatContextService, new class extends mock<IChatContextService>() {
	}());
	collection.set(IChatAttachmentWidgetRegistry, new class extends mock<IChatAttachmentWidgetRegistry>() {
	}());
	collection.set(ISharedWebContentExtractorService, new class extends mock<ISharedWebContentExtractorService>() {
	}());
	collection.set(ISCMService, new class extends mock<ISCMService>() {
		override readonly onDidAddRepository = Event.None;
		override readonly onDidRemoveRepository = Event.None;
		override readonly repositories: never[] = [];
	}());
	collection.set(IUserInteractionService, new MockUserInteractionService());
	collection.set(IAccessibleViewService, new class extends mock<IAccessibleViewService>() {
		override getOpenAriaHint() { return ''; }
	}());
	collection.set(IChatMarkdownAnchorService, new class extends mock<IChatMarkdownAnchorService>() {
		override register() { return toDisposable(() => { }); }
	}());
	collection.set(ITerminalService, new class extends mock<ITerminalService>() {
		override readonly whenConnected = Promise.resolve();
		override readonly onDidChangeInstances = Event.None;
		override readonly instances: never[] = [];
	}());
	collection.set(ITerminalChatService, new class extends mock<ITerminalChatService>() {
		override readonly onDidRegisterTerminalInstanceWithToolSession = Event.None;
		override readonly onDidContinueInBackground = Event.None;
		override getTerminalInstanceByToolSessionId() { return Promise.resolve(undefined); }
		override getToolSessionTerminalInstances() { return []; }
		override registerProgressPart() { return toDisposable(() => { }); }
		override isBackgroundTerminal() { return false; }
		override setFocusedProgressPart() { }
		override clearFocusedProgressPart() { }
		override getFocusedProgressPart() { return undefined; }
		override getMostRecentProgressPart() { return undefined; }
	}());
	collection.set(ITerminalEditorService, new class extends mock<ITerminalEditorService>() {
		override readonly onDidChangeInstances = Event.None;
		override readonly instances: never[] = [];
	}());
	collection.set(ITerminalGroupService, new class extends mock<ITerminalGroupService>() {
		override readonly onDidChangeInstances = Event.None;
		override readonly instances: never[] = [];
	}());
	collection.set(IAiEditTelemetryService, {
		_serviceBrand: undefined,
		createSuggestionId: () => undefined!,
		handleCodeAccepted: () => { },
	});
	// Override NullHoverService with a version that returns tracked disposables
	// so the leak checker can detect if callers forget to dispose hover registrations.
	collection.set(IHoverService, {
		_serviceBrand: undefined,
		hideHover: () => undefined,
		showInstantHover: () => undefined,
		showDelayedHover: () => undefined,
		setupDelayedHover: () => toDisposable(() => { }),
		setupDelayedHoverAtMouse: () => toDisposable(() => { }),
		setupManagedHover: () => {
			const disposable = toDisposable(() => { });
			return Object.assign(disposable, {
				show: (_focus?: boolean) => { },
				hide: () => { },
				update: (_tooltip: IManagedHoverContent, _options?: IManagedHoverOptions) => { },
			});
		},
		showAndFocusLastHover: () => undefined,
		showManagedHover: () => undefined,
	} satisfies IHoverService);
	return collection;
}

function setupChatWidgetEnvironment(disposables: DisposableStore): { instantiationService: TestInstantiationService; parentElement: HTMLElement } {
	// Clear contribs to avoid external dependencies
	const savedContribs = [...ChatWidget.CONTRIBS];
	ChatWidget.CONTRIBS.length = 0;
	disposables.add(toDisposable(() => {
		ChatWidget.CONTRIBS.length = 0;
		ChatWidget.CONTRIBS.push(...savedContribs);
	}));

	const parentElement = mainWindow.document.createElement('div');
	parentElement.style.width = '800px';
	parentElement.style.height = '600px';
	mainWindow.document.body.appendChild(parentElement);
	disposables.add(toDisposable(() => parentElement.remove()));

	const collection = createChatServiceCollection(disposables);
	const base = disposables.add(workbenchInstantiationService(undefined, disposables));
	const instantiationService = disposables.add(base.createChild(collection));

	// Register the chat input text model content provider so chatSessionInput: URIs can be resolved
	disposables.add(instantiationService.createInstance(ChatInputBoxContentProvider));
	// Register the code block content provider so vscodeChatCodeBlock: URIs can be resolved
	disposables.add(instantiationService.createInstance(ChatCodeBlockContentProvider));

	return { instantiationService, parentElement };
}

suite('ChatWidget Disposal', function () {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let disposables: DisposableStore;
	let instantiationService: TestInstantiationService;
	let parentElement: HTMLElement;

	async function flushMicrotasks() {
		// Flush microtask queue multiple rounds to allow nested async
		// chains to settle (e.g. TextModelResolverService.destroyReferencedObject).
		// Mix in a macrotask (setTimeout 0) for platforms where chained
		// awaits schedule through the macrotask queue (WebKit browser).
		for (let i = 0; i < 20; i++) {
			await new Promise<void>(r => queueMicrotask(r));
		}
		await new Promise<void>(r => setTimeout(r, 0));
		for (let i = 0; i < 20; i++) {
			await new Promise<void>(r => queueMicrotask(r));
		}
	}

	const styles: IChatWidgetStyles = {
		overlayBackground: '#000000',
		listForeground: '#ffffff',
		listBackground: '#000000',
		inputEditorBackground: '#000000',
		resultEditorBackground: '#000000',
	};

	function createParsedRequest(text: string) {
		return {
			text,
			parts: [new ChatRequestTextPart(new OffsetRange(0, text.length), new Range(1, 1, 1, text.length + 1), text)]
		};
	}

	function createToolInvocation(opts: {
		toolId: string;
		toolCallId: string;
		state?: 'streaming' | 'completed' | 'cancelled';
		terminalData?: { exitCode: number; commandLine: string };
		subagentData?: { agentName: string };
	}): ChatToolInvocation {
		const toolData = {
			id: opts.toolId,
			displayName: `Tool ${opts.toolId}`,
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: false,
			userDescription: '',
			modelDescription: '',
			tags: [],
		};
		const invocation = ChatToolInvocation.createStreaming({
			toolCallId: opts.toolCallId,
			toolId: opts.toolId,
			toolData,
		});

		if (opts.terminalData) {
			invocation.toolSpecificData = {
				kind: 'terminal',
				commandLine: { original: opts.terminalData.commandLine },
				language: 'bash',
			};
		}

		if (opts.subagentData) {
			invocation.toolSpecificData = {
				kind: 'subagent',
				agentName: opts.subagentData.agentName,
				description: 'A subagent',
			};
		}

		if (opts.state === 'completed') {
			invocation.transitionFromStreaming(undefined, {}, { type: ToolConfirmKind.ConfirmationNotNeeded });
			invocation.didExecuteTool({ content: [], toolResultMessage: 'Done' });
		} else if (opts.state === 'cancelled') {
			invocation.cancelFromStreaming(ToolConfirmKind.Denied, 'User denied');
		}

		return invocation;
	}

	function createProgressTask(content: string, settled: boolean): IChatTask {
		const deferred = new DeferredPromise<string | void>();
		const emitter = disposables.add(new Emitter<IChatWarningMessage | IChatContentReference>());

		const task: IChatTask = {
			content: new MarkdownString(content),
			kind: 'progressTask',
			deferred,
			progress: [],
			onDidAddProgress: emitter.event,
			add(progress) {
				task.progress.push(progress);
				emitter.fire(progress);
			},
			complete(result) {
				deferred.complete(result ?? undefined);
			},
			task: () => deferred.p,
			isSettled: () => deferred.isSettled,
			toJSON: () => ({
				content: task.content,
				progress: task.progress,
				kind: 'progressTaskSerialized' as const,
			}),
		};

		if (settled) {
			deferred.complete(content);
		}

		return task;
	}

	function createCompletedModel(maxTurns = 4): ChatModel {
		const model = disposables.add(instantiationService.createInstance(
			ChatModel,
			undefined,
			{ initialLocation: ChatAgentLocation.Chat, canUseTools: true }
		));

		// --- Turn 1: Markdown with fenced code blocks ---
		const req1 = model.addRequest(
			createParsedRequest('Hello, can you help me?'),
			{ variables: [] },
			0,
		);
		model.acceptResponseProgress(req1, {
			kind: 'markdownContent',
			content: new MarkdownString('Sure, I can help!\n\n```typescript\nconsole.log("hello");\n```'),
		});
		req1.response!.setResult({});
		req1.response!.complete();

		if (maxTurns <= 1) { return model; }

		// --- Turn 2: Thinking + tool calls + terminal + subagent ---
		const req2 = model.addRequest(
			createParsedRequest('Fix the bug in my code'),
			{ variables: [] },
			0,
		);

		// Thinking that will be grouped (consecutive)
		model.acceptResponseProgress(req2, {
			kind: 'thinking',
			value: 'Let me analyze the code...',
			id: 'thinking-1',
		});
		model.acceptResponseProgress(req2, {
			kind: 'thinking',
			value: ' I see the issue is in the parser.',
			id: 'thinking-1',
		});

		// Markdown between thinking blocks
		model.acceptResponseProgress(req2, {
			kind: 'markdownContent',
			content: new MarkdownString('I found the issue.'),
		});

		// Separate thinking block (ungrouped from the first)
		model.acceptResponseProgress(req2, {
			kind: 'thinking',
			value: '',  // Empty value creates a new block
		});
		model.acceptResponseProgress(req2, {
			kind: 'thinking',
			value: 'Now let me think about the fix...',
			id: 'thinking-2',
		});

		// Completed tool invocation (read file)
		const readFileTool = createToolInvocation({
			toolId: 'readFile',
			toolCallId: 'call-1',
			state: 'completed',
		});
		model.acceptResponseProgress(req2, readFileTool);

		// Terminal tool - success
		const terminalToolSuccess = createToolInvocation({
			toolId: 'runTerminalCommand',
			toolCallId: 'call-2',
			terminalData: { exitCode: 0, commandLine: 'npm test' },
			state: 'completed',
		});
		model.acceptResponseProgress(req2, terminalToolSuccess);

		// Terminal tool - failure
		const terminalToolFail = createToolInvocation({
			toolId: 'runTerminalCommand',
			toolCallId: 'call-3',
			terminalData: { exitCode: 1, commandLine: 'npm run build' },
			state: 'completed',
		});
		model.acceptResponseProgress(req2, terminalToolFail);

		// Subagent tool
		const subagentTool = createToolInvocation({
			toolId: 'subagent',
			toolCallId: 'call-4',
			subagentData: { agentName: 'code-reviewer' },
			state: 'completed',
		});
		model.acceptResponseProgress(req2, subagentTool);

		// Cancelled/denied tool
		const deniedTool = createToolInvocation({
			toolId: 'deleteFile',
			toolCallId: 'call-5',
			state: 'cancelled',
		});
		model.acceptResponseProgress(req2, deniedTool);

		// Note: textEdit is omitted because ICodeCompareModelService is a private (non-exported) singleton
		// that can't be mocked. It needs real text model resolution to render without error.

		// Workspace edits
		model.acceptResponseProgress(req2, {
			kind: 'workspaceEdit',
			edits: [{
				oldResource: undefined,
				newResource: URI.file('/test/newFile.ts'),
			}],
		});

		// Confirmation
		model.acceptResponseProgress(req2, {
			kind: 'confirmation',
			title: 'Apply changes?',
			message: new MarkdownString('Do you want to apply these changes?'),
			data: { fileCount: 3 },
			buttons: ['Yes', 'No'],
			isUsed: true,
		});

		// Warning message
		model.acceptResponseProgress(req2, {
			kind: 'warning',
			content: new MarkdownString('⚠️ This might break things'),
		});

		// Progress message
		model.acceptResponseProgress(req2, {
			kind: 'progressMessage',
			content: new MarkdownString('Building project...'),
		});

		// Command button
		model.acceptResponseProgress(req2, {
			kind: 'command',
			command: { id: 'workbench.action.openFile', title: 'Open File' },
		});

		// Code block with codemapper edit URI — triggers the CollapsedCodeBlock pill path
		model.acceptResponseProgress(req2, {
			kind: 'markdownContent',
			content: new MarkdownString('Edited file:\n\n```typescript\n<vscode_codeblock_uri isEdit>file:///test/edited-file.ts</vscode_codeblock_uri>const fixed = true;\n```'),
		});

		// Final markdown
		model.acceptResponseProgress(req2, {
			kind: 'markdownContent',
			content: new MarkdownString('All done! The bug has been fixed.'),
		});

		req2.response!.setResult({});
		req2.response!.complete();

		if (maxTurns <= 2) { return model; }

		// --- Turn 3: Elicitation ---
		const req3 = model.addRequest(
			createParsedRequest('Configure the project'),
			{ variables: [] },
			0,
		);

		const elicitation = new ChatElicitationRequestPart(
			'Choose configuration',
			new MarkdownString('Select your preferred framework'),
			'Project setup',
			'Accept',
			'Cancel',
			async () => ElicitationState.Accepted,
			async () => ElicitationState.Rejected,
		);
		model.acceptResponseProgress(req3, elicitation);
		model.acceptResponseProgress(req3, {
			kind: 'markdownContent',
			content: new MarkdownString('Configuration applied.'),
		});
		req3.response!.setResult({});
		req3.response!.complete();

		if (maxTurns <= 3) { return model; }

		// --- Turn 4: Remaining content types ---
		const req4 = model.addRequest(
			createParsedRequest('Show me everything else'),
			{ variables: [] },
			0,
		);

		// Tree data
		model.acceptResponseProgress(req4, {
			kind: 'treeData',
			treeData: {
				label: 'project-root',
				uri: URI.file('/test/project'),
				children: [
					{
						label: 'src', uri: URI.file('/test/project/src'), children: [
							{ label: 'index.ts', uri: URI.file('/test/project/src/index.ts'), children: [] },
						]
					},
					{ label: 'package.json', uri: URI.file('/test/project/package.json'), children: [] },
				],
			},
		});

		// Multi-diff data (HIGH leak risk: observables, toolbar, lists)
		model.acceptResponseProgress(req4, new ChatMultiDiffData({
			multiDiffData: {
				title: 'Code Review Changes',
				resources: [
					{
						originalUri: URI.file('/test/original.ts'),
						modifiedUri: URI.file('/test/modified.ts'),
						added: 10,
						removed: 3,
					},
					{
						modifiedUri: URI.file('/test/new-file.ts'),
						added: 25,
					},
				],
			},
		}));

		// Hook (pre-tool-use)
		model.acceptResponseProgress(req4, {
			kind: 'hook',
			hookType: 'PreToolUse',
			toolDisplayName: 'runTerminalCommand',
			systemMessage: 'Hook approved the tool invocation',
		});

		// Hook (with stop reason)
		model.acceptResponseProgress(req4, {
			kind: 'hook',
			hookType: 'PostToolUse',
			stopReason: 'Hook blocked this action',
			toolDisplayName: 'deleteFile',
		});

		// Pull request content
		model.acceptResponseProgress(req4, {
			kind: 'pullRequest',
			title: 'Fix parser bug',
			description: 'Fixes the off-by-one error in the parser',
			author: 'testuser',
			linkTag: '#42',
			command: { id: 'vscode.open', title: 'Open PR' },
		});

		// Note: 'extensions' omitted — ChatExtensionsContentPart needs IExtensionsWorkbenchService.local which is complex to mock

		// Question carousel
		model.acceptResponseProgress(req4, {
			kind: 'questionCarousel',
			questions: [
				{
					id: 'q1', type: 'singleSelect', title: 'Which framework?', options: [
						{ id: 'react', label: 'React', value: 'react' },
						{ id: 'vue', label: 'Vue', value: 'vue' },
					]
				},
				{ id: 'q2', type: 'text', title: 'Project name' },
			],
			allowSkip: true,
			message: 'Please answer these questions:',
		});

		// Codeblock URI
		model.acceptResponseProgress(req4, {
			kind: 'codeblockUri',
			uri: URI.file('/test/generated-code.ts'),
		});

		// Inline reference (turns into an inlineReference part)
		model.acceptResponseProgress(req4, {
			kind: 'inlineReference',
			inlineReference: URI.file('/test/referenced-file.ts'),
			name: 'referenced-file.ts',
		});

		// Content references (will be aggregated into 'references' by the renderer)
		model.acceptResponseProgress(req4, {
			kind: 'reference',
			reference: { variableName: 'file', value: URI.file('/test/context-file.ts') },
		});

		// Code citation (will be aggregated into 'codeCitations' by the renderer)
		model.acceptResponseProgress(req4, {
			kind: 'codeCitation',
			value: URI.parse('https://github.com/example/repo'),
			license: 'MIT',
			snippet: 'function example() {}',
		});

		// MCP servers starting (serialized form — no observable state)
		model.acceptResponseProgress(req4, {
			kind: 'mcpServersStarting',
			state: undefined,
			didStartServerIds: ['mcp-server-1', 'mcp-server-2'],
		});

		// Disabled Claude hooks
		model.acceptResponseProgress(req4, {
			kind: 'disabledClaudeHooks',
		});

		// Undo stop
		model.acceptResponseProgress(req4, {
			kind: 'undoStop',
			id: 'undo-stop-1',
		});

		// Progress task (settled)
		model.acceptResponseProgress(req4, createProgressTask('Installing dependencies...', true));

		// Final markdown
		model.acceptResponseProgress(req4, {
			kind: 'markdownContent',
			content: new MarkdownString('Everything rendered.'),
		});

		// Set result with error details (the renderer computes errorDetails from the result)
		req4.response!.setResult({
			errorDetails: {
				message: 'Rate limit exceeded',
			},
		});
		req4.response!.complete();

		return model;
	}

	setup(() => {
		disposables = store.add(new DisposableStore());

		// Suppress benign ResizeObserver loop errors that fire during macrotask
		// flushing after widget disposal (needed for the setTimeout flush below).
		const origOnError = mainWindow.onerror;
		mainWindow.onerror = function (event, ...rest) {
			if (typeof event === 'string' && event.includes('ResizeObserver')) {
				return true;
			}
			return origOnError?.call(this, event, ...rest);
		};
		disposables.add(toDisposable(() => { mainWindow.onerror = origOnError; }));

		const env = setupChatWidgetEnvironment(disposables);
		instantiationService = env.instantiationService;
		parentElement = env.parentElement;
	});

	test('bare widget lifecycle - no model - no leaks', async function () {
		const widget = disposables.add(
			instantiationService.createInstance(
				ChatWidget,
				ChatAgentLocation.Chat,
				{},
				{},
				styles,
			)
		);

		widget.render(parentElement);
		widget.setVisible(true);
		widget.layout(600, 800);
		await flushMicrotasks();
	});

	test('minimal tool test', async function () {
		const model = disposables.add(instantiationService.createInstance(
			ChatModel,
			undefined,
			{ initialLocation: ChatAgentLocation.Chat, canUseTools: true }
		));
		const req1 = model.addRequest(
			createParsedRequest('test'),
			{ variables: [] },
			0,
		);
		// Add thinking first (triggers collapsed tools mode)
		model.acceptResponseProgress(req1, {
			kind: 'thinking',
			value: 'Analyzing...',
			id: 'think-1',
		});
		// Terminal tool
		const termTool = createToolInvocation({
			toolId: 'runTerminalCommand',
			toolCallId: 'call-1',
			terminalData: { exitCode: 0, commandLine: 'npm test' },
			state: 'completed',
		});
		model.acceptResponseProgress(req1, termTool);
		model.acceptResponseProgress(req1, {
			kind: 'markdownContent',
			content: new MarkdownString('Done'),
		});
		req1.response!.setResult({});
		req1.response!.complete();

		const widget = disposables.add(
			instantiationService.createInstance(ChatWidget, ChatAgentLocation.Chat, {}, {}, styles)
		);
		widget.render(parentElement);
		widget.setVisible(true);
		widget.setModel(model);
		widget.layout(600, 800);
		widget.setModel(undefined);
		model.dispose();
		await flushMicrotasks();
	});

	test('completed session: load, scroll, unload - no leaks', async function () {
		const model = createCompletedModel();
		const widget = disposables.add(
			instantiationService.createInstance(
				ChatWidget,
				ChatAgentLocation.Chat,
				{},
				{},
				styles,
			)
		);

		widget.render(parentElement);
		widget.setVisible(true);
		widget.setModel(model);
		widget.layout(600, 800);

		// Unload the model
		widget.setModel(undefined);

		// Dispose the model and widget - leak check happens via ensureNoDisposablesAreLeakedInTestSuite
		model.dispose();
		await flushMicrotasks();
	});

	test('progressive session: stream content, confirm/deny tools, then complete - no leaks', async function () {
		const model = disposables.add(instantiationService.createInstance(
			ChatModel,
			undefined,
			{ initialLocation: ChatAgentLocation.Chat, canUseTools: true }
		));

		const widget = disposables.add(
			instantiationService.createInstance(
				ChatWidget,
				ChatAgentLocation.Chat,
				{},
				{},
				styles,
			)
		);

		widget.render(parentElement);
		widget.setVisible(true);
		widget.setModel(model);
		widget.layout(600, 800);

		// --- Progressively add content ---

		// Add request and start streaming response
		const req = model.addRequest(
			createParsedRequest('Fix all the tests'),
			{ variables: [] },
			0,
		);

		// Stream thinking
		model.acceptResponseProgress(req, {
			kind: 'thinking',
			value: 'Let me analyze...',
			id: 'think-1',
		});

		model.acceptResponseProgress(req, {
			kind: 'thinking',
			value: ' the failing tests.',
			id: 'think-1',
		});

		// Stream markdown
		model.acceptResponseProgress(req, {
			kind: 'markdownContent',
			content: new MarkdownString('I found several issues:\n\n```typescript\nconst x = 1;\nconsole.log(x);\n```'),
		});

		// Code block with codemapper edit URI — triggers the CollapsedCodeBlock pill path
		model.acceptResponseProgress(req, {
			kind: 'markdownContent',
			content: new MarkdownString('Editing file:\n\n```typescript\n<vscode_codeblock_uri isEdit>file:///test/fix.ts</vscode_codeblock_uri>const y = 2;\n```'),
		});

		// Tool invocation that needs confirmation - accept it
		const toolNeedingConfirm = new ChatToolInvocation(
			{
				invocationMessage: 'Edit file.ts',
				pastTenseMessage: 'Edited file.ts',
				confirmationMessages: { title: 'Edit file?', message: new MarkdownString('Allow editing file.ts?') },
			},
			{
				id: 'editFile',
				displayName: 'Edit File',
				source: ToolDataSource.Internal,
				canBeReferencedInPrompt: false,
				userDescription: '',
				modelDescription: '',
				tags: [],
			},
			'call-confirm-1',
			undefined,
			{ path: '/test/file.ts' },
		);
		model.acceptResponseProgress(req, toolNeedingConfirm);

		// Accept the tool confirmation
		const confirmState = toolNeedingConfirm.state.get();
		if (confirmState.type === IChatToolInvocation.StateKind.WaitingForConfirmation) {
			confirmState.confirm({ type: ToolConfirmKind.UserAction });
		}

		// Complete the tool (async — returns a promise)
		await toolNeedingConfirm.didExecuteTool({ content: [], toolResultMessage: 'File edited' });

		// Another tool invocation that is denied
		const toolToDeny = new ChatToolInvocation(
			{
				invocationMessage: 'Delete file.ts',
				pastTenseMessage: 'Deleted file.ts',
				confirmationMessages: { title: 'Delete file?', message: new MarkdownString('Allow deleting file.ts?') },
			},
			{
				id: 'deleteFile',
				displayName: 'Delete File',
				source: ToolDataSource.Internal,
				canBeReferencedInPrompt: false,
				userDescription: '',
				modelDescription: '',
				tags: [],
			},
			'call-deny-1',
			undefined,
			{ path: '/test/file.ts' },
		);
		model.acceptResponseProgress(req, toolToDeny);

		// Deny the tool
		const denyState = toolToDeny.state.get();
		if (denyState.type === IChatToolInvocation.StateKind.WaitingForConfirmation) {
			denyState.confirm({ type: ToolConfirmKind.Denied });
		}

		// Terminal tool that streams and completes
		const termTool = createToolInvocation({
			toolId: 'runTerminalCommand',
			toolCallId: 'call-term-1',
			terminalData: { exitCode: 0, commandLine: 'npm test -- --grep "parser"' },
		});
		termTool.transitionFromStreaming(
			{
				invocationMessage: 'Running tests',
				pastTenseMessage: 'Tests passed',
			},
			{ command: 'npm test' },
			{ type: ToolConfirmKind.ConfirmationNotNeeded },
		);
		model.acceptResponseProgress(req, termTool);

		await termTool.didExecuteTool({ content: [], toolResultMessage: 'All tests passed' });

		// Subagent tool
		const subagentTool = createToolInvocation({
			toolId: 'subagent',
			toolCallId: 'call-sub-1',
			subagentData: { agentName: 'code-reviewer' },
		});
		subagentTool.transitionFromStreaming(
			{
				invocationMessage: 'Reviewing code',
				pastTenseMessage: 'Code reviewed',
			},
			{},
			{ type: ToolConfirmKind.ConfirmationNotNeeded },
		);
		model.acceptResponseProgress(req, subagentTool);

		await subagentTool.didExecuteTool({ content: [], toolResultMessage: 'Review complete' });

		// Elicitation - accepted (async — accept returns a promise)
		const elicitation = new ChatElicitationRequestPart(
			'Choose test runner',
			new MarkdownString('Which test runner?'),
			'Setup',
			'Use Jest',
			'Cancel',
			async () => ElicitationState.Accepted,
			async () => ElicitationState.Rejected,
		);
		model.acceptResponseProgress(req, elicitation);

		await elicitation.accept(true);

		// Note: textEdit is omitted because ICodeCompareModelService is a private (non-exported) singleton
		// that can't be mocked. It needs real text model resolution to render without error.

		// Progressively stream workspace edit
		model.acceptResponseProgress(req, {
			kind: 'workspaceEdit',
			edits: [{
				oldResource: undefined,
				newResource: URI.file('/test/new-component.ts'),
			}],
		});

		// Tree data (HIGH leak risk: tree pooling, event listeners)
		model.acceptResponseProgress(req, {
			kind: 'treeData',
			treeData: {
				label: 'output',
				uri: URI.file('/test/output'),
				children: [
					{ label: 'bundle.js', uri: URI.file('/test/output/bundle.js'), children: [] },
				],
			},
		});

		// Multi-diff data (HIGH leak risk: observables, toolbar, lists)
		model.acceptResponseProgress(req, new ChatMultiDiffData({
			multiDiffData: {
				title: 'Streaming Changes',
				resources: [
					{
						originalUri: URI.file('/test/old.ts'),
						modifiedUri: URI.file('/test/new.ts'),
						added: 5,
						removed: 2,
					},
				],
			},
		}));

		// Question carousel (CRITICAL leak risk: 9 registrations, 6 DisposableStores)
		model.acceptResponseProgress(req, {
			kind: 'questionCarousel',
			questions: [
				{
					id: 'pq1', type: 'singleSelect', title: 'Continue?', options: [
						{ id: 'yes', label: 'Yes', value: 'yes' },
						{ id: 'no', label: 'No', value: 'no' },
					]
				},
			],
			allowSkip: true,
		});

		// Hook part
		model.acceptResponseProgress(req, {
			kind: 'hook',
			hookType: 'PreToolUse',
			toolDisplayName: 'editFile',
		});

		// Progress task - start unsettled, then complete it
		const progressTask = createProgressTask('Building project...', false);
		model.acceptResponseProgress(req, progressTask);

		// Add progress to the task
		progressTask.add({ kind: 'warning', content: new MarkdownString('Deprecation warning in parser.ts') });

		// Complete the task — flush the microtask from the .then() callback in ChatModel
		progressTask.complete('Build complete');
		await Promise.resolve();

		// Separate thinking block (ungrouped)
		model.acceptResponseProgress(req, {
			kind: 'thinking',
			value: '',
		});
		model.acceptResponseProgress(req, {
			kind: 'thinking',
			value: 'All tests should pass now.',
			id: 'think-2',
		});

		// More markdown
		model.acceptResponseProgress(req, {
			kind: 'markdownContent',
			content: new MarkdownString('\n\nAll tests have been fixed and are passing.'),
		});

		// Complete the response
		req.response!.setResult({});
		req.response!.complete();

		// Scroll to check rendering
		widget.scrollTop = 200;

		// Unload and dispose
		widget.setModel(undefined);
		await flushMicrotasks();
	});

	test('switch between models - no leaks', async function () {
		const model1 = createCompletedModel(1);
		const model2 = createCompletedModel(1);

		const widget = disposables.add(
			instantiationService.createInstance(ChatWidget, ChatAgentLocation.Chat, {}, {}, styles)
		);
		widget.render(parentElement);
		widget.setVisible(true);

		// Load first model
		widget.setModel(model1);
		widget.layout(600, 800);

		// Flush so createModelReference promises from model1's code blocks resolve
		await flushMicrotasks();

		// Switch to second model
		widget.setModel(model2);
		widget.layout(600, 800);

		// Flush so createModelReference promises from model2's code blocks resolve
		// AND so destroyReferencedObject for model1's code blocks complete
		await flushMicrotasks();

		// Unload
		widget.setModel(undefined);
		await flushMicrotasks();
	});
});

// This suite manages its own DisposableTracker for set-diff leak detection:
// eslint-disable-next-line local/code-ensure-no-disposables-leak-in-test
suite('ChatWidget Rendering Leak Detection', function () {
	// This suite tests the more realistic scenario: the widget stays alive,
	// but content is loaded and unloaded. Any disposables created by rendering
	// that survive model unload are real-world leaks.

	let tracker: DisposableTracker;
	let disposables: DisposableStore;
	let instantiationService: TestInstantiationService;
	let parentElement: HTMLElement;

	const styles: IChatWidgetStyles = {
		overlayBackground: '#000000',
		listForeground: '#ffffff',
		listBackground: '#000000',
		inputEditorBackground: '#000000',
		resultEditorBackground: '#000000',
	};

	function createParsedRequest(text: string) {
		return {
			text,
			parts: [new ChatRequestTextPart(new OffsetRange(0, text.length), new Range(1, 1, 1, text.length + 1), text)]
		};
	}

	function createToolInvocation(opts: {
		toolId: string;
		toolCallId: string;
		state?: 'streaming' | 'completed' | 'cancelled';
		terminalData?: { exitCode: number; commandLine: string };
		subagentData?: { agentName: string };
	}): ChatToolInvocation {
		const toolData = {
			id: opts.toolId,
			displayName: `Tool ${opts.toolId}`,
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: false,
			userDescription: '',
			modelDescription: '',
			tags: [],
		};
		const invocation = ChatToolInvocation.createStreaming({
			toolCallId: opts.toolCallId,
			toolId: opts.toolId,
			toolData,
		});
		if (opts.terminalData) {
			invocation.toolSpecificData = {
				kind: 'terminal',
				commandLine: { original: opts.terminalData.commandLine },
				language: 'bash',
			};
		}
		if (opts.subagentData) {
			invocation.toolSpecificData = {
				kind: 'subagent',
				agentName: opts.subagentData.agentName,
				description: 'A subagent',
			};
		}
		if (opts.state === 'completed') {
			invocation.transitionFromStreaming(undefined, {}, { type: ToolConfirmKind.ConfirmationNotNeeded });
			invocation.didExecuteTool({ content: [], toolResultMessage: 'Done' });
		} else if (opts.state === 'cancelled') {
			invocation.cancelFromStreaming(ToolConfirmKind.Denied, 'User denied');
		}
		return invocation;
	}

	function createCompletedModel(): ChatModel {
		const model = instantiationService.createInstance(
			ChatModel,
			undefined,
			{ initialLocation: ChatAgentLocation.Chat, canUseTools: true }
		);

		// Turn 1: Markdown with fenced code blocks
		const req1 = model.addRequest(createParsedRequest('Hello'), { variables: [] }, 0);
		model.acceptResponseProgress(req1, {
			kind: 'markdownContent',
			content: new MarkdownString('Here is a code example:\n\n```typescript\nfunction greet(name: string): string {\n\treturn `Hello, ${name}!`;\n}\n```\n\nAnd another:\n\n```python\ndef greet(name):\n\treturn f"Hello, {name}!"\n```'),
		});
		req1.response!.setResult({});
		req1.response!.complete();

		// Turn 2: Thinking + tools + terminal + subagent + edits + confirmation
		const req2 = model.addRequest(createParsedRequest('Fix the bug'), { variables: [] }, 0);
		model.acceptResponseProgress(req2, { kind: 'thinking', value: 'Analyzing the code...', id: 'thinking-1' });
		model.acceptResponseProgress(req2, { kind: 'thinking', value: ' Found the issue.', id: 'thinking-1' });
		model.acceptResponseProgress(req2, { kind: 'markdownContent', content: new MarkdownString('Found it.') });
		model.acceptResponseProgress(req2, { kind: 'thinking', value: '' });
		model.acceptResponseProgress(req2, { kind: 'thinking', value: 'Planning the fix...', id: 'thinking-2' });
		model.acceptResponseProgress(req2, createToolInvocation({ toolId: 'readFile', toolCallId: 'c1', state: 'completed' }));
		model.acceptResponseProgress(req2, createToolInvocation({ toolId: 'runTerminalCommand', toolCallId: 'c2', terminalData: { exitCode: 0, commandLine: 'npm test' }, state: 'completed' }));
		model.acceptResponseProgress(req2, createToolInvocation({ toolId: 'runTerminalCommand', toolCallId: 'c3', terminalData: { exitCode: 1, commandLine: 'npm run build' }, state: 'completed' }));
		model.acceptResponseProgress(req2, createToolInvocation({ toolId: 'subagent', toolCallId: 'c4', subagentData: { agentName: 'reviewer' }, state: 'completed' }));
		model.acceptResponseProgress(req2, createToolInvocation({ toolId: 'deleteFile', toolCallId: 'c5', state: 'cancelled' }));
		model.acceptResponseProgress(req2, { kind: 'workspaceEdit', edits: [{ oldResource: undefined, newResource: URI.file('/test/newFile.ts') }] });
		model.acceptResponseProgress(req2, { kind: 'confirmation', title: 'Apply changes?', message: new MarkdownString('Confirm?'), data: {}, buttons: ['Yes', 'No'], isUsed: true });
		model.acceptResponseProgress(req2, { kind: 'warning', content: new MarkdownString('⚠️ Warning') });
		model.acceptResponseProgress(req2, { kind: 'progressMessage', content: new MarkdownString('Building...') });
		model.acceptResponseProgress(req2, { kind: 'command', command: { id: 'workbench.action.openFile', title: 'Open File' } });
		// Code block with codemapper edit URI — triggers the CollapsedCodeBlock pill path
		model.acceptResponseProgress(req2, { kind: 'markdownContent', content: new MarkdownString('Edited file:\n\n```typescript\n<vscode_codeblock_uri isEdit>file:///test/edited-file.ts</vscode_codeblock_uri>const fixed = true;\n```') });
		model.acceptResponseProgress(req2, { kind: 'markdownContent', content: new MarkdownString('All done.') });
		req2.response!.setResult({});
		req2.response!.complete();

		// Turn 3: Elicitation
		const req3 = model.addRequest(createParsedRequest('Configure'), { variables: [] }, 0);
		const elicitation = new ChatElicitationRequestPart('Choose', new MarkdownString('Select framework'), 'Setup', 'Accept', 'Cancel', async () => ElicitationState.Accepted, async () => ElicitationState.Rejected);
		model.acceptResponseProgress(req3, elicitation);
		model.acceptResponseProgress(req3, { kind: 'markdownContent', content: new MarkdownString('Done.') });
		req3.response!.setResult({});
		req3.response!.complete();

		// Turn 4: Remaining content types
		const req4 = model.addRequest(createParsedRequest('Show everything'), { variables: [] }, 0);
		model.acceptResponseProgress(req4, { kind: 'treeData', treeData: { label: 'root', uri: URI.file('/test'), children: [{ label: 'child', uri: URI.file('/test/child'), children: [] }] } });
		model.acceptResponseProgress(req4, new ChatMultiDiffData({ multiDiffData: { title: 'Changes', resources: [{ originalUri: URI.file('/a.ts'), modifiedUri: URI.file('/b.ts'), added: 5, removed: 2 }] } }));
		model.acceptResponseProgress(req4, { kind: 'hook', hookType: 'PreToolUse', toolDisplayName: 'runTerminalCommand', systemMessage: 'Approved' });
		model.acceptResponseProgress(req4, { kind: 'hook', hookType: 'PostToolUse', stopReason: 'Blocked', toolDisplayName: 'deleteFile' });
		model.acceptResponseProgress(req4, { kind: 'pullRequest', title: 'Fix bug', description: 'Fixes an issue', author: 'testuser', linkTag: '#42', command: { id: 'vscode.open', title: 'Open PR' } });
		// Note: 'extensions' omitted — ChatExtensionsContentPart needs IExtensionsWorkbenchService.local which is complex to mock
		model.acceptResponseProgress(req4, { kind: 'questionCarousel', questions: [{ id: 'q1', type: 'singleSelect', title: 'Framework?', options: [{ id: 'r', label: 'React', value: 'react' }] }], allowSkip: true, message: 'Choose:' });
		model.acceptResponseProgress(req4, { kind: 'codeblockUri', uri: URI.file('/test/gen.ts') });
		model.acceptResponseProgress(req4, { kind: 'inlineReference', inlineReference: URI.file('/test/ref.ts'), name: 'ref.ts' });
		model.acceptResponseProgress(req4, { kind: 'reference', reference: { variableName: 'file', value: URI.file('/test/ctx.ts') } });
		model.acceptResponseProgress(req4, { kind: 'codeCitation', value: URI.parse('https://github.com/example'), license: 'MIT', snippet: 'fn()' });
		model.acceptResponseProgress(req4, { kind: 'mcpServersStarting', state: undefined, didStartServerIds: ['mcp-1'] });
		model.acceptResponseProgress(req4, { kind: 'disabledClaudeHooks' });
		model.acceptResponseProgress(req4, { kind: 'undoStop', id: 'undo-1' });
		// External tool invocation update — exercises the ChatToolInvocation constructor path (vs createStreaming)
		model.acceptResponseProgress(req4, {
			kind: 'externalToolInvocationUpdate',
			toolCallId: 'ext-1',
			toolName: 'externalLinter',
			isComplete: false,
			invocationMessage: 'Running external linter...',
		});
		model.acceptResponseProgress(req4, {
			kind: 'externalToolInvocationUpdate',
			toolCallId: 'ext-1',
			toolName: 'externalLinter',
			isComplete: true,
			pastTenseMessage: 'Ran external linter',
		});
		model.acceptResponseProgress(req4, { kind: 'markdownContent', content: new MarkdownString('Everything rendered.') });
		req4.response!.setResult({ errorDetails: { message: 'Rate limit exceeded' } });
		req4.response!.complete();

		return model;
	}

	setup(() => {
		disposables = new DisposableStore();
		tracker = new DisposableTracker();
		setDisposableTracker(tracker);
		const env = setupChatWidgetEnvironment(disposables);
		instantiationService = env.instantiationService;
		parentElement = env.parentElement;
	});

	teardown(function (this: import('mocha').Context) {
		disposables.dispose();
		setDisposableTracker(null);
		if (this.currentTest?.state !== 'failed') {
			const result = tracker.computeLeakingDisposables();
			if (result) {
				throw new Error(`There are ${result.leaks.length} undisposed disposables!${result.details}`);
			}
		}
	});

	/**
	 * Flushes pending microtasks (e.g. async tree operations).
	 * Not a delay — just yields to the event loop so Promise chains resolve.
	 */
	async function flushMicrotasks(): Promise<void> {
		for (let i = 0; i < 20; i++) {
			await new Promise<void>(r => queueMicrotask(r));
		}
	}

	/**
	 * Performs a full load/unload cycle with microtask flushing.
	 */
	async function loadUnloadCycle(widget: ChatWidget, model: ChatModel): Promise<void> {
		widget.setModel(model);
		widget.layout(600, 5000);
		await flushMicrotasks();
		widget.setModel(undefined);
		await flushMicrotasks();
	}

	/**
	 * Performs a load/unload cycle and returns disposables created during
	 * the load phase that survived the unload — i.e. rendering artifacts
	 * that were not cleaned up.
	 *
	 * Takes three snapshots (before load, before unload, after unload) to
	 * separate load-phase disposables from unload-phase disposables. Items
	 * created during unload (e.g. welcome view, input state) are expected
	 * and excluded.
	 */
	async function loadUnloadCycleWithCheck(
		widget: ChatWidget,
		model: ChatModel,
	): Promise<IDisposable[]> {
		const beforeLoad = snapshotTracked();

		widget.setModel(model);
		widget.layout(600, 5000);
		await flushMicrotasks();

		// Snapshot just before unloading — captures everything created during load
		const beforeUnload = snapshotTracked();

		widget.setModel(undefined);
		await flushMicrotasks();

		const afterUnload = snapshotTracked();

		// Load-phase disposables: created between beforeLoad and beforeUnload
		const loadCreated = [...beforeUnload].filter(d => !beforeLoad.has(d));
		// Of those, which survived the unload? Those are leaks.
		return loadCreated.filter(d => afterUnload.has(d))
			.filter(d => !isInputPartChurn(d));
	}

	/**
	 * Returns true if a disposable is from the input part's model-switching
	 * lifecycle (autorun, text buffer replacement). These survive between
	 * model loads because setModel(undefined) does not reset the input editor.
	 * They are cleaned up on the next setModel() call, so they are not
	 * accumulating leaks.
	 */
	function isInputPartChurn(d: IDisposable): boolean {
		const trackerMap: Map<IDisposable, { source: string | null }> = (tracker as unknown as { livingDisposables: Map<IDisposable, { source: string | null }> }).livingDisposables;
		const source = trackerMap.get(d)?.source ?? '';
		// V8: "at ChatInputPart.setInputModel (...)" / WebKit: "setInputModel@..."
		return source.includes('setInputModel')
			|| source.includes('setValue');
	}

	/**
	 * Takes an identity snapshot of currently tracked disposables.
	 */
	function snapshotTracked(): Set<IDisposable> {
		return new Set(tracker.getTrackedDisposables());
	}

	/**
	 * Summarizes leaked disposables with creation stack excerpts for diagnostics.
	 */
	function describeLeaks(leaked: IDisposable[]): string {
		if (leaked.length === 0) {
			return '(none)';
		}
		const counts = new Map<string, number>();
		const stacks = new Map<string, string[]>();
		// Access private livingDisposables for diagnostic stack traces
		const trackerMap: Map<IDisposable, { source: string | null }> = (tracker as unknown as { livingDisposables: Map<IDisposable, { source: string | null }> }).livingDisposables;
		for (const d of leaked) {
			const name = d.constructor.name;
			counts.set(name, (counts.get(name) || 0) + 1);
			const info = trackerMap.get(d);
			if (info?.source && (!stacks.has(name) || stacks.get(name)!.length < 2)) {
				const frames = info.source.split('\n').filter(l => l.includes('file://') && !l.includes('lifecycle.ts')).slice(0, 8);
				if (!stacks.has(name)) {
					stacks.set(name, []);
				}
				stacks.get(name)!.push(frames.join('\n'));
			}
		}
		const summary = [...counts.entries()].map(([name, count]) => `${name} x${count}`).join(', ');
		const stackDetails = [...stacks.entries()].map(([name, traces]) =>
			`\n--- ${name} ---\n${traces.join('\n--\n')}`
		).join('');
		return `${summary}${stackDetails}`;
	}

	test('load and unload model - no rendering artifacts leak while widget stays alive', async function () {
		const widget = disposables.add(
			instantiationService.createInstance(ChatWidget, ChatAgentLocation.Chat, {}, {}, styles)
		);
		widget.render(parentElement);
		widget.setVisible(true);
		widget.layout(600, 5000);

		const model = disposables.add(createCompletedModel());

		// Warm-up: two load/unload cycles to stabilize templates, pools, and widget state
		await loadUnloadCycle(widget, model);
		await loadUnloadCycle(widget, model);

		// Test cycle with targeted detection: track disposables created during
		// the load phase and verify they're all cleaned up after unload.
		const surviving = await loadUnloadCycleWithCheck(widget, model);
		if (surviving.length > 0) {
			assert.fail(
				`Load/unload cycle left ${surviving.length} disposables alive that ` +
				`were created during rendering: ${describeLeaks(surviving)}`
			);
		}
	});

	test('switch models - no rendering artifacts leak from the previous model', async function () {
		const widget = disposables.add(
			instantiationService.createInstance(ChatWidget, ChatAgentLocation.Chat, {}, {}, styles)
		);
		widget.render(parentElement);
		widget.setVisible(true);
		widget.layout(600, 5000);

		const model1 = disposables.add(createCompletedModel());
		const model2 = disposables.add(instantiationService.createInstance(
			ChatModel, undefined, { initialLocation: ChatAgentLocation.Chat, canUseTools: true }
		));
		const req = model2.addRequest(createParsedRequest('Simple'), { variables: [] }, 0);
		model2.acceptResponseProgress(req, { kind: 'markdownContent', content: new MarkdownString('Simple answer') });
		req.response!.setResult({});
		req.response!.complete();

		// Warm-up: two full switch cycles
		for (let i = 0; i < 2; i++) {
			widget.setModel(model1);
			widget.layout(600, 5000);
			await flushMicrotasks();
			widget.setModel(model2);
			widget.layout(600, 5000);
			await flushMicrotasks();
			widget.setModel(undefined);
			await flushMicrotasks();
		}

		// Snapshot before the test cycle
		const beforeLoad = snapshotTracked();

		// Test cycle: model1 → model2 → unload
		widget.setModel(model1);
		widget.layout(600, 5000);
		await flushMicrotasks();
		widget.setModel(model2);
		widget.layout(600, 5000);
		await flushMicrotasks();

		// Snapshot before unloading — captures all load-phase disposables
		const beforeUnload = snapshotTracked();

		widget.setModel(undefined);
		await flushMicrotasks();

		const afterUnload = snapshotTracked();

		// Load-phase disposables that survived unload are leaks
		const loadCreated = [...beforeUnload].filter(d => !beforeLoad.has(d));
		const surviving = loadCreated.filter(d => afterUnload.has(d))
			.filter(d => !isInputPartChurn(d));
		if (surviving.length > 0) {
			assert.fail(
				`Model switch left ${surviving.length} disposables alive that ` +
				`were created during rendering: ${describeLeaks(surviving)}`
			);
		}
	});

	test('repeated load/unload cycles - no cumulative leaks', async function () {
		const widget = disposables.add(
			instantiationService.createInstance(ChatWidget, ChatAgentLocation.Chat, {}, {}, styles)
		);
		widget.render(parentElement);
		widget.setVisible(true);
		widget.layout(600, 5000);

		const model = disposables.add(createCompletedModel());

		// Warm-up: two full load/unload cycles
		await loadUnloadCycle(widget, model);
		await loadUnloadCycle(widget, model);

		// Run 5 cycles, each checking that load-phase disposables are fully
		// cleaned up after unload (no surviving rendering artifacts).
		for (let cycle = 0; cycle < 5; cycle++) {
			const surviving = await loadUnloadCycleWithCheck(widget, model);
			if (surviving.length > 0) {
				assert.fail(
					`Cycle ${cycle + 1}/5 left ${surviving.length} disposables alive ` +
					`that were created during rendering: ${describeLeaks(surviving)}`
				);
			}
		}
	});
});
