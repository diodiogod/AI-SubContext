## Runtime Note

- This repo is often used from WSL while LM Studio and the subtitle app run on Windows.
- Do not assume WSL `127.0.0.1` can reach Windows `localhost`.
- If `http://127.0.0.1:1234` or the app port looks down from WSL, verify from Windows before concluding LM Studio or the app is stopped.
- When needed, use `powershell.exe` commands to check or call Windows-side `localhost` services.
