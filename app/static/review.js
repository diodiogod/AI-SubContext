const titleEl = document.getElementById("review-page-title");
const metaEl = document.getElementById("review-page-meta");
const refreshBtn = document.getElementById("review-page-refresh");
const filtersEl = document.getElementById("review-page-filters");
const searchEl = document.getElementById("review-search");
const prevFlaggedBtn = document.getElementById("review-prev-flagged");
const nextFlaggedBtn = document.getElementById("review-next-flagged");
const autoRewriteNextBtn = document.getElementById("review-auto-rewrite-next");
const summaryEl = document.getElementById("review-table-summary");
const tableBody = document.getElementById("review-table-body");
const sideBody = document.getElementById("review-side-body");
const snapshotDialog = document.getElementById("review-snapshot-dialog");
const snapshotTitle = document.getElementById("review-snapshot-title");
const snapshotBody = document.getElementById("review-snapshot-body");
const saveSnapshotBtn = document.getElementById("review-save-snapshot");
const generateSnapshotBtn = document.getElementById("review-generate-snapshot");

const jobId = window.location.pathname.split("/").filter(Boolean).pop();
let currentJob = null;
let currentFilter = "suspect";
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

function escapeHtml(value) {
  return String(value ?? "")
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

function statusBadge(status) {
  return `<span class="badge ${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

function tooltipTag(label, tooltip, className = "inline-badge") {
  return `<span class="${className} tooltip-tag" title="${escapeHtml(tooltip)}">${escapeHtml(label)}</span>`;
}

function compactReasonLabel(reason) {
  return {
    source_leak: "Source Leak",
    missing_output: "Missing Output",
    unchanged: "Unchanged",
    manual: "Manual",
    retry_fixed: "Retry Fixed",
    other: "Other",
  }[reason] || "Other";
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
      ${snapshot.premise ? `<div class="tile"><div class="mini-eyebrow">Premise</div><p>${escapeHtml(snapshot.premise)}</p></div>` : ""}
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

function lineStatus(issue) {
  if (!issue) return "normal";
  return issue.status || "normal";
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
  return (job.original_lines || []).map(line => {
    const position = Number(line.position);
    const issue = issueMap.get(position) || null;
    const status = lineStatus(issue);
    const reasonTags = inferReasonTags(issue);
    return {
      position,
      source_text: line.text || "",
      start_time: line.start_time || "",
      end_time: line.end_time || "",
      translated_text: translatedMap.get(position) || "",
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
    if (currentFilter === "normal" && line.status !== "normal") return false;
    if (currentSearch) {
      const haystack = [
        line.source_text,
        lineDrafts.get(lineKey(line.position)) ?? line.translated_text,
        line.status,
        ...line.reason_tags.map(compactReasonLabel),
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
    ["normal", "Normal"],
  ];
  filtersEl.innerHTML = names.map(([key, label]) => `
    <button
      type="button"
      class="review-filter ${currentFilter === key ? "is-active" : ""}"
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

function renderTable(job) {
  const rows = filteredLines(job);
  summaryEl.textContent = `${rows.length} line(s) visible`;
  if (!rows.length) {
    tableBody.innerHTML = `<tr><td colspan="7" class="job-meta">No lines in this filter.</td></tr>`;
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
        <td>${escapeHtml(String(line.position + 1))}</td>
        <td><div class="table-time">${escapeHtml(timeLabel)}</div></td>
        <td>${statusBadge(line.status)}</td>
        <td><div class="table-reasons">${renderReasonTags(line.reason_tags)}</div></td>
        <td><div class="table-copy">${escapeHtml(line.source_text)}</div></td>
        <td><div class="table-copy">${escapeHtml(translated)}</div></td>
        <td>${escapeHtml(String(line.batch_index))}</td>
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
      <p>${escapeHtml(line.source_text)}</p>
    </div>
    <label class="review-edit">
      <strong>Translation</strong>
      <textarea id="workspace-translation">${escapeHtml(draft)}</textarea>
    </label>
    <label class="review-instruction">
      <strong>Retranslate Instruction</strong>
      <input id="workspace-instruction" type="text" value="${escapeHtml(instruction)}" placeholder="Optional instruction for this line only" />
    </label>
    ${notes.length ? `<div class="issue-notes">${notes.map(note => `<div>${escapeHtml(note)}</div>`).join("")}</div>` : ""}
    <div class="review-actions">
      <button type="button" class="ghost" id="workspace-batch-card">Batch Card</button>
      <button type="button" class="ghost" id="workspace-retranslate">${job.status === "processing" || job.status === "queued" ? "Queue Retranslate" : "Retranslate"}</button>
      <button type="button" id="workspace-save" data-mode="${escapeHtml(action.mode)}">${escapeHtml(action.label)}</button>
      <button type="button" class="ghost" id="workspace-remove">Remove Subtitle</button>
    </div>
  `;
}

function renderHeader(job) {
  titleEl.textContent = job.title || job.filename || "Review";
  metaEl.textContent = `${job.filename || "Job"} • ${job.settings?.source_language || "src"} → ${job.settings?.target_language || "tgt"} • ${job.settings?.model || "model"}`;
}

function renderAll() {
  if (!currentJob) return;
  renderHeader(currentJob);
  renderFilters(currentJob);
  updateToolbarState(currentJob);
  renderTable(currentJob);
  renderSide(currentJob);
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
    activeEditor.closest("#review-snapshot-dialog")
  );
  if (!isEditing) {
    renderAll();
    if (snapshotDialog.open && openBatchIndex !== null) {
      renderSnapshotDialog(currentJob, openBatchIndex);
    }
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
    if (currentFilter === "suspect" && nextFilter !== "suspect") {
      clearTransientSuspectResolved();
    }
    currentFilter = nextFilter;
    renderAll();
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
  }
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
});

void fetchJob();
setInterval(fetchJob, 2500);
