const STORAGE_KEY = "ai-subcontext-settings";
const MODEL_HISTORY_KEY = "ai-subcontext-model-history";
const MAX_MODEL_HISTORY = 10;
const form = document.getElementById("job-form");
const jobsEl = document.getElementById("jobs");
const refreshBtn = document.getElementById("refresh-btn");
const clearFinishedBtn = document.getElementById("clear-finished-btn");
const activeJobCard = document.getElementById("active-job-card");
const dialog = document.getElementById("context-dialog");
const contextDialogTitle = document.getElementById("context-dialog-title");
const contextDialogBody = document.getElementById("context-dialog-body");
const detailDialog = document.getElementById("detail-dialog");
const detailDialogTitle = document.getElementById("detail-dialog-title");
const detailDialogBody = document.getElementById("detail-dialog-body");
const logDialog = document.getElementById("log-dialog");
const logDialogTitle = document.getElementById("log-dialog-title");
const logDialogBody = document.getElementById("log-dialog-body");
const reviewDialog = document.getElementById("review-dialog");
const reviewDialogTitle = document.getElementById("review-dialog-title");
const reviewDialogBody = document.getElementById("review-dialog-body");
const snapshotDialog = document.getElementById("snapshot-dialog");
const snapshotDialogTitle = document.getElementById("snapshot-dialog-title");
const snapshotDialogBody = document.getElementById("snapshot-dialog-body");
const saveContextBtn = document.getElementById("save-context-btn");
const generateContextBtn = document.getElementById("generate-context-btn");
const saveSnapshotBtn = document.getElementById("save-snapshot-btn");
const generateSnapshotBtn = document.getElementById("generate-snapshot-btn");
const fileInput = document.getElementById("file");
const translatedFileInput = document.getElementById("translated_file");
const dropZone = document.getElementById("drop-zone");
const translatedDropZone = document.getElementById("translated-drop-zone");
const selectedFile = document.getElementById("selected-file");
const selectedTranslatedFile = document.getElementById("selected-translated-file");
const modelInput = document.getElementById("model");
const modelHistory = document.getElementById("model-history");
const modelSelect = document.getElementById("model-select");
const loadModelsBtn = document.getElementById("load-models-btn");
const modelListStatus = document.getElementById("model-list-status");
const testConnectionBtn = document.getElementById("test-connection-btn");
const reviewExistingBtn = document.getElementById("review-existing-btn");
const connectionTestResult = document.getElementById("connection-test-result");

let editingJobId = null;
let openLogJobId = null;
let openReviewJobId = null;
let openReviewFilter = "all";
let openSnapshotJobId = null;
let openSnapshotBatchIndex = null;
let remoteModelOptions = [];
const reviewDrafts = new Map();
const reviewInstructionDrafts = new Map();
const contextEditorDrafts = new Map();

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function emptySessionContext() {
  return {
    movie_title: "",
    media_type: "Movie",
    source_language: "",
    target_language: "",
    premise: "",
    tone: "",
    scene_context: "",
    style_notes: [],
    characters: [],
    glossary: [],
    unresolved_ambiguities: [],
  };
}

function normalizeContextInput(context) {
  const base = { ...emptySessionContext(), ...(context || {}) };
  return {
    ...base,
    style_notes: Array.isArray(base.style_notes) ? base.style_notes.filter(Boolean) : [],
    unresolved_ambiguities: Array.isArray(base.unresolved_ambiguities) ? base.unresolved_ambiguities.filter(Boolean) : [],
    characters: Array.isArray(base.characters) ? base.characters.map(item => ({
      name: item?.name || "",
      role: item?.role || "",
      aliases: Array.isArray(item?.aliases) ? item.aliases.filter(Boolean) : [],
      gender: item?.gender || "unknown",
    })) : [],
    glossary: Array.isArray(base.glossary) ? base.glossary.map(item => ({
      term: item?.term || "",
      meaning: item?.meaning || "",
      keep: Boolean(item?.keep),
    })) : [],
  };
}

function splitListText(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(Boolean);
}

function scopeDraftKey(scope, jobId, batchIndex = "") {
  return `${scope}:${jobId}:${batchIndex}`;
}

function normalizeModelName(value) {
  return String(value || "").trim();
}

function readModelHistory() {
  const raw = localStorage.getItem(MODEL_HISTORY_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(normalizeModelName).filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

function writeModelHistory(models) {
  const unique = [];
  const seen = new Set();
  for (const model of models) {
    const name = normalizeModelName(model);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    unique.push(name);
    if (unique.length >= MAX_MODEL_HISTORY) break;
  }
  localStorage.setItem(MODEL_HISTORY_KEY, JSON.stringify(unique));
  renderModelHistory(unique);
  return unique;
}

function renderModelHistory(models = readModelHistory()) {
  if (!modelHistory) return;
  const current = normalizeModelName(modelInput?.value);
  const combined = [];
  const seen = new Set();
  for (const model of [current, ...remoteModelOptions, ...models]) {
    const name = normalizeModelName(model);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    combined.push(name);
    if (combined.length >= MAX_MODEL_HISTORY) break;
  }
  modelHistory.innerHTML = combined.map(model => `<option value="${escapeHtml(model)}"></option>`).join("");
}

function renderModelSelect(models = remoteModelOptions) {
  if (!modelSelect) return;
  const current = normalizeModelName(modelInput?.value);
  if (!models.length) {
    modelSelect.innerHTML = `<option value="">Load models to choose one</option>`;
    modelSelect.value = "";
    return;
  }
  const options = [`<option value="">Choose a fetched model</option>`];
  const seen = new Set();
  for (const model of models) {
    const name = normalizeModelName(model);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    options.push(`<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`);
  }
  modelSelect.innerHTML = options.join("");
  modelSelect.value = seen.has(current) ? current : "";
}

function rememberModel(model) {
  const name = normalizeModelName(model);
  if (!name) return;
  const history = [name, ...readModelHistory().filter(entry => entry !== name)];
  writeModelHistory(history);
}

function setModelListStatus(message, ok = true) {
  if (!modelListStatus) return;
  modelListStatus.textContent = message || "";
  modelListStatus.style.color = ok ? "var(--ok)" : "var(--danger)";
}

function loadSettings() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const settings = JSON.parse(raw);
    for (const [key, value] of Object.entries(settings)) {
      const field = document.getElementById(key);
      if (!field) continue;
      if (field.type === "checkbox") {
        field.checked = Boolean(value);
      } else {
        field.value = value;
      }
    }
    if (settings.model) {
      rememberModel(settings.model);
    }
  } catch (_) {}
}

function saveSettings() {
  const payload = {};
  for (const element of form.elements) {
    if (!element.id || element.type === "file") continue;
    payload[element.id] = element.type === "checkbox" ? element.checked : element.value;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  if (payload.model) {
    rememberModel(payload.model);
  }
}

function collectSettingsPayload() {
  const payload = {};
  for (const element of form.elements) {
    if (!element.id || element.type === "file" || element.type === "button") continue;
    payload[element.id] = element.type === "checkbox" ? element.checked : element.value;
  }
  return payload;
}

function updateSelectedFileLabel() {
  const file = fileInput.files && fileInput.files[0];
  selectedFile.textContent = file ? file.name : "No file selected";
}

function updateSelectedTranslatedFileLabel() {
  const file = translatedFileInput.files && translatedFileInput.files[0];
  selectedTranslatedFile.innerHTML = file ? escapeHtml(file.name) : `Optional second <code>.srt</code>`;
}

function statusBadge(status) {
  return `<span class="badge ${status}">${status}</span>`;
}

function formatProgress(value) {
  const numeric = Number.isFinite(Number(value)) ? Number(value) : 0;
  const bounded = Math.max(0, Math.min(100, numeric));
  return `${Math.round(bounded)}%`;
}

function formatTimestamp(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function hasBatchIndex(value) {
  return value !== null && value !== undefined && value !== "";
}

function tooltipTag(label, tooltip, className = "inline-badge") {
  return `<span class="${className} tooltip-tag" title="${escapeHtml(tooltip)}">${escapeHtml(label)}</span>`;
}

function validationStat(jobId, label, value, className, tooltip, filter) {
  const numeric = Number(value || 0);
  return `
    <button
      type="button"
      class="validation-stat ${className}"
      title="${escapeHtml(tooltip)}"
      data-action="review-lines"
      data-id="${escapeHtml(jobId)}"
      data-filter="${escapeHtml(filter)}"
      ${numeric <= 0 ? "disabled" : ""}
    >
      <span class="validation-stat-label">${escapeHtml(label)}</span>
      <strong>${escapeHtml(String(numeric))}</strong>
    </button>
  `;
}

function detailButton(title, body) {
  return `
    <button
      type="button"
      class="tile-link"
      data-detail-trigger="true"
      data-detail-title="${escapeHtml(title)}"
      data-detail-body="${escapeHtml(body)}"
    >
      View details
    </button>
  `;
}

function shouldShowCharacterDetail(role, aliases) {
  const aliasText = aliases.join(", ");
  return role.length > 240 || aliases.length > 6 || aliasText.length > 120;
}

function shouldShowGlossaryDetail(meaning, keep) {
  return meaning.length > 240 || (keep && meaning.length > 210);
}

function renderSessionSnapshot(snapshot, compact = false) {
  if (!snapshot) return "";

  const characters = (snapshot.characters || []).slice(0, compact ? 6 : 12);
  const glossary = (snapshot.glossary || []).slice(0, compact ? 4 : 8);
  const styleNotes = (snapshot.style_notes || []).slice(0, compact ? 4 : 8);
  const ambiguities = snapshot.unresolved_ambiguities || [];

  return `
    <div class="context-card">
      ${snapshot.premise ? `
        <div class="tile">
          <div class="mini-eyebrow">Premise</div>
          <p>${escapeHtml(snapshot.premise)}</p>
        </div>
      ` : ""}

      ${snapshot.tone ? `
        <div class="tile">
          <div class="mini-eyebrow">Tone</div>
          <p>${escapeHtml(snapshot.tone)}</p>
        </div>
      ` : ""}

      ${snapshot.scene_context ? `
        <div class="scene">
          <div class="mini-eyebrow">Scene</div>
          <div>${escapeHtml(snapshot.scene_context)}</div>
        </div>
      ` : ""}

      ${styleNotes.length ? `
        <div class="tile">
          <div class="mini-eyebrow">Style Notes</div>
          <ul>${styleNotes.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        </div>
      ` : ""}

      ${characters.length ? `
        <div>
          <div class="mini-eyebrow">Characters</div>
          <div class="grid grid-characters">
            ${characters.map(character => {
              const name = character.name || "Unnamed";
              const role = character.role || "No role summary yet.";
              const aliases = Array.isArray(character.aliases) ? character.aliases.filter(Boolean) : [];
              const showDetail = shouldShowCharacterDetail(role, aliases);
              const detailBody = [
                role,
                aliases.length ? `Aliases: ${aliases.join(", ")}` : "Aliases: none",
              ].join("\n\n");
              return `
              <div class="tile tile-fixed">
                <h4>
                  <span class="tile-title-text">${escapeHtml(name)}</span>
                  ${character.gender && character.gender !== "unknown" ? tooltipTag(character.gender.toUpperCase(), "Character metadata inferred from the active scene context.") : ""}
                </h4>
                <p class="tile-copy">${escapeHtml(role)}</p>
                ${aliases.length ? `<div class="chip-row">${aliases.map(alias => tooltipTag(alias, "Known alias for this character.", "chip")).join("")}</div>` : ""}
                ${showDetail ? `<div class="tile-actions">${detailButton(`${name} Details`, detailBody)}</div>` : ""}
              </div>
            `;
            }).join("")}
          </div>
        </div>
      ` : ""}

      ${glossary.length ? `
        <div>
          <div class="mini-eyebrow">Glossary</div>
          <div class="grid grid-glossary">
            ${glossary.map(entry => {
              const term = entry.term || "Untitled term";
              const meaning = entry.meaning || "No glossary note yet.";
              const showDetail = shouldShowGlossaryDetail(meaning, Boolean(entry.keep));
              const detailBody = meaning;
              return `
              <div class="tile tile-fixed">
                <h4>
                  <span class="tile-title-text">${escapeHtml(term)}</span>
                  ${entry.keep ? tooltipTag("Keep", "Preserve this term as written during translation.") : ""}
                </h4>
                <p class="tile-copy">${escapeHtml(meaning)}</p>
                ${showDetail ? `<div class="tile-actions">${detailButton(`${term} Glossary Note`, detailBody)}</div>` : ""}
              </div>
            `;
            }).join("")}
          </div>
        </div>
      ` : ""}

      ${ambiguities.length ? `
        <div class="tile">
          <div class="mini-eyebrow">Ambiguities</div>
          <ul>${ambiguities.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        </div>
      ` : ""}
    </div>
  `;
}

function renderCharacterEditorRow(scope, character, index) {
  return `
    <article class="editor-item" data-editor-row="character">
      <div class="editor-item-head">
        <span class="job-fact">Character ${escapeHtml(String(index + 1))}</span>
        <button type="button" class="ghost small" data-context-remove="character" data-context-scope="${escapeHtml(scope)}">Remove</button>
      </div>
      <div class="field-grid field-grid-primary context-mini-grid">
        <label>
          <span class="label-row">Name</span>
          <input type="text" data-context-character="name" value="${escapeHtml(character.name || "")}" />
        </label>
        <label>
          <span class="label-row">Gender</span>
          <select data-context-character="gender">
            ${["unknown", "f", "m", "neutral"].map(value => `<option value="${escapeHtml(value)}" ${character.gender === value ? "selected" : ""}>${escapeHtml(value)}</option>`).join("")}
          </select>
        </label>
        <label class="field-span-full">
          <span class="label-row">Role</span>
          <textarea data-context-character="role">${escapeHtml(character.role || "")}</textarea>
        </label>
        <label class="field-span-full">
          <span class="label-row">Aliases</span>
          <input type="text" data-context-character="aliases" value="${escapeHtml((character.aliases || []).join(", "))}" placeholder="comma separated aliases" />
        </label>
      </div>
    </article>
  `;
}

function renderGlossaryEditorRow(scope, entry, index) {
  return `
    <article class="editor-item" data-editor-row="glossary">
      <div class="editor-item-head">
        <span class="job-fact">Glossary ${escapeHtml(String(index + 1))}</span>
        <button type="button" class="ghost small" data-context-remove="glossary" data-context-scope="${escapeHtml(scope)}">Remove</button>
      </div>
      <div class="field-grid field-grid-primary context-mini-grid">
        <label>
          <span class="label-row">Term</span>
          <input type="text" data-context-glossary="term" value="${escapeHtml(entry.term || "")}" />
        </label>
        <label class="checkbox editor-inline-check">
          <input type="checkbox" data-context-glossary="keep" ${entry.keep ? "checked" : ""} />
          <span>Keep as written</span>
        </label>
        <label class="field-span-full">
          <span class="label-row">Meaning</span>
          <textarea data-context-glossary="meaning">${escapeHtml(entry.meaning || "")}</textarea>
        </label>
      </div>
    </article>
  `;
}

function renderContextEditor(scope, context, options = {}) {
  const normalized = normalizeContextInput(context);
  const previewId = `context-preview-${scope}`;
  return `
    ${options.meta || ""}
    <div class="context-editor-grid">
      <section class="context-editor-form">
        <div class="field-grid field-grid-primary">
          <input type="hidden" data-context-field="movie_title" data-context-scope="${escapeHtml(scope)}" value="${escapeHtml(normalized.movie_title || "")}" />
          <input type="hidden" data-context-field="media_type" data-context-scope="${escapeHtml(scope)}" value="${escapeHtml(normalized.media_type || "Movie")}" />
          <input type="hidden" data-context-field="source_language" data-context-scope="${escapeHtml(scope)}" value="${escapeHtml(normalized.source_language || "")}" />
          <input type="hidden" data-context-field="target_language" data-context-scope="${escapeHtml(scope)}" value="${escapeHtml(normalized.target_language || "")}" />
          <label class="field-span-full">
            <span class="label-row">Premise</span>
            <textarea data-context-field="premise" data-context-scope="${escapeHtml(scope)}">${escapeHtml(normalized.premise)}</textarea>
          </label>
          <label>
            <span class="label-row">Tone</span>
            <input type="text" data-context-field="tone" data-context-scope="${escapeHtml(scope)}" value="${escapeHtml(normalized.tone)}" />
          </label>
          <label class="field-span-full">
            <span class="label-row">Scene Context</span>
            <textarea data-context-field="scene_context" data-context-scope="${escapeHtml(scope)}">${escapeHtml(normalized.scene_context)}</textarea>
          </label>
          <label class="field-span-full">
            <span class="label-row">Style Notes</span>
            <textarea data-context-field="style_notes" data-context-scope="${escapeHtml(scope)}" placeholder="One note per line">${escapeHtml(normalized.style_notes.join("\n"))}</textarea>
          </label>
          <label class="field-span-full">
            <span class="label-row">Ambiguities</span>
            <textarea data-context-field="unresolved_ambiguities" data-context-scope="${escapeHtml(scope)}" placeholder="One ambiguity per line">${escapeHtml(normalized.unresolved_ambiguities.join("\n"))}</textarea>
          </label>
        </div>
        <section class="editor-section">
          <div class="editor-section-head">
            <div class="mini-eyebrow">Characters</div>
            <button type="button" class="ghost small" data-context-add="character" data-context-scope="${escapeHtml(scope)}">Add Character</button>
          </div>
          <div class="editor-list" data-context-list="character" data-context-scope="${escapeHtml(scope)}">
            ${normalized.characters.length ? normalized.characters.map((character, index) => renderCharacterEditorRow(scope, character, index)).join("") : `<p class="job-meta">No characters yet.</p>`}
          </div>
        </section>
        <section class="editor-section">
          <div class="editor-section-head">
            <div class="mini-eyebrow">Glossary</div>
            <button type="button" class="ghost small" data-context-add="glossary" data-context-scope="${escapeHtml(scope)}">Add Term</button>
          </div>
          <div class="editor-list" data-context-list="glossary" data-context-scope="${escapeHtml(scope)}">
            ${normalized.glossary.length ? normalized.glossary.map((entry, index) => renderGlossaryEditorRow(scope, entry, index)).join("") : `<p class="job-meta">No glossary terms yet.</p>`}
          </div>
        </section>
      </section>
      <section class="context-editor-preview">
        <div class="mini-eyebrow">Live Preview</div>
        <div id="${escapeHtml(previewId)}" class="snapshot-preview">
          ${renderSessionSnapshot(normalized)}
        </div>
      </section>
    </div>
  `;
}

function readContextEditor(scope, root = document) {
  const getField = (name) => root.querySelector(`[data-context-field="${name}"][data-context-scope="${scope}"]`);
  return {
    movie_title: getField("movie_title")?.value || "",
    media_type: getField("media_type")?.value || "Movie",
    source_language: getField("source_language")?.value || "",
    target_language: getField("target_language")?.value || "",
    premise: getField("premise")?.value.trim() || "",
    tone: getField("tone")?.value.trim() || "",
    scene_context: getField("scene_context")?.value.trim() || "",
    style_notes: splitListText(getField("style_notes")?.value || ""),
    unresolved_ambiguities: splitListText(getField("unresolved_ambiguities")?.value || ""),
    characters: Array.from(root.querySelectorAll(`[data-context-list="character"][data-context-scope="${scope}"] [data-editor-row="character"]`)).map(item => ({
      name: item.querySelector('[data-context-character="name"]')?.value.trim() || "",
      role: item.querySelector('[data-context-character="role"]')?.value.trim() || "",
      aliases: String(item.querySelector('[data-context-character="aliases"]')?.value || "")
        .split(",")
        .map(value => value.trim())
        .filter(Boolean),
      gender: item.querySelector('[data-context-character="gender"]')?.value || "unknown",
    })).filter(item => item.name || item.role || item.aliases.length),
    glossary: Array.from(root.querySelectorAll(`[data-context-list="glossary"][data-context-scope="${scope}"] [data-editor-row="glossary"]`)).map(item => ({
      term: item.querySelector('[data-context-glossary="term"]')?.value.trim() || "",
      meaning: item.querySelector('[data-context-glossary="meaning"]')?.value.trim() || "",
      keep: Boolean(item.querySelector('[data-context-glossary="keep"]')?.checked),
    })).filter(item => item.term || item.meaning),
  };
}

function syncContextPreview(scope, root = document) {
  const preview = root.querySelector(`#context-preview-${scope}`);
  if (!preview) return;
  preview.innerHTML = renderSessionSnapshot(normalizeContextInput(readContextEditor(scope, root)));
}

function addContextRow(scope, kind, root = document) {
  const draft = normalizeContextInput(readContextEditor(scope, root));
  if (kind === "character") {
    draft.characters.push({ name: "", role: "", aliases: [], gender: "unknown" });
  } else if (kind === "glossary") {
    draft.glossary.push({ term: "", meaning: "", keep: true });
  }
  if (scope === "snapshot" && openSnapshotJobId && openSnapshotBatchIndex !== null) {
    contextEditorDrafts.set(snapshotDraftKey(openSnapshotJobId, openSnapshotBatchIndex), draft);
    const responseJobId = openSnapshotJobId;
    void fetch(`/api/jobs/${responseJobId}`)
      .then(response => response.json())
      .then(job => renderSnapshotDialog(job, openSnapshotBatchIndex));
    return;
  }
  if (scope === "main" && editingJobId) {
    contextEditorDrafts.set(scopeDraftKey("main", editingJobId), draft);
    void fetch(`/api/jobs/${editingJobId}`)
      .then(response => response.json())
      .then(job => renderMainContextDialog(job, draft));
  }
}

function removeContextRow(scope, kind, button) {
  const row = button.closest("[data-editor-row]");
  if (!row) return;
  row.remove();
  const root = button.closest("dialog") || document;
  const draft = normalizeContextInput(readContextEditor(scope, root));
  if (scope === "snapshot" && openSnapshotJobId && openSnapshotBatchIndex !== null) {
    contextEditorDrafts.set(snapshotDraftKey(openSnapshotJobId, openSnapshotBatchIndex), draft);
  }
  if (scope === "main" && editingJobId) {
    contextEditorDrafts.set(scopeDraftKey("main", editingJobId), draft);
  }
  syncContextPreview(scope, root);
}

function renderContext(job) {
  const ctx = job.session_context;
  if (!ctx) return "";
  const previous = (job.session_context_history || [])[1];
  const validation = job.validation_stats || {};
  const fixedTotal = Number(validation.auto_fixed_subtitles || 0) + Number(validation.manual_fixed_subtitles || 0);
  return `
    <div class="context-card">
      <div class="panel-head">
        <div>
          <h2>Translation Context</h2>
          <div class="job-meta">Rolling card shared across batches</div>
        </div>
        ${statusBadge(job.status)}
      </div>
      <div class="actions">
        <button class="warn" data-action="pause" data-id="${job.id}" title="Pause after the current batch finishes. Safer than interrupting a request mid-generation." ${job.status !== "processing" ? "disabled" : ""}>Pause</button>
        <button class="ghost" data-action="resume" data-id="${job.id}" title="Resume a paused job from the next pending batch." ${job.status !== "paused" ? "disabled" : ""}>Resume</button>
        <a class="ghost link-button" href="/review/${job.id}" title="Open the dedicated table review workspace for this job.">Open Workspace</a>
        <button class="ghost" data-action="review-lines" data-id="${job.id}" data-filter="all" title="Open the line review panel. Use it to inspect flagged lines and apply manual fixes.">Review Lines</button>
        <button class="ghost" data-action="logs" data-id="${job.id}" title="Open the verbose execution log with retries, validation checks, and flagged lines.">View Log</button>
        <button class="ghost" data-action="edit" data-id="${job.id}" title="Edit the rolling context card before the next batch uses it." ${(job.status !== "processing" && job.status !== "paused") ? "disabled" : ""}>Edit Context</button>
        <button class="danger" data-action="stop" data-id="${job.id}" title="Stop the job after the current batch finishes." ${(job.status !== "processing" && job.status !== "paused") ? "disabled" : ""}>Stop</button>
      </div>
      <div class="validation-summary">
        ${validationStat(
          job.id,
          "Suspect",
          validation.suspicious_subtitles || 0,
          "is-suspect",
          "Subtitle lines flagged by validation as likely untranslated or still in the source language.",
          "suspect",
        )}
        ${validationStat(
          job.id,
          "Fixed",
          fixedTotal,
          "is-fixed",
          "Subtitle lines fixed automatically by retry or manually in the review panel.",
          "fixed",
        )}
        ${validationStat(
          job.id,
          "Error",
          validation.error_subtitles || 0,
          "is-error",
          "Subtitle lines that still looked wrong after retry and fallback handling.",
          "error",
        )}
      </div>
      ${renderSessionSnapshot(ctx)}
      ${previous ? `
        <div class="tile">
          <div class="mini-eyebrow">Previous Snapshot</div>
          ${renderSessionSnapshot(previous, true)}
        </div>
      ` : ""}
    </div>
  `;
}

function renderJobs(jobs) {
  if (!jobs.length) {
    jobsEl.innerHTML = `<p class="job-meta">No jobs yet.</p>`;
    activeJobCard.classList.add("hidden");
    activeJobCard.innerHTML = "";
    return;
  }

  const active = jobs.find(job => job.status === "processing" || job.status === "paused");
  if (active && active.session_context) {
    activeJobCard.classList.remove("hidden");
    activeJobCard.innerHTML = renderContext(active);
  } else {
    activeJobCard.classList.add("hidden");
    activeJobCard.innerHTML = "";
  }

  const counts = jobs.reduce((acc, job) => {
    acc.total += 1;
    acc[job.status] = (acc[job.status] || 0) + 1;
    return acc;
  }, { total: 0, processing: 0, paused: 0, completed: 0, failed: 0, cancelled: 0 });

  jobsEl.innerHTML = `
    <div class="jobs-summary">
      <div class="job-stat">
        <span class="job-stat-label">Total</span>
        <strong>${counts.total}</strong>
      </div>
      <div class="job-stat">
        <span class="job-stat-label">Active</span>
        <strong>${counts.processing + counts.paused}</strong>
      </div>
      <div class="job-stat">
        <span class="job-stat-label">Completed</span>
        <strong>${counts.completed}</strong>
      </div>
      <div class="job-stat">
        <span class="job-stat-label">Issues</span>
        <strong>${counts.failed + counts.cancelled}</strong>
      </div>
    </div>
    <div class="job-list">${jobs.map(job => {
      const progress = formatProgress(job.progress);
      const title = escapeHtml(job.title || job.filename || "Untitled job");
      const filename = escapeHtml(job.filename || "Unknown file");
      const sourceLanguage = escapeHtml(job?.settings?.source_language || "n/a");
      const targetLanguage = escapeHtml(job?.settings?.target_language || "n/a");
      const model = escapeHtml(job?.settings?.model || "No model");
      const kind = job?.job_kind === "review" ? "Validation Review" : "Translation";
      const message = escapeHtml(job.message || "Waiting for update.");
      const logCount = Array.isArray(job.logs) ? job.logs.length : 0;
      const logTitle = logCount
        ? `Show verbose runtime events, retries, and validation decisions. ${logCount} log entries available.`
        : "Show verbose runtime events, retries, and validation decisions.";
      const validation = job.validation_stats || {};
      const issueCount = Array.isArray(job.validation_issues) ? job.validation_issues.length : 0;
      const fixedTotal = Number(validation.auto_fixed_subtitles || 0) + Number(validation.manual_fixed_subtitles || 0);
      return `
    <article class="job job-workspace-link" data-workspace-url="/review/${job.id}">
      <button class="job-corner-log" data-action="logs" data-id="${job.id}" title="${escapeHtml(logTitle)}">
        <span class="job-corner-label" aria-hidden="true">log</span>
      </button>
      <div class="job-top">
        <div class="job-copy">
          <div class="job-headline">
            <h3 class="job-title">${title}</h3>
            <span class="job-kicker">${filename}</span>
            ${statusBadge(job.status)}
          </div>
          <div class="job-facts">
            <span class="job-fact">${escapeHtml(kind)}</span>
            <span class="job-fact">${sourceLanguage} → ${targetLanguage}</span>
            <span class="job-fact">${model}</span>
            <span class="job-fact">Progress ${progress}</span>
            ${(validation.suspicious_subtitles || fixedTotal || validation.error_subtitles) ? `
              <span class="job-fact">Suspect ${escapeHtml(String(validation.suspicious_subtitles || 0))}</span>
              <span class="job-fact">Fixed ${escapeHtml(String(fixedTotal))}</span>
              <span class="job-fact">Error ${escapeHtml(String(validation.error_subtitles || 0))}</span>
            ` : ""}
          </div>
          <div class="job-meta">${message}</div>
        </div>
        <div class="job-actions">
          <button class="ghost" data-action="review-lines" data-id="${job.id}" data-filter="all" title="Inspect flagged subtitle lines and save manual fixes." ${issueCount ? "" : "disabled"}>Review Lines${issueCount ? ` (${issueCount})` : ""}</button>
          ${job.status === "completed" ? `<button class="ghost" data-action="download" data-id="${job.id}" title="Download the current translated subtitle file.">Download</button>` : ""}
          <button class="ghost" data-action="delete-job" data-id="${job.id}" title="Remove this job entry from the list. Active jobs must be paused or stopped first." ${(job.status === "processing" || job.status === "queued") ? "disabled" : ""}>Delete</button>
        </div>
      </div>
      <div class="job-progress-row">
        <div class="job-progress-label">Translation progress</div>
        <div class="job-progress-value">${progress}</div>
      </div>
      <div class="progress"><div class="progress-bar" style="width:${job.progress || 0}%"></div></div>
    </article>
  `;
    }).join("")}</div>
  `;
}

function renderLogDialog(job) {
  if (!job || !logDialogTitle || !logDialogBody) return;
  const title = job.title || job.filename || "Job";
  const logs = Array.isArray(job.logs) ? job.logs : [];
  const issues = Array.isArray(job.validation_issues) ? job.validation_issues : [];
  logDialogTitle.textContent = `${title} Log`;
  if (!logs.length && !issues.length) {
    logDialogBody.innerHTML = `<p class="job-meta">No verbose events yet.</p>`;
    return;
  }
  logDialogBody.innerHTML = `
    <div class="log-section">
      <div class="mini-eyebrow">Event Log</div>
      <div class="log-list">
      ${logs.map(entry => {
        const level = escapeHtml(entry.level || "info");
        const batch = hasBatchIndex(entry.batch_index) ? `Batch ${Number(entry.batch_index)}` : "System";
        return `
          <article class="log-entry">
            <div class="log-entry-head">
              <span class="log-time">${escapeHtml(formatTimestamp(entry.timestamp))}</span>
              <span class="log-badge ${level}">${level}</span>
              <span class="log-batch">${escapeHtml(batch)}</span>
            </div>
            <div class="log-message">${escapeHtml(entry.message || "")}</div>
          </article>
        `;
      }).join("")}
      </div>
    </div>
    ${issues.length ? `
      <div class="log-section">
        <div class="mini-eyebrow">Flagged Subtitle Lines</div>
        <div class="issue-list">
          ${issues.map(issue => `
            <article class="issue-entry ${escapeHtml(issue.status || "suspect")}">
              <div class="issue-entry-head">
                <span class="log-badge ${escapeHtml(issue.status || "suspect")}">${escapeHtml(issue.status || "suspect")}</span>
                <span class="log-batch">Line ${escapeHtml(String((issue.position ?? 0) + 1))}</span>
                ${hasBatchIndex(issue.batch_index) ? `<span class="log-time">Batch ${escapeHtml(String(issue.batch_index))}</span>` : ""}
              </div>
              <div class="issue-copy"><strong>Source:</strong> ${escapeHtml(issue.source_text || "")}</div>
              <div class="issue-copy"><strong>Current:</strong> ${escapeHtml(issue.translated_text || "")}</div>
              ${(issue.notes || []).length ? `<div class="issue-notes">${(issue.notes || []).map(note => `<div>${escapeHtml(note)}</div>`).join("")}</div>` : ""}
            </article>
          `).join("")}
        </div>
      </div>
    ` : ""}
  `;
  logDialogBody.scrollTop = logDialogBody.scrollHeight;
}

function filterIssues(issues, filter) {
  if (filter === "all") return issues;
  if (filter === "fixed") {
    return issues.filter(issue => issue.status === "auto_fixed" || issue.status === "manual_fixed");
  }
  return issues.filter(issue => issue.status === filter);
}

function reviewInstructionKey(jobId, position) {
  return `${jobId}:${position}`;
}

function findBatchSnapshot(job, batchIndex) {
  const snapshots = Array.isArray(job?.batch_context_snapshots) ? job.batch_context_snapshots : [];
  return snapshots.find(item => Number(item.batch_index) === Number(batchIndex)) || null;
}

function deriveBatchInfo(job, batchIndex) {
  const snapshot = findBatchSnapshot(job, batchIndex);
  if (snapshot) {
    return {
      batch_index: Number(batchIndex),
      start_position: Number(snapshot.start_position),
      end_position: Number(snapshot.end_position),
      input_context: snapshot.input_context || null,
      output_context: snapshot.output_context || null,
      has_snapshot: true,
    };
  }
  const batchSize = Number(job?.settings?.batch_size || 0);
  const lines = Array.isArray(job?.original_lines) ? job.original_lines : [];
  if (!batchSize || !lines.length || !Number.isFinite(Number(batchIndex)) || Number(batchIndex) <= 0) {
    return null;
  }
  const start = (Number(batchIndex) - 1) * batchSize;
  const slice = lines.slice(start, start + batchSize);
  if (!slice.length) return null;
  return {
    batch_index: Number(batchIndex),
    start_position: Number(slice[0].position),
    end_position: Number(slice[slice.length - 1].position),
    input_context: null,
    output_context: null,
    has_snapshot: false,
  };
}

function snapshotDraftKey(jobId, batchIndex) {
  return `${jobId}:batch:${batchIndex}`;
}

function formatContextJson(snapshot) {
  return JSON.stringify(snapshot || {}, null, 2);
}

function renderSnapshotPreview(context) {
  if (!context) {
    return `<div class="tile"><div class="mini-eyebrow">No Snapshot</div><p>No saved context for this side.</p></div>`;
  }
  return renderSessionSnapshot(context);
}

function syncSnapshotPreview() {
  syncContextPreview("snapshot", snapshotDialogBody);
}

function renderSnapshotDialog(job, batchIndex) {
  if (!job || !snapshotDialogTitle || !snapshotDialogBody) return;
  const snapshot = deriveBatchInfo(job, batchIndex);
  snapshotDialogTitle.textContent = `Batch ${batchIndex} Card`;
  if (!snapshot) {
    snapshotDialogBody.innerHTML = `<p class="job-meta">No saved batch snapshot found for this batch.</p>`;
    if (saveSnapshotBtn) saveSnapshotBtn.disabled = true;
    return;
  }

  const draftKey = snapshotDraftKey(job.id, batchIndex);
  const currentDraft = contextEditorDrafts.has(draftKey)
    ? contextEditorDrafts.get(draftKey)
    : normalizeContextInput(snapshot.input_context || job.session_context || {});

  snapshotDialogBody.innerHTML = `
    ${renderContextEditor("snapshot", currentDraft, {
      meta: `
        <div class="snapshot-meta-row">
          <span class="job-fact">Batch ${escapeHtml(String(batchIndex))}</span>
          <span class="job-fact">Lines ${escapeHtml(String(snapshot.start_position + 1))} to ${escapeHtml(String(snapshot.end_position + 1))}</span>
          <span class="job-fact">${snapshot.has_snapshot ? "Used for retranslation" : "No saved card yet"}</span>
        </div>
        <section class="context-editor-preview secondary">
          <div class="mini-eyebrow">Saved Output Card</div>
          <div class="snapshot-preview">
            ${snapshot.has_snapshot ? renderSnapshotPreview(snapshot.output_context) : `<div class="tile"><div class="mini-eyebrow">No Saved Output</div><p>This batch did not have a stored snapshot yet. You can generate one now.</p></div>`}
          </div>
        </section>
      `,
    })}
  `;
  if (saveSnapshotBtn) saveSnapshotBtn.disabled = false;
}

function renderMainContextDialog(job, context) {
  if (!dialog || !contextDialogBody || !contextDialogTitle) return;
  editingJobId = job.id;
  contextDialogTitle.textContent = `Edit Context`;
  const draftKey = scopeDraftKey("main", job.id);
  const currentDraft = contextEditorDrafts.has(draftKey)
    ? contextEditorDrafts.get(draftKey)
    : normalizeContextInput(context || {});
  contextDialogBody.innerHTML = renderContextEditor("main", currentDraft);
}

function reviewActionMeta(currentText, originalText) {
  const current = String(currentText ?? "");
  const original = String(originalText ?? "");
  if (current === original) {
    return {
      label: "Mark Resolved",
      mode: "resolve",
      title: "Keep the current text and mark this line as resolved manually.",
    };
  }
  if (!current.trim()) {
    return {
      label: "Remove Subtitle",
      mode: "remove",
      title: "Blank this subtitle line and mark the removal as manual.",
    };
  }
  return {
    label: "Save Line",
    mode: "save",
    title: "Save the edited translation and mark this line as manually fixed.",
  };
}

function syncReviewActionState(position) {
  const field = reviewDialogBody.querySelector(`[data-review-input="${position}"]`);
  const actionButton = reviewDialogBody.querySelector(`[data-review-apply="${position}"]`);
  if (!field || !actionButton) return;
  const meta = reviewActionMeta(field.value, field.dataset.original || "");
  actionButton.textContent = meta.label;
  actionButton.dataset.reviewMode = meta.mode;
  actionButton.title = meta.title;
}

function renderReviewDialog(job, filter = "all") {
  if (!job || !reviewDialogTitle || !reviewDialogBody) return;
  const issues = Array.isArray(job.validation_issues) ? job.validation_issues : [];
  const pendingRetranslations = new Map(
    (Array.isArray(job.pending_retranslations) ? job.pending_retranslations : []).map(item => [Number(item.position), item]),
  );
  const filteredIssues = filterIssues(issues, filter);
  const counts = {
    all: issues.length,
    suspect: issues.filter(issue => issue.status === "suspect").length,
    fixed: issues.filter(issue => issue.status === "auto_fixed" || issue.status === "manual_fixed").length,
    error: issues.filter(issue => issue.status === "error").length,
  };
  reviewDialogTitle.textContent = `${job.title || job.filename || "Job"} Review`;
  reviewDialogBody.innerHTML = `
    <div class="review-workspace-cta">
      <div>
        <div class="mini-eyebrow">Better Workflow</div>
        <strong>Use the Review Workspace for table view, faster navigation, and batch-card editing.</strong>
      </div>
      <a class="review-workspace-link" href="/review/${job.id}">Open Workspace</a>
    </div>
    <div class="review-filter-row">
      ${["all", "suspect", "fixed", "error"].map(name => `
        <button
          type="button"
          class="review-filter ${name === filter ? "is-active" : ""}"
          data-review-filter="${escapeHtml(name)}"
        >
          ${escapeHtml(name === "all" ? "All" : name.charAt(0).toUpperCase() + name.slice(1))} (${escapeHtml(String(counts[name]))})
        </button>
      `).join("")}
    </div>
    ${filteredIssues.length ? `
      <div class="review-list">
        ${filteredIssues.map(issue => {
          const position = Number(issue.position || 0);
          const textId = `review-line-${job.id}-${position}`;
          const draftKey = `${job.id}:${position}`;
          const instructionDraftKey = reviewInstructionKey(job.id, position);
          const originalText = issue.translated_text || "";
          const currentText = reviewDrafts.has(draftKey) ? reviewDrafts.get(draftKey) : originalText;
          const pendingRetranslation = pendingRetranslations.get(position);
          const currentInstruction = reviewInstructionDrafts.has(instructionDraftKey)
            ? reviewInstructionDrafts.get(instructionDraftKey)
            : (pendingRetranslation?.extra_instruction || "");
          const actionMeta = reviewActionMeta(currentText, originalText);
          const hasBatchCard = Boolean(issue.batch_index && deriveBatchInfo(job, issue.batch_index));
          const queueMode = job.status === "processing" || job.status === "queued";
          const retranslateLabel = pendingRetranslation
            ? "Update Queued Retranslate"
            : (queueMode ? "Queue Retranslate" : "Retranslate");
          const retranslateTitle = pendingRetranslation
            ? "Replace the existing queued retranslation instruction for this line."
            : (queueMode
              ? "Queue this line for retranslation. It will run at a safe batch boundary."
              : "Run a fresh retranslation for this line now, using the optional instruction below.");
          return `
            <article class="review-item ${escapeHtml(issue.status || "suspect")}">
              <div class="issue-entry-head">
                <span class="log-badge ${escapeHtml(issue.status || "suspect")}">${escapeHtml(issue.status || "suspect")}</span>
                <span class="log-batch">Line ${escapeHtml(String(position + 1))}</span>
                ${hasBatchIndex(issue.batch_index) ? `<span class="log-time">Batch ${escapeHtml(String(issue.batch_index))}</span>` : ""}
                ${pendingRetranslation ? `<span class="log-badge info">queued</span>` : ""}
              </div>
              <div class="review-source"><strong>Source</strong><p>${escapeHtml(issue.source_text || "")}</p></div>
              <label class="review-edit">
                <strong>Translation</strong>
                <textarea
                  id="${escapeHtml(textId)}"
                  data-review-input="${escapeHtml(String(position))}"
                  data-original="${escapeHtml(originalText)}"
                  data-review-editable="true"
                >${escapeHtml(currentText)}</textarea>
              </label>
              <label class="review-instruction">
                <strong>Retranslate Instruction</strong>
                <input
                  type="text"
                  value="${escapeHtml(currentInstruction)}"
                  placeholder="Optional instruction for this line only"
                  data-review-instruction="${escapeHtml(String(position))}"
                  data-review-editable="true"
                />
              </label>
              ${(issue.notes || []).length ? `<div class="issue-notes">${(issue.notes || []).map(note => `<div>${escapeHtml(note)}</div>`).join("")}</div>` : ""}
              <div class="review-actions">
                <button
                  type="button"
                  class="ghost"
                  data-review-snapshot="${escapeHtml(String(issue.batch_index || ""))}"
                  title="${escapeHtml(
                    hasBatchCard
                      ? "Open the batch card for these lines. If no snapshot exists yet, you can generate and save one here."
                      : "No batch card is available for this line."
                  )}"
                  ${hasBatchCard ? "" : "disabled"}
                >
                  Batch Card
                </button>
                <button
                  type="button"
                  class="ghost"
                  data-review-retranslate="${escapeHtml(String(position))}"
                  title="${escapeHtml(retranslateTitle)}"
                >
                  ${escapeHtml(retranslateLabel)}
                </button>
                <button
                  type="button"
                  data-review-apply="${escapeHtml(String(position))}"
                  data-review-mode="${escapeHtml(actionMeta.mode)}"
                  title="${escapeHtml(actionMeta.title)}"
                >
                  ${escapeHtml(actionMeta.label)}
                </button>
                <button
                  type="button"
                  class="ghost"
                  data-review-remove="${escapeHtml(String(position))}"
                  title="Blank this subtitle line and mark the removal as manual."
                >
                  Remove Subtitle
                </button>
              </div>
            </article>
          `;
        }).join("")}
      </div>
    ` : `<p class="job-meta">No lines in this filter.</p>`}
  `;
}

async function fetchJobs() {
  const response = await fetch("/api/jobs");
  const jobs = await response.json();
  const models = [];
  for (const job of jobs) {
    if (job?.settings?.model) models.push(job.settings.model);
  }
  if (modelInput?.value) models.unshift(modelInput.value);
  writeModelHistory(models);
  renderJobs(jobs);
  if (openLogJobId) {
    const openJob = jobs.find(job => job.id === openLogJobId);
    if (openJob) {
      renderLogDialog(openJob);
    } else if (logDialog?.open) {
      logDialog.close();
      openLogJobId = null;
    }
  }
  if (openReviewJobId) {
    const openJob = jobs.find(job => job.id === openReviewJobId);
    if (openJob) {
      const activeReviewInput = reviewDialog?.open
        ? reviewDialog.querySelector("[data-review-editable]:focus")
        : null;
      if (!activeReviewInput) {
        renderReviewDialog(openJob, openReviewFilter);
      }
    } else if (reviewDialog?.open) {
      reviewDialog.close();
      openReviewJobId = null;
      openReviewFilter = "all";
    }
  }
  if (openSnapshotJobId && openSnapshotBatchIndex !== null) {
    const openJob = jobs.find(job => job.id === openSnapshotJobId);
    if (openJob) {
      const activeSnapshotEditor = snapshotDialog?.open
        ? snapshotDialog.querySelector("input:focus, textarea:focus, select:focus")
        : null;
      if (!activeSnapshotEditor) {
        renderSnapshotDialog(openJob, openSnapshotBatchIndex);
      }
    } else if (snapshotDialog?.open) {
      snapshotDialog.close();
      openSnapshotJobId = null;
      openSnapshotBatchIndex = null;
    }
  }
}

async function fetchModelList() {
  saveSettings();
  setModelListStatus("Loading models...", true);
  try {
    const response = await fetch("/api/model/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectSettingsPayload()),
    });
    const data = await response.json();
    remoteModelOptions = Array.isArray(data.models) ? data.models.filter(Boolean) : [];
    renderModelHistory();
    renderModelSelect();
    setModelListStatus(data.message || (data.ok ? "Models loaded." : "Could not load models."), Boolean(data.ok));
  } catch (error) {
    remoteModelOptions = [];
    renderModelHistory();
    renderModelSelect();
    setModelListStatus(error?.message || "Could not load models.", false);
  }
}

async function createJob(event) {
  event.preventDefault();
  saveSettings();
  const data = new FormData();
  const file = fileInput.files[0];
  if (!file) return;
  data.append("file", file);
  for (const element of form.elements) {
    if (!element.id || element.type === "file") continue;
    if (element.type === "checkbox") {
      data.append(element.id, element.checked ? "true" : "false");
    } else {
      data.append(element.id, element.value);
    }
  }

  const response = await fetch("/api/jobs", {
    method: "POST",
    body: data,
  });
  if (!response.ok) {
    alert("Could not create job.");
    return;
  }
  rememberModel(document.getElementById("model")?.value);
  form.reset();
  loadSettings();
  updateSelectedFileLabel();
  updateSelectedTranslatedFileLabel();
  await fetchJobs();
}

async function createReviewJob() {
  saveSettings();
  const sourceFile = fileInput.files[0];
  const translatedFile = translatedFileInput.files[0];
  if (!sourceFile || !translatedFile) {
    alert("Select both source and translated .srt files.");
    return;
  }
  const data = new FormData();
  data.append("source_file", sourceFile);
  data.append("translated_file", translatedFile);
  for (const element of form.elements) {
    if (!element.id || element.type === "file" || element.type === "button") continue;
    if (element.type === "checkbox") {
      data.append(element.id, element.checked ? "true" : "false");
    } else {
      data.append(element.id, element.value);
    }
  }

  const response = await fetch("/api/jobs/review", {
    method: "POST",
    body: data,
  });
  if (!response.ok) {
    alert("Could not create validation review job.");
    return;
  }
  rememberModel(document.getElementById("model")?.value);
  await fetchJobs();
}

async function testConnection() {
  saveSettings();
  rememberModel(modelInput?.value);
  connectionTestResult.textContent = "Testing model connection...";
  const response = await fetch("/api/model/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(collectSettingsPayload()),
  });
  const data = await response.json();
  connectionTestResult.textContent = data.message || (data.ok ? "Connection OK" : "Connection failed");
  connectionTestResult.style.color = data.ok ? "var(--ok)" : "var(--danger)";
}

function setInputFile(input, file) {
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
}

function handleDroppedFiles(files, targetInput = fileInput) {
  if (!files || !files.length) return;
  const file = files[0];
  if (!file.name.toLowerCase().endsWith(".srt")) {
    alert("Only .srt files are supported.");
    return;
  }
  setInputFile(targetInput, file);
  if (targetInput === translatedFileInput) {
    updateSelectedTranslatedFileLabel();
    return;
  }
  updateSelectedFileLabel();
}

function bindDropZone(zone, targetInput) {
  if (!zone) return;
  zone.addEventListener("dragenter", (event) => {
    event.preventDefault();
    zone.classList.add("dragover");
  });
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    zone.classList.add("dragover");
  });
  zone.addEventListener("dragleave", (event) => {
    event.preventDefault();
    if (!zone.contains(event.relatedTarget)) {
      zone.classList.remove("dragover");
    }
  });
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("dragover");
    handleDroppedFiles(event.dataTransfer.files, targetInput);
  });
}

async function performAction(action, jobId, filter = "all") {
  if (action === "delete-job") {
    const response = await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
    if (!response.ok) {
      alert("Could not delete job.");
      return;
    }
    await fetchJobs();
    return;
  }

  if (action === "review-lines") {
    const response = await fetch(`/api/jobs/${jobId}`);
    const job = await response.json();
    openReviewJobId = jobId;
    openReviewFilter = filter || "all";
    renderReviewDialog(job, openReviewFilter);
    reviewDialog.showModal();
    return;
  }

  if (action === "logs") {
    const response = await fetch(`/api/jobs/${jobId}`);
    const job = await response.json();
    openLogJobId = jobId;
    renderLogDialog(job);
    logDialog.showModal();
    return;
  }

  if (action === "edit") {
    const response = await fetch(`/api/jobs/${jobId}`);
    const job = await response.json();
    renderMainContextDialog(job, job.session_context || {});
    dialog.showModal();
    return;
  }

  if (action === "download") {
    const response = await fetch(`/api/jobs/${jobId}/download`);
    if (!response.ok) {
      alert("Translated subtitle is not available.");
      return;
    }
    const data = await response.json();
    const blob = new Blob([data.content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = data.filename;
    link.click();
    URL.revokeObjectURL(url);
    return;
  }

  await fetch(`/api/jobs/${jobId}/${action}`, { method: "POST" });
  await fetchJobs();
}

async function saveReviewedLine(position, resolutionMode = "save") {
  if (!openReviewJobId) return;
  const field = reviewDialogBody.querySelector(`[data-review-input="${position}"]`);
  if (!field) return;
  reviewDrafts.set(`${openReviewJobId}:${position}`, field.value);
  const response = await fetch(`/api/jobs/${openReviewJobId}/lines/${position}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: field.value, resolution_mode: resolutionMode }),
  });
  if (!response.ok) {
    alert("Could not update subtitle line.");
    return;
  }
  const job = await response.json();
  reviewDrafts.delete(`${openReviewJobId}:${position}`);
  renderReviewDialog(job, openReviewFilter);
  await fetchJobs();
}

async function requestLineRetranslation(position) {
  if (!openReviewJobId) return;
  const instructionField = reviewDialogBody.querySelector(`[data-review-instruction="${position}"]`);
  const extraInstruction = instructionField ? instructionField.value : "";
  reviewInstructionDrafts.set(reviewInstructionKey(openReviewJobId, position), extraInstruction);
  const response = await fetch(`/api/jobs/${openReviewJobId}/lines/${position}/retranslate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ extra_instruction: extraInstruction }),
  });
  if (!response.ok) {
    alert("Could not retranslate subtitle line.");
    return;
  }
  const data = await response.json();
  const job = data.job;
  reviewInstructionDrafts.delete(reviewInstructionKey(openReviewJobId, position));
  renderReviewDialog(job, openReviewFilter);
  await fetchJobs();
}

async function saveSnapshotContext() {
  if (!openSnapshotJobId || openSnapshotBatchIndex === null) return;
  const payload = normalizeContextInput(readContextEditor("snapshot", snapshotDialogBody));
  const response = await fetch(`/api/jobs/${openSnapshotJobId}/batch-context/${openSnapshotBatchIndex}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_context: payload }),
  });
  if (!response.ok) {
    alert("Could not update batch card.");
    return;
  }
  const job = await response.json();
  contextEditorDrafts.delete(snapshotDraftKey(openSnapshotJobId, openSnapshotBatchIndex));
  renderSnapshotDialog(job, openSnapshotBatchIndex);
  await fetchJobs();
}

async function generateSnapshotContext() {
  if (!openSnapshotJobId || openSnapshotBatchIndex === null) return;
  generateSnapshotBtn.disabled = true;
  generateSnapshotBtn.textContent = "Generating...";
  const response = await fetch(`/api/jobs/${openSnapshotJobId}/batch-context/${openSnapshotBatchIndex}/generate`, {
    method: "POST",
  });
  generateSnapshotBtn.disabled = false;
  generateSnapshotBtn.textContent = "Generate Card";
  if (!response.ok) {
    alert("Could not generate batch card.");
    return;
  }
  const data = await response.json();
  contextEditorDrafts.set(snapshotDraftKey(openSnapshotJobId, openSnapshotBatchIndex), normalizeContextInput(data.session_context));
  const jobResponse = await fetch(`/api/jobs/${openSnapshotJobId}`);
  const job = await jobResponse.json();
  renderSnapshotDialog(job, openSnapshotBatchIndex);
}

async function clearFinishedJobs() {
  const response = await fetch("/api/jobs", { method: "DELETE" });
  if (!response.ok) {
    alert("Could not clear finished jobs.");
    return;
  }
  await fetchJobs();
}

async function saveEditedContext() {
  if (!editingJobId) return;
  const payload = normalizeContextInput(readContextEditor("main", contextDialogBody));
  const response = await fetch(`/api/jobs/${editingJobId}/context`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_context: payload }),
  });
  if (!response.ok) {
    alert("Could not update context.");
    return;
  }
  contextEditorDrafts.delete(scopeDraftKey("main", editingJobId));
  dialog.close();
  editingJobId = null;
  await fetchJobs();
}

async function generateMainContext() {
  if (!editingJobId) return;
  generateContextBtn.disabled = true;
  generateContextBtn.textContent = "Generating...";
  const response = await fetch(`/api/jobs/${editingJobId}/context/generate`, {
    method: "POST",
  });
  generateContextBtn.disabled = false;
  generateContextBtn.textContent = "Generate Card";
  if (!response.ok) {
    alert("Could not generate context card.");
    return;
  }
  const data = await response.json();
  contextEditorDrafts.set(scopeDraftKey("main", editingJobId), normalizeContextInput(data.session_context));
  const jobResponse = await fetch(`/api/jobs/${editingJobId}`);
  const job = await jobResponse.json();
  renderMainContextDialog(job, data.session_context);
}

document.addEventListener("click", (event) => {
  const workspaceCard = event.target.closest(".job-workspace-link[data-workspace-url]");
  if (workspaceCard && !event.target.closest("button, a, input, textarea, select, summary, label")) {
    window.location.href = workspaceCard.dataset.workspaceUrl;
    return;
  }
  const reviewApply = event.target.closest("[data-review-apply]");
  if (reviewApply) {
    void saveReviewedLine(reviewApply.dataset.reviewApply, reviewApply.dataset.reviewMode || "save");
    return;
  }
  const reviewRemove = event.target.closest("[data-review-remove]");
  if (reviewRemove) {
    const position = reviewRemove.dataset.reviewRemove;
    const field = reviewDialogBody.querySelector(`[data-review-input="${position}"]`);
    if (field) {
      field.value = "";
      reviewDrafts.set(`${openReviewJobId}:${position}`, "");
      syncReviewActionState(position);
    }
    void saveReviewedLine(position, "remove");
    return;
  }
  const reviewRetranslate = event.target.closest("[data-review-retranslate]");
  if (reviewRetranslate) {
    void requestLineRetranslation(reviewRetranslate.dataset.reviewRetranslate);
    return;
  }
  const contextAdd = event.target.closest("[data-context-add]");
  if (contextAdd) {
    addContextRow(contextAdd.dataset.contextScope, contextAdd.dataset.contextAdd, contextAdd.closest("dialog") || document);
    return;
  }
  const contextRemove = event.target.closest("[data-context-remove]");
  if (contextRemove) {
    removeContextRow(contextRemove.dataset.contextScope, contextRemove.dataset.contextRemove, contextRemove);
    return;
  }
  const reviewSnapshot = event.target.closest("[data-review-snapshot]");
  if (reviewSnapshot) {
    if (!openReviewJobId) return;
    const batchIndex = Number(reviewSnapshot.dataset.reviewSnapshot);
    if (!Number.isFinite(batchIndex)) return;
    openSnapshotJobId = openReviewJobId;
    openSnapshotBatchIndex = batchIndex;
    void fetch(`/api/jobs/${openReviewJobId}`)
      .then(response => response.json())
      .then(job => {
        renderSnapshotDialog(job, batchIndex);
        snapshotDialog.showModal();
      });
    return;
  }
  const reviewFilter = event.target.closest("[data-review-filter]");
  if (reviewFilter) {
    if (!openReviewJobId) return;
    openReviewFilter = reviewFilter.dataset.reviewFilter || "all";
    void fetch(`/api/jobs/${openReviewJobId}`)
      .then(response => response.json())
      .then(job => renderReviewDialog(job, openReviewFilter));
    return;
  }
  const detailTrigger = event.target.closest("[data-detail-trigger]");
  if (detailTrigger) {
    detailDialogTitle.textContent = detailTrigger.dataset.detailTitle || "Details";
    detailDialogBody.textContent = detailTrigger.dataset.detailBody || "";
    detailDialog.showModal();
    return;
  }
  const button = event.target.closest("[data-action]");
  if (!button) return;
  void performAction(button.dataset.action, button.dataset.id, button.dataset.filter || "all");
});

document.addEventListener("input", (event) => {
  const reviewInput = event.target.closest("[data-review-input]");
  if (reviewInput && openReviewJobId) {
    reviewDrafts.set(`${openReviewJobId}:${reviewInput.dataset.reviewInput}`, reviewInput.value);
    syncReviewActionState(reviewInput.dataset.reviewInput);
    return;
  }
  const instructionInput = event.target.closest("[data-review-instruction]");
  if (instructionInput && openReviewJobId) {
    reviewInstructionDrafts.set(
      reviewInstructionKey(openReviewJobId, instructionInput.dataset.reviewInstruction),
      instructionInput.value,
    );
    return;
  }
  const contextField = event.target.closest("[data-context-field], [data-context-character], [data-context-glossary]");
  if (contextField) {
    const root = contextField.closest("dialog") || document;
    const scope = root === snapshotDialog ? "snapshot" : "main";
    const draft = normalizeContextInput(readContextEditor(scope, root));
    if (scope === "snapshot" && openSnapshotJobId && openSnapshotBatchIndex !== null) {
      contextEditorDrafts.set(snapshotDraftKey(openSnapshotJobId, openSnapshotBatchIndex), draft);
      syncContextPreview("snapshot", snapshotDialogBody);
      return;
    }
    if (scope === "main" && editingJobId) {
      contextEditorDrafts.set(scopeDraftKey("main", editingJobId), draft);
      syncContextPreview("main", contextDialogBody);
    }
  }
});

form.addEventListener("submit", createJob);
refreshBtn.addEventListener("click", () => void fetchJobs());
clearFinishedBtn?.addEventListener("click", () => void clearFinishedJobs());
saveContextBtn.addEventListener("click", () => void saveEditedContext());
generateContextBtn?.addEventListener("click", () => void generateMainContext());
saveSnapshotBtn?.addEventListener("click", () => void saveSnapshotContext());
generateSnapshotBtn?.addEventListener("click", () => void generateSnapshotContext());
testConnectionBtn.addEventListener("click", () => void testConnection());
logDialog?.addEventListener("close", () => {
  openLogJobId = null;
});
reviewDialog?.addEventListener("close", () => {
  if (openReviewJobId) {
    for (const key of Array.from(reviewDrafts.keys())) {
      if (key.startsWith(`${openReviewJobId}:`)) {
        reviewDrafts.delete(key);
      }
    }
    for (const key of Array.from(reviewInstructionDrafts.keys())) {
      if (key.startsWith(`${openReviewJobId}:`)) {
        reviewInstructionDrafts.delete(key);
      }
    }
  }
  openReviewJobId = null;
  openReviewFilter = "all";
});
snapshotDialog?.addEventListener("close", () => {
  if (openSnapshotJobId && openSnapshotBatchIndex !== null) {
    contextEditorDrafts.delete(snapshotDraftKey(openSnapshotJobId, openSnapshotBatchIndex));
  }
  openSnapshotJobId = null;
  openSnapshotBatchIndex = null;
});
dialog?.addEventListener("close", () => {
  if (editingJobId) {
    contextEditorDrafts.delete(scopeDraftKey("main", editingJobId));
  }
  editingJobId = null;
});
fileInput.addEventListener("change", updateSelectedFileLabel);
translatedFileInput.addEventListener("change", updateSelectedTranslatedFileLabel);
modelInput.addEventListener("change", () => rememberModel(modelInput.value));
modelSelect.addEventListener("change", () => {
  if (!modelSelect.value) return;
  modelInput.value = modelSelect.value;
  rememberModel(modelSelect.value);
  renderModelHistory();
  renderModelSelect();
});
loadModelsBtn.addEventListener("click", () => void fetchModelList());
reviewExistingBtn.addEventListener("click", () => void createReviewJob());
bindDropZone(dropZone, fileInput);
bindDropZone(translatedDropZone, translatedFileInput);

loadSettings();
renderModelHistory();
renderModelSelect();
updateSelectedFileLabel();
updateSelectedTranslatedFileLabel();
requestAnimationFrame(() => {
  document.body.classList.add("page-ready");
});
void fetchModelList();
fetchJobs();
setInterval(fetchJobs, 2500);
