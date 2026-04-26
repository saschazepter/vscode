/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IRemoteAgentHostService, RemoteAgentHostConnectionStatus } from '../../../../platform/agentHost/common/remoteAgentHostService.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IOutputService } from '../../../../workbench/services/output/common/output.js';
import { IPreferencesService } from '../../../../workbench/services/preferences/common/preferences.js';
import { IAgentHostSessionsProvider } from '../../../common/agentHostSessionsProvider.js';

export function getStatusLabel(status: RemoteAgentHostConnectionStatus): string {
	switch (status) {
		case RemoteAgentHostConnectionStatus.Connected:
			return localize('workspacePicker.statusOnline', "Online");
		case RemoteAgentHostConnectionStatus.Connecting:
			return localize('workspacePicker.statusConnecting', "Connecting");
		case RemoteAgentHostConnectionStatus.Disconnected:
			return localize('workspacePicker.statusOffline', "Offline");
	}
}

export function getStatusHover(status: RemoteAgentHostConnectionStatus, address?: string): string {
	switch (status) {
		case RemoteAgentHostConnectionStatus.Connected:
			return address
				? localize('workspacePicker.hoverConnectedAddr', "Remote agent host is connected and ready.\n\nAddress: {0}", address)
				: localize('workspacePicker.hoverConnected', "Remote agent host is connected and ready.");
		case RemoteAgentHostConnectionStatus.Connecting:
			return address
				? localize('workspacePicker.hoverConnectingAddr', "Attempting to connect to remote agent host...\n\nAddress: {0}", address)
				: localize('workspacePicker.hoverConnecting', "Attempting to connect to remote agent host...");
		case RemoteAgentHostConnectionStatus.Disconnected:
			return address
				? localize('workspacePicker.hoverDisconnectedAddr', "Remote agent host is disconnected.\n\nAddress: {0}", address)
				: localize('workspacePicker.hoverDisconnected', "Remote agent host is disconnected.");
	}
}

/**
 * Show the per-remote management options quickpick (Reconnect / Remove /
 * Copy Address / Open Settings / Show Output) for the given provider.
 *
 * Used by both the Workspace Picker's Manage submenu and the F1
 * "Manage Remote Agent Hosts..." command, so both surfaces drive the
 * same actions. Callers that don't have a {@link ServicesAccessor} should
 * use `instantiationService.invokeFunction(accessor => showRemoteHostOptions(accessor, provider))`.
 */
export async function showRemoteHostOptions(accessor: ServicesAccessor, provider: IAgentHostSessionsProvider): Promise<void> {
	const address = provider.remoteAddress;
	if (!address) {
		return;
	}

	const quickInputService = accessor.get(IQuickInputService);
	const remoteAgentHostService = accessor.get(IRemoteAgentHostService);
	const clipboardService = accessor.get(IClipboardService);
	const preferencesService = accessor.get(IPreferencesService);
	const outputService = accessor.get(IOutputService);

	const status = provider.connectionStatus?.get();
	const isConnected = status === RemoteAgentHostConnectionStatus.Connected;

	const items: IQuickPickItem[] = [];
	if (!isConnected) {
		items.push({ label: '$(debug-restart) ' + localize('workspacePicker.reconnect', "Reconnect"), id: 'reconnect' });
	}
	items.push(
		{ label: '$(trash) ' + localize('workspacePicker.removeRemote', "Remove Remote"), id: 'remove' },
		{ label: '$(copy) ' + localize('workspacePicker.copyAddress', "Copy Address"), id: 'copy' },
		{ label: '$(settings-gear) ' + localize('workspacePicker.openSettings', "Open Settings"), id: 'settings' },
	);
	if (provider.outputChannelId) {
		items.push({ label: '$(output) ' + localize('workspacePicker.showOutput', "Show Output"), id: 'output' });
	}

	const picked = await quickInputService.pick(items, {
		placeHolder: localize('workspacePicker.remoteOptionsTitle', "Options for {0}", provider.label),
	});
	if (!picked) {
		return;
	}

	const action = (picked as IQuickPickItem & { id: string }).id;
	switch (action) {
		case 'reconnect':
			remoteAgentHostService.reconnect(address);
			break;
		case 'remove':
			await remoteAgentHostService.removeRemoteAgentHost(address);
			break;
		case 'copy':
			await clipboardService.writeText(address);
			break;
		case 'settings':
			await preferencesService.openSettings({ query: 'chat.remoteAgentHosts' });
			break;
		case 'output':
			if (provider.outputChannelId) {
				outputService.showChannel(provider.outputChannelId, true);
			}
			break;
	}
}

