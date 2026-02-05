/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/modalEditorPart.css';
import { $, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IEditorGroupView, IEditorPartsView } from './editor.js';
import { EditorPart, IEditorPartUIState } from './editorPart.js';
import { GroupDirection, GroupsOrder, IModalEditorPart } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { localize } from '../../../../nls.js';

export interface ICreateModalEditorPartResult {
	readonly part: ModalEditorPartImpl;
	readonly instantiationService: IInstantiationService;
	readonly disposables: DisposableStore;
}

export class ModalEditorPart {

	constructor(
		private readonly editorPartsView: IEditorPartsView,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService
	) {
	}

	async create(): Promise<ICreateModalEditorPartResult> {
		const disposables = new DisposableStore();

		// Create modal backdrop
		const modalElement = $('.monaco-modal-editor-block.dimmed');
		modalElement.tabIndex = -1;
		const mainContainer = this.layoutService.mainContainer;
		mainContainer.appendChild(modalElement);
		disposables.add({ dispose: () => modalElement.remove() });

		// Create shadow container for the modal
		const shadowElement = modalElement.appendChild($('.modal-editor-shadow'));

		// Create editor part container
		const editorPartContainer = $('.part.editor.modal-editor-part', {
			role: 'dialog',
			'aria-modal': 'true',
			'aria-label': localize('modalEditorPart', "Modal Editor")
		});
		shadowElement.appendChild(editorPartContainer);

		// Create the editor part
		const editorPart = disposables.add(this.instantiationService.createInstance(
			ModalEditorPartImpl,
			mainWindow.vscodeWindowId,
			this.editorPartsView,
			undefined,
			localize('modalEditorPart', "Modal Editor")
		));
		disposables.add(this.editorPartsView.registerPart(editorPart));
		editorPart.create(editorPartContainer);

		// Create scoped instantiation service
		const scopedInstantiationService = disposables.add(editorPart.scopedInstantiationService.createChild(new ServiceCollection(
			[IEditorService, this.editorService.createScoped(editorPart, disposables)]
		)));

		// Handle close on click outside
		disposables.add(addDisposableListener(modalElement, EventType.MOUSE_DOWN, e => {
			if (e.target === modalElement) {
				editorPart.close();
			}
		}));

		// Handle escape key to close
		disposables.add(addDisposableListener(modalElement, EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.keyCode === KeyCode.Escape) {
				editorPart.close();
			}
		}));

		// Handle close event from editor part
		disposables.add(Event.once(editorPart.onWillClose)(() => {
			disposables.dispose();
		}));

		// Layout the modal editor part
		const layout = () => {
			const containerDimension = this.layoutService.mainContainerDimension;
			const width = Math.min(containerDimension.width * 0.8, 1200);
			const height = Math.min(containerDimension.height * 0.8, 800);

			editorPartContainer.style.width = `${width}px`;
			editorPartContainer.style.height = `${height}px`;

			// Account for 1px border on all sides (box-sizing: border-box in .part CSS)
			const borderSize = 2;
			editorPart.layout(width - borderSize, height - borderSize, 0, 0);
		};

		layout();
		disposables.add(this.layoutService.onDidLayoutMainContainer(() => layout()));

		// Focus the modal
		editorPartContainer.focus();

		return {
			part: editorPart,
			instantiationService: scopedInstantiationService,
			disposables
		};
	}
}

class ModalEditorPartImpl extends EditorPart implements IModalEditorPart {

	private static COUNTER = 1;

	private readonly _onWillClose = this._register(new Emitter<void>());
	readonly onWillClose = this._onWillClose.event;

	private readonly optionsDisposable = this._register(new MutableDisposable());

	constructor(
		windowId: number,
		editorPartsView: IEditorPartsView,
		private readonly state: IEditorPartUIState | undefined,
		groupsLabel: string,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IConfigurationService configurationService: IConfigurationService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IHostService hostService: IHostService,
		@IContextKeyService contextKeyService: IContextKeyService
	) {
		const id = ModalEditorPartImpl.COUNTER++;
		super(editorPartsView, `workbench.parts.modalEditor.${id}`, groupsLabel, windowId, instantiationService, themeService, configurationService, storageService, layoutService, hostService, contextKeyService);

		// Modal editor parts enforce compact options
		this.optionsDisposable.value = this.enforcePartOptions({
			showTabs: 'single',
			closeEmptyGroups: true,
			tabActionCloseVisibility: false,
			alwaysShowEditorActions: true,
			editorActionsLocation: 'default',
			tabHeight: 'default',
			wrapTabs: false
		});
	}

	override removeGroup(group: number | IEditorGroupView, preserveFocus?: boolean): void {

		// Close modal when last group removed
		const groupView = this.assertGroupView(group);
		if (this.count === 1 && this.activeGroup === groupView) {
			this.doRemoveLastGroup(preserveFocus);
		}

		// Otherwise delegate to parent implementation
		else {
			super.removeGroup(group, preserveFocus);
		}
	}

	private doRemoveLastGroup(preserveFocus?: boolean): void {
		const restoreFocus = !preserveFocus && this.shouldRestoreFocus(this.container);

		// Activate next group
		const mostRecentlyActiveGroups = this.editorPartsView.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE);
		const nextActiveGroup = mostRecentlyActiveGroups[1]; // [0] will be the current group we are about to dispose
		if (nextActiveGroup) {
			nextActiveGroup.groupsView.activateGroup(nextActiveGroup);

			if (restoreFocus) {
				nextActiveGroup.focus();
			}
		}

		this.doClose(false /* do not merge any confirming editors to main part */);
	}

	protected override loadState(): IEditorPartUIState | undefined {
		return this.state;
	}

	protected override saveState(): void {
		return; // disabled, modal editor part state is not persisted
	}

	close(): boolean {
		return this.doClose(true /* merge all confirming editors to main part */);
	}

	private doClose(mergeConfirmingEditorsToMainPart: boolean): boolean {
		let result = true;
		if (mergeConfirmingEditorsToMainPart) {

			// First close all editors that are non-confirming
			for (const group of this.groups) {
				group.closeAllEditors({ excludeConfirming: true });
			}

			// Then merge remaining to main part
			result = this.mergeGroupsToMainPart();
			if (!result) {
				// Do not close when editors could not be merged back.
				return false;
			}
		}

		this._onWillClose.fire();

		return result;
	}

	private mergeGroupsToMainPart(): boolean {
		if (!this.groups.some(group => group.count > 0)) {
			return true; // skip if we have no editors opened
		}

		// Find the most recent group that is not locked
		let targetGroup: IEditorGroupView | undefined = undefined;
		for (const group of this.editorPartsView.mainPart.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE)) {
			if (!group.isLocked) {
				targetGroup = group;
				break;
			}
		}

		if (!targetGroup) {
			targetGroup = this.editorPartsView.mainPart.addGroup(this.editorPartsView.mainPart.activeGroup, this.partOptions.openSideBySideDirection === 'right' ? GroupDirection.RIGHT : GroupDirection.DOWN);
		}

		const result = this.mergeAllGroups(targetGroup, {
			// Try to reduce the impact of closing the modal
			// as much as possible by not changing existing editors
			// in the main window.
			preserveExistingIndex: true
		});
		targetGroup.focus();

		return result;
	}
}
