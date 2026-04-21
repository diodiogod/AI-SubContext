# Changelog

All notable changes to AI SubContext are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-04-21

### Added

- Add multilingual subtitle references and stronger review tools
- You can now load supporting subtitle tracks in other languages to give the model extra aligned context
- Reference tracks are visible in jobs, logs, and the Review Workspace, including per-line confidence and matched reference lines
- Initial movie card generation now uses cleaned subtitle text with configurable whole-text or sampled strategies
- The console now shows an initial card size estimate so you can judge what your model is likely to handle
- Context card cleanup is stricter, reducing instruction-like garbage in premise and style notes

### Fixed

- The Review Workspace now supports a more complete fix loop with bulk review actions and better diagnostics
## [0.1.0] - 2026-04-20

### Added

- Standalone subtitle translation web app with drag-and-drop `.srt` upload
- Source and target language controls with OpenAI-compatible model and base URL settings
- Batch translation workflow with optional structured context card
- Pause, resume, stop, and live context editing for active translation jobs
- Job persistence to `data/jobs.json` so unfinished jobs can be restored after restart
- Local model history dropdown plus LM Studio model fetching
- Windows and Linux launchers with separate virtual environments

### Changed

- Use a focused, local-first UI instead of requiring Bazarr or Radarr

### Fixed

- Preserve running jobs across app restarts instead of losing them in memory
