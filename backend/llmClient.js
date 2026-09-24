// LLM backend for fix suggestions. Production default is Google Gemini via
// the Gemini Developer API (https://ai.google.dev):
//   1. Create a key at https://aistudio.google.com/apikey
//   2. Set GEMINI_API_KEY in the environment (see .env.example)
//   3. Optionally set GEMINI_MODEL (default: gemini-3.8-flash) and
//      GEMINI_THINKING_LEVEL (low | medium | high)
// Google retires models on a published schedule (gemini-2.0-flash is already
// shut down). If requests start failing with a 404 "model not found", check
// https://ai.google.dev/gemini-api/docs/models and update GEMINI_MODEL.
//
// A connected user can override the server default per-server-session with
// their own key for any supported hosted provider (Gemini, Anthropic,
// OpenAI, or Grok) via setUserKey() -- see /api/ai/connect in server.js. The
// key lives in memory only, exactly like the GitHub/GitLab tokens
// (mcpGithubClient.js), and is never written to disk. While a user key is
// set, it's used for every completion instead of the server default;
// disconnecting (or the server restarting) falls straight back to
// GEMINI_API_KEY. If neither exists, complete() throws
// LlmNotConfiguredError instead of silently doing nothing.
const Anthropic = require("@anthropic-ai/sdk");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
// Only sent when set -- Gemini 3.x defaults to medium/high dynamic thinking,
// which is fine for correctness but slower. "minimal" is NOT accepted by
// gemini-3.8-flash (the API returns an error), so it's deliberately omitted
// from the documented values.
const GEMINI_THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL || null;
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 90000;
// A 503 "high demand" is capacity pressure on ONE specific model (brand-new
// models like gemini-3.8-flash get hammered hardest). Retrying the same model
// for ~7s isn't enough, so: retry briefly, then fall over to the next model in
// GEMINI_FALLBACK_MODELS (comma-separated, tried in order). Older stable
// models have far more spare capacity.
const GEMINI_FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || "gemini-3.5-flash-lite,gemini-flash-lite-latest,gemini-3.7-flash,gemini-3.1-flash-lite,gemini-3.5-flash")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
// Per-model retry backoff (ms) for transient errors; jitter is added on top.
const GEMINI_RETRY_DELAYS_MS = [1500, 3500];
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

// Models frequently ignore "output only the file content" and wrap the answer
// in a code fence and/or a chatty preamble ("Sure, here's the fix:") /
// sign-off ("Let me know if..."). Left alone, that prose gets written
// straight into the diff as if it were file content. SYSTEM_PROMPT reduces
// how often that happens; cleanResponse() strips it on the way out for the
// cases that still slip through -- applied to every provider's output, since
// none of them are guaranteed to follow the instruction perfectly.
const SYSTEM_PROMPT =
  "You are a code-completion engine, not a chat assistant. You output raw file " +
  "content and nothing else: no greetings, no explanations, no markdown code " +
  "fences, no sign-offs. Your entire response is written directly to disk as a file.";

const PROVIDERS = ["gemini", "anthropic", "openai", "grok"];
const PROVIDER_LABEL = { gemini: "Gemini", anthropic: "Anthropic", openai: "OpenAI", grok: "Grok" };

class LlmNotConfiguredError extends Error {
  constructor(message) {
    super(message);
    this.code = "LLM_NOT_CONFIGURED";
  }
}

// Best-effort strip of chat filler a model tacks on despite instructions
// not to. Order matters: a fenced block is the strongest signal of "this
// is the actual content", so it wins over everything else.
function cleanResponse(raw) {
  let text = raw.trim();

  const fenced = text.match(/```(?:[a-zA-Z0-9_+-]*\n)?([\s\S]*?)```/);
  if (fenced) {
    return fenced[1].trim();
  }

  const lines = text.split("\n");

  const preamblePatterns =
    /^(sure|okay|ok|certainly|of course|here'?s|here is|i can|i'll|i will|note:|this is)\b/i;
  while (lines.length > 1 && preamblePatterns.test(lines[0].trim())) {
    lines.shift();
    while (lines.length && lines[0].trim() === "") lines.shift();
  }

  const signoffPatterns = /^(let me know|hope this helps|i hope|feel free|please note)\b/i;
  while (lines.length > 1 && signoffPatterns.test(lines[lines.length - 1].trim())) {
    lines.pop();
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  }

  return lines.join("\n").trim();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- Gemini (server default, and also selectable as a user key) ----------

// Uses the stable generateContent REST endpoint with the key in the
// x-goog-api-key header (not the URL, so it can't leak into logs/proxies).
// No temperature is sent: Google's guidance for Gemini 3.x is to leave it at
// the default of 1.0 -- lowering it can cause looping or degraded reasoning.
async function completeGemini(apiKey, prompt) {
  const models = [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS.filter((m) => m !== GEMINI_MODEL)];
  let lastErr = null;

  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    try {
      return await callGeminiModel(apiKey, prompt, model, mi === 0);
    } catch (err) {
      lastErr = err;
      // Only move on to the next model for capacity/availability problems.
      // Bad key, blocked prompt, truncated output etc. would fail identically.
      if (!err.transient) throw err;
      console.warn(`[llm] Gemini model ${model} unavailable (${err.message}) -- trying next fallback`);
    }
  }
  throw lastErr;
}

async function callGeminiModel(apiKey, prompt, model, isPrimary) {
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  };
  // thinkingLevel is only known-good on the primary model; fallbacks use
  // their defaults so an unsupported setting can't turn into a 400.
  if (GEMINI_THINKING_LEVEL && isPrimary) {
    body.generationConfig = { thinkingConfig: { thinkingLevel: GEMINI_THINKING_LEVEL } };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const e = new Error(
        err.name === "AbortError"
          ? `Gemini didn't respond within ${Math.round(GEMINI_TIMEOUT_MS / 1000)}s -- try again in a moment.`
          : `Couldn't reach the Gemini API: ${err.message}`
      );
      e.transient = true;
      throw e;
    } finally {
      clearTimeout(timeout);
    }

    if (TRANSIENT_STATUSES.has(res.status) && attempt < GEMINI_RETRY_DELAYS_MS.length) {
      await sleep(GEMINI_RETRY_DELAYS_MS[attempt] + Math.random() * 500);
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let detail = text.slice(0, 200);
      try {
        detail = JSON.parse(text).error?.message || detail;
      } catch {
        // not JSON -- keep the raw snippet
      }
      const hint =
        res.status === 404
          ? ` Model "${model}" may be retired or unavailable to this key -- check https://ai.google.dev/gemini-api/docs/models and update GEMINI_MODEL.`
          : res.status === 429
          ? " Rate limit or quota reached -- wait a minute, or enable billing for a higher limit."
          : "";
      const e = new Error(`Gemini request failed (${res.status}, ${model}): ${detail}${hint}`);
      // 404 = this model id is gone for this key; a fallback model may still work.
      e.transient = TRANSIENT_STATUSES.has(res.status) || res.status === 404;
      throw e;
    }

    const data = await res.json();

    if (data.promptFeedback?.blockReason) {
      throw new Error(`Gemini blocked the request (${data.promptFeedback.blockReason}).`);
    }
    const candidate = data.candidates?.[0];
    if (!candidate) throw new Error("Gemini returned no response candidates.");

    // A cut-off answer would be written into the repo as a truncated file,
    // so treat it as a failure rather than returning partial content.
    if (candidate.finishReason === "MAX_TOKENS") {
      throw new Error("Gemini's response was cut off before the file was complete -- refusing to use a truncated file.");
    }

    const text = (candidate.content?.parts || [])
      .filter((p) => !p.thought)
      .map((p) => p.text || "")
      .join("");
    if (!text && candidate.finishReason && candidate.finishReason !== "STOP") {
      throw new Error(`Gemini returned no text (finishReason: ${candidate.finishReason}).`);
    }
    return text;
  }
}

// ---------- Other hosted providers (only used when a user connects their own key) ----------

async function completeAnthropic(apiKey, prompt) {
  const anthropic = new Anthropic({ apiKey });
  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  });
  return message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

async function completeOpenAI(apiKey, prompt) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI request failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// xAI's Grok API is wire-compatible with OpenAI's chat completions shape --
// same request/response, just a different base URL and model name.
async function completeGrok(apiKey, prompt) {
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "grok-2-latest",
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Grok request failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

const HOSTED_COMPLETERS = { gemini: completeGemini, anthropic: completeAnthropic, openai: completeOpenAI, grok: completeGrok };

// ---------- User key state (in memory only, per server process) ----------

let userProvider = null;
let userApiKey = null;

async function setUserKey(provider, apiKey) {
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`Unknown provider "${provider}" -- choose one of: ${PROVIDERS.join(", ")}.`);
  }
  const key = (apiKey || "").trim();
  if (!key) throw new Error("Paste an API key first.");

  // Verify with a trivial call before accepting it, same as the GitHub/
  // GitLab connect flow -- a bad key should fail here, not on the first
  // real fix generation.
  try {
    await HOSTED_COMPLETERS[provider](key, "Reply with the single word OK.");
  } catch (err) {
    throw new Error(`${PROVIDER_LABEL[provider]} rejected that key: ${err.message}`);
  }

  userProvider = provider;
  userApiKey = key;
  return { connected: true, provider };
}

function clearUserKey() {
  userProvider = null;
  userApiKey = null;
}

function getUserKeyStatus() {
  if (userProvider) return { connected: true, provider: userProvider, isUserKey: true };
  if (GEMINI_API_KEY) return { connected: true, provider: "gemini", isUserKey: false };
  return { connected: false, provider: null };
}

// True when complete() has something to call -- lets callers that do
// side-effecting work first (e.g. creating a git branch) bail out early.
function isConfigured() {
  return Boolean(userProvider || GEMINI_API_KEY);
}

// Priority: an explicitly connected user key wins (any provider, including
// their own Gemini key); otherwise the server-configured GEMINI_API_KEY.
async function complete(prompt) {
  let raw;
  if (userProvider) {
    raw = await HOSTED_COMPLETERS[userProvider](userApiKey, prompt);
  } else if (GEMINI_API_KEY) {
    raw = await completeGemini(GEMINI_API_KEY, prompt);
  } else {
    throw new LlmNotConfiguredError(
      "No AI provider is configured. Set GEMINI_API_KEY in backend/.env (free key: https://aistudio.google.com/apikey), or connect your own key on the Connect tab."
    );
  }
  return cleanResponse(raw || "");
}

module.exports = { complete, isConfigured, setUserKey, clearUserKey, getUserKeyStatus, LlmNotConfiguredError };