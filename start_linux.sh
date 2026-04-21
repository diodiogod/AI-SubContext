#!/bin/bash

set -e

LOGFILE="ai_subcontext_setup.log"
SKIP_GIT=0
PORT="7861"

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-git) SKIP_GIT=1 ;;
        --port=*) PORT="${1#--port=}" ;;
    esac
    shift
done

echo "Logging to $LOGFILE"

if [ -d .git ] && [ $SKIP_GIT -eq 0 ]; then
    echo "Pulling latest changes..."
    if ! git pull >> "$LOGFILE" 2>&1; then
        echo "WARNING: git pull failed, continuing with current version"
    fi
fi

if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 not found"
    exit 1
fi

if [ ! -f requirements.txt ]; then
    echo "ERROR: requirements.txt not found"
    exit 1
fi

VENV_PATH="venv-linux"
VENV_EXISTS=0
if [ -f "$VENV_PATH/bin/activate" ]; then
    VENV_EXISTS=1
else
    echo "Creating virtual environment..."
    python3 -m venv "$VENV_PATH" >> "$LOGFILE" 2>&1
fi

source "$VENV_PATH/bin/activate"

REQ_FINGERPRINT_FILE="$VENV_PATH/.requirements.sha256"
CURRENT_REQUIREMENTS_HASH="$(python - <<'PY'
import hashlib
from pathlib import Path
print(hashlib.sha256(Path("requirements.txt").read_bytes()).hexdigest())
PY
)"
INSTALLED_REQUIREMENTS_HASH=""
if [ -f "$REQ_FINGERPRINT_FILE" ]; then
    INSTALLED_REQUIREMENTS_HASH="$(cat "$REQ_FINGERPRINT_FILE")"
fi

if [ $VENV_EXISTS -eq 0 ] || [ "$CURRENT_REQUIREMENTS_HASH" != "$INSTALLED_REQUIREMENTS_HASH" ]; then
    echo "Installing dependencies..."
    python -m pip install --upgrade pip >> "$LOGFILE" 2>&1
    python -m pip install --upgrade -r requirements.txt >> "$LOGFILE" 2>&1
    printf '%s\n' "$CURRENT_REQUIREMENTS_HASH" > "$REQ_FINGERPRINT_FILE"
else
    echo "Requirements unchanged, skipping installation"
fi

echo "Starting AI SubContext on http://127.0.0.1:$PORT"
export SUBTITLE_STUDIO_PORT="$PORT"
python -m app.main
