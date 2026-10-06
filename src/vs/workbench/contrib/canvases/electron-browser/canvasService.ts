/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun, derived, IReader, observableFromEvent, observableSignal } from '../../../../base/common/observable.js';
import { isEqual } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { CanvasesEnabledSettingId } from '../../../../platform/agentHost/common/agentService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IChatEntitlementService } from '../../../services/chat/common/chatEntitlementService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { CanvasInput, canvasOwnerKey, getCanvasReferenceKey, ICanvas, ICanvasContextService, ICanvasOwner, ICanvasReference, ICanvasReopenTarget, ICanvasService, isCanvasOwner } from '../common/canvas.js';

export class CanvasService extends Disposable implements ICanvasService {

	declare readonly _serviceBrand: undefined;
	readonly enabled;
	readonly reopenableCanvases;

	private readonly inputs = this._register(new DisposableMap<string, CanvasInput>());
	private readonly inputLifetimes = this._register(new DisposableMap<string, DisposableStore>());
	private readonly dismissed = new Map<string, { readonly reference: ICanvasReference; readonly requestId: string | undefined }>();
	private readonly presented = new Map<string, string | undefined>();
	private readonly requests = new Map<string, string | undefined>();
	private readonly pendingOpens = new Set<CanvasInput>();
	private readonly programmaticCloses = new Set<CanvasInput>();
	private readonly dismissedChanged = observableSignal(this);

	constructor(
		@ICanvasContextService private readonly contextService: ICanvasContextService,
		@IEditorService private readonly editorService: IEditorService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatEntitlementService entitlementService: IChatEntitlementService,
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		this.enabled = observableFromEvent(this, Event.any(
			entitlementService.onDidChangeSentiment,
			Event.filter(configurationService.onDidChangeConfiguration, event => event.affectsConfiguration(CanvasesEnabledSettingId)),
		), () => !entitlementService.sentiment.hidden && configurationService.getValue<boolean>(CanvasesEnabledSettingId) === true);
		this.reopenableCanvases = derived(this, reader => {
			this.dismissedChanged.read(reader);
			if (!this.enabled.read(reader)) {
				return [];
			}
			const targets: ICanvasReopenTarget[] = [];
			for (const { reference } of this.dismissed.values()) {
				if (!contextService.isOwnerVisible(reference, reader)) {
					continue;
				}
				const context = contextService.contexts.read(reader).find(context => isCanvasOwner(context.owner, reference));
				const canvas = context?.canvases.read(reader)?.find(canvas => isEqual(canvas.resource, reference.canvas));
				if (canvas?.source !== undefined) {
					targets.push({ reference, canvas });
				}
			}
			return targets;
		});
		this._register(contextService.onDidRemoveOwner(owner => this.removeOwner(owner)));
		this._register(autorun(reader => {
			const enabled = this.enabled.read(reader);
			const contexts = contextService.contexts.read(reader);
			const knownOwners = new Set<string>();
			const liveKeys = new Set<string>();
			for (const context of contexts) {
				const canvases = context.canvases.read(reader);
				if (canvases === undefined) {
					continue;
				}
				knownOwners.add(canvasOwnerKey(context.owner));
				const visible = enabled && contextService.isOwnerVisible(context.owner, reader);
				const requests = context.openRequests?.read(reader);
				for (const canvas of canvases) {
					const reference: ICanvasReference = { ...context.owner, canvas: canvas.resource };
					const key = getCanvasReferenceKey(reference);
					liveKeys.add(key);
					let input = this.inputs.get(key);
					input?.setCanvas(canvas);
					const request = canvas.instanceId ? requests?.get(canvas.instanceId) : undefined;
					if (request || !this.requests.has(key)) {
						this.requests.set(key, request?.id);
					}
					const requestId = this.requests.get(key);
					const dismissed = this.dismissed.get(key);
					if (!visible || canvas.source === undefined
						|| (dismissed && (dismissed.requestId === requestId || !request?.succeeded))
						|| (this.presented.has(key) && (this.presented.get(key) === requestId || !request?.succeeded))) {
						continue;
					}
					this.deleteDismissed(key);
					if (input && request?.succeeded && this.editorService.isVisible(input)) {
						this.presented.set(key, requestId);
						continue;
					}
					input ??= this.getOrCreateInput(reference, canvas);
					this.revealInput(key, input);
				}
			}
			for (const [key, dismissed] of this.dismissed) {
				if (!enabled || (knownOwners.has(canvasOwnerKey(dismissed.reference)) && !liveKeys.has(key))) {
					this.deleteDismissed(key);
					this.requests.delete(key);
				}
			}
			for (const key of this.requests.keys()) {
				if (!liveKeys.has(key) && !this.inputs.has(key) && !this.dismissed.has(key)) {
					this.requests.delete(key);
				}
			}
			for (const [key, input] of this.inputs) {
				if (!enabled || (knownOwners.has(canvasOwnerKey(input.reference)) && !liveKeys.has(key))) {
					void this.closeInput(key, input).catch(error => this.reportError('Failed to close canvas', error));
				}
			}
		}));
	}

	isOwnerPresentable(reference: ICanvasReference, reader?: IReader): boolean {
		return this.enabled.read(reader)
			&& this.contextService.isOwnerVisible(reference, reader)
			&& this.contextService.contexts.read(reader).some(context => isCanvasOwner(context.owner, reference)
				&& context.canvases.read(reader)?.some(canvas => isEqual(canvas.resource, reference.canvas)));
	}

	async revealCanvas(reference: ICanvasReference): Promise<void> {
		const context = this.isOwnerPresentable(reference)
			? this.contextService.contexts.get().find(context => isCanvasOwner(context.owner, reference))
			: undefined;
		const canvas = context?.canvases.get()?.find(canvas => isEqual(canvas.resource, reference.canvas));
		if (canvas?.source === undefined) {
			return;
		}
		const key = getCanvasReferenceKey(reference);
		const input = this.getOrCreateInput(reference, canvas);
		input.setCanvas(canvas);
		this.pendingOpens.add(input);
		this.deleteDismissed(key);
		await this.doRevealInput(key, input);
	}

	async reopenCanvas(reference: ICanvasReference): Promise<void> {
		if (!this.dismissed.has(getCanvasReferenceKey(reference))) {
			return;
		}
		await this.revealCanvas(reference);
	}

	private getOrCreateInput(reference: ICanvasReference, canvas: ICanvas): CanvasInput {
		const key = getCanvasReferenceKey(reference);
		const existing = this.inputs.get(key);
		if (existing && !existing.isDisposed()) {
			return existing;
		}
		const input = this.instantiationService.createInstance(CanvasInput, reference, canvas);
		this.inputs.set(key, input);
		const lifetime = new DisposableStore();
		this.inputLifetimes.set(key, lifetime);
		lifetime.add(Event.once(input.onWillDispose)(() => {
			if (!this._store.isDisposed && this.inputs.get(key) === input && !this.programmaticCloses.has(input)) {
				this.rememberDismissed(key, reference);
			}
			if (this.inputs.get(key) === input) {
				this.inputs.deleteAndLeak(key);
				this.inputLifetimes.deleteAndLeak(key);
				this.presented.delete(key);
			}
			lifetime.dispose();
		}));
		return input;
	}

	private revealInput(key: string, input: CanvasInput): void {
		if (this.pendingOpens.has(input) || this.programmaticCloses.has(input)) {
			return;
		}
		this.pendingOpens.add(input);
		void this.doRevealInput(key, input).catch(error => this.reportError('Failed to reveal canvas', error));
	}

	private async doRevealInput(key: string, input: CanvasInput): Promise<void> {
		const canvas = input.canvas.get();
		if (!canvas) {
			this.pendingOpens.delete(input);
			throw new Error(localize('canvas.closed', "This canvas is no longer available."));
		}
		const source = canvas.source;
		try {
			if (!this.isOwnerPresentable(input.reference)) {
				return;
			}
			const group = this.contextService.getEditorGroup(input.reference, input);
			const pane = await this.editorService.openEditor(input, { pinned: true, revealIfOpened: true, preserveFocus: false }, group);
			if (this._store.isDisposed || input.isDisposed() || this.inputs.get(key) !== input) {
				await this.closeEditors(input);
				return;
			}
			if (!this.isOwnerPresentable(input.reference)) {
				await this.closeInput(key, input);
				return;
			}
			const opened = pane || this.editorService.findEditors(input.resource).some(identifier => !identifier.editor.isDisposed() && identifier.editor.matches(input));
			if (!opened) {
				throw new Error(localize('canvas.openFailed', "Canvas editor failed to open"));
			}
			this.presented.set(key, this.requests.get(key));
		} catch (error) {
			if (this.inputs.get(key) === input) {
				this.presented.delete(key);
				if (this.enabled.get() && !input.isDisposed()) {
					this.rememberDismissed(key, input.reference);
				}
			}
			throw error;
		} finally {
			this.pendingOpens.delete(input);
			if (!this.presented.has(key) && !isEqual(input.canvas.get()?.source, source) && input.canvas.get()?.source && !input.isDisposed() && this.isOwnerPresentable(input.reference)) {
				this.revealInput(key, input);
			}
		}
	}

	private removeOwner(owner: ICanvasOwner): void {
		for (const [key, dismissed] of this.dismissed) {
			if (isCanvasOwner(dismissed.reference, owner)) {
				this.deleteDismissed(key);
				this.requests.delete(key);
			}
		}
		for (const [key, input] of this.inputs) {
			if (isCanvasOwner(input.reference, owner)) {
				void this.closeInput(key, input).catch(error => this.reportError('Failed to close canvas', error));
			}
		}
	}

	private async closeInput(key: string, input: CanvasInput): Promise<void> {
		if (this.programmaticCloses.has(input)) {
			return;
		}
		this.programmaticCloses.add(input);
		if (this.inputs.get(key) === input) {
			this.inputs.deleteAndLeak(key);
		}
		const lifetime = this.inputLifetimes.deleteAndLeak(key);
		this.deleteDismissed(key);
		this.presented.delete(key);
		this.requests.delete(key);
		try {
			await this.closeEditors(input);
		} finally {
			input.dispose();
			lifetime?.dispose();
			this.programmaticCloses.delete(input);
		}
	}

	private closeEditors(input: CanvasInput): Promise<void> {
		return this.editorService.closeEditors(this.editorService.findEditors(input.resource).filter(editor => editor.editor === input), { preserveFocus: true });
	}

	private reportError(message: string, error: Error): void {
		this.logService.error(`[CanvasService] ${message}`, error);
		this.notificationService.error(error);
	}

	private rememberDismissed(key: string, reference: ICanvasReference): void {
		this.dismissed.delete(key);
		this.dismissed.set(key, { reference, requestId: this.requests.get(key) });
		this.dismissedChanged.trigger(undefined);
	}

	private deleteDismissed(key: string): void {
		if (this.dismissed.delete(key)) {
			this.dismissedChanged.trigger(undefined);
		}
	}
}
