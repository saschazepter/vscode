/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { isWeb } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDefaultAccount } from '../../../../../base/common/defaultAccount.js';
import { IDefaultAccountService } from '../../../../../platform/defaultAccount/common/defaultAccount.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IExtensionService } from '../../../../../workbench/services/extensions/common/extensions.js';
import { ChatSetupStrategy } from '../../../../../workbench/contrib/chat/browser/chatSetup/chatSetup.js';
import { IWorkbenchEnvironmentService } from '../../../../../workbench/services/environment/common/environmentService.js';
import { IWorkbenchLayoutService } from '../../../../../workbench/services/layout/browser/layoutService.js';
import { workbenchInstantiationService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { SessionsWelcomeVisibleContext } from '../../../../common/contextkeys.js';
import { WELCOME_COMPLETE_KEY } from '../../../../common/welcome.js';
import { IAuthenticationService } from '../../../../../workbench/services/authentication/common/authentication.js';
import { resetSessionsWelcome, SessionsWelcomeContribution } from '../../browser/welcome.contribution.js';
import { SessionsWalkthroughOverlay, WalkthroughOutcome } from '../../browser/sessionsWalkthrough.js';

const MOCK_ACCOUNT: IDefaultAccount = {
	accountName: 'testuser',
	sessionId: 'test-session',
	enterprise: false,
	authenticationProvider: { id: 'github', name: 'GitHub', enterprise: false },
};

class MockDefaultAccountService implements Pick<IDefaultAccountService, 'currentDefaultAccount' | 'onDidChangeDefaultAccount'> {

	private readonly _onDidChangeDefaultAccount = new Emitter<IDefaultAccount | null>();
	readonly onDidChangeDefaultAccount = this._onDidChangeDefaultAccount.event;

	currentDefaultAccount: IDefaultAccount | null = null;

	setAccount(account: IDefaultAccount | null): void {
		this.currentDefaultAccount = account;
		this._onDidChangeDefaultAccount.fire(account);
	}
}

class TestWalkthroughOverlay extends Disposable {

	private _resolveOutcome!: (outcome: WalkthroughOutcome) => void;
	readonly outcome: Promise<WalkthroughOutcome> = new Promise(resolve => {
		this._resolveOutcome = resolve;
	});

	resolve(outcome: WalkthroughOutcome): void {
		this._resolveOutcome(outcome);
	}

	complete(): void {
		this.resolve('completed');
	}
}

suite('SessionsWelcomeContribution', () => {

	const disposables = new DisposableStore();
	let instantiationService: TestInstantiationService;
	let mockDefaultAccountService: MockDefaultAccountService;

	setup(() => {
		instantiationService = workbenchInstantiationService(undefined, disposables);
		mockDefaultAccountService = new MockDefaultAccountService();
		instantiationService.stub(IDefaultAccountService, mockDefaultAccountService as unknown as IDefaultAccountService);

		// Ensure product has a defaultChatAgent so the contribution activates
		const productService = instantiationService.get(IProductService);
		instantiationService.stub(IProductService, {
			...productService,
			defaultChatAgent: { ...productService.defaultChatAgent, chatExtensionId: 'test.chat' }
		} as IProductService);

		// On web the contribution checks IAuthenticationService.getSessions.
		// Default to an authenticated user; individual tests override as needed.
		instantiationService.stub(IAuthenticationService, {
			getSessions: () => Promise.resolve([{ id: 'test', accessToken: 'tok', scopes: ['user:email'], account: { id: 'test', label: 'test' } }]),
			onDidChangeSessions: Event.None,
		} as Partial<IAuthenticationService> as IAuthenticationService);
	});

	teardown(() => {
		disposables.clear();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	function markReturningUser(): void {
		const storageService = instantiationService.get(IStorageService);
		storageService.store(WELCOME_COMPLETE_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	function isOverlayVisible(): boolean {
		const contextKeyService = instantiationService.get(IContextKeyService);
		return SessionsWelcomeVisibleContext.getValue(contextKeyService) === true;
	}

	async function flushMicrotasks(): Promise<void> {
		await Promise.resolve();
	}

	test('first launch shows overlay', async () => {
		// First launch, not signed in — should show overlay
		// On web, _checkWebAuth must see no sessions to show the walkthrough
		instantiationService.stub(IAuthenticationService, {
			getSessions: () => Promise.resolve([]),
			onDidChangeSessions: Event.None,
		} as Partial<IAuthenticationService> as IAuthenticationService);

		const contribution = disposables.add(instantiationService.createInstance(SessionsWelcomeContribution));
		assert.ok(contribution);
		await flushMicrotasks();
		await flushMicrotasks();
		assert.strictEqual(isOverlayVisible(), true);
	});

	test('returning user signed in does not show overlay', async () => {
		markReturningUser();
		mockDefaultAccountService.setAccount(MOCK_ACCOUNT);
		const contribution = disposables.add(instantiationService.createInstance(SessionsWelcomeContribution));
		assert.ok(contribution);
		await flushMicrotasks();
		assert.strictEqual(isOverlayVisible(), false);
	});

	test('returning user not signed in shows overlay', async () => {
		markReturningUser();
		// currentDefaultAccount is null by default
		const contribution = disposables.add(instantiationService.createInstance(SessionsWelcomeContribution));
		assert.ok(contribution);
		await flushMicrotasks();
		assert.strictEqual(isOverlayVisible(), true);
	});

	(isWeb ? test.skip : test)('returning user: sign out shows overlay; signing back in hides it and persists completion', async () => {
		markReturningUser();
		mockDefaultAccountService.setAccount(MOCK_ACCOUNT);

		const contribution = disposables.add(instantiationService.createInstance(SessionsWelcomeContribution));
		assert.ok(contribution);
		await flushMicrotasks();
		assert.strictEqual(isOverlayVisible(), false, 'should not show initially');

		// Simulate sign out
		mockDefaultAccountService.setAccount(null);

		assert.strictEqual(isOverlayVisible(), true, 'should show overlay after sign out');

		// Simulate signing back in
		mockDefaultAccountService.setAccount(MOCK_ACCOUNT);
		await flushMicrotasks();

		const storageService = instantiationService.get(IStorageService);
		assert.strictEqual(isOverlayVisible(), false, 'should hide overlay after signing back in');
		assert.strictEqual(storageService.getBoolean(WELCOME_COMPLETE_KEY, StorageScope.APPLICATION, false), true);
	});

	test('reset welcome respects skip-sessions-welcome while still clearing completion state', async () => {
		markReturningUser();

		const storageService = instantiationService.get(IStorageService);
		const layoutService = instantiationService.get(IWorkbenchLayoutService);
		const contextKeyService = instantiationService.get(IContextKeyService);
		const logService = instantiationService.get(ILogService);
		const environmentService = instantiationService.get(IWorkbenchEnvironmentService);
		instantiationService.stub(IWorkbenchEnvironmentService, {
			...environmentService,
			args: { ...(environmentService as IWorkbenchEnvironmentService & { args?: Record<string, unknown> }).args, 'skip-sessions-welcome': true },
		} as IWorkbenchEnvironmentService);

		resetSessionsWelcome(storageService, instantiationService, layoutService, mockDefaultAccountService as unknown as IDefaultAccountService, contextKeyService, instantiationService.get(IWorkbenchEnvironmentService), logService);

		assert.strictEqual(storageService.getBoolean(WELCOME_COMPLETE_KEY, StorageScope.APPLICATION, false), false, 'should clear completion state');
		assert.strictEqual(isOverlayVisible(), false, 'should not show overlay when skip flag is set');
	});

	test('sign-in dismisses overlay and persists welcome completion', async () => {
		// First launch, not signed in
		instantiationService.stub(IAuthenticationService, {
			getSessions: () => Promise.resolve([]),
			onDidChangeSessions: Event.None,
		} as Partial<IAuthenticationService> as IAuthenticationService);

		const contribution = disposables.add(instantiationService.createInstance(SessionsWelcomeContribution));
		assert.ok(contribution);
		await flushMicrotasks();
		await flushMicrotasks();
		assert.strictEqual(isOverlayVisible(), true, 'should show on first launch');

		// Simulate sign-in completing
		mockDefaultAccountService.setAccount(MOCK_ACCOUNT);
		await flushMicrotasks();

		const storageService = instantiationService.get(IStorageService);
		assert.strictEqual(storageService.getBoolean(WELCOME_COMPLETE_KEY, StorageScope.APPLICATION, false), true);
		assert.strictEqual(isOverlayVisible(), false, 'should dismiss once signed in');
	});

	(isWeb ? test.skip : test)('first-launch + already signed in shows welcome screen; Get Started completes it', async () => {
		mockDefaultAccountService.setAccount(MOCK_ACCOUNT);
		instantiationService.stub(ICommandService, {
			executeCommand: () => Promise.resolve(false)
		} as unknown as ICommandService);
		instantiationService.stub(IExtensionService, {
			stopExtensionHosts: () => Promise.resolve(false),
			startExtensionHosts: () => Promise.resolve()
		} as unknown as IExtensionService);

		const container = document.createElement('div');
		document.body.appendChild(container);

		try {
			const overlay = disposables.add(instantiationService.createInstance(SessionsWalkthroughOverlay, container, true));

			assert.strictEqual(overlay.isShowingWelcome, true, 'should be in welcome mode');
			assert.ok(container.querySelector('.sessions-walkthrough-get-started-btn'), 'should show Get Started button');
			assert.strictEqual(container.querySelector('.sessions-walkthrough-provider-btn'), null, 'should not show sign-in buttons');

			let outcomeResolved = false;
			overlay.outcome.then(() => { outcomeResolved = true; });

			const getStartedBtn = container.querySelector<HTMLButtonElement>('.sessions-walkthrough-get-started-btn');
			assert.ok(getStartedBtn);
			getStartedBtn.click();
			await flushMicrotasks();

			assert.strictEqual(overlay.isShowingWelcome, false, 'isShowingWelcome should be cleared after Get Started');
			assert.strictEqual(outcomeResolved, true, 'outcome should resolve after Get Started click');

			overlay.dispose();
		} finally {
			container.remove();
		}
	});

	test('walkthrough cannot be dismissed by Escape or backdrop click', () => {
		instantiationService.stub(ICommandService, {
			executeCommand: () => Promise.resolve(false)
		} as unknown as ICommandService);
		instantiationService.stub(IExtensionService, {
			stopExtensionHosts: () => Promise.resolve(false),
			startExtensionHosts: () => Promise.resolve()
		} as unknown as IExtensionService);
		instantiationService.stub(ILogService, new NullLogService());

		const container = document.createElement('div');
		document.body.appendChild(container);

		try {
			const overlay = disposables.add(instantiationService.createInstance(SessionsWalkthroughOverlay, container, true));
			const overlayElement = container.querySelector<HTMLElement>('.sessions-walkthrough-overlay');
			assert.ok(overlayElement);

			overlayElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
			assert.strictEqual(overlayElement.isConnected, true, 'Escape should not dismiss the walkthrough');
			assert.strictEqual(overlayElement.classList.contains('sessions-walkthrough-dismissed'), false);

			overlayElement.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
			assert.strictEqual(overlayElement.isConnected, true, 'Backdrop click should not dismiss the walkthrough');
			assert.strictEqual(overlayElement.classList.contains('sessions-walkthrough-dismissed'), false);

			overlay.dispose();
		} finally {
			container.remove();
		}
	});

	(isWeb ? test.skip : test)('walkthrough preserves provider-specific sign-in strategies', async () => {
		let commandArgs: unknown[] | undefined;
		instantiationService.stub(IExtensionService, {
			stopExtensionHosts: () => Promise.resolve(false),
			startExtensionHosts: () => Promise.resolve()
		} as unknown as IExtensionService);
		instantiationService.stub(ILogService, new NullLogService());

		const container = document.createElement('div');
		document.body.appendChild(container);

		try {
			const assertButtonStrategy = async (selector: string, expectedStrategy: ChatSetupStrategy) => {
				commandArgs = undefined;
				let resolveExecuteCommandCalled!: () => void;
				const executeCommandCalled = new Promise<void>(resolve => {
					resolveExecuteCommandCalled = resolve;
				});
				instantiationService.stub(ICommandService, {
					executeCommand: (...args: unknown[]) => {
						commandArgs = args;
						resolveExecuteCommandCalled();
						return Promise.resolve(false);
					}
				} as unknown as ICommandService);

				const overlay = disposables.add(instantiationService.createInstance(SessionsWalkthroughOverlay, container, true));
				const githubButton = container.querySelector<HTMLButtonElement>('.sessions-walkthrough-provider-btn.provider-github');
				const googleButton = container.querySelector<HTMLButtonElement>('.sessions-walkthrough-provider-btn.provider-google');
				const appleButton = container.querySelector<HTMLButtonElement>('.sessions-walkthrough-provider-btn.provider-apple');
				const enterpriseButton = container.querySelector<HTMLButtonElement>('.sessions-walkthrough-provider-btn.provider-enterprise');
				assert.ok(githubButton);
				assert.ok(googleButton);
				assert.ok(appleButton);
				assert.ok(enterpriseButton);

				const button = container.querySelector<HTMLButtonElement>(selector);
				assert.ok(button);
				button.click();
				await executeCommandCalled;

				assert.ok(commandArgs);
				assert.deepStrictEqual(commandArgs?.[1], {
					setupStrategy: expectedStrategy
				});

				overlay.dispose();
				container.textContent = '';
			};

			await assertButtonStrategy('.sessions-walkthrough-provider-btn.provider-apple', ChatSetupStrategy.SetupWithAppleProvider);
			await assertButtonStrategy('.sessions-walkthrough-provider-btn.provider-google', ChatSetupStrategy.SetupWithGoogleProvider);
			await assertButtonStrategy('.sessions-walkthrough-provider-btn.provider-enterprise', ChatSetupStrategy.SetupWithEnterpriseProvider);
		} finally {
			container.remove();
		}
	});

	(isWeb ? test.skip : test)('enterprise sign-in option is removed after setup begins', async () => {
		let resolveExecuteCommand!: () => void;
		const executeCommandStarted = new Promise<void>(resolve => {
			resolveExecuteCommand = resolve;
		});

		instantiationService.stub(ICommandService, {
			executeCommand: () => {
				resolveExecuteCommand();
				return new Promise<boolean>(() => { });
			}
		} as unknown as ICommandService);
		instantiationService.stub(IExtensionService, {
			stopExtensionHosts: () => Promise.resolve(false),
			startExtensionHosts: () => Promise.resolve()
		} as unknown as IExtensionService);
		instantiationService.stub(ILogService, new NullLogService());

		const container = document.createElement('div');
		document.body.appendChild(container);

		try {
			const overlay = disposables.add(instantiationService.createInstance(SessionsWalkthroughOverlay, container, true));
			const enterpriseButton = container.querySelector<HTMLButtonElement>('.sessions-walkthrough-provider-btn.provider-enterprise');
			assert.ok(enterpriseButton);

			enterpriseButton.click();
			await executeCommandStarted;
			await new Promise(resolve => setTimeout(resolve, 250));

			assert.strictEqual(container.querySelector('.sessions-walkthrough-provider-btn.provider-enterprise'), null);
			assert.strictEqual(container.querySelector('.sessions-walkthrough-provider-btn'), null);

			overlay.dispose();
		} finally {
			container.remove();
		}
	});

	test('walkthrough shows disclaimer links on the initial sign-in screen', () => {
		instantiationService.stub(ICommandService, {
			executeCommand: () => Promise.resolve(false)
		} as unknown as ICommandService);
		instantiationService.stub(IExtensionService, {
			stopExtensionHosts: () => Promise.resolve(false),
			startExtensionHosts: () => Promise.resolve()
		} as unknown as IExtensionService);
		instantiationService.stub(ILogService, new NullLogService());
		const productService = instantiationService.get(IProductService);
		instantiationService.stub(IProductService, {
			...productService,
			defaultChatAgent: {
				...productService.defaultChatAgent,
				chatExtensionId: 'test.chat',
				termsStatementUrl: 'https://example.com/terms',
				privacyStatementUrl: 'https://example.com/privacy',
				publicCodeMatchesUrl: 'https://example.com/public-code',
				manageSettingsUrl: 'https://example.com/settings'
			}
		} as IProductService);

		const container = document.createElement('div');
		document.body.appendChild(container);

		try {
			const overlay = disposables.add(instantiationService.createInstance(SessionsWalkthroughOverlay, container, true));
			const disclaimer = container.querySelector<HTMLElement>('.sessions-walkthrough-disclaimer');
			assert.ok(disclaimer);
			assert.strictEqual(disclaimer.classList.contains('hidden'), false);

			const links = Array.from(disclaimer.querySelectorAll<HTMLAnchorElement>('a'));
			assert.deepStrictEqual(links.map(link => link.textContent), ['Terms', 'Privacy Statement', 'public code', 'settings']);

			overlay.dispose();
		} finally {
			container.remove();
		}
	});

	test('walkthrough falls back to default disclaimer links when product links are missing', () => {
		instantiationService.stub(ICommandService, {
			executeCommand: () => Promise.resolve(false)
		} as unknown as ICommandService);
		instantiationService.stub(IExtensionService, {
			stopExtensionHosts: () => Promise.resolve(false),
			startExtensionHosts: () => Promise.resolve()
		} as unknown as IExtensionService);
		instantiationService.stub(ILogService, new NullLogService());

		const productService = instantiationService.get(IProductService);
		instantiationService.stub(IProductService, {
			...productService,
			defaultChatAgent: {
				...productService.defaultChatAgent,
				chatExtensionId: 'test.chat',
				termsStatementUrl: '',
				privacyStatementUrl: '',
				publicCodeMatchesUrl: '',
				manageSettingsUrl: ''
			}
		} as IProductService);

		const container = document.createElement('div');
		document.body.appendChild(container);

		try {
			const overlay = disposables.add(instantiationService.createInstance(SessionsWalkthroughOverlay, container, true));
			const disclaimer = container.querySelector<HTMLElement>('.sessions-walkthrough-disclaimer');
			assert.ok(disclaimer);
			assert.strictEqual(disclaimer.classList.contains('hidden'), false);
			assert.deepStrictEqual(
				Array.from(disclaimer.querySelectorAll<HTMLAnchorElement>('a')).map(link => link.getAttribute('href')),
				[
					'https://aka.ms/github-copilot-terms-statement',
					'https://aka.ms/github-copilot-privacy-statement',
					'https://aka.ms/github-copilot-match-public-code',
					'https://aka.ms/github-copilot-settings'
				]
			);

			overlay.dispose();
		} finally {
			container.remove();
		}
	});

	test('dismissing walkthrough does not mark welcome complete', async () => {
		instantiationService.stub(IAuthenticationService, {
			getSessions: () => Promise.resolve([]),
			onDidChangeSessions: Event.None,
		} as Partial<IAuthenticationService> as IAuthenticationService);

		const walkthrough = new TestWalkthroughOverlay();
		instantiationService.stubInstance(SessionsWalkthroughOverlay, walkthrough as unknown as SessionsWalkthroughOverlay);

		const contribution = disposables.add(instantiationService.createInstance(SessionsWelcomeContribution));
		assert.ok(contribution);
		await flushMicrotasks();
		await flushMicrotasks();
		assert.strictEqual(isOverlayVisible(), true);

		walkthrough.resolve('dismissed');
		await flushMicrotasks();

		const storageService = instantiationService.get(IStorageService);
		assert.strictEqual(storageService.getBoolean(WELCOME_COMPLETE_KEY, StorageScope.APPLICATION, false), false);
		assert.strictEqual(isOverlayVisible(), false);
	});

	test('completing walkthrough marks welcome complete', async () => {
		instantiationService.stub(IAuthenticationService, {
			getSessions: () => Promise.resolve([]),
			onDidChangeSessions: Event.None,
		} as Partial<IAuthenticationService> as IAuthenticationService);

		const walkthrough = new TestWalkthroughOverlay();
		instantiationService.stubInstance(SessionsWalkthroughOverlay, walkthrough as unknown as SessionsWalkthroughOverlay);

		const contribution = disposables.add(instantiationService.createInstance(SessionsWelcomeContribution));
		assert.ok(contribution);
		await flushMicrotasks();
		await flushMicrotasks();
		assert.strictEqual(isOverlayVisible(), true);

		walkthrough.resolve('completed');
		await flushMicrotasks();

		const storageService = instantiationService.get(IStorageService);
		assert.strictEqual(storageService.getBoolean(WELCOME_COMPLETE_KEY, StorageScope.APPLICATION, false), true);
		assert.strictEqual(isOverlayVisible(), false);
	});
});
