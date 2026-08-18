const ALLOWED_ORIGIN = "https://q9999499-collab.github.io";
const MODEL = "@cf/meta/llama-3.1-8b-instruct";

const QASIM_SYSTEM_PROMPT = `You are Qasim, a friendly, intelligent AI assistant.
Be helpful, clear, accurate and professional.
Be concise when appropriate.
Understand and respond naturally in English, Urdu, Roman Urdu, and mixed Urdu/English.
Never claim to have performed an action, accessed a file, browsed the internet, used a tool, or completed a task unless you actually performed that action.
If something is unavailable, explain the limitation honestly.`;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin"
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8", ...CORS_HEADERS, ...extra }
  });
}

function allowed(request) {
  const origin = request.headers.get("Origin");
  return !origin || origin === ALLOWED_ORIGIN;
}

function getText(result) {
  if (typeof result === "string") return result;
  if (typeof result?.response === "string") return result.response;
  if (typeof result?.text === "string") return result.text;
  if (typeof result?.output_text === "string") return result.output_text;
  return "";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return allowed(request)
        ? new Response(null, { status: 204, headers: CORS_HEADERS })
        : json({ error: { message: "Origin not allowed." } }, 403);
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({ ok: true, service: "Qasim AI API", status: "online", provider: "Cloudflare Workers AI", model: MODEL });
    }

    if (!allowed(request)) {
      return json({ error: { message: "Origin not allowed." } }, 403);
    }

    if (url.pathname !== "/v1/chat/completions" && url.pathname !== "/chat/completions") {
      return json({ error: { message: "Endpoint not found." } }, 404);
    }

    if (request.method !== "POST") {
      return json({ error: { message: "Method not allowed. Use POST." } }, 405, { Allow: "GET, POST, OPTIONS" });
    }

    if (!env.AI) {
      return json({ error: { message: "Cloudflare Workers AI binding is missing. Add an AI binding named AI." } }, 500);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: { message: "Invalid JSON request body." } }, 400);
    }

    if (!Array.isArray(body?.messages) || body.messages.length === 0) {
      return json({ error: { message: "Request must contain a non-empty messages array." } }, 400);
    }

    const messages = [];
    for (const m of body.messages) {
      if (!m || !["user", "assistant", "system"].includes(m.role) || typeof m.content !== "string" || !m.content.trim()) {
        return json({ error: { message: "Each message must contain a valid role and non-empty text content." } }, 400);
      }
      messages.push({ role: m.role, content: m.content.trim() });
    }

    const modelMessages = [
      { role: "system", content: QASIM_SYSTEM_PROMPT },
      ...messages.filter(m => m.role !== "system")
    ];

    try {
      const result = await env.AI.run(MODEL, {
        messages: modelMessages,
        max_tokens: 1024
      });

      const content = getText(result);
      if (!content.trim()) {
        return json({ error: { message: "Cloudflare Workers AI returned an empty response." } }, 502);
      }

      return json({
        id: `qasim-${crypto.randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: MODEL,
        choices: [{
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop"
        }]
      });
    } catch (error) {
      console.error("Qasim Workers AI error:", error);
      return json({
        error: { message: error?.message || "Cloudflare Workers AI request failed." }
      }, 502);
    }
  }
};
