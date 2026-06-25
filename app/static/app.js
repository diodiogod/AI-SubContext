const STORAGE_KEY = "ai-subcontext-settings";
const MODEL_HISTORY_KEY = "ai-subcontext-model-history";
const MODEL_CALL_STATS_KEY = "ai-subcontext-model-call-stats";
const LANGUAGE_TIPS_HISTORY_KEY = "ai-subcontext-language-tips-history";
const MAX_MODEL_HISTORY = 10;
const MAX_LANGUAGE_TIPS_HISTORY = 20;
const LANGUAGE_TIPS_TARGET_SETUP = "setup";
const LANGUAGE_TIPS_TARGET_MAIN = "context-main";
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
const visionEvidenceDialog = document.getElementById("vision-evidence-dialog");
const visionEvidenceDialogTitle = document.getElementById("vision-evidence-dialog-title");
const visionEvidenceDialogBody = document.getElementById("vision-evidence-dialog-body");
const visionEvidencePrev = document.getElementById("vision-evidence-prev");
const visionEvidenceNext = document.getElementById("vision-evidence-next");
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
const videoFileInput = document.getElementById("video_file");
const dropZone = document.getElementById("drop-zone");
const translatedDropZone = document.getElementById("translated-drop-zone");
const videoDropZone = document.getElementById("video-file-picker");
const selectedFile = document.getElementById("selected-file");
const selectedTranslatedFile = document.getElementById("selected-translated-file");
const selectedVideoFile = document.getElementById("selected-video-file");
const referenceTracksCard = document.querySelector(".reference-tracks-card");
const referenceTracksEl = document.getElementById("reference-tracks");
const addReferenceTrackBtn = document.getElementById("add-reference-track-btn");
const modelInput = document.getElementById("model");
const modelHistory = document.getElementById("model-history");
const modelSelect = document.getElementById("model-select");
const loadModelsBtn = document.getElementById("load-models-btn");
const modelListStatus = document.getElementById("model-list-status");
const testConnectionBtn = document.getElementById("test-connection-btn");
const reviewExistingBtn = document.getElementById("review-existing-btn");
const connectionTestResult = document.getElementById("connection-test-result");
const initialCardStrategyInput = document.getElementById("initial_card_strategy");
const initialCardMaxCharsInput = document.getElementById("initial_card_max_chars");
const initialCardEstimate = document.getElementById("initial-card-estimate");
const adaptiveVisionInput = document.getElementById("adaptive_vision");
const visualSceneContextInput = document.getElementById("visual_scene_context");
const visionControls = document.getElementById("vision-controls");
const sceneVisionControls = document.getElementById("scene-vision-controls");
const adaptiveVisionControls = document.getElementById("adaptive-vision-controls");
const visionReadiness = document.getElementById("vision-readiness");
const resetPromptLabBtn = document.getElementById("reset-prompt-lab-btn");
const consoleTabButtons = [...document.querySelectorAll("[data-console-tab]")];
const consoleTabPanels = [...document.querySelectorAll("[data-console-panel]")];

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
const contextLanguageTipsDrafts = new Map();
let referenceTrackCounter = 0;
let initialCardEstimateToken = 0;
let sourceSubtitleTextStats = null;
let runtimeDefaults = {};
let createJobInFlight = false;
const expandedContextHistory = new Set();
const renderedContextSnapshots = new Map();
const modelCallParserState = new Map();
const modelCallRenderedState = new Map();
const modelCallAnimation = { jobId: null, rafId: null };
const logDialogTabs = new Map();
const logDialogReadingState = new Map();
const visionRailScrollState = new Map();
const seenVisionFrameIds = new Set();
const VIDEO_FILE_EXTENSIONS = new Set(["mp4", "mkv", "webm", "mov", "avi", "m4v", "ts"]);
const jobsById = new Map();
let openVisionEvidenceJobId = null;
let openVisionEvidenceFrameId = null;

function readModelCallStats() {
  const raw = localStorage.getItem(MODEL_CALL_STATS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

let modelCallStats = readModelCallStats();

function writeModelCallStats() {
  localStorage.setItem(MODEL_CALL_STATS_KEY, JSON.stringify(modelCallStats));
}

function modelCallSignature(job) {
  const model = String(job?.settings?.model || "unknown").trim() || "unknown";
  const batchSize = Math.max(1, Number(job?.settings?.batch_size || 0) || 0);
  return `${model}::b${batchSize}`;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function formatMediaTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function updateVisionRailFocus(rail) {
  if (!rail) return;
  const frames = [...rail.querySelectorAll(".vision-frame")];
  if (!frames.length) return;
  const railRect = rail.getBoundingClientRect();
  const focusCenter = railRect.left + (railRect.width / 2);
  const expanded = Boolean(rail.closest(".vision-timeline.expanded"));
  const minWidth = expanded ? 118 : 68;
  const maxWidth = expanded ? 190 : 116;
  const focusRange = Math.max(railRect.width * 0.58, 180);

  for (const frame of frames) {
    const frameRect = frame.getBoundingClientRect();
    const frameCenter = frameRect.left + (frameRect.width / 2);
    const distance = Math.abs(frameCenter - focusCenter);
    const focus = Math.max(0, 1 - (distance / focusRange));
    const easedFocus = focus * focus * (3 - (2 * focus));
    const width = minWidth + ((maxWidth - minWidth) * easedFocus);
    const opacity = 0.52 + (0.48 * focus);
    frame.style.setProperty("--frame-focus-width", `${width.toFixed(1)}px`);
    frame.style.setProperty("--frame-opacity", opacity.toFixed(2));
  }
}

function scheduleVisionRailFocus(rail) {
  if (!rail || rail.dataset.focusFramePending === "true") return;
  rail.dataset.focusFramePending = "true";
  requestAnimationFrame(() => {
    rail.dataset.focusFramePending = "false";
    updateVisionRailFocus(rail);
  });
}

function rememberVisionRailScroll(rail) {
  const railKey = rail?.dataset?.visionRailKey;
  if (!railKey) return;
  const maxScroll = Math.max(0, rail.scrollWidth - rail.clientWidth);
  visionRailScrollState.set(railKey, {
    scrollLeft: rail.scrollLeft,
    followLatest: maxScroll - rail.scrollLeft <= 24,
  });
}

function captureVisionRailScrolls(root = document) {
  for (const rail of root.querySelectorAll(".vision-rail")) {
    rememberVisionRailScroll(rail);
  }
}

function refreshVisionRails(root = document) {
  for (const rail of root.querySelectorAll(".vision-rail")) {
    const railKey = rail.dataset.visionRailKey;
    if (railKey) {
      const saved = visionRailScrollState.get(railKey);
      if (saved) {
        const maxScroll = Math.max(0, rail.scrollWidth - rail.clientWidth);
        rail.scrollLeft = saved.followLatest ? maxScroll : Math.min(saved.scrollLeft, maxScroll);
      } else {
        rail.scrollLeft = Math.max(0, rail.scrollWidth - rail.clientWidth);
        visionRailScrollState.set(railKey, {
          scrollLeft: rail.scrollLeft,
          followLatest: true,
        });
      }
    }
    updateVisionRailFocus(rail);
  }
}

function renderVisionTimeline(job, compact = false, location = "timeline") {
  const frames = Array.isArray(job?.visual_frames) ? job.visual_frames : [];
  if (!frames.length) return "";
  const ordered = [...frames].sort((a, b) => {
    const timeDelta = Number(a.timestamp_ms || 0) - Number(b.timestamp_ms || 0);
    return timeDelta || Number(a.batch_index || 0) - Number(b.batch_index || 0);
  });
  const visible = compact ? ordered.slice(-24) : ordered.slice(-80);
  const newestId = visible[visible.length - 1]?.id;
  const stats = job?.vision_stats || {};
  return `
    <section class="vision-timeline ${compact ? "compact" : "expanded"}">
      <div class="vision-timeline-head">
        <div>
          <div class="mini-eyebrow">Visual Evidence</div>
          <div class="job-meta">${escapeHtml(String(frames.length))} frame${frames.length === 1 ? "" : "s"} collected for scene guides and targeted evidence</div>
        </div>
        <div class="vision-timeline-stats">
          <span title="Calls: number of batches that triggered one multimodal follow-up request with screenshots.">Calls ${escapeHtml(String(stats.clarification_requests || 0))}</span>
          ${stats.scene_cards_total ? `<span title="Timestamped visual scene guides prepared before translation.">Scene guides ${escapeHtml(String(stats.scene_cards_created || 0))}/${escapeHtml(String(stats.scene_cards_total))}</span>` : ""}
          <span title="Approved: model-reported visual doubts that passed the app's category, line, question, and per-batch limit checks.">Approved ${escapeHtml(String(stats.doubts_approved || 0))}</span>
          <span title="Revised: subtitle lines whose provisional translation was changed after the model inspected the requested screenshots.">Revised ${escapeHtml(String(stats.lines_revised || 0))}</span>
          ${stats.clarification_failures ? `<span class="failed">Failed ${escapeHtml(String(stats.clarification_failures))}</span>` : ""}
          ${frames.length > visible.length ? `<span class="vision-more">+${escapeHtml(String(frames.length - visible.length))} earlier</span>` : ""}
          <button type="button" class="vision-rail-control" data-vision-scroll="-1" title="Scroll visual evidence backward" aria-label="Previous screenshots">‹</button>
          <button type="button" class="vision-rail-control" data-vision-scroll="1" title="Scroll visual evidence forward" aria-label="Next screenshots">›</button>
        </div>
      </div>
      <div class="vision-rail" data-vision-rail-key="${escapeHtml(`${job.id}:${location}`)}">
        ${visible.map((frame, index) => {
          const frameId = String(frame.id || "");
          const isNew = frameId && !seenVisionFrameIds.has(`${job.id}:${frameId}`);
          if (frameId) seenVisionFrameIds.add(`${job.id}:${frameId}`);
          const age = visible.length - index - 1;
          const cappedAge = Math.min(age, 8);
          const frameOpacity = Math.max(0.48, 1 - cappedAge * 0.055).toFixed(2);
          const positions = Array.isArray(frame.related_positions) ? frame.related_positions : [];
          const categories = Array.isArray(frame.categories) ? frame.categories : [];
          const revised = Array.isArray(frame.revised_positions) ? frame.revised_positions : [];
          const isSceneFrame = frame.status === "scene"
            || (Array.isArray(frame.categories) && frame.categories.includes("scene_context"))
            || frameId.startsWith("b-");
          const positionLabel = positions.length
            ? (isSceneFrame
              ? `Lines ${Number(positions[0]) + 1}-${Number(positions[positions.length - 1]) + 1}`
              : `Lines ${positions.map(position => Number(position) + 1).join(", ")}`)
            : "";
          const title = [
            isSceneFrame ? `Scene ${frame.batch_index || "?"}` : `Batch ${frame.batch_index || "?"}`,
            `Time ${formatMediaTime(frame.timestamp_ms)}`,
            positionLabel,
            categories.length ? categories.join(", ") : "",
          ].filter(Boolean).join(" · ");
          return `
            <button
              type="button"
              class="vision-frame ${frame.status === "failed" ? "failed" : ""} ${frame.status === "pending" ? "pending" : ""} ${isSceneFrame ? "scene-frame" : ""} ${revised.length ? "revised" : ""} ${frameId === newestId ? "latest" : ""} ${isNew ? "is-new" : ""}"
              style="--frame-shrink:${cappedAge * 6}px;--frame-opacity:${frameOpacity}"
              data-vision-frame="${escapeHtml(frameId)}"
              data-vision-job="${escapeHtml(job.id)}"
              title="${escapeHtml(title)}"
            >
              <img src="/api/jobs/${encodeURIComponent(job.id)}/vision/frames/${encodeURIComponent(frameId)}" alt="Visual evidence at ${escapeHtml(formatMediaTime(frame.timestamp_ms))}" loading="lazy" />
              <span class="vision-frame-shade"></span>
              <span class="vision-frame-time">${escapeHtml(formatMediaTime(frame.timestamp_ms))}</span>
              <span class="vision-frame-batch">${isSceneFrame ? "SCENE" : `B${escapeHtml(String(frame.batch_index || "?"))}`}</span>
              ${frame.status === "pending" ? `<span class="vision-frame-pending">analyzing</span>` : ""}
              ${revised.length ? `<span class="vision-frame-result">revised</span>` : ""}
            </button>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function openVisionEvidence(jobId, frameId) {
  const job = jobsById.get(jobId);
  const frame = (job?.visual_frames || []).find(item => String(item.id) === String(frameId));
  if (!job || !frame || !visionEvidenceDialog || !visionEvidenceDialogBody) return;
  const details = Array.isArray(frame.details) ? frame.details : [];
  const isSceneFrame = frame.status === "scene"
    || (Array.isArray(frame.categories) && frame.categories.includes("scene_context"))
    || String(frame.id || "").startsWith("b-");
  const sceneGuide = (job.visual_scene_contexts || []).find(
    item => Array.isArray(item.frame_ids) && item.frame_ids.includes(frameId)
  );
  const imageUrl = `/api/jobs/${encodeURIComponent(jobId)}/vision/frames/${encodeURIComponent(frameId)}`;
  const orderedFrames = [...(job.visual_frames || [])].sort((a, b) => {
    const timeDelta = Number(a.timestamp_ms || 0) - Number(b.timestamp_ms || 0);
    return timeDelta || Number(a.batch_index || 0) - Number(b.batch_index || 0);
  });
  const frameIndex = orderedFrames.findIndex(item => String(item.id) === String(frameId));
  openVisionEvidenceJobId = jobId;
  openVisionEvidenceFrameId = frameId;
  if (visionEvidencePrev) {
    visionEvidencePrev.disabled = frameIndex <= 0;
    visionEvidencePrev.title = frameIndex <= 0 ? "This is the first visual frame." : "Open the previous visual frame.";
  }
  if (visionEvidenceNext) {
    visionEvidenceNext.disabled = frameIndex < 0 || frameIndex >= orderedFrames.length - 1;
    visionEvidenceNext.title = frameIndex >= orderedFrames.length - 1
      ? "This is the latest visual frame."
      : "Open the next visual frame.";
  }
  visionEvidenceDialogTitle.textContent = `${sceneGuide ? `Scene ${sceneGuide.scene_index || "?"}` : `Batch ${frame.batch_index || "?"}`} · ${formatMediaTime(frame.timestamp_ms)}`;
  visionEvidenceDialogBody.innerHTML = `
    <div class="vision-evidence-layout">
      <figure class="vision-evidence-image">
        <img src="${imageUrl}" alt="Visual evidence at ${escapeHtml(formatMediaTime(frame.timestamp_ms))}" />
        <figcaption>
          <span>${escapeHtml(job.video_filename || "Source video")}</span>
          <span>${escapeHtml(frame.status || "used")}</span>
        </figcaption>
      </figure>
      <section class="vision-evidence-copy">
        <div class="job-facts">
          <span class="job-fact">Batch ${escapeHtml(String(frame.batch_index || "?"))}</span>
          <span class="job-fact">Time ${escapeHtml(formatMediaTime(frame.timestamp_ms))}</span>
          ${sceneGuide
            ? `<span class="job-fact">Lines ${escapeHtml(String(Number(sceneGuide.start_position || 0) + 1))}-${escapeHtml(String(Number(sceneGuide.end_position || 0) + 1))}</span>`
            : `<span class="job-fact">${escapeHtml(String(details.length))} doubt${details.length === 1 ? "" : "s"}</span>
               <span class="job-fact">${escapeHtml(String((frame.revised_positions || []).length))} revised</span>`}
        </div>
        ${sceneGuide ? `
          <article class="vision-evidence-detail scene-guide-detail">
            <div class="vision-evidence-detail-head">
              <span class="log-badge info">scene guide</span>
              <span class="log-batch">Scene ${escapeHtml(String(sceneGuide.scene_index || "?"))}</span>
            </div>
            <div class="vision-evidence-field">
              <span>Visual summary</span>
              <strong>${escapeHtml(sceneGuide.summary || "No summary returned.")}</strong>
            </div>
            ${sceneGuide.setting ? `<div class="vision-evidence-field"><span>Setting</span><strong>${escapeHtml(sceneGuide.setting)}</strong></div>` : ""}
            ${(sceneGuide.visible_characters || []).length ? `<div class="vision-evidence-field"><span>Visible people</span><strong>${escapeHtml(sceneGuide.visible_characters.join(" · "))}</strong></div>` : ""}
            ${(sceneGuide.actions || []).length ? `<div class="vision-evidence-field"><span>Visible actions</span><strong>${escapeHtml(sceneGuide.actions.join(" · "))}</strong></div>` : ""}
            ${(sceneGuide.uncertainties || []).length ? `<div class="vision-evidence-field"><span>Still uncertain</span><strong>${escapeHtml(sceneGuide.uncertainties.join(" · "))}</strong></div>` : ""}
          </article>
        ` : details.length ? details.map(detail => `
          <article class="vision-evidence-detail ${detail.revised ? "revised" : ""}">
            <div class="vision-evidence-detail-head">
              <span class="log-badge info">${escapeHtml(detail.category || "visual")}</span>
              <span class="log-batch">Line ${escapeHtml(String(Number(detail.position || 0) + 1))}</span>
              <span class="log-time">${escapeHtml(detail.confidence || "unknown")} confidence</span>
            </div>
            <div class="vision-evidence-field">
              <span>Source subtitle</span>
              <strong>${escapeHtml(detail.source_text || "Not recorded")}</strong>
            </div>
            <div class="vision-evidence-field">
              <span>Model doubt</span>
              <strong>${escapeHtml(detail.question || "Question was not recorded for this older frame.")}</strong>
            </div>
            ${detail.alternative_translation ? `
              <div class="vision-evidence-field">
                <span>Alternative considered</span>
                <strong>${escapeHtml(detail.alternative_translation)}</strong>
              </div>
            ` : ""}
            ${detail.translation_impact ? `
              <div class="vision-evidence-field">
                <span>Why vision mattered</span>
                <strong>${escapeHtml(detail.translation_impact)}</strong>
              </div>
            ` : ""}
            <div class="vision-evidence-field">
              <span>Visual response</span>
              <strong>${escapeHtml(detail.answer || (frame.status === "pending" ? "The visual request is still running." : "No visual answer was returned."))}</strong>
            </div>
            <div class="vision-translation-compare">
              <div>
                <span>Before vision</span>
                <strong>${escapeHtml(detail.provisional_translation || "Not recorded")}</strong>
              </div>
              <div class="${detail.revised ? "changed" : ""}">
                <span>After vision</span>
                <strong>${escapeHtml(detail.final_translation || detail.provisional_translation || "Not recorded")}</strong>
              </div>
            </div>
          </article>
        `).join("") : isSceneFrame ? `
          <p class="job-meta">${
            frame.status === "pending"
              ? "This frame sequence is being analyzed for a visual scene guide."
              : "The visual scene guide was not available for this frame."
          }</p>
        ` : `
          <p class="job-meta">This frame was recorded before detailed visual evidence history was added.</p>
        `}
      </section>
    </div>
  `;
  if (!visionEvidenceDialog.open) visionEvidenceDialog.showModal();
  visionEvidenceDialogBody.scrollTop = 0;
}

function navigateVisionEvidence(offset) {
  const job = jobsById.get(openVisionEvidenceJobId);
  if (!job || !openVisionEvidenceFrameId) return;
  const orderedFrames = [...(job.visual_frames || [])].sort((a, b) => {
    const timeDelta = Number(a.timestamp_ms || 0) - Number(b.timestamp_ms || 0);
    return timeDelta || Number(a.batch_index || 0) - Number(b.batch_index || 0);
  });
  const currentIndex = orderedFrames.findIndex(item => String(item.id) === String(openVisionEvidenceFrameId));
  const target = orderedFrames[currentIndex + offset];
  if (target) openVisionEvidence(job.id, target.id);
}

function addModelCallDuration(job, seconds) {
  const duration = Number(seconds);
  if (!Number.isFinite(duration) || duration <= 0) return;
  const signature = modelCallSignature(job);
  const bucket = modelCallStats[signature] || { samples: [] };
  const samples = Array.isArray(bucket.samples) ? bucket.samples : [];
  samples.push(Math.max(1, Math.min(900, Math.round(duration))));
  bucket.samples = samples.slice(-40);
  modelCallStats[signature] = bucket;
  writeModelCallStats();
}

function learnModelCallDurations(job) {
  const logs = Array.isArray(job?.logs) ? job.logs : [];
  if (!logs.length) return;
  const state = modelCallParserState.get(job.id) || { processed: 0, pendingByBatch: {} };
  const pendingByBatch = state.pendingByBatch || {};
  const startPattern = /Submitting batch to model|Retrying batch with stricter translation instruction|Starting batch /;
  const endPattern = /Validation after attempt|Model request timed out after/;

  for (let index = state.processed; index < logs.length; index += 1) {
    const entry = logs[index];
    const batch = Number(entry?.batch_index);
    if (!Number.isFinite(batch) || batch <= 0) continue;
    const message = String(entry?.message || "");
    const timeMs = Date.parse(String(entry?.timestamp || ""));
    if (!Number.isFinite(timeMs)) continue;

    if (startPattern.test(message)) {
      const queue = Array.isArray(pendingByBatch[batch]) ? pendingByBatch[batch] : [];
      queue.push(timeMs);
      pendingByBatch[batch] = queue;
      continue;
    }

    if (endPattern.test(message)) {
      const queue = Array.isArray(pendingByBatch[batch]) ? pendingByBatch[batch] : [];
      if (queue.length) {
        const startMs = queue.shift();
        if (Number.isFinite(startMs) && timeMs > startMs) {
          addModelCallDuration(job, (timeMs - startMs) / 1000);
        }
        pendingByBatch[batch] = queue;
      }
    }
  }

  modelCallParserState.set(job.id, { processed: logs.length, pendingByBatch });
}

const PROMPT_FIELD_IDS = [
  "prompt_translation_system",
  "prompt_translation_strict_retry",
  "prompt_initial_context_system",
  "prompt_full_context_refresh_system",
  "prompt_batch_context_refresh_system",
  "prompt_line_revision_system",
];

const RUNTIME_DEFAULT_FIELD_IDS = [
  "max_completion_tokens",
  "request_timeout_seconds",
  ...PROMPT_FIELD_IDS,
];

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

function extractSubtitleTextFromSrt(content) {
  return String(content || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => line.trim())
    .filter(line => line && !/^\d+$/.test(line) && !/^\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}$/.test(line))
    .join("\n")
    .trim();
}

function estimateTokensFromChars(charCount) {
  const numeric = Number(charCount) || 0;
  return Math.max(0, Math.round(numeric / 4));
}

async function refreshInitialCardEstimate() {
  if (!initialCardEstimate) return;
  const currentToken = ++initialCardEstimateToken;
  const file = fileInput.files && fileInput.files[0];
  if (!file) {
    sourceSubtitleTextStats = null;
    initialCardEstimate.textContent = "Initial card input estimate appears after you load a source subtitle.";
    initialCardEstimate.style.color = "var(--muted)";
    return;
  }

  if (!sourceSubtitleTextStats || sourceSubtitleTextStats.name !== file.name || sourceSubtitleTextStats.size !== file.size || sourceSubtitleTextStats.lastModified !== file.lastModified) {
    const content = await file.text();
    if (currentToken !== initialCardEstimateToken) return;
    const cleaned = extractSubtitleTextFromSrt(content);
    sourceSubtitleTextStats = {
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      cleanedChars: cleaned.length,
      estimatedTokens: estimateTokensFromChars(cleaned.length),
    };
  }

  const stats = sourceSubtitleTextStats;
  const strategy = String(initialCardStrategyInput?.value || "auto");
  const maxChars = Math.max(2000, Number(initialCardMaxCharsInput?.value || 24000) || 24000);
  if (!stats) {
    initialCardEstimate.textContent = "Initial card input estimate appears after you load a source subtitle.";
    initialCardEstimate.style.color = "var(--muted)";
    return;
  }

  const fullChars = stats.cleanedChars;
  const fullTokens = stats.estimatedTokens;
  let summary = `Cleaned subtitle text: ~${fullChars.toLocaleString()} chars (~${fullTokens.toLocaleString()} tokens). `;
  if (strategy === "whole") {
    summary += "Whole subtitle mode will send all cleaned subtitle text.";
  } else if (strategy === "sample") {
    summary += `Distributed sample mode will cap input near ${maxChars.toLocaleString()} chars (~${estimateTokensFromChars(maxChars).toLocaleString()} tokens).`;
  } else if (fullChars <= maxChars) {
    summary += "Auto mode will send the whole cleaned subtitle text.";
  } else {
    summary += `Auto mode will sample the subtitle down to about ${maxChars.toLocaleString()} chars (~${estimateTokensFromChars(maxChars).toLocaleString()} tokens).`;
  }

  initialCardEstimate.textContent = summary;
  initialCardEstimate.style.color = (strategy === "whole" && fullChars > maxChars * 1.5) ? "var(--accent-2)" : "var(--muted)";
}

function scopeDraftKey(scope, jobId, batchIndex = "") {
  return `${scope}:${jobId}:${batchIndex}`;
}

function normalizeModelName(value) {
  return String(value || "").trim();
}

function normalizeLanguageTip(value) {
  return String(value || "").trim();
}

function readLanguageTipsHistory() {
  const raw = localStorage.getItem(LANGUAGE_TIPS_HISTORY_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(normalizeLanguageTip).filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

function writeLanguageTipsHistory(entries) {
  const unique = [];
  const seen = new Set();
  for (const entry of entries) {
    const tip = normalizeLanguageTip(entry);
    if (!tip || seen.has(tip)) continue;
    seen.add(tip);
    unique.push(tip);
    if (unique.length >= MAX_LANGUAGE_TIPS_HISTORY) break;
  }
  localStorage.setItem(LANGUAGE_TIPS_HISTORY_KEY, JSON.stringify(unique));
  renderLanguageTipsHistoryMenu(LANGUAGE_TIPS_TARGET_SETUP, document);
  renderLanguageTipsHistoryMenu(LANGUAGE_TIPS_TARGET_MAIN, contextDialogBody || document);
  return unique;
}

function rememberLanguageTip(value) {
  const tip = normalizeLanguageTip(value);
  if (!tip) return;
  const history = [tip, ...readLanguageTipsHistory().filter(entry => entry !== tip)];
  writeLanguageTipsHistory(history);
}

function forgetLanguageTip(value) {
  const tip = normalizeLanguageTip(value);
  if (!tip) return;
  writeLanguageTipsHistory(readLanguageTipsHistory().filter(entry => entry !== tip));
}

function renderLanguageTipsHistoryMenu(target, root = document) {
  const menu = root.querySelector(`[data-tips-history-menu="${target}"]`);
  if (!menu) return;
  const history = readLanguageTipsHistory();
  if (!history.length) {
    menu.innerHTML = `<div class="tips-history-empty">No saved tips yet.</div>`;
    return;
  }
  menu.innerHTML = history.map(tip => `
    <div class="tips-history-item">
      <button
        type="button"
        class="tips-history-apply"
        data-tips-history-apply="${escapeHtml(target)}"
        data-tip-value="${escapeHtml(tip)}"
        title="${escapeHtml(tip)}"
      >${escapeHtml(tip)}</button>
      <button
        type="button"
        class="tips-history-delete"
        data-tips-history-delete="${escapeHtml(target)}"
        data-tip-value="${escapeHtml(tip)}"
        title="Delete this tip from history"
        aria-label="Delete tip"
      >×</button>
    </div>
  `).join("");
}

function closeLanguageTipsMenus() {
  for (const menu of document.querySelectorAll("[data-tips-history-menu]")) {
    menu.classList.remove("open");
  }
  for (const toggle of document.querySelectorAll("[data-tips-history-toggle]")) {
    toggle.setAttribute("aria-expanded", "false");
  }
}

function rootForTipsTarget(target) {
  return target === LANGUAGE_TIPS_TARGET_MAIN ? (contextDialogBody || document) : document;
}

function setLanguageTipsInputValue(target, value) {
  const root = rootForTipsTarget(target);
  const input = root.querySelector(`[data-tips-input="${target}"]`);
  if (!input) return;
  input.value = normalizeLanguageTip(value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
}

function toggleLanguageTipsMenu(target) {
  const root = rootForTipsTarget(target);
  const menu = root.querySelector(`[data-tips-history-menu="${target}"]`);
  const toggle = root.querySelector(`[data-tips-history-toggle="${target}"]`);
  if (!menu || !toggle) return;
  const nextOpen = !menu.classList.contains("open");
  closeLanguageTipsMenus();
  if (nextOpen) {
    renderLanguageTipsHistoryMenu(target, root);
    menu.classList.add("open");
    toggle.setAttribute("aria-expanded", "true");
  }
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

async function fetchRuntimeDefaults() {
  try {
    const response = await fetch("/api/runtime/defaults");
    if (!response.ok) return;
    runtimeDefaults = await response.json();
  } catch (_) {
    runtimeDefaults = {};
  }
}

function applyRuntimeDefaults(force = false) {
  for (const fieldId of RUNTIME_DEFAULT_FIELD_IDS) {
    const field = document.getElementById(fieldId);
    if (!field || !(fieldId in runtimeDefaults)) continue;
    const nextValue = runtimeDefaults[fieldId];
    const isCheckbox = field.type === "checkbox";
    const hasValue = isCheckbox ? field.checked : String(field.value || "").trim().length > 0;
    if (!force && hasValue) continue;
    if (isCheckbox) {
      field.checked = Boolean(nextValue);
    } else {
      field.value = nextValue;
    }
  }
}

function resetPromptLabDefaults() {
  if (!Object.keys(runtimeDefaults).length) return;
  for (const fieldId of RUNTIME_DEFAULT_FIELD_IDS) {
    const field = document.getElementById(fieldId);
    if (!field || !(fieldId in runtimeDefaults)) continue;
    field.value = runtimeDefaults[fieldId];
  }
  saveSettings();
  void refreshInitialCardEstimate();
}

function setConsoleTab(tabId) {
  for (const button of consoleTabButtons) {
    const active = button.dataset.consoleTab === tabId;
    button.classList.toggle("active", active);
    button.classList.toggle("ghost", !active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  }
  for (const panel of consoleTabPanels) {
    const active = panel.dataset.consolePanel === tabId;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  }
}

function loadSettings() {
  const settings = readStoredSettings();
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
  updateVisionControls();
}

function saveSettings() {
  const payload = { ...readStoredSettings() };
  for (const element of form.elements) {
    if (!element.id || element.type === "file" || element.tagName === "BUTTON") continue;
    payload[element.id] = element.type === "checkbox" ? element.checked : element.value;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  if (payload.model) {
    rememberModel(payload.model);
  }
}

async function responseErrorDetail(response, fallbackMessage) {
  try {
    const data = await response.json();
    if (data && typeof data === "object") {
      if (typeof data.detail === "string" && data.detail.trim()) return data.detail.trim();
      if (Array.isArray(data.detail) && data.detail.length) return fallbackMessage;
      if (typeof data.message === "string" && data.message.trim()) return data.message.trim();
    }
  } catch (_) {
    // Fall through to plain text
  }
  try {
    const text = await response.text();
    if (text && text.trim()) return text.trim();
  } catch (_) {
    // Ignore and return fallback
  }
  return fallbackMessage;
}

function collectSettingsPayload() {
  const payload = { ...runtimeDefaults, ...readStoredSettings() };
  for (const element of form.elements) {
    if (!element.id || element.type === "file" || element.tagName === "BUTTON") continue;
    payload[element.id] = element.type === "checkbox" ? element.checked : element.value;
  }
  return payload;
}

function collectRuntimeOverridePayload() {
  const merged = { ...runtimeDefaults, ...readStoredSettings() };
  const payload = {};
  for (const fieldId of RUNTIME_DEFAULT_FIELD_IDS) {
    if (fieldId in merged) {
      payload[fieldId] = merged[fieldId];
    }
  }
  return payload;
}

function updateSelectedFileLabel() {
  const file = fileInput.files && fileInput.files[0];
  selectedFile.textContent = file ? file.name : "No file selected";
  if (!file) {
    sourceSubtitleTextStats = null;
  }
  void refreshInitialCardEstimate();
}

function updateSelectedTranslatedFileLabel() {
  const file = translatedFileInput.files && translatedFileInput.files[0];
  selectedTranslatedFile.innerHTML = file ? escapeHtml(file.name) : `Optional second <code>.srt</code>`;
}

function updateSelectedVideoFileLabel() {
  const file = videoFileInput?.files && videoFileInput.files[0];
  if (selectedVideoFile) {
    selectedVideoFile.textContent = file
      ? file.name
      : "Drop a video here or click to browse";
  }
  updateVisionControls();
}

function acceptSelectedVideo() {
  const file = videoFileInput?.files && videoFileInput.files[0];
  if (file && visualSceneContextInput && adaptiveVisionInput) {
    if (!visualSceneContextInput.checked && !adaptiveVisionInput.checked) {
      visualSceneContextInput.checked = true;
    }
    saveSettings();
  }
  updateSelectedVideoFileLabel();
}

function updateVisionControls() {
  const sceneEnabled = Boolean(visualSceneContextInput?.checked);
  const adaptiveEnabled = Boolean(adaptiveVisionInput?.checked);
  const enabled = sceneEnabled || adaptiveEnabled;
  if (visionControls) visionControls.hidden = !enabled;
  if (sceneVisionControls) sceneVisionControls.hidden = !sceneEnabled;
  if (adaptiveVisionControls) adaptiveVisionControls.hidden = !adaptiveEnabled;
  if (!visionReadiness) return;
  const video = videoFileInput?.files && videoFileInput.files[0];
  if (!enabled) {
    visionReadiness.textContent = "";
  } else if (!video) {
    visionReadiness.textContent = "Select a source video to use the visual features.";
  } else {
    const modes = [
      sceneEnabled ? "scene guides before translation" : "",
      adaptiveEnabled ? "evidence-based doubt resolution during translation" : "",
    ].filter(Boolean);
    visionReadiness.textContent = `${video.name} ready for ${modes.join(" and ")}.`;
  }
}

function renderReferenceTrackEmptyState() {
  if (!referenceTracksEl) return;
  const hasRows = referenceTracksEl.querySelector(".reference-track-row");
  const emptyState = referenceTracksEl.querySelector(".reference-track-empty");
  if (hasRows) {
    emptyState?.remove();
    return;
  }
  if (!emptyState) {
    referenceTracksEl.innerHTML = `<div class="reference-track-empty">Drop supporting .srt files here or click Add.</div>`;
  }
}

function updateReferenceTrackLabel(row) {
  if (!row) return;
  const fileInputEl = row.querySelector("[data-reference-file]");
  const valueEl = row.querySelector("[data-reference-file-name]");
  const file = fileInputEl?.files && fileInputEl.files[0];
  if (!valueEl) return;
  valueEl.textContent = file ? file.name : "Choose supporting .srt";
}

function addReferenceTrackRow(language = "") {
  if (!referenceTracksEl) return;
  referenceTracksEl.querySelector(".reference-track-empty")?.remove();
  const trackId = `reference-track-${referenceTrackCounter++}`;
  referenceTracksEl.insertAdjacentHTML("beforeend", `
    <div class="reference-track-row" data-reference-row="${escapeHtml(trackId)}">
      <label>
        <span class="label-row">Language</span>
        <input type="text" data-reference-language value="${escapeHtml(language)}" placeholder="es, fr, ja..." />
      </label>
      <label class="secondary-file reference-track-picker" data-reference-picker="true" title="Optional supporting subtitle file used only as aligned context during translation.">
        <input type="file" data-reference-file accept=".srt" hidden />
        <span class="secondary-file-label">Reference Subtitle</span>
        <span class="secondary-file-value" data-reference-file-name>Choose supporting .srt</span>
      </label>
      <div class="reference-track-actions">
        <button type="button" class="ghost small" data-reference-remove="true">Remove</button>
      </div>
    </div>
  `);
  const row = referenceTracksEl.lastElementChild;
  const input = row?.querySelector("[data-reference-file]");
  const picker = row?.querySelector("[data-reference-picker]");
  if (picker && input) {
    bindDropZone(picker, input);
  }
  renderReferenceTrackEmptyState();
  return row;
}

function removeReferenceTrackRow(button) {
  const row = button?.closest(".reference-track-row");
  if (!row) return;
  row.remove();
  renderReferenceTrackEmptyState();
}

function collectReferenceTracks() {
  if (!referenceTracksEl) return [];
  const rows = [...referenceTracksEl.querySelectorAll(".reference-track-row")];
  const tracks = [];
  for (const row of rows) {
    const language = row.querySelector("[data-reference-language]")?.value?.trim() || "";
    const file = row.querySelector("[data-reference-file]")?.files?.[0] || null;
    if (!language && !file) continue;
    if (!language || !file) {
      alert("Each reference track needs both a language code and a subtitle file.");
      return null;
    }
    tracks.push({ language, file });
  }
  return tracks;
}

function resetReferenceTrackRows() {
  if (!referenceTracksEl) return;
  referenceTracksEl.innerHTML = "";
  renderReferenceTrackEmptyState();
}

function emptyReferenceTrackRows() {
  if (!referenceTracksEl) return [];
  return [...referenceTracksEl.querySelectorAll(".reference-track-row")]
    .filter(row => !(row.querySelector("[data-reference-file]")?.files?.[0]));
}

function attachReferenceFileToRow(row, file) {
  if (!row || !file) return;
  const input = row.querySelector("[data-reference-file]");
  if (!input) return;
  setInputFile(input, file);
  updateReferenceTrackLabel(row);
}

function addReferenceTracksFromFiles(files) {
  const droppedFiles = [...(files || [])];
  if (!droppedFiles.length) return;
  const invalid = droppedFiles.filter(file => !String(file?.name || "").toLowerCase().endsWith(".srt"));
  if (invalid.length) {
    alert("Only .srt files are supported.");
    return;
  }

  const availableRows = emptyReferenceTrackRows();
  let firstCreatedOrFilledRow = null;
  for (const file of droppedFiles) {
    const row = availableRows.shift() || addReferenceTrackRow();
    attachReferenceFileToRow(row, file);
    if (!firstCreatedOrFilledRow) {
      firstCreatedOrFilledRow = row;
    }
  }

  const languageInput = firstCreatedOrFilledRow?.querySelector("[data-reference-language]");
  if (languageInput && !String(languageInput.value || "").trim()) {
    languageInput.focus();
  }
}

function statusBadge(status) {
  return `<span class="badge ${status}">${status}</span>`;
}

function formatProgress(value) {
  const numeric = Number.isFinite(Number(value)) ? Number(value) : 0;
  const bounded = Math.max(0, Math.min(100, numeric));
  return `${Math.round(bounded)}%`;
}

function formatDuration(seconds) {
  const numeric = Math.max(0, Math.round(Number(seconds) || 0));
  if (!numeric) return "";
  const hours = Math.floor(numeric / 3600);
  const minutes = Math.floor((numeric % 3600) / 60);
  const secs = numeric % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}

function jobEtaSeconds(job) {
  if (!job || job.status !== "processing") return null;
  const completionAtMs = job.estimated_completion_at ? Date.parse(String(job.estimated_completion_at)) : NaN;
  if (Number.isFinite(completionAtMs)) {
    return Math.max(0, Math.round((completionAtMs - Date.now()) / 1000));
  }
  const eta = Number(job.eta_seconds);
  return Number.isFinite(eta) && eta > 0 ? eta : null;
}

function formatJobEta(job) {
  const eta = jobEtaSeconds(job);
  if (eta === null) return "Calculating after first batch";
  if (eta <= 0) return "Finishing";
  return formatDuration(eta);
}

function currentRequestTimeoutInfo(job) {
  const configuredTimeout = Math.max(15, Number(job?.settings?.request_timeout_seconds || 120));
  const callProgress = currentModelCallProgress(job);
  if (!callProgress || job?.status !== "processing") {
    return {
      configuredTimeout,
      label: `${configuredTimeout}s`,
      detail: "Configured per-request timeout for this job.",
    };
  }
  const startedAtMs = Number(callProgress.startedAtMs || Date.now());
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  const remainingSeconds = Math.max(0, configuredTimeout - elapsedSeconds);
  return {
    configuredTimeout,
    startedAtMs,
    elapsedSeconds,
    remainingSeconds,
    label: `${formatDuration(elapsedSeconds) || "0s"} / ${configuredTimeout}s`,
    detail: `${formatDuration(remainingSeconds) || "0s"} until this active request reaches the configured timeout.`,
  };
}

function timeoutInfoAttrs(timeoutInfo) {
  if (!timeoutInfo?.startedAtMs) return "";
  return ` data-live-timeout="true" data-timeout-started-ms="${escapeHtml(String(timeoutInfo.startedAtMs))}" data-timeout-seconds="${escapeHtml(String(timeoutInfo.configuredTimeout))}"`;
}

function updateLiveTimeoutDisplays() {
  const nodes = document.querySelectorAll("[data-live-timeout='true']");
  for (const node of nodes) {
    const startedAtMs = Number(node.dataset.timeoutStartedMs || 0);
    const configuredTimeout = Math.max(15, Number(node.dataset.timeoutSeconds || 120));
    if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) continue;
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
    const remainingSeconds = Math.max(0, configuredTimeout - elapsedSeconds);
    node.textContent = `${formatDuration(elapsedSeconds) || "0s"} / ${configuredTimeout}s`;
    node.title = `${formatDuration(remainingSeconds) || "0s"} until this active request reaches the configured timeout.`;
  }
}

function renderEtaPill(job) {
  if (!job || job.status !== "processing") return "";
  return `
    <div class="eta-pill" title="Adaptive ETA based on completed batch timing. It recalibrates after each finished batch.">
      <span>ETA</span>
      <strong>${escapeHtml(formatJobEta(job))}</strong>
    </div>
  `;
}

function latestTimeoutWarning(job) {
  if (!job || job.status === "completed" || job.status === "cancelled") return "";
  const logs = Array.isArray(job?.logs) ? job.logs : [];
  const timeoutLog = [...logs].reverse().find(entry => String(entry?.message || "").includes("Model request timed out after"));
  if (!timeoutLog) return "";
  const timeoutBatch = hasBatchIndex(timeoutLog.batch_index) ? Number(timeoutLog.batch_index) : null;
  const completedBatch = Number(job.current_batch || 0);
  if (timeoutBatch !== null && Number.isFinite(timeoutBatch) && completedBatch >= timeoutBatch) {
    return "";
  }
  const batch = hasBatchIndex(timeoutLog.batch_index) ? `Batch ${Number(timeoutLog.batch_index)}` : "A model request";
  const configuredTimeout = Math.max(15, Number(job?.settings?.request_timeout_seconds || 120));
  return `${batch} hit the ${configuredTimeout}s request timeout. The model server may still be generating that abandoned request; if retries stall, cancel it in the model server. You can raise Request Timeout in Prompt Lab > Safety Controls.`;
}

function runtimeActivity(job) {
  if (!job || job.status !== "processing") return null;
  const logs = Array.isArray(job.logs) ? job.logs : [];
  const latest = logs[logs.length - 1] || null;
  const message = String(latest?.message || job.message || "Processing");
  const lowered = message.toLowerCase();
  let label = "Working";
  let tone = "active";

  if (lowered.includes("retry") || lowered.includes("splitting batch")) {
    label = "Retrying";
    tone = "retry";
  } else if (lowered.includes("visual clarification") || lowered.includes("frame")) {
    label = "Vision";
    tone = "vision";
  } else if (lowered.includes("validation")) {
    label = "Validating";
    tone = "validating";
  } else if (lowered.includes("submitting") || lowered.includes("prompt size")) {
    label = "Model generating";
    tone = "generating";
  } else if (lowered.includes("starting batch")) {
    label = "Preparing batch";
  } else if (lowered.includes("finished batch")) {
    label = "Advancing";
  }

  return {
    label,
    tone,
    message,
    batch: hasBatchIndex(latest?.batch_index) ? Number(latest.batch_index) : null,
  };
}

function renderRuntimeActivity(job, compact = false) {
  const activity = runtimeActivity(job);
  if (!activity) return "";
  return `
    <div class="runtime-activity ${escapeHtml(activity.tone)} ${compact ? "compact" : ""}" title="${escapeHtml(activity.message)}">
      <span class="runtime-activity-dot" aria-hidden="true"></span>
      <strong>${escapeHtml(activity.label)}</strong>
      ${activity.batch ? `<span>Batch ${escapeHtml(String(activity.batch))}</span>` : ""}
      <span class="runtime-activity-message">${escapeHtml(activity.message)}</span>
    </div>
  `;
}

function currentModelCallProgress(job) {
  if (!job || job.status !== "processing") return null;
  const totalBatches = Math.max(0, Number(job.total_batches || 0));
  const currentBatch = Math.max(0, Number(job.current_batch || 0));
  const activeBatch = totalBatches ? Math.min(totalBatches, currentBatch + 1) : currentBatch + 1;
  const logs = Array.isArray(job.logs) ? job.logs : [];
  const batchLogs = logs.filter(item => Number(item?.batch_index) === activeBatch);
  const latestStart = [...batchLogs].reverse().find(item => {
    const text = String(item?.message || "");
    return text.includes("Submitting batch to model")
      || text.includes("Retrying batch with stricter translation instruction")
      || text.includes("Starting batch ");
  });
  const timeoutSeconds = Math.max(15, Number(job?.settings?.request_timeout_seconds || 120));
  const startedAtMs = latestStart?.timestamp ? Date.parse(String(latestStart.timestamp)) : NaN;
  const elapsedSeconds = Number.isFinite(startedAtMs)
    ? Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000))
    : 0;
  const signature = modelCallSignature(job);
  const samples = Array.isArray(modelCallStats?.[signature]?.samples) ? modelCallStats[signature].samples : [];
  const learnedExpectedSeconds = samples.length ? Math.max(4, median(samples)) : null;
  const defaultExpectedSeconds = Math.max(8, Math.min(45, timeoutSeconds * 0.35));
  const expectedSeconds = learnedExpectedSeconds || defaultExpectedSeconds;
  const ratio = expectedSeconds > 0 ? (elapsedSeconds / expectedSeconds) : 0;
  let estimatedPercent = modelCallPercentFromRatio(ratio);
  if (!Number.isFinite(startedAtMs)) {
    estimatedPercent = 8;
  }
  estimatedPercent = Math.max(8, Math.min(94, estimatedPercent));
  const callKey = `${activeBatch}:${Number.isFinite(startedAtMs) ? Math.floor(startedAtMs) : 0}`;
  return {
    percent: estimatedPercent,
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : Date.now(),
    expectedSeconds,
    callKey,
  };
}

function modelCallPercentFromRatio(ratio) {
  let estimatedPercent = 8;
  if (ratio <= 1) {
    estimatedPercent = 8 + ratio * 77;
  } else {
    estimatedPercent = 85 + Math.min(9, (ratio - 1) * 18);
  }
  return estimatedPercent;
}

function stopModelCallAnimation() {
  if (modelCallAnimation.rafId !== null) {
    cancelAnimationFrame(modelCallAnimation.rafId);
    modelCallAnimation.rafId = null;
  }
  modelCallAnimation.jobId = null;
}

function animateCurrentModelCallBar(job) {
  if (!job || !activeJobCard) return;
  const bar = activeJobCard.querySelector(".js-model-call-progress-bar");
  if (!bar) {
    stopModelCallAnimation();
    modelCallRenderedState.delete(job.id);
    return;
  }
  const target = Math.max(0, Math.min(100, Number(bar.dataset.targetPercent || 0) || 0));
  const startedAtMs = Math.max(0, Number(bar.dataset.startedAtMs || Date.now()) || Date.now());
  const expectedSeconds = Math.max(1, Number(bar.dataset.expectedSeconds || 15) || 15);
  const callKey = String(bar.dataset.callKey || "");
  const previous = modelCallRenderedState.get(job.id);
  const isNewCall = !previous || previous.callKey !== callKey;
  const start = isNewCall
    ? Math.max(4, Math.min(18, target * 0.35))
    : Math.max(0, Math.min(100, Number(previous.percent) || 0));

  bar.style.width = `${start}%`;
  modelCallRenderedState.set(job.id, { percent: start, callKey });

  stopModelCallAnimation();
  modelCallAnimation.jobId = job.id;

  const tick = () => {
    if (modelCallAnimation.jobId !== job.id) return;
    if (!bar.isConnected) {
      stopModelCallAnimation();
      return;
    }
    const elapsedSeconds = Math.max(0, (Date.now() - startedAtMs) / 1000);
    const ratio = expectedSeconds > 0 ? (elapsedSeconds / expectedSeconds) : 0;
    const computedTarget = Math.max(8, Math.min(94, modelCallPercentFromRatio(ratio)));
    const state = modelCallRenderedState.get(job.id) || { percent: start, callKey };
    const current = Number(state.percent ?? start);
    const next = current + (computedTarget - current) * 0.08;
    const clamped = Math.max(0, Math.min(94, next));
    bar.style.width = `${clamped}%`;
    modelCallRenderedState.set(job.id, { percent: clamped, callKey });
    modelCallAnimation.rafId = requestAnimationFrame(tick);
  };
  modelCallAnimation.rafId = requestAnimationFrame(tick);
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

function formatConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "0%";
  return `${Math.round(Math.max(0, Math.min(1, numeric)) * 100)}%`;
}

function referenceTrackQuality(track, primaryTotal = 0) {
  const matched = Math.max(0, Number(track?.matched_lines || 0));
  const average = Math.max(0, Math.min(1, Number(track?.average_confidence || 0)));
  const coverage = primaryTotal > 0 ? matched / primaryTotal : 0;
  if (primaryTotal > 0 && (coverage < 0.55 || average < 0.5)) return "weak";
  if (primaryTotal > 0 && (coverage < 0.8 || average < 0.68)) return "mixed";
  return "strong";
}

function renderReferenceTrackSummary(track, compact = false, primaryTotal = 0) {
  if (!track) return "";
  const language = String(track.language || "").trim() || "ref";
  const filename = String(track.filename || "reference.srt").trim() || "reference.srt";
  const matched = Number(track.matched_lines || 0);
  const total = Number(track.total_lines || 0);
  const average = formatConfidence(track.average_confidence);
  const mode = String(track.alignment_mode || "timestamp");
  const primaryCount = Math.max(0, Number(primaryTotal || 0));
  const unmatchedPrimary = primaryCount > 0 ? Math.max(0, primaryCount - matched) : 0;
  const coverage = primaryCount > 0 ? `${Math.round((matched / primaryCount) * 100)}%` : "n/a";
  const lineDelta = primaryCount > 0 ? total - primaryCount : 0;
  const quality = referenceTrackQuality(track, primaryCount);
  const qualityLabel = quality === "strong" ? "Strong" : (quality === "mixed" ? "Check" : "Weak");
  const summaryTitle = [
    `${matched}/${primaryCount || "?"} primary source lines received aligned reference text.`,
    `${total} reference subtitle lines loaded.`,
    lineDelta ? `Reference has ${Math.abs(lineDelta)} ${lineDelta > 0 ? "more" : "fewer"} line(s) than the primary source.` : "Reference line count is close to the primary source.",
    `Alignment mode: ${mode}. Average confidence: ${average}.`,
  ].join(" ");
  return `
    <div class="reference-track-summary ${compact ? "compact" : ""} ${quality}" title="${escapeHtml(summaryTitle)}">
      <div class="reference-track-summary-head">
        <span class="job-fact">${escapeHtml(language)}</span>
        <span class="job-meta">${escapeHtml(filename)}</span>
      </div>
      <div class="reference-track-summary-meta">
        <span class="job-fact">Primary ${escapeHtml(String(matched))}/${escapeHtml(String(primaryCount || "?"))}</span>
        <span class="job-fact">Coverage ${escapeHtml(coverage)}</span>
        <span class="job-fact">Ref lines ${escapeHtml(String(total))}${lineDelta ? escapeHtml(` (${lineDelta > 0 ? "+" : ""}${lineDelta})`) : ""}</span>
        <span class="job-fact">Avg ${escapeHtml(average)}</span>
        <span class="job-fact">${escapeHtml(mode)}</span>
        <span class="job-fact">Quality ${escapeHtml(qualityLabel)}</span>
      </div>
      ${!compact && primaryCount > 0 && unmatchedPrimary ? `
        <div class="reference-track-note">
          ${escapeHtml(String(unmatchedPrimary))} primary line(s) have no confident reference match. Extra reference lines are skipped or grouped by timestamp.
        </div>
      ` : ""}
    </div>
  `;
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

function metricStat(label, value, className, tooltip) {
  return `
    <div class="validation-stat ${className}" title="${escapeHtml(tooltip)}">
      <span class="validation-stat-label">${escapeHtml(label)}</span>
      <strong>${escapeHtml(String(value))}</strong>
    </div>
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

function cloneSnapshot(snapshot) {
  return snapshot ? JSON.parse(JSON.stringify(snapshot)) : null;
}

function snapshotValueSignature(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function buildNamedEntryMap(items, keyName) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const key = String(item?.[keyName] || "").trim().toLowerCase();
    if (!key) continue;
    map.set(key, snapshotValueSignature(item));
  }
  return map;
}

function diffSessionSnapshot(previousSnapshot, currentSnapshot) {
  const changedFields = new Set();
  const changedCharacters = new Set();
  const changedGlossary = new Set();
  if (!previousSnapshot || !currentSnapshot) {
    return { changedFields, changedCharacters, changedGlossary, hasChanges: false };
  }

  for (const field of ["premise", "tone", "scene_context", "style_notes", "unresolved_ambiguities"]) {
    if (snapshotValueSignature(previousSnapshot[field]) !== snapshotValueSignature(currentSnapshot[field])) {
      changedFields.add(field);
    }
  }

  const previousCharacters = buildNamedEntryMap(previousSnapshot.characters, "name");
  const currentCharacters = buildNamedEntryMap(currentSnapshot.characters, "name");
  for (const [key, value] of currentCharacters.entries()) {
    if (previousCharacters.get(key) !== value) {
      changedCharacters.add(key);
    }
  }
  if (changedCharacters.size) {
    changedFields.add("characters");
  }

  const previousGlossary = buildNamedEntryMap(previousSnapshot.glossary, "term");
  const currentGlossary = buildNamedEntryMap(currentSnapshot.glossary, "term");
  for (const [key, value] of currentGlossary.entries()) {
    if (previousGlossary.get(key) !== value) {
      changedGlossary.add(key);
    }
  }
  if (changedGlossary.size) {
    changedFields.add("glossary");
  }

  return {
    changedFields,
    changedCharacters,
    changedGlossary,
    hasChanges: changedFields.size > 0,
  };
}

function updateClassName(baseClass, active) {
  return active ? `${baseClass} is-updated` : baseClass;
}

function renderSessionSnapshot(snapshot, compact = false, delta = null) {
  if (!snapshot) return "";

  const characters = (snapshot.characters || []).slice(0, compact ? 6 : 12);
  const glossary = (snapshot.glossary || []).slice(0, compact ? 4 : 8);
  const styleNotes = (snapshot.style_notes || []).slice(0, compact ? 4 : 8);
  const ambiguities = snapshot.unresolved_ambiguities || [];
  const changedFields = delta?.changedFields || new Set();
  const changedCharacters = delta?.changedCharacters || new Set();
  const changedGlossary = delta?.changedGlossary || new Set();

  return `
    <div class="${updateClassName("context-card", Boolean(delta?.hasChanges))}">
      ${snapshot.premise ? `
        <div class="${updateClassName("tile", changedFields.has("premise"))}">
          <div class="mini-eyebrow">Whole Movie Premise</div>
          <p>${escapeHtml(snapshot.premise)}</p>
        </div>
      ` : ""}

      ${snapshot.tone ? `
        <div class="${updateClassName("tile", changedFields.has("tone"))}">
          <div class="mini-eyebrow">Tone</div>
          <p>${escapeHtml(snapshot.tone)}</p>
        </div>
      ` : ""}

      ${snapshot.scene_context ? `
        <div class="${updateClassName("scene", changedFields.has("scene_context"))}">
          <div class="mini-eyebrow">Scene</div>
          <div>${escapeHtml(snapshot.scene_context)}</div>
        </div>
      ` : ""}

      ${styleNotes.length ? `
        <div class="${updateClassName("tile", changedFields.has("style_notes"))}">
          <div class="mini-eyebrow">Style Notes</div>
          <ul>${styleNotes.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        </div>
      ` : ""}

      ${characters.length ? `
        <div class="${changedFields.has("characters") ? "context-section is-updated" : "context-section"}">
          <div class="mini-eyebrow">Characters</div>
          <div class="grid grid-characters">
            ${characters.map(character => {
              const name = character.name || "Unnamed";
              const role = character.role || "No role summary yet.";
              const aliases = Array.isArray(character.aliases) ? character.aliases.filter(Boolean) : [];
              const characterKey = String(name).trim().toLowerCase();
              const showDetail = shouldShowCharacterDetail(role, aliases);
              const detailBody = [
                role,
                aliases.length ? `Aliases: ${aliases.join(", ")}` : "Aliases: none",
              ].join("\n\n");
              return `
              <div class="${updateClassName("tile tile-fixed", changedCharacters.has(characterKey))}">
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
        <div class="${changedFields.has("glossary") ? "context-section is-updated" : "context-section"}">
          <div class="mini-eyebrow">Glossary</div>
          <div class="grid grid-glossary">
            ${glossary.map(entry => {
              const term = entry.term || "Untitled term";
              const meaning = entry.meaning || "No glossary note yet.";
              const glossaryKey = String(term).trim().toLowerCase();
              const showDetail = shouldShowGlossaryDetail(meaning, Boolean(entry.keep));
              const detailBody = meaning;
              return `
              <div class="${updateClassName("tile tile-fixed", changedGlossary.has(glossaryKey))}">
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
        <div class="${updateClassName("tile", changedFields.has("unresolved_ambiguities"))}">
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
  const languageTips = String(options.targetLanguageTips || "");
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
          ${scope === "main" ? `
            <label class="field-span-full">
              <span class="label-row">Target Language Tips</span>
              <div class="tips-history" data-tips-history-root="${escapeHtml(LANGUAGE_TIPS_TARGET_MAIN)}">
                <div class="tips-history-input-row">
                  <input
                    type="text"
                    data-context-language-tips
                    data-context-scope="${escapeHtml(scope)}"
                    data-tips-input="${escapeHtml(LANGUAGE_TIPS_TARGET_MAIN)}"
                    value="${escapeHtml(languageTips)}"
                    placeholder="Optional language-specific tips"
                    title="Optional guidance about local target-language usage and register. Example: pt-BR only, avoid 'tu', avoid Portugal Portuguese forms."
                  />
                  <button
                    type="button"
                    class="ghost small tips-history-toggle"
                    data-tips-history-toggle="${escapeHtml(LANGUAGE_TIPS_TARGET_MAIN)}"
                    aria-expanded="false"
                    title="Open saved language tips"
                  >History</button>
                </div>
                <div class="tips-history-menu" data-tips-history-menu="${escapeHtml(LANGUAGE_TIPS_TARGET_MAIN)}"></div>
              </div>
            </label>
          ` : ""}
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

function readContextLanguageTips(scope, root = document) {
  return String(root.querySelector(`[data-context-language-tips][data-context-scope="${scope}"]`)?.value || "").trim();
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
    contextLanguageTipsDrafts.set(editingJobId, readContextLanguageTips("main", root));
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
  const previousRendered = renderedContextSnapshots.get(job.id) || null;
  const delta = diffSessionSnapshot(previousRendered, ctx);
  renderedContextSnapshots.set(job.id, cloneSnapshot(ctx));
  const validation = job.validation_stats || {};
  const fixedTotal = Number(validation.auto_fixed_subtitles || 0) + Number(validation.manual_fixed_subtitles || 0);
  const translatedCount = Number(Array.isArray(job.translated_lines) ? job.translated_lines.length : 0);
  const sourceCount = Number(Array.isArray(job.original_lines) ? job.original_lines.length : 0);
  const etaLabel = job.status === "processing" ? formatJobEta(job) : "Paused";
  const timeoutWarning = latestTimeoutWarning(job);
  const canResume = job.status === "paused" || job.status === "failed";
  const callProgress = currentModelCallProgress(job);
  const resumeLabel = job.status === "failed" ? "Resume Failed Job" : "Resume";
  const resumeTitle = job.status === "failed"
    ? "Resume a failed translation from the last unfinished batch using current Prompt Lab runtime settings."
    : "Resume a paused job from the next pending batch using current Prompt Lab runtime settings.";
  return `
    <div class="context-card">
      <button class="job-corner-log" data-action="logs" data-id="${job.id}" title="Open the verbose execution log with retries, validation checks, and flagged lines.">
        <span class="job-corner-label" aria-hidden="true">log</span>
      </button>
      <div class="panel-head">
        <div>
          <h2>Translation Context</h2>
          <div class="job-meta">Rolling card shared across batches</div>
        </div>
        ${statusBadge(job.status)}
      </div>
      ${callProgress ? `
        <div class="progress model-call-progress-top" title="Current model call is running">
          <div
            class="progress-bar js-model-call-progress-bar"
            data-target-percent="${callProgress.percent}"
            data-started-at-ms="${callProgress.startedAtMs}"
            data-expected-seconds="${callProgress.expectedSeconds}"
            data-call-key="${escapeHtml(callProgress.callKey)}"
          ></div>
        </div>
      ` : ""}
      ${renderRuntimeActivity(job)}
      <div class="actions">
        <button class="warn" data-action="pause" data-id="${job.id}" title="Pause after the current batch finishes. Safer than interrupting a request mid-generation." ${job.status !== "processing" ? "disabled" : ""}>Pause</button>
        <button class="ghost" data-action="resume" data-id="${job.id}" title="${escapeHtml(resumeTitle)}" ${!canResume ? "disabled" : ""}>${escapeHtml(resumeLabel)}</button>
        <a class="ghost link-button" href="/review/${job.id}" title="Open the dedicated table review workspace for this job.">Open Workspace</a>
        <button class="ghost" data-action="review-lines" data-id="${job.id}" data-filter="all" title="Open the line review panel. Use it to inspect flagged lines and apply manual fixes.">Review Lines</button>
        <button class="ghost" data-action="logs" data-id="${job.id}" title="Open the verbose execution log with retries, validation checks, and flagged lines.">View Log</button>
        <button class="ghost" data-action="edit" data-id="${job.id}" title="Edit the rolling context card before the next batch uses it." ${(job.status !== "processing" && job.status !== "paused") ? "disabled" : ""}>Edit Context</button>
        <button class="danger" data-action="stop" data-id="${job.id}" title="Cancel the active app request and stop the job. If LM Studio keeps generating after client disconnect, cancel it in LM Studio too." ${(job.status !== "processing" && job.status !== "paused") ? "disabled" : ""}>Stop</button>
      </div>
      ${timeoutWarning ? `<div class="runtime-warning">${escapeHtml(timeoutWarning)}</div>` : ""}
      <div class="validation-summary">
        ${metricStat(
          "Translated",
          `${translatedCount}/${sourceCount || 0}${job.status === "processing" ? ` · ETA ${etaLabel}` : ""}`,
          "is-progress",
          "Current translated line count out of total source subtitle lines. ETA is adaptive and recalculated after each completed batch.",
        )}
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
      ${renderVisionTimeline(job, true, "active")}
      ${renderSessionSnapshot(ctx, false, delta)}
      ${previous ? `
        <details class="context-history tile" data-context-history="${escapeHtml(job.id)}" ${expandedContextHistory.has(job.id) ? "open" : ""}>
          <summary class="context-history-summary">
            <div>
              <div class="mini-eyebrow">Previous Snapshot</div>
              <div class="context-history-preview">${escapeHtml(previous.scene_context || previous.premise || "Open the previous card snapshot.")}</div>
            </div>
          </summary>
          <div class="context-history-body">
            ${renderSessionSnapshot(previous, true)}
          </div>
        </details>
      ` : ""}
    </div>
  `;
}

function renderJobs(jobs) {
  captureVisionRailScrolls(activeJobCard);
  captureVisionRailScrolls(jobsEl);
  if (!jobs.length) {
    jobsEl.innerHTML = `<p class="job-meta">No jobs yet.</p>`;
    activeJobCard.classList.add("hidden");
    activeJobCard.innerHTML = "";
    stopModelCallAnimation();
    modelCallRenderedState.clear();
    return;
  }

  const active = jobs.find(job => job.status === "processing" || job.status === "paused");
  if (active && active.session_context) {
    const existingBar = activeJobCard.querySelector(".js-model-call-progress-bar");
    if (existingBar && existingBar.parentElement) {
      const barWidth = existingBar.getBoundingClientRect().width;
      const trackWidth = existingBar.parentElement.getBoundingClientRect().width;
      if (trackWidth > 0 && Number.isFinite(barWidth)) {
        const renderedPercent = Math.max(0, Math.min(100, (barWidth / trackWidth) * 100));
        const existingCallKey = String(existingBar.dataset.callKey || "");
        modelCallRenderedState.set(active.id, { percent: renderedPercent, callKey: existingCallKey });
      }
    }
    activeJobCard.classList.remove("hidden");
    activeJobCard.innerHTML = renderContext(active);
    animateCurrentModelCallBar(active);
    requestAnimationFrame(() => refreshVisionRails(activeJobCard));
  } else {
    activeJobCard.classList.add("hidden");
    activeJobCard.innerHTML = "";
    stopModelCallAnimation();
    modelCallRenderedState.clear();
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
      const referenceTracks = Array.isArray(job.reference_tracks) ? job.reference_tracks : [];
      const sourceCount = Number(Array.isArray(job.original_lines) ? job.original_lines.length : 0);
      const requestTimeout = Math.max(15, Number(job?.settings?.request_timeout_seconds || 120));
      const referenceLanguages = referenceTracks.map(track => String(track?.language || "").trim()).filter(Boolean);
      const kind = job?.job_kind === "review" ? "Validation Review" : "Translation";
      const message = escapeHtml(job.message || "Waiting for update.");
      const timeoutWarning = latestTimeoutWarning(job);
      const logCount = Array.isArray(job.logs) ? job.logs.length : 0;
      const logTitle = logCount
        ? `Show verbose runtime events, retries, and validation decisions. ${logCount} log entries available.`
        : "Show verbose runtime events, retries, and validation decisions.";
      const validation = job.validation_stats || {};
      const vision = job.vision_stats || {};
      const adaptiveVisionEnabled = Boolean(job?.settings?.adaptive_vision);
      const sceneVisionEnabled = Boolean(job?.settings?.visual_scene_context);
      const visionEnabled = adaptiveVisionEnabled || sceneVisionEnabled;
      const issueCount = Array.isArray(job.validation_issues) ? job.validation_issues.length : 0;
      const fixedTotal = Number(validation.auto_fixed_subtitles || 0) + Number(validation.manual_fixed_subtitles || 0);
      const canResume = job.status === "paused" || job.status === "failed";
      const resumeLabel = job.status === "failed" ? "Resume Failed" : "Resume";
      const resumeTitle = job.status === "failed"
        ? "Resume this failed translation from the last unfinished batch using current Prompt Lab runtime settings."
        : "Resume this paused translation using current Prompt Lab runtime settings.";
      const canEditContext = job?.job_kind !== "review";
      const editContextTitle = "Edit the context card and language tips used by resume/retranslation calls.";
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
            ${referenceLanguages.length ? `<span class="job-fact">Refs ${escapeHtml(referenceLanguages.join(", "))}</span>` : ""}
            ${sceneVisionEnabled ? `<span class="job-fact">Visual scene guides</span>` : ""}
            ${adaptiveVisionEnabled ? `<span class="job-fact">Vision doubt checks</span>` : ""}
            ${vision.scene_cards_total ? `<span class="job-fact">Scene guides ${escapeHtml(String(vision.scene_cards_created || 0))}/${escapeHtml(String(vision.scene_cards_total))}</span>` : ""}
            ${vision.clarification_requests ? `<span class="job-fact">Vision calls ${escapeHtml(String(vision.clarification_requests))}</span>` : ""}
            ${vision.lines_revised ? `<span class="job-fact">Vision revised ${escapeHtml(String(vision.lines_revised))}</span>` : ""}
            ${vision.clarification_failures ? `<span class="job-fact">Vision failed ${escapeHtml(String(vision.clarification_failures))}</span>` : ""}
            <span class="job-fact">Progress ${progress}</span>
            <span class="job-fact">Timeout ${escapeHtml(String(requestTimeout))}s</span>
            ${(validation.suspicious_subtitles || fixedTotal || validation.error_subtitles) ? `
              <span class="job-fact">Suspect ${escapeHtml(String(validation.suspicious_subtitles || 0))}</span>
              <span class="job-fact">Fixed ${escapeHtml(String(fixedTotal))}</span>
              <span class="job-fact">Error ${escapeHtml(String(validation.error_subtitles || 0))}</span>
            ` : ""}
          </div>
          <div class="job-meta">${message}</div>
          ${renderRuntimeActivity(job, true)}
          ${timeoutWarning ? `<div class="runtime-warning compact">${escapeHtml(timeoutWarning)}</div>` : ""}
          ${referenceTracks.length ? `
            <div class="reference-track-summary-list">
              ${referenceTracks.map(track => renderReferenceTrackSummary(track, true, sourceCount)).join("")}
            </div>
          ` : ""}
          ${renderVisionTimeline(job, true, "job")}
        </div>
        <div class="job-actions">
          <button class="ghost" data-action="resume" data-id="${job.id}" title="${escapeHtml(resumeTitle)}" ${!canResume ? "disabled" : ""}>${escapeHtml(resumeLabel)}</button>
          <button class="ghost" data-action="edit" data-id="${job.id}" title="${escapeHtml(editContextTitle)}" ${!canEditContext ? "disabled" : ""}>Edit Context</button>
          <button class="ghost" data-action="review-lines" data-id="${job.id}" data-filter="all" title="Inspect flagged subtitle lines and save manual fixes." ${issueCount ? "" : "disabled"}>Review Lines${issueCount ? ` (${issueCount})` : ""}</button>
          ${job.status === "completed" ? `<button class="ghost" data-action="download" data-id="${job.id}" title="Download the current translated subtitle file.">Download</button>` : ""}
          <button class="ghost" data-action="delete-job" data-id="${job.id}" title="Remove this job entry from the list. Active jobs must be paused or stopped first." ${(job.status === "processing" || job.status === "queued") ? "disabled" : ""}>Delete</button>
        </div>
      </div>
      <div class="job-progress-row">
        <div class="job-progress-label">Translation progress</div>
        <div class="job-progress-value">${progress}</div>
      </div>
      ${renderEtaPill(job)}
      <div class="progress"><div class="progress-bar" style="width:${job.progress || 0}%"></div></div>
    </article>
  `;
    }).join("")}</div>
  `;
  requestAnimationFrame(() => refreshVisionRails(jobsEl));
}

function renderLogDialog(job, options = {}) {
  if (!job || !logDialogTitle || !logDialogBody) return;
  captureVisionRailScrolls(logDialogBody);
  const savedReading = options.restoreReading ? logDialogReadingState.get(job.id) : null;
  const preserveScroll = Boolean(options.preserveScroll || savedReading);
  const previousScrollTop = savedReading?.scrollTop ?? logDialogBody.scrollTop;
  const previousScrollHeight = savedReading?.scrollHeight ?? logDialogBody.scrollHeight;
  const wasNearTop = previousScrollTop <= 24;
  const title = job.title || job.filename || "Job";
  const logs = Array.isArray(job.logs) ? job.logs : [];
  const issues = Array.isArray(job.validation_issues) ? job.validation_issues : [];
  const referenceTracks = Array.isArray(job.reference_tracks) ? job.reference_tracks : [];
  const visualObservations = Array.isArray(job.visual_observations) ? job.visual_observations : [];
  const visionStats = job.vision_stats || {};
  const adaptiveVisionEnabled = Boolean(job?.settings?.adaptive_vision);
  const sceneVisionEnabled = Boolean(job?.settings?.visual_scene_context);
  const visionEnabled = adaptiveVisionEnabled || sceneVisionEnabled;
  const sourceCount = Number(Array.isArray(job.original_lines) ? job.original_lines.length : 0);
  const translatedCount = Number(Array.isArray(job.translated_lines) ? job.translated_lines.length : 0);
  const latestLogs = [...logs].reverse();
  const latestEvent = latestLogs[0] || null;
  const latestBatch = latestEvent && hasBatchIndex(latestEvent.batch_index) ? `Batch ${Number(latestEvent.batch_index)}` : "System";
  const latestLevel = escapeHtml(latestEvent?.level || "info");
  const timeoutInfo = currentRequestTimeoutInfo(job);
  const activeTab = logDialogTabs.get(job.id) || "events";
  const issueCount = issues.length;
  logDialogTitle.textContent = `${title} Log`;
  if (!logs.length && !issues.length && !referenceTracks.length && !visionEnabled) {
    logDialogBody.innerHTML = `<p class="job-meta">No verbose events yet.</p>`;
    return;
  }
  logDialogBody.innerHTML = `
    <div class="log-tabs" role="tablist" aria-label="Log sections">
      <button type="button" class="log-tab ${activeTab === "events" ? "active" : ""}" data-log-tab="events">Events ${escapeHtml(String(logs.length))}</button>
      <button type="button" class="log-tab ${activeTab === "references" ? "active" : ""}" data-log-tab="references" ${referenceTracks.length ? "" : "disabled"}>References ${escapeHtml(String(referenceTracks.length))}</button>
      <button type="button" class="log-tab ${activeTab === "vision" ? "active" : ""}" data-log-tab="vision" ${visionEnabled ? "" : "disabled"}>Vision ${escapeHtml(String(visualObservations.length + (job.visual_scene_contexts || []).length))}</button>
      <button type="button" class="log-tab ${activeTab === "issues" ? "active" : ""}" data-log-tab="issues" ${issueCount ? "" : "disabled"}>Issues ${escapeHtml(String(issueCount))}</button>
      <span class="log-follow-state">${preserveScroll && !wasNearTop ? "Reading position locked" : "Following newest"}</span>
    </div>
    <div class="log-overview">
      <div class="log-overview-item">
        <span>Status</span>
        <strong>${escapeHtml(job.status || "unknown")}</strong>
      </div>
      <div class="log-overview-item">
        <span>Progress</span>
        <strong>${escapeHtml(String(translatedCount))}/${escapeHtml(String(sourceCount || 0))}</strong>
      </div>
      <div class="log-overview-item">
        <span>Batch</span>
        <strong>${escapeHtml(String(job.current_batch || 0))}/${escapeHtml(String(job.total_batches || 0))}</strong>
      </div>
      <div class="log-overview-item">
        <span>Timeout</span>
        <strong title="${escapeHtml(timeoutInfo.detail)}"${timeoutInfoAttrs(timeoutInfo)}>${escapeHtml(timeoutInfo.label)}</strong>
      </div>
      ${visionEnabled ? `
        <div class="log-overview-item">
          <span>Vision</span>
          <strong>${escapeHtml(String(visionStats.lines_revised || 0))} revised</strong>
        </div>
      ` : ""}
    </div>
    ${renderRuntimeActivity(job)}
    <section class="log-tab-panel ${activeTab === "events" ? "active" : ""}" data-log-panel="events">
      ${latestEvent ? `
        <article class="log-entry latest ${latestLevel}">
          <div class="log-entry-head">
            <span class="log-badge ${latestLevel}">latest</span>
            <span class="log-time">${escapeHtml(formatTimestamp(latestEvent.timestamp))}</span>
            <span class="log-batch">${escapeHtml(latestBatch)}</span>
          </div>
          <div class="log-message">${escapeHtml(latestEvent.message || "")}</div>
        </article>
      ` : ""}
      <div class="log-section">
        <div class="log-section-head">
          <div class="mini-eyebrow">Newest Events First</div>
          <div class="job-meta">${escapeHtml(String(logs.length))} event${logs.length === 1 ? "" : "s"}</div>
        </div>
        <div class="log-list">
        ${latestLogs.map(entry => {
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
    </section>
    <section class="log-tab-panel ${activeTab === "references" ? "active" : ""}" data-log-panel="references">
      ${referenceTracks.length ? `
        <div class="mini-eyebrow">Reference Track Alignment</div>
        <p class="job-meta">Reference tracks are supporting context only. The primary subtitle remains canonical.</p>
        <div class="reference-track-summary-list">
          ${referenceTracks.map(track => renderReferenceTrackSummary(track, false, sourceCount)).join("")}
        </div>
      ` : `<p class="job-meta">No reference subtitles were loaded for this job.</p>`}
    </section>
    <section class="log-tab-panel ${activeTab === "vision" ? "active" : ""}" data-log-panel="vision">
      ${visionEnabled ? `
        <div class="mini-eyebrow">Visual Understanding</div>
        <p class="job-meta">
          ${escapeHtml(job.video_filename || "Source video loaded")}.
          ${sceneVisionEnabled ? "Scene guides are prepared before translation." : ""}
          ${adaptiveVisionEnabled ? "Translation doubts require a concrete alternative before frames are requested." : ""}
        </p>
        <div class="job-facts">
          ${sceneVisionEnabled ? `<span class="job-fact">Scene guides ${escapeHtml(String(visionStats.scene_cards_created || 0))}/${escapeHtml(String(visionStats.scene_cards_total || "?"))}</span>` : ""}
          ${visionStats.scene_context_failures ? `<span class="job-fact">Scene failures ${escapeHtml(String(visionStats.scene_context_failures))}</span>` : ""}
          <span class="job-fact">Requested ${escapeHtml(String(visionStats.doubts_requested || 0))}</span>
          <span class="job-fact" title="Model-reported visual doubts that passed the app's validation and per-batch limits.">Approved ${escapeHtml(String(visionStats.doubts_approved || 0))}</span>
          <span class="job-fact">Rejected ${escapeHtml(String(visionStats.doubts_rejected || 0))}</span>
          <span class="job-fact" title="Batches that triggered one multimodal follow-up request with screenshots.">Calls ${escapeHtml(String(visionStats.clarification_requests || 0))}</span>
          <span class="job-fact" title="Subtitle lines changed after the model inspected the requested screenshots.">Revised ${escapeHtml(String(visionStats.lines_revised || 0))}</span>
          <span class="job-fact">Failed ${escapeHtml(String(visionStats.clarification_failures || 0))}</span>
        </div>
        ${renderVisionTimeline(job, false, "log")}
        ${(job.visual_scene_contexts || []).length ? `
          <div class="issue-list">
            ${[...(job.visual_scene_contexts || [])].reverse().map(scene => `
              <article class="issue-entry">
                <div class="issue-entry-head">
                  <span class="log-badge info">scene ${escapeHtml(String(scene.scene_index || "?"))}</span>
                  <span class="log-batch">Lines ${escapeHtml(String(Number(scene.start_position || 0) + 1))}-${escapeHtml(String(Number(scene.end_position || 0) + 1))}</span>
                  <span class="log-time">${escapeHtml(scene.start_time || "")}</span>
                </div>
                <div class="issue-copy">${escapeHtml(scene.summary || scene.setting || "Visual scene guide ready.")}</div>
              </article>
            `).join("")}
          </div>
        ` : ""}
        ${visualObservations.length ? `
          <div class="issue-list">
            ${[...visualObservations].reverse().map(observation => `
              <article class="issue-entry">
                <div class="issue-entry-head">
                  <span class="log-badge info">${escapeHtml(observation.category || "visual")}</span>
                  <span class="log-batch">Line ${escapeHtml(String((observation.position ?? 0) + 1))}</span>
                  <span class="log-time">${escapeHtml(observation.confidence || "unknown")} confidence</span>
                </div>
                <div class="issue-copy">${escapeHtml(observation.answer || "No visual answer recorded.")}</div>
              </article>
            `).join("")}
          </div>
        ` : `<p class="job-meta">No visual clarification has been needed yet.</p>`}
      ` : `<p class="job-meta">Adaptive vision is disabled for this job.</p>`}
    </section>
    <section class="log-tab-panel ${activeTab === "issues" ? "active" : ""}" data-log-panel="issues">
      ${issues.length ? `
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
      ` : `<p class="job-meta">No flagged subtitle lines yet.</p>`}
    </section>
  `;
  if (preserveScroll && !wasNearTop) {
    const heightDelta = logDialogBody.scrollHeight - previousScrollHeight;
    logDialogBody.scrollTop = Math.max(0, previousScrollTop + heightDelta);
  } else {
    logDialogBody.scrollTop = 0;
  }
  logDialogReadingState.set(job.id, {
    scrollTop: logDialogBody.scrollTop,
    scrollHeight: logDialogBody.scrollHeight,
  });
  requestAnimationFrame(() => refreshVisionRails(logDialogBody));
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
  const currentLanguageTips = contextLanguageTipsDrafts.has(job.id)
    ? contextLanguageTipsDrafts.get(job.id)
    : String(job?.settings?.target_language_tips || "");
  contextDialogBody.innerHTML = renderContextEditor("main", currentDraft, { targetLanguageTips: currentLanguageTips });
  renderLanguageTipsHistoryMenu(LANGUAGE_TIPS_TARGET_MAIN, contextDialogBody);
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
  jobsById.clear();
  for (const job of jobs) {
    jobsById.set(job.id, job);
  }
  for (const job of jobs) {
    learnModelCallDurations(job);
  }
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
      renderLogDialog(openJob, { preserveScroll: true });
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
  if (createJobInFlight) return;
  saveSettings();
  const referenceTracks = collectReferenceTracks();
  if (referenceTracks === null) return;
  const data = new FormData();
  const file = fileInput.files[0];
  if (!file) return;
  const videoFile = videoFileInput?.files && videoFileInput.files[0];
  const visionEnabled = Boolean(
    adaptiveVisionInput?.checked || visualSceneContextInput?.checked
  );
  if (visionEnabled && !videoFile) {
    alert("Select a source video or turn off the visual features.");
    return;
  }
  const submitButton = form.querySelector('button[type="submit"]');
  const originalSubmitText = submitButton?.textContent || "Translate Subtitle";
  createJobInFlight = true;
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "Creating Job...";
  }
  data.append("file", file);
  if (visionEnabled && videoFile) data.append("video_file", videoFile);
  for (const track of referenceTracks) {
    data.append("reference_languages", track.language);
    data.append("reference_files", track.file);
  }
  const payload = collectSettingsPayload();
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "boolean") {
      data.append(key, value ? "true" : "false");
    } else if (value !== undefined && value !== null) {
      data.append(key, value);
    }
  }

  try {
    const response = await fetch("/api/jobs", {
      method: "POST",
      body: data,
    });
    if (!response.ok) {
      alert(await responseErrorDetail(response, "Could not create job."));
      return;
    }
    rememberLanguageTip(payload.target_language_tips);
    rememberModel(document.getElementById("model")?.value);
    form.reset();
    loadSettings();
    updateSelectedFileLabel();
    updateSelectedTranslatedFileLabel();
    updateSelectedVideoFileLabel();
    resetReferenceTrackRows();
    await fetchJobs();
  } catch (error) {
    alert(error?.message || "Could not create job.");
  } finally {
    createJobInFlight = false;
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = originalSubmitText;
    }
  }
}

async function createReviewJob() {
  saveSettings();
  const referenceTracks = collectReferenceTracks();
  if (referenceTracks === null) return;
  const sourceFile = fileInput.files[0];
  const translatedFile = translatedFileInput.files[0];
  if (!sourceFile || !translatedFile) {
    alert("Select both source and translated .srt files.");
    return;
  }
  const data = new FormData();
  data.append("source_file", sourceFile);
  data.append("translated_file", translatedFile);
  for (const track of referenceTracks) {
    data.append("reference_languages", track.language);
    data.append("reference_files", track.file);
  }
  const payload = collectSettingsPayload();
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "boolean") {
      data.append(key, value ? "true" : "false");
    } else if (value !== undefined && value !== null) {
      data.append(key, value);
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
  rememberLanguageTip(payload.target_language_tips);
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
  if (targetInput === videoFileInput) {
    const extension = String(file.name || "").toLowerCase().split(".").pop();
    const isVideo = String(file.type || "").startsWith("video/") || VIDEO_FILE_EXTENSIONS.has(extension);
    if (!isVideo) {
      alert("Drop a supported video file: MP4, MKV, WebM, MOV, AVI, M4V, or TS.");
      return;
    }
    setInputFile(targetInput, file);
    acceptSelectedVideo();
    return;
  }
  if (!file.name.toLowerCase().endsWith(".srt")) {
    alert("Only .srt files are supported.");
    return;
  }
  setInputFile(targetInput, file);
  if (targetInput === translatedFileInput) {
    updateSelectedTranslatedFileLabel();
    return;
  }
  if (targetInput === fileInput) {
    updateSelectedFileLabel();
    return;
  }
  const row = targetInput.closest(".reference-track-row");
  if (row) {
    updateReferenceTrackLabel(row);
  }
}

function bindDropZone(zone, targetInput) {
  if (!zone) return;
  zone.addEventListener("dragenter", (event) => {
    event.preventDefault();
    event.stopPropagation();
    zone.classList.add("dragover");
  });
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.stopPropagation();
    zone.classList.add("dragover");
  });
  zone.addEventListener("dragleave", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!zone.contains(event.relatedTarget)) {
      zone.classList.remove("dragover");
    }
  });
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    zone.classList.remove("dragover");
    handleDroppedFiles(event.dataTransfer.files, targetInput);
  });
}

function bindReferenceTrackCard(zone) {
  if (!zone) return;
  zone.addEventListener("dragenter", (event) => {
    if (event.target.closest(".reference-track-row")) return;
    event.preventDefault();
    zone.classList.add("dragover");
  });
  zone.addEventListener("dragover", (event) => {
    if (event.target.closest(".reference-track-row")) return;
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
    if (event.target.closest(".reference-track-row")) return;
    event.preventDefault();
    zone.classList.remove("dragover");
    addReferenceTracksFromFiles(event.dataTransfer.files);
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
    renderLogDialog(job, { restoreReading: true });
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

  if (action === "resume") {
    await fetch(`/api/jobs/${jobId}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime_settings: collectRuntimeOverridePayload() }),
    });
    await fetchJobs();
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
    alert(await responseErrorDetail(response, "Could not generate batch card."));
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
  const targetLanguageTips = readContextLanguageTips("main", contextDialogBody);
  const response = await fetch(`/api/jobs/${editingJobId}/context`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_context: payload, target_language_tips: targetLanguageTips }),
  });
  if (!response.ok) {
    alert("Could not update context.");
    return;
  }
  rememberLanguageTip(targetLanguageTips);
  contextEditorDrafts.delete(scopeDraftKey("main", editingJobId));
  contextLanguageTipsDrafts.delete(editingJobId);
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
    alert(await responseErrorDetail(response, "Could not generate context card."));
    return;
  }
  const data = await response.json();
  contextEditorDrafts.set(scopeDraftKey("main", editingJobId), normalizeContextInput(data.session_context));
  const jobResponse = await fetch(`/api/jobs/${editingJobId}`);
  const job = await jobResponse.json();
  renderMainContextDialog(job, data.session_context);
}

document.addEventListener("click", (event) => {
  const tipsToggle = event.target.closest("[data-tips-history-toggle]");
  if (tipsToggle) {
    toggleLanguageTipsMenu(tipsToggle.dataset.tipsHistoryToggle || "");
    return;
  }
  const tipsApply = event.target.closest("[data-tips-history-apply]");
  if (tipsApply) {
    const target = tipsApply.dataset.tipsHistoryApply || "";
    const value = tipsApply.dataset.tipValue || "";
    setLanguageTipsInputValue(target, value);
    closeLanguageTipsMenus();
    return;
  }
  const tipsDelete = event.target.closest("[data-tips-history-delete]");
  if (tipsDelete) {
    const target = tipsDelete.dataset.tipsHistoryDelete || "";
    const value = tipsDelete.dataset.tipValue || "";
    forgetLanguageTip(value);
    const root = rootForTipsTarget(target);
    renderLanguageTipsHistoryMenu(target, root);
    const menu = root.querySelector(`[data-tips-history-menu="${target}"]`);
    const toggle = root.querySelector(`[data-tips-history-toggle="${target}"]`);
    if (menu && toggle) {
      menu.classList.add("open");
      toggle.setAttribute("aria-expanded", "true");
    }
    return;
  }
  if (!event.target.closest(".tips-history")) {
    closeLanguageTipsMenus();
  }
  const historySummary = event.target.closest(".context-history-summary");
  if (historySummary) {
    const details = historySummary.closest("[data-context-history]");
    const jobId = details?.dataset.contextHistory;
    if (jobId) {
      const nextOpen = !details.hasAttribute("open");
      if (nextOpen) {
        expandedContextHistory.add(jobId);
      } else {
        expandedContextHistory.delete(jobId);
      }
    }
  }
  const workspaceCard = event.target.closest(".job-workspace-link[data-workspace-url]");
  if (workspaceCard && !event.target.closest("button, a, input, textarea, select, summary, label")) {
    const selection = window.getSelection();
    const hasTextSelection = selection
      && String(selection.toString() || "").trim().length > 0
      && workspaceCard.contains(selection.anchorNode)
      && workspaceCard.contains(selection.focusNode);
    if (hasTextSelection) {
      return;
    }
    window.location.href = workspaceCard.dataset.workspaceUrl;
    return;
  }
  const visionFrame = event.target.closest("[data-vision-frame][data-vision-job]");
  if (visionFrame) {
    event.preventDefault();
    event.stopPropagation();
    openVisionEvidence(visionFrame.dataset.visionJob, visionFrame.dataset.visionFrame);
    return;
  }
  const visionScroll = event.target.closest("[data-vision-scroll]");
  if (visionScroll) {
    event.preventDefault();
    event.stopPropagation();
    const rail = visionScroll.closest(".vision-timeline")?.querySelector(".vision-rail");
    if (!rail) return;
    const direction = Number(visionScroll.dataset.visionScroll || 0);
    rail.scrollBy({
      left: direction * Math.max(220, rail.clientWidth * 0.72),
      behavior: "smooth",
    });
    rememberVisionRailScroll(rail);
    window.setTimeout(() => scheduleVisionRailFocus(rail), 180);
    return;
  }
  const referenceRemove = event.target.closest("[data-reference-remove]");
  if (referenceRemove) {
    removeReferenceTrackRow(referenceRemove);
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
  const logTab = event.target.closest("[data-log-tab]");
  if (logTab && openLogJobId) {
    const tab = logTab.dataset.logTab || "events";
    logDialogTabs.set(openLogJobId, tab);
    void fetch(`/api/jobs/${openLogJobId}`)
      .then(response => response.json())
      .then(job => renderLogDialog(job));
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
  const languageTipsField = event.target.closest("[data-context-language-tips]");
  if (languageTipsField) {
    const root = languageTipsField.closest("dialog") || document;
    const scope = root === snapshotDialog ? "snapshot" : "main";
    if (scope === "main" && editingJobId) {
      contextLanguageTipsDrafts.set(editingJobId, readContextLanguageTips("main", root));
    }
    return;
  }
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

document.addEventListener("change", (event) => {
  const referenceFileInput = event.target.closest("[data-reference-file]");
  if (referenceFileInput) {
    updateReferenceTrackLabel(referenceFileInput.closest(".reference-track-row"));
  }
});

document.addEventListener("toggle", (event) => {
  const details = event.target;
  if (!(details instanceof HTMLDetailsElement) || !details.matches("[data-context-history]")) return;
  const jobId = details.dataset.contextHistory;
  if (!jobId) return;
  if (details.open) {
    expandedContextHistory.add(jobId);
  } else {
    expandedContextHistory.delete(jobId);
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
addReferenceTrackBtn?.addEventListener("click", () => addReferenceTrackRow());
resetPromptLabBtn?.addEventListener("click", () => resetPromptLabDefaults());
for (const button of consoleTabButtons) {
  button.addEventListener("click", () => setConsoleTab(button.dataset.consoleTab || "runtime"));
}
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
logDialogBody?.addEventListener("scroll", () => {
  if (!openLogJobId) return;
  logDialogReadingState.set(openLogJobId, {
    scrollTop: logDialogBody.scrollTop,
    scrollHeight: logDialogBody.scrollHeight,
  });
}, { passive: true });
document.addEventListener("scroll", (event) => {
  const rail = event.target instanceof Element && event.target.matches(".vision-rail")
    ? event.target
    : null;
  if (rail) {
    rememberVisionRailScroll(rail);
    scheduleVisionRailFocus(rail);
  }
}, true);
document.addEventListener("wheel", (event) => {
  const rail = event.target instanceof Element ? event.target.closest(".vision-rail") : null;
  if (!rail || rail.scrollWidth <= rail.clientWidth) return;
  const horizontalDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (!horizontalDelta) return;
  event.preventDefault();
  rail.scrollLeft += horizontalDelta;
  rememberVisionRailScroll(rail);
  scheduleVisionRailFocus(rail);
}, { passive: false });
window.addEventListener("resize", () => refreshVisionRails(), { passive: true });
dialog?.addEventListener("close", () => {
  closeLanguageTipsMenus();
  if (editingJobId) {
    contextEditorDrafts.delete(scopeDraftKey("main", editingJobId));
    contextLanguageTipsDrafts.delete(editingJobId);
  }
  editingJobId = null;
});
fileInput.addEventListener("change", updateSelectedFileLabel);
translatedFileInput.addEventListener("change", updateSelectedTranslatedFileLabel);
videoFileInput?.addEventListener("change", acceptSelectedVideo);
visionEvidencePrev?.addEventListener("click", () => navigateVisionEvidence(-1));
visionEvidenceNext?.addEventListener("click", () => navigateVisionEvidence(1));
visionEvidenceDialog?.addEventListener("close", () => {
  openVisionEvidenceJobId = null;
  openVisionEvidenceFrameId = null;
});
document.addEventListener("keydown", (event) => {
  if (!visionEvidenceDialog?.open) return;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    navigateVisionEvidence(-1);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    navigateVisionEvidence(1);
  }
});
adaptiveVisionInput?.addEventListener("change", () => {
  saveSettings();
  updateVisionControls();
});
visualSceneContextInput?.addEventListener("change", () => {
  saveSettings();
  updateVisionControls();
});
initialCardStrategyInput?.addEventListener("change", () => void refreshInitialCardEstimate());
initialCardMaxCharsInput?.addEventListener("input", () => void refreshInitialCardEstimate());
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
bindDropZone(videoDropZone, videoFileInput);
bindReferenceTrackCard(referenceTracksCard);
setConsoleTab("runtime");
renderLanguageTipsHistoryMenu(LANGUAGE_TIPS_TARGET_SETUP, document);

async function initializeApp() {
  await fetchRuntimeDefaults();
  loadSettings();
  applyRuntimeDefaults();
  renderModelHistory();
  renderModelSelect();
  renderLanguageTipsHistoryMenu(LANGUAGE_TIPS_TARGET_SETUP, document);
  updateSelectedFileLabel();
  updateSelectedTranslatedFileLabel();
  updateSelectedVideoFileLabel();
  renderReferenceTrackEmptyState();
  await refreshInitialCardEstimate();
  requestAnimationFrame(() => {
    document.body.classList.add("page-ready");
  });
  await fetchModelList();
  await fetchJobs();
  setInterval(fetchJobs, 2500);
  setInterval(updateLiveTimeoutDisplays, 1000);
}

void initializeApp();
