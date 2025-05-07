/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable local/code-no-unexternalized-strings */

import { env } from '../../../base/common/process.js';
import { IProductConfiguration } from '../../../base/common/product.js';
import { ISandboxConfiguration } from '../../../base/parts/sandbox/common/sandboxTypes.js';

/**
 * @deprecated It is preferred that you use `IProductService` if you can. This
 * allows web embedders to override our defaults. But for things like `product.quality`,
 * the use is fine because that property is not overridable.
 */
let product: IProductConfiguration;

// Native sandbox environment
const vscodeGlobal = (globalThis as any).vscode;
if (typeof vscodeGlobal !== 'undefined' && typeof vscodeGlobal.context !== 'undefined') {
	const configuration: ISandboxConfiguration | undefined = vscodeGlobal.context.configuration();
	if (configuration) {
		product = configuration.product;
	} else {
		throw new Error('Sandbox: unable to resolve product configuration from preload script.');
	}
}
// _VSCODE environment
else if (globalThis._VSCODE_PRODUCT_JSON && globalThis._VSCODE_PACKAGE_JSON) {
	// Obtain values from product.json and package.json-data
	product = globalThis._VSCODE_PRODUCT_JSON as unknown as IProductConfiguration;

	// Running out of sources
	if (env['VSCODE_DEV']) {
		Object.assign(product, {
			nameShort: `${product.nameShort} Dev`,
			nameLong: `${product.nameLong} Dev`,
			dataFolderName: `${product.dataFolderName}-dev`,
			serverDataFolderName: product.serverDataFolderName ? `${product.serverDataFolderName}-dev` : undefined
		});
	}

	// Version is added during built time, but we still
	// want to have it running out of sources so we
	// read it from package.json only when we need it.
	if (!product.version) {
		const pkg = globalThis._VSCODE_PACKAGE_JSON as { version: string };

		Object.assign(product, {
			version: pkg.version
		});
	}
}

// Web environment or unknown
else {

	// Built time configuration (do NOT modify)
	product = { /*BUILD->INSERT_PRODUCT_CONFIGURATION*/ } as any;

	// Running out of sources
	if (Object.keys(product).length === 0) {
		Object.assign(product, {
			version: '1.95.0-dev',
			nameShort: 'Code - OSS Dev',
			nameLong: 'Code - OSS Dev',
			applicationName: 'code-oss',
			dataFolderName: '.vscode-oss',
			urlProtocol: 'code-oss',
			reportIssueUrl: 'https://github.com/microsoft/vscode/issues/new',
			licenseName: 'MIT',
			licenseUrl: 'https://github.com/microsoft/vscode/blob/main/LICENSE.txt',
			serverLicenseUrl: 'https://github.com/microsoft/vscode/blob/main/LICENSE.txt',
			"extensionsGallery": {
				"nlsBaseUrl": "https://www.vscode-unpkg.net/_lp/",
				"serviceUrl": "https://marketplace.visualstudio.com/_apis/public/gallery",
				"itemUrl": "https://marketplace.visualstudio.com/items",
				"publisherUrl": "https://marketplace.visualstudio.com/publishers",
				"resourceUrlTemplate": "https://{publisher}.vscode-unpkg.net/{publisher}/{name}/{version}/{path}",
				"extensionUrlTemplate": "https://www.vscode-unpkg.net/_gallery/{publisher}/{name}/latest",
				"controlUrl": "https://main.vscode-cdn.net/extensions/marketplace.json",
				"accessSKUs": [
					"copilot_enterprise_seat",
					"copilot_enterprise_seat_assignment",
					"copilot_enterprise_trial_seat",
					"copilot_for_business_seat",
					"copilot_for_business_seat_assignment",
					"copilot_for_business_trial_seat"
				]
			},
			"linkProtectionTrustedDomains": [
				"https://*.visualstudio.com",
				"https://*.microsoft.com",
				"https://aka.ms",
				"https://*.gallerycdn.vsassets.io",
				"https://*.github.com",
				"https://login.microsoftonline.com",
				"https://*.vscode.dev",
				"https://*.github.dev",
				"https://gh.io",
				"https://portal.azure.com",
				"https://raw.githubusercontent.com",
				"https://private-user-images.githubusercontent.com",
				"https://avatars.githubusercontent.com"
			],
			"trustedExtensionAuthAccess": {
				"github": [
					"vscode.git",
					"vscode.github",
					"github.remotehub",
					"ms-vscode.remote-server",
					"github.vscode-pull-request-github",
					"github.codespaces",
					"github.copilot",
					"github.copilot-chat",
					"ms-vsliveshare.vsliveshare",
					"ms-azuretools.vscode-azure-github-copilot"
				],
				"github-enterprise": [
					"vscode.git",
					"vscode.github",
					"github.remotehub",
					"ms-vscode.remote-server",
					"github.vscode-pull-request-github",
					"github.codespaces",
					"github.copilot",
					"github.copilot-chat",
					"ms-vsliveshare.vsliveshare",
					"ms-azuretools.vscode-azure-github-copilot"
				],
				"microsoft": [
					"vscode.git",
					"ms-vscode.azure-repos",
					"ms-vscode.remote-server",
					"ms-vsliveshare.vsliveshare",
					"ms-azuretools.vscode-azure-github-copilot",
					"ms-azuretools.vscode-azureresourcegroups",
					"ms-edu.vscode-learning",
					"ms-toolsai.vscode-ai",
					"ms-toolsai.vscode-ai-remote"
				],
				"microsoft-sovereign-cloud": [
					"vscode.git",
					"ms-vscode.azure-repos",
					"ms-vscode.remote-server",
					"ms-vsliveshare.vsliveshare",
					"ms-azuretools.vscode-azure-github-copilot",
					"ms-azuretools.vscode-azureresourcegroups",
					"ms-edu.vscode-learning",
					"ms-toolsai.vscode-ai",
					"ms-toolsai.vscode-ai-remote"
				],
				"__GitHub.copilot-chat": [
					"ms-azuretools.vscode-azure-github-copilot"
				]
			},
			"trustedExtensionProtocolHandlers": [
				"vscode.git",
				"vscode.github-authentication",
				"vscode.microsoft-authentication"
			],
			"trustedExtensionPublishers": [
				"microsoft",
				"github"
			],
			"inheritAuthAccountPreference": {
				"github.copilot": [
					"github.copilot-chat"
				]
			},
			"auth": {
				"loginUrl": "https://login.microsoftonline.com/common/oauth2/authorize",
				"tokenUrl": "https://login.microsoftonline.com/common/oauth2/token",
				"redirectUrl": "https://vscode-redirect.azurewebsites.net/",
				"clientId": "aebc6443-996d-45c2-90f0-388ff96faa56"
			},
			"configurationSync.store": {
				"url": "https://vscode-sync-insiders.trafficmanager.net/",
				"stableUrl": "https://vscode-sync.trafficmanager.net/",
				"insidersUrl": "https://vscode-sync-insiders.trafficmanager.net/",
				"canSwitch": true,
				"authenticationProviders": {
					"github": {
						"scopes": [
							"user:email"
						]
					},
					"microsoft": {
						"scopes": [
							"openid",
							"profile",
							"email",
							"offline_access"
						]
					}
				}
			},
			"defaultChatAgent": {
				"extensionId": "GitHub.copilot",
				"chatExtensionId": "GitHub.copilot-chat",
				"documentationUrl": "https://aka.ms/github-copilot-overview",
				"termsStatementUrl": "https://aka.ms/github-copilot-terms-statement",
				"privacyStatementUrl": "https://aka.ms/github-copilot-privacy-statement",
				"skusDocumentationUrl": "https://aka.ms/github-copilot-plans",
				"publicCodeMatchesUrl": "https://aka.ms/github-copilot-match-public-code",
				"manageSettingsUrl": "https://aka.ms/github-copilot-settings",
				"managePlanUrl": "https://aka.ms/github-copilot-manage-plan",
				"manageOverageUrl": "https://aka.ms/github-copilot-manage-overage",
				"upgradePlanUrl": "https://aka.ms/github-copilot-upgrade-plan",
				"providerId": "github",
				"providerName": "GitHub",
				"enterpriseProviderId": "github-enterprise",
				"enterpriseProviderName": "GHE.com",
				"providerUriSetting": "github-enterprise.uri",
				"providerScopes": [
					[
						"user:email"
					],
					[
						"read:user"
					],
					[
						"read:user",
						"user:email",
						"repo",
						"workflow"
					]
				],
				"entitlementUrl": "https://api.github.com/copilot_internal/user",
				"entitlementSignupLimitedUrl": "https://api.github.com/copilot_internal/subscribe_limited_user",
				"chatQuotaExceededContext": "github.copilot.chat.quotaExceeded",
				"completionsQuotaExceededContext": "github.copilot.completions.quotaExceeded",
				"walkthroughCommand": "github.copilot.open.walkthrough",
				"completionsMenuCommand": "github.copilot.toggleStatusMenu",
				"completionsRefreshTokenCommand": "github.copilot.signIn",
				"chatRefreshTokenCommand": "github.copilot.refreshToken",
				"completionsAdvancedSetting": "github.copilot.advanced",
				"completionsEnablementSetting": "github.copilot.enable",
				"nextEditSuggestionsSetting": "github.copilot.nextEditSuggestions.enabled"
			},
			"tunnelServerQualities": {
				"stable": {
					"serverApplicationName": "code-server"
				},
				"exploration": {
					"serverApplicationName": "code-server-exploration"
				},
				"insider": {
					"serverApplicationName": "code-server-insiders"
				}
			},
			"tunnelApplicationName": "code-tunnel-insiders",
			"tunnelApplicationConfig": {
				"editorWebUrl": "https://insiders.vscode.dev",
				"extension": {
					"friendlyName": "Remote - Tunnels",
					"extensionId": "ms-vscode.remote-server"
				},
				"authenticationProviders": {
					"github": {
						"scopes": [
							"user:email",
							"read:org"
						]
					},
					"microsoft": {
						"scopes": [
							"46da2f7e-b5ef-422a-88d4-2a7f9de6a0b2/.default",
							"profile",
							"openid"
						]
					}
				}
			},
			"defaultAccount": {
				"authenticationProvider": {
					"id": "github",
					"enterpriseProviderId": "github-enterprise",
					"enterpriseProviderConfig": "github-enterprise.uri",
					"scopes": [
						"user:email"
					]
				},
				"chatEntitlementUrl": "https://api.github.com/copilot_internal/user",
				"tokenEntitlementUrl": "https://api.github.com/copilot_internal/v2/token"
			}
		});
	}
}

export default product;
