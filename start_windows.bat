@echo off
setlocal enabledelayedexpansion

set LOGFILE=ai_subcontext_setup.log
set SKIP_GIT=0
set PORT=7861

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

echo Starting AI SubContext on http://127.0.0.1:%PORT%
set SUBTITLE_STUDIO_PORT=%PORT%
python -m app.main
