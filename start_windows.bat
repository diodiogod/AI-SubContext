@echo off
setlocal enabledelayedexpansion

set LOGFILE=ai_subcontext_setup.log
set SKIP_GIT=0
set PORT=7861
set PORT_SEARCH_LIMIT=20

for %%A in (%*) do (
    if /I "%%~A"=="--skip-git" set SKIP_GIT=1
    set ARG=%%~A
    if /I "!ARG:~0,7!"=="--port=" set PORT=!ARG:~7!
)

echo Logging to %LOGFILE%

if exist .git (
    if !SKIP_GIT! EQU 0 (
        echo Pulling latest changes...
        git pull >> "%LOGFILE%" 2>&1
        if errorlevel 1 (
            echo WARNING: git pull failed, continuing with current version
        )
    )
)

where python >nul 2>nul
if errorlevel 1 (
    echo ERROR: Python not found
    pause
    exit /b 1
)

if not exist requirements.txt (
    echo ERROR: requirements.txt not found
    pause
    exit /b 1
)

set VENV_PATH=venv-win
set VENV_EXISTS=0
if exist %VENV_PATH%\Scripts\activate.bat (
    set VENV_EXISTS=1
) else (
    echo Creating virtual environment...
    python -m venv %VENV_PATH% >> "%LOGFILE%" 2>&1
)

call %VENV_PATH%\Scripts\activate.bat

set REQ_FINGERPRINT_FILE=%VENV_PATH%\.requirements.sha256
set CURRENT_REQUIREMENTS_HASH=
set INSTALLED_REQUIREMENTS_HASH=

for /f "usebackq delims=" %%H in (`python -c "import hashlib, pathlib; print(hashlib.sha256(pathlib.Path('requirements.txt').read_bytes()).hexdigest())"`) do (
    if not defined CURRENT_REQUIREMENTS_HASH set "CURRENT_REQUIREMENTS_HASH=%%H"
)

if exist "%REQ_FINGERPRINT_FILE%" (
    set /p INSTALLED_REQUIREMENTS_HASH=<"%REQ_FINGERPRINT_FILE%"
)

if %VENV_EXISTS% EQU 0 (
    set SHOULD_INSTALL=1
) else (
    set SHOULD_INSTALL=0
)

if /I not "%CURRENT_REQUIREMENTS_HASH%"=="%INSTALLED_REQUIREMENTS_HASH%" (
    set SHOULD_INSTALL=1
)

if %SHOULD_INSTALL% EQU 1 (
    echo Installing dependencies...
    python -m pip install --upgrade pip >> "%LOGFILE%" 2>&1
    python -m pip install --upgrade -r requirements.txt >> "%LOGFILE%" 2>&1
    >"%REQ_FINGERPRINT_FILE%" echo %CURRENT_REQUIREMENTS_HASH%
) else (
    echo Requirements unchanged, skipping installation
)

set START_PORT=%PORT%
set /a END_PORT=START_PORT+PORT_SEARCH_LIMIT
set SELECTED_PORT=
for /l %%P in (%START_PORT%,1,%END_PORT%) do (
    set "CANDIDATE_PORT=%%P"
    python -c "import socket, sys; s=socket.socket(); s.bind(('127.0.0.1', int(sys.argv[1]))); s.close()" !CANDIDATE_PORT! >nul 2>nul
    if not errorlevel 1 (
        set "SELECTED_PORT=!CANDIDATE_PORT!"
        goto :port_found
    )
)

echo ERROR: Could not find a free port from %START_PORT% to %END_PORT%
echo Close the app already using the port or start with --port=PORT.
pause
exit /b 1

:port_found
if not "%SELECTED_PORT%"=="%START_PORT%" (
    echo Port %START_PORT% is busy, switching to %SELECTED_PORT%
) else (
    echo Port %SELECTED_PORT% is available
)
echo Starting AI SubContext on http://127.0.0.1:%SELECTED_PORT%
set SUBTITLE_STUDIO_PORT=%SELECTED_PORT%
python -m app.main
set APP_EXIT_CODE=%ERRORLEVEL%
if not "%APP_EXIT_CODE%"=="0" (
    echo ERROR: Application exited with code %APP_EXIT_CODE%
    echo Check %LOGFILE% for install or startup errors.
)
pause
exit /b %APP_EXIT_CODE%
