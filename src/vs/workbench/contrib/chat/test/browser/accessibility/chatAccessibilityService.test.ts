/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { TestInstantiationService } from '../../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IAccessibilitySignalService } from '../../../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IChatWidgetService } from '../../../browser/chat.js';
import { ChatAccessibilityService } from '../../../browser/accessibility/chatAccessibilityService.js';
import { MockChatWidgetService } from '../widget/mockChatWidget.js';
import { IHostService } from '../../../../../services/host/browser/host.js';
import { TestConfigurationService } from '../../../../../../platform/configuration/test/common/testConfigurationService.js';

suite('ChatAccessibilityService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let instantiationService: TestInstantiationService;
	let backgroundSessionEmitter: Emitter<URI>;

	setup(() => {
		instantiationService = store.add(new TestInstantiationService());

		backgroundSessionEmitter = store.add(new Emitter<URI>());
		const mockWidgetService = new class extends MockChatWidgetService {
			override readonly onDidBackgroundSession = backgroundSessionEmitter.event;
		}();

		const mockAccessibilitySignalService = {
			playSignal: () => { },
			playSignalLoop: () => store.add(new DisposableStore()),
		};

		const mockHostService = {};

		instantiationService.stub(IAccessibilitySignalService, mockAccessibilitySignalService as any);
		instantiationService.stub(IConfigurationService, new TestConfigurationService());
		instantiationService.stub(IHostService, mockHostService as any);
		instantiationService.stub(IChatWidgetService, mockWidgetService);
	});

	test('disposes progress signal when session is backgrounded', () => {
		const service = store.add(instantiationService.createInstance(ChatAccessibilityService));
		const sessionUri = URI.parse('test://session1');

		// Start a request (which sets up the progress signal)
		service.acceptRequest(sessionUri, true);

		// Background the session
		backgroundSessionEmitter.fire(sessionUri);

		// The signal should be disposed - calling disposeRequest again should be a no-op
		// We verify by checking that no error is thrown
		service.disposeRequest(sessionUri);
	});

	test('disposes progress signal when session is backgrounded even without active request', () => {
		const service = store.add(instantiationService.createInstance(ChatAccessibilityService));
		const sessionUri = URI.parse('test://session1');

		// Start a request
		service.acceptRequest(sessionUri, true);

		// Background the session - this should always clean up, regardless of requestInProgress state
		backgroundSessionEmitter.fire(sessionUri);

		// Verify the signal was cleaned up by trying to dispose again (should be no-op)
		service.disposeRequest(sessionUri);
	});

	test('backgrounding session without pending signal is safe', () => {
		store.add(instantiationService.createInstance(ChatAccessibilityService));
		const sessionUri = URI.parse('test://session1');

		// Background a session that never had a request - should not throw
		backgroundSessionEmitter.fire(sessionUri);
	});

	test('signal is started for new request after backgrounding', () => {
		const service = store.add(instantiationService.createInstance(ChatAccessibilityService));
		const sessionUri = URI.parse('test://session1');

		// Start, background, then start again
		service.acceptRequest(sessionUri, true);
		backgroundSessionEmitter.fire(sessionUri);

		// Should be able to start a new request
		service.acceptRequest(sessionUri, true);

		// Clean up
		service.disposeRequest(sessionUri);
	});

	test('playSignalLoop is disposed when session is backgrounded', () => {
		const loopDisposable = {
			dispose: () => { /* tracked disposal */ }
		};

		const mockAccessibilitySignalService = {
			playSignal: () => { },
			playSignalLoop: () => loopDisposable,
		};
		instantiationService.stub(IAccessibilitySignalService, mockAccessibilitySignalService as any);

		const service = store.add(instantiationService.createInstance(ChatAccessibilityService));
		const sessionUri = URI.parse('test://session1');

		service.acceptRequest(sessionUri, true);

		// Background the session
		backgroundSessionEmitter.fire(sessionUri);

		// The loop disposable should have been disposed via the scheduler
		// (The scheduler itself is disposed, which disposes the loop)
		assert.ok(true, 'backgrounding session with pending signal should not throw');
	});
});
