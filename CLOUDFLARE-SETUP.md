# Qasim AI — Cloudflare setup

Qasim AI uses Cloudflare Workers AI for the backend. The GitHub Pages frontend does not contain an AI provider API key.

## Wrangler configuration

`wrangler.jsonc` is the source of truth for the Worker bindings.

It defines:

- `AI` — Workers AI inference and image generation.
- `AI_SEARCH` — Cloudflare AI Search namespace (`default`) for knowledge/document search.
- `MEMORY` — KV storage reserved for persistent conversation/user memory.
- `FILES` — R2 bucket reserved for uploaded files.

Cloudflare's current Wrangler configuration supports Workers AI, AI Search namespaces, KV, and R2 bindings. AI Search's modern Workers binding is `ai_search` or `ai_search_namespaces`; the legacy `env.AI.autorag()` API is not recommended for new work.

## Main Worker

- Worker: `qasim-ai-api`
- Source: `worker.js`
- Main binding: `env.AI`

## AI model

Chat model:

`@cf/zai-org/glm-4.7-flash`

This model supports multilingual dialogue, reasoning, coding, and multi-turn tool calling.

Image model:

`@cf/black-forest-labs/flux-1-schnell`

## Endpoints

Chat:

`https://qasim-ai-api.q9999499.workers.dev/v1/chat/completions`

Image generation:

`https://qasim-ai-api.q9999499.workers.dev/v1/images/generations`

Health:

`https://qasim-ai-api.q9999499.workers.dev/health`

## Security

The browser does not receive an OpenAI API key. The Worker uses the native Cloudflare Workers AI binding. CORS is restricted to:

`https://q9999499-collab.github.io`

## Deployment

Cloudflare/Wrangler should deploy `worker.js` using `wrangler.jsonc`.

Cloudflare's current documentation states that Wrangler can automatically provision supported resources such as KV, R2 and AI Search when bindings are configured without resource IDs. Resource identifiers created from dashboard/GitHub deployments may be visible in Cloudflare even when they are not written back into the repository.

After deployment, verify:

1. `AI` binding exists.
2. `AI_SEARCH` namespace binding exists.
3. `MEMORY` KV binding exists.
4. `FILES` R2 bucket binding exists.
5. `/health` reports the current model.
6. `/v1/chat/completions` returns an AI response.
7. `/v1/images/generations` returns an image.
