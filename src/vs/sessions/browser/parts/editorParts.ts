/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/editorPart.css';
import { ServiceCollection } from '../../../platform/instantiation/common/serviceCollection.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IAuxiliaryWindowService } from '../../../workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { IEditorService } from '../../../workbench/services/editor/common/editorService.js';
import { EditorParts as EditorPartsBase } from '../../../workbench/browser/parts/editor/editorParts.js';
import { IEditorGroupsService, IEditorPart } from '../../../workbench/services/editor/common/editorGroupsService.js';
import { IStatusbarService } from '../../../workbench/services/statusbar/browser/statusbar.js';
import { ChatEditorPart, MainEditorPart } from './editorPart.js';

export class EditorParts extends EditorPartsBase {
	readonly chatPart: ChatEditorPart;
	private chatPartInstantiationService: IInstantiationService | undefined;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IStorageService storageService: IStorageService,
		@IThemeService themeService: IThemeService,
		@IAuxiliaryWindowService auxiliaryWindowService: IAuxiliaryWindowService,
		@IContextKeyService contextKeyService: IContextKeyService
	) {
		super(instantiationService, storageService, themeService, auxiliaryWindowService, contextKeyService);

		this.chatPart = this._register(this.instantiationService.createInstance(ChatEditorPart, this));
		this._register(this.registerPart(this.chatPart));
	}

	protected override createMainEditorPart(): MainEditorPart {
		return this.instantiationService.createInstance(MainEditorPart, this);
	}

	override getScopedInstantiationService(part: IEditorPart): IInstantiationService {
		if (part === this.chatPart) {
			if (!this.chatPartInstantiationService) {
				this.chatPartInstantiationService = this.instantiationService.invokeFunction(accessor => {
					const editorService = accessor.get(IEditorService);
					const statusbarService = accessor.get(IStatusbarService);

					return this._register(this.chatPart.scopedInstantiationService.createChild(new ServiceCollection(
						[IEditorService, editorService.createScoped(this.chatPart, this._store)],
						[IStatusbarService, statusbarService.createScoped(statusbarService, this._store)]
					)));
				});
			}

			return this.chatPartInstantiationService;
		}

		return super.getScopedInstantiationService(part);
	}
}

registerSingleton(IEditorGroupsService, EditorParts, InstantiationType.Eager);
