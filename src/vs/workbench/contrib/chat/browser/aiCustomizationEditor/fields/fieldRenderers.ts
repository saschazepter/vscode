/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../../../base/browser/ui/inputbox/inputBox.js';
import { Toggle } from '../../../../../../base/browser/ui/toggle/toggle.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { localize } from '../../../../../../nls.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { defaultButtonStyles, defaultInputBoxStyles, defaultToggleStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';

const $ = DOM.$;

//#region Field Types

export type FieldValue = string | string[] | boolean | undefined;

export interface IFieldDefinition {
	readonly id: string;
	readonly key: string;
	readonly label: string;
	readonly description?: string;
	readonly type: 'text' | 'multiline' | 'array' | 'checkbox' | 'readonly';
	readonly placeholder?: string;
	readonly required?: boolean;
}

export interface IFieldRendererOptions {
	readonly contextViewService: IContextViewService;
	readonly hoverService: IHoverService;
}

//#endregion

//#region Base Field Renderer

export interface IFieldChangeEvent {
	readonly fieldId: string;
	readonly value: FieldValue;
}

export abstract class BaseFieldRenderer extends Disposable {
	protected readonly _onDidChange = this._register(new Emitter<IFieldChangeEvent>());
	readonly onDidChange: Event<IFieldChangeEvent> = this._onDidChange.event;

	constructor(
		protected readonly definition: IFieldDefinition,
		protected readonly options: IFieldRendererOptions,
	) {
		super();
	}

	abstract render(container: HTMLElement): void;
	abstract setValue(value: FieldValue): void;
	abstract getValue(): FieldValue;
	abstract focus(): void;
}

//#endregion

//#region Text Field Renderer

export class TextFieldRenderer extends BaseFieldRenderer {
	private inputBox: InputBox | undefined;
	private container: HTMLElement | undefined;

	render(container: HTMLElement): void {
		this.container = DOM.append(container, $('.ai-customization-field-item'));

		// Label
		const labelElement = DOM.append(this.container, $('.field-label'));
		labelElement.textContent = this.definition.label;
		if (this.definition.required) {
			DOM.append(labelElement, $('span.required', undefined, '*'));
		}

		// Description
		if (this.definition.description) {
			const descElement = DOM.append(this.container, $('.field-description'));
			descElement.textContent = this.definition.description;
		}

		// Control
		const controlElement = DOM.append(this.container, $('.field-control'));
		this.inputBox = this._register(new InputBox(controlElement, this.options.contextViewService, {
			placeholder: this.definition.placeholder,
			inputBoxStyles: defaultInputBoxStyles,
		}));

		this._register(this.inputBox.onDidChange(value => {
			this._onDidChange.fire({ fieldId: this.definition.id, value });
		}));
	}

	setValue(value: FieldValue): void {
		if (this.inputBox && typeof value === 'string') {
			this.inputBox.value = value;
		} else if (this.inputBox && value === undefined) {
			this.inputBox.value = '';
		}
	}

	getValue(): FieldValue {
		return this.inputBox?.value || undefined;
	}

	focus(): void {
		this.inputBox?.focus();
	}
}

//#endregion

//#region Multiline Field Renderer

export class MultilineFieldRenderer extends BaseFieldRenderer {
	private textArea: HTMLTextAreaElement | undefined;
	private container: HTMLElement | undefined;

	render(container: HTMLElement): void {
		this.container = DOM.append(container, $('.ai-customization-field-item.multiline-field'));

		// Label
		const labelElement = DOM.append(this.container, $('.field-label'));
		labelElement.textContent = this.definition.label;
		if (this.definition.required) {
			DOM.append(labelElement, $('span.required', undefined, '*'));
		}

		// Description
		if (this.definition.description) {
			const descElement = DOM.append(this.container, $('.field-description'));
			descElement.textContent = this.definition.description;
		}

		// Control
		const controlElement = DOM.append(this.container, $('.field-control'));
		this.textArea = DOM.append(controlElement, $('textarea', {
			placeholder: this.definition.placeholder || '',
			rows: 8,
		}));

		this._register(DOM.addDisposableListener(this.textArea, 'input', () => {
			this._onDidChange.fire({ fieldId: this.definition.id, value: this.textArea?.value });
		}));
	}

	setValue(value: FieldValue): void {
		if (this.textArea && typeof value === 'string') {
			this.textArea.value = value;
		} else if (this.textArea && value === undefined) {
			this.textArea.value = '';
		}
	}

	getValue(): FieldValue {
		return this.textArea?.value || undefined;
	}

	focus(): void {
		this.textArea?.focus();
	}
}

//#endregion

//#region Checkbox Field Renderer

export class CheckboxFieldRenderer extends BaseFieldRenderer {
	private toggle: Toggle | undefined;
	private container: HTMLElement | undefined;

	render(container: HTMLElement): void {
		this.container = DOM.append(container, $('.ai-customization-field-item.checkbox-field'));

		// Control comes first for checkbox
		const controlElement = DOM.append(this.container, $('.field-control'));
		this.toggle = this._register(new Toggle({
			title: this.definition.label,
			isChecked: false,
			...defaultToggleStyles,
		}));
		controlElement.appendChild(this.toggle.domNode);

		// Label
		const labelElement = DOM.append(this.container, $('.field-label'));
		labelElement.textContent = this.definition.label;

		this._register(this.toggle.onChange(() => {
			this._onDidChange.fire({ fieldId: this.definition.id, value: this.toggle?.checked });
		}));
	}

	setValue(value: FieldValue): void {
		if (this.toggle && typeof value === 'boolean') {
			this.toggle.checked = value;
		} else if (this.toggle) {
			this.toggle.checked = false;
		}
	}

	getValue(): FieldValue {
		return this.toggle?.checked ?? false;
	}

	focus(): void {
		this.toggle?.domNode.focus();
	}
}

//#endregion

//#region Array Field Renderer

interface IArrayItem {
	readonly container: HTMLElement;
	readonly input: InputBox;
	readonly removeButton: Button;
	readonly disposables: DisposableStore;
}

export class ArrayFieldRenderer extends BaseFieldRenderer {
	private container: HTMLElement | undefined;
	private itemsContainer: HTMLElement | undefined;
	private items: IArrayItem[] = [];
	private addButton: Button | undefined;

	render(container: HTMLElement): void {
		this.container = DOM.append(container, $('.ai-customization-field-item.ai-customization-array-field'));

		// Label
		const labelElement = DOM.append(this.container, $('.field-label'));
		labelElement.textContent = this.definition.label;
		if (this.definition.required) {
			DOM.append(labelElement, $('span.required', undefined, '*'));
		}

		// Description
		if (this.definition.description) {
			const descElement = DOM.append(this.container, $('.field-description'));
			descElement.textContent = this.definition.description;
		}

		// Items container
		this.itemsContainer = DOM.append(this.container, $('.array-items'));

		// Add button
		const buttonContainer = DOM.append(this.container, $('.add-item-button'));
		this.addButton = this._register(new Button(buttonContainer, {
			title: localize('addItem', "Add Item"),
			...defaultButtonStyles,
		}));
		this.addButton.label = localize('addItem', "Add Item");
		this.addButton.element.classList.add('monaco-text-button');

		this._register(this.addButton.onDidClick(() => {
			this.addItem('');
			this.fireChange();
		}));
	}

	private addItem(value: string): IArrayItem {
		const disposables = new DisposableStore();
		const itemContainer = DOM.append(this.itemsContainer!, $('.array-item'));

		const input = disposables.add(new InputBox(itemContainer, this.options.contextViewService, {
			placeholder: this.definition.placeholder,
			inputBoxStyles: defaultInputBoxStyles,
		}));
		input.value = value;

		disposables.add(input.onDidChange(() => this.fireChange()));

		const removeButton = disposables.add(new Button(itemContainer, {
			title: localize('removeItem', "Remove"),
			secondary: true,
			...defaultButtonStyles,
		}));
		removeButton.icon = Codicon.close;
		removeButton.element.classList.add('monaco-icon-button');

		disposables.add(removeButton.onDidClick(() => {
			this.removeItem(item);
			this.fireChange();
		}));

		const item: IArrayItem = { container: itemContainer, input, removeButton, disposables };
		this.items.push(item);
		return item;
	}

	private removeItem(item: IArrayItem): void {
		const index = this.items.indexOf(item);
		if (index >= 0) {
			this.items.splice(index, 1);
			item.container.remove();
			item.disposables.dispose();
		}
	}

	private fireChange(): void {
		this._onDidChange.fire({ fieldId: this.definition.id, value: this.getValue() });
	}

	setValue(value: FieldValue): void {
		// Clear existing items
		for (const item of this.items) {
			item.container.remove();
			item.disposables.dispose();
		}
		this.items = [];

		// Add new items
		if (Array.isArray(value)) {
			for (const v of value) {
				this.addItem(v);
			}
		}
	}

	getValue(): FieldValue {
		return this.items.map(item => item.input.value).filter(v => v.length > 0);
	}

	focus(): void {
		this.items[0]?.input.focus();
	}

	override dispose(): void {
		for (const item of this.items) {
			item.disposables.dispose();
		}
		this.items = [];
		super.dispose();
	}
}

//#endregion

//#region Readonly Field Renderer

export class ReadonlyFieldRenderer extends BaseFieldRenderer {
	private container: HTMLElement | undefined;
	private valueElement: HTMLElement | undefined;

	render(container: HTMLElement): void {
		this.container = DOM.append(container, $('.ai-customization-field-item.readonly-field'));

		// Label
		const labelElement = DOM.append(this.container, $('.field-label'));
		labelElement.textContent = this.definition.label;

		// Value
		this.valueElement = DOM.append(this.container, $('.field-value'));
	}

	setValue(value: FieldValue): void {
		if (this.valueElement) {
			if (Array.isArray(value)) {
				this.valueElement.textContent = value.join(', ');
			} else if (typeof value === 'boolean') {
				this.valueElement.textContent = value ? localize('yes', "Yes") : localize('no', "No");
			} else {
				this.valueElement.textContent = value ?? '';
			}
		}
	}

	getValue(): FieldValue {
		return undefined; // Readonly fields don't return values
	}

	focus(): void {
		// Readonly fields don't focus
	}
}

//#endregion

//#region Field Renderer Factory

export function createFieldRenderer(
	definition: IFieldDefinition,
	options: IFieldRendererOptions,
): BaseFieldRenderer {
	switch (definition.type) {
		case 'text':
			return new TextFieldRenderer(definition, options);
		case 'multiline':
			return new MultilineFieldRenderer(definition, options);
		case 'checkbox':
			return new CheckboxFieldRenderer(definition, options);
		case 'array':
			return new ArrayFieldRenderer(definition, options);
		case 'readonly':
			return new ReadonlyFieldRenderer(definition, options);
		default:
			return new TextFieldRenderer(definition, options);
	}
}

//#endregion

//#region Section Renderer

export interface ISectionDefinition {
	readonly id: string;
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly fields: IFieldDefinition[];
}

export class SectionRenderer extends Disposable {
	private readonly _onDidChange = this._register(new Emitter<IFieldChangeEvent>());
	readonly onDidChange: Event<IFieldChangeEvent> = this._onDidChange.event;

	private container: HTMLElement | undefined;
	private readonly fieldRenderers = new Map<string, BaseFieldRenderer>();

	constructor(
		private readonly definition: ISectionDefinition,
		private readonly options: IFieldRendererOptions,
	) {
		super();
	}

	render(container: HTMLElement): HTMLElement {
		this.container = DOM.append(container, $('.ai-customization-field-section'));
		this.container.id = `section-${this.definition.id}`;

		// Section header
		const header = DOM.append(this.container, $('.section-header'));
		const iconElement = DOM.append(header, $('.icon'));
		iconElement.classList.add(...ThemeIcon.asClassNameArray(this.definition.icon));
		DOM.append(header, $('span.label', undefined, this.definition.label));

		// Section content
		const content = DOM.append(this.container, $('.section-content'));

		// Render fields
		for (const fieldDef of this.definition.fields) {
			const renderer = createFieldRenderer(fieldDef, this.options);
			this._register(renderer);
			this.fieldRenderers.set(fieldDef.id, renderer);

			const fieldContainer = DOM.append(content, $('.field-wrapper'));
			renderer.render(fieldContainer);

			this._register(renderer.onDidChange(e => {
				this._onDidChange.fire(e);
			}));
		}

		return this.container;
	}

	getFieldRenderer(fieldId: string): BaseFieldRenderer | undefined {
		return this.fieldRenderers.get(fieldId);
	}

	setFieldValue(fieldId: string, value: FieldValue): void {
		this.fieldRenderers.get(fieldId)?.setValue(value);
	}

	getFieldValue(fieldId: string): FieldValue {
		return this.fieldRenderers.get(fieldId)?.getValue();
	}

	getElement(): HTMLElement | undefined {
		return this.container;
	}
}

//#endregion
