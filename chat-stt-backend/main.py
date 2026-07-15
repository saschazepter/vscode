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

import os
from typing import Optional

import httpx
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# --- Configuration (server-side only) ---------------------------------------

AZURE_ENDPOINT = os.environ.get("AZURE_OPENAI_ENDPOINT", "").rstrip("/")
AZURE_API_KEY = os.environ.get("AZURE_OPENAI_API_KEY", "")
AZURE_DEPLOYMENT = os.environ.get("AZURE_OPENAI_DEPLOYMENT", "gpt-4o-mini-transcribe")
AZURE_API_VERSION = os.environ.get("AZURE_OPENAI_API_VERSION", "2025-03-01-preview")

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
