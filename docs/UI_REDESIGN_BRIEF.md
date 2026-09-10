# AI SubContext interface redesign brief

Planning only. No application code changed. Based on the supplied console screenshot, PROJECT_INDEX.md, the three frontend HTML pages, shared CSS, and a focused look at console event handling. The subtitle workspace was inspected in code, not visually tested. Backend internals were intentionally outside this review.

## Objective

Make the existing feature-rich application feel like a coherent subtitle editing program. Preserve translation, review, context management, visual evidence, Prompt Lab, logs, and job controls. Reduce how much the user must read and navigate before doing useful work.

## Diagnosis

The screenshot shows several different activities stacked on one page: new-job setup, model connection, context configuration, a selected job, visual evidence, and saved jobs. The selected job appears below an entire setup form even when the user is already working. The layout gives configuration more prominence than the subtitles.

Repeated eyebrows, instructional headings, numbered steps, nested rounded panels, outlines, and explanatory text create visual noise. The large headline reads like a product landing page. The asymmetric source/model layout leaves a large empty area, while the actual controls remain small. Making everything smaller would worsen readability.

Logs have an obscure corner affordance. Model entry and model discovery occupy separate blocks. Review-existing-translation is presented as an optional file inside a translation form, although it is a distinct workflow. Job cards repeat progress, metrics, and evidence that belong in a selected-job workspace.

The strongest existing foundation is the subtitle review workspace: a table, filters, a selected-line editor, density and column controls, and keyboard navigation. Keep its interaction model.

## Proposed information architecture

Use one consistent application shell across the current pages. This does not require a frontend framework rewrite.

- Compact top bar: application name, current destination or job title, model connection status, and an explicit Logs button when a job is selected.
- Left sidebar, approximately 220 px: New job, Jobs, a short recent-job list with text status, then Prompt Lab and App Settings. Recent entries are navigation, not miniature dashboards.
- Main area: the current task, using the available width and height.
- Selected job: persistent title, language direction, current phase/progress, applicable Pause or Resume action, Export, and a More menu. Below this, job tabs: Subtitles, Context, Visual Evidence, Settings.
- Logs: a resizable bottom drawer scoped clearly to the selected job, with an Expand action. Preserve existing log tabs, detail, and reading position. Closing it returns screen space to the task.

Global navigation changes destinations. Job tabs change the view of the same job. Filters narrow the content within a view. Give these three types of control distinct visual treatment.

Returning users land on Jobs or restore their last selected job. First-time users see a small empty state with New translation and Review existing translation. Never automatically begin a run.

## New-job view

Use a dedicated view with two explicit modes: Translate and Review existing. Avoid a mandatory multistep wizard. Use two setup tabs, with errors also indicated on the tab that contains them.

**Basics:** source SRT, optional title, source and target languages, language guidance with its existing history control, model selector, optional video, and reference tracks. Review mode additionally requires the translated SRT and changes the primary action to Start review. Preserve existing review settings behavior; do not imply that importing a translation retranslates the entire file.

**Context & advanced:** rolling context, prepare scene guides, and visual clarification as three independently understandable options. Keep scene guides and clarification independent: either, both, or neither can be enabled. Reveal sampling settings only for enabled features. Group batching, temperature, initial-card strategy, and input budget beneath Advanced.

Keep a compact summary and Start translation/Start review footer visible. The summary should expose selected context modes even while Basics is open. Display a clear missing-video explanation when a visual feature needs one. Show actual prerequisite errors, not speculative capability claims.

Use a modest upload area that becomes a compact file row once selected. For video, preserve local path, native picker/drop, upload fallback, clearing, and rerun scene-guide reuse. Place upload fallback in a secondary menu with a short explanation that it stores a copy. Do not turn selecting a local video into an upload.

Show the chosen model and an Edit connection link. Move base URL, masked API key with reveal, model discovery, and Test connection into App Settings. Allow manual model IDs and arbitrary OpenAI-compatible endpoints; avoid LM Studio-only language. Reuse current persistence first. Named provider profiles are optional later work, not required for the redesign.

Connection errors should read, for example, “Cannot reach the model server” with Retry and Details. Preserve the full technical error in Details/logs. A disconnected server should not prevent opening saved subtitles or editing existing results.

## Selected-job views

### Subtitles

Make this the default job tab. Retain the source/translation table and selected-line inspector. Use a compact toolbar for search, status filters with counts, previous/next finding, and bulk rewrite. Keep column visibility, row density, and jump-to-line accessible in secondary controls.

The table receives most of the width; the line editor occupies approximately 340–420 px on a wide screen. Keep source text, translation, finding reason, supporting reference, and applicable context reachable from the selection. Preserve edit, resolve/remove finding, line retranslation, and existing bulk behavior. Do not reimplement these semantics as part of a visual refresh.

Use short phase text during work: Preparing context, Analyzing scenes, Translating, Paused, Completed. Show only information backed by existing state. Keep “completed processing” distinct from “no unresolved findings.” Counts should link to the corresponding subtitle filter. Never show an invented ETA.

### Context

Present the rolling movie/episode sheet as a readable document with sections for premise, tone/style, current scene, characters, glossary, and ambiguities. Characters and glossary should use compact editable rows rather than decorative profile cards. Character portraits are not a requirement.

Provide an explicit scope selector: Current context or Batch history. A batch selection exposes its input/output snapshots with the batch or line range clearly labeled. Preserve editing and regeneration of main and batch cards. Explain which scope an edit affects; do not suggest a current-card edit retroactively changes completed translations.

Keep unsaved edits safe during polling, tab switches, and drawer interactions. Surface draft/saved state and preserve existing draft protection.

### Visual Evidence

Give frames enough space to be useful. Use a timestamped scene list or thumbnail grid and a larger selected scene/frame viewer with its scene guide. Distinguish prepared scene guides from translation-doubt evidence, and preserve questions, alternatives, decisions, and related subtitle/batch information where available.

Replace the permanently tiny filmstrip on the main page with this focused evidence browser. Keep quick evidence access from a selected subtitle. Do not imply that the app already has a synchronized video player or timeline editor; those are separate possible projects.

### Job Settings

Display the settings actually saved with this job. Clearly distinguish them from defaults for future jobs and from overrides the backend allows on resume. Preserve existing pause/resume, rerun, reuse, export, and deletion capabilities in appropriate controls. Place uncommon or destructive actions in More, retaining existing confirmations and safeguards.

## Jobs and Prompt Lab

Jobs should be a searchable compact table: title/file, language direction, status, progress, unresolved findings, and row actions. Retain existing filters and cleanup actions. Open the job by selecting its title. Show detailed evidence and context inside the job instead of expanding every row into another dashboard. Use truncation with full-name access for long filenames.

Prompt Lab remains a first-class global destination. Use a template list beside one large editor, preserving all six existing templates, variable insertion, save/reset, timeout, and token controls. Move long call-flow explanations into Help. Keep visible the existing rule that saved defaults apply to new jobs; existing jobs retain their saved settings. Preserve unsaved edits when changing templates or navigating away.

## Visual direction

Aim for a restrained desktop editor with clear typography and useful density.

- Neutral charcoal canvas, slightly lighter work surfaces, and a single muted teal accent for selection and primary actions. Use solid fills, subtle separators, and little or no shadow.
- Remove the hero headline, background grid/glows, decorative gradients, hover lifts, repeated step numbers, and nested card borders.
- Use Segoe UI or a comparable readable system sans. Use monospace for timestamps, model IDs, and logs. Target 14 px body text, 12–13 px secondary text, and 18–22 px page titles; do not shrink text to fit the old layout.
- Use a consistent 4/8 px spacing system, approximately 32–36 px controls, and 4–6 px corner radii. Prefer aligned fields and separators to a box around every group.
- One primary action per task area. Use labeled buttons for important actions and simple consistent icons for secondary tools.
- Status must have text or an icon in addition to color. Preserve visible keyboard focus, accessible tab behavior, and readable contrast.
- At narrower widths, collapse the sidebar and move the line inspector into an accessible drawer. Keep table scrolling contained. Target desktop layouts at 1440×900 and 1280×800 first.

## Mockup generator prompt

Create high-fidelity desktop UI mockups for AI SubContext, a context-aware subtitle translation and review application. It connects to local or remote OpenAI-compatible models, maintains an editable rolling context sheet with characters and glossary, optionally analyzes video stills, and supports detailed subtitle review and logs.

Design a restrained professional editing application at 1440×900. Use neutral charcoal surfaces, a muted teal accent, readable 14 px system typography, subtle separators, compact controls, and small corner radii. Use the full viewport. Avoid landing-page headlines, gradients, glass effects, oversized cards, decorative dashboards, and tiny text.

Show four separate screens with the same shell:

1. New translation: sidebar with New job, Jobs, recent jobs, Prompt Lab, App Settings; Basics and Context & advanced setup tabs; compact source/video/reference inputs; language direction and model selection; visible start footer. Show the three context options in a separate companion state if needed.
2. Active job, Subtitles tab: job title and phase/progress, Pause, Export, Logs; tabs Subtitles / Context / Visual Evidence / Settings; source and translated subtitle table with findings filters; selected-line editor on the right; bottom log drawer open at a usable height.
3. Same job, Context tab: readable premise and current scene, compact character and glossary rows, explicit Current context / Batch history scope, edit and regenerate actions.
4. Same job, Visual Evidence tab: timestamped scenes, legible frame thumbnails, larger selected evidence and its guide, related subtitle range. No invented video timeline.

Use realistic illustrative English-to-Brazilian-Portuguese dialogue and a plausible episode title. Label example counts as mock data in the deliverable notes. Keep job identity consistent across screens. Show selected states and useful content, not just empty containers. Treat Logs and Prompt Lab as important visible tools. Maintain all functionality described in the accompanying brief.

## Implementation handoff

1. Approve the workspace and setup mockups before coding the redesign. Resolve density and navigation here rather than through a complete implementation.
2. Build shared visual tokens and shell in the existing vanilla frontend. Preserve routes and API contracts; keep review deep links working. Avoid adding a framework, backend features, or new persistence concepts solely for layout.
3. Separate setup from saved-job navigation and relocate connection controls. Audit existing field IDs, event bindings, form serialization, and local-storage behavior before moving DOM elements; existing scripts may assume all controls share a page.
4. Integrate the existing subtitle editor into the job navigation, then relocate context/evidence and expose logs consistently. Preserve selection, filters, scroll position, and drafts across polling and navigation. Do not duplicate polling loops or rerender an active editor destructively.
5. Restyle Prompt Lab and verify feature parity. Inventory existing visible and menu actions before replacement, including rerun/reuse and log subviews.

Acceptance: a returning user can open a saved job immediately; setup no longer sits above active work; common setup is understandable without opening advanced controls; logs take one action to open from a job; subtitles and context retain edits while status updates; connection defaults and saved-job settings cannot be confused; every existing feature remains reachable. Check translation and review modes, running/paused/completed/error jobs, context on/off, both independent vision modes, local/upload video, references, main/batch edits, reruns, logs, export, and existing keyboard controls. Use static JavaScript checks plus targeted browser verification; use an actual model run only where behavior changes warrant it.

Existing unrelated changes were observed in app/translator.py and tests/test_subtitle_integrity.py. Leave them untouched during this UI work. This brief adds no version bump or release change.
