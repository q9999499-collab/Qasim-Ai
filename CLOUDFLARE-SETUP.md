# Qasim AI — Cloudflare Worker setup

The repository now contains `worker.js`, a normal JavaScript Cloudflare Worker backend.

## Important security rule

Never put the OpenAI API key in `index.html`, browser JavaScript, GitHub, screenshots, or ChatGPT.

Create a Cloudflare Worker from the `worker.js` code and add this as a Cloudflare Secret:

`OPENAI_API_KEY`

## Worker endpoint

After deployment, the frontend endpoint should be:

`https://YOUR-WORKER.workers.dev/v1/chat/completions`

The health check is:

`https://YOUR-WORKER.workers.dev/health`

## Frontend configuration

In `index.html`, set:

```js
const CONFIG = {
  API_URL: "https://YOUR-WORKER.workers.dev/v1/chat/completions",
  API_KEY: "",
  MODEL: "gpt-4o-mini",
  TIMEOUT_MS: 60000
};
```

`API_KEY` must remain empty.

## CORS

The Worker only permits the Qasim AI GitHub Pages origin:

`https://q9999499-collab.github.io`
