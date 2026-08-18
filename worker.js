const ALLOWED_ORIGIN = "https://q9999499-collab.github.io";

const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const FLUX_MODEL = "@cf/black-forest-labs/flux-2-dev";

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
The user may ask for a very short answer or an extremely long, detailed answer.
Match the requested length. If no length is specified, give a useful medium-to-detailed answer.
Never return an empty answer. If the requested answer is complex, structure it with headings, bullets, steps, examples, timelines, calculations or tables when useful.
Do not claim that an image, file, web search, or tool was used unless it actually was.`;

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

async function timeoutFetch(url, options = {}, timeout = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function retry(fn, attempts = 2, delayMs = 700) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (error) {
      lastError = error;
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError || new Error("Request failed");
}

function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((part) => {
    if (typeof part?.text === "string") return part.text;
    if (typeof part?.text?.value === "string") return part.text.value;
    return "";
  }).join("").trim();
}

function geminiParts(messages, files = [], searchContext = "") {
  const parts = [];
  for (const message of messages) {
    const role = message.role === "assistant" ? "ASSISTANT" : "USER";
    const content = clean(message.content);
    if (content) parts.push({ text: `${role}: ${content}` });
  }

  if (searchContext) {
    parts.push({ text: "WEB SEARCH RESULTS (use only as supporting context; do not invent beyond them):\n" + searchContext });
  }

  for (const file of files.slice(0, 6)) {
    if (file?.data && typeof file.data === "string" && typeof file.mime_type === "string" && file.mime_type.startsWith("image/")) {
      parts.push({ inline_data: {
        mime_type: file.mime_type,
        data: file.data.includes(",") ? file.data.split(",")[1] : file.data,
      }});
    } else if (file?.text) {
      parts.push({ text: `FILE ${file.name || "document"}:\n${String(file.text).slice(0, 120000)}` });
    }
  }
  return parts;
}

async function gemini(messages, files, searchContext, env, maxOutputTokens) {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
  const response = await timeoutFetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: SYSTEM_PROMPT }, ...geminiParts(messages, files, searchContext)] }],
      generationConfig: { maxOutputTokens },
    }),
  }, 60000);

  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || `Gemini HTTP ${response.status}`);

  const answer = extractGeminiText(data);
  if (!answer) {
    const finishReason = data?.candidates?.[0]?.finishReason || "UNKNOWN";
    throw new Error(`Gemini returned an empty response (finishReason=${finishReason})`);
  }
  return answer;
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
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages.slice(-20)],
      max_tokens: Math.min(maxTokens, 32768),
    }),
  }, 60000);

  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || `Groq HTTP ${response.status}`);

  const answer = clean(data?.choices?.[0]?.message?.content);
  if (!answer) throw new Error("Groq returned an empty response");
  return answer;
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
      body: JSON.stringify({ api_key: env.TAVILY_API_KEY, query, search_depth: "basic", max_results: 5 }),
    }, 15000);
    if (!response.ok) return "";
    const data = await response.json().catch(() => null);
    return (data?.results || []).map((item) => `Title: ${item.title || ""}\nURL: ${item.url || ""}\nContent: ${item.content || ""}`).join("\n\n");
  } catch (error) {
    console.error("WEB_SEARCH_ERROR", error);
    return "";
  }
}

async function supabaseRequest(env, path, options = {}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase is not configured");
  return timeoutFetch(`${env.SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  }, 10000);
}

async function saveMessages(clientId, conversationId, messages, env) {
  if (!clientId || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return conversationId || null;
  try {
    let id = conversationId;
    if (!id) {
      const firstUser = messages.find((m) => m.role === "user");
      const title = clean(firstUser?.content || "New conversation").slice(0, 80);
      const createConversation = await supabaseRequest(env, "/rest/v1/qasim_conversations?select=id", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ client_id: clientId, title }),
      });
      const rows = await createConversation.json().catch(() => []);
      id = rows?.[0]?.id || null;
    }
    if (!id) return conversationId || null;

    for (const message of messages.slice(-2)) {
      const content = clean(message.content);
      if (!content) continue;
      await supabaseRequest(env, "/rest/v1/qasim_messages", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ conversation_id: id, role: message.role, content }),
      });
    }
    return id;
  } catch (error) {
    console.error("SUPABASE_HISTORY_ERROR", error);
    return conversationId || null;
  }
}

async function loadHistory(conversationId, env) {
  if (!conversationId || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return [];
  try {
    const path = `/rest/v1/qasim_messages?conversation_id=eq.${encodeURIComponent(conversationId)}&select=role,content,created_at&order=created_at.asc&limit=100`;
    const response = await supabaseRequest(env, path, { method: "GET" });
    if (!response.ok) return [];
    const data = await response.json().catch(() => []);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error("SUPABASE_LOAD_HISTORY_ERROR", error);
    return [];
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
  } catch { return null; }
}

function binaryToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  return btoa(binary);
}

async function fluxImage(prompt, env, inputImages = []) {
  if (!env.AI) throw new Error("Workers AI binding AI is missing");
  const form = new FormData();
  form.append("prompt", `${prompt}\n\nUltra-realistic, photorealistic, professional photography, natural lighting, realistic textures, realistic shadows, accurate proportions, cinematic but natural color grading, crisp fine detail, no artificial AI look.`);
  form.append("width", "1024");
  form.append("height", "1024");
  form.append("steps", "25");

  for (let i = 0; i < Math.min(inputImages.length, 4); i++) {
    const parsed = dataUrl(inputImages[i]);
    if (!parsed) continue;
    form.append(`input_image_${i}`, new File([parsed.bytes], `input-${i}.jpg`, { type: parsed.mime }));
  }

  const request = new Request("https://qasim-ai-multipart.invalid", { method: "POST", body: form });
  const result = await env.AI.run(FLUX_MODEL, {
    multipart: {
      body: request.body,
      contentType: request.headers.get("content-type") || "multipart/form-data",
    },
  });

  const image = typeof result?.image === "string" ? result.image : typeof result?.response === "string" ? result.response : "";
  if (!image) throw new Error("FLUX returned no image");
  return { image, mime: "image/jpeg", provider: "Cloudflare FLUX.2 Dev", model: FLUX_MODEL };
}

async function huggingFaceImage(prompt, env) {
  if (!env.HF_TOKEN) throw new Error("HF_TOKEN is missing");
  const model = "black-forest-labs/FLUX.1-schnell";
  const response = await timeoutFetch(`https://router.huggingface.co/hf-inference/models/${model}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.HF_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ inputs: `${prompt}\nPhotorealistic professional photography, natural lighting, realistic textures.` }),
  }, 60000);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Hugging Face HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return { image: binaryToBase64(new Uint8Array(await response.arrayBuffer())), mime: response.headers.get("content-type") || "image/jpeg", provider: "Hugging Face", model };
}

async function falImage(prompt, env) {
  if (!env.FAL_KEY) throw new Error("FAL_KEY is missing");
  const response = await timeoutFetch("https://fal.run/fal-ai/flux/schnell", {
    method: "POST",
    headers: { Authorization: `Key ${env.FAL_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, image_size: "square_hd", num_images: 1 }),
  }, 60000);
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.detail || data?.error || `fal.ai HTTP ${response.status}`);
  const url = data?.images?.[0]?.url;
  if (!url) throw new Error("fal.ai returned no image");
  const imageResponse = await timeoutFetch(url, {}, 30000);
  if (!imageResponse.ok) throw new Error("fal.ai image download failed");
  return { image: binaryToBase64(new Uint8Array(await imageResponse.arrayBuffer())), mime: imageResponse.headers.get("content-type") || "image/jpeg", provider: "fal.ai", model: "fal-ai/flux/schnell" };
}

async function replicateImage(prompt, env) {
  if (!env.REPLICATE_API_TOKEN) throw new Error("REPLICATE_API_TOKEN is missing");
  const create = await timeoutFetch("https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.REPLICATE_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: { prompt } }),
  }, 30000);
  let result = await create.json().catch(() => null);
  if (!create.ok) throw new Error(result?.detail || `Replicate HTTP ${create.status}`);

  for (let i = 0; i < 45; i++) {
    if (result?.status === "succeeded") break;
    if (result?.status === "failed" || result?.status === "canceled") throw new Error(result?.error || "Replicate generation failed");
    if (!result?.urls?.get) throw new Error("Replicate polling URL missing");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const poll = await timeoutFetch(result.urls.get, { headers: { Authorization: `Bearer ${env.REPLICATE_API_TOKEN}` } }, 15000);
    result = await poll.json().catch(() => null);
  }

  if (result?.status !== "succeeded") throw new Error("Replicate generation timed out");
  const output = Array.isArray(result.output) ? result.output[0] : result.output;
  if (!output) throw new Error("Replicate returned no image");
  const imageResponse = await timeoutFetch(output, {}, 30000);
  if (!imageResponse.ok) throw new Error("Replicate image download failed");
  return { image: binaryToBase64(new Uint8Array(await imageResponse.arrayBuffer())), mime: imageResponse.headers.get("content-type") || "image/jpeg", provider: "Replicate", model: "black-forest-labs/flux-schnell" };
}

async function togetherImage(prompt, env) {
  if (!env.TOGETHER_API_KEY) throw new Error("TOGETHER_API_KEY is missing");
  const response = await timeoutFetch("https://api.together.xyz/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.TOGETHER_API_KEY}` },
    body: JSON.stringify({ model: "black-forest-labs/FLUX.1-schnell", prompt, width: 1024, height: 1024, steps: 4, n: 1, response_format: "b64_json" }),
  }, 60000);
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
      contents: [{ role: "user", parts: [{ text: `${prompt}\n\nCreate a high-quality photorealistic image. Natural lighting. Realistic textures. Professional photography. Accurate proportions.` }] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    }),
  }, 90000);
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || `Gemini Image HTTP ${response.status}`);
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((part) => part?.inlineData?.data);
  if (!imagePart) throw new Error("Gemini Image returned no image");
  return { image: imagePart.inlineData.data, mime: imagePart.inlineData.mimeType || "image/png", provider: "Gemini Image", model: GEMINI_IMAGE_MODEL };
}

async function generateImage(prompt, env, inputImages = []) {
  const errors = [];
  const providers = [
    { name: "Cloudflare FLUX.2 Dev", enabled: Boolean(env.AI), run: () => fluxImage(prompt, env, inputImages) },
    { name: "Gemini Image", enabled: Boolean(env.GEMINI_API_KEY), run: () => geminiImage(prompt, env) },
    { name: "Hugging Face", enabled: Boolean(env.HF_TOKEN), run: () => huggingFaceImage(prompt, env) },
    { name: "fal.ai", enabled: Boolean(env.FAL_KEY), run: () => falImage(prompt, env) },
    { name: "Replicate", enabled: Boolean(env.REPLICATE_API_TOKEN), run: () => replicateImage(prompt, env) },
    { name: "Together AI", enabled: Boolean(env.TOGETHER_API_KEY), run: () => togetherImage(prompt, env) },
  ];

  for (const provider of providers) {
    if (!provider.enabled) {
      errors.push(`${provider.name}: not configured`);
      continue;
    }
    try {
      console.log(`Trying image provider: ${provider.name}`);
      return await provider.run();
    } catch (error) {
      console.error(`IMAGE_PROVIDER_FAILED ${provider.name}`, error);
      errors.push(`${provider.name}: ${error?.message || "unknown error"}`);
    }
  }
  throw new Error("All configured image providers failed. " + errors.join(" | "));
}

async function handleImage(request, env) {
  const body = await readJSON(request);
  const prompt = clean(body?.prompt);
  if (!prompt) return json({ error: { message: "Image prompt is required" } }, 400);

  try {
    const inputImages = Array.isArray(body?.images) ? body.images : body?.input_image ? [body.input_image] : [];
    const result = await generateImage(prompt, env, inputImages);
    return json({ created: true, provider: result.provider, model: result.model, data: [{ b64_json: result.image, mime_type: result.mime }] });
  } catch (error) {
    console.error("IMAGE_GENERATION_ERROR", error);
    return json({ error: { code: "ALL_IMAGE_PROVIDERS_FAILED", message: error?.message || "Image generation failed" } }, 502);
  }
}

async function handleChat(request, env, ctx) {
  const body = await readJSON(request);
  if (!Array.isArray(body?.messages)) return json({ error: { message: "messages array is required" } }, 400);

  let messages = body.messages
    .filter((message) => message && (message.role === "user" || message.role === "assistant") && typeof message.content === "string")
    .map((message) => ({ role: message.role, content: clean(message.content) }))
    .filter((message) => message.content)
    .slice(-40);

  if (!messages.length) return json({ error: { message: "No valid messages" } }, 400);

  const sessionId = clean(body?.session_id) || crypto.randomUUID();
  const storedHistory = await loadHistory(sessionId, env);
  if (storedHistory.length) {
    messages = [
      ...storedHistory
        .filter((message) => (message.role === "user" || message.role === "assistant") && typeof message.content === "string")
        .map((message) => ({ role: message.role, content: clean(message.content) })),
      ...messages,
    ].filter((message) => message.content).slice(-40);
  }

  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  if (!lastUser) return json({ error: { message: "Please send a user message" } }, 400);

  const maxOutputTokens = clampInt(body?.max_output_tokens ?? body?.max_tokens ?? body?.maxOutputTokens, 256, 65536, 16384);
  let searchContext = "";
  if (body.web_search !== false && wantsSearch(lastUser.content)) searchContext = await webSearch(lastUser.content, env);

  let answer = "";
  let provider = "Gemini";
  let geminiError = null;
  let groqError = null;

  try {
    answer = await retry(() => gemini(messages, Array.isArray(body.files) ? body.files : [], searchContext, env, maxOutputTokens), 2);
  } catch (error) {
    geminiError = error;
    console.error("GEMINI_ERROR", error);
    try {
      answer = await retry(() => groq(messages, env, maxOutputTokens), 2);
      provider = "Groq";
    } catch (error2) {
      groqError = error2;
      console.error("GROQ_ERROR", error2);
    }
  }

  if (!clean(answer)) {
    return json({
      error: {
        code: "AI_BACKENDS_UNAVAILABLE",
        message: "AI providers returned no usable answer. " + `Gemini: ${geminiError?.message || "not failed"}. ` + `Groq: ${groqError?.message || "not failed"}.`,
      },
      session_id: sessionId,
    }, 503);
  }

  const savedMessages = [
    { role: "user", content: lastUser.content },
    { role: "assistant", content: answer },
  ];

  if (ctx?.waitUntil) {
    ctx.waitUntil(saveMessages(body?.client_id || sessionId, body?.conversation_id || null, savedMessages, env));
  }

  return json({
    id: `qasim-${crypto.randomUUID()}`,
    object: "chat.completion",
    provider,
    model: provider === "Gemini" ? GEMINI_MODEL : GROQ_MODEL,
    fallback: provider !== "Gemini",
    session_id: sessionId,
    conversation_id: body?.conversation_id || null,
    web_search: Boolean(searchContext),
    choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
  });
}

async function handleHistory(request, env) {
  const body = await readJSON(request);
  if (!body?.client_id) return json({ error: { message: "client_id required" } }, 400);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ conversations: [], configured: false });

  try {
    const response = await supabaseRequest(env, `/rest/v1/qasim_conversations?client_id=eq.${encodeURIComponent(body.client_id)}&select=*&order=updated_at.desc`, { method: "GET" });
    const conversations = await response.json().catch(() => []);
    return json({ conversations: Array.isArray(conversations) ? conversations : [], configured: true });
  } catch {
    return json({ conversations: [], configured: true });
  }
}

function health(env) {
  return json({
    ok: true,
    service: "Qasim AI API",
    chat_provider: "Gemini",
    gemini_model: GEMINI_MODEL,
    chat_fallback: GROQ_MODEL,
    image_primary: FLUX_MODEL,
    image_fallbacks: [GEMINI_IMAGE_MODEL, "Hugging Face", "fal.ai", "Replicate", "Together AI"],
    gemini_key: Boolean(env.GEMINI_API_KEY),
    groq_key: Boolean(env.GROQ_API_KEY),
    hf_key: Boolean(env.HF_TOKEN),
    fal_key: Boolean(env.FAL_KEY),
    replicate_key: Boolean(env.REPLICATE_API_TOKEN),
    together_key: Boolean(env.TOGETHER_API_KEY),
    workers_ai: Boolean(env.AI),
    database: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
    web_search: Boolean(env.TAVILY_API_KEY),
    website_limits: "none",
    max_chat_output_tokens: 65536,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (origin && origin !== ALLOWED_ORIGIN) return json({ error: { message: "Origin not allowed" } }, 403);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) return health(env);
    if (request.method !== "POST") return json({ error: { message: "Use POST" } }, 405);
    if (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") return handleChat(request, env, ctx);
    if (url.pathname === "/v1/images/generations" || url.pathname === "/images/generations") return handleImage(request, env);
    if (url.pathname === "/v1/history") return handleHistory(request, env);
    return json({ error: { message: "Endpoint not found" } }, 404);
  },
};
