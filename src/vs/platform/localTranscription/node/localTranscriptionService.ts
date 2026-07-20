/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import {
	ILocalTranscriptionModelStatus,
	ILocalTranscriptionProxyConfig,
	ILocalTranscriptionResult,
	ILocalTranscriptionService,
	LocalTranscriptionModelState,
} from '../common/localTranscription.js';

/** PCM audio format the renderer captures and streams: mono 16 kHz signed 16-bit. */
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

/**
 * Default on-device model. `nemotron-speech-streaming-en-0.6b` is the NVIDIA
 * Nemotron streaming RNN-T model the GitHub Copilot app ships for dictation; it
 * runs through Foundry Local's native streaming ASR engine (ORT + ORT-GenAI).
 */
const DEFAULT_MODEL = 'nemotron-speech-streaming-en-0.6b';

/** Application name reported to Foundry Local for logs/telemetry and its data dir. */
const FOUNDRY_APP_NAME = 'vscode-dictation';

/**
 * Foundry Local JS SDK. It is an ESM package that loads a native addon
 * (`foundry_local_napi.node`) plus the Foundry Local Core / onnxruntime /
 * onnxruntime-genai shared libraries. Import it lazily so forking the utility
 * process stays cheap; the model itself is only downloaded/loaded when dictation
 * first runs.
 */
type FoundryLocal = typeof import('foundry-local-sdk');
type FoundryLocalManager = import('foundry-local-sdk').FoundryLocalManager;
type IModel = import('foundry-local-sdk').IModel;
type LiveAudioTranscriptionSession = import('foundry-local-sdk').LiveAudioTranscriptionSession;
type LiveAudioTranscriptionResponse = import('foundry-local-sdk').LiveAudioTranscriptionResponse;

/**
 * Map a raw model download/load error message to a fixed, low-cardinality code
 * safe to emit as telemetry. The raw message can contain paths, URLs, or other
 * dynamic detail, so only the returned allowlisted code should be reported.
 */
function classifyModelError(message: string): string {
	const text = message.toLowerCase();
	if (/\b(404|not found|no such file|does not exist|could not locate|repository not found|unknown model)\b/.test(text)) {
		return 'notFound';
	}
	if (/\b(network|fetch|econn|enotfound|etimedout|socket|dns|offline|proxy|tls|certificate|getaddrinfo|feed)\b/.test(text)) {
		return 'network';
	}
	if (/\b(out of memory|oom|enomem|allocation failed|cannot allocate)\b/.test(text)) {
		return 'memory';
	}
	if (/\b(enospc|no space left|disk)\b/.test(text)) {
		return 'disk';
	}
	if (/\b(eacces|eperm|permission denied|access is denied)\b/.test(text)) {
		return 'permission';
	}
	return 'unknown';
}

/** Join two transcript fragments with a single separating space, trimming edges. */
function joinTranscript(a: string, b: string): string {
	const left = a.trim();
	const right = b.trim();
	if (!left) {
		return right;
	}
	if (!right) {
		return left;
	}
	return `${left} ${right}`;
}

/**
 * On-device speech-to-text backed by Foundry Local's streaming ASR engine. Runs
 * in a utility process. A single transcription session is active at a time
 * (dictation is a singleton in the renderer): the renderer streams PCM16 mono
 * 16 kHz audio via `pushAudio`, and the service emits interim transcripts on
 * `onDidTranscribe` and a final one after `stop`.
 */
export class LocalTranscriptionService extends Disposable implements ILocalTranscriptionService {

	declare readonly _serviceBrand: undefined;

	readonly isSupported = true;

	private readonly _onDidChangeModelStatus = this._register(new Emitter<ILocalTranscriptionModelStatus>());
	readonly onDidChangeModelStatus: Event<ILocalTranscriptionModelStatus> = this._onDidChangeModelStatus.event;

	private readonly _onDidTranscribe = this._register(new Emitter<ILocalTranscriptionResult>());
	readonly onDidTranscribe: Event<ILocalTranscriptionResult> = this._onDidTranscribe.event;

	private _status: ILocalTranscriptionModelStatus = { state: LocalTranscriptionModelState.Idle };

	private _sdk: FoundryLocal | undefined;
	private _manager: FoundryLocalManager | undefined;
	private _model: IModel | undefined;
	private _loadedModelId: string | undefined;
	/** In-flight (or resolved) model download+load for the selected model. */
	private _modelPromise: Promise<IModel> | undefined;

	/** The active streaming session, once `start()` has opened it. */
	private _session: LiveAudioTranscriptionSession | undefined;
	/** Resolves when the background stream consumer for `_session` has drained. */
	private _consumePromise: Promise<void> | undefined;
	/** In-flight model download/load + session open for the active recording. */
	private _openPromise: Promise<void> | undefined;
	private _sessionActive = false;

	/** Cumulative finalized transcript for the active session. */
	private _finalizedText = '';
	/** Latest interim (not-yet-finalized) segment text. */
	private _partialText = '';

	/**
	 * PCM chunks captured before the model finished loading and the session
	 * opened. Flushed in order once the session starts so no leading audio is
	 * dropped while the first-use download/load completes.
	 */
	private _pendingChunks: Uint8Array[] = [];

	/**
	 * Monotonically bumped whenever a session starts or is reset, so a slow
	 * session opened for one recording can detect that it is now stale and avoid
	 * emitting its transcript into a later session.
	 */
	private _generation = 0;

	constructor() {
		super();
		// Tear down the active session (and its native ASR resources) when the
		// service — and its utility process — goes away.
		this._register(toDisposable(() => { void this._disposeSession(); }));
	}

	async getModelStatus(): Promise<ILocalTranscriptionModelStatus> {
		return this._status;
	}

	private _setStatus(status: ILocalTranscriptionModelStatus): void {
		this._status = status;
		this._onDidChangeModelStatus.fire(status);
	}

	async start(options: { cacheDir: string; model?: string; language?: string; proxy?: ILocalTranscriptionProxyConfig }): Promise<void> {
		// Reset any prior session before starting a new one.
		await this._disposeSession();
		this._generation++;
		const generation = this._generation;
		this._sessionActive = true;
		this._finalizedText = '';
		this._partialText = '';
		this._pendingChunks = [];

		const model = options.model ?? DEFAULT_MODEL;
		const language = options.language;
		// Do not block capture on the (possibly first-use) model download/load and
		// session open; buffer audio until the session is ready, then flush it.
		this._openPromise = this._openSession(options.cacheDir, model, language, generation);
		this._openPromise.catch(() => { /* status already reported */ });
	}

	/**
	 * Ensure the Foundry Local manager exists, the selected model is downloaded
	 * and loaded, and a fresh live transcription session is started. Buffered
	 * audio captured while this was in flight is flushed once the session opens.
	 */
	private async _openSession(cacheDir: string, modelId: string, language: string | undefined, generation: number): Promise<void> {
		try {
			const model = await this._ensureModel(cacheDir, modelId);
			if (generation !== this._generation) {
				return; // superseded by a newer session
			}

			const audioClient = model.createAudioClient();
			if (language) {
				audioClient.settings.language = language;
			}
			const session = audioClient.createLiveTranscriptionSession();
			session.settings.sampleRate = SAMPLE_RATE;
			session.settings.channels = CHANNELS;
			session.settings.bitsPerSample = BITS_PER_SAMPLE;
			if (language) {
				session.settings.language = language;
			}
			await session.start();

			if (generation !== this._generation) {
				// A newer session replaced this one while it was opening; discard.
				await session.dispose();
				return;
			}

			this._session = session;
			this._setStatus({ state: LocalTranscriptionModelState.Ready });

			// Consume streaming results in the background, accumulating a
			// cumulative transcript and emitting interims as segments arrive.
			this._consumePromise = this._consume(session, generation);

			// Flush any audio captured before the session was ready, in order.
			const buffered = this._pendingChunks;
			this._pendingChunks = [];
			for (const chunk of buffered) {
				if (generation !== this._generation) {
					break;
				}
				await session.append(chunk);
			}
		} catch (err) {
			if (generation === this._generation) {
				const message = String(err instanceof Error ? err.message : err);
				this._setStatus({ state: LocalTranscriptionModelState.Error, error: message, errorCode: classifyModelError(message) });
			}
			throw err;
		}
	}

	/**
	 * Download (if needed) and load the selected model through Foundry Local,
	 * reporting download/load progress via the model status. Idempotent: a load
	 * already in flight (or the same model already loaded) is reused.
	 */
	private async _ensureModel(cacheDir: string, modelId: string): Promise<IModel> {
		if (this._model && this._loadedModelId === modelId) {
			return this._model;
		}
		if (this._modelPromise && this._loadedModelId === modelId) {
			return this._modelPromise;
		}

		this._loadedModelId = modelId;
		this._modelPromise = (async () => {
			try {
				this._setStatus({ state: LocalTranscriptionModelState.Downloading, progress: 0 });

				if (!this._sdk) {
					this._sdk = await import('foundry-local-sdk');
				}
				if (!this._manager) {
					// Store downloaded model files under VS Code's cache dir so
					// subsequent sessions load without re-downloading ("model
					// management"). `createAsync` avoids blocking the event loop
					// during native init.
					this._manager = await this._sdk.FoundryLocalManager.createAsync({
						appName: FOUNDRY_APP_NAME,
						modelCacheDir: cacheDir,
						logLevel: 'warn',
					});
				}

				const model = await this._manager.catalog.getModel(modelId);

				let didDownload = false;
				if (!model.isCached) {
					didDownload = true;
					await model.download((percent: number) => {
						this._setStatus({ state: LocalTranscriptionModelState.Downloading, progress: Math.min(1, Math.max(0, percent / 100)) });
					});
				}

				this._setStatus({ state: LocalTranscriptionModelState.Loading });
				await model.load();

				this._model = model;
				this._setStatus({ state: LocalTranscriptionModelState.Ready, downloaded: didDownload });
				return model;
			} catch (err) {
				this._model = undefined;
				this._modelPromise = undefined;
				this._loadedModelId = undefined;
				throw err;
			}
		})();
		return this._modelPromise;
	}

	/**
	 * Drain the session's result stream, maintaining a cumulative transcript.
	 * Foundry emits per-segment results flagged `is_final`; finalized segments are
	 * appended to the running transcript and interim segments update the tail.
	 */
	private async _consume(session: LiveAudioTranscriptionSession, generation: number): Promise<void> {
		try {
			for await (const result of session.getStream()) {
				if (generation !== this._generation) {
					break;
				}
				const text = this._resultText(result);
				if (result.is_final) {
					this._finalizedText = joinTranscript(this._finalizedText, text);
					this._partialText = '';
				} else {
					this._partialText = text;
				}
				const cumulative = joinTranscript(this._finalizedText, this._partialText);
				if (this._sessionActive) {
					this._onDidTranscribe.fire({ text: cumulative, isFinal: false });
				}
			}
		} catch {
			// Stream errors surface via stop()/the error status; nothing to emit here.
		}
	}

	private _resultText(result: LiveAudioTranscriptionResponse): string {
		const part = result.content?.[0];
		return (part?.text ?? part?.transcript ?? '').trim();
	}

	async pushAudio(chunk: VSBuffer): Promise<void> {
		if (!this._sessionActive) {
			return;
		}
		const bytes = chunk.buffer;
		// Copy out of the shared VSBuffer backing store; `append` takes ownership
		// of the bytes it queues to native core.
		const pcm = new Uint8Array(bytes.byteLength);
		pcm.set(bytes);
		if (this._session) {
			try {
				await this._session.append(pcm);
			} catch {
				// Session ended underneath us (e.g. native error); drop the chunk.
			}
		} else {
			// Model still loading / session not open yet: buffer until it is.
			this._pendingChunks.push(pcm);
		}
	}

	async stop(): Promise<string> {
		const generation = this._generation;
		this._sessionActive = false;

		// On first use the model may still be downloading/loading when the user
		// stops. Wait for the session to open (or fail) so the whole recording is
		// transcribed instead of being dropped.
		if (!this._session && this._openPromise) {
			try {
				await this._openPromise;
			} catch {
				// Load failed; status already reported as Error.
			}
		}

		if (generation !== this._generation) {
			return '';
		}

		const session = this._session;
		if (!session) {
			// Model never finished loading; nothing to transcribe.
			const text = joinTranscript(this._finalizedText, this._partialText).trim();
			this._resetSessionState();
			return text;
		}

		try {
			// `stop()` drains any buffered audio, emits final results into the
			// stream, then completes it — so the consumer loop ends after this.
			await session.stop();
		} catch {
			// Best-effort: fall through to whatever transcript we accumulated.
		}
		if (this._consumePromise) {
			try {
				await this._consumePromise;
			} catch { /* consumer swallows its own errors */ }
		}

		const text = joinTranscript(this._finalizedText, this._partialText).trim();
		if (generation === this._generation) {
			this._onDidTranscribe.fire({ text, isFinal: true });
		}
		await this._disposeSession();
		this._resetSessionState();
		return text;
	}

	async cancel(): Promise<void> {
		this._sessionActive = false;
		this._generation++;
		await this._disposeSession();
		this._resetSessionState();
	}

	private async _disposeSession(): Promise<void> {
		const session = this._session;
		this._session = undefined;
		const consume = this._consumePromise;
		this._consumePromise = undefined;
		if (session) {
			try {
				await session.dispose();
			} catch { /* best-effort teardown */ }
		}
		if (consume) {
			try {
				await consume;
			} catch { /* consumer swallows its own errors */ }
		}
	}

	private _resetSessionState(): void {
		this._sessionActive = false;
		this._finalizedText = '';
		this._partialText = '';
		this._pendingChunks = [];
	}
}
