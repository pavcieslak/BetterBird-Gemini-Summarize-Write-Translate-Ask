"use strict";

const $ = id => document.getElementById(id);
const FIELDS = ["apiKey", "model", "translateLanguage", "defaultSummary", "defaultTone", "extraInstructions", "temperature", "maxChars"];

function send(msg) {
  return messenger.runtime.sendMessage(msg).then(r => r || { ok: false, error: "No response from the add-on background." });
}

function flash(id, text, isError) {
  const node = $(id);
  node.textContent = text;
  node.className = isError ? "error" : "ok";
}

function readForm() {
  return {
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim() || SETTINGS_DEFAULTS.model,
    translateLanguage: $("translateLanguage").value.trim() || SETTINGS_DEFAULTS.translateLanguage,
    defaultSummary: $("defaultSummary").value,
    defaultTone: $("defaultTone").value,
    extraInstructions: $("extraInstructions").value.trim(),
    temperature: Number($("temperature").value),
    maxChars: Math.max(2000, Number($("maxChars").value) || SETTINGS_DEFAULTS.maxChars)
  };
}

(async function init() {
  const s = await getSettings();
  for (const f of FIELDS) $(f).value = s[f];
  $("temperatureOut").textContent = Number(s.temperature).toFixed(1);

  $("temperature").addEventListener("input", () => {
    $("temperatureOut").textContent = Number($("temperature").value).toFixed(1);
  });

  $("toggleKey").addEventListener("click", () => {
    const show = $("apiKey").type === "password";
    $("apiKey").type = show ? "text" : "password";
    $("toggleKey").textContent = show ? "Hide" : "Show";
  });

  $("form").addEventListener("submit", async ev => {
    ev.preventDefault();
    await saveSettings(readForm());
    flash("saved", "Saved.");
    setTimeout(() => flash("saved", ""), 2500);
  });

  $("loadModels").addEventListener("click", async () => {
    const apiKey = $("apiKey").value.trim();
    if (!apiKey) return flash("testResult", "Enter your API key first.", true);
    flash("testResult", "Loading models…");
    const res = await send({ type: "listModels", apiKey });
    if (!res.ok) return flash("testResult", res.error, true);
    const list = $("models");
    list.replaceChildren();
    res.models.forEach(m => {
      const o = document.createElement("option");
      o.value = m;
      list.append(o);
    });
    flash("testResult", `${res.models.length} models available. Click the Model field to pick one.`);
  });

  $("test").addEventListener("click", async () => {
    const apiKey = $("apiKey").value.trim();
    if (!apiKey) return flash("testResult", "Enter your API key first.", true);
    flash("testResult", "Testing…");
    const res = await send({ type: "testKey", apiKey, model: $("model").value.trim() || SETTINGS_DEFAULTS.model });
    if (res.ok) flash("testResult", "Connection works. Remember to press Save.");
    else flash("testResult", res.error, true);
  });
})();
