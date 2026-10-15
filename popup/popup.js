"use strict";

const MODE = document.body.dataset.mode;

const LENGTHS = [
  ["short", "Short (1–2 sentences)"],
  ["bullets", "Key points + action items"],
  ["detailed", "Detailed"]
];
const TONES = [
  ["", "Default"],
  ["professional", "Professional"],
  ["friendly", "Friendly"],
  ["formal", "Formal"],
  ["casual", "Casual"],
  ["direct and concise", "Direct & concise"],
  ["warm", "Warm"],
  ["firm but polite", "Firm but polite"]
];
const STYLES = [
  ["grammar", "Fix spelling & grammar only"],
  ["clarity", "Improve clarity & flow"],
  ["shorter", "Make shorter"],
  ["professional", "More professional"],
  ["formal", "More formal"],
  ["friendly", "More friendly"]
];
const LANGUAGES = [
  "English", "Polish", "German", "French", "Spanish", "Italian", "Portuguese", "Dutch",
  "Czech", "Slovak", "Ukrainian", "Russian", "Swedish", "Norwegian", "Danish", "Finnish",
  "Greek", "Turkish", "Arabic", "Hebrew", "Hindi", "Chinese", "Japanese", "Korean"
];

// kind: select | text | area | check
const ACTIONS = {
  read: [
    { id: "summarize", label: "Summarize", output: "copy", run: "Summarize",
      fields: [{ name: "length", kind: "select", label: "Length", options: LENGTHS },
               { name: "language", kind: "lang", label: "Summary language (optional)", placeholder: "Same as the email" }] },
    { id: "translate", label: "Translate", output: "copy", run: "Translate",
      fields: [{ name: "language", kind: "lang", label: "Translate to", placeholder: "e.g. English", required: true }] },
    { id: "reply", label: "Draft reply", output: "reply", run: "Draft reply",
      fields: [{ name: "instructions", kind: "area", label: "What should the reply say? (optional)", placeholder: "e.g. Accept the meeting, but ask to move it to Thursday" },
               { name: "tone", kind: "select", label: "Tone", options: TONES },
               { name: "language", kind: "lang", label: "Reply language (optional)", placeholder: "Same as the email" },
               { name: "replyAll", kind: "check", label: "Reply to all" }] },
    { id: "ask", label: "Ask", output: "copy", run: "Ask",
      fields: [{ name: "instructions", kind: "area", label: "Your question about this email", placeholder: "e.g. What deadline do they mention?", required: true }] }
  ],
  compose: [
    { id: "write", label: "Write", output: "insert", run: "Write",
      fields: [{ name: "instructions", kind: "area", label: "What should the email say?", placeholder: "e.g. Politely ask for the invoice to be re-sent, mention the PO number is in the draft" },
               { name: "tone", kind: "select", label: "Tone", options: TONES },
               { name: "language", kind: "lang", label: "Language (optional)", placeholder: "Same as the draft / original" }] },
    { id: "improve", label: "Improve", output: "replace", run: "Improve draft",
      fields: [{ name: "style", kind: "select", label: "How", options: STYLES },
               { name: "language", kind: "lang", label: "Language (optional)", placeholder: "Keep the draft's language" }] },
    { id: "translate", label: "Translate", output: "replace", run: "Translate draft",
      fields: [{ name: "language", kind: "lang", label: "Translate draft to", placeholder: "e.g. German", required: true }] },
    { id: "thread", label: "Summarize thread", output: "copy", run: "Summarize",
      fields: [{ name: "length", kind: "select", label: "Length", options: LENGTHS },
               { name: "language", kind: "lang", label: "Summary language (optional)", placeholder: "Same as the message" }] }
  ]
};

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

const ui = {
  tabId: null,
  state: null,
  action: ACTIONS[MODE][0].id,
  values: {},      // field values, remembered while the popup is open
  result: "",
  busy: false,
  pollTimer: null
};

const keyFor = (action, name) => (name === "instructions" ? `${action}:instructions` : name);
const currentAction = () => ACTIONS[MODE].find(a => a.id === ui.action);

function send(msg) {
  return messenger.runtime.sendMessage(msg).then(res => res || { ok: false, error: "No response from the add-on background." });
}

/* ---------- rendering ---------- */

function render() {
  const app = $("#app");
  app.replaceChildren();

  const header = el("header", {},
    el("div", { class: "title" }, el("strong", { text: "Gemini" }), el("span", { class: "subject", text: ui.state && ui.state.subject ? ui.state.subject : "" })),
    el("button", { class: "icon-btn", title: "Settings", "aria-label": "Settings", text: "⚙", onclick: openSettings })
  );
  app.append(header);

  if (!ui.state || !ui.state.ok) {
    app.append(el("div", { class: "notice error", text: (ui.state && ui.state.error) || "Could not load." }));
    return;
  }
  if (ui.state.noMessage) {
    app.append(el("div", { class: "notice", text: "Select a single message to use Gemini on it." }));
    return;
  }
  if (!ui.state.hasKey) {
    app.append(el("div", { class: "notice" },
      el("p", { text: "Add your Gemini API key to get started." }),
      el("button", { class: "primary", text: "Open settings", onclick: openSettings })));
    return;
  }

  const tabs = el("nav", { class: "tabs", role: "tablist" });
  for (const a of ACTIONS[MODE]) {
    tabs.append(el("button", {
      role: "tab",
      class: a.id === ui.action ? "tab active" : "tab",
      "aria-selected": String(a.id === ui.action),
      text: a.label,
      onclick: () => { collectValues(); ui.action = a.id; ui.result = ""; render(); }
    }));
  }
  app.append(tabs);

  const form = el("form", { class: "form", onsubmit: ev => { ev.preventDefault(); onRun(); } });
  for (const f of currentAction().fields) form.append(buildField(f));
  form.append(el("div", { class: "row" },
    el("button", { class: "primary", id: "run", type: "submit", text: currentAction().run, disabled: ui.busy })));
  app.append(form);

  app.append(el("div", { id: "status", class: "status", role: "status" }));

  const result = el("textarea", { id: "result", rows: "11", spellcheck: "false", "aria-label": "Result", class: ui.result ? "" : "hidden" });
  result.value = ui.result;
  app.append(result);
  app.append(el("div", { id: "actions", class: ui.result ? "row actions" : "row actions hidden" }, ...buildOutputButtons()));

  app.append(el("p", { class: "hint", text: "Email text is sent to Google's Gemini API only when you press a button here." }));
}

function buildField(f) {
  const id = "f-" + f.name;
  const value = ui.values[keyFor(ui.action, f.name)];
  let input;
  if (f.kind === "select") {
    input = el("select", { id, name: f.name });
    for (const [v, label] of f.options) input.append(el("option", { value: v, text: label }));
    input.value = value != null ? value : defaultFor(f.name);
  } else if (f.kind === "lang") {
    input = el("input", { id, name: f.name, type: "text", list: "langs", placeholder: f.placeholder || "", autocomplete: "off" });
    input.value = value != null ? value : (f.required ? defaultFor("language") : "");
    if (!document.getElementById("langs")) {
      const dl = el("datalist", { id: "langs" });
      LANGUAGES.forEach(l => dl.append(el("option", { value: l })));
      document.body.append(dl);
    }
  } else if (f.kind === "area") {
    input = el("textarea", { id, name: f.name, rows: "3", placeholder: f.placeholder || "" });
    input.value = value || "";
  } else {
    input = el("input", { id, name: f.name, type: "checkbox" });
    input.checked = !!value;
    return el("label", { class: "check", for: id }, input, " " + f.label);
  }
  return el("div", { class: "field" }, el("label", { for: id, text: f.label }), input);
}

function defaultFor(name) {
  const d = (ui.state && ui.state.defaults) || {};
  if (name === "length") return d.length || "bullets";
  if (name === "tone") return d.tone || "";
  if (name === "language") return d.language || "English";
  if (name === "style") return "clarity";
  return "";
}

function buildOutputButtons() {
  const out = currentAction().output;
  const btns = [el("button", { text: "Copy", onclick: onCopy })];
  if (out === "insert") {
    btns.unshift(el("button", { class: "primary", text: "Insert into email", onclick: () => onApply("insert") }));
    btns.push(el("button", { text: "Replace draft", onclick: () => onApply("replace") }));
  } else if (out === "replace") {
    btns.unshift(el("button", { class: "primary", text: "Replace draft", onclick: () => onApply("replace") }));
    btns.push(el("button", { text: "Insert above", onclick: () => onApply("insert") }));
  } else if (out === "reply") {
    btns.unshift(el("button", { class: "primary", text: "Open reply with this", onclick: () => onApply("insert") }));
  }
  return btns;
}

/* ---------- state ---------- */

function collectValues() {
  const form = $(".form");
  if (!form) return {};
  const params = {};
  for (const f of currentAction().fields) {
    const node = form.elements[f.name];
    if (!node) continue;
    const v = f.kind === "check" ? node.checked : node.value;
    ui.values[keyFor(ui.action, f.name)] = v;
    params[f.name] = v;
  }
  return params;
}

function setStatus(text, isError) {
  const s = $("#status");
  if (!s) return;
  s.textContent = text || "";
  s.className = "status" + (isError ? " error" : "");
}

function showResult(text) {
  ui.result = text || "";
  const r = $("#result"), a = $("#actions");
  if (!r) return;
  r.value = ui.result;
  r.classList.toggle("hidden", !ui.result);
  a.classList.toggle("hidden", !ui.result);
}

function adoptSession(session) {
  if (!session) return;
  ui.action = ACTIONS[MODE].some(a => a.id === session.action) ? session.action : ui.action;
  for (const [name, v] of Object.entries(session.params || {})) ui.values[keyFor(ui.action, name)] = v;
  ui.result = session.text || "";
}

/* ---------- actions ---------- */

async function onRun() {
  const params = collectValues();
  for (const f of currentAction().fields) {
    if (f.required && !String(params[f.name] || "").trim()) {
      setStatus("Please fill in: " + f.label.toLowerCase(), true);
      return;
    }
  }
  messenger.storage.local.set({ ui: { language: params.language || "", tone: params.tone || "", length: params.length || "" } }).catch(() => {});
  setBusy(true);
  const res = await send({ type: "run", mode: MODE, tabId: ui.tabId, action: ui.action, params });
  setBusy(false);
  finishRun(res);
}

function finishRun(res) {
  const session = res.session;
  if (session && session.text) {
    showResult(session.text);
    setStatus(session.truncated ? "Output was cut off at the length limit." : "", session.truncated);
  } else {
    showResult("");
    setStatus((session && session.error) || res.error || "No result.", true);
  }
}

function setBusy(busy) {
  ui.busy = busy;
  const run = $("#run");
  if (run) run.disabled = busy;
  if (busy) {
    showResult("");
    setStatus("Asking Gemini…");
  }
}

async function onCopy() {
  const text = $("#result").value;
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    $("#result").select();
    document.execCommand("copy");
  }
  setStatus("Copied.");
}

async function onApply(how) {
  const text = $("#result").value;
  const params = collectValues();
  setStatus("Working…");
  const res = await send({ type: "apply", mode: MODE, tabId: ui.tabId, how, text, replyAll: !!params.replyAll });
  if (res.ok) window.close();
  else setStatus(res.error || "Could not apply the text.", true);
}

function openSettings() {
  messenger.runtime.openOptionsPage();
  window.close();
}

function pollWhileRunning() {
  clearTimeout(ui.pollTimer);
  ui.pollTimer = setTimeout(async () => {
    const state = await send({ type: "getState", mode: MODE, tabId: ui.tabId });
    if (state.ok && state.session && state.session.running) {
      pollWhileRunning();
    } else {
      setBusy(false);
      finishRun({ session: state.session });
    }
  }, 700);
}

/* ---------- init ---------- */

(async function init() {
  try {
    const [tab] = await messenger.tabs.query({ active: true, currentWindow: true });
    ui.tabId = tab.id;
    const stored = await messenger.storage.local.get("ui");
    const last = stored.ui || {};
    ui.state = await send({ type: "getState", mode: MODE, tabId: ui.tabId });
    if (ui.state.ok) {
      ui.state.defaults = Object.assign({}, ui.state.defaults, {
        language: last.language || ui.state.defaults.language,
        tone: last.tone != null && last.tone !== "" ? last.tone : ui.state.defaults.tone,
        length: last.length || ui.state.defaults.length
      });
      adoptSession(ui.state.session);
    }
  } catch (e) {
    ui.state = { ok: false, error: e.message || String(e) };
  }
  render();
  if (ui.state && ui.state.session) {
    if (ui.state.session.running) {
      setBusy(true);
      pollWhileRunning();
    } else if (ui.state.session.error && !ui.state.session.text) {
      setStatus(ui.state.session.error, true);
    }
  }
})();
