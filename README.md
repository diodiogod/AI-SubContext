# AI SubContext

This tool uses a large language model to translate subtitle files with context awareness, preserving meaning, terminology, and character consistency across an entire script instead of treating each line in isolation. It lets you load an `.srt`, choose source and target languages, connect to a local or remote model endpoint, and monitor a live context layer that tracks scene information, glossary terms, unresolved ambiguities, and recurring character details as translation progresses in batches. The goal is to give you more control over subtitle quality, especially in dialogue-heavy content where tone, reference, and continuity matter.

Current version: v0.2.2

Current features:
- drop or pick an `.srt` file
- drop or pick a translated `.srt` for validation review against the source file
- choose source / target language
- choose model and OpenAI-compatible base URL
- translate in batches
- optional structured context card that rolls between batches
- pause, resume, stop, and edit the live context card through a structured editor
- generate or refine the main context card with another model call
- save per-batch context snapshots and generate/edit batch cards for review or retranslation
- post-batch validation with suspicious / fixed / error counters
- automatic retry, stricter retry, autosplit, and isolated line retry for weak models
- verbose runtime log with validation and retry events
- review existing translated subtitles without retranslating the full file
- line review tools:
  - mark resolved
  - save manual edits
  - remove subtitle text
  - retranslate a line with optional extra instruction
- dedicated review workspace at `/review/{job_id}` with table-style subtitle review
- download translated `.srt`

Default local URL:
- `http://127.0.0.1:7861`

## Launch

Windows:

```bat
start_windows.bat
```

Linux:

```bash
./start_linux.sh
```

## Notes

- This MVP expects an OpenAI-compatible endpoint such as LM Studio, OpenRouter, or another local server.
- Settings are entered in the UI and stored in browser local storage for convenience.
- Jobs are persisted to `data/jobs.json`. If you close the app, unfinished jobs are restored as paused and can be resumed.
- Validation review jobs can compare a source subtitle with an already translated subtitle and flag likely untranslated or suspicious lines.
- The workspace and review tools are built around `.srt` only for now.
- Windows and WSL use separate virtual environments: `venv-win` and `venv-linux`.
