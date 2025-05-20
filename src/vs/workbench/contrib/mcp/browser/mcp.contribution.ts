/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import * as jsonContributionRegistry from '../../../../platform/jsonschemas/common/jsonContributionRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorExtensions } from '../../../common/editor.js';
import { IViewsRegistry, Extensions as ViewExtensions } from '../../../common/views.js';
import { mcpSchemaId } from '../../../services/configuration/common/configuration.js';
import { VIEW_CONTAINER } from '../../extensions/browser/extensions.contribution.js';
import { DefaultViewsContext, SearchMcpServersContext } from '../../extensions/common/extensions.js';
import { ConfigMcpDiscovery } from '../common/discovery/configMcpDiscovery.js';
import { ExtensionMcpDiscovery } from '../common/discovery/extensionMcpDiscovery.js';
import { mcpDiscoveryRegistry } from '../common/discovery/mcpDiscovery.js';
import { RemoteNativeMpcDiscovery } from '../common/discovery/nativeMcpRemoteDiscovery.js';
import { CursorWorkspaceMcpDiscoveryAdapter } from '../common/discovery/workspaceMcpDiscoveryAdapter.js';
import { IMcpConfigPathsService, McpConfigPathsService } from '../common/mcpConfigPathsService.js';
import { mcpServerSchema } from '../common/mcpConfiguration.js';
import { McpContextKeysController } from '../common/mcpContextKeys.js';
import { IMcpDevModeDebugging, McpDevModeDebugging } from '../common/mcpDevMode.js';
import { McpRegistry } from '../common/mcpRegistry.js';
import { IMcpRegistry } from '../common/mcpRegistryTypes.js';
import { McpService } from '../common/mcpService.js';
import { HasInstalledMcpServersContext, IMcpService, IMcpWorkbenchService, InstalledMcpServersViewId, McpServersGalleryEnabledContext } from '../common/mcpTypes.js';
import { AddConfigurationAction, EditStoredInput, InstallFromActivation, ListMcpServerCommand, McpBrowseCommand, MCPServerActionRendering, McpServerOptionsCommand, RemoveStoredInput, ResetMcpCachedTools, ResetMcpTrustCommand, RestartServer, ShowConfiguration, ShowOutput, StartServer, StopServer } from './mcpCommands.js';
import { McpDiscovery } from './mcpDiscovery.js';
import { McpLanguageFeatures } from './mcpLanguageFeatures.js';
import { McpServerEditor } from './mcpServerEditor.js';
import { McpServerEditorInput } from './mcpServerEditorInput.js';
import { McpServersListView } from './mcpServersView.js';
import { McpUrlHandler } from './mcpUrlHandler.js';
import { MCPContextsInitialisation, McpWorkbenchService } from './mcpWorkbenchService.js';

registerSingleton(IMcpRegistry, McpRegistry, InstantiationType.Delayed);
registerSingleton(IMcpService, McpService, InstantiationType.Delayed);
registerSingleton(IMcpWorkbenchService, McpWorkbenchService, InstantiationType.Eager);
registerSingleton(IMcpConfigPathsService, McpConfigPathsService, InstantiationType.Delayed);
registerSingleton(IMcpDevModeDebugging, McpDevModeDebugging, InstantiationType.Delayed);


mcpDiscoveryRegistry.register(new SyncDescriptor(RemoteNativeMpcDiscovery));
mcpDiscoveryRegistry.register(new SyncDescriptor(ConfigMcpDiscovery));
mcpDiscoveryRegistry.register(new SyncDescriptor(ExtensionMcpDiscovery));
mcpDiscoveryRegistry.register(new SyncDescriptor(CursorWorkspaceMcpDiscoveryAdapter));

registerWorkbenchContribution2('mcpDiscovery', McpDiscovery, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2('mcpContextKeys', McpContextKeysController, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2('mcpLanguageFeatures', McpLanguageFeatures, WorkbenchPhase.Eventually);
registerWorkbenchContribution2('mcpUrlHandler', McpUrlHandler, WorkbenchPhase.BlockRestore);

registerAction2(ListMcpServerCommand);
registerAction2(McpServerOptionsCommand);
registerAction2(ResetMcpTrustCommand);
registerAction2(ResetMcpCachedTools);
registerAction2(AddConfigurationAction);
registerAction2(RemoveStoredInput);
registerAction2(EditStoredInput);
registerAction2(StartServer);
registerAction2(StopServer);
registerAction2(ShowOutput);
registerAction2(InstallFromActivation);
registerAction2(RestartServer);
registerAction2(ShowConfiguration);
registerAction2(McpBrowseCommand);

registerWorkbenchContribution2('mcpActionRendering', MCPServerActionRendering, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(MCPContextsInitialisation.ID, MCPContextsInitialisation, WorkbenchPhase.AfterRestored);

const jsonRegistry = <jsonContributionRegistry.IJSONContributionRegistry>Registry.as(jsonContributionRegistry.Extensions.JSONContribution);
jsonRegistry.registerSchema(mcpSchemaId, mcpServerSchema);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([
	{
		id: InstalledMcpServersViewId,
		name: localize2('mcp-installed', "MCP Servers - Installed"),
		ctorDescriptor: new SyncDescriptor(McpServersListView),
		when: ContextKeyExpr.and(DefaultViewsContext, HasInstalledMcpServersContext, McpServersGalleryEnabledContext),
		weight: 40,
		order: 4,
		canToggleVisibility: true
	},
	{
		id: 'workbench.views.mcp.marketplace',
		name: localize2('mcp', "MCP Servers"),
		ctorDescriptor: new SyncDescriptor(McpServersListView),
		when: ContextKeyExpr.and(SearchMcpServersContext, McpServersGalleryEnabledContext),
	}
], VIEW_CONTAINER);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		McpServerEditor,
		McpServerEditor.ID,
		localize('mcpServer', "MCP Server")
	),
	[
		new SyncDescriptor(McpServerEditorInput)
	]);
