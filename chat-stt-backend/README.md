# chat-stt-backend

Transcription backend for the VS Code chat-input speech-to-text feature
(`chat.speechToText.*`). It hides the Azure OpenAI credentials server-side so
they never ship in the client: the VS Code client records audio and POSTs it
here with the user's GitHub token; this service authorizes the caller, forwards
the audio to an Azure OpenAI transcription deployment, and returns the text.

## Wire contract

```
POST /transcribe
Authorization: Bearer <github-token>
Content-Type: multipart/form-data; file=<audio blob>

200 OK -> { "text": "<transcription>" }
```

`GET /health` returns `{ "ok": true }`.

## Run locally

```bash
cd chat-stt-backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # fill in AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY
export $(grep -v '^#' .env | xargs)   # or use a dotenv loader / your process manager
uvicorn main:app --reload --port 8000
```

Then in VS Code settings:

```jsonc
"chat.speechToText.serverUrl": "http://localhost:8000/transcribe"
```

For local testing without GitHub auth, set `REQUIRE_GITHUB_AUTH=false`.

## Getting the Azure values

1. Create an **Azure OpenAI** resource in the Azure portal.
2. Deploy a transcription model (`gpt-4o-mini-transcribe` or `gpt-4o-transcribe`);
   the deployment name you choose is `AZURE_OPENAI_DEPLOYMENT`.
3. Copy the **Endpoint** and a **Key** from the resource's *Keys and Endpoint*
   page into `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_KEY`.

## Production notes

- Put this behind HTTPS and a real host; set `chat.speechToText.serverUrl`
  (or the `chatSpeechToTextUrl` field in `product.json`) to that URL.
- `_resolve_github_user` validates the token against `api.github.com/user`.
  Extend it to check Copilot entitlement before transcribing, since Azure bills
  the resource owner per minute of audio.
- Consider rate limiting and per-user usage metering.
