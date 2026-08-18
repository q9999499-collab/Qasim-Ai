# Qasim AI — Cloudflare Workers AI setup

Qasim AI now uses **Cloudflare Workers AI** directly. OpenAI is not used by the frontend or backend.

## Security

No AI provider API key is placed in `index.html` or sent from the browser. The Worker uses a native Workers AI binding named `AI`.

## Worker binding

In Cloudflare Worker settings, add:

- Binding type: **Workers AI**
- Variable name: **AI**

The Worker code accesses it as `env.AI`.

Cloudflare documents this binding and `env.AI.run()` pattern here:
https://developers.cloudflare.com/workers-ai/configuration/bindings/

## Worker endpoint

`https://qasim-ai-api.q9999499.workers.dev/v1/chat/completions`

Health check:

`https://qasim-ai-api.q9999499.workers.dev/health`

## Model

The backend uses:

`@cf/meta/llama-3.1-8b-instruct`

The browser may send the model field, but the Worker intentionally controls the actual model so the client cannot select an unsupported provider.

## Frontend

`index.html` calls the Worker endpoint with standard chat-completions JSON. No `API_KEY` is required in the browser.

## CORS

The Worker only permits the Qasim AI GitHub Pages origin:

`https://q9999499-collab.github.io`
