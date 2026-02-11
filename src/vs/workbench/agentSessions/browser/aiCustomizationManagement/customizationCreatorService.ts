/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IActiveAgentSessionService } from '../../../contrib/chat/browser/agentSessions/agentSessionsService.js';
import { IChatWidgetService } from '../../../contrib/chat/browser/chat.js';
import { IChatService } from '../../../contrib/chat/common/chatService/chatService.js';
import { ChatModeKind } from '../../../contrib/chat/common/constants.js';
import { PromptsType } from '../../../contrib/chat/common/promptSyntax/promptTypes.js';
import { getPromptFileDefaultLocations } from '../../../contrib/chat/common/promptSyntax/config/promptFileLocations.js';
import { PromptsStorage } from '../../../contrib/chat/common/promptSyntax/service/promptsService.js';
import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { getActiveWorkingDirectory } from '../agentSessionUtils.js';

/**
 * Service that opens an AI-guided chat session to help the user create
 * a new customization (agent, skill, instructions, prompt, hook).
 *
 * Opens a new chat in agent mode, then sends a request with hidden
 * system instructions (modeInstructions) that guide the AI through
 * the creation process. The user sees only their message.
 */
export class CustomizationCreatorService {

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IChatService private readonly chatService: IChatService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@IActiveAgentSessionService private readonly activeAgentSessionService: IActiveAgentSessionService,
		@ILogService private readonly logService: ILogService,
	) { }

	async createWithAI(type: PromptsType): Promise<void> {
		// TODO: The 'Generate X' flow currently opens a new chat that is not connected
		// to the active worktree. For this to fully work, the background agent needs to
		// accept a worktree parameter so the new session can write files into the correct
		// worktree directory and have those changes tracked in the session's diff view.

		// Capture worktree BEFORE opening new chat (which changes active session)
		const activeSession = this.activeAgentSessionService.getActiveSession();
		this.logService.info(`[CustomizationCreator] Active session: repo=${activeSession?.repository?.toString() ?? 'none'}, worktree=${activeSession?.worktree?.toString() ?? 'none'}`);

		const targetDir = this.resolveTargetDirectory(type);
		this.logService.info(`[CustomizationCreator] Target dir: ${targetDir?.toString() ?? 'none'}`);
		const systemInstructions = buildAgentInstructions(type, targetDir);
		const userMessage = buildUserMessage(type, targetDir);

		// Start a new chat, then send the request with hidden instructions
		await this.commandService.executeCommand('workbench.action.chat.newChat');

		// Grab the now-active widget's session and send with hidden instructions
		const widget = this.chatWidgetService.lastFocusedWidget;
		const sessionResource = widget?.viewModel?.sessionResource;
		if (!sessionResource) {
			return;
		}

		await this.chatService.sendRequest(sessionResource, userMessage, {
			modeInfo: {
				kind: ChatModeKind.Agent,
				isBuiltin: false,
				modeId: 'custom',
				applyCodeBlockSuggestionId: undefined,
				modeInstructions: {
					name: 'customization-creator',
					content: systemInstructions,
					toolReferences: [],
				},
			},
		});
	}

	/**
	 * Returns the worktree and repository URIs from the active session.
	 */
	getActiveSessionPaths(): { worktree: URI | undefined; repository: URI | undefined } {
		const activeSession = this.activeAgentSessionService.getActiveSession();
		return {
			worktree: activeSession?.worktree,
			repository: activeSession?.repository,
		};
	}

	/**
	 * Resolves the target directory for a new customization file based on the
	 * active session's worktree (preferred) or repository path.
	 */
	resolveTargetDirectory(type: PromptsType): URI | undefined {
		const basePath = getActiveWorkingDirectory(this.activeAgentSessionService);
		if (!basePath) {
			return undefined;
		}

		// Find the first local (workspace) source folder for this type
		const defaultLocations = getPromptFileDefaultLocations(type);
		const localLocation = defaultLocations.find(loc => loc.storage === PromptsStorage.local);
		if (!localLocation) {
			return basePath;
		}

		return URI.joinPath(basePath, localLocation.path);
	}

	/**
	 * Resolves the user-level directory for a new customization file.
	 * Returns undefined if there's no user-level location for this type.
	 */
	resolveUserDirectory(type: PromptsType): URI | undefined {
		const defaultLocations = getPromptFileDefaultLocations(type);
		const userLocation = defaultLocations.find(loc => loc.storage === PromptsStorage.user);
		if (!userLocation) {
			return undefined;
		}

		// User paths start with ~ - resolve to home directory
		const path = userLocation.path;
		if (path.startsWith('~')) {
			const homedir = URI.file(process.env.HOME || process.env.USERPROFILE || '');
			return URI.joinPath(homedir, path.slice(1));
		}

		return URI.file(path);
	}
}

//#region Agent Instructions

/**
 * Builds the hidden system instructions for the customization creator agent.
 * Sent as modeInstructions - invisible to the user.
 */
function buildAgentInstructions(type: PromptsType, targetDir: URI | undefined): string {
	const targetHint = targetDir
		? `\nIMPORTANT: Save the file to this directory: ${targetDir.fsPath}`
		: '';

	const writePolicy = `

CRITICAL WORKFLOW:
- In your VERY FIRST response, you MUST immediately create the file on disk from a starter template with placeholder content. Do not ask questions first -- write the file first so it appears in the diff view, then ask the user how they want to customize it.
- Every subsequent message from the user should result in you updating that same file on disk with the requested changes.
- Always write the complete file content, not partial diffs.${targetHint}`;

	switch (type) {
		case PromptsType.agent:
			return `You are a helpful assistant that guides users through creating a new custom AI agent.${writePolicy}

Ask the user what the agent should do, what tools it needs, then write a .agent.md file with YAML frontmatter (name, description, tools) and system instructions.`;

		case PromptsType.skill:
			return `You are a helpful assistant that guides users through creating a new skill.${writePolicy}

Ask the user for a skill name (lowercase, hyphens, e.g. "pdf-processing") and what it does. Create a <name>/SKILL.md file with YAML frontmatter (name, description) and instructions.`;

		case PromptsType.instructions:
			return `You are a helpful assistant that guides users through creating a new instructions file.${writePolicy}

Ask the user what the instructions cover and if they apply to specific files (applyTo glob). Write a .instructions.md file with YAML frontmatter (description, optional applyTo) and actionable content.`;

		case PromptsType.prompt:
			return `You are a helpful assistant that guides users through creating a new reusable prompt.${writePolicy}

Ask the user what the prompt should do. Write a .prompt.md file with YAML frontmatter (name, description) and prompt content.`;

		case PromptsType.hook:
			return `You are a helpful assistant that guides users through creating a new hook.${writePolicy}

Ask the user when the hook should trigger and what it should do, then write the configuration file.`;

		default:
			return `You are a helpful assistant that guides users through creating a new AI customization file.${writePolicy}

Ask the user what they want to create, then guide them step by step.`;
	}
}

//#endregion

//#region User Messages

/**
 * Builds the user-visible message that opens the chat.
 * Includes the target path so the agent knows where to write the file.
 */
function buildUserMessage(type: PromptsType, targetDir: URI | undefined): string {
	const pathHint = targetDir ? ` Write it to \`${targetDir.fsPath}\`.` : '';

	switch (type) {
		case PromptsType.agent:
			return `Help me create a new custom agent (.agent.md file).${pathHint} Ask me what it should do, then write the file.`;
		case PromptsType.skill:
			return `Help me create a new skill (SKILL.md in a named subdirectory).${pathHint} Ask me what it should do, then write the file.`;
		case PromptsType.instructions:
			return `Help me create a new instructions file (.instructions.md).${pathHint} Ask me what it should cover, then write the file.`;
		case PromptsType.prompt:
			return `Help me create a new prompt (.prompt.md file).${pathHint} Ask me what it should do, then write the file.`;
		case PromptsType.hook:
			return `Help me create a new hook.${pathHint} Ask me when it should trigger and what it should do, then write the file.`;
		default:
			return `Help me create a new customization.${pathHint}`;
	}
}

//#endregion
