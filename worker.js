const ALLOWED_ORIGIN = "https://q9999499-collab.github.io";
const CHAT_MODEL = "@cf/zai-org/glm-4.7-flash";
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 16000;
const MAX_TOKENS = 6144;

const SYSTEM_PROMPT = `You are Qasim, a careful, high-quality AI assistant.

LANGUAGE
- Understand English, Urdu, Roman Urdu, and mixed Urdu/English.
- Reply in the user's language and writing style unless asked otherwise.
- For Roman Urdu, use natural, readable Roman Urdu and avoid random English words.

ACCURACY AND REASONING
- Answer the exact question asked; do not answer a different question.
- For difficult problems, reason carefully, check assumptions, calculate intermediate values, and verify the final result before answering.
- Distinguish facts, estimates, assumptions, analogies, and uncertainty.
- Never invent facts, citations, web searches, files, tool calls, actions, or results.
- For science, medicine, law, finance, and other high-stakes topics, be precise about uncertainty and avoid presenting an analogy as a literal fact.
- For math, show enough working to make the answer auditable and re-check arithmetic.
- If a question is ambiguous and the ambiguity materially changes the answer, ask a concise clarification; otherwise state the assumption and proceed.

CONVERSATION
- Use the supplied conversation history.
- Maintain continuity and do not unnecessarily restart an answer.
- If the user asks to continue, continue from the last point instead of repeating the entire answer.

CODING
- Give complete, practical code when requested.
- Prefer secure defaults and explain important configuration requirements.
- Never claim code was deployed, tested, or executed unless that actually happened.

STYLE
- Be direct, helpful, professional, and concise when the question is simple.
- For complex questions, give a structured, complete answer rather than stopping halfway.`.trim();

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

function extractText(result) {
  if (typeof result === "string") return clean(result);
  const candidates = [
    result?.response,
    result?.text,
    result?.output_text,
    result?.answer,
    result?.generated_text,
    result?.content,
    result?.message?.content,
    result?.choices?.[0]?.message?.content,
    result?.choices?.[0]?.text
  ];
  for (const value of candidates) {
    const text = clean(value);
    if (text) return text;
  }
  return "";
}

async function readJSON(request) {
  try { return await request.json(); } catch { return null; }
}

async function runChat(env, messages, maxTokens) {
  return env.AI.run(CHAT_MODEL, {
    messages,
    max_completion_tokens: maxTokens,
    temperature: 0.2,
    top_p: 0.9
  });
}

async function chat(request, env) {
  const body = await readJSON(request);

  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return json({ error: { message: "A non-empty messages array is required." } }, 400);
  }

  if (body.messages.length > MAX_MESSAGES) {
    return json({ error: { message: `Maximum ${MAX_MESSAGES} messages are allowed.` } }, 400);
  }

  const messages = [];
  for (const message of body.messages) {
    if (!message || !["user", "assistant", "system"].includes(message.role) || typeof message.content !== "string") {
      return json({ error: { message: "Invalid message format." } }, 400);
    }
    const content = clean(message.content);
    if (!content) return json({ error: { message: "Message cannot be empty." } }, 400);
    if (content.length > MAX_MESSAGE_CHARS) return json({ error: { message: "Message is too long." } }, 400);
    messages.push({ role: message.role, content });
  }

  const aiMessages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...messages.filter(m => m.role !== "system")
  ];

  try {
    let result = await runChat(env, aiMessages, MAX_TOKENS);
    let text = extractText(result);

    // One controlled retry protects against transient empty model responses.
    if (!text) {
      console.warn("Empty Workers AI response; retrying once.");
      result = await runChat(env, aiMessages, 4096);
      text = extractText(result);
    }

    if (!text) {
      console.error("Workers AI returned no extractable text:", JSON.stringify(result));
      return json({
        error: {
          message: "Cloudflare AI returned no text. Please try again.",
          response_type: typeof result,
          response_keys: result && typeof result === "object" ? Object.keys(result) : []
        }
      }, 502);
    }

    return json({
      id: `qasim-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: CHAT_MODEL,
      choices: [{
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop"
      }]
    });
  } catch (error) {
    console.error("Qasim chat error:", error?.stack || error);
    return json({ error: { message: error?.message || "Cloudflare Workers AI request failed." } }, 502);
  }
}

async function generateImage(request, env) {
  const body = await readJSON(request);
  const prompt = clean(body?.prompt);
  if (!prompt) return json({ error: { message: "Image prompt is required." } }, 400);
  if (prompt.length > 3000) return json({ error: { message: "Image prompt is too long." } }, 400);

  try {
    const result = await env.AI.run(IMAGE_MODEL, { prompt, steps: 4 });
    if (!result?.image) return json({ error: { message: "Image model returned no image." } }, 502);
    return json({
      created: Math.floor(Date.now() / 1000),
      model: IMAGE_MODEL,
      data: [{ b64_json: result.image, mime_type: "image/jpeg" }]
    });
  } catch (error) {
    console.error("Qasim image error:", error?.stack || error);
    return json({ error: { message: error?.message || "Image generation failed." } }, 502);
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
      return json({
        ok: true,
        service: "Qasim AI API",
        status: "online",
        provider: "Cloudflare Workers AI",
        model: CHAT_MODEL,
        image_model: IMAGE_MODEL,
        mode: "real-ai"
      });
    }

    if (!env.AI || typeof env.AI.run !== "function") {
      return json({ error: { message: "Cloudflare Workers AI binding named AI is missing." } }, 500);
    }

    if (request.method !== "POST") return json({ error: { message: "Use POST for this endpoint." } }, 405);

    if (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") return chat(request, env);
    if (url.pathname === "/v1/images/generations" || url.pathname === "/images/generations") return generateImage(request, env);

    return json({ error: { message: "Endpoint not found." } }, 404);
  }
};
