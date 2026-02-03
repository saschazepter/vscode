/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { registerAction2, Action2, MenuId } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IChatSessionsService } from '../../common/chatSessionsService.js';
import { AgentSessionProviders, getAgentSessionProviderName } from './agentSessions.js';
import { AgentSessionStatus, IAgentSession } from './agentSessionsModel.js';
import { IAgentSessionsFilter } from './agentSessionsViewer.js';
import { IAgentSessionsFilterExcludes, IAgentSessionsViewerService } from './agentSessionsViewerService.js';

export enum AgentSessionsGrouping {
	Capped = 'capped',
	Date = 'date'
}

export interface IAgentSessionsFilterOptions extends Partial<IAgentSessionsFilter> {

	readonly filterMenuId: MenuId;

	readonly limitResults?: () => number | undefined;
	notifyResults?(count: number): void;

	readonly groupResults?: () => AgentSessionsGrouping | undefined;

	overrideExclude?(session: IAgentSession): boolean | undefined;
}

export class AgentSessionsFilter extends Disposable implements Required<IAgentSessionsFilter> {

	readonly onDidChange = this.agentSessionsService.onDidChangeFilterExcludes;

	readonly limitResults = () => this.options.limitResults?.();
	readonly groupResults = () => this.options.groupResults?.();

	private readonly actionDisposables = this._register(new DisposableStore());

	constructor(
		private readonly options: IAgentSessionsFilterOptions,
		@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,
		@IAgentSessionsViewerService private readonly agentSessionsService: IAgentSessionsViewerService,
	) {
		super();

		this.updateFilterActions();
		this.registerListeners();
	}

	private registerListeners(): void {
		this._register(this.chatSessionsService.onDidChangeItemsProviders(() => this.updateFilterActions()));
		this._register(this.chatSessionsService.onDidChangeAvailability(() => this.updateFilterActions()));
		this._register(this.agentSessionsService.onDidChangeFilterExcludes(() => this.updateFilterActions()));
	}

	private get excludes(): IAgentSessionsFilterExcludes {
		return this.agentSessionsService.getFilterExcludes();
	}

	private setExcludes(excludes: IAgentSessionsFilterExcludes): void {
		this.agentSessionsService.setFilterExcludes(excludes);
	}

	private updateFilterActions(): void {
		this.actionDisposables.clear();

		this.registerProviderActions(this.actionDisposables);
		this.registerStateActions(this.actionDisposables);
		this.registerArchivedActions(this.actionDisposables);
		this.registerReadActions(this.actionDisposables);
		this.registerResetAction(this.actionDisposables);
	}

	private registerProviderActions(disposables: DisposableStore): void {
		const providers: { id: string; label: string }[] = Object.values(AgentSessionProviders).map(provider => ({
			id: provider,
			label: getAgentSessionProviderName(provider)
		}));

		for (const provider of this.chatSessionsService.getAllChatSessionContributions()) {
			if (providers.find(p => p.id === provider.type)) {
				continue; // already added
			}

			providers.push({ id: provider.type, label: provider.name });
		}

		const that = this;
		let counter = 0;
		for (const provider of providers) {
			disposables.add(registerAction2(class extends Action2 {
				constructor() {
					super({
						id: `agentSessions.filter.toggleExclude:${provider.id}.${that.options.filterMenuId.id.toLowerCase()}`,
						title: provider.label,
						menu: {
							id: that.options.filterMenuId,
							group: '1_providers',
							order: counter++,
						},
						toggled: that.excludes.providers.includes(provider.id) ? ContextKeyExpr.false() : ContextKeyExpr.true(),
					});
				}
				run(): void {
					const providerExcludes = new Set(that.excludes.providers);
					if (!providerExcludes.delete(provider.id)) {
						providerExcludes.add(provider.id);
					}

					that.setExcludes({ ...that.excludes, providers: Array.from(providerExcludes) });
				}
			}));
		}
	}

	private registerStateActions(disposables: DisposableStore): void {
		const states: { id: AgentSessionStatus; label: string }[] = [
			{ id: AgentSessionStatus.Completed, label: localize('agentSessionStatus.completed', "Completed") },
			{ id: AgentSessionStatus.InProgress, label: localize('agentSessionStatus.inProgress', "In Progress") },
			{ id: AgentSessionStatus.NeedsInput, label: localize('agentSessionStatus.needsInput', "Input Needed") },
			{ id: AgentSessionStatus.Failed, label: localize('agentSessionStatus.failed', "Failed") },
		];

		const that = this;
		let counter = 0;
		for (const state of states) {
			disposables.add(registerAction2(class extends Action2 {
				constructor() {
					super({
						id: `agentSessions.filter.toggleExcludeState:${state.id}.${that.options.filterMenuId.id.toLowerCase()}`,
						title: state.label,
						menu: {
							id: that.options.filterMenuId,
							group: '2_states',
							order: counter++,
						},
						toggled: that.excludes.states.includes(state.id) ? ContextKeyExpr.false() : ContextKeyExpr.true(),
					});
				}
				run(): void {
					const stateExcludes = new Set(that.excludes.states);
					if (!stateExcludes.delete(state.id)) {
						stateExcludes.add(state.id);
					}

					that.setExcludes({ ...that.excludes, states: Array.from(stateExcludes) });
				}
			}));
		}
	}

	private registerArchivedActions(disposables: DisposableStore): void {
		const that = this;
		disposables.add(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: `agentSessions.filter.toggleExcludeArchived.${that.options.filterMenuId.id.toLowerCase()}`,
					title: localize('agentSessions.filter.archived', 'Archived'),
					menu: {
						id: that.options.filterMenuId,
						group: '3_props',
						order: 1000,
					},
					toggled: that.excludes.archived ? ContextKeyExpr.false() : ContextKeyExpr.true(),
				});
			}
			run(): void {
				that.setExcludes({ ...that.excludes, archived: !that.excludes.archived });
			}
		}));
	}

	private registerReadActions(disposables: DisposableStore): void {
		const that = this;
		disposables.add(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: `agentSessions.filter.toggleExcludeRead.${that.options.filterMenuId.id.toLowerCase()}`,
					title: localize('agentSessions.filter.read', 'Read'),
					menu: {
						id: that.options.filterMenuId,
						group: '3_props',
						order: 0,
					},
					toggled: that.excludes.read ? ContextKeyExpr.false() : ContextKeyExpr.true(),
				});
			}
			run(): void {
				that.setExcludes({ ...that.excludes, read: !that.excludes.read });
			}
		}));
	}

	private registerResetAction(disposables: DisposableStore): void {
		const that = this;
		disposables.add(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: `agentSessions.filter.resetExcludes.${that.options.filterMenuId.id.toLowerCase()}`,
					title: localize('agentSessions.filter.reset', "Reset"),
					menu: {
						id: that.options.filterMenuId,
						group: '4_reset',
						order: 0,
					},
				});
			}
			run(): void {
				that.agentSessionsService.resetFilterExcludes();
			}
		}));
	}

	isDefault(): boolean {
		return this.agentSessionsService.isDefaultFilterExcludes();
	}

	getExcludes(): IAgentSessionsFilterExcludes {
		return this.excludes;
	}

	exclude(session: IAgentSession): boolean {
		const overrideExclude = this.options?.overrideExclude?.(session);
		if (typeof overrideExclude === 'boolean') {
			return overrideExclude;
		}

		// Use the service for core filtering logic (read, provider, status)
		if (this.agentSessionsService.excludeSession(session)) {
			return true;
		}

		// Handle archived sessions separately since it depends on groupResults
		const excludes = this.excludes;
		if (excludes.archived && this.groupResults?.() === AgentSessionsGrouping.Capped && session.isArchived()) {
			return true; // exclude archived sessions when grouped by capped where we have no "Archived" group
		}

		return false;
	}

	notifyResults(count: number): void {
		this.options.notifyResults?.(count);
	}
}
