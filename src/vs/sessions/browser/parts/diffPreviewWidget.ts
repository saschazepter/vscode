/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../base/browser/dom.js';
import { Dimension } from '../../../base/browser/dom.js';
import { Codicon } from '../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../base/common/lifecycle.js';
import { observableValue, ValueWithChangeEventFromObservable } from '../../../base/common/observable.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IEditorProgressService, IProgressRunner } from '../../../platform/progress/common/progress.js';
import { ServiceCollection } from '../../../platform/instantiation/common/serviceCollection.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { ITextModelService } from '../../../editor/common/services/resolverService.js';
import { MultiDiffEditorWidget } from '../../../editor/browser/widget/multiDiffEditor/multiDiffEditorWidget.js';
import { MultiDiffEditorViewModel } from '../../../editor/browser/widget/multiDiffEditor/multiDiffEditorViewModel.js';
import { IDocumentDiffItem, IMultiDiffEditorModel } from '../../../editor/browser/widget/multiDiffEditor/model.js';
import { IWorkbenchUIElementFactory, IResourceLabel } from '../../../editor/browser/widget/multiDiffEditor/workbenchUIElementFactory.js';
import { RefCounted } from '../../../editor/browser/widget/diffEditor/utils.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { ResourceLabel } from '../../../workbench/browser/labels.js';
import { MenuWorkbenchToolBar } from '../../../platform/actions/browser/toolbar.js';
import { Menus } from '../menus.js';

/**
 * A file with original and modified URIs for diff preview.
 */
export interface IDiffPreviewFile {
	readonly uri: URI;
	readonly originalUri?: URI;
}

const $ = dom.$;

/**
 * Widget that shows a multi-diff editor preview for session changes.
 * Used inside the Changes view as the left pane of a horizontal split.
 */
export class DiffPreviewWidget extends Disposable {

	static readonly PREFERRED_WIDTH = 500;
	private static readonly HEADER_HEIGHT = 32;

	private readonly container: HTMLElement;
	private readonly headerContainer: HTMLElement;
	private readonly titleLabel: HTMLElement;
	private readonly fileCountBadge: HTMLElement;
	private readonly emptyStateContainer: HTMLElement;
	private readonly editorContainer: HTMLElement;

	private multiDiffEditor: MultiDiffEditorWidget | undefined;
	private readonly _viewModel = this._register(new MutableDisposable<MultiDiffEditorViewModel>());
	private readonly modelDisposables = this._register(new DisposableStore());

	private readonly documentsObs = observableValue<readonly RefCounted<IDocumentDiffItem>[] | 'loading'>(this, []);

	private currentWidth = 0;
	private currentHeight = 0;
	private _visible = false;
	private _setFilesSeq = 0;

	get visible(): boolean {
		return this._visible;
	}

	get element(): HTMLElement {
		return this.container;
	}

	constructor(
		parent: HTMLElement,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@ILogService private readonly logService: ILogService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
	) {
		super();

		this.container = dom.append(parent, $('.diff-preview-widget'));

		// Header bar with title and actions
		this.headerContainer = dom.append(this.container, $('.diff-preview-header'));
		const titleContainer = dom.append(this.headerContainer, $('.diff-preview-header-title'));
		this.titleLabel = dom.append(titleContainer, $('span.diff-preview-header-label'));
		this.titleLabel.textContent = localize('diffPreview.title', "Review");
		this.fileCountBadge = dom.append(titleContainer, $('span.diff-preview-files-count'));
		this.fileCountBadge.style.display = 'none';

		const toolbarContainer = dom.append(this.headerContainer, $('.diff-preview-header-toolbar'));
		this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, toolbarContainer, Menus.DiffPreviewToolbar, {
			menuOptions: { shouldForwardArgs: true },
			toolbarOptions: { primaryGroup: g => g.startsWith('navigation') },
		}));

		// Empty state
		this.emptyStateContainer = dom.append(this.container, $('.diff-preview-empty'));
		const emptyIcon = dom.append(this.emptyStateContainer, $('.diff-preview-empty-icon'));
		emptyIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.diffMultiple));
		const emptyMessage = dom.append(this.emptyStateContainer, $('.diff-preview-empty-message'));
		emptyMessage.textContent = localize('diffPreview.empty', "Select files to preview changes");

		// Editor container
		this.editorContainer = dom.append(this.container, $('.diff-preview-editor'));
	}

	show(): void {
		this._visible = true;
		this.container.style.display = '';
		this.ensureEditor();
	}

	hide(): void {
		this._visible = false;
		this.container.style.display = 'none';
		this.clearEditor();
	}

	/**
	 * Set the files to preview. Pass all changed files for a multi-diff view.
	 */
	async setFiles(files: readonly IDiffPreviewFile[]): Promise<void> {
		const seq = ++this._setFilesSeq;
		this.modelDisposables.clear();

		this.logService.debug(`[DiffPreviewWidget] setFiles called with ${files.length} files`);

		if (files.length === 0) {
			this.documentsObs.set([], undefined);
			this.updateEmptyState(true);
			this.fileCountBadge.textContent = '';
			this.fileCountBadge.style.display = 'none';
			this.updateViewModel();
			return;
		}

		this.updateEmptyState(false);
		this.fileCountBadge.textContent = `${files.length}`;
		this.fileCountBadge.style.display = '';

		// Resolve text models for each file
		const docs: RefCounted<IDocumentDiffItem>[] = [];
		for (const file of files) {
			const docDisposables = new DisposableStore();
			this.modelDisposables.add(docDisposables);

			try {
				this.logService.debug(`[DiffPreviewWidget] Resolving: modified=${file.uri.toString()}, original=${file.originalUri?.toString()}`);

				const [originalRef, modifiedRef] = await Promise.all([
					file.originalUri ? this.textModelService.createModelReference(file.originalUri) : undefined,
					this.textModelService.createModelReference(file.uri),
				]);

				if (originalRef) {
					docDisposables.add(originalRef);
				}
				docDisposables.add(modifiedRef);

				const item: IDocumentDiffItem = {
					original: originalRef?.object.textEditorModel ?? undefined,
					modified: modifiedRef.object.textEditorModel,
				};

				docs.push(RefCounted.createOfNonDisposable(item, docDisposables, this));
				this.logService.debug(`[DiffPreviewWidget] Successfully resolved file: ${file.uri.toString()}`);
			} catch (e) {
				this.logService.error(`[DiffPreviewWidget] Failed to resolve file: ${file.uri.toString()}`, e);
				docDisposables.dispose();
			}
		}

		// Discard results if a newer setFiles call has started
		if (seq !== this._setFilesSeq) {
			for (const doc of docs) {
				doc.dispose();
			}
			return;
		}

		this.logService.debug(`[DiffPreviewWidget] Resolved ${docs.length}/${files.length} documents, dimensions: ${this.currentWidth}x${this.currentHeight}`);

		this.documentsObs.set(docs, undefined);
		this.updateViewModel();

		// Re-layout now that the editor has content
		if (this.multiDiffEditor && this.currentWidth > 0 && this.currentHeight > 0) {
			this.multiDiffEditor.layout(this.getInnerDimension());
		}
	}

	/**
	 * Reveal a specific file in the multi-diff view, expanding it if collapsed.
	 */
	revealFile(uri: URI): void {
		if (!this.multiDiffEditor || !this._viewModel.value) {
			return;
		}

		// Expand the item if it's collapsed
		const items = this._viewModel.value.items.get();
		const item = items.find(i => i.modifiedUri?.toString() === uri.toString());
		if (item && item.collapsed.get()) {
			item.collapsed.set(false, undefined);
		}

		this.multiDiffEditor.reveal({ original: undefined, modified: uri });
	}

	private static readonly HORIZONTAL_PADDING = 20; // 10px left + 10px right
	private static readonly VERTICAL_PADDING = 20; // 10px top + 10px bottom

	/**
	 * Compute the inner dimensions available for the multi-diff editor.
	 */
	private getInnerDimension(): Dimension {
		return new Dimension(
			Math.max(0, this.currentWidth - DiffPreviewWidget.HORIZONTAL_PADDING),
			Math.max(0, this.currentHeight - DiffPreviewWidget.VERTICAL_PADDING - DiffPreviewWidget.HEADER_HEIGHT),
		);
	}

	layout(width: number, height: number): void {
		this.currentWidth = width;
		this.currentHeight = height;

		if (this.multiDiffEditor) {
			this.multiDiffEditor.layout(this.getInnerDimension());
		}
	}

	private updateEmptyState(empty: boolean): void {
		this.emptyStateContainer.style.display = empty ? '' : 'none';
		this.editorContainer.style.display = empty ? 'none' : '';
	}

	private updateViewModel(): void {
		this.ensureEditor();

		const model: IMultiDiffEditorModel = {
			documents: new ValueWithChangeEventFromObservable(this.documentsObs),
		};

		this._viewModel.value = this.multiDiffEditor!.createViewModel(model);
		this.multiDiffEditor!.setViewModel(this._viewModel.value);
	}

	private ensureEditor(): void {
		if (this.multiDiffEditor) {
			return;
		}

		// Create a scoped instantiation service that provides IEditorProgressService
		// (required by DiffEditorWidget but not available outside editor parts)
		const scopedContextKeyService = this._register(this.contextKeyService.createScoped(this.editorContainer));
		const scopedInstantiationService = this._register(this.instantiationService.createChild(new ServiceCollection(
			[IContextKeyService, scopedContextKeyService],
			[IEditorProgressService, new class implements IEditorProgressService {
				_serviceBrand: undefined;
				show(totalOrInfinite: true | number, delay?: number): IProgressRunner {
					return { total() { }, worked() { }, done() { } };
				}
				async showWhile(promise: Promise<unknown>, _delay?: number): Promise<void> {
					await promise;
				}
			}],
		)));

		this.multiDiffEditor = this._register(scopedInstantiationService.createInstance(
			MultiDiffEditorWidget,
			this.editorContainer,
			this.createUIElementFactory(scopedInstantiationService),
		));

		if (this.currentWidth > 0 && this.currentHeight > 0) {
			this.multiDiffEditor.layout(this.getInnerDimension());
		}
	}

	private createUIElementFactory(scopedInstantiationService: IInstantiationService): IWorkbenchUIElementFactory {
		return {
			createResourceLabel: (element: HTMLElement): IResourceLabel => {
				const label = scopedInstantiationService.createInstance(ResourceLabel, element, {});
				return {
					setUri(uri, options = {}) {
						if (!uri) {
							label.element.clear();
						} else {
							label.element.setFile(uri, { strikethrough: options.strikethrough });
						}
					},
					dispose() {
						label.dispose();
					}
				};
			}
		};
	}

	private clearEditor(): void {
		this.modelDisposables.clear();
		this.documentsObs.set([], undefined);
		if (this.multiDiffEditor) {
			this.multiDiffEditor.setViewModel(undefined);
		}
		this._viewModel.clear();
	}

	override dispose(): void {
		super.dispose();
	}
}
