const ALLOWED_ORIGIN = "https://q9999499-collab.github.io";

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return allowed(request)
        ? new Response(null, { status: 204, headers: CORS_HEADERS })
        : json({ error: { message: "Origin not allowed." } }, 403);
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({ ok: true, service: "Qasim AI API", status: "online" });
    }

    if (!allowed(request)) {
      return json({ error: { message: "Origin not allowed." } }, 403);
    }

    if (request.method !== "POST") {
      return json({ error: { message: "Method not allowed. Use POST." } }, 405, { Allow: "GET, POST, OPTIONS" });
    }

    if (url.pathname !== "/v1/chat/completions" && url.pathname !== "/chat/completions") {
      return json({ error: { message: "Endpoint not found." } }, 404);
    }

    if (!env.OPENAI_API_KEY) {
      return json({ error: { message: "OPENAI_API_KEY secret is not configured." } }, 500);
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
      messages.push({ role: m.role, content: m.content });
    }

    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : "gpt-4o-mini";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 55000);

    let response;
    try {
      response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: QASIM_SYSTEM_PROMPT }, ...messages]
        })
      });
    } catch (error) {
      return json({ error: { message: error?.name === "AbortError" ? "AI provider request timed out." : "Could not connect to the AI provider." } }, 502);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return json({ error: { message: "AI provider returned an invalid response." } }, 502);
    }

    if (!response.ok) {
      return json({ error: { message: data?.error?.message || "AI provider returned an error." } }, response.status >= 400 && response.status < 600 ? response.status : 502);
    }

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      return json({ error: { message: "AI provider returned an empty response." } }, 502);
    }

    return json({
      id: data.id || `qasim-${Date.now()}`,
      object: "chat.completion",
      created: data.created || Math.floor(Date.now() / 1000),
      model: data.model || model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: data.choices?.[0]?.finish_reason || "stop" }],
      usage: data.usage || undefined
    });
  }
};
