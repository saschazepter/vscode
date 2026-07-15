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
import { IAuthenticationService } from '../../../../services/authentication/common/authentication.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IDefaultAccountService } from '../../../../../platform/defaultAccount/common/defaultAccount.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { AgentsVoiceStorageKeys } from '../../../agentsVoice/common/agentsVoice.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';

export const IChatSpeechToTextService = createDecorator<IChatSpeechToTextService>('chatSpeechToTextService');

/** Sample rate (Hz) of the PCM16 audio streamed to the transcription backend. */
const SAMPLE_RATE = 16000;

export const enum ChatSpeechToTextState {
	/** Not recording. */
	Idle = 'idle',
	/** Capturing microphone audio and streaming it for transcription. */
	Recording = 'recording',
	/** Recording stopped, awaiting the final transcript. */
	Transcribing = 'transcribing',
}

export interface IChatSpeechToTextService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeState: Event<ChatSpeechToTextState>;
	readonly state: ChatSpeechToTextState;

	/**
	 * Fires with the cumulative transcript while recording, so callers can
	 * render dictation live as the user speaks. The value grows monotonically
	 * (finalized utterances plus any in-progress delta).
	 */
	readonly onDidUpdateTranscript: Event<string>;

	/**
	 * Begin capturing microphone audio in the given window and streaming it to
	 * the transcription backend. Rejects if the microphone or backend cannot be
	 * reached.
	 */
	start(window: Window & typeof globalThis): Promise<void>;

	/**
	 * Stop capturing, flush the final utterance, and resolve with the complete
	 * cumulative transcript (or `undefined` when nothing was transcribed).
	 */
	stopAndTranscribe(): Promise<string | undefined>;

	/** Abort an in-progress recording without keeping the transcript. */
	cancel(): void;
}

export class ChatSpeechToTextService extends Disposable implements IChatSpeechToTextService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<ChatSpeechToTextState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private readonly _onDidUpdateTranscript = this._register(new Emitter<string>());
	readonly onDidUpdateTranscript = this._onDidUpdateTranscript.event;

	private _state = ChatSpeechToTextState.Idle;
	get state(): ChatSpeechToTextState {
		return this._state;
	}

	private readonly _recordingContextKey: IContextKey<boolean>;

	private _mediaStream: MediaStream | undefined;
	private _audioContext: AudioContext | undefined;
	private _sourceNode: MediaStreamAudioSourceNode | undefined;
	private _processorNode: ScriptProcessorNode | undefined;
	private _socket: WebSocket | undefined;

	/** Finalized (committed) utterances, space-joined. */
	private _finalizedText = '';
	/** In-progress text for the current utterance (from delta events). */
	private _deltaText = '';
	/** Resolves when the backend closes after a `stop`, delivering the final text. */
	private _closePromise: Promise<void> | undefined;
	private _resolveClose: (() => void) | undefined;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ILogService private readonly _logService: ILogService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IProductService private readonly _productService: IProductService,
		@IDefaultAccountService private readonly _defaultAccountService: IDefaultAccountService,
		@IStorageService private readonly _storageService: IStorageService,
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

	private get _transcript(): string {
		return [this._finalizedText, this._deltaText].filter(Boolean).join(' ').replace(/\s{2,}/g, ' ').trim();
	}

	async start(window: Window & typeof globalThis): Promise<void> {
		if (this._state !== ChatSpeechToTextState.Idle) {
			return;
		}

		const serverUrl = this._getServerUrl();
		if (!serverUrl) {
			this._notificationService.notify({
				severity: Severity.Warning,
				message: localize('chatStt.notConfigured', "Speech-to-text is not configured. Set chat.speechToText.serverUrl to your transcription backend."),
			});
			return;
		}

		let stream: MediaStream;
		try {
			stream = await this._acquireStream(window);
		} catch (err) {
			this._logService.error('[chat-stt] microphone acquisition failed', err);
			this._notificationService.error(localize('chatStt.micError', "Could not access the microphone for speech-to-text: {0}", toErrorMessage(err)));
			throw err;
		}

		this._finalizedText = '';
		this._deltaText = '';
		this._mediaStream = stream;

		try {
			await this._openSocket(serverUrl, window);
		} catch (err) {
			this._teardown();
			this._logService.error('[chat-stt] failed to connect to transcription backend', err);
			this._notificationService.error(localize('chatStt.connectError', "Could not connect to the speech-to-text backend: {0}", toErrorMessage(err)));
			throw err;
		}

		this._startCapture(window, stream);
		this._setState(ChatSpeechToTextState.Recording);
	}

	async stopAndTranscribe(): Promise<string | undefined> {
		if (this._state !== ChatSpeechToTextState.Recording) {
			return undefined;
		}

		this._setState(ChatSpeechToTextState.Transcribing);
		this._stopCapture();

		// Ask the backend to flush the final utterance, then wait for it to
		// close (bounded) so the last `segment` lands before we return.
		try {
			this._socket?.send(JSON.stringify({ type: 'stop' }));
		} catch {
			// socket already gone
		}

		if (this._closePromise) {
			await Promise.race([this._closePromise, timeout(8000)]);
		}

		const text = this._transcript;
		this._teardown();
		this._setState(ChatSpeechToTextState.Idle);
		return text || undefined;
	}

	cancel(): void {
		this._teardown();
		this._finalizedText = '';
		this._deltaText = '';
		this._setState(ChatSpeechToTextState.Idle);
	}

	private _openSocket(serverUrl: string, window: Window & typeof globalThis): Promise<void> {
		const wsUrl = toStreamUrl(serverUrl);
		return new Promise<void>((resolve, reject) => {
			let socket: WebSocket;
			try {
				socket = new window.WebSocket(wsUrl);
			} catch (err) {
				reject(err);
				return;
			}
			this._socket = socket;

			this._closePromise = new Promise<void>(res => { this._resolveClose = res; });

			let ready = false;
			socket.onopen = async () => {
				const token = await this._getAuthToken();
				socket.send(JSON.stringify({ type: 'auth', token: token ?? '' }));
			};
			socket.onmessage = ev => {
				let msg: { type?: string; text?: string; message?: string };
				try {
					msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
				} catch {
					return;
				}
				switch (msg.type) {
					case 'ready':
						ready = true;
						resolve();
						break;
					case 'delta':
						this._deltaText += msg.text ?? '';
						this._onDidUpdateTranscript.fire(this._transcript);
						break;
					case 'segment':
						this._finalizedText = [this._finalizedText, (msg.text ?? '').trim()].filter(Boolean).join(' ');
						this._deltaText = '';
						this._onDidUpdateTranscript.fire(this._transcript);
						break;
					case 'error':
						this._logService.error('[chat-stt] backend error', msg.message);
						this._notificationService.error(localize('chatStt.transcribeError', "Speech-to-text transcription failed: {0}", msg.message ?? ''));
						if (!ready) {
							reject(new Error(msg.message ?? 'backend error'));
						}
						break;
				}
			};
			socket.onerror = () => {
				if (!ready) {
					reject(new Error('WebSocket error'));
				}
			};
			socket.onclose = () => {
				this._resolveClose?.();
				if (!ready) {
					reject(new Error('WebSocket closed before ready'));
				}
			};
		});
	}

	private _startCapture(window: Window & typeof globalThis, stream: MediaStream): void {
		const ctx = new window.AudioContext({ sampleRate: SAMPLE_RATE });
		this._audioContext = ctx;
		// The context is created several awaits after the user gesture (mic
		// acquisition + socket handshake), so it can start suspended; resume it
		// or `onaudioprocess` never fires and no audio is streamed.
		ctx.resume().catch(() => { /* ignore */ });
		const source = ctx.createMediaStreamSource(stream);
		this._sourceNode = source;
		const processor = ctx.createScriptProcessor(4096, 1, 1);
		this._processorNode = processor;

		processor.onaudioprocess = e => {
			const socket = this._socket;
			if (!socket || socket.readyState !== socket.OPEN) {
				return;
			}
			const samples = e.inputBuffer.getChannelData(0);
			socket.send(JSON.stringify({ type: 'audio', data: encodeRawPcm16Base64(samples, window) }));
		};

		source.connect(processor);
		processor.connect(ctx.destination);
	}

	private _stopCapture(): void {
		if (this._processorNode) {
			this._processorNode.onaudioprocess = null;
			try { this._processorNode.disconnect(); } catch { /* ignore */ }
			this._processorNode = undefined;
		}
		try { this._sourceNode?.disconnect(); } catch { /* ignore */ }
		this._sourceNode = undefined;
		this._audioContext?.close().catch(() => { /* ignore */ });
		this._audioContext = undefined;
		this._mediaStream?.getTracks().forEach(track => track.stop());
		this._mediaStream = undefined;
	}

	private _teardown(): void {
		this._stopCapture();
		if (this._socket) {
			this._socket.onopen = null;
			this._socket.onmessage = null;
			this._socket.onerror = null;
			this._socket.onclose = null;
			try { this._socket.close(); } catch { /* ignore */ }
			this._socket = undefined;
		}
		this._resolveClose?.();
		this._resolveClose = undefined;
		this._closePromise = undefined;
	}

	private async _acquireStream(window: Window & typeof globalThis): Promise<MediaStream> {
		// Honor the microphone chosen for Voice Mode (shared setting) so both
		// features record from the same device. Falls back to the system default
		// if the stored device is stale/unplugged.
		const deviceId = this._storageService.get(AgentsVoiceStorageKeys.MicrophoneDevice, StorageScope.APPLICATION);
		const audioConstraints: MediaTrackConstraints = {
			channelCount: 1,
			echoCancellation: true,
			noiseSuppression: true,
		};
		if (deviceId) {
			audioConstraints.deviceId = { exact: deviceId };
		}

		try {
			return await window.navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
		} catch (err) {
			const isDeviceError = deviceId && err instanceof DOMException &&
				(err.name === 'OverconstrainedError' || err.name === 'NotFoundError');
			if (!isDeviceError) {
				throw err;
			}
			this._logService.warn(`[chat-stt] preferred microphone ${deviceId.slice(0, 8)}… unavailable, falling back to default`);
			delete audioConstraints.deviceId;
			return window.navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
		}
	}

	private _getServerUrl(): string {
		const configured = (this._configurationService.getValue<string>('chat.speechToText.serverUrl') ?? '').trim();
		return configured || this._productService.defaultChatAgent?.speechToTextUrl || '';
	}

	private async _getAuthToken(): Promise<string | undefined> {
		try {
			const providerId = this._defaultAccountService.getDefaultAccountAuthenticationProvider().id;
			const sessions = await this._authenticationService.getSessions(providerId);
			return sessions[0]?.accessToken;
		} catch (err) {
			this._logService.warn('[chat-stt] failed to resolve authentication session', err);
			return undefined;
		}
	}
}

/** Convert an `http(s)` transcription URL into its `ws(s)` streaming variant. */
function toStreamUrl(serverUrl: string): string {
	const url = serverUrl.replace(/^http/, 'ws').replace(/\/+$/, '');
	if (url.endsWith('/transcribe')) {
		return `${url}/stream`;
	}
	return `${url}/stream`;
}

/** Encode PCM Float32 samples into base64-encoded raw PCM16 (no WAV header). */
function encodeRawPcm16Base64(samples: Float32Array, win: Window & typeof globalThis): string {
	const buf = new ArrayBuffer(samples.length * 2);
	const view = new DataView(buf);
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
	}
	const bytes = new Uint8Array(buf);
	let binaryStr = '';
	for (let i = 0; i < bytes.length; i++) {
		binaryStr += String.fromCharCode(bytes[i]);
	}
	return win.btoa(binaryStr);
}

function timeout(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function toErrorMessage(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}
