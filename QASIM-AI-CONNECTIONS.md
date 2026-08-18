# Qasim AI — connected services

The Worker now supports:

- Gemini API — primary chat/reasoning/long answers
- FLUX.2 Dev on Cloudflare Workers AI — image generation/editing
- Tavily — current web search when a request asks for latest/current/web information
- Gemini file/image context — when the frontend sends `files`
- Supabase — persistent conversation/message storage
- Groq — fallback chat provider

## Cloudflare Worker Secrets

Add these as Worker **Secrets** (never put them in GitHub or frontend code):

- `GEMINI_API_KEY` — Google Gemini API key
- `GROQ_API_KEY` — fallback Groq API key
- `TAVILY_API_KEY` — Tavily search API key
- `SUPABASE_URL` — `https://oksovldnrfpilxxisykb.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service-role secret key

The Worker keeps FLUX.2 Dev on the Cloudflare `AI` binding. The image model is `@cf/black-forest-labs/flux-2-dev`.

## Database

Supabase project: `Arshad Computer Lab` (`oksovldnrfpilxxisykb`).

Migration `create_qasim_chat_history` creates `qasim_conversations` and `qasim_messages` with RLS enabled. The Worker uses the service-role key server-side only.

## Important

No website-side artificial chat/image count is imposed by the Worker. Provider quotas, rate limits, and billing still apply. Gemini/Tavily/Groq usage is independent of Cloudflare Workers AI Neurons for chat/search, while FLUX.2 Dev still consumes Workers AI Neurons.