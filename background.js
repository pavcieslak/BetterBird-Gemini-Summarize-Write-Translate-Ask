"use strict";

// One session per (mode, tab): holds the running state and the last result so a
// popup that was closed mid-request can pick the answer up when it is reopened.
const sessions = new Map();
const sessionKey = (mode, tabId) => `${mode}:${tabId}`;

messenger.tabs.onRemoved.addListener(tabId => {
  sessions.delete(sessionKey("read", tabId));
  sessions.delete(sessionKey("compose", tabId));
});

function publicSession(s) {
  if (!s) return null;
  return {
    running: s.running,
    action: s.action,
    params: s.params,
    text: s.text,
    error: s.error,
    truncated: !!s.truncated
  };
}

async function displayedMessage(tabId) {
  const m = await messenger.messageDisplay.getDisplayedMessage(tabId);
  if (!m) throw new Error("Select a single message first.");
  return m;
}

async function getState({ mode, tabId }) {
  const settings = await getSettings();
  const state = {
    ok: true,
    hasKey: !!settings.apiKey,
    defaults: {
      language: settings.translateLanguage,
      tone: settings.defaultTone,
      length: settings.defaultSummary
    }
  };
  const k = sessionKey(mode, tabId);
  let session = sessions.get(k);

  if (mode === "read") {
    const m = await messenger.messageDisplay.getDisplayedMessage(tabId);
    if (!m) return Object.assign(state, { noMessage: true });
    state.subject = m.subject;
    if (session && session.messageId !== m.id) {
      sessions.delete(k);
      session = null;
    }
  } else {
    const d = await messenger.compose.getComposeDetails(tabId);
    state.subject = d.subject;
    state.isReply = !!d.relatedMessageId;
  }
  state.session = publicSession(session);
  return state;
}

function validate(mode, action, params, ctx) {
  const p = params || {};
  if (action === "translate" && !(p.language || "").trim()) return "Choose a language to translate to.";
  if (action === "ask" && !(p.instructions || "").trim()) return "Type your question first.";
  if (mode === "compose") {
    if (action === "write" && !(p.instructions || "").trim() && !ctx.draft.trim()) {
      return "Describe what the email should say, or type some notes in the draft first.";
    }
    if ((action === "improve" || action === "translate") && !ctx.draft.trim()) {
      return "Your draft is empty. Write some text first.";
    }
    if (action === "thread" && !ctx.original) {
      return "There is no original message to summarize. This works in replies and forwards.";
    }
  }
  return null;
}

async function run({ mode, tabId, action, params }) {
  const k = sessionKey(mode, tabId);
  const prev = sessions.get(k);
  if (prev && prev.running) return { ok: false, error: "Already working on a request for this window." };

  const s = { running: true, action, params, text: "", error: null, messageId: null, truncated: false };
  sessions.set(k, s);
  try {
    const settings = await getSettings();
    if (!settings.apiKey) throw new Error("No Gemini API key set. Open the add-on settings and paste your key.");

    let ctx;
    if (mode === "read") {
      const m = await displayedMessage(tabId);
      s.messageId = m.id;
      ctx = await loadMessageContext(m.id, settings.maxChars);
    } else {
      ctx = await getComposeContext(tabId, settings);
    }

    const problem = validate(mode, action, params, ctx);
    if (problem) throw new Error(problem);

    const { system, prompt } = buildPrompt(mode, action, params, ctx, settings);
    const temperature = Math.min(2, Math.max(0, Number(settings.temperature) || 0));
    const out = await geminiGenerate({
      apiKey: settings.apiKey,
      model: settings.model,
      system,
      prompt,
      temperature
    });
    s.text = out.text;
    s.truncated = out.truncated;
  } catch (e) {
    s.error = e.message || String(e);
  } finally {
    s.running = false;
  }
  return { ok: !s.error, session: publicSession(s) };
}

async function apply({ mode, tabId, how, text, replyAll }) {
  if (!text || !text.trim()) throw new Error("Nothing to insert.");
  if (mode === "compose") {
    await applyToCompose(tabId, text, how === "replace" ? "replace" : "insert");
  } else {
    const s = sessions.get(sessionKey("read", tabId));
    const messageId = s && s.messageId ? s.messageId : (await displayedMessage(tabId)).id;
    await openReplyWithText(messageId, text, !!replyAll);
  }
  return { ok: true };
}

const handlers = {
  getState,
  run,
  apply,
  async listModels({ apiKey }) {
    const settings = await getSettings();
    const models = await geminiListModels(apiKey || settings.apiKey);
    return { ok: true, models };
  },
  async testKey({ apiKey, model }) {
    const settings = await getSettings();
    const out = await geminiGenerate({
      apiKey: apiKey || settings.apiKey,
      model: model || settings.model,
      system: "Reply with the single word OK.",
      prompt: "ping",
      temperature: 0
    });
    return { ok: true, text: out.text };
  }
};

messenger.runtime.onMessage.addListener(msg => {
  const handler = msg && handlers[msg.type];
  if (!handler) return undefined;
  return handler(msg).catch(e => ({ ok: false, error: e.message || String(e) }));
});
