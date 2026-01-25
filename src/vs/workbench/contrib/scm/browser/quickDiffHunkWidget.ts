/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/quickDiffHunkWidget.css';

import * as nls from '../../../../nls.js';
import * as dom from '../../../../base/browser/dom.js';
import { ActionRunner, IAction } from '../../../../base/common/actions.js';
import { ActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { MenuId, MenuItemAction } from '../../../../platform/actions/common/actions.js';
import { ICodeEditor, IOverlayWidget, IOverlayWidgetPosition } from '../../../../editor/browser/editorBrowser.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { URI } from '../../../../base/common/uri.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IChange } from '../../../../editor/common/diff/legacyLinesDiffComputer.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { gotoNextLocation, gotoPreviousLocation } from '../../../../platform/theme/common/iconRegistry.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';

class QuickDiffHunkWidgetActionRunner extends ActionRunner {

	protected override runAction(action: IAction, context: unknown): Promise<void> {
		if (action instanceof MenuItemAction && Array.isArray(context)) {
			return action.run(...context);
		}
		return super.runAction(action, context);
	}
}

export class QuickDiffHunkWidget implements IOverlayWidget {

	private static _idPool = 0;
	private readonly _id: string = `quickdiff-hunk-widget-${QuickDiffHunkWidget._idPool++}`;

	private readonly _domNode: HTMLElement;
	private readonly _store = new DisposableStore();
	private _position: IOverlayWidgetPosition | undefined;
	private _lastStartLineNumber: number | undefined;
	private _viewZoneHeight: number = 0;
	private _removed: boolean = false;
	private _uri: URI;
	private _changes: IChange[];
	private _index: number;

	constructor(
		private readonly _editor: ICodeEditor,
		uri: URI,
		originalUri: URI,
		changes: IChange[],
		index: number,
		private readonly _onClose: () => void,
		private readonly _onPrevious: () => void,
		private readonly _onNext: () => void,
		@IInstantiationService instaService: IInstantiationService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		this._uri = uri;
		this._changes = changes;
		this._index = index;

		this._domNode = document.createElement('div');
		this._domNode.className = 'quick-diff-hunk-widget';

		// Create a scoped context key service with originalResource set
		const scopedContextKeyService = contextKeyService.createOverlay([
			['originalResource', originalUri.toString()],
			['originalResourceScheme', originalUri.scheme]
		]);

		// Create a child instantiation service with the scoped context key service
		const serviceCollection = new ServiceCollection([IContextKeyService, scopedContextKeyService]);
		const scopedInstaService = instaService.createChild(serviceCollection, this._store);

		const actionRunner = this._store.add(new QuickDiffHunkWidgetActionRunner());

		const toolbar = scopedInstaService.createInstance(MenuWorkbenchToolBar, this._domNode, MenuId.SCMChangeContext, {
			telemetrySource: 'quickDiffHunk',
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			actionRunner,
			toolbarOptions: { primaryGroup: () => true },
			menuOptions: {
				renderShortTitle: true,
				shouldForwardArgs: true,
			},
			actionViewItemProvider: (action, options) => {
				if (!action.class) {
					return new class extends ActionViewItem {
						constructor() {
							super(undefined, action, { ...options, keybindingNotRenderedWithLabel: true, icon: false, label: true });
						}
					};
				}
				return undefined;
			}
		});

		this._store.add(toolbar);
		this._store.add(toolbar.actionRunner.onWillRun(_ => _editor.focus()));
		this._store.add(toolbar.actionRunner.onDidRun(e => {
			if (!e.error) {
				this._onClose();
			}
		}));

		// Set the context for the toolbar actions
		toolbar.context = [this._uri, this._changes, this._index];

		// Add navigation and close actions
		const actionsContainer = dom.append(this._domNode, dom.$('.quick-diff-hunk-actions'));

		// Previous action
		const previousButton = dom.append(actionsContainer, dom.$('a.action-label.codicon'));
		previousButton.classList.add(...ThemeIcon.asClassNameArray(gotoPreviousLocation));
		previousButton.title = this._keybindingService.appendKeybinding(nls.localize('showPreviousChange', "Show Previous Change"), 'editor.action.dirtydiff.previous');
		this._store.add(dom.addDisposableListener(previousButton, dom.EventType.CLICK, () => this._onPrevious()));

		// Next action
		const nextButton = dom.append(actionsContainer, dom.$('a.action-label.codicon'));
		nextButton.classList.add(...ThemeIcon.asClassNameArray(gotoNextLocation));
		nextButton.title = this._keybindingService.appendKeybinding(nls.localize('showNextChange', "Show Next Change"), 'editor.action.dirtydiff.next');
		this._store.add(dom.addDisposableListener(nextButton, dom.EventType.CLICK, () => this._onNext()));

		// Close action
		const closeButton = dom.append(actionsContainer, dom.$('a.action-label.codicon'));
		closeButton.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
		closeButton.title = nls.localize('closeChange', "Close");
		this._store.add(dom.addDisposableListener(closeButton, dom.EventType.CLICK, () => this._onClose()));

		this._editor.addOverlayWidget(this);
	}

	update(uri: URI, changes: IChange[], index: number): void {
		this._uri = uri;
		this._changes = changes;
		this._index = index;
	}

	dispose(): void {
		this._store.dispose();
		this._editor.removeOverlayWidget(this);
		this._removed = true;
	}

	getId(): string {
		return this._id;
	}

	layout(startLineNumber: number, viewZoneHeight: number = 0): void {
		const { contentLeft, contentWidth, verticalScrollbarWidth } = this._editor.getLayoutInfo();
		const scrollTop = this._editor.getScrollTop();

		// For deleted content (viewZoneHeight > 0), position at the top of the view zone
		// The view zone appears after startLineNumber, and getTopForLineNumber(startLineNumber + 1)
		// gives us the bottom of the view zone, so subtract viewZoneHeight to get the top
		const topOffset = viewZoneHeight > 0
			? this._editor.getTopForLineNumber(startLineNumber + 1) - viewZoneHeight - scrollTop
			: this._editor.getTopForLineNumber(startLineNumber) - scrollTop;

		this._position = {
			stackOrdinal: 1,
			preference: {
				top: topOffset,
				left: contentLeft + contentWidth - (2 * verticalScrollbarWidth + dom.getTotalWidth(this._domNode))
			}
		};

		this._viewZoneHeight = viewZoneHeight;

		if (this._removed) {
			this._removed = false;
			this._editor.addOverlayWidget(this);
		} else {
			this._editor.layoutOverlayWidget(this);
		}
		this._lastStartLineNumber = startLineNumber;
	}

	remove(): void {
		this._editor.removeOverlayWidget(this);
		this._removed = true;
	}

	toggle(show: boolean) {
		this._domNode.classList.toggle('hover', show);
		if (this._lastStartLineNumber) {
			this.layout(this._lastStartLineNumber, this._viewZoneHeight);
		}
	}

	getDomNode(): HTMLElement {
		return this._domNode;
	}

	getPosition(): IOverlayWidgetPosition | null {
		return this._position ?? null;
	}

	getStartLineNumber(): number | undefined {
		return this._lastStartLineNumber;
	}

	getViewZoneHeight(): number {
		return this._viewZoneHeight;
	}
}
