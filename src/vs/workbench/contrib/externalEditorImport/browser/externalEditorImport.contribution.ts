/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isWeb } from '../../../../base/common/platform.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IExternalEditorImportResult, IExternalEditorImportService, IExternalEditorSource } from '../common/externalEditorImport.js';
import { ExternalEditorImportService } from './externalEditorImportService.js';

registerSingleton(IExternalEditorImportService, ExternalEditorImportService, InstantiationType.Delayed);

const EXTERNAL_IMPORT_PROMPTED_KEY = 'externalEditorImport.prompted';

/**
 * Imports everything the source offers and reports the outcome to the user.
 */
export async function runExternalEditorImport(
	source: IExternalEditorSource,
	importService: IExternalEditorImportService,
	notificationService: INotificationService,
	progressService: IProgressService,
): Promise<IExternalEditorImportResult> {
	const result = await progressService.withProgress(
		{ location: ProgressLocation.Notification, title: localize('externalImport.progress', "Importing customizations from {0}\u2026", source.label) },
		() => importService.import(source, { settings: true, keybindings: true, snippets: true, extensions: true }, CancellationToken.None),
	);

	const parts: string[] = [];
	if (result.settingsImported > 0) {
		parts.push(localize('externalImport.settingsCount', "{0} settings", result.settingsImported));
	}
	if (result.keybindingsImported) {
		parts.push(localize('externalImport.keybindings', "keyboard shortcuts"));
	}
	if (result.snippetsImported > 0) {
		parts.push(localize('externalImport.snippetsCount', "{0} snippet files", result.snippetsImported));
	}
	if (result.extensionsInstalled > 0) {
		parts.push(localize('externalImport.extensionsCount', "{0} extensions", result.extensionsInstalled));
	}

	if (parts.length === 0) {
		if (result.extensionsFailed > 0) {
			notificationService.notify({
				severity: Severity.Warning,
				message: localize('externalImport.failed', "Some customizations from {0} could not be imported. You can try again later from the Command Palette.", source.label),
			});
		} else {
			notificationService.info(localize('externalImport.nothing', "Nothing new to import from {0} \u2014 your customizations are already up to date.", source.label));
		}
	} else if (result.extensionsFailed > 0) {
		notificationService.notify({
			severity: Severity.Warning,
			message: localize('externalImport.donePartial', "Imported {0} from {1}. Some extensions could not be imported.", parts.join(', '), source.label),
		});
	} else {
		notificationService.info(localize('externalImport.done', "Imported {0} from {1}.", parts.join(', '), source.label));
	}

	return result;
}

/**
 * Offers returning users a one-click way to import their customizations from a
 * detected source editor (e.g. Cursor). First-time users are handled by the
 * onboarding modal instead.
 */
export class ExternalEditorImportNotificationContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.externalEditorImportNotification';

	constructor(
		@IExternalEditorImportService private readonly importService: IExternalEditorImportService,
		@INotificationService private readonly notificationService: INotificationService,
		@IStorageService private readonly storageService: IStorageService,
		@IProgressService private readonly progressService: IProgressService,
	) {
		super();

		if (isWeb) {
			return; // local detection is only possible on desktop
		}

		if (this.storageService.isNew(StorageScope.APPLICATION)) {
			return; // brand-new users are handled by the onboarding modal
		}

		if (this.storageService.getBoolean(EXTERNAL_IMPORT_PROMPTED_KEY, StorageScope.APPLICATION)) {
			return; // already offered before
		}

		this.tryPrompt();
	}

	private async tryPrompt(): Promise<void> {
		let sources: IExternalEditorSource[];
		try {
			sources = await this.importService.detectSources(CancellationToken.None);
		} catch {
			return;
		}

		const source = sources[0];
		if (!source) {
			return;
		}

		// Mark as prompted regardless of the user's choice so we never nag.
		this.storageService.store(EXTERNAL_IMPORT_PROMPTED_KEY, true, StorageScope.APPLICATION, StorageTarget.USER);

		this.notificationService.prompt(
			Severity.Info,
			localize('externalImport.prompt', "We noticed {0} is installed. Want to bring your settings, keyboard shortcuts, and extensions over to VS Code?", source.label),
			[
				{
					label: localize('externalImport.prompt.import', "Import from {0}", source.label),
					run: () => { runExternalEditorImport(source, this.importService, this.notificationService, this.progressService); },
				},
				{
					label: localize('externalImport.prompt.notNow', "Not Now"),
					run: () => { },
				},
			],
		);
	}
}

registerWorkbenchContribution2(ExternalEditorImportNotificationContribution.ID, ExternalEditorImportNotificationContribution, WorkbenchPhase.Eventually);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.importFromExternalEditor',
			title: localize2('externalImport.action', "Import Settings and Extensions from Another Editor..."),
			category: Categories.Preferences,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const importService = accessor.get(IExternalEditorImportService);
		const notificationService = accessor.get(INotificationService);
		const progressService = accessor.get(IProgressService);

		const sources = await importService.detectSources(CancellationToken.None);
		const source = sources[0];
		if (!source) {
			notificationService.info(localize('externalImport.none', "No other editors with importable customizations were found on this machine."));
			return;
		}

		await runExternalEditorImport(source, importService, notificationService, progressService);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.importFromCursor',
			title: localize2('externalImport.cursorAction', "Import Settings and Extensions from Cursor"),
			category: Categories.Preferences,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const importService = accessor.get(IExternalEditorImportService);
		const notificationService = accessor.get(INotificationService);
		const progressService = accessor.get(IProgressService);

		const sources = await importService.detectSources(CancellationToken.None);
		const source = sources.find(candidate => candidate.id === 'cursor');
		if (!source) {
			notificationService.info(localize('externalImport.cursor.none', "Cursor with importable customizations was not found on this machine."));
			return;
		}

		await runExternalEditorImport(source, importService, notificationService, progressService);
	}
});
