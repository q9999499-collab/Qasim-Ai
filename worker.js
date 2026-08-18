const ALLOWED_ORIGIN = "https://q9999499-collab.github.io";

// Speed-first routing:
// - Groq is primary for chat because the website gets a response sooner.
// - Gemini is the chat fallback and still supports very long answers.
// - FLUX.2 Klein 4B is primary for images because it is a distilled 4-step model optimized for speed.
const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const FLUX_FAST_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
const FLUX_QUALITY_MODEL = "@cf/black-forest-labs/flux-2-dev";

const CORS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Qasim-Client",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

const SYSTEM_PROMPT = `You are Qasim AI.
Answer naturally, accurately, helpfully and completely.
Support English, Urdu, Roman Urdu and mixed language; follow the user's language.
Match the requested length: short when asked, detailed when asked, and medium by default.
For complex questions, use clear headings, bullets, steps, examples, timelines, calculations or tables when useful.
Never return an empty answer.
Do not claim an image, file, web search or tool was used unless it actually was.`;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS,
      ...extraHeaders,
    },
  });
}

function clean(value) {
  return typeof value === "string" ? value.replace(/\u0000/g, "").trim() : "";
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

async function readJSON(request) {
  try { return await request.json(); } catch { return null; }
}

async function timeoutFetch(url, options = {}, timeout = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: clean(m.content) }))
    .filter((m) => m.content)
    .slice(-20);
}

function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((p) => typeof p?.text === "string" ? p.text : "").join("").trim();
}

async function groq(messages, env, maxTokens) {
  if (!env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not configured");

  const response = await timeoutFetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages,
      ],
      temperature: 0.3,
      max_tokens: Math.min(maxTokens, 32768),
    }),
  }, 20000);

  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || `Groq HTTP ${response.status}`);

  const answer = clean(data?.choices?.[0]?.message?.content);
  if (!answer) throw new Error("Groq returned an empty response");
  return answer;
}

async function gemini(messages, env, maxTokens) {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");

  const prompt = messages
    .map((m) => `${m.role === "assistant" ? "ASSISTANT" : "USER"}: ${m.content}`)
    .join("\n\n");

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
  const response = await timeoutFetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [{ text: `${SYSTEM_PROMPT}\n\nCONVERSATION:\n${prompt}` }],
      }],
      generationConfig: {
        maxOutputTokens: Math.min(maxTokens, 65536),
      },
    }),
  }, 30000);

  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || `Gemini HTTP ${response.status}`);

  const answer = extractGeminiText(data);
  if (!answer) {
    const reason = data?.candidates?.[0]?.finishReason || "UNKNOWN";
    throw new Error(`Gemini returned an empty response (${reason})`);
  }
  return answer;
}

async function streamGroq(messages, env, maxTokens) {
  if (!env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not configured");

  const response = await timeoutFetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
      temperature: 0.3,
      max_tokens: Math.min(maxTokens, 32768),
      stream: true,
    }),
  }, 20000);

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error?.message || `Groq HTTP ${response.status}`);
  }

  const headers = new Headers(CORS);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("Connection", "keep-alive");
  return new Response(response.body, { status: 200, headers });
}

function wantsSearch(text) {
  return /\b(latest|today|current|now|news|recent|price|weather|score|search|look up|web|2026|aaj|abhi|taza|khabar)\b/i.test(text || "");
}

async function webSearch(query, env) {
  if (!env.TAVILY_API_KEY) return "";
  try {
    const response = await timeoutFetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: env.TAVILY_API_KEY,
        query,
        search_depth: "basic",
        max_results: 4,
      }),
    }, 8000);
    if (!response.ok) return "";
    const data = await response.json().catch(() => null);
    return (data?.results || [])
      .map((r) => `Title: ${r.title || ""}\nURL: ${r.url || ""}\n${r.content || ""}`)
      .join("\n\n");
  } catch (error) {
    console.error("WEB_SEARCH_ERROR", error);
    return "";
  }
}

async function supabaseRequest(env, path, options = {}, timeout = 6000) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase is not configured");
  return timeoutFetch(`${env.SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  }, timeout);
}

async function loadHistory(conversationId, env) {
  if (!conversationId || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return [];
  try {
    const path = `/rest/v1/qasim_messages?conversation_id=eq.${encodeURIComponent(conversationId)}&select=role,content&order=created_at.asc&limit=50`;
    const response = await supabaseRequest(env, path, { method: "GET" }, 5000);
    if (!response.ok) return [];
    const data = await response.json().catch(() => []);
    return Array.isArray(data) ? normalizeMessages(data) : [];
  } catch {
    return [];
  }
}

async function saveMessages(clientId, conversationId, userText, answer, env) {
  if (!clientId || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return conversationId || null;
  try {
    let id = conversationId;
    if (!id) {
      const create = await supabaseRequest(env, "/rest/v1/qasim_conversations?select=id", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ client_id: clientId, title: clean(userText).slice(0, 80) || "New conversation" }),
      }, 5000);
      const rows = await create.json().catch(() => []);
      id = rows?.[0]?.id || null;
    }
    if (!id) return conversationId || null;

    await Promise.all([
      supabaseRequest(env, "/rest/v1/qasim_messages", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ conversation_id: id, role: "user", content: userText }),
      }, 5000),
      supabaseRequest(env, "/rest/v1/qasim_messages", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ conversation_id: id, role: "assistant", content: answer }),
      }, 5000),
    ]);
    return id;
  } catch (error) {
    console.error("SUPABASE_SAVE_ERROR", error);
    return conversationId || null;
  }
}

function dataUrl(value) {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(value || "");
  if (!match) return null;
  try {
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { mime: match[1], bytes };
  } catch {
    return null;
  }
}

function binaryToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

async function fluxKleinImage(prompt, env, inputImages = []) {
  if (!env.AI) throw new Error("Workers AI binding AI is missing");

  const form = new FormData();
  form.append("prompt", `${prompt}\n\nPhotorealistic, natural lighting, realistic textures, accurate proportions, professional photography, crisp detail.`);
  form.append("width", "1024");
  form.append("height", "1024");

  for (let i = 0; i < Math.min(inputImages.length, 4); i++) {
    const parsed = dataUrl(inputImages[i]);
    if (!parsed) continue;
    form.append(`input_image_${i}`, new File([parsed.bytes], `input-${i}.jpg`, { type: parsed.mime }));
  }

  const req = new Request("https://qasim-ai-multipart.invalid", { method: "POST", body: form });
  const result = await env.AI.run(FLUX_FAST_MODEL, {
    multipart: {
      body: req.body,
      contentType: req.headers.get("content-type") || "multipart/form-data",
    },
  });

  const image = typeof result?.image === "string" ? result.image : typeof result?.response === "string" ? result.response : "";
  if (!image) throw new Error("FLUX Klein returned no image");
  return { image, mime: "image/jpeg", provider: "Cloudflare FLUX.2 Klein 4B", model: FLUX_FAST_MODEL };
}

async function fluxDevImage(prompt, env, inputImages = []) {
  if (!env.AI) throw new Error("Workers AI binding AI is missing");
  const form = new FormData();
  form.append("prompt", `${prompt}\n\nUltra-realistic, photorealistic, professional photography, natural lighting, realistic textures, realistic shadows, accurate proportions, cinematic composition.`);
  form.append("width", "1024");
  form.append("height", "1024");
  form.append("steps", "16");
  for (let i = 0; i < Math.min(inputImages.length, 4); i++) {
    const parsed = dataUrl(inputImages[i]);
    if (!parsed) continue;
    form.append(`input_image_${i}`, new File([parsed.bytes], `input-${i}.jpg`, { type: parsed.mime }));
  }
  const req = new Request("https://qasim-ai-multipart.invalid", { method: "POST", body: form });
  const result = await env.AI.run(FLUX_QUALITY_MODEL, {
    multipart: { body: req.body, contentType: req.headers.get("content-type") || "multipart/form-data" },
  });
  const image = typeof result?.image === "string" ? result.image : typeof result?.response === "string" ? result.response : "";
  if (!image) throw new Error("FLUX Dev returned no image");
  return { image, mime: "image/jpeg", provider: "Cloudflare FLUX.2 Dev", model: FLUX_QUALITY_MODEL };
}

async function huggingFaceImage(prompt, env) {
  if (!env.HF_TOKEN) throw new Error("HF_TOKEN is missing");
  const model = "black-forest-labs/FLUX.1-schnell";
  const response = await timeoutFetch(`https://router.huggingface.co/hf-inference/models/${model}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.HF_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ inputs: `${prompt}\nPhotorealistic professional photography, natural lighting.` }),
  }, 45000);
  if (!response.ok) throw new Error(`Hugging Face HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 250)}`);
  return { image: binaryToBase64(new Uint8Array(await response.arrayBuffer())), mime: response.headers.get("content-type") || "image/jpeg", provider: "Hugging Face", model };
}

async function falImage(prompt, env) {
  if (!env.FAL_KEY) throw new Error("FAL_KEY is missing");
  const response = await timeoutFetch("https://fal.run/fal-ai/flux/schnell", {
    method: "POST",
    headers: { Authorization: `Key ${env.FAL_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, image_size: "square_hd", num_images: 1 }),
  }, 45000);
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.detail || data?.error || `fal.ai HTTP ${response.status}`);
  const url = data?.images?.[0]?.url;
  if (!url) throw new Error("fal.ai returned no image");
  const imageResponse = await timeoutFetch(url, {}, 20000);
  if (!imageResponse.ok) throw new Error("fal.ai image download failed");
  return { image: binaryToBase64(new Uint8Array(await imageResponse.arrayBuffer())), mime: imageResponse.headers.get("content-type") || "image/jpeg", provider: "fal.ai", model: "fal-ai/flux/schnell" };
}

async function replicateImage(prompt, env) {
  if (!env.REPLICATE_API_TOKEN) throw new Error("REPLICATE_API_TOKEN is missing");
  const create = await timeoutFetch("https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.REPLICATE_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: { prompt } }),
  }, 25000);
  let result = await create.json().catch(() => null);
  if (!create.ok) throw new Error(result?.detail || `Replicate HTTP ${create.status}`);
  for (let i = 0; i < 30; i++) {
    if (result?.status === "succeeded") break;
    if (result?.status === "failed" || result?.status === "canceled") throw new Error(result?.error || "Replicate generation failed");
    if (!result?.urls?.get) throw new Error("Replicate polling URL missing");
    await new Promise((resolve) => setTimeout(resolve, 700));
    const poll = await timeoutFetch(result.urls.get, { headers: { Authorization: `Bearer ${env.REPLICATE_API_TOKEN}` } }, 10000);
    result = await poll.json().catch(() => null);
  }
  const output = Array.isArray(result?.output) ? result.output[0] : result?.output;
  if (!output) throw new Error("Replicate returned no image");
  const imageResponse = await timeoutFetch(output, {}, 20000);
  if (!imageResponse.ok) throw new Error("Replicate image download failed");
  return { image: binaryToBase64(new Uint8Array(await imageResponse.arrayBuffer())), mime: imageResponse.headers.get("content-type") || "image/jpeg", provider: "Replicate", model: "black-forest-labs/flux-schnell" };
}

async function togetherImage(prompt, env) {
  if (!env.TOGETHER_API_KEY) throw new Error("TOGETHER_API_KEY is missing");
  const response = await timeoutFetch("https://api.together.xyz/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.TOGETHER_API_KEY}` },
    body: JSON.stringify({ model: "black-forest-labs/FLUX.1-schnell", prompt, width: 1024, height: 1024, steps: 4, n: 1, response_format: "b64_json" }),
  }, 45000);
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || `Together HTTP ${response.status}`);
  const image = data?.data?.[0]?.b64_json;
  if (!image) throw new Error("Together returned no image");
  return { image, mime: "image/png", provider: "Together AI", model: "black-forest-labs/FLUX.1-schnell" };
}

async function geminiImage(prompt, env) {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is missing");
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
  const response = await timeoutFetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: `${prompt}\nCreate a high-quality photorealistic image with natural lighting and realistic textures.` }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    }),
  }, 45000);
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || `Gemini Image HTTP ${response.status}`);
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p) => p?.inlineData?.data || p?.inline_data?.data);
  const inline = imagePart?.inlineData || imagePart?.inline_data;
  if (!inline?.data) throw new Error("Gemini Image returned no image");
  return { image: inline.data, mime: inline.mimeType || inline.mime_type || "image/png", provider: "Gemini Image", model: GEMINI_IMAGE_MODEL };
}

async function generateImage(prompt, env, inputImages = [], quality = "fast") {
  const providers = quality === "quality"
    ? [
        { enabled: Boolean(env.AI), run: () => fluxDevImage(prompt, env, inputImages) },
        { enabled: Boolean(env.GEMINI_API_KEY), run: () => geminiImage(prompt, env) },
        { enabled: Boolean(env.FAL_KEY), run: () => falImage(prompt, env) },
        { enabled: Boolean(env.HF_TOKEN), run: () => huggingFaceImage(prompt, env) },
        { enabled: Boolean(env.REPLICATE_API_TOKEN), run: () => replicateImage(prompt, env) },
        { enabled: Boolean(env.TOGETHER_API_KEY), run: () => togetherImage(prompt, env) },
      ]
    : [
        { enabled: Boolean(env.AI), run: () => fluxKleinImage(prompt, env, inputImages) },
        { enabled: Boolean(env.GEMINI_API_KEY), run: () => geminiImage(prompt, env) },
        { enabled: Boolean(env.HF_TOKEN), run: () => huggingFaceImage(prompt, env) },
        { enabled: Boolean(env.FAL_KEY), run: () => falImage(prompt, env) },
        { enabled: Boolean(env.TOGETHER_API_KEY), run: () => togetherImage(prompt, env) },
        { enabled: Boolean(env.REPLICATE_API_TOKEN), run: () => replicateImage(prompt, env) },
      ];

  const errors = [];
  for (const provider of providers) {
    if (!provider.enabled) continue;
    try { return await provider.run(); }
    catch (error) {
      console.error("IMAGE_PROVIDER_FAILED", error?.message);
      errors.push(error?.message || "unknown error");
    }
  }
  throw new Error(`All image providers failed. ${errors.join(" | ")}`);
}

async function handleImage(request, env) {
  const body = await readJSON(request);
  const prompt = clean(body?.prompt);
  if (!prompt) return json({ error: { message: "Image prompt is required" } }, 400);

  try {
    const result = await generateImage(
      prompt,
      env,
      Array.isArray(body?.images) ? body.images : [],
      body?.quality === "quality" ? "quality" : "fast",
    );
    return json({
      created: true,
      provider: result.provider,
      model: result.model || result.provider,
      data: [{ b64_json: result.image, mime_type: result.mime }],
    });
  } catch (error) {
    return json({ error: { code: "ALL_IMAGE_PROVIDERS_FAILED", message: error?.message || "Image generation failed" } }, 502);
  }
}

async function handleChat(request, env, ctx) {
  const body = await readJSON(request);
  if (!Array.isArray(body?.messages)) return json({ error: { message: "messages array is required" } }, 400);

  let messages = normalizeMessages(body.messages);
  if (!messages.length) return json({ error: { message: "No valid messages" } }, 400);

  const sessionId = clean(body?.session_id) || crypto.randomUUID();
  const clientId = clean(body?.client_id);
  const maxTokens = clampInt(body?.max_output_tokens ?? body?.max_tokens, 256, 65536, 16384);

  // History loading is opt-in now. Most chat UIs already send their visible history,
  // so the extra Supabase request only added latency to every message.
  if (body?.load_history === true && sessionId) {
    const history = await loadHistory(sessionId, env);
    if (history.length) messages = [...history, ...messages].slice(-20);
  }

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return json({ error: { message: "A user message is required" } }, 400);

  // Web search is opt-in to keep normal chat fast. The frontend can send web_search:true.
  let searchContext = "";
  if (body?.web_search === true && wantsSearch(lastUser.content)) {
    searchContext = await webSearch(lastUser.content, env);
    if (searchContext) {
      messages = [
        ...messages.slice(0, -1),
        { role: "user", content: `${lastUser.content}\n\nWEB SEARCH RESULTS:\n${searchContext}` },
      ].slice(-20);
    }
  }

  // Optional SSE streaming endpoint for instant perceived response.
  if (body?.stream === true) {
    try {
      return await streamGroq(messages, env, maxTokens);
    } catch (error) {
      console.error("GROQ_STREAM_ERROR", error?.message);
      // Fall through to normal Gemini JSON fallback so the request never becomes an empty response.
    }
  }

  let answer;
  let provider;
  let model;
  let fallback = false;

  // Fast path: Groq first. No artificial retry delay on the critical path.
  try {
    answer = await groq(messages, env, maxTokens);
    provider = "Groq";
    model = GROQ_MODEL;
  } catch (groqError) {
    console.error("GROQ_ERROR", groqError?.message);
    try {
      answer = await gemini(messages, env, maxTokens);
      provider = "Gemini";
      model = GEMINI_MODEL;
      fallback = true;
    } catch (geminiError) {
      console.error("GEMINI_ERROR", geminiError?.message);
      return json({
        error: {
          code: "AI_BACKENDS_UNAVAILABLE",
          message: `Groq failed: ${groqError?.message || "unknown"}. Gemini failed: ${geminiError?.message || "unknown"}.`,
        },
      }, 503);
    }
  }

  if (!answer) {
    return json({ error: { code: "EMPTY_AI_RESPONSE", message: "AI returned an empty response. Please try again." } }, 503);
  }

  // Database writes never block the response.
  ctx.waitUntil(saveMessages(clientId, sessionId, lastUser.content, answer, env));

  return json({
    id: `qasim-${crypto.randomUUID()}`,
    object: "chat.completion",
    provider,
    model,
    fallback,
    session_id: sessionId,
    choices: [{
      index: 0,
      message: { role: "assistant", content: answer },
      finish_reason: "stop",
    }],
  });
}

function health(env) {
  return json({
    ok: true,
    service: "Qasim AI API",
    chat_primary: GROQ_MODEL,
    chat_fallback: GEMINI_MODEL,
    image_fast_primary: FLUX_FAST_MODEL,
    image_quality_primary: FLUX_QUALITY_MODEL,
    image_fallbacks: ["Gemini Image", "Hugging Face", "fal.ai", "Together AI", "Replicate"],
    gemini_key: Boolean(env.GEMINI_API_KEY),
    groq_key: Boolean(env.GROQ_API_KEY),
    workers_ai: Boolean(env.AI),
    hf_key: Boolean(env.HF_TOKEN),
    fal_key: Boolean(env.FAL_KEY),
    replicate_key: Boolean(env.REPLICATE_API_TOKEN),
    together_key: Boolean(env.TOGETHER_API_KEY),
    database: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
    web_search: Boolean(env.TAVILY_API_KEY),
    speed_mode: "optimized",
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return health(env);
    }

    if (request.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
      return handleChat(request, env, ctx);
    }

    if (request.method === "POST" && (url.pathname === "/v1/images/generations" || url.pathname === "/images/generations")) {
      return handleImage(request, env);
    }

    return json({ error: { message: "Endpoint not found" } }, 404);
  },
};
