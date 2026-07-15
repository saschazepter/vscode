/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IContextKey, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { localize } from '../../../../../nls.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';

export const IChatSpeechToTextService = createDecorator<IChatSpeechToTextService>('chatSpeechToTextService');

export const enum ChatSpeechToTextState {
	/** Not recording. */
	Idle = 'idle',
	/** Capturing microphone audio. */
	Recording = 'recording',
	/** Recording stopped, awaiting the transcription response. */
	Transcribing = 'transcribing',
}

export interface IChatSpeechToTextService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeState: Event<ChatSpeechToTextState>;
	readonly state: ChatSpeechToTextState;

	/**
	 * Begin capturing microphone audio in the given window. Rejects if the
	 * microphone cannot be acquired.
	 */
	start(window: Window & typeof globalThis): Promise<void>;

	/**
	 * Stop capturing and transcribe the recorded audio with the configured
	 * Azure OpenAI transcription deployment. Returns the transcribed text, or
	 * `undefined` when nothing was recorded or transcription failed.
	 */
	stopAndTranscribe(): Promise<string | undefined>;

	/** Abort an in-progress recording without transcribing. */
	cancel(): void;
}

interface IAzureTranscriptionConfig {
	readonly endpoint: string;
	readonly deployment: string;
	readonly apiKey: string;
	readonly apiVersion: string;
}

export class ChatSpeechToTextService extends Disposable implements IChatSpeechToTextService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<ChatSpeechToTextState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private _state = ChatSpeechToTextState.Idle;
	get state(): ChatSpeechToTextState {
		return this._state;
	}

	private readonly _recordingContextKey: IContextKey<boolean>;

	private _mediaRecorder: MediaRecorder | undefined;
	private _mediaStream: MediaStream | undefined;
	private _chunks: Blob[] = [];
	private _mimeType = 'audio/webm';

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ILogService private readonly _logService: ILogService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this._recordingContextKey = ChatContextKeys.speechToTextRecording.bindTo(contextKeyService);
	}

	private _setState(state: ChatSpeechToTextState): void {
		if (this._state === state) {
			return;
		}
		this._state = state;
		this._recordingContextKey.set(state === ChatSpeechToTextState.Recording);
		this._onDidChangeState.fire(state);
	}

	async start(window: Window & typeof globalThis): Promise<void> {
		if (this._state !== ChatSpeechToTextState.Idle) {
			return;
		}

		let stream: MediaStream;
		try {
			stream = await window.navigator.mediaDevices.getUserMedia({ audio: true });
		} catch (err) {
			this._logService.error('[chat-stt] microphone acquisition failed', err);
			this._notificationService.error(localize('chatStt.micError', "Could not access the microphone for speech-to-text: {0}", toErrorMessage(err)));
			throw err;
		}

		this._mimeType = pickSupportedMimeType(window);
		this._chunks = [];
		this._mediaStream = stream;

		const recorder = new (window as unknown as { MediaRecorder: typeof MediaRecorder }).MediaRecorder(stream, { mimeType: this._mimeType });
		recorder.ondataavailable = e => {
			if (e.data.size > 0) {
				this._chunks.push(e.data);
			}
		};
		this._mediaRecorder = recorder;
		recorder.start();
		this._setState(ChatSpeechToTextState.Recording);
	}

	async stopAndTranscribe(): Promise<string | undefined> {
		if (this._state !== ChatSpeechToTextState.Recording || !this._mediaRecorder) {
			return undefined;
		}

		const recorder = this._mediaRecorder;
		const blob = await new Promise<Blob>(resolve => {
			recorder.onstop = () => resolve(new Blob(this._chunks, { type: this._mimeType }));
			recorder.stop();
		});
		this._teardownStream();

		if (blob.size === 0) {
			this._setState(ChatSpeechToTextState.Idle);
			return undefined;
		}

		const config = this._readConfig();
		if (!config) {
			this._setState(ChatSpeechToTextState.Idle);
			return undefined;
		}

		this._setState(ChatSpeechToTextState.Transcribing);
		try {
			return await this._transcribe(blob, config);
		} catch (err) {
			this._logService.error('[chat-stt] transcription failed', err);
			this._notificationService.error(localize('chatStt.transcribeError', "Speech-to-text transcription failed: {0}", toErrorMessage(err)));
			return undefined;
		} finally {
			this._setState(ChatSpeechToTextState.Idle);
		}
	}

	cancel(): void {
		if (this._mediaRecorder && this._state === ChatSpeechToTextState.Recording) {
			this._mediaRecorder.onstop = null;
			try {
				this._mediaRecorder.stop();
			} catch {
				// ignore
			}
		}
		this._teardownStream();
		this._chunks = [];
		this._setState(ChatSpeechToTextState.Idle);
	}

	private _teardownStream(): void {
		this._mediaStream?.getTracks().forEach(track => track.stop());
		this._mediaStream = undefined;
		this._mediaRecorder = undefined;
	}

	private _readConfig(): IAzureTranscriptionConfig | undefined {
		const endpoint = (this._configurationService.getValue<string>('chat.speechToText.azure.endpoint') ?? '').trim();
		const apiKey = (this._configurationService.getValue<string>('chat.speechToText.azure.apiKey') ?? '').trim();
		const deployment = (this._configurationService.getValue<string>('chat.speechToText.azure.deployment') ?? '').trim();
		const apiVersion = (this._configurationService.getValue<string>('chat.speechToText.azure.apiVersion') ?? '').trim();

		if (!endpoint || !apiKey || !deployment || !apiVersion) {
			this._notificationService.notify({
				severity: Severity.Warning,
				message: localize('chatStt.notConfigured', "Speech-to-text is not configured. Set chat.speechToText.azure.endpoint, .apiKey, .deployment and .apiVersion in your settings."),
			});
			return undefined;
		}
		return { endpoint, apiKey, deployment, apiVersion };
	}

	private async _transcribe(blob: Blob, config: IAzureTranscriptionConfig): Promise<string | undefined> {
		const base = config.endpoint.replace(/\/+$/, '');
		const url = `${base}/openai/deployments/${encodeURIComponent(config.deployment)}/audio/transcriptions?api-version=${encodeURIComponent(config.apiVersion)}`;

		const form = new FormData();
		form.append('file', blob, `audio.${extensionForMime(this._mimeType)}`);
		form.append('response_format', 'json');

		const response = await fetch(url, {
			method: 'POST',
			headers: { 'api-key': config.apiKey },
			body: form,
		});

		if (!response.ok) {
			const detail = await safeReadText(response);
			throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
		}

		const json = await response.json() as { text?: string };
		return typeof json.text === 'string' ? json.text.trim() : undefined;
	}
}

function pickSupportedMimeType(window: Window & typeof globalThis): string {
	const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
	const recorder = (window as unknown as { MediaRecorder?: { isTypeSupported?(type: string): boolean } }).MediaRecorder;
	if (recorder?.isTypeSupported) {
		for (const candidate of candidates) {
			if (recorder.isTypeSupported(candidate)) {
				return candidate;
			}
		}
	}
	return 'audio/webm';
}

function extensionForMime(mimeType: string): string {
	if (mimeType.includes('mp4')) {
		return 'mp4';
	}
	if (mimeType.includes('ogg')) {
		return 'ogg';
	}
	return 'webm';
}

async function safeReadText(response: Response): Promise<string> {
	try {
		return (await response.text()).slice(0, 500);
	} catch {
		return '';
	}
}

function toErrorMessage(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}
