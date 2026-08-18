const ALLOWED_ORIGIN = "https://q9999499-collab.github.io";
const CHAT_MODEL = "@cf/zai-org/glm-4.7-flash";
const IMAGE_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
const MAX_MESSAGE_CHARS = 12000;
const MAX_CONTEXT_MESSAGES = 16;
const MAX_COMPLETION_TOKENS = 4096;

const SYSTEM_PROMPT = `You are Qasim AI, a careful, capable multilingual assistant.
Understand English, Urdu, Roman Urdu, and mixed Urdu/English. Reply naturally in the user's language.
Answer the exact question asked. Do not change the subject. Answer every requested part.
For difficult tasks, reason carefully, state assumptions, check calculations, and verify conclusions.
For math, show auditable steps, consistent units, and a final independent check.
For science, distinguish established facts, assumptions, estimates, interpretations, and analogies. Never present an analogy as literal physics. Do not imply faster-than-light communication from quantum entanglement.
For coding, give complete practical code and do not claim testing/deployment unless it actually happened.
Never invent facts, citations, searches, tools, actions, files, or results. If uncertain, say so.
Keep answers complete without unnecessary repetition.
When the user asks to continue, continue from the previous point instead of restarting.`.trim();

const CORS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS }
  });
}

function clean(value) {
  return typeof value === "string" ? value.replace(/\u0000/g, "").trim() : "";
}

async function readJSON(request) {
  try { return await request.json(); } catch { return null; }
}

function extractText(result) {
  if (typeof result === "string") return clean(result);
  if (!result || typeof result !== "object") return "";
  const candidates = [result.response, result.text, result.output_text, result.answer, result.generated_text, result.content, result.message?.content, result.choices?.[0]?.message?.content, result.choices?.[0]?.text];
  for (const value of candidates) {
    const text = clean(value);
    if (text) return text;
  }
  return "";
}

function recentMessages(messages) {
  const valid = messages.filter(m => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string");
  return valid.slice(-MAX_CONTEXT_MESSAGES);
}

async function runChat(env, messages) {
  return env.AI.run(CHAT_MODEL, {
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...recentMessages(messages)],
    max_completion_tokens: MAX_COMPLETION_TOKENS,
    temperature: 0.15,
    top_p: 0.9
  });
}

async function chat(request, env) {
  const body = await readJSON(request);
  if (!Array.isArray(body?.messages) || !body.messages.length) return json({ error: { message: "A non-empty messages array is required." } }, 400);

  const messages = [];
  for (const message of body.messages) {
    if (!message || !["user", "assistant", "system"].includes(message.role) || typeof message.content !== "string") return json({ error: { message: "Invalid message format." } }, 400);
    const content = clean(message.content);
    if (!content) continue;
    if (content.length > MAX_MESSAGE_CHARS) return json({ error: { message: "Message is too long." } }, 400);
    if (message.role !== "system") messages.push({ role: message.role, content });
  }

  try {
    let result = await runChat(env, messages);
    let text = extractText(result);
    if (!text) {
      result = await runChat(env, messages);
      text = extractText(result);
    }
    if (!text) return json({ error: { message: "The AI model returned an empty response. Please try again." } }, 502);

    return json({
      id: `qasim-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: CHAT_MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }]
    });
  } catch (error) {
    console.error("Qasim chat error", error?.stack || error);
    return json({ error: { message: error?.message || "Cloudflare Workers AI request failed." } }, 502);
  }
}

function dataUrlToBytes(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl || "");
  if (!match) return null;
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { mime: match[1], bytes };
}

async function generateImage(request, env) {
  const body = await readJSON(request);
  const prompt = clean(body?.prompt);
  if (!prompt) return json({ error: { message: "Image prompt is required." } }, 400);
  if (prompt.length > 4000) return json({ error: { message: "Image prompt is too long." } }, 400);

  try {
    const form = new FormData();
    form.set("prompt", prompt);
    if (body?.input_image) {
      const parsed = dataUrlToBytes(body.input_image);
      if (!parsed) return json({ error: { message: "Invalid input image." } }, 400);
      if (parsed.bytes.byteLength > 4 * 1024 * 1024) return json({ error: { message: "Input image is too large." } }, 400);
      form.set("input_image_0", new File([parsed.bytes], "reference.jpg", { type: parsed.mime || "image/jpeg" }));
    }

    const result = await env.AI.run(IMAGE_MODEL, form);
    if (!result?.image) return json({ error: { message: "Image model returned no image." } }, 502);

    return json({
      created: Math.floor(Date.now() / 1000),
      model: IMAGE_MODEL,
      data: [{ b64_json: result.image, mime_type: "image/jpeg" }]
    });
  } catch (error) {
    console.error("Qasim image error", error?.stack || error);
    return json({ error: { message: error?.message || "Image generation/editing failed." } }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      if (origin && origin !== ALLOWED_ORIGIN) return json({ error: { message: "Origin not allowed." } }, 403);
      return new Response(null, { status: 204, headers: CORS });
    }
    if (origin && origin !== ALLOWED_ORIGIN) return json({ error: { message: "Origin not allowed." } }, 403);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({ ok: true, service: "Qasim AI API", status: "online", provider: "Cloudflare Workers AI", model: CHAT_MODEL, image_model: IMAGE_MODEL, mode: "real-ai", image_editing: true });
    }

    if (!env.AI || typeof env.AI.run !== "function") return json({ error: { message: "Cloudflare Workers AI binding named AI is missing." } }, 500);
    if (request.method !== "POST") return json({ error: { message: "Use POST for this endpoint." } }, 405);

    if (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") return chat(request, env);
    if (url.pathname === "/v1/images/generations" || url.pathname === "/images/generations") return generateImage(request, env);

    return json({ error: { message: "Endpoint not found." } }, 404);
  }
};
