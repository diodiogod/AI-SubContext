const titleEl = document.getElementById("review-page-title");
const metaEl = document.getElementById("review-page-meta");
const progressCardEl = document.getElementById("review-progress-card");
const progressStatusEl = document.getElementById("review-progress-status");
const progressValueEl = document.getElementById("review-progress-value");
const progressBarEl = document.getElementById("review-progress-bar");
const refreshBtn = document.getElementById("review-page-refresh");
const filtersEl = document.getElementById("review-page-filters");
const searchEl = document.getElementById("review-search");
const prevFlaggedBtn = document.getElementById("review-prev-flagged");
const nextFlaggedBtn = document.getElementById("review-next-flagged");
const autoRewriteNextBtn = document.getElementById("review-auto-rewrite-next");
const summaryEl = document.getElementById("review-table-summary");
const tableBody = document.getElementById("review-table-body");
const tableEl = document.querySelector(".review-table");
const tableHeader = document.getElementById("review-table-header");
const tableColumns = document.getElementById("review-table-columns");
const columnControls = document.getElementById("review-column-controls");
const columnResetBtn = document.getElementById("review-column-reset");
const sideBody = document.getElementById("review-side-body");
const snapshotDialog = document.getElementById("review-snapshot-dialog");
const snapshotTitle = document.getElementById("review-snapshot-title");
const snapshotBody = document.getElementById("review-snapshot-body");
const saveSnapshotBtn = document.getElementById("review-save-snapshot");
const generateSnapshotBtn = document.getElementById("review-generate-snapshot");

const jobId = window.location.pathname.split("/").filter(Boolean).pop();
const REVIEW_SCROLL_STATE_KEY = `ai-subcontext-review-scroll-state:${jobId}`;
const REVIEW_UI_STATE_KEY = `ai-subcontext-review-ui-state:${jobId}`;
const REVIEW_COLUMN_STATE_KEY = "ai-subcontext-review-columns:v2";
const REVIEW_COLUMN_DEFINITIONS = {
  line: { label: "Line", width: 56, visible: true },
  status: { label: "Status", width: 88, visible: true },
  reason: { label: "Reason", width: 122, visible: true },
  subtitle: { label: "Subtitle", width: 560, visible: true },
  source: { label: "Source", width: 300, visible: false },
  translation: { label: "Translation", width: 340, visible: false },
  time: { label: "Time", width: 170, visible: false },
  refs: { label: "Refs", width: 150, visible: false },
  batch: { label: "Batch", width: 72, visible: false },
};
const DEFAULT_REVIEW_COLUMN_ORDER = ["line", "status", "reason", "subtitle", "source", "translation", "time", "refs", "batch"];
let currentJob = null;
let currentFilter = "all";
let currentSearch = "";
let selectedPosition = null;
let openBatchIndex = null;
let autoRewritePending = false;
let autoRewriteAbort = false;
const transientSuspectResolved = new Set();
const selectedPositions = new Set();
let selectionAnchorPosition = null;
const lineDrafts = new Map();
const instructionDrafts = new Map();
const contextDrafts = new Map();
let reviewScrollRestorePending = true;
let reviewScrollSaveFrame = null;
let reviewUiRestorePending = true;
let reviewUiSaveFrame = null;
let reviewColumnState = loadReviewColumnState();
let resizingColumn = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseSubtitleFormatting(value) {
  const raw = String(value ?? "");
  const tagPattern = /<[^>]*>/g;
  const stack = [];
  const html = [];
  let cursor = 0;
  let formatted = false;

  const fail = () => ({ valid: false, formatted: true, html: escapeHtml(raw) });
  for (const match of raw.matchAll(tagPattern)) {
    html.push(escapeHtml(raw.slice(cursor, match.index)));
    cursor = Number(match.index) + match[0].length;
    const tag = match[0];
    const closeMatch = tag.match(/^<\/\s*(font|b|i|u)\s*>$/i);
    if (closeMatch) {
      const name = closeMatch[1].toLowerCase();
      if (stack.pop() !== name) return fail();
      html.push(name === "font" ? "</span>" : `</${name}>`);
      formatted = true;
      continue;
    }

    const simpleOpen = tag.match(/^<\s*(b|i|u)\s*>$/i);
    if (simpleOpen) {
      const name = simpleOpen[1].toLowerCase();
      stack.push(name);
      html.push(`<${name}>`);
      formatted = true;
      continue;
    }

    const fontOpen = tag.match(/^<\s*font\b([^>]*)>$/i);
    if (!fontOpen) return fail();
    const attributes = fontOpen[1];
    const attributePattern = /\s+([a-z][\w-]*)\s*=\s*("[^"]*"|'[^']*')/gi;
    const styles = [];
    let consumed = "";
    for (const attribute of attributes.matchAll(attributePattern)) {
      consumed += attribute[0];
      const name = attribute[1].toLowerCase();
      const attrValue = attribute[2].slice(1, -1).trim();
      if (name === "color" && /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(attrValue)) {
        styles.push(`color:${attrValue}`);
      } else if (name === "face" && /^[a-z0-9 ,_-]{1,80}$/i.test(attrValue)) {
        styles.push(`font-family:${attrValue}`);
      } else if (name === "size" && /^[1-7]$/.test(attrValue)) {
        const scale = ["", "0.72em", "0.84em", "1em", "1.18em", "1.36em", "1.58em", "1.82em"];
        styles.push(`font-size:${scale[Number(attrValue)]}`);
      } else {
        return fail();
      }
    }
    if (consumed.trim() !== attributes.trim()) return fail();
    stack.push("font");
    html.push(`<span class="subtitle-font-span"${styles.length ? ` style="${styles.join(";")}"` : ""}>`);
    formatted = true;
  }

  html.push(escapeHtml(raw.slice(cursor)));
  const textOutsideCompleteTags = raw.replace(/<[^>]*>/g, "");
  if (
    stack.length
    || /<\/?\s*(?:font|b|i|u)\b/i.test(textOutsideCompleteTags)
    || /\[+\s*(?:SUBF[A-Z]*|SUBBR)_\d+/i.test(raw)
  ) return fail();
  return { valid: true, formatted, html: html.join("") };
}

function renderSubtitlePreview(value, { compact = false } = {}) {
  const raw = String(value ?? "");
  const parsed = parseSubtitleFormatting(raw);
  if (!parsed.valid) {
    return `
      <div class="subtitle-preview is-broken ${compact ? "compact" : ""}">
        <span class="subtitle-format-warning">broken formatting</span>
        <code>${escapeHtml(raw)}</code>
      </div>
    `;
  }
  return `
    <div class="subtitle-preview ${parsed.formatted ? "is-formatted" : "is-plain"} ${compact ? "compact" : ""}">
      ${parsed.html}
    </div>
  `;
}

function defaultReviewColumnState() {
  return DEFAULT_REVIEW_COLUMN_ORDER.map(key => ({
    key,
    width: REVIEW_COLUMN_DEFINITIONS[key].width,
    visible: REVIEW_COLUMN_DEFINITIONS[key].visible,
  }));
}

function loadReviewColumnState() {
  try {
    const saved = JSON.parse(localStorage.getItem(REVIEW_COLUMN_STATE_KEY) || "null");
    if (!Array.isArray(saved)) return defaultReviewColumnState();
    const byKey = new Map(saved.map(item => [String(item?.key || ""), item]));
    const orderedKeys = [
      ...saved.map(item => String(item?.key || "")).filter(key => REVIEW_COLUMN_DEFINITIONS[key]),
      ...DEFAULT_REVIEW_COLUMN_ORDER.filter(key => !byKey.has(key)),
    ];
    return [...new Set(orderedKeys)].map(key => {
      const item = byKey.get(key) || {};
      const definition = REVIEW_COLUMN_DEFINITIONS[key];
      return {
        key,
        width: Math.max(48, Math.min(720, Number(item.width) || definition.width)),
        visible: item.visible === undefined ? definition.visible : Boolean(item.visible),
      };
    });
  } catch (_) {
    return defaultReviewColumnState();
  }
}

function saveReviewColumnState() {
  localStorage.setItem(REVIEW_COLUMN_STATE_KEY, JSON.stringify(reviewColumnState));
}

function visibleReviewColumns() {
  return reviewColumnState.filter(column => column.visible);
}

function renderColumnControls() {
  if (!columnControls) return;
  columnControls.innerHTML = reviewColumnState.map(column => `
    <label>
      <input type="checkbox" data-column-visible="${escapeHtml(column.key)}" ${column.visible ? "checked" : ""} />
      <span>${escapeHtml(REVIEW_COLUMN_DEFINITIONS[column.key].label)}</span>
    </label>
  `).join("");
}

function renderTableStructure() {
  const columns = visibleReviewColumns();
  if (tableColumns) {
    tableColumns.innerHTML = columns.map(column => (
      `<col data-column="${escapeHtml(column.key)}" style="width:${column.width}px" />`
    )).join("");
  }
  if (tableHeader) {
    tableHeader.innerHTML = columns.map(column => `
      <th draggable="true" data-column-header="${escapeHtml(column.key)}" title="Drag to reorder">
        <span>${escapeHtml(REVIEW_COLUMN_DEFINITIONS[column.key].label)}</span>
        <span class="review-column-resizer" data-column-resize="${escapeHtml(column.key)}" title="Drag to resize"></span>
      </th>
    `).join("");
  }
  if (tableEl) {
    const totalWidth = columns.reduce((total, column) => total + column.width, 0);
    tableEl.style.minWidth = `${Math.max(520, totalWidth)}px`;
  }
  renderColumnControls();
}

function readScrollState(storageKey) {
  const raw = sessionStorage.getItem(storageKey);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

function writeScrollState(storageKey, state) {
  sessionStorage.setItem(storageKey, JSON.stringify(state));
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
  sessionStorage.setItem(storageKey, JSON.stringify(state));
}

function parseStoredNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseStoredPositiveNumber(value) {
  const numeric = parseStoredNumber(value);
  return numeric !== null && numeric > 0 ? numeric : null;
}

function reviewScrollContainer() {
  return document.querySelector(".review-table-wrap");
}

function saveReviewScrollState() {
  const tableWrap = reviewScrollContainer();
  writeScrollState(REVIEW_SCROLL_STATE_KEY, {
    windowScrollTop: window.scrollY || 0,
    tableScrollTop: tableWrap?.scrollTop || 0,
  });
}

function scheduleReviewScrollSave() {
  if (reviewScrollSaveFrame !== null) return;
  reviewScrollSaveFrame = requestAnimationFrame(() => {
    reviewScrollSaveFrame = null;
    saveReviewScrollState();
  });
}

function restoreReviewScrollState() {
  if (!reviewScrollRestorePending) return;
  reviewScrollRestorePending = false;
  const state = readScrollState(REVIEW_SCROLL_STATE_KEY);
  if (!state) return;
  const tableWrap = reviewScrollContainer();
  window.scrollTo({ top: Number(state.windowScrollTop || 0), behavior: "auto" });
  if (tableWrap) {
    tableWrap.scrollTop = Number(state.tableScrollTop || 0);
  }
}

function captureReviewUiState() {
  return {
    windowScrollTop: window.scrollY || 0,
    tableScrollTop: reviewScrollContainer()?.scrollTop || 0,
    currentFilter,
    currentSearch,
    selectedPosition,
    selectedPositions: [...selectedPositions],
    selectionAnchorPosition,
    openBatchIndex,
    lineDrafts: [...lineDrafts.entries()],
    instructionDrafts: [...instructionDrafts.entries()],
    contextDrafts: [...contextDrafts.entries()],
  };
}

function saveReviewUiState() {
  writeSessionState(REVIEW_UI_STATE_KEY, captureReviewUiState());
}

function scheduleReviewUiSave() {
  if (reviewUiSaveFrame !== null) return;
  reviewUiSaveFrame = requestAnimationFrame(() => {
    reviewUiSaveFrame = null;
    saveReviewUiState();
  });
}

function restoreReviewUiState() {
  if (!reviewUiRestorePending) return;
  reviewUiRestorePending = false;
  const state = readSessionState(REVIEW_UI_STATE_KEY);
  if (!state) return;
  currentFilter = state.currentFilter || "all";
  currentSearch = state.currentSearch || "";
  if (searchEl) searchEl.value = currentSearch;
  selectedPosition = parseStoredNumber(state.selectedPosition);
  selectedPositions.clear();
  for (const value of Array.isArray(state.selectedPositions) ? state.selectedPositions : []) {
    const position = Number(value);
    if (Number.isFinite(position)) selectedPositions.add(position);
  }
  selectionAnchorPosition = parseStoredNumber(state.selectionAnchorPosition);
  openBatchIndex = parseStoredPositiveNumber(state.openBatchIndex);
  lineDrafts.clear();
  for (const [key, value] of Array.isArray(state.lineDrafts) ? state.lineDrafts : []) {
    lineDrafts.set(key, value);
  }
  instructionDrafts.clear();
  for (const [key, value] of Array.isArray(state.instructionDrafts) ? state.instructionDrafts : []) {
    instructionDrafts.set(key, value);
  }
  contextDrafts.clear();
  for (const [key, value] of Array.isArray(state.contextDrafts) ? state.contextDrafts : []) {
    contextDrafts.set(key, value);
  }
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

function statusBadge(status) {
  const label = {
    normal: "Ready",
    pending: "Pending",
    translating: "Translating",
    provisional: "Provisional",
    retrying: "Retrying",
    missing: "Missing",
    suspect: "Check",
    error: "Error",
    auto_fixed: "Auto Fixed",
    manual_fixed: "Edited",
  }[status] || status;
  return `<span class="badge ${escapeHtml(status)}">${escapeHtml(label)}</span>`;
}

function formatProgress(value) {
  const numeric = Number.isFinite(Number(value)) ? Number(value) : 0;
  const bounded = Math.max(0, Math.min(100, numeric));
  return `${Math.round(bounded)}%`;
}

function tooltipTag(label, tooltip, className = "inline-badge") {
  return `<span class="${className} tooltip-tag" title="${escapeHtml(tooltip)}">${escapeHtml(label)}</span>`;
}

function compactReasonLabel(reason) {
  return {
    source_leak: "Source Leak",
    source_language_leak: "Source Leak",
    missing_output: "Missing Output",
    extra_output: "Extra Output",
    unchanged: "Unchanged",
    unchanged_from_source: "Unchanged",
    manual: "Manual",
    manual_fix: "Manual",
    manual_retranslation: "Manual Retry",
    retry_fixed: "Retry Fixed",
    isolated_retry: "Retry Fixed",
    validator_language_mismatch: "Lang Mismatch",
    formatting_mismatch: "Formatting",
    boundary_drift: "Boundary",
    boundary_sequence_drift: "Cue Shift",
    other: "Other",
  }[reason] || "Other";
}

function formatConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "0%";
  return `${Math.round(Math.max(0, Math.min(1, numeric)) * 100)}%`;
}

function buildReferenceMap(job) {
  const map = new Map();
  const tracks = Array.isArray(job?.reference_tracks) ? job.reference_tracks : [];
  for (const track of tracks) {
    const language = String(track?.language || "").trim() || "ref";
    const filename = String(track?.filename || "reference.srt").trim() || "reference.srt";
    const alignmentMode = String(track?.alignment_mode || "timestamp");
    const alignedLines = Array.isArray(track?.aligned_lines) ? track.aligned_lines : [];
    for (const item of alignedLines) {
      const position = Number(item?.position);
      if (!Number.isFinite(position)) continue;
      const entry = {
        language,
        filename,
        alignment_mode: alignmentMode,
        text: String(item?.text || ""),
        confidence: Number(item?.confidence || 0),
        matched_positions: Array.isArray(item?.matched_positions) ? item.matched_positions.map(value => Number(value)).filter(Number.isFinite) : [],
        start_time: String(item?.start_time || ""),
        end_time: String(item?.end_time || ""),
      };
      map.set(position, [...(map.get(position) || []), entry]);
    }
  }
  for (const [position, references] of map.entries()) {
    map.set(position, references.sort((a, b) => (b.confidence || 0) - (a.confidence || 0)));
  }
  return map;
}

function summarizeReferenceInline(references) {
  if (!references.length) return `<span class="job-meta">-</span>`;
  if (references.length === 1) {
    const [reference] = references;
    return `<span class="job-fact">${escapeHtml(reference.language.toUpperCase())} ${escapeHtml(formatConfidence(reference.confidence))}</span>`;
  }
  const average = references.reduce((sum, item) => sum + Number(item.confidence || 0), 0) / references.length;
  return `<span class="job-fact">${escapeHtml(String(references.length))} refs • ${escapeHtml(formatConfidence(average))}</span>`;
}

function formatMatchedPositions(positions) {
  const values = (positions || []).map(value => Number(value)).filter(Number.isFinite);
  if (!values.length) return "n/a";
  if (values.length === 1) return String(values[0] + 1);
  return `${values[0] + 1}-${values[values.length - 1] + 1}`;
}

function renderReferenceLines(references) {
  if (!references.length) {
    return `
      <div class="review-source-block">
        <div class="mini-eyebrow">Reference Lines</div>
        <p>No aligned reference subtitles for this line.</p>
      </div>
    `;
  }
  return `
    <div class="review-source-block">
      <div class="mini-eyebrow">Reference Lines</div>
      <div class="reference-line-list">
        ${references.map(reference => `
          <article class="reference-line-card">
            <div class="reference-line-meta">
              <span class="job-fact">${escapeHtml(reference.language.toUpperCase())}</span>
              <span class="job-fact">Confidence ${escapeHtml(formatConfidence(reference.confidence))}</span>
              <span class="job-fact">Ref line ${escapeHtml(formatMatchedPositions(reference.matched_positions))}</span>
              <span class="job-fact">${escapeHtml(reference.alignment_mode)}</span>
              ${(reference.start_time && reference.end_time) ? `<span class="job-fact">${escapeHtml(`${reference.start_time} - ${reference.end_time}`)}</span>` : ""}
            </div>
            <div class="reference-line-copy">${escapeHtml(reference.text || "")}</div>
            <div class="job-meta">${escapeHtml(reference.filename)}</div>
          </article>
        `).join("")}
      </div>
    </div>
  `;
}

function inferReasonTags(issue) {
  const notes = Array.isArray(issue?.notes) ? issue.notes : [];
  const joined = notes.join(" ").toLowerCase();
  const tags = [];
  if (joined.includes("source language") || joined.includes("detected output language")) tags.push("source_leak");
  if (joined.includes("missing translated subtitle") || joined.includes("missing output") || joined.includes("extra subtitle lines")) tags.push("missing_output");
  if (joined.includes("unchanged from source") || joined.includes("same as source") || joined.includes("unchanged")) tags.push("unchanged");
  if (joined.includes("manually updated") || joined.includes("review panel") || joined.includes("confirmed as correct")) tags.push("manual");
  if (joined.includes("validation cleared after retry") || joined.includes("isolated retry fixed") || joined.includes("stricter instruction")) tags.push("retry_fixed");
  if (joined.includes("formatting was missing") || joined.includes("formatting mismatch")) tags.push("formatting_mismatch");
  if (joined.includes("shifted into a neighboring") || joined.includes("neighboring-cue")) tags.push("boundary_sequence_drift");
  else if (joined.includes("subtitle boundary")) tags.push("boundary_drift");
  if (!tags.length && notes.length) tags.push("other");
  return [...new Set(tags)];
}

function renderReasonTags(tags) {
  if (!tags.length) return `<span class="job-meta">-</span>`;
  return tags.map(tag => `<span class="reason-tag reason-${escapeHtml(tag)}">${escapeHtml(compactReasonLabel(tag))}</span>`).join("");
}

function renderSessionSnapshot(snapshot, compact = false) {
  if (!snapshot) {
    return `<div class="tile"><div class="mini-eyebrow">No Card</div><p>No context available.</p></div>`;
  }
  const characters = (snapshot.characters || []).slice(0, compact ? 6 : 12);
  const glossary = (snapshot.glossary || []).slice(0, compact ? 4 : 8);
  const styleNotes = (snapshot.style_notes || []).slice(0, compact ? 4 : 8);
  const ambiguities = snapshot.unresolved_ambiguities || [];
  return `
    <div class="context-card">
      ${snapshot.premise ? `<div class="tile"><div class="mini-eyebrow">Whole Movie Premise</div><p>${escapeHtml(snapshot.premise)}</p></div>` : ""}
      ${snapshot.tone ? `<div class="tile"><div class="mini-eyebrow">Tone</div><p>${escapeHtml(snapshot.tone)}</p></div>` : ""}
      ${snapshot.scene_context ? `<div class="scene"><div class="mini-eyebrow">Scene</div><div>${escapeHtml(snapshot.scene_context)}</div></div>` : ""}
      ${styleNotes.length ? `<div class="tile"><div class="mini-eyebrow">Style Notes</div><ul>${styleNotes.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : ""}
      ${characters.length ? `
        <div>
          <div class="mini-eyebrow">Characters</div>
          <div class="grid grid-characters">
            ${characters.map(character => `
              <div class="tile tile-fixed">
                <h4>
                  <span class="tile-title-text">${escapeHtml(character.name || "Unnamed")}</span>
                  ${character.gender && character.gender !== "unknown" ? tooltipTag(String(character.gender).toUpperCase(), "Character metadata stored in this card.") : ""}
                </h4>
                <p class="tile-copy">${escapeHtml(character.role || "No role summary yet.")}</p>
                ${(character.aliases || []).length ? `<div class="chip-row">${character.aliases.map(alias => tooltipTag(alias, "Known alias.", "chip")).join("")}</div>` : ""}
              </div>
            `).join("")}
          </div>
        </div>
      ` : ""}
      ${glossary.length ? `
        <div>
          <div class="mini-eyebrow">Glossary</div>
          <div class="grid grid-glossary">
            ${glossary.map(entry => `
              <div class="tile tile-fixed">
                <h4>
                  <span class="tile-title-text">${escapeHtml(entry.term || "Untitled term")}</span>
                  ${entry.keep ? tooltipTag("Keep", "Preserve this term as written.") : ""}
                </h4>
                <p class="tile-copy">${escapeHtml(entry.meaning || "No glossary note yet.")}</p>
              </div>
            `).join("")}
          </div>
        </div>
      ` : ""}
      ${ambiguities.length ? `<div class="tile"><div class="mini-eyebrow">Ambiguities</div><ul>${ambiguities.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : ""}
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

function renderContextEditor(scope, context, meta = "") {
  const normalized = normalizeContextInput(context);
  return `
    ${meta}
    <div class="context-editor-grid">
      <section class="context-editor-form">
        <div class="field-grid field-grid-primary">
          <input type="hidden" data-context-field="movie_title" data-context-scope="${escapeHtml(scope)}" value="${escapeHtml(normalized.movie_title || "")}" />
          <input type="hidden" data-context-field="media_type" data-context-scope="${escapeHtml(scope)}" value="${escapeHtml(normalized.media_type || "Movie")}" />
          <input type="hidden" data-context-field="source_language" data-context-scope="${escapeHtml(scope)}" value="${escapeHtml(normalized.source_language || "")}" />
          <input type="hidden" data-context-field="target_language" data-context-scope="${escapeHtml(scope)}" value="${escapeHtml(normalized.target_language || "")}" />
          <label class="field-span-full">
            <span class="label-row">Whole Movie Premise</span>
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
            ${normalized.characters.length ? normalized.characters.map((item, index) => renderCharacterEditorRow(scope, item, index)).join("") : `<p class="job-meta">No characters yet.</p>`}
          </div>
        </section>
        <section class="editor-section">
          <div class="editor-section-head">
            <div class="mini-eyebrow">Glossary</div>
            <button type="button" class="ghost small" data-context-add="glossary" data-context-scope="${escapeHtml(scope)}">Add Term</button>
          </div>
          <div class="editor-list" data-context-list="glossary" data-context-scope="${escapeHtml(scope)}">
            ${normalized.glossary.length ? normalized.glossary.map((item, index) => renderGlossaryEditorRow(scope, item, index)).join("") : `<p class="job-meta">No glossary terms yet.</p>`}
          </div>
        </section>
      </section>
      <section class="context-editor-preview">
        <div class="mini-eyebrow">Live Preview</div>
        <div id="context-preview-${escapeHtml(scope)}" class="snapshot-preview">
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
      aliases: String(item.querySelector('[data-context-character="aliases"]')?.value || "").split(",").map(value => value.trim()).filter(Boolean),
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

function deriveBatchInfo(job, batchIndex) {
  const snapshots = Array.isArray(job?.batch_context_snapshots) ? job.batch_context_snapshots : [];
  const existing = snapshots.find(item => Number(item.batch_index) === Number(batchIndex));
  if (existing) {
    return {
      batch_index: Number(batchIndex),
      start_position: Number(existing.start_position),
      end_position: Number(existing.end_position),
      input_context: existing.input_context || null,
      output_context: existing.output_context || null,
      has_snapshot: true,
    };
  }
  const batchSize = Number(job?.settings?.batch_size || 0);
  const lines = Array.isArray(job?.original_lines) ? job.original_lines : [];
  if (!batchSize || batchIndex <= 0) return null;
  const start = (batchIndex - 1) * batchSize;
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

function lineStatus(job, issue, position, translatedMap) {
  const activePositions = new Set((job.active_batch_positions || []).map(Number));
  const recoveryPositions = new Set((job.active_recovery_positions || []).map(Number));
  if (recoveryPositions.has(position) && (!issue || issue.status === "suspect")) return "retrying";
  if (issue) return issue.status || "suspect";
  if (activePositions.has(position)) {
    return translatedMap.has(position) ? "provisional" : "translating";
  }
  if (translatedMap.has(position)) return "normal";
  const batchIndex = lineBatchIndex(job, null, position);
  if (batchIndex <= Number(job.current_batch || 0)) return "missing";
  return "pending";
}

function lineBatchIndex(job, issue, position) {
  if (issue?.batch_index) return Number(issue.batch_index);
  const batchSize = Number(job?.settings?.batch_size || 1);
  return Math.floor(position / batchSize) + 1;
}

function lineKey(position) {
  return `${jobId}:${position}`;
}

function getLines(job) {
  const translatedMap = new Map((job.translated_lines || []).map(line => [Number(line.position), line.text || ""]));
  const issueMap = new Map((job.validation_issues || []).map(issue => [Number(issue.position), issue]));
  const referenceMap = buildReferenceMap(job);
  return (job.original_lines || []).map(line => {
    const position = Number(line.position);
    const issue = issueMap.get(position) || null;
    const status = lineStatus(job, issue, position, translatedMap);
    const reasonTags = Array.isArray(issue?.reason_codes) && issue.reason_codes.length
      ? [...new Set(issue.reason_codes.map(code => String(code || "").trim()).filter(Boolean))]
      : inferReasonTags(issue);
    const references = referenceMap.get(position) || [];
    return {
      position,
      source_text: line.text || "",
      start_time: line.start_time || "",
      end_time: line.end_time || "",
      translated_text: translatedMap.get(position) || "",
      reference_subtitles: references,
      issue,
      status,
      reason_tags: reasonTags,
      batch_index: lineBatchIndex(job, issue, position),
    };
  });
}

function filteredLines(job) {
  const lines = getLines(job);
  return lines.filter(line => {
    if (currentFilter === "suspect") {
      const transientResolved = transientSuspectResolved.has(line.position)
        && ["auto_fixed", "manual_fixed"].includes(line.status);
      if (line.status !== "suspect" && !transientResolved) return false;
    }
    if (currentFilter === "error" && line.status !== "error") return false;
    if (currentFilter === "fixed" && !["auto_fixed", "manual_fixed"].includes(line.status)) return false;
    if (currentFilter === "edited" && line.status !== "manual_fixed") return false;
    if (currentFilter === "active" && !["translating", "provisional", "retrying"].includes(line.status)) return false;
    if (currentFilter === "pending" && line.status !== "pending") return false;
    if (currentFilter === "missing" && line.status !== "missing" && !line.reason_tags.includes("missing_output")) return false;
    if (currentFilter === "normal" && line.status !== "normal") return false;
    if (currentSearch) {
      const haystack = [
        line.source_text,
        lineDrafts.get(lineKey(line.position)) ?? line.translated_text,
        line.status,
        ...line.reason_tags.map(compactReasonLabel),
        ...line.reference_subtitles.map(item => [item.language, item.filename, item.text, item.alignment_mode].join(" ")),
      ].join("\n").toLowerCase();
      if (!haystack.includes(currentSearch.toLowerCase())) return false;
    }
    return true;
  });
}

function countFilters(job) {
  const lines = getLines(job);
  return {
    all: lines.length,
    suspect: lines.filter(line => line.status === "suspect").length,
    error: lines.filter(line => line.status === "error").length,
    fixed: lines.filter(line => ["auto_fixed", "manual_fixed"].includes(line.status)).length,
    edited: lines.filter(line => line.status === "manual_fixed").length,
    active: lines.filter(line => ["translating", "provisional", "retrying"].includes(line.status)).length,
    pending: lines.filter(line => line.status === "pending").length,
    missing: lines.filter(line => line.status === "missing" || line.reason_tags.includes("missing_output")).length,
    normal: lines.filter(line => line.status === "normal").length,
  };
}

function renderFilters(job) {
  const counts = countFilters(job);
  const names = [
    ["all", "All"],
    ["suspect", "Suspect"],
    ["error", "Error"],
    ["fixed", "Fixed"],
    ["edited", "Edited"],
    ["active", "Active"],
    ["pending", "Pending"],
    ["missing", "Missing"],
    ["normal", "Normal"],
  ];
  filtersEl.innerHTML = names.map(([key, label]) => `
    <button
      type="button"
      class="review-filter filter-${escapeHtml(key)} ${currentFilter === key ? "is-active" : ""}"
      data-filter="${escapeHtml(key)}"
    >
      ${escapeHtml(label)} (${escapeHtml(String(counts[key] || 0))})
    </button>
  `).join("");
}

function clearTransientSuspectResolved() {
  transientSuspectResolved.clear();
}

function updateToolbarState(job) {
  if (!autoRewriteNextBtn) return;
  const flaggedCount = filteredLines(job)
    .filter(line => line.status === "suspect" || line.status === "error")
    .length;
  autoRewriteNextBtn.disabled = autoRewritePending || !flaggedCount;
  autoRewriteNextBtn.disabled = !autoRewritePending && !flaggedCount;
  autoRewriteNextBtn.textContent = autoRewritePending ? "Stop Auto Rewrite" : "Auto Rewrite All";
}

function renderReviewTableCell(columnKey, line, translated, timeLabel) {
  const emptyTranslation = `<span>${line.status === "pending" ? "Waiting for translation" : (line.status === "translating" ? "Model is translating this line" : "No translation returned")}</span>`;
  const content = {
    line: escapeHtml(String(line.position + 1)),
    time: `<div class="table-time">${escapeHtml(timeLabel)}</div>`,
    status: statusBadge(line.status),
    reason: `<div class="table-reasons">${renderReasonTags(line.reason_tags)}</div>`,
    subtitle: `
      <div class="stacked-subtitle-pair">
        <div class="stacked-subtitle-part source">
          <span class="stacked-subtitle-label">Source</span>
          ${renderSubtitlePreview(line.source_text, { compact: true })}
        </div>
        <div class="stacked-subtitle-part translation ${translated ? "" : "is-empty"}">
          <span class="stacked-subtitle-label">Translation</span>
          ${translated ? renderSubtitlePreview(translated, { compact: true }) : emptyTranslation}
        </div>
      </div>
    `,
    source: `<div class="table-copy">${renderSubtitlePreview(line.source_text, { compact: true })}</div>`,
    translation: `<div class="table-copy ${translated ? "" : "is-empty"}">${
      translated
        ? renderSubtitlePreview(translated, { compact: true })
        : emptyTranslation
    }</div>`,
    refs: `<div class="table-reference-summary">${summarizeReferenceInline(line.reference_subtitles)}</div>`,
    batch: escapeHtml(String(line.batch_index)),
  }[columnKey] ?? "";
  return `<td data-column-cell="${escapeHtml(columnKey)}">${content}</td>`;
}

function renderTable(job) {
  renderTableStructure();
  const columns = visibleReviewColumns();
  const rows = filteredLines(job);
  const linesWithReferences = rows.filter(line => line.reference_subtitles.length).length;
  summaryEl.textContent = `${rows.length} line(s) visible${linesWithReferences ? ` • ${linesWithReferences} with references` : ""}`;
  if (!rows.length) {
    tableBody.innerHTML = `<tr><td colspan="${Math.max(1, columns.length)}" class="job-meta">No lines in this filter.</td></tr>`;
    return;
  }
  if (!rows.some(line => line.position === selectedPosition)) {
    selectedPosition = rows[0].position;
  }
  tableBody.innerHTML = rows.map(line => {
    const draft = lineDrafts.get(lineKey(line.position));
    const translated = draft ?? line.translated_text;
    const timeLabel = line.start_time && line.end_time ? `${line.start_time} - ${line.end_time}` : "-";
    return `
      <tr class="review-row ${escapeHtml(line.status)} ${selectedPosition === line.position ? "is-selected" : ""} ${selectedPositions.has(line.position) ? "is-marked" : ""}" data-row-position="${escapeHtml(String(line.position))}">
        ${columns.map(column => renderReviewTableCell(column.key, line, translated, timeLabel)).join("")}
      </tr>
    `;
  }).join("");
}

function reviewActionMeta(currentText, originalText) {
  const current = String(currentText ?? "");
  const original = String(originalText ?? "");
  if (current === original) {
    return { label: "Mark Resolved", mode: "resolve" };
  }
  if (!current.trim()) {
    return { label: "Remove Subtitle", mode: "remove" };
  }
  return { label: "Save Line", mode: "save" };
}

function selectedLine(job) {
  return getLines(job).find(line => line.position === selectedPosition) || null;
}

function selectedVisibleLines(job) {
  const visible = new Set(filteredLines(job).map(line => line.position));
  return getLines(job).filter(line => visible.has(line.position) && selectedPositions.has(line.position));
}

function renderSide(job) {
  const multiSelectedLines = selectedVisibleLines(job);
  if (multiSelectedLines.length > 1) {
    const suspectCount = multiSelectedLines.filter(line => line.status === "suspect").length;
    const errorCount = multiSelectedLines.filter(line => line.status === "error").length;
    const fixedCount = multiSelectedLines.filter(line => ["auto_fixed", "manual_fixed"].includes(line.status)).length;
    sideBody.innerHTML = `
      <div class="panel-head">
        <div>
          <div class="mini-eyebrow">Multi Selection</div>
          <h2>${escapeHtml(String(multiSelectedLines.length))} Lines Selected</h2>
        </div>
      </div>
      <div class="review-side-meta">
        <span class="job-fact">Suspect ${escapeHtml(String(suspectCount))}</span>
        <span class="job-fact">Error ${escapeHtml(String(errorCount))}</span>
        <span class="job-fact">Fixed ${escapeHtml(String(fixedCount))}</span>
      </div>
      <div class="review-source-block">
        <div class="mini-eyebrow">Selection</div>
        <p>Use the same actions here for the whole selection. Click a single row if you want to go back to per-line review.</p>
      </div>
      <label class="review-instruction">
        <strong>Retranslate Instruction</strong>
        <input id="workspace-bulk-instruction" type="text" placeholder="Optional instruction for selected lines" />
      </label>
      <div class="review-actions">
        <button type="button" class="ghost" id="workspace-clear-selection">Clear Selection</button>
        <button type="button" class="ghost" id="workspace-bulk-retranslate">Retranslate Selected</button>
        <button type="button" id="workspace-bulk-resolve">Resolve Selected</button>
      </div>
    `;
    return;
  }

  const line = selectedLine(job);
  if (!line) {
    sideBody.innerHTML = `<p class="job-meta">Select a line to review it here.</p>`;
    return;
  }
  const draft = lineDrafts.get(lineKey(line.position)) ?? line.translated_text;
  const instruction = instructionDrafts.get(lineKey(line.position)) ?? "";
  const action = reviewActionMeta(draft, line.translated_text);
  const notes = line.issue?.notes || [];
  const formattingNeedsAttention = !parseSubtitleFormatting(draft).valid
    || line.reason_tags.includes("formatting_mismatch");
  sideBody.innerHTML = `
    <div class="panel-head">
      <div>
        <div class="mini-eyebrow">Selected Line</div>
        <h2>Line ${escapeHtml(String(line.position + 1))}</h2>
      </div>
      ${statusBadge(line.status)}
    </div>
    <div class="review-side-meta">
      <span class="job-fact">Batch ${escapeHtml(String(line.batch_index))}</span>
      <span class="job-fact">${escapeHtml(job.settings?.source_language || "src")} → ${escapeHtml(job.settings?.target_language || "tgt")}</span>
      ${(line.start_time && line.end_time) ? `<span class="job-fact">${escapeHtml(`${line.start_time} - ${line.end_time}`)}</span>` : ""}
    </div>
    ${line.reason_tags.length ? `<div class="review-reason-row">${renderReasonTags(line.reason_tags)}</div>` : ""}
    <div class="review-source-block">
      <div class="mini-eyebrow">Source</div>
      ${renderSubtitlePreview(line.source_text)}
    </div>
    ${renderReferenceLines(line.reference_subtitles)}
    <div class="review-translation-block">
      <div class="mini-eyebrow">Translation</div>
      <div id="workspace-translation-preview">${draft ? renderSubtitlePreview(draft) : ""}</div>
    </div>
    <details class="review-raw-editor" ${formattingNeedsAttention ? "open" : ""}>
      <summary>
        <span>Formatting & raw text</span>
        ${formattingNeedsAttention ? `<span class="subtitle-format-warning">check formatting</span>` : ""}
      </summary>
      <label class="review-edit">
        <span class="sr-only">Raw translation text</span>
        <textarea id="workspace-translation">${escapeHtml(draft)}</textarea>
      </label>
    </details>
    <div class="review-retranslate-group">
      <label class="review-instruction">
        <strong>Retranslate Instruction</strong>
        <input id="workspace-instruction" type="text" value="${escapeHtml(instruction)}" placeholder="Optional instruction for this line only" />
      </label>
      <button type="button" class="ghost" id="workspace-retranslate">${job.status === "processing" || job.status === "queued" ? "Queue Retranslate" : "Retranslate"}</button>
    </div>
    ${notes.length ? `<div class="issue-notes">${notes.map(note => `<div>${escapeHtml(note)}</div>`).join("")}</div>` : ""}
    <div class="review-actions review-decision-bar">
      <button type="button" id="workspace-save" data-mode="${escapeHtml(action.mode)}">${escapeHtml(action.label)}</button>
      <button type="button" class="ghost" id="workspace-batch-card">Batch Card</button>
      <details class="review-more-actions">
        <summary title="More actions" aria-label="More actions">•••</summary>
        <div><button type="button" class="danger ghost" id="workspace-remove">Remove Subtitle</button></div>
      </details>
    </div>
  `;
}

function renderHeader(job) {
  const referenceTracks = Array.isArray(job?.reference_tracks) ? job.reference_tracks : [];
  titleEl.textContent = job.title || job.filename || "Review";
  metaEl.textContent = `${job.filename || "Job"} • ${job.settings?.source_language || "src"} → ${job.settings?.target_language || "tgt"} • ${job.settings?.model || "model"}${referenceTracks.length ? ` • ${referenceTracks.length} reference track(s)` : ""}`;
  const progress = formatProgress(job.progress || 0);
  if (progressStatusEl) {
    progressStatusEl.innerHTML = statusBadge(job.status || "queued");
  }
  if (progressValueEl) {
    progressValueEl.textContent = progress;
  }
  if (progressBarEl) {
    progressBarEl.style.width = `${Math.max(0, Math.min(100, Number(job.progress || 0)))}%`;
  }
  if (progressCardEl) {
    progressCardEl.classList.toggle("is-idle", !["processing", "paused", "queued", "failed", "completed"].includes(job.status));
  }
}

function renderAll() {
  if (!currentJob) return;
  renderHeader(currentJob);
  renderFilters(currentJob);
  updateToolbarState(currentJob);
  renderTable(currentJob);
  renderSide(currentJob);
  scheduleReviewUiSave();
}

async function fetchJob() {
  const response = await fetch(`/api/jobs/${jobId}`);
  if (!response.ok) {
    titleEl.textContent = "Review Workspace";
    metaEl.textContent = "Job not found";
    tableBody.innerHTML = `<tr><td colspan="7" class="job-meta">Job not found.</td></tr>`;
    sideBody.innerHTML = `<p class="job-meta">This review workspace could not load the job.</p>`;
    return;
  }
  currentJob = await response.json();
  const activeEditor = document.activeElement;
  const isEditing = activeEditor && (
    activeEditor.closest(".review-header") ||
    activeEditor.closest(".review-side-body") ||
    activeEditor.closest(".review-column-menu") ||
    activeEditor.closest("#review-snapshot-dialog")
  ) || Boolean(resizingColumn);
  if (!isEditing) {
    restoreReviewUiState();
    renderAll();
    if (openBatchIndex !== null) {
      const batch = deriveBatchInfo(currentJob, openBatchIndex);
      if (batch) {
        renderSnapshotDialog(currentJob, openBatchIndex);
        if (!snapshotDialog.open) {
          snapshotDialog.showModal();
        }
      } else {
        openBatchIndex = null;
        saveReviewUiState();
        if (snapshotDialog.open) {
          snapshotDialog.close();
        }
      }
    }
    if (snapshotDialog.open && openBatchIndex !== null) {
      renderSnapshotDialog(currentJob, openBatchIndex);
    }
    requestAnimationFrame(() => {
      restoreReviewScrollState();
    });
  }
}

async function saveLine(mode = "save") {
  if (!currentJob || selectedPosition === null) return;
  const currentPosition = selectedPosition;
  const nextPosition = nextVisibleWorkflowPosition(currentJob, currentPosition);
  const priorLine = selectedLine(currentJob);
  const translation = document.getElementById("workspace-translation")?.value || "";
  lineDrafts.set(lineKey(selectedPosition), translation);
  const response = await fetch(`/api/jobs/${jobId}/lines/${selectedPosition}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: translation, resolution_mode: mode }),
  });
  if (!response.ok) {
    alert("Could not update subtitle line.");
    return;
  }
  currentJob = await response.json();
  lineDrafts.delete(lineKey(selectedPosition));
  const updatedLine = selectedLine(currentJob);
  if (
    currentFilter === "suspect"
    && priorLine?.status === "suspect"
    && updatedLine
    && ["auto_fixed", "manual_fixed"].includes(updatedLine.status)
  ) {
    transientSuspectResolved.add(updatedLine.position);
  }
  if (nextPosition !== null && nextPosition !== currentPosition) {
    selectedPosition = nextPosition;
  }
  renderAll();
  tableBody.querySelector(`[data-row-position="${selectedPosition}"]`)?.scrollIntoView({ block: "nearest" });
}

async function saveLineAt(position, text, mode = "save") {
  if (!currentJob) return false;
  const priorLine = getLines(currentJob).find(line => line.position === position) || null;
  const response = await fetch(`/api/jobs/${jobId}/lines/${position}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, resolution_mode: mode }),
  });
  if (!response.ok) {
    return false;
  }
  currentJob = await response.json();
  lineDrafts.delete(lineKey(position));
  const updatedLine = getLines(currentJob).find(line => line.position === position) || null;
  if (
    currentFilter === "suspect"
    && priorLine?.status === "suspect"
    && updatedLine
    && ["auto_fixed", "manual_fixed"].includes(updatedLine.status)
  ) {
    transientSuspectResolved.add(updatedLine.position);
  }
  return true;
}

async function retranslateLineAt(position, instruction = "") {
  if (!currentJob || position === null || position === undefined) return false;
  const nextPosition = nextVisibleWorkflowPosition(currentJob, position);
  const priorLine = getLines(currentJob).find(line => line.position === position) || null;
  instructionDrafts.set(lineKey(position), instruction);
  const response = await fetch(`/api/jobs/${jobId}/lines/${position}/retranslate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ extra_instruction: instruction }),
  });
  if (!response.ok) {
    alert("Could not retranslate subtitle line.");
    return false;
  }
  const data = await response.json();
  currentJob = data.job;
  instructionDrafts.delete(lineKey(position));
  const updatedLine = getLines(currentJob).find(line => line.position === position) || null;
  if (
    currentFilter === "suspect"
    && priorLine?.status === "suspect"
    && updatedLine
    && ["auto_fixed", "manual_fixed"].includes(updatedLine.status)
  ) {
    transientSuspectResolved.add(updatedLine.position);
  }
  if (nextPosition !== null && nextPosition !== position) {
    selectedPosition = nextPosition;
  }
  renderAll();
  tableBody.querySelector(`[data-row-position="${selectedPosition}"]`)?.scrollIntoView({ block: "nearest" });
  return true;
}

function selectedVisiblePositions(job = currentJob) {
  if (!job) return [];
  const visible = new Set(filteredLines(job).map(line => line.position));
  return [...selectedPositions].filter(position => visible.has(position));
}

async function bulkResolveSelected() {
  const positions = selectedVisiblePositions(currentJob);
  if (!positions.length) return;
  const button = document.getElementById("workspace-bulk-resolve");
  if (button) {
    button.disabled = true;
    button.textContent = "Resolving...";
  }
  try {
    for (const position of positions) {
      const line = getLines(currentJob).find(item => item.position === position);
      const text = lineDrafts.get(lineKey(position)) ?? line?.translated_text ?? "";
      const ok = await saveLineAt(position, text, "resolve");
      if (!ok) {
        alert(`Could not resolve line ${position + 1}.`);
        break;
      }
    }
  } finally {
    if (button) {
      button.textContent = "Resolve Selected";
    }
    renderAll();
  }
}

async function bulkRetranslateSelected(extraInstruction = "") {
  const positions = selectedVisiblePositions(currentJob);
  if (!positions.length) return;
  const button = document.getElementById("workspace-bulk-retranslate");
  const instruction = extraInstruction;
  if (button) {
    button.disabled = true;
    button.textContent = "Retranslating...";
  }
  try {
    for (const position of positions) {
      const ok = await retranslateLineAt(position, instruction);
      if (!ok) {
        alert(`Could not retranslate line ${position + 1}.`);
        break;
      }
    }
  } finally {
    if (button) {
      button.textContent = "Retranslate Selected";
    }
    renderAll();
  }
}

function clearSelectedRows() {
  selectedPositions.clear();
  selectionAnchorPosition = null;
  renderAll();
}

function applyRowSelection(position, event) {
  const rows = filteredLines(currentJob).map(line => line.position);
  const isToggle = event.metaKey || event.ctrlKey;
  const isRange = event.shiftKey;

  if (isRange && selectionAnchorPosition !== null) {
    const startIndex = rows.indexOf(selectionAnchorPosition);
    const endIndex = rows.indexOf(position);
    if (startIndex !== -1 && endIndex !== -1) {
      if (!isToggle) {
        selectedPositions.clear();
      }
      const [from, to] = startIndex < endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
      for (let index = from; index <= to; index += 1) {
        selectedPositions.add(rows[index]);
      }
    } else {
      selectedPositions.clear();
      selectedPositions.add(position);
    }
  } else if (isToggle) {
    if (selectedPositions.has(position)) {
      selectedPositions.delete(position);
    } else {
      selectedPositions.add(position);
    }
    selectionAnchorPosition = position;
  } else {
    selectedPositions.clear();
    selectedPositions.add(position);
    selectionAnchorPosition = position;
  }

  selectedPosition = position;
  renderAll();
}

async function retranslateLine() {
  if (!currentJob || selectedPosition === null) return;
  const instruction = document.getElementById("workspace-instruction")?.value || "";
  await retranslateLineAt(selectedPosition, instruction);
}

function snapshotDraftKey(batchIndex) {
  return `${jobId}:batch:${batchIndex}`;
}

function renderSnapshotDialog(job, batchIndex) {
  const batch = deriveBatchInfo(job, batchIndex);
  snapshotTitle.textContent = `Batch ${batchIndex} Card`;
  if (!batch) {
    snapshotBody.innerHTML = `<p class="job-meta">No batch data available.</p>`;
    saveSnapshotBtn.disabled = true;
    generateSnapshotBtn.disabled = true;
    return;
  }
  const draftKey = snapshotDraftKey(batchIndex);
  const currentDraft = contextDrafts.get(draftKey) || normalizeContextInput(batch.input_context || job.session_context || {});
  snapshotBody.innerHTML = renderContextEditor("workspace-snapshot", currentDraft, `
    <div class="snapshot-meta-row">
      <span class="job-fact">Batch ${escapeHtml(String(batchIndex))}</span>
      <span class="job-fact">Lines ${escapeHtml(String(batch.start_position + 1))} to ${escapeHtml(String(batch.end_position + 1))}</span>
      <span class="job-fact">${batch.has_snapshot ? "Saved snapshot" : "Derived from batch index"}</span>
    </div>
    <section class="context-editor-preview secondary">
      <div class="mini-eyebrow">Saved Output Card</div>
      <div class="snapshot-preview">
        ${batch.has_snapshot ? renderSessionSnapshot(batch.output_context) : `<div class="tile"><div class="mini-eyebrow">No Saved Output</div><p>You can generate and save a card for this batch.</p></div>`}
      </div>
    </section>
  `);
  saveSnapshotBtn.disabled = false;
  generateSnapshotBtn.disabled = false;
}

async function saveBatchCard() {
  if (!currentJob || openBatchIndex === null) return;
  const payload = normalizeContextInput(readContextEditor("workspace-snapshot", snapshotBody));
  const response = await fetch(`/api/jobs/${jobId}/batch-context/${openBatchIndex}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_context: payload }),
  });
  if (!response.ok) {
    alert("Could not update batch card.");
    return;
  }
  currentJob = await response.json();
  contextDrafts.delete(snapshotDraftKey(openBatchIndex));
  renderSnapshotDialog(currentJob, openBatchIndex);
  renderAll();
}

async function generateBatchCard() {
  if (!currentJob || openBatchIndex === null) return;
  generateSnapshotBtn.disabled = true;
  generateSnapshotBtn.textContent = "Generating...";
  const response = await fetch(`/api/jobs/${jobId}/batch-context/${openBatchIndex}/generate`, { method: "POST" });
  generateSnapshotBtn.disabled = false;
  generateSnapshotBtn.textContent = "Generate Card";
  if (!response.ok) {
    alert("Could not generate batch card.");
    return;
  }
  const data = await response.json();
  contextDrafts.set(snapshotDraftKey(openBatchIndex), normalizeContextInput(data.session_context));
  renderSnapshotDialog(currentJob, openBatchIndex);
}

function flaggedPositions() {
  if (!currentJob) return [];
  return filteredLines(currentJob)
    .filter(line => line.status === "suspect" || line.status === "error")
    .map(line => line.position);
}

function jumpFlagged(direction) {
  const positions = flaggedPositions();
  if (!positions.length) return;
  if (selectedPosition === null) {
    selectedPosition = positions[0];
    renderAll();
    return;
  }
  const currentIndex = positions.indexOf(selectedPosition);
  if (currentIndex === -1) {
    selectedPosition = positions[0];
  } else {
    const nextIndex = (currentIndex + direction + positions.length) % positions.length;
    selectedPosition = positions[nextIndex];
  }
  renderAll();
  const row = tableBody.querySelector(`[data-row-position="${selectedPosition}"]`);
  row?.scrollIntoView({ block: "nearest" });
}

function visibleFlaggedPositions(job = currentJob) {
  if (!job) return [];
  return filteredLines(job)
    .filter(line => line.status === "suspect" || line.status === "error")
    .map(line => line.position);
}

function nextVisibleWorkflowPosition(job, currentPosition) {
  if (!job) return null;
  const rows = filteredLines(job);
  if (!rows.length) return null;
  const pendingRows = rows.filter(line => line.status === "suspect" || line.status === "error");
  const orderedRows = pendingRows.length ? pendingRows : rows;
  const currentIndex = orderedRows.findIndex(line => line.position === currentPosition);
  if (currentIndex === -1) {
    return orderedRows[0]?.position ?? null;
  }
  return orderedRows[(currentIndex + 1) % orderedRows.length]?.position ?? null;
}

async function autoRewriteAllFlagged() {
  if (!currentJob) return;
  if (autoRewritePending) {
    autoRewriteAbort = true;
    return;
  }
  const queue = visibleFlaggedPositions(currentJob);
  if (!queue.length) return;
  autoRewritePending = true;
  autoRewriteAbort = false;
  renderAll();
  try {
    for (const position of queue) {
      if (autoRewriteAbort) break;
      const stillFlagged = visibleFlaggedPositions(currentJob).includes(position);
      if (!stillFlagged) continue;
      selectedPosition = position;
      renderAll();
      const row = tableBody.querySelector(`[data-row-position="${selectedPosition}"]`);
      row?.scrollIntoView({ block: "nearest" });
      const ok = await retranslateLineAt(position, "");
      if (!ok) break;
    }
  } finally {
    autoRewritePending = false;
    autoRewriteAbort = false;
    renderAll();
  }
}

function removeContextRow(scope, button) {
  const row = button.closest("[data-editor-row]");
  if (!row) return;
  row.remove();
  syncContextPreview(scope, snapshotBody);
}

function addContextRow(scope, kind) {
  const draft = normalizeContextInput(readContextEditor(scope, snapshotBody));
  if (kind === "character") {
    draft.characters.push({ name: "", role: "", aliases: [], gender: "unknown" });
  } else {
    draft.glossary.push({ term: "", meaning: "", keep: true });
  }
  contextDrafts.set(snapshotDraftKey(openBatchIndex), draft);
  renderSnapshotDialog(currentJob, openBatchIndex);
}

document.addEventListener("click", (event) => {
  const filterButton = event.target.closest("[data-filter]");
  if (filterButton) {
    const nextFilter = filterButton.dataset.filter || "all";
    const previousSelectedPosition = selectedPosition;
    if (currentFilter === "suspect" && nextFilter !== "suspect") {
      clearTransientSuspectResolved();
    }
    currentFilter = nextFilter;
    renderAll();
    if (previousSelectedPosition !== null) {
      const previousRow = tableBody.querySelector(`[data-row-position="${previousSelectedPosition}"]`);
      previousRow?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    return;
  }
  const row = event.target.closest("[data-row-position]");
  if (row) {
    applyRowSelection(Number(row.dataset.rowPosition), event);
    return;
  }
  const addButton = event.target.closest("[data-context-add]");
  if (addButton && snapshotDialog.open) {
    addContextRow(addButton.dataset.contextScope, addButton.dataset.contextAdd);
    return;
  }
  const removeButton = event.target.closest("[data-context-remove]");
  if (removeButton && snapshotDialog.open) {
    removeContextRow(removeButton.dataset.contextScope, removeButton);
    return;
  }
  if (event.target.id === "workspace-save") {
    void saveLine(event.target.dataset.mode || "save");
    return;
  }
  if (event.target.id === "workspace-remove") {
    const field = document.getElementById("workspace-translation");
    if (field) field.value = "";
    void saveLine("remove");
    return;
  }
  if (event.target.id === "workspace-retranslate") {
    void retranslateLine();
    return;
  }
  if (event.target.id === "workspace-clear-selection") {
    clearSelectedRows();
    return;
  }
  if (event.target.id === "workspace-bulk-resolve") {
    void bulkResolveSelected();
    return;
  }
  if (event.target.id === "workspace-bulk-retranslate") {
    const instruction = document.getElementById("workspace-bulk-instruction")?.value || "";
    void bulkRetranslateSelected(instruction);
    return;
  }
  if (event.target.id === "workspace-batch-card") {
    const line = selectedLine(currentJob);
    if (!line) return;
    openBatchIndex = line.batch_index;
    renderSnapshotDialog(currentJob, openBatchIndex);
    snapshotDialog.showModal();
    saveReviewUiState();
  }
});

document.addEventListener("change", (event) => {
  const toggle = event.target.closest("[data-column-visible]");
  if (!toggle) return;
  const key = toggle.dataset.columnVisible;
  const column = reviewColumnState.find(item => item.key === key);
  if (!column) return;
  if (!toggle.checked && visibleReviewColumns().length <= 1) {
    toggle.checked = true;
    return;
  }
  column.visible = Boolean(toggle.checked);
  saveReviewColumnState();
  if (currentJob) renderTable(currentJob);
});

columnResetBtn?.addEventListener("click", () => {
  reviewColumnState = defaultReviewColumnState();
  saveReviewColumnState();
  if (currentJob) renderTable(currentJob);
});

document.addEventListener("dragstart", (event) => {
  const header = event.target.closest("[data-column-header]");
  if (!header || event.target.closest("[data-column-resize]")) return;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", header.dataset.columnHeader || "");
  header.classList.add("is-dragging");
});

document.addEventListener("dragend", (event) => {
  event.target.closest("[data-column-header]")?.classList.remove("is-dragging");
});

document.addEventListener("dragover", (event) => {
  if (event.target.closest("[data-column-header]")) event.preventDefault();
});

document.addEventListener("drop", (event) => {
  const targetHeader = event.target.closest("[data-column-header]");
  if (!targetHeader) return;
  event.preventDefault();
  const sourceKey = event.dataTransfer.getData("text/plain");
  const targetKey = targetHeader.dataset.columnHeader;
  if (!sourceKey || !targetKey || sourceKey === targetKey) return;
  const sourceIndex = reviewColumnState.findIndex(item => item.key === sourceKey);
  const targetIndex = reviewColumnState.findIndex(item => item.key === targetKey);
  if (sourceIndex < 0 || targetIndex < 0) return;
  const [column] = reviewColumnState.splice(sourceIndex, 1);
  reviewColumnState.splice(targetIndex, 0, column);
  saveReviewColumnState();
  if (currentJob) renderTable(currentJob);
});

document.addEventListener("pointerdown", (event) => {
  const handle = event.target.closest("[data-column-resize]");
  if (!handle) return;
  event.preventDefault();
  event.stopPropagation();
  const key = handle.dataset.columnResize;
  const column = reviewColumnState.find(item => item.key === key);
  if (!column) return;
  resizingColumn = { key, startX: event.clientX, startWidth: column.width };
  document.body.classList.add("is-resizing-review-column");
  handle.setPointerCapture?.(event.pointerId);
});

window.addEventListener("pointermove", (event) => {
  if (!resizingColumn) return;
  const column = reviewColumnState.find(item => item.key === resizingColumn.key);
  if (!column) return;
  column.width = Math.max(48, Math.min(720, resizingColumn.startWidth + event.clientX - resizingColumn.startX));
  renderTableStructure();
});

window.addEventListener("pointerup", () => {
  if (!resizingColumn) return;
  resizingColumn = null;
  document.body.classList.remove("is-resizing-review-column");
  saveReviewColumnState();
});

document.addEventListener("input", (event) => {
  if (event.target.id === "workspace-translation" && selectedPosition !== null) {
    lineDrafts.set(lineKey(selectedPosition), event.target.value);
    const action = reviewActionMeta(event.target.value, selectedLine(currentJob)?.translated_text || "");
    const saveButton = document.getElementById("workspace-save");
    if (saveButton) {
      saveButton.textContent = action.label;
      saveButton.dataset.mode = action.mode;
    }
    const preview = document.getElementById("workspace-translation-preview");
    if (preview) preview.innerHTML = event.target.value ? renderSubtitlePreview(event.target.value) : "";
    return;
  }
  if (event.target.id === "workspace-instruction" && selectedPosition !== null) {
    instructionDrafts.set(lineKey(selectedPosition), event.target.value);
    return;
  }
  if (snapshotDialog.open && event.target.closest("[data-context-field], [data-context-character], [data-context-glossary]")) {
    contextDrafts.set(snapshotDraftKey(openBatchIndex), normalizeContextInput(readContextEditor("workspace-snapshot", snapshotBody)));
    syncContextPreview("workspace-snapshot", snapshotBody);
  }
});

searchEl.addEventListener("input", () => {
  currentSearch = searchEl.value || "";
  renderAll();
});
refreshBtn.addEventListener("click", () => void fetchJob());
prevFlaggedBtn.addEventListener("click", () => jumpFlagged(-1));
nextFlaggedBtn.addEventListener("click", () => jumpFlagged(1));
autoRewriteNextBtn?.addEventListener("click", () => void autoRewriteAllFlagged());
saveSnapshotBtn.addEventListener("click", () => void saveBatchCard());
generateSnapshotBtn.addEventListener("click", () => void generateBatchCard());
snapshotDialog.addEventListener("close", () => {
  if (openBatchIndex !== null) {
    contextDrafts.delete(snapshotDraftKey(openBatchIndex));
  }
  openBatchIndex = null;
  saveReviewUiState();
});
document.addEventListener("scroll", scheduleReviewScrollSave, { passive: true });
window.addEventListener("scroll", scheduleReviewScrollSave, { passive: true });
window.addEventListener("pagehide", saveReviewScrollState, { passive: true });
window.addEventListener("beforeunload", saveReviewScrollState, { passive: true });
reviewScrollContainer()?.addEventListener("scroll", scheduleReviewScrollSave, { passive: true });
document.addEventListener("change", scheduleReviewUiSave, true);

void fetchJob();
setInterval(fetchJob, 2500);
