const ALLOWED_ORIGIN = "https://q9999499-collab.github.io";
const CHAT_MODEL = "@cf/zai-org/glm-4.7-flash";
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const MAX_MESSAGES = 32;
const MAX_MESSAGE_CHARS = 12000;
const MAX_TOKENS = 1800;

const QASIM_SYSTEM_PROMPT = `You are Qasim, the AI assistant for the Qasim AI website.
Match the user's language: English, Urdu, Roman Urdu, or mixed Urdu/English. Answer the exact question directly. Never invent facts or claim tools/actions you did not actually use. Use supplied conversation history for context. Be accurate, useful, concise by default, and detailed when needed. For coding requests, give practical complete code and never claim it was tested unless it was actually executed.`.trim();

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8", ...CORS_HEADERS }
  });
}

function originAllowed(request) {
  const origin = request.headers.get("Origin");
  return !origin || origin === ALLOWED_ORIGIN;
}

function cleanText(value) {
  return typeof value === "string" ? value.replace(/\u0000/g, "").trim() : "";
}

// Cloudflare model response formats can vary. Walk the response safely and find text.
function extractText(value, depth = 0) {
  if (depth > 8 || value == null) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = extractText(item, depth + 1);
      if (text) return text;
    }
    return "";
  }
  if (typeof value !== "object") return "";

  const preferred = [
    "response", "text", "output_text", "content", "message", "answer", "generated_text"
  ];
  for (const key of preferred) {
    if (key in value) {
      const text = extractText(value[key], depth + 1);
      if (text) return text;
    }
  }

  if (value.choices) {
    const text = extractText(value.choices, depth + 1);
    if (text) return text;
  }

  return "";
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

async function chat(request, env) {
  const body = await readJson(request);
  if (!Array.isArray(body?.messages) || !body.messages.length) {
    return json({ error: { message: "Request must contain a non-empty messages array." } }, 400);
  }
  if (body.messages.length > MAX_MESSAGES) {
    return json({ error: { message: `Too many messages. Maximum is ${MAX_MESSAGES}.` } }, 400);
  }

  const messages = [];
  for (const message of body.messages) {
    if (!message || !["user", "assistant", "system"].includes(message.role) || typeof message.content !== "string") {
      return json({ error: { message: "Each message must contain a valid role and text content." } }, 400);
    }
    const content = cleanText(message.content);
    if (!content) return json({ error: { message: "Message content cannot be empty." } }, 400);
    if (content.length > MAX_MESSAGE_CHARS) return json({ error: { message: `A message is too long. Maximum is ${MAX_MESSAGE_CHARS} characters.` } }, 400);
    messages.push({ role: message.role, content });
  }

  const modelMessages = [
    { role: "system", content: QASIM_SYSTEM_PROMPT },
    ...messages.filter(m => m.role !== "system")
  ];

  try {
    const result = await env.AI.run(CHAT_MODEL, {
      messages: modelMessages,
      max_tokens: MAX_TOKENS,
      temperature: 0.2,
      top_p: 0.9,
      repetition_penalty: 1.05
    });

    const content = cleanText(extractText(result));
    if (!content) {
      console.error("Unexpected Workers AI response:", JSON.stringify(result));
      return json({ error: { message: "The AI service returned no text. Please try again." } }, 502);
    }

    return json({
      id: `qasim-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: CHAT_MODEL,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }]
    });
  } catch (error) {
    console.error("Qasim chat error:", error);
    return json({ error: { message: "Qasim AI is temporarily unavailable. Please try again." } }, 502);
  }
}

async function generateImage(request, env) {
  const body = await readJson(request);
  const prompt = cleanText(body?.prompt);
  if (!prompt) return json({ error: { message: "An image prompt is required." } }, 400);
  if (prompt.length > 2048) return json({ error: { message: "Image prompt is too long." } }, 400);

  try {
    const result = await env.AI.run(IMAGE_MODEL, {
      prompt,
      steps: Math.min(Math.max(Number(body?.steps) || 4, 1), 8),
      seed: Math.floor(Math.random() * 2147483647)
    });
    if (!result?.image) return json({ error: { message: "The image model returned no image." } }, 502);
    return json({ created: Math.floor(Date.now() / 1000), model: IMAGE_MODEL, data: [{ b64_json: result.image, mime_type: "image/jpeg" }] });
  } catch (error) {
    console.error("Qasim image error:", error);
    return json({ error: { message: "Image generation failed. Please try again." } }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return originAllowed(request) ? new Response(null, { status: 204, headers: CORS_HEADERS }) : json({ error: { message: "Origin not allowed." } }, 403);
    }
    if (!originAllowed(request)) return json({ error: { message: "Origin not allowed." } }, 403);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({ ok: true, service: "Qasim AI API", status: "online", provider: "Cloudflare Workers AI", model: CHAT_MODEL, image_model: IMAGE_MODEL, mode: "real-ai" });
    }

    if (!env.AI || typeof env.AI.run !== "function") {
      return json({ error: { message: "Cloudflare Workers AI binding named AI is missing." } }, 500);
    }

    if (request.method !== "POST") return json({ error: { message: "Method not allowed. Use POST." } }, 405);
    if (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") return chat(request, env);
    if (url.pathname === "/v1/images/generations" || url.pathname === "/images/generations") return generateImage(request, env);

    return json({ error: { message: "Endpoint not found." } }, 404);
  }
};
