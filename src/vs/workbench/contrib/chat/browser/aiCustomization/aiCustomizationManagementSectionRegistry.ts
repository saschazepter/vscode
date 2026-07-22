/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension } from '../../../../../base/browser/dom.js';
import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { AICustomizationManagementSection } from '../../common/aiCustomizationWorkspaceService.js';

export interface IAICustomizationManagementSectionWidget extends IDisposable {
	layout?(dimension: Dimension): void;
	focus?(): void;
}

export interface IAICustomizationManagementSectionContribution {
	readonly id: AICustomizationManagementSection;
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly description: string;
	readonly supportsHarness: (harnessId: string) => boolean;
	create(instantiationService: IInstantiationService, container: HTMLElement): IAICustomizationManagementSectionWidget;
}

class AICustomizationManagementSectionRegistry {
	private readonly contributions = new Map<AICustomizationManagementSection, IAICustomizationManagementSectionContribution>();

	register(contribution: IAICustomizationManagementSectionContribution): IDisposable {
		this.contributions.set(contribution.id, contribution);
		return toDisposable(() => this.contributions.delete(contribution.id));
	}

	get(id: AICustomizationManagementSection): IAICustomizationManagementSectionContribution | undefined {
		return this.contributions.get(id);
	}
}

export const aiCustomizationManagementSectionRegistry = new AICustomizationManagementSectionRegistry();
