/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../../base/common/themables.js';
import { IChatToolInvocation, IChatToolInvocationSerialized, ToolConfirmKind } from '../../../../common/chatService/chatService.js';
import { IChatCodeBlockInfo } from '../../../chat.js';
import { getToolInvocationIcon } from '../chatThinkingContentPart.js';

export abstract class BaseChatToolInvocationSubPart extends Disposable {
	protected static idPool = 0;
	public abstract readonly domNode: HTMLElement;

	protected _onNeedsRerender = this._register(new Emitter<void>());
	public readonly onNeedsRerender = this._onNeedsRerender.event;

	public abstract codeblocks: IChatCodeBlockInfo[];

	private readonly _codeBlocksPartId = 'tool-' + (BaseChatToolInvocationSubPart.idPool++);

	public get codeblocksPartId() {
		return this._codeBlocksPartId;
	}

	constructor(
		protected readonly toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized,
	) {
		super();
	}

	protected getIcon() {
		const toolInvocation = this.toolInvocation;
		const confirmState = IChatToolInvocation.executionConfirmedOrDenied(toolInvocation);
		const isSkipped = confirmState?.type === ToolConfirmKind.Skipped;
		if (isSkipped) {
			return Codicon.circleSlash;
		}

		if (confirmState?.type === ToolConfirmKind.Denied) {
			return Codicon.error;
		}

		const icon = getToolInvocationIcon(toolInvocation.toolId, toolInvocation.icon ?? undefined);
		return IChatToolInvocation.isComplete(toolInvocation)
			? icon
			: ThemeIcon.modify(icon, 'spin');
	}
}
