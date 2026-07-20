# AI SubContext - Project Index

*Startup map for the context-aware subtitle translation and review application*

## Architecture

AI SubContext is a local FastAPI application with a vanilla HTML/CSS/JavaScript frontend.

1. `app/static/` - translation console, review workspace, and Prompt Lab
2. `app/main.py` - FastAPI pages and API boundary
3. `app/job_manager.py` - job lifecycle, persistence, batching, vision, and review orchestration
4. `app/translator.py` - OpenAI-compatible requests, prompts, schemas, validation, retries, and translation
5. `app/srt_utils.py` - SRT parsing, composition, chunking, and reference-track alignment
6. `app/vision.py` - scene windows and FFmpeg frame extraction
7. `app/models.py` / `app/config.py` - persistent state and validated settings

## Critical Rules

- `JobManager` owns mutable job state. API handlers should delegate state changes to it.
- `OpenAICompatibleTranslator` owns model calls, prompts, response schemas, validation, and recovery.
- Subtitle `position` is the canonical zero-based identity across source lines, translations, findings, references, batches, and vision records.
- Each translated line must contain only its matching source line. Neighboring lines are context and must never be merged into it.
- Jobs are persisted after meaningful changes and unfinished jobs are restored as paused.
- The primary source SRT is canonical. Secondary subtitle tracks are supporting evidence only.
- Prompt templates use runtime language variables such as `{{source_language}}` and `{{target_language}}`; model-facing values include both readable names and codes.
- Reference, scene, adaptive-vision, and rolling-context prompt blocks are appended only when that feature and its evidence are active for the request.
- Translation and review jobs share `TranslationJob` but use different execution paths.
- Visual scene guides are created before translation and attached only to overlapping batches.
- Clean reruns may reuse scene guides only when the primary source SRT is identical; translated lines and adaptive decisions are never carried over.
- Adaptive visual clarification is bounded: the translator must supply a current translation, a concrete alternative, and a visually answerable question.
- Local video paths are external, read-only inputs and must never be deleted. Only videos marked `video_managed` belong to the app.
- Browser drag-and-drop cannot expose absolute paths. The Windows-native picker/drop endpoints return paths without transferring video bytes.
- The frontend has no framework. When settings or payloads change, update the backend models, form handling, HTML, and JavaScript together.

## Main Flows

### Translation

1. `POST /api/jobs` validates uploads and settings.
2. `JobManager.create_job()` parses the SRT, aligns optional references, persists the job, and starts an async task.
3. `_run_job()` optionally builds the initial structured context card.
4. If enabled, ordered video frames are analyzed into visual scene guides.
5. Lines are translated in batches through `translate_batch()`.
6. Validation may trigger a strict retry, recursive batch split, or isolated line repair.
7. Optional adaptive vision chooses between a provisional translation and its supplied alternative.
8. Translations, context, findings, progress, timing, and logs are persisted.
9. The completed SRT preserves original timing and adds the AI SubContext disclosure subtitle.

### Existing Translation Review

`POST /api/jobs/review` accepts source and translated SRT files. The app strips its own disclosure line, validates aligned lines without retranslating the file, and exposes findings in `/review/{job_id}`. Users can edit, resolve, remove, or retranslate individual lines.

### Context

- The initial `SessionContext` is built from the whole cleaned subtitle or a distributed sample.
- It carries premise, tone, scene state, style notes, characters, glossary, and ambiguities.
- Each batch stores input and output cards in `BatchContextSnapshot`.
- Main and batch cards can be edited or regenerated.
- Line retranslation uses the relevant batch card when available, then the current main card.
- Prompt Lab settings are copied into new jobs. Existing jobs keep their original settings unless runtime overrides are supplied on resume.

### Validation Recovery

Validation covers structural errors, empty/unchanged output, likely source-language leakage, target-language consistency, proper-name false positives, and subtitle boundary drift.

Inline subtitle styling is program-owned. Supported SRT tags are replaced with neutral immutable markers before model calls, restored afterward, and validated for balanced source-compatible formatting. Validation operates on visible text without markup. Sustained neighboring-cue shifts are detected from run-level alignment and retried in small anchored groups.

Recovery order:

1. Publish the initial batch result immediately so valid and failed lines are visible live.
2. Retry only failed positions once without context updates or adaptive visual doubts.
3. Retry at most four remaining strong failures individually.
4. Preserve unresolved findings for manual review.
5. Split batches only after timeouts, not semantic validation failures.

Model output must contain exactly the expected positions. Missing or duplicate positions become explicit blank/error lines and must never silently fall back to source text.

Common finding states are `suspect`, `error`, `auto_fixed`, and `manual_fixed`.

## File Map

### Backend

- `app/main.py` - pages, uploads, model probing, job controls, context/line APIs, frame serving, and SRT download
- `app/job_manager.py` - shared in-process job store and all workflow/state transitions
- `app/translator.py` - default prompts, JSON schemas, endpoint fallback, context generation, translation, validation, retries, and visual analysis
- `app/vision.py` - visual doubt validation, scene grouping, ordered frame sampling, JPEG cache
- `app/srt_utils.py` - canonical SRT positions/timing, output composition, disclosure handling, reference alignment
- `app/models.py` - `TranslationJob`, `SubtitleLine`, `SessionContext`, snapshots, findings, references, and visual records
- `app/config.py` - `TranslationSettings` defaults and limits
- `app/version.py` - canonical application version

### Frontend

- `app/static/index.html`, `app.js`, `app.css` - main translation console and shared styling
- `app/static/review.html`, `review.js` - line review, filters, bulk actions, retranslations, and batch cards
- `app/static/prompt_lab.html`, `prompt_lab.js` - editable prompt templates, insertable variables, token limit, and timeout

The console and review workspace poll job APIs every 2.5 seconds. There are no WebSockets.

## Important Data Models

- `TranslationJob` - complete persisted job state
- `SubtitleLine` - canonical position, text, and timing
- `SessionContext` - rolling movie/scene card
- `BatchContextSnapshot` - context before and after a batch
- `SubtitleValidationIssue` / `JobValidationStats` - findings and counters
- `ReferenceSubtitleTrack` - aligned supporting subtitle evidence
- `VisualSceneContext` / `VisualFrameRecord` - scene guides and visual evidence

When adding persisted fields, provide defaults so older `data/jobs.json` files continue to load.

## Persistence

Git-ignored runtime data:

- `data/jobs.json` - serialized jobs
- `data/videos/` - managed upload copies and hard-linked rerun videos; direct local videos stay at their original paths
- `data/vision_cache/` - extracted JPEG frames
- `ignored/` - local tests and scratch assets
- `venv-linux/`, `venv-win/` - launcher-managed environments

State writes use a temporary file and atomic replacement. Deleting a job removes only app-managed videos and frame caches, never an external source video.

## Runtime

Dependencies are in `requirements.txt`. The main stack is FastAPI, Uvicorn, HTTPX, Pydantic, `srt`, `fast-langdetect`, and vanilla JavaScript.

An OpenAI-compatible `/v1/models` and `/v1/chat/completions` endpoint is required. LM Studio is the main tested local runtime. FFmpeg is required for visual features.

Launch:

```bash
./start_linux.sh
start_windows.bat
```

Both launchers accept `--skip-git` and `--port=PORT`. The default port is `7861`; Windows selects the next free port when necessary.

Read `AGENTS.md` before diagnosing local connectivity or running local regression assets. This repo is often controlled from WSL while LM Studio and the browser-visible app run on Windows, so their `localhost` boundaries may differ.

## Verification

There is no committed automated test suite. Minimum static checks:

```bash
python -m py_compile app/config.py app/job_manager.py app/main.py app/models.py app/srt_utils.py app/translator.py app/vision.py
node --check app/static/app.js
node --check app/static/review.js
node --check app/static/prompt_lab.js
```

For behavioral changes, run a local translation or review job and inspect logs, position alignment, validation findings, context snapshots, and final SRT boundaries. Include visual evidence checks when changing vision.

## Release

Do not edit versions or `CHANGELOG.md` manually. Read `docs/BUMP_SCRIPT_INSTRUCTIONS.md` and use:

```bash
python3 scripts/bump_version_enhanced.py patch "<commit description>" "<multiline changelog description>"
```

`minor`, `major`, and explicit versions are also supported. The script updates `app/version.py`, `README.md`, and `CHANGELOG.md`, and commits by default.

## Change Guide

| Change | Start here |
|---|---|
| API route | `app/main.py`, then manager/models |
| Job lifecycle or persistence | `app/job_manager.py`, `app/models.py` |
| Prompts, schemas, validation, or retries | `app/translator.py` |
| Persisted setting | `app/config.py`, `app/main.py`, models, HTML, and JS |
| Context-card behavior | `app/translator.py`, `app/job_manager.py`, both context UIs |
| Reference subtitle alignment | `app/srt_utils.py`, `app/job_manager.py` |
| Vision behavior | `app/vision.py`, `app/translator.py`, `app/job_manager.py` |
| Main UI or visual evidence | `app/static/index.html`, `app.js`, `app.css` |
| Review workflow | `app/static/review.html`, `review.js`, line APIs |
| Prompt Lab | `app/static/prompt_lab.*`, translator runtime defaults |
| Exported SRT | `app/srt_utils.py`, refresh calls in `app/job_manager.py` |
| Launch or release | launch scripts or documented version-bump script |

## Documentation

- `README.md` - user-facing features and launch instructions
- `CHANGELOG.md` - release history
- `AGENTS.md` - local agent/runtime guidance; keep it out of user-facing docs
- `docs/BUMP_SCRIPT_INSTRUCTIONS.md` - release procedure
