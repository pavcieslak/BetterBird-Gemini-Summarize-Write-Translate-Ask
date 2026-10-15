"use strict";

const SETTINGS_DEFAULTS = {
  apiKey: "",
  // "-latest" alias so the add-on keeps working when Google retires dated models.
  model: "gemini-flash-latest",
  temperature: 0.4,
  translateLanguage: "English",
  defaultSummary: "bullets",
  defaultTone: "",
  extraInstructions: "",
  maxChars: 60000
};

async function getSettings() {
  const stored = await messenger.storage.local.get("settings");
  return Object.assign({}, SETTINGS_DEFAULTS, stored.settings || {});
}

async function saveSettings(values) {
  const current = await getSettings();
  const next = Object.assign({}, current, values);
  await messenger.storage.local.set({ settings: next });
  return next;
}
