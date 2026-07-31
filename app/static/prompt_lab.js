const STORAGE_KEY = "ai-subcontext-settings";
const UI_STATE_KEY = "ai-subcontext-prompt-lab-ui-state";
const statusEl = document.getElementById("prompt-lab-status");
const saveBtn = document.getElementById("prompt-lab-save");
const resetBtn = document.getElementById("prompt-lab-reset");
const promptLabForm = document.getElementById("prompt-lab-form");

for (const helpDot of document.querySelectorAll(".info-dot[title]")) {
  helpDot.tabIndex = 0;
  helpDot.setAttribute("role", "note");
  helpDot.setAttribute("aria-label", `Help: ${helpDot.title}`);
}

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
let promptLabRestorePending = true;
let promptLabSaveFrame = null;
let promptLabDraftTimer = null;
let promptLabDirty = false;
let defaultsLoaded = false;

const PROMPT_FIELD_LABELS = {
  prompt_translation_system: "Batch Translation Prompt",
  prompt_translation_strict_retry: "Strict Retry Prompt",
  prompt_initial_context_system: "Initial Card Prompt",
  prompt_full_context_refresh_system: "Whole File Card Refresh Prompt",
  prompt_batch_context_refresh_system: "Batch Card Prompt",
  prompt_line_revision_system: "Line Revision Prompt",
};

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

function readSessionState(storageKey) {
  const raw = sessionStorage.getItem(storageKey);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

function writeSessionState(storageKey, state) {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(state));
  } catch (_) {
    // Saved settings still work; only unsaved-draft recovery is unavailable.
  }
}

function setStatus(message, ok = true) {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.dataset.tone = ok ? (promptLabDirty ? "dirty" : "saved") : "error";
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
  for (const [fieldId, fingerprints] of Object.entries(legacyPromptFingerprints)) {
    const storedValue = stored[fieldId];
    const knownFingerprints = Array.isArray(fingerprints) ? fingerprints : [fingerprints];
    if (typeof storedValue !== "string" || !knownFingerprints.includes(promptFingerprint(storedValue))) continue;
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

function capturePromptLabState() {
  const values = promptLabDirty ? {} : null;
  if (values) {
    for (const fieldId of FIELD_IDS) {
      const field = document.getElementById(fieldId);
      if (!field) continue;
      values[fieldId] = fieldValue(field);
    }
  }
  const activeField = activePromptField?.id || document.activeElement?.id || "";
  return {
    values,
    dirty: promptLabDirty,
    scrollTop: window.scrollY || 0,
    activeField,
    selectionStart: activePromptField?.selectionStart ?? null,
    selectionEnd: activePromptField?.selectionEnd ?? null,
  };
}

function savePromptLabUiState() {
  writeSessionState(UI_STATE_KEY, capturePromptLabState());
}

function savePromptLabLayoutState() {
  const existing = readSessionState(UI_STATE_KEY) || {};
  const activeFieldId = activePromptField?.id || document.activeElement?.id || "";
  writeSessionState(UI_STATE_KEY, {
    ...existing,
    scrollTop: window.scrollY || 0,
    activeField: activeFieldId,
    selectionStart: activePromptField?.selectionStart ?? null,
    selectionEnd: activePromptField?.selectionEnd ?? null,
  });
}

function schedulePromptLabUiSave() {
  if (promptLabSaveFrame !== null) window.clearTimeout(promptLabSaveFrame);
  promptLabSaveFrame = window.setTimeout(() => {
    promptLabSaveFrame = null;
    savePromptLabLayoutState();
  }, 450);
}

function schedulePromptLabDraftSave() {
  if (promptLabDraftTimer !== null) window.clearTimeout(promptLabDraftTimer);
  promptLabDraftTimer = window.setTimeout(() => {
    promptLabDraftTimer = null;
    savePromptLabUiState();
  }, 350);
}

function restorePromptLabUiState() {
  if (!promptLabRestorePending) return;
  promptLabRestorePending = false;
  const state = readSessionState(UI_STATE_KEY);
  if (!state) return false;
  const recoveredDraft = state.dirty === true && state.values && typeof state.values === "object";
  if (recoveredDraft) {
    for (const [fieldId, value] of Object.entries(state.values)) {
      const field = document.getElementById(fieldId);
      if (!field) continue;
      field.value = value ?? "";
    }
  }
  requestAnimationFrame(() => {
    window.scrollTo({ top: Number(state.scrollTop || 0), behavior: "auto" });
    const field = state.activeField ? document.getElementById(state.activeField) : null;
    if (field instanceof HTMLElement) {
      field.focus({ preventScroll: true });
      if (field instanceof HTMLTextAreaElement && Number.isFinite(Number(state.selectionStart)) && Number.isFinite(Number(state.selectionEnd))) {
        field.setSelectionRange(Number(state.selectionStart), Number(state.selectionEnd));
      }
      activePromptField = field instanceof HTMLTextAreaElement ? field : null;
    }
  });
  promptLabDirty = Boolean(recoveredDraft);
  return Boolean(recoveredDraft);
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
  if (!defaultsLoaded || !promptLabForm?.reportValidity()) {
    setStatus("Check the highlighted Prompt Lab fields before saving.", false);
    return;
  }
  try {
    const stored = readStoredSettings();
    const next = {
      ...stored,
      ...collectPromptLabSettings(),
    };
    writeStoredSettings(next);
    promptLabDirty = false;
    sessionStorage.removeItem(UI_STATE_KEY);
    setStatus("Saved · new jobs and resumed paused/failed jobs will use these settings.");
    updatePromptFieldMeta();
  } catch (_) {
    setStatus("Could not save locally. Browser storage may be unavailable.", false);
  }
}

function resetPromptLab() {
  if (!defaultsLoaded) return;
  for (const fieldId of FIELD_IDS) {
    const field = document.getElementById(fieldId);
    if (!field) continue;
    field.value = runtimeDefaults[fieldId] ?? "";
  }
  promptLabDirty = true;
  setStatus("Defaults loaded as an unsaved draft. Review them, then Save Changes.");
  updatePromptFieldMeta();
  schedulePromptLabDraftSave();
}

function markDirty() {
  if (!defaultsLoaded) return;
  promptLabDirty = true;
  setStatus("Unsaved changes in Prompt Lab.");
  updatePromptFieldMeta();
  schedulePromptLabDraftSave();
}

function rememberPromptField(event) {
  if (event.currentTarget instanceof HTMLTextAreaElement) {
    activePromptField = event.currentTarget;
    schedulePromptLabUiSave();
  }
}

function insertPromptVariable(variable) {
  if (!defaultsLoaded) return;
  const fallback = document.getElementById("prompt_translation_system");
  const field = activePromptField || fallback;
  if (!(field instanceof HTMLTextAreaElement)) return;

  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  field.setRangeText(variable, start, end, "end");
  field.focus();
  activePromptField = field;
  const targetLabel = PROMPT_FIELD_LABELS[field.id] || "Active prompt";
  document.getElementById("prompt-variable-preview").textContent = `${targetLabel} · ${variable}`;
  markDirty();
}

function updatePromptFieldMeta(field = null) {
  const fields = field ? [field] : FIELD_IDS.map(id => document.getElementById(id)).filter(item => item instanceof HTMLTextAreaElement);
  for (const promptField of fields) {
    if (!(promptField instanceof HTMLTextAreaElement)) continue;
    const count = promptField.closest(".prompt-field-block")?.querySelector(`[data-prompt-count="${promptField.id}"]`);
    if (count) {
      const characters = promptField.value.length;
      count.textContent = `${characters.toLocaleString()} characters · ~${Math.max(1, Math.ceil(characters / 4)).toLocaleString()} tokens`;
    }
  }
  saveBtn?.classList.toggle("has-unsaved-changes", promptLabDirty);
}

function installPromptFieldTools() {
  for (const [fieldId, label] of Object.entries(PROMPT_FIELD_LABELS)) {
    const field = document.getElementById(fieldId);
    if (!(field instanceof HTMLTextAreaElement) || field.closest(".prompt-field-block")?.querySelector(`[data-prompt-tools="${fieldId}"]`)) continue;
    const labelElement = field.closest("label");
    if (!labelElement) continue;
    const wrapper = document.createElement("div");
    wrapper.className = "prompt-field-block field-span-full";
    labelElement.replaceWith(wrapper);
    wrapper.append(labelElement);
    const tools = document.createElement("div");
    tools.className = "prompt-field-tools";
    tools.dataset.promptTools = fieldId;
    tools.innerHTML = `
      <span data-prompt-count="${fieldId}"></span>
      <button type="button" class="ghost" data-reset-prompt="${fieldId}" title="Restore only ${label} to its default. This remains unsaved until you choose Save Changes.">Reset this prompt</button>
    `;
    wrapper.append(tools);
  }
  updatePromptFieldMeta();
}

async function initializePromptLab() {
  try {
    saveBtn.disabled = true;
    resetBtn.disabled = true;
    for (const fieldId of FIELD_IDS) {
      const field = document.getElementById(fieldId);
      if (field) field.disabled = true;
    }
    for (const chip of document.querySelectorAll("[data-prompt-variable]")) chip.disabled = true;
    await fetchRuntimeDefaults();
    populateFields();
    const recoveredDraft = restorePromptLabUiState();
    defaultsLoaded = true;
    for (const fieldId of FIELD_IDS) {
      const field = document.getElementById(fieldId);
      if (field) field.disabled = false;
    }
    for (const chip of document.querySelectorAll("[data-prompt-variable]")) chip.disabled = false;
    saveBtn.disabled = false;
    resetBtn.disabled = false;
    installPromptFieldTools();
    setStatus(recoveredDraft
      ? "Recovered unsaved Prompt Lab changes from this browser session."
      : "Saved settings are ready. New jobs and resumed paused/failed jobs use them.");
  } catch (error) {
    saveBtn.disabled = true;
    resetBtn.disabled = true;
    setStatus(error?.message || "Could not load Prompt Lab.", false);
  }
}

for (const fieldId of FIELD_IDS) {
  const field = document.getElementById(fieldId);
  field?.addEventListener("input", () => {
    markDirty();
    if (field instanceof HTMLTextAreaElement) updatePromptFieldMeta(field);
  });
  field?.addEventListener("change", schedulePromptLabUiSave);
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

document.addEventListener("click", (event) => {
  const resetPrompt = event.target.closest?.("[data-reset-prompt]");
  if (!resetPrompt) return;
  const fieldId = resetPrompt.dataset.resetPrompt;
  const field = document.getElementById(fieldId);
  if (!(field instanceof HTMLTextAreaElement)) return;
  field.value = runtimeDefaults[fieldId] ?? "";
  activePromptField = field;
  field.focus();
  markDirty();
  updatePromptFieldMeta(field);
  setStatus(`${PROMPT_FIELD_LABELS[fieldId] || "Prompt"} restored to its default as an unsaved change.`);
});

window.addEventListener("scroll", schedulePromptLabUiSave, { passive: true });
window.addEventListener("pagehide", savePromptLabUiState, { passive: true });
window.addEventListener("beforeunload", (event) => {
  try {
    savePromptLabUiState();
  } finally {
    if (!promptLabDirty) return;
    event.preventDefault();
    event.returnValue = "";
  }
});

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    savePromptLab();
  }
});

void initializePromptLab();
