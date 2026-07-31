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
const sidePanel = document.querySelector(".review-side-panel");
const syncStatusEl = document.getElementById("review-sync-status");
const toastEl = document.getElementById("review-toast");
const reviewConfirmDialog = document.getElementById("review-confirm-dialog");
const reviewConfirmTitle = document.getElementById("review-confirm-title");
const reviewConfirmMessage = document.getElementById("review-confirm-message");
const reviewConfirmCancel = document.getElementById("review-confirm-cancel");
const reviewConfirmSubmit = document.getElementById("review-confirm-submit");
const jumpLineEl = document.getElementById("review-jump-line");
const densityButtons = [...document.querySelectorAll("[data-review-density]")];
const snapshotDialog = document.getElementById("review-snapshot-dialog");
const snapshotTitle = document.getElementById("review-snapshot-title");
const snapshotBody = document.getElementById("review-snapshot-body");
const saveSnapshotBtn = document.getElementById("review-save-snapshot");
const generateSnapshotBtn = document.getElementById("review-generate-snapshot");

const jobId = window.location.pathname.split("/").filter(Boolean).pop();
const VALID_REVIEW_FILTERS = new Set(["all", "suspect", "error", "fixed", "edited", "active", "pending", "missing", "normal"]);
const requestedReviewFilter = new URLSearchParams(window.location.search).get("filter");
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
let currentFilter = VALID_REVIEW_FILTERS.has(requestedReviewFilter) ? requestedReviewFilter : "all";
let currentSearch = "";
let selectedPosition = null;
let openBatchIndex = null;
let autoRewritePending = false;
let autoRewriteAbort = false;
let autoRewriteProgress = null;
const transientSuspectResolved = new Set();
const selectedPositions = new Set();
let selectionAnchorPosition = null;
const lineDrafts = new Map();
const instructionDrafts = new Map();
const contextDrafts = new Map();
const loadedBatchSnapshots = new Map();
let reviewScrollRestorePending = true;
let reviewScrollSaveFrame = null;
let reviewUiRestorePending = true;
let reviewUiSaveFrame = null;
let reviewColumnState = loadReviewColumnState();
let resizingColumn = null;
let reviewDensity = "comfortable";
let lastReviewPayload = "";
let reviewFetchSequence = 0;
let reviewFetchController = null;
let reviewFetchInFlight = false;
let reviewMutationDepth = 0;
let reviewConnectionFailed = false;
let pendingReviewRender = false;
let toastTimer = null;
let bulkActionPending = false;
let lineActionPending = false;
let batchCardOperationToken = 0;
let pendingReviewConfirmationResolve = null;
const rawEditorOpenPositions = new Set();

function setReviewSyncStatus(message, tone = "live") {
  if (!syncStatusEl) return;
  syncStatusEl.textContent = message;
  syncStatusEl.dataset.tone = tone;
}

function showReviewToast(message, tone = "info") {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.dataset.tone = tone;
  toastEl.hidden = false;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
    toastTimer = null;
  }, 4200);
}

function requestReviewConfirmation({ title, message, confirmLabel = "Continue", tone = "danger" }) {
  if (!reviewConfirmDialog || !reviewConfirmTitle || !reviewConfirmMessage || !reviewConfirmSubmit) {
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }
  if (pendingReviewConfirmationResolve) return Promise.resolve(false);
  reviewConfirmTitle.textContent = title;
  reviewConfirmMessage.textContent = message;
  reviewConfirmSubmit.textContent = confirmLabel;
  reviewConfirmSubmit.classList.toggle("danger", tone === "danger");
  reviewConfirmSubmit.classList.toggle("warn", tone === "warning");
  reviewConfirmDialog.dataset.tone = tone;
  reviewConfirmDialog.showModal();
  requestAnimationFrame(() => reviewConfirmCancel?.focus());
  return new Promise(resolve => {
    pendingReviewConfirmationResolve = resolve;
  });
}

function settleReviewConfirmation(confirmed) {
  const resolve = pendingReviewConfirmationResolve;
  pendingReviewConfirmationResolve = null;
  if (reviewConfirmDialog?.open) reviewConfirmDialog.close(confirmed ? "confirm" : "cancel");
  resolve?.(confirmed);
}

function applyReviewDensity() {
  document.body.dataset.reviewDensity = reviewDensity;
  for (const button of densityButtons) {
    const active = button.dataset.reviewDensity === reviewDensity;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

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
  try {
    localStorage.setItem(REVIEW_COLUMN_STATE_KEY, JSON.stringify(reviewColumnState));
  } catch (_) {
    showReviewToast("Column changes work for this session, but could not be saved in browser storage.", "warning");
  }
}

function visibleReviewColumns() {
  return reviewColumnState.filter(column => column.visible);
}

function renderColumnControls() {
  if (!columnControls) return;
  columnControls.innerHTML = reviewColumnState.map((column, index) => {
    const label = REVIEW_COLUMN_DEFINITIONS[column.key].label;
    return `
      <div class="review-column-option">
        <label>
          <input type="checkbox" data-column-visible="${escapeHtml(column.key)}" ${column.visible ? "checked" : ""} />
          <span>${escapeHtml(label)}</span>
        </label>
        <div class="review-column-option-actions">
          <button type="button" class="ghost" data-column-move="left" data-column-key="${escapeHtml(column.key)}" aria-label="Move ${escapeHtml(label)} left" ${index === 0 ? "disabled" : ""}>←</button>
          <button type="button" class="ghost" data-column-move="right" data-column-key="${escapeHtml(column.key)}" aria-label="Move ${escapeHtml(label)} right" ${index === reviewColumnState.length - 1 ? "disabled" : ""}>→</button>
          <label class="review-column-width-label">
            <span class="sr-only">${escapeHtml(label)} width in pixels</span>
            <input type="number" data-column-width="${escapeHtml(column.key)}" min="48" max="720" step="8" value="${escapeHtml(String(column.width))}" />
            <span aria-hidden="true">px</span>
          </label>
        </div>
      </div>
    `;
  }).join("");
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
      <th scope="col" draggable="true" data-column-header="${escapeHtml(column.key)}" title="Drag to reorder">
        <span>${escapeHtml(REVIEW_COLUMN_DEFINITIONS[column.key].label)}</span>
        <span
          class="review-column-resizer"
          data-column-resize="${escapeHtml(column.key)}"
          title="Drag or use arrow keys to resize"
          role="separator"
          tabindex="0"
          aria-orientation="vertical"
          aria-label="Resize ${escapeHtml(REVIEW_COLUMN_DEFINITIONS[column.key].label)} column"
          aria-valuemin="48"
          aria-valuemax="720"
          aria-valuenow="${escapeHtml(String(column.width))}"
        ></span>
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
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(state));
  } catch (_) {
    // Review remains usable without persisted scroll position.
  }
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
    // Draft input remains in the DOM; only cross-navigation recovery is unavailable.
  }
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
    tableScrollLeft: tableWrap?.scrollLeft || 0,
    sideScrollTop: sideBody?.scrollTop || 0,
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
    tableWrap.scrollLeft = Number(state.tableScrollLeft || 0);
  }
  if (sideBody) sideBody.scrollTop = Number(state.sideScrollTop || 0);
}

function captureReviewUiState() {
  return {
    windowScrollTop: window.scrollY || 0,
    tableScrollTop: reviewScrollContainer()?.scrollTop || 0,
    tableScrollLeft: reviewScrollContainer()?.scrollLeft || 0,
    sideScrollTop: sideBody?.scrollTop || 0,
    currentFilter,
    currentSearch,
    reviewDensity,
    selectedPosition,
    selectedPositions: [...selectedPositions],
    selectionAnchorPosition,
    openBatchIndex,
    lineDrafts: [...lineDrafts.entries()],
    instructionDrafts: [...instructionDrafts.entries()],
    contextDrafts: [...contextDrafts.entries()],
    rawEditorOpenPositions: [...rawEditorOpenPositions],
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
  if (!state) {
    applyReviewDensity();
    return;
  }
  currentFilter = VALID_REVIEW_FILTERS.has(requestedReviewFilter)
    ? requestedReviewFilter
    : VALID_REVIEW_FILTERS.has(state.currentFilter)
      ? state.currentFilter
      : "all";
  currentSearch = VALID_REVIEW_FILTERS.has(requestedReviewFilter) ? "" : (state.currentSearch || "");
  reviewDensity = state.reviewDensity === "compact" ? "compact" : "comfortable";
  applyReviewDensity();
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
  rawEditorOpenPositions.clear();
  for (const value of Array.isArray(state.rawEditorOpenPositions) ? state.rawEditorOpenPositions : []) {
    const position = Number(value);
    if (Number.isFinite(position)) rawEditorOpenPositions.add(position);
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

function statusLabel(status) {
  return {
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
}

function statusBadge(status) {
  const label = statusLabel(status);
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
    <div class="review-source-block" dir="auto">
      <div class="mini-eyebrow">Reference Lines</div>
      <div class="reference-line-list">
        ${references.map(reference => `
          <article class="reference-line-card" lang="${escapeHtml(reference.language || "")}" dir="auto">
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
  const sourceMap = new Map((job.original_lines || []).map(line => [Number(line.position), line]));
  const translatedMap = new Map((job.translated_lines || []).map(line => [Number(line.position), line]));
  const issueMap = new Map((job.validation_issues || []).map(issue => [Number(issue.position), issue]));
  const referenceMap = buildReferenceMap(job);
  const positions = [...new Set([...sourceMap.keys(), ...translatedMap.keys(), ...issueMap.keys()])]
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const translatedTextMap = new Map([...translatedMap].map(([position, line]) => [position, line?.text || ""]));
  return positions.map(position => {
    const line = sourceMap.get(position) || null;
    const translatedLine = translatedMap.get(position) || null;
    const issue = issueMap.get(position) || null;
    const status = lineStatus(job, issue, position, translatedTextMap);
    const reasonTags = Array.isArray(issue?.reason_codes) && issue.reason_codes.length
      ? [...new Set(issue.reason_codes.map(code => String(code || "").trim()).filter(Boolean))]
      : inferReasonTags(issue);
    const references = referenceMap.get(position) || [];
    return {
      position,
      has_source: Boolean(line),
      source_text: line?.text || "",
      start_time: line?.start_time || translatedLine?.start_time || "",
      end_time: line?.end_time || translatedLine?.end_time || "",
      translated_text: translatedLine?.text || "",
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
        line.status.replaceAll("_", " "),
        statusLabel(line.status),
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
      aria-pressed="${currentFilter === key ? "true" : "false"}"
    >
      <span>${escapeHtml(label)}</span><strong>${escapeHtml(String(counts[key] || 0))}</strong>
    </button>
  `).join("");
}

function clearTransientSuspectResolved() {
  transientSuspectResolved.clear();
}

function updateToolbarState(job) {
  const flaggedLines = filteredLines(job)
    .filter(line => line.status === "suspect" || line.status === "error");
  const flaggedCount = flaggedLines.length;
  const rewriteCount = flaggedLines.filter(line => line.has_source).length;
  if (autoRewriteNextBtn) {
    autoRewriteNextBtn.disabled = !autoRewritePending && !rewriteCount;
    autoRewriteNextBtn.textContent = autoRewritePending
      ? `Stop Auto Rewrite${autoRewriteProgress ? ` · ${autoRewriteProgress.current}/${autoRewriteProgress.total}` : ""}`
      : `Auto Rewrite All${rewriteCount ? ` (${rewriteCount})` : ""}`;
    if (autoRewritePending) autoRewriteNextBtn.setAttribute("aria-busy", "true");
    else autoRewriteNextBtn.removeAttribute("aria-busy");
  }
  if (prevFlaggedBtn) prevFlaggedBtn.disabled = !flaggedCount;
  if (nextFlaggedBtn) nextFlaggedBtn.disabled = !flaggedCount;
}

function renderReviewTableCell(columnKey, line, translated, timeLabel) {
  const emptyTranslation = `<span>${line.status === "pending" ? "Waiting for translation" : (line.status === "translating" ? "Model is translating this line" : "No translation returned")}</span>`;
  const sourceContent = line.source_text
    ? renderSubtitlePreview(line.source_text, { compact: true })
    : `<span class="job-meta">Extra translated cue — no source line</span>`;
  const content = {
    line: escapeHtml(String(line.position + 1)),
    time: `<div class="table-time">${escapeHtml(timeLabel)}</div>`,
    status: statusBadge(line.status),
    reason: `<div class="table-reasons">${renderReasonTags(line.reason_tags)}</div>`,
    subtitle: `
      <div class="stacked-subtitle-pair">
        <div class="stacked-subtitle-part source">
          <span class="stacked-subtitle-label">Source</span>
          ${sourceContent}
        </div>
        <div class="stacked-subtitle-part translation ${translated ? "" : "is-empty"}">
          <span class="stacked-subtitle-label">Translation</span>
          ${translated ? renderSubtitlePreview(translated, { compact: true }) : emptyTranslation}
        </div>
      </div>
    `,
    source: `<div class="table-copy">${sourceContent}</div>`,
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
      <tr class="review-row ${escapeHtml(line.status)} ${selectedPosition === line.position ? "is-selected" : ""} ${selectedPositions.has(line.position) ? "is-marked" : ""}"
          data-row-position="${escapeHtml(String(line.position))}"
          tabindex="${selectedPosition === line.position ? "0" : "-1"}"
          aria-selected="${selectedPosition === line.position || selectedPositions.has(line.position) ? "true" : "false"}"
          aria-label="Line ${escapeHtml(String(line.position + 1))}, ${escapeHtml(line.status.replaceAll("_", " "))}">
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

function reviewActionBusy() {
  return lineActionPending || bulkActionPending || autoRewritePending || batchCardOperationToken !== 0;
}

function renderSide(job) {
  const actionBusy = reviewActionBusy();
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
        <button type="button" class="ghost" id="workspace-clear-selection" ${actionBusy ? "disabled" : ""}>Clear Selection</button>
        <button type="button" class="ghost" id="workspace-bulk-retranslate" ${actionBusy ? "disabled aria-busy=\"true\"" : ""}>${actionBusy ? "Working…" : "Retranslate Selected"}</button>
        <button type="button" id="workspace-bulk-resolve" ${actionBusy ? "disabled aria-busy=\"true\"" : ""}>${actionBusy ? "Working…" : "Resolve Selected"}</button>
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
      ${line.source_text ? renderSubtitlePreview(line.source_text) : `<p class="job-meta">Extra translated cue — there is no matching source line.</p>`}
    </div>
    ${renderReferenceLines(line.reference_subtitles)}
    <div class="review-translation-block" lang="${escapeHtml(job.settings?.target_language || "")}" dir="auto">
      <div class="mini-eyebrow">Translation</div>
      <div id="workspace-translation-preview">${draft ? renderSubtitlePreview(draft) : ""}</div>
    </div>
    <details class="review-raw-editor" data-raw-editor-position="${escapeHtml(String(line.position))}" ${formattingNeedsAttention || rawEditorOpenPositions.has(line.position) ? "open" : ""}>
      <summary>
        <span>Formatting & raw text</span>
        ${formattingNeedsAttention ? `<span class="subtitle-format-warning">check formatting</span>` : ""}
      </summary>
      <label class="review-edit">
        <span class="sr-only">Raw translation text</span>
        <textarea id="workspace-translation" lang="${escapeHtml(job.settings?.target_language || "")}" dir="auto">${escapeHtml(draft)}</textarea>
      </label>
    </details>
    <div class="review-retranslate-group">
      <label class="review-instruction">
        <strong>Retranslate Instruction</strong>
        <input id="workspace-instruction" type="text" value="${escapeHtml(instruction)}" placeholder="Optional instruction for this line only" />
      </label>
      <button type="button" class="ghost" id="workspace-retranslate" ${actionBusy || !line.has_source ? "disabled" : ""} ${actionBusy ? "aria-busy=\"true\"" : ""} ${!line.has_source ? "title=\"Extra output has no source cue to retranslate. Edit or remove it instead.\"" : ""}>${actionBusy ? "Working…" : (job.status === "processing" || job.status === "queued" ? "Queue Retranslate" : "Retranslate")}</button>
    </div>
    ${notes.length ? `<div class="issue-notes">${notes.map(note => `<div>${escapeHtml(note)}</div>`).join("")}</div>` : ""}
    <div class="review-actions review-decision-bar">
      <button type="button" id="workspace-save" data-mode="${escapeHtml(action.mode)}" ${actionBusy ? "disabled aria-busy=\"true\"" : ""}>${actionBusy ? "Working…" : escapeHtml(action.label)}</button>
      <button type="button" class="ghost" id="workspace-batch-card" ${actionBusy || !line.has_source ? "disabled" : ""} ${!line.has_source ? "title=\"This extra output has no source batch.\"" : ""}>Batch Card</button>
      ${action.mode === "remove" ? "" : `<button type="button" class="danger ghost" id="workspace-remove" ${actionBusy ? "disabled" : ""}>Remove Subtitle</button>`}
    </div>
    <div class="review-keyboard-hint" aria-label="Keyboard shortcuts">
      <span><kbd>↑</kbd><kbd>↓</kbd> lines</span>
      <span><kbd>/</kbd> search</span>
      <span><kbd>Ctrl</kbd><kbd>S</kbd> save</span>
    </div>
    <button type="button" class="ghost review-return-list" data-review-return-list>Back to selected line in list</button>
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
    const numericProgress = Math.max(0, Math.min(100, Number(job.progress || 0)));
    progressBarEl.style.width = `${numericProgress}%`;
    progressBarEl.parentElement?.setAttribute("role", "progressbar");
    progressBarEl.parentElement?.setAttribute("aria-label", "Job progress");
    progressBarEl.parentElement?.setAttribute("aria-valuemin", "0");
    progressBarEl.parentElement?.setAttribute("aria-valuemax", "100");
    progressBarEl.parentElement?.setAttribute("aria-valuenow", String(numericProgress));
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

function reviewHasActiveEditor() {
  const activeEditor = document.activeElement;
  const isEditable = activeEditor instanceof HTMLInputElement
    || activeEditor instanceof HTMLTextAreaElement
    || activeEditor instanceof HTMLSelectElement
    || activeEditor?.getAttribute?.("contenteditable") === "true";
  return Boolean(isEditable && (
    activeEditor.closest(".review-header")
    || activeEditor.closest(".review-side-body")
    || activeEditor.closest(".review-column-menu")
  )) || Boolean(snapshotDialog.open) || Boolean(resizingColumn);
}

function applyFetchedReviewJob() {
  if (!currentJob || reviewHasActiveEditor()) {
    pendingReviewRender = true;
    return;
  }
  pendingReviewRender = false;
  restoreReviewUiState();
  renderAll();
  if (openBatchIndex !== null) {
    const batch = deriveBatchInfo(currentJob, openBatchIndex);
    if (batch) {
      renderSnapshotDialog(currentJob, openBatchIndex);
      if (!snapshotDialog.open) snapshotDialog.showModal();
    } else {
      openBatchIndex = null;
      saveReviewUiState();
      if (snapshotDialog.open) snapshotDialog.close();
    }
  }
  if (snapshotDialog.open && openBatchIndex !== null) {
    renderSnapshotDialog(currentJob, openBatchIndex);
  }
  requestAnimationFrame(() => restoreReviewScrollState());
}

async function fetchJob({ force = false } = {}) {
  if (reviewMutationDepth > 0) return;
  if (reviewFetchInFlight && !force) return;
  const sequence = ++reviewFetchSequence;
  if (force) reviewFetchController?.abort();
  const controller = new AbortController();
  reviewFetchController = controller;
  reviewFetchInFlight = true;
  if (force) setReviewSyncStatus("Syncing…", "syncing");
  try {
    const response = await fetch(`/api/jobs/${jobId}?view=review`, { signal: controller.signal });
    if (sequence !== reviewFetchSequence) return;
    if (!response.ok) {
      if (response.status === 404) {
        titleEl.textContent = "Review Workspace";
        metaEl.textContent = "Job not found";
        tableBody.innerHTML = `<tr><td colspan="7" class="job-meta">Job not found.</td></tr>`;
        sideBody.innerHTML = `<p class="job-meta">This review workspace could not load the job.</p>`;
        setReviewSyncStatus("Job not found", "error");
        return;
      }
      throw new Error(`Server returned ${response.status}`);
    }
    const payload = await response.text();
    if (sequence !== reviewFetchSequence) return;
    const changed = payload !== lastReviewPayload;
    if (changed) {
      currentJob = JSON.parse(payload);
      lastReviewPayload = payload;
      pendingReviewRender = true;
    }
    if (changed || pendingReviewRender || force) applyFetchedReviewJob();
    const recovered = reviewConnectionFailed;
    reviewConnectionFailed = false;
    setReviewSyncStatus(pendingReviewRender ? "Update ready · finish editing" : "Live", pendingReviewRender ? "paused" : "live");
    if (recovered) showReviewToast("Connection restored. Review data is current.", "success");
  } catch (error) {
    if (error?.name === "AbortError") return;
    if (sequence !== reviewFetchSequence) return;
    setReviewSyncStatus("Offline · retrying", "error");
    if (!reviewConnectionFailed) {
      showReviewToast("Could not refresh the job. Your local drafts are preserved while the app retries.", "error");
    }
    reviewConnectionFailed = true;
  } finally {
    if (reviewFetchController === controller) {
      reviewFetchController = null;
      reviewFetchInFlight = false;
    }
  }
}

function pauseReviewPollingForMutation(message = "Saving…") {
  reviewMutationDepth += 1;
  if (reviewMutationDepth === 1) {
    reviewFetchSequence += 1;
    reviewFetchController?.abort();
    reviewFetchController = null;
    reviewFetchInFlight = false;
  }
  setReviewSyncStatus(message, "syncing");
}

function finishReviewMutation({ refresh = true, status = "Live", tone = "live" } = {}) {
  reviewMutationDepth = Math.max(0, reviewMutationDepth - 1);
  if (reviewMutationDepth > 0) return;
  setReviewSyncStatus(status, tone);
  if (refresh) void fetchJob({ force: true });
}

async function saveLine(mode = "save") {
  if (!currentJob || selectedPosition === null || lineActionPending) return;
  lineActionPending = true;
  const currentPosition = selectedPosition;
  const nextPosition = nextVisibleWorkflowPosition(currentJob, currentPosition);
  const priorLine = selectedLine(currentJob);
  const editorValue = document.getElementById("workspace-translation")?.value || "";
  const translation = mode === "remove" ? "" : editorValue;
  lineDrafts.set(lineKey(currentPosition), translation);
  const actionButton = document.getElementById("workspace-save");
  pauseReviewPollingForMutation(mode === "remove" ? "Removing subtitle…" : "Saving line…");
  if (actionButton) {
    actionButton.disabled = true;
    actionButton.setAttribute("aria-busy", "true");
  }
  for (const button of [document.getElementById("workspace-remove"), document.getElementById("workspace-retranslate")]) {
    if (button) button.disabled = true;
  }
  try {
    const response = await fetch(`/api/jobs/${jobId}/lines/${currentPosition}?view=review`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: translation, resolution_mode: mode }),
    });
    if (!response.ok) throw new Error("Could not update subtitle line.");
    currentJob = await response.json();
  } catch (error) {
    if (mode === "remove") lineDrafts.set(lineKey(currentPosition), editorValue);
    showReviewToast(error?.message || "Could not update subtitle line.", "error");
    setReviewSyncStatus("Changes not saved", "error");
    if (actionButton) {
      actionButton.disabled = false;
      actionButton.removeAttribute("aria-busy");
    }
    lineActionPending = false;
    renderSide(currentJob);
    finishReviewMutation({ refresh: false, status: "Changes not saved", tone: "error" });
    return;
  }
  lastReviewPayload = "";
  lineActionPending = false;
  finishReviewMutation();
  lineDrafts.delete(lineKey(currentPosition));
  const updatedLine = getLines(currentJob).find(line => line.position === currentPosition) || null;
  if (
    currentFilter === "suspect"
    && priorLine?.status === "suspect"
    && updatedLine
    && ["auto_fixed", "manual_fixed"].includes(updatedLine.status)
  ) {
    transientSuspectResolved.add(updatedLine.position);
  }
  if (selectedPosition === currentPosition && nextPosition !== null && nextPosition !== currentPosition) {
    selectedPosition = nextPosition;
  }
  renderAll();
  tableBody.querySelector(`[data-row-position="${selectedPosition}"]`)?.scrollIntoView({ block: "nearest" });
}

async function confirmRemoveSelectedSubtitle() {
  if (!currentJob || selectedPosition === null || lineActionPending) return;
  const position = selectedPosition;
  const line = getLines(currentJob).find(item => item.position === position) || null;
  const confirmed = await requestReviewConfirmation({
    title: `Remove subtitle line ${position + 1}?`,
    message: `The translated subtitle text will be cleared from this line. The source timing and source text remain available so you can restore or retranslate it later.${line?.translated_text ? "" : " This line is already empty."}`,
    confirmLabel: "Remove Subtitle",
  });
  if (!confirmed || selectedPosition !== position) return;
  await saveLine("remove");
}

async function saveLineAt(position, text, mode = "save") {
  if (!currentJob) return false;
  const priorLine = getLines(currentJob).find(line => line.position === position) || null;
  let mutationSucceeded = false;
  pauseReviewPollingForMutation("Saving selected lines…");
  try {
    const response = await fetch(`/api/jobs/${jobId}/lines/${position}?view=review`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, resolution_mode: mode }),
    });
    if (!response.ok) throw new Error(`Could not update line ${position + 1}.`);
    currentJob = await response.json();
    lastReviewPayload = "";
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
    mutationSucceeded = true;
    return true;
  } catch (error) {
    showReviewToast(error?.message || `Could not update line ${position + 1}.`, "error");
    return false;
  } finally {
    finishReviewMutation({
      refresh: false,
      status: mutationSucceeded ? "Live" : "Changes not saved",
      tone: mutationSucceeded ? "live" : "error",
    });
  }
}

async function retranslateLineAt(position, instruction = "") {
  if (!currentJob || position === null || position === undefined) return false;
  const nextPosition = nextVisibleWorkflowPosition(currentJob, position);
  const priorLine = getLines(currentJob).find(line => line.position === position) || null;
  let mutationSucceeded = false;
  instructionDrafts.set(lineKey(position), instruction);
  pauseReviewPollingForMutation("Retranslating line…");
  try {
    const response = await fetch(`/api/jobs/${jobId}/lines/${position}/retranslate?view=review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ extra_instruction: instruction }),
    });
    if (!response.ok) throw new Error("Could not retranslate subtitle line.");
    const data = await response.json();
    currentJob = data.job;
    lastReviewPayload = "";
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
    if (selectedPosition === position && nextPosition !== null && nextPosition !== position) selectedPosition = nextPosition;
    renderAll();
    tableBody.querySelector(`[data-row-position="${selectedPosition}"]`)?.scrollIntoView({ block: "nearest" });
    mutationSucceeded = true;
    return true;
  } catch (error) {
    showReviewToast(error?.message || "Could not retranslate subtitle line.", "error");
    return false;
  } finally {
    finishReviewMutation({
      refresh: false,
      status: mutationSucceeded ? "Live" : "Retranslation failed",
      tone: mutationSucceeded ? "live" : "error",
    });
  }
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
  bulkActionPending = true;
  pauseReviewPollingForMutation("Resolving selected lines…");
  try {
    for (const position of positions) {
      const line = getLines(currentJob).find(item => item.position === position);
      const text = lineDrafts.get(lineKey(position)) ?? line?.translated_text ?? "";
      const ok = await saveLineAt(position, text, "resolve");
      if (!ok) {
        showReviewToast(`Stopped at line ${position + 1}; earlier successful changes were kept.`, "error");
        break;
      }
    }
  } finally {
    bulkActionPending = false;
    finishReviewMutation();
    if (button) {
      button.textContent = "Resolve Selected";
    }
    renderAll();
  }
}

async function bulkRetranslateSelected(extraInstruction = "") {
  const selected = selectedVisiblePositions(currentJob);
  const sourcePositions = new Set(getLines(currentJob).filter(line => line.has_source).map(line => line.position));
  const positions = selected.filter(position => sourcePositions.has(position));
  if (!positions.length) return;
  if (positions.length < selected.length) {
    showReviewToast(`${selected.length - positions.length} extra-output cue(s) skipped because they have no source line.`, "warning");
  }
  const button = document.getElementById("workspace-bulk-retranslate");
  const instruction = extraInstruction;
  if (button) {
    button.disabled = true;
    button.textContent = "Retranslating...";
  }
  bulkActionPending = true;
  pauseReviewPollingForMutation("Retranslating selected lines…");
  try {
    for (const position of positions) {
      const ok = await retranslateLineAt(position, instruction);
      if (!ok) {
        showReviewToast(`Stopped at line ${position + 1}; earlier successful retranslations were kept.`, "error");
        break;
      }
    }
  } finally {
    bulkActionPending = false;
    finishReviewMutation();
    if (button) {
      button.textContent = "Retranslate Selected";
    }
    renderAll();
  }
}

function clearSelectedRows() {
  if (reviewActionBusy()) return;
  selectedPositions.clear();
  selectionAnchorPosition = null;
  syncRenderedSelection(selectedPosition);
}

function syncRenderedSelection(focusPosition = null) {
  for (const row of tableBody.querySelectorAll("[data-row-position]")) {
    const position = Number(row.dataset.rowPosition);
    const current = position === selectedPosition;
    const marked = selectedPositions.has(position);
    row.classList.toggle("is-selected", current);
    row.classList.toggle("is-marked", marked);
    row.tabIndex = current ? 0 : -1;
    row.setAttribute("aria-selected", String(current || marked));
  }
  renderSide(currentJob);
  if (sideBody) sideBody.scrollTop = 0;
  scheduleReviewUiSave();
  requestAnimationFrame(() => {
    if (focusPosition === null) return;
    tableBody.querySelector(`[data-row-position="${focusPosition}"]`)?.focus({ preventScroll: true });
  });
}

function applyRowSelection(position, event) {
  if (reviewActionBusy()) return;
  const rows = [...tableBody.querySelectorAll("[data-row-position]")].map(row => Number(row.dataset.rowPosition));
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
  syncRenderedSelection(position);
  requestAnimationFrame(() => {
    const selectedRow = tableBody.querySelector(`[data-row-position="${position}"]`);
    if (window.matchMedia("(max-width: 960px)").matches && event.type === "click") {
      sidePanel?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  });
}

function jumpToLine(rawLine) {
  if (!currentJob) return;
  const lineNumber = Number(rawLine);
  const position = Math.trunc(lineNumber) - 1;
  const exists = getLines(currentJob).some(line => Number(line.position) === position);
  if (!Number.isFinite(position) || position < 0 || !exists) {
    showReviewToast(`Line ${rawLine || "?"} is outside this subtitle.`, "error");
    jumpLineEl?.focus();
    return;
  }
  if (currentFilter !== "all" || currentSearch) {
    currentFilter = "all";
    currentSearch = "";
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete("filter");
    window.history.replaceState(null, "", nextUrl);
    if (searchEl) searchEl.value = "";
    showReviewToast("Cleared the current filter to reveal that line.");
  }
  selectedPosition = position;
  selectedPositions.clear();
  selectedPositions.add(position);
  selectionAnchorPosition = position;
  renderAll();
  requestAnimationFrame(() => {
    const row = tableBody.querySelector(`[data-row-position="${position}"]`);
    row?.scrollIntoView({ block: "center", behavior: "smooth" });
    row?.focus({ preventScroll: true });
  });
}

async function retranslateLine() {
  if (!currentJob || selectedPosition === null || lineActionPending) return;
  if (!selectedLine(currentJob)?.has_source) {
    showReviewToast("This extra output has no source cue to retranslate. Edit or remove it instead.", "warning");
    return;
  }
  const instruction = document.getElementById("workspace-instruction")?.value || "";
  lineActionPending = true;
  renderSide(currentJob);
  try {
    await retranslateLineAt(selectedPosition, instruction);
  } finally {
    lineActionPending = false;
    renderSide(currentJob);
  }
}

function snapshotDraftKey(batchIndex) {
  return `${jobId}:batch:${batchIndex}`;
}

function renderSnapshotDialog(job, batchIndex) {
  const batch = loadedBatchSnapshots.get(Number(batchIndex)) || deriveBatchInfo(job, batchIndex);
  snapshotTitle.textContent = `Batch ${batchIndex} Card`;
  if (!batch) {
    snapshotBody.innerHTML = `<p class="job-meta">No batch data available.</p>`;
    saveSnapshotBtn.disabled = true;
    generateSnapshotBtn.disabled = true;
    return;
  }
  const draftKey = snapshotDraftKey(batchIndex);
  const currentDraft = contextDrafts.get(draftKey) || normalizeContextInput(batch.input_context || batch.session_context || job.session_context || {});
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
  const operationPending = batchCardOperationToken !== 0;
  saveSnapshotBtn.disabled = operationPending;
  generateSnapshotBtn.disabled = operationPending;
}

async function openSelectedBatchCard() {
  const line = selectedLine(currentJob);
  if (!currentJob || !line || !line.has_source || batchCardOperationToken !== 0) return;
  const batchIndex = line.batch_index;
  openBatchIndex = batchIndex;
  snapshotTitle.textContent = `Batch ${batchIndex} Card`;
  snapshotBody.innerHTML = `<p class="job-meta">Loading this Batch Card…</p>`;
  saveSnapshotBtn.disabled = true;
  generateSnapshotBtn.disabled = true;
  if (!snapshotDialog.open) snapshotDialog.showModal();
  saveReviewUiState();
  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/batch-context/${batchIndex}`);
    if (!response.ok) throw new Error("Could not load this Batch Card.");
    const batch = await response.json();
    if (openBatchIndex !== batchIndex || !snapshotDialog.open) return;
    loadedBatchSnapshots.set(Number(batchIndex), batch);
    renderSnapshotDialog(currentJob, batchIndex);
  } catch (error) {
    if (openBatchIndex !== batchIndex || !snapshotDialog.open) return;
    snapshotBody.innerHTML = `<p class="job-meta">${escapeHtml(error?.message || "Could not load this Batch Card.")} Close this panel and try again.</p>`;
    showReviewToast(error?.message || "Could not load this Batch Card.", "error");
  }
}

async function saveBatchCard() {
  if (!currentJob || openBatchIndex === null || batchCardOperationToken !== 0) return;
  const batchIndex = openBatchIndex;
  const operationToken = Date.now() + Math.random();
  batchCardOperationToken = operationToken;
  const payload = normalizeContextInput(readContextEditor("workspace-snapshot", snapshotBody));
  pauseReviewPollingForMutation("Saving Batch Card…");
  saveSnapshotBtn.disabled = true;
  generateSnapshotBtn.disabled = true;
  saveSnapshotBtn.setAttribute("aria-busy", "true");
  let response;
  try {
    response = await fetch(`/api/jobs/${jobId}/batch-context/${batchIndex}?view=review`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_context: payload }),
    });
    if (!response.ok) throw new Error("Could not update Batch Card.");
    currentJob = await response.json();
    const loadedBatch = loadedBatchSnapshots.get(Number(batchIndex));
    loadedBatchSnapshots.set(Number(batchIndex), {
      ...(loadedBatch || deriveBatchInfo(currentJob, batchIndex) || {}),
      input_context: payload,
      has_snapshot: true,
    });
  } catch (error) {
    showReviewToast(error?.message || "Could not update Batch Card.", "error");
    finishReviewMutation({ refresh: false, status: "Batch Card not saved", tone: "error" });
    if (batchCardOperationToken === operationToken) batchCardOperationToken = 0;
    saveSnapshotBtn.disabled = false;
    generateSnapshotBtn.disabled = false;
    saveSnapshotBtn.removeAttribute("aria-busy");
    return;
  }
  lastReviewPayload = "";
  contextDrafts.delete(snapshotDraftKey(batchIndex));
  if (batchCardOperationToken === operationToken) batchCardOperationToken = 0;
  if (openBatchIndex === batchIndex && snapshotDialog.open) renderSnapshotDialog(currentJob, batchIndex);
  renderAll();
  finishReviewMutation();
  saveSnapshotBtn.removeAttribute("aria-busy");
  showReviewToast("Batch Card saved.", "success");
}

async function generateBatchCard() {
  if (!currentJob || openBatchIndex === null || batchCardOperationToken !== 0) return;
  const batchIndex = openBatchIndex;
  const operationToken = Date.now() + Math.random();
  batchCardOperationToken = operationToken;
  pauseReviewPollingForMutation("Generating Batch Card…");
  generateSnapshotBtn.disabled = true;
  saveSnapshotBtn.disabled = true;
  generateSnapshotBtn.setAttribute("aria-busy", "true");
  generateSnapshotBtn.textContent = "Generating…";
  let response;
  try {
    response = await fetch(`/api/jobs/${jobId}/batch-context/${batchIndex}/generate`, { method: "POST" });
    if (!response.ok) throw new Error("Could not generate Batch Card.");
    const data = await response.json();
    contextDrafts.set(snapshotDraftKey(batchIndex), normalizeContextInput(data.session_context));
  } catch (error) {
    showReviewToast(error?.message || "Could not generate Batch Card.", "error");
    finishReviewMutation({ refresh: false, status: "Batch Card generation failed", tone: "error" });
    if (batchCardOperationToken === operationToken) batchCardOperationToken = 0;
    generateSnapshotBtn.disabled = false;
    saveSnapshotBtn.disabled = false;
    generateSnapshotBtn.removeAttribute("aria-busy");
    generateSnapshotBtn.textContent = "Generate Card";
    return;
  }
  if (batchCardOperationToken === operationToken) batchCardOperationToken = 0;
  if (openBatchIndex === batchIndex && snapshotDialog.open) renderSnapshotDialog(currentJob, batchIndex);
  finishReviewMutation();
  generateSnapshotBtn.removeAttribute("aria-busy");
  generateSnapshotBtn.textContent = "Generate Card";
  showReviewToast("Generated a new Batch Card draft. Review it, then save when ready.", "success");
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
    .filter(line => line.has_source && (line.status === "suspect" || line.status === "error"))
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
  return orderedRows[currentIndex + 1]?.position ?? null;
}

async function autoRewriteAllFlagged() {
  if (!currentJob) return;
  if (autoRewritePending) {
    autoRewriteAbort = true;
    return;
  }
  const queue = visibleFlaggedPositions(currentJob);
  if (!queue.length) return;
  const skippedExtras = filteredLines(currentJob).filter(
    line => !line.has_source && (line.status === "suspect" || line.status === "error"),
  ).length;
  const confirmed = await requestReviewConfirmation({
    title: `Retranslate ${queue.length} flagged line${queue.length === 1 ? "" : "s"}?`,
    message: `Auto Rewrite will process the visible suspect and error lines one by one using the current filter and search. This may make several model calls; you can stop after it begins.${skippedExtras ? ` ${skippedExtras} extra-output cue(s) without a source line will be left for manual review.` : ""}`,
    confirmLabel: "Start Auto Rewrite",
    tone: "warning",
  });
  if (!confirmed) return;
  autoRewritePending = true;
  autoRewriteAbort = false;
  autoRewriteProgress = { current: 0, total: queue.length, succeeded: 0 };
  pauseReviewPollingForMutation("Auto Rewrite in progress…");
  renderAll();
  try {
    for (let index = 0; index < queue.length; index += 1) {
      const position = queue[index];
      if (autoRewriteAbort) break;
      const stillFlagged = visibleFlaggedPositions(currentJob).includes(position);
      if (!stillFlagged) continue;
      autoRewriteProgress.current = index + 1;
      selectedPosition = position;
      setReviewSyncStatus(`Auto Rewrite ${autoRewriteProgress.current}/${autoRewriteProgress.total}`, "syncing");
      renderAll();
      const row = tableBody.querySelector(`[data-row-position="${selectedPosition}"]`);
      row?.scrollIntoView({ block: "nearest" });
      const ok = await retranslateLineAt(position, "");
      if (!ok) break;
      autoRewriteProgress.succeeded += 1;
    }
  } finally {
    const stopped = autoRewriteAbort;
    const { succeeded = 0, total = queue.length } = autoRewriteProgress || {};
    autoRewritePending = false;
    autoRewriteAbort = false;
    autoRewriteProgress = null;
    finishReviewMutation();
    renderAll();
    showReviewToast(
      stopped
        ? `Auto Rewrite stopped after ${succeeded} of ${total} line${total === 1 ? "" : "s"}.`
        : `Auto Rewrite finished: ${succeeded} of ${total} line${total === 1 ? "" : "s"} updated.`,
      stopped || succeeded < total ? "warning" : "success",
    );
  }
}

function removeContextRow(scope, button) {
  const row = button.closest("[data-editor-row]");
  if (!row) return;
  row.remove();
  if (openBatchIndex !== null) {
    contextDrafts.set(snapshotDraftKey(openBatchIndex), normalizeContextInput(readContextEditor(scope, snapshotBody)));
    scheduleReviewUiSave();
  }
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
    const nextUrl = new URL(window.location.href);
    if (nextFilter === "all") nextUrl.searchParams.delete("filter");
    else nextUrl.searchParams.set("filter", nextFilter);
    window.history.replaceState(null, "", nextUrl);
    renderAll();
    if (previousSelectedPosition !== null) {
      const previousRow = tableBody.querySelector(`[data-row-position="${previousSelectedPosition}"]`);
      previousRow?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    return;
  }
  const row = event.target.closest("[data-row-position]");
  if (row) {
    const selection = window.getSelection();
    if (selection && String(selection.toString() || "").trim() && row.contains(selection.anchorNode) && row.contains(selection.focusNode)) {
      return;
    }
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
    const mode = event.target.dataset.mode || "save";
    if (mode === "remove") void confirmRemoveSelectedSubtitle();
    else void saveLine(mode);
    return;
  }
  if (event.target.id === "workspace-remove") {
    void confirmRemoveSelectedSubtitle();
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
    void openSelectedBatchCard();
    return;
  }
  if (event.target.closest("[data-review-return-list]")) {
    const row = selectedPosition === null ? null : tableBody.querySelector(`[data-row-position="${selectedPosition}"]`);
    row?.scrollIntoView({ block: "center", behavior: "smooth" });
    window.setTimeout(() => row?.focus({ preventScroll: true }), 220);
  }
});

document.addEventListener("change", (event) => {
  const toggle = event.target.closest("[data-column-visible]");
  if (toggle) {
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
    return;
  }
  const widthInput = event.target.closest("[data-column-width]");
  if (!widthInput) return;
  const column = reviewColumnState.find(item => item.key === widthInput.dataset.columnWidth);
  if (!column) return;
  column.width = Math.max(48, Math.min(720, Number(widthInput.value) || column.width));
  saveReviewColumnState();
  if (currentJob) renderTable(currentJob);
});

document.addEventListener("click", (event) => {
  const moveButton = event.target.closest("[data-column-move][data-column-key]");
  if (!moveButton) return;
  const index = reviewColumnState.findIndex(item => item.key === moveButton.dataset.columnKey);
  const offset = moveButton.dataset.columnMove === "left" ? -1 : 1;
  const nextIndex = index + offset;
  if (index < 0 || nextIndex < 0 || nextIndex >= reviewColumnState.length) return;
  [reviewColumnState[index], reviewColumnState[nextIndex]] = [reviewColumnState[nextIndex], reviewColumnState[index]];
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

function cancelColumnResize() {
  if (!resizingColumn) return;
  resizingColumn = null;
  document.body.classList.remove("is-resizing-review-column");
  saveReviewColumnState();
}

window.addEventListener("pointercancel", cancelColumnResize);
window.addEventListener("blur", cancelColumnResize);

document.addEventListener("keydown", (event) => {
  const handle = event.target instanceof Element ? event.target.closest("[data-column-resize]") : null;
  if (!handle || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  const column = reviewColumnState.find(item => item.key === handle.dataset.columnResize);
  if (!column) return;
  event.preventDefault();
  const direction = event.key === "ArrowLeft" ? -1 : 1;
  column.width = Math.max(48, Math.min(720, column.width + direction * (event.shiftKey ? 32 : 8)));
  saveReviewColumnState();
  if (currentJob) renderTable(currentJob);
  requestAnimationFrame(() => tableHeader?.querySelector(`[data-column-resize="${CSS.escape(column.key)}"]`)?.focus());
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
    scheduleReviewUiSave();
    return;
  }
  if (event.target.id === "workspace-instruction" && selectedPosition !== null) {
    instructionDrafts.set(lineKey(selectedPosition), event.target.value);
    scheduleReviewUiSave();
    return;
  }
  if (snapshotDialog.open && event.target.closest("[data-context-field], [data-context-character], [data-context-glossary]")) {
    contextDrafts.set(snapshotDraftKey(openBatchIndex), normalizeContextInput(readContextEditor("workspace-snapshot", snapshotBody)));
    syncContextPreview("workspace-snapshot", snapshotBody);
    scheduleReviewUiSave();
  }
});

searchEl.addEventListener("input", () => {
  currentSearch = searchEl.value || "";
  renderAll();
  scheduleReviewUiSave();
});
refreshBtn.addEventListener("click", () => void fetchJob({ force: true }));
prevFlaggedBtn.addEventListener("click", () => jumpFlagged(-1));
nextFlaggedBtn.addEventListener("click", () => jumpFlagged(1));
autoRewriteNextBtn?.addEventListener("click", () => void autoRewriteAllFlagged());
saveSnapshotBtn.addEventListener("click", () => void saveBatchCard());
generateSnapshotBtn.addEventListener("click", () => void generateBatchCard());
snapshotDialog.addEventListener("close", () => {
  const preservedDraft = openBatchIndex !== null && contextDrafts.has(snapshotDraftKey(openBatchIndex));
  openBatchIndex = null;
  saveReviewUiState();
  if (preservedDraft) showReviewToast("Unsaved Batch Card draft preserved. Reopen the card to continue editing.");
});
snapshotDialog.addEventListener("click", (event) => {
  if (event.target === snapshotDialog && snapshotDialog.open) {
    snapshotDialog.close();
  }
});
document.addEventListener("scroll", scheduleReviewScrollSave, { passive: true });
window.addEventListener("scroll", scheduleReviewScrollSave, { passive: true });
window.addEventListener("pagehide", saveReviewScrollState, { passive: true });
window.addEventListener("beforeunload", saveReviewScrollState, { passive: true });
reviewScrollContainer()?.addEventListener("scroll", scheduleReviewScrollSave, { passive: true });
sideBody?.addEventListener("scroll", scheduleReviewScrollSave, { passive: true });
document.addEventListener("change", scheduleReviewUiSave, true);

document.addEventListener("toggle", (event) => {
  const rawEditor = event.target.closest?.("[data-raw-editor-position]");
  if (!rawEditor) return;
  const position = Number(rawEditor.dataset.rawEditorPosition);
  if (!Number.isFinite(position)) return;
  if (rawEditor.open) rawEditorOpenPositions.add(position);
  else rawEditorOpenPositions.delete(position);
  scheduleReviewUiSave();
}, true);

for (const button of densityButtons) {
  button.addEventListener("click", () => {
    reviewDensity = button.dataset.reviewDensity === "compact" ? "compact" : "comfortable";
    applyReviewDensity();
    scheduleReviewUiSave();
  });
}

jumpLineEl?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  jumpToLine(jumpLineEl.value);
});

document.addEventListener("keydown", (event) => {
  const target = event.target;
  const isTyping = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
  if (reviewConfirmDialog?.open) return;
  if (event.key === "/" && !isTyping && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    searchEl.focus();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && snapshotDialog.open) {
    event.preventDefault();
    saveSnapshotBtn?.click();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && document.getElementById("workspace-save")) {
    event.preventDefault();
    document.getElementById("workspace-save")?.click();
    return;
  }
  const row = target instanceof Element ? target.closest("[data-row-position]") : null;
  if (!row || !["ArrowUp", "ArrowDown", "Enter", " "].includes(event.key)) return;
  event.preventDefault();
  const positions = filteredLines(currentJob).map(line => line.position);
  const current = Number(row.dataset.rowPosition);
  if (event.key === "Enter" || event.key === " ") {
    applyRowSelection(current, event);
    return;
  }
  const currentIndex = positions.indexOf(current);
  const nextIndex = Math.max(0, Math.min(positions.length - 1, currentIndex + (event.key === "ArrowDown" ? 1 : -1)));
  const next = positions[nextIndex];
  if (Number.isFinite(next)) {
    applyRowSelection(next, event);
    requestAnimationFrame(() => tableBody.querySelector(`[data-row-position="${next}"]`)?.scrollIntoView({ block: "nearest" }));
  }
});

snapshotDialog.querySelector("form")?.addEventListener("submit", (event) => {
  event.preventDefault();
});
snapshotDialog.querySelector("[data-dialog-close]")?.addEventListener("click", () => snapshotDialog.close("cancel"));
reviewConfirmSubmit?.addEventListener("click", () => settleReviewConfirmation(true));
reviewConfirmCancel?.addEventListener("click", () => settleReviewConfirmation(false));
reviewConfirmDialog?.addEventListener("click", event => {
  if (event.target === reviewConfirmDialog && reviewConfirmDialog.open) settleReviewConfirmation(false);
});
reviewConfirmDialog?.addEventListener("cancel", event => {
  event.preventDefault();
  settleReviewConfirmation(false);
});
reviewConfirmDialog?.addEventListener("close", () => {
  if (!pendingReviewConfirmationResolve) return;
  const resolve = pendingReviewConfirmationResolve;
  pendingReviewConfirmationResolve = null;
  resolve(reviewConfirmDialog.returnValue === "confirm");
});

window.addEventListener("pagehide", saveReviewUiState, { passive: true });
window.addEventListener("beforeunload", saveReviewUiState, { passive: true });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    reviewFetchController?.abort();
    setReviewSyncStatus("Paused in background", "paused");
  } else {
    void fetchJob({ force: true });
  }
});
document.addEventListener("focusout", () => {
  if (!pendingReviewRender) return;
  window.setTimeout(() => {
    if (!pendingReviewRender || reviewHasActiveEditor() || reviewMutationDepth > 0) return;
    applyFetchedReviewJob();
    setReviewSyncStatus("Live", "live");
  }, 0);
});

applyReviewDensity();
void fetchJob();
setInterval(() => {
  if (!document.hidden) void fetchJob();
}, 2500);
