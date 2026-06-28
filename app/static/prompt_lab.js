const STORAGE_KEY = "ai-subcontext-settings";
const statusEl = document.getElementById("prompt-lab-status");
const saveBtn = document.getElementById("prompt-lab-save");
const resetBtn = document.getElementById("prompt-lab-reset");

const FIELD_IDS = [
  "max_completion_tokens",
  "request_timeout_seconds",
  "prompt_translation_system",
  "prompt_translation_strict_retry",
  "prompt_initial_context_system",
  "prompt_full_context_refresh_system",
  "prompt_batch_context_refresh_system",
  "prompt_line_revision_system",
];

let runtimeDefaults = {};
let legacyPromptFingerprints = {};
let activePromptField = null;

function readStoredSettings() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeStoredSettings(nextSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(nextSettings));
}

function setStatus(message, ok = true) {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.style.color = ok ? "var(--muted)" : "var(--danger)";
}

async function fetchRuntimeDefaults() {
  const response = await fetch("/api/runtime/defaults");
  if (!response.ok) {
    throw new Error("Could not load runtime defaults.");
  }
  runtimeDefaults = await response.json();
  legacyPromptFingerprints = runtimeDefaults.legacy_prompt_fingerprints || {};
  delete runtimeDefaults.legacy_prompt_fingerprints;
}

function promptFingerprint(value) {
  let fingerprint = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    fingerprint ^= value.charCodeAt(index);
    fingerprint = Math.imul(fingerprint, 16777619) >>> 0;
  }
  return fingerprint.toString(16).padStart(8, "0");
}

function migrateLegacyPromptDefaults(stored) {
  let changed = false;
  for (const [fieldId, fingerprint] of Object.entries(legacyPromptFingerprints)) {
    const storedValue = stored[fieldId];
    if (typeof storedValue !== "string" || promptFingerprint(storedValue) !== fingerprint) continue;
    stored[fieldId] = runtimeDefaults[fieldId] ?? storedValue;
    changed = true;
  }
  if (changed) writeStoredSettings(stored);
  return stored;
}

function fieldValue(field) {
  if (!field) return "";
  if (field.type === "checkbox") return field.checked;
  return field.value;
}

function populateFields() {
  const stored = migrateLegacyPromptDefaults(readStoredSettings());
  const merged = { ...runtimeDefaults, ...stored };
  for (const fieldId of FIELD_IDS) {
    const field = document.getElementById(fieldId);
    if (!field) continue;
    field.value = merged[fieldId] ?? "";
  }
}

function collectPromptLabSettings() {
  const payload = {};
  for (const fieldId of FIELD_IDS) {
    const field = document.getElementById(fieldId);
    if (!field) continue;
    payload[fieldId] = fieldValue(field);
  }
  return payload;
}

function savePromptLab() {
  const stored = readStoredSettings();
  const next = {
    ...stored,
    ...collectPromptLabSettings(),
  };
  writeStoredSettings(next);
  setStatus("Prompt Lab saved. New and resumed jobs will use these settings.");
}

function resetPromptLab() {
  const stored = readStoredSettings();
  const next = {
    ...stored,
    ...runtimeDefaults,
  };
  writeStoredSettings(next);
  populateFields();
  setStatus("Prompt Lab reset to defaults. New jobs will use the default settings.");
}

function markDirty() {
  setStatus("Unsaved changes in Prompt Lab.");
}

function rememberPromptField(event) {
  if (event.currentTarget instanceof HTMLTextAreaElement) {
    activePromptField = event.currentTarget;
  }
}

function insertPromptVariable(variable) {
  const fallback = document.getElementById("prompt_translation_system");
  const field = activePromptField || fallback;
  if (!(field instanceof HTMLTextAreaElement)) return;

  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  field.setRangeText(variable, start, end, "end");
  field.focus();
  activePromptField = field;
  document.getElementById("prompt-variable-preview").textContent = variable;
  markDirty();
}

async function initializePromptLab() {
  try {
    await fetchRuntimeDefaults();
    populateFields();
    setStatus("Prompt Lab ready. Changes affect new jobs and paused/failed jobs when resumed.");
  } catch (error) {
    setStatus(error?.message || "Could not load Prompt Lab.", false);
  }
}

for (const fieldId of FIELD_IDS) {
  const field = document.getElementById(fieldId);
  field?.addEventListener("input", markDirty);
  if (field instanceof HTMLTextAreaElement) {
    field.addEventListener("focus", rememberPromptField);
    field.addEventListener("click", rememberPromptField);
  }
}

for (const chip of document.querySelectorAll("[data-prompt-variable]")) {
  chip.addEventListener("click", () => insertPromptVariable(chip.dataset.promptVariable || ""));
}

saveBtn?.addEventListener("click", savePromptLab);
resetBtn?.addEventListener("click", resetPromptLab);

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    savePromptLab();
  }
});

void initializePromptLab();
