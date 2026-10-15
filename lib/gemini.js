"use strict";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

class GeminiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function normalizeModel(model) {
  return String(model || "").trim().replace(/^models\//, "");
}

async function geminiRequest(path, { apiKey, method = "GET", body, timeoutMs = 90000 }) {
  if (!apiKey) {
    throw new GeminiError("NO_KEY", "No Gemini API key set. Open the add-on settings and paste your key.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(GEMINI_BASE + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new GeminiError("TIMEOUT", "Gemini took too long to respond. Try again, or use a faster model.");
    }
    throw new GeminiError("NETWORK", "Could not reach the Gemini API. Check your internet connection.");
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    /* non-JSON error body */
  }

  if (!res.ok) {
    const apiMessage = data && data.error && data.error.message ? data.error.message : res.statusText;
    let hint = "";
    if (res.status === 400 && /API key/i.test(apiMessage)) hint = " Check the key in settings.";
    if (res.status === 403) hint = " The key may be restricted or the API not enabled for it.";
    if (res.status === 404) hint = " The model name may be wrong or retired. Use “Load models” in settings.";
    if (res.status === 429) hint = " Rate limit or quota reached. Wait a moment and retry.";
    throw new GeminiError("HTTP_" + res.status, `Gemini error ${res.status}: ${apiMessage}.${hint}`);
  }
  return data;
}

async function geminiGenerate({ apiKey, model, system, prompt, temperature = 0.4 }) {
  const data = await geminiRequest(`/models/${encodeURIComponent(normalizeModel(model))}:generateContent`, {
    apiKey,
    method: "POST",
    body: {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature, maxOutputTokens: 8192 }
    }
  });

  if (data.promptFeedback && data.promptFeedback.blockReason) {
    throw new GeminiError("BLOCKED", "Gemini declined this content (" + data.promptFeedback.blockReason + ").");
  }
  const cand = data.candidates && data.candidates[0];
  const text = cand && cand.content && cand.content.parts
    ? cand.content.parts.map(p => p.text || "").join("").trim()
    : "";
  if (!text) {
    const reason = cand && cand.finishReason ? ` (${cand.finishReason})` : "";
    throw new GeminiError("EMPTY", "Gemini returned no text" + reason + ".");
  }
  const truncated = cand.finishReason === "MAX_TOKENS";
  return { text, truncated };
}

async function geminiListModels(apiKey) {
  const ids = [];
  let pageToken = "";
  for (let i = 0; i < 5; i++) {
    const data = await geminiRequest("/models?pageSize=100" + (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""), { apiKey, timeoutMs: 30000 });
    for (const m of data.models || []) {
      if ((m.supportedGenerationMethods || []).includes("generateContent") && /^models\/gemini/.test(m.name)) {
        ids.push(m.name.replace(/^models\//, ""));
      }
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return ids.sort();
}
