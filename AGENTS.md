## Runtime Note

- This repo is often used from WSL while LM Studio and the subtitle app run on Windows.
- Do not assume WSL `127.0.0.1` can reach Windows `localhost`.
- If `http://127.0.0.1:1234` or the app port looks down from WSL, verify from Windows before concluding LM Studio or the app is stopped.
- When needed, use `powershell.exe` commands to check or call Windows-side `localhost` services.

## Internal Visual Test

- There is an internal visual regression test under `ignored/visual-test/`.
- Files:
  - `ignored/visual-test/test.mp4`
  - `ignored/visual-test/test.srt`
- Source: extracted from the Perpetual Grace job around `00:14:15` to `00:19:15`.
- Purpose: quick rerun for scene-context vision and subtitle-boundary validation work.
- The clip is git-ignored and intended only for local testing.
- If a future agent needs to rerun it against the Windows app, use `powershell.exe` and post both files to the local app instance already visible in the browser, usually `http://127.0.0.1:7861/api/jobs`, with `visual_scene_context=true`.
