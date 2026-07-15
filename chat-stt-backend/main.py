# ---------------------------------------------------------------------------------------------
#  Copyright (c) Microsoft Corporation. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
# ---------------------------------------------------------------------------------------------
"""Chat speech-to-text backend.

Receives audio recorded by the VS Code chat input, authorizes the caller by
their GitHub token, forwards the audio to an Azure OpenAI transcription
deployment, and returns the transcribed text. The Azure credentials live only
here (in server-side environment variables); the VS Code client never sees
them.

Wire contract expected by the client
(`chatSpeechToTextService._transcribe`):

    POST {serverUrl}
    Authorization: Bearer <github-token>
    Content-Type: multipart/form-data
    file=<audio blob (webm/mp4/ogg/wav)>

    200 OK -> { "text": "<transcription>" }

Run locally:

    cd chat-stt-backend
    python -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    cp .env.example .env   # then fill in the AZURE_* values
    uvicorn main:app --reload --port 8000

Then set in VS Code settings:

    "chat.speechToText.serverUrl": "http://localhost:8000/transcribe"
"""

from __future__ import annotations

import asyncio
import json
import os
import ssl
from typing import Optional

import certifi
import httpx
import websockets
from fastapi import FastAPI, File, Header, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# --- Configuration (server-side only) ---------------------------------------

AZURE_ENDPOINT = os.environ.get("AZURE_OPENAI_ENDPOINT", "").rstrip("/")
AZURE_API_KEY = os.environ.get("AZURE_OPENAI_API_KEY", "")
AZURE_DEPLOYMENT = os.environ.get("AZURE_OPENAI_DEPLOYMENT", "gpt-4o-mini-transcribe")
AZURE_API_VERSION = os.environ.get("AZURE_OPENAI_API_VERSION", "2025-03-01-preview")
# The realtime transcription API uses a different (newer) preview version than
# the batch /audio/transcriptions endpoint.
AZURE_REALTIME_API_VERSION = os.environ.get("AZURE_OPENAI_REALTIME_API_VERSION", "2025-04-01-preview")

# When true, every request must carry a GitHub token that resolves to a real
# user via the GitHub API. Disable only for local testing.
REQUIRE_GITHUB_AUTH = os.environ.get("REQUIRE_GITHUB_AUTH", "true").lower() != "false"

# Reject uploads larger than this (Azure's own limit is 25 MB).
MAX_AUDIO_BYTES = int(os.environ.get("MAX_AUDIO_BYTES", str(25 * 1024 * 1024)))

app = FastAPI(title="chat-stt-backend")

# The VS Code renderer issues a cross-origin request (and sends an
# `Authorization` header), so the browser fires a CORS preflight. Allow all
# origins/headers/methods -- auth is by bearer token, not cookies, so there is
# no credentialed-origin concern. Tighten `allow_origins` for production if the
# calling origin is known.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Authorization ----------------------------------------------------------

async def _resolve_github_user(authorization: Optional[str]) -> str:
    """Validate the bearer token against GitHub and return the login.

    In production this is also the place to check Copilot entitlement before
    allowing (and paying for) a transcription.
    """
    if not REQUIRE_GITHUB_AUTH:
        return "anonymous"

    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")

    token = authorization[len("Bearer "):].strip()
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            "https://api.github.com/user",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
            },
        )
    if resp.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid GitHub token")

    return resp.json().get("login", "unknown")


# --- Azure transcription ----------------------------------------------------

async def _transcribe_with_azure(filename: str, content: bytes, content_type: str) -> str:
    if not AZURE_ENDPOINT or not AZURE_API_KEY:
        raise HTTPException(status_code=500, detail="Server is not configured with Azure credentials")

    url = (
        f"{AZURE_ENDPOINT}/openai/deployments/{AZURE_DEPLOYMENT}"
        f"/audio/transcriptions?api-version={AZURE_API_VERSION}"
    )
    files = {"file": (filename or "audio.webm", content, content_type or "application/octet-stream")}
    data = {"response_format": "json"}

    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            url,
            headers={"api-key": AZURE_API_KEY},
            files=files,
            data=data,
        )

    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Azure transcription failed: {resp.text[:500]}")

    return resp.json().get("text", "")


# --- Routes -----------------------------------------------------------------

@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"ok": True})


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    authorization: Optional[str] = Header(default=None),
) -> JSONResponse:
    await _resolve_github_user(authorization)

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty audio upload")
    if len(content) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Audio upload too large")

    text = await _transcribe_with_azure(file.filename or "audio.webm", content, file.content_type or "")
    return JSONResponse({"text": text.strip()})

# --- Streaming (realtime) transcription -------------------------------------

def _azure_realtime_url() -> str:
    """WebSocket URL for the Azure OpenAI realtime transcription API."""
    ws_base = AZURE_ENDPOINT.replace("https://", "wss://").replace("http://", "ws://")
    return (
        f"{ws_base}/openai/realtime"
        f"?api-version={AZURE_REALTIME_API_VERSION}&intent=transcription"
    )


_SESSION_UPDATE = {
    "type": "transcription_session.update",
    "session": {
        "input_audio_format": "pcm16",
        "input_audio_transcription": {"model": AZURE_DEPLOYMENT},
        # Server-side voice-activity detection segments the stream into
        # utterances; each pause flushes a `.completed` transcript so the
        # client can render text progressively while the user keeps talking.
        "turn_detection": {"type": "server_vad", "silence_duration_ms": 400},
    },
}


@app.websocket("/transcribe/stream")
async def transcribe_stream(client_ws: WebSocket) -> None:
    """Bridge the client to Azure realtime transcription.

    Wire contract (client <-> this endpoint), all JSON text frames:

        client -> { "type": "auth",  "token": "<github token>" }   (first frame)
        client -> { "type": "audio", "data":  "<base64 pcm16 16k mono>" }
        client -> { "type": "stop" }

        server -> { "type": "ready" }
        server -> { "type": "delta",   "text": "<incremental text>" }
        server -> { "type": "segment", "text": "<finalized utterance>" }
        server -> { "type": "error",   "message": "<detail>" }
    """
    await client_ws.accept()

    if not AZURE_ENDPOINT or not AZURE_API_KEY:
        await client_ws.send_json({"type": "error", "message": "Server is not configured with Azure credentials"})
        await client_ws.close()
        return

    # First frame must authenticate the caller.
    try:
        first = await client_ws.receive_json()
    except (WebSocketDisconnect, json.JSONDecodeError):
        await client_ws.close()
        return
    if first.get("type") != "auth":
        await client_ws.send_json({"type": "error", "message": "Expected auth frame"})
        await client_ws.close()
        return
    token = first.get("token") or ""
    try:
        await _resolve_github_user(f"Bearer {token}" if token else None)
    except HTTPException as e:
        await client_ws.send_json({"type": "error", "message": e.detail})
        await client_ws.close()
        return

    sslctx = ssl.create_default_context(cafile=certifi.where())
    try:
        async with websockets.connect(
            _azure_realtime_url(),
            additional_headers={"api-key": AZURE_API_KEY},
            max_size=None,
            ssl=sslctx,
        ) as azure_ws:
            await azure_ws.send(json.dumps(_SESSION_UPDATE))
            await client_ws.send_json({"type": "ready"})

            audio_frames = 0
            pending_since_commit = 0

            async def pump_client_to_azure() -> None:
                nonlocal audio_frames, pending_since_commit
                while True:
                    msg = await client_ws.receive_json()
                    mtype = msg.get("type")
                    if mtype == "audio":
                        data = msg.get("data", "")
                        await azure_ws.send(json.dumps({"type": "input_audio_buffer.append", "audio": data}))
                        audio_frames += 1
                        pending_since_commit += len(data)
                    elif mtype == "stop":
                        print(f"[stt] stop received; audio_frames={audio_frames} pending_bytes={pending_since_commit}", flush=True)
                        # Only commit when audio has been appended since the last
                        # (VAD) commit; committing an empty buffer errors.
                        if pending_since_commit > 0:
                            await azure_ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
                        return

            async def pump_azure_to_client() -> None:
                nonlocal pending_since_commit
                async for raw in azure_ws:
                    evt = json.loads(raw)
                    etype = evt.get("type")
                    if etype == "input_audio_buffer.committed":
                        pending_since_commit = 0
                    elif etype == "conversation.item.input_audio_transcription.delta":
                        await client_ws.send_json({"type": "delta", "text": evt.get("delta", "")})
                    elif etype == "conversation.item.input_audio_transcription.completed":
                        await client_ws.send_json({"type": "segment", "text": evt.get("transcript", "")})
                    elif etype == "error":
                        err = evt.get("error", {}) or {}
                        code = err.get("code") if isinstance(err, dict) else None
                        # With server VAD, Azure auto-commits speech segments and
                        # clears the buffer. A trailing manual commit (or a stop
                        # with only non-speech/silence buffered) then races that
                        # and reports an empty buffer. The audio was already
                        # transcribed via VAD, so this is benign — log, don't
                        # surface it to the user as a failed transcription.
                        if code in ("input_audio_buffer_commit_empty",):
                            print(f"[stt] ignoring benign azure error: {err}", flush=True)
                            continue
                        print(f"[stt] azure error: {err}", flush=True)
                        await client_ws.send_json({"type": "error", "message": str(evt.get("error", "realtime error"))})

            client_task = asyncio.create_task(pump_client_to_azure())
            azure_task = asyncio.create_task(pump_azure_to_client())
            try:
                # When the client sends `stop`, wait briefly for the final
                # segment to arrive before tearing down.
                await client_task
                try:
                    await asyncio.wait_for(azure_task, timeout=8)
                except asyncio.TimeoutError:
                    pass
            finally:
                for task in (client_task, azure_task):
                    if not task.done():
                        task.cancel()
    except WebSocketDisconnect:
        pass
    except Exception as e:  # noqa: BLE001 - surface any bridge failure to the client
        try:
            await client_ws.send_json({"type": "error", "message": f"Realtime bridge failed: {str(e)[:300]}"})
        except Exception:
            pass
    finally:
        try:
            await client_ws.close()
        except Exception:
            pass
