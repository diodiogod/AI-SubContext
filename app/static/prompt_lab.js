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
}

function fieldValue(field) {
  if (!field) return "";
  if (field.type === "checkbox") return field.checked;
  return field.value;
}

function populateFields() {
  const stored = readStoredSettings();
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
  setStatus("Prompt Lab saved. New jobs will use these settings.");
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

async function initializePromptLab() {
  try {
    await fetchRuntimeDefaults();
    populateFields();
    setStatus("Prompt Lab ready. Changes affect future jobs only.");
  } catch (error) {
    setStatus(error?.message || "Could not load Prompt Lab.", false);
  }
}

for (const fieldId of FIELD_IDS) {
  const field = document.getElementById(fieldId);
  field?.addEventListener("input", markDirty);
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
