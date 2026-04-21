# Changelog

All notable changes to AI SubContext are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.2] - 2026-04-21

### Added

- Review Workspace now shows live translation status and percentage while a job is still running
- Automatic subtitle repair is less aggressive and leaves borderline suspect lines for manual review instead of over-retrying them
- Exported translated subtitles now include a branded final disclosure line
- Reviewing one of the app's own exported subtitles ignores that disclosure footer automatically
- The final disclosure subtitle now stays on screen for only two seconds

### Changed

- Improve review workflow and subtitle export disclosure
## [0.2.1] - 2026-04-21

### Added

- Translation context updates now visually highlight only the fields that changed
- Previous context snapshots stay collapsed by default and remain open while you inspect them
- The verbose log no longer snaps you away while reading older entries
- Failed jobs now show clearer invalid-JSON model errors instead of raw parser exceptions

### Changed

- Improve live context feedback and failure diagnostics

### Fixed

- Job error text can be copied without accidentally opening the review workspace
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
