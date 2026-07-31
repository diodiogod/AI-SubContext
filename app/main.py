from __future__ import annotations

import asyncio
import os
import subprocess
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from app.config import TranslationSettings
from app.job_manager import DuplicateActiveJobError, VisualContextReuseError, job_manager
from app.models import (
    CreateJobResponse,
    GenerateContextResponse,
    JobStatus,
    ModelListResponse,
    ModelTestResponse,
    ReloadJobResponse,
    ResumeJobRequest,
    RetranslateLineRequest,
    RuntimeDefaultsResponse,
    SessionContext,
    TranslationJob,
    UpdateBatchContextSnapshotRequest,
    UpdateTranslatedLineRequest,
    UpdateContextRequest,
)
from app.version import __version__


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
VIDEO_EXTENSIONS = {".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v", ".ts"}

_WINDOWS_VIDEO_DROP_SCRIPT = r'''
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$allowed = @('.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.ts')
$selected = ''
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Drop Video Without Copying'
$form.ClientSize = New-Object System.Drawing.Size(560, 250)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.AllowDrop = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(8, 20, 27)
$form.ForeColor = [System.Drawing.Color]::FromArgb(229, 244, 242)
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.KeyPreview = $true

$title = New-Object System.Windows.Forms.Label
$title.Text = 'Drop a video from Explorer'
$title.Font = New-Object System.Drawing.Font('Segoe UI', 18, [System.Drawing.FontStyle]::Bold)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(34, 34)
$form.Controls.Add($title)

$message = New-Object System.Windows.Forms.Label
$message.Text = "The original file stays where it is.`r`nNothing will be uploaded, copied, moved, or deleted."
$message.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$message.AutoSize = $true
$message.Location = New-Object System.Drawing.Point(37, 87)
$message.ForeColor = [System.Drawing.Color]::FromArgb(155, 190, 186)
$form.Controls.Add($message)

$status = New-Object System.Windows.Forms.Label
$status.Text = 'Waiting for MP4, MKV, WebM, MOV, AVI, M4V, or TS...'
$status.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$status.AutoSize = $true
$status.Location = New-Object System.Drawing.Point(37, 158)
$status.ForeColor = [System.Drawing.Color]::FromArgb(120, 230, 222)
$form.Controls.Add($status)

$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.Size = New-Object System.Drawing.Size(82, 32)
$cancel.Location = New-Object System.Drawing.Point(438, 188)
$cancel.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$cancel.Add_Click({ $form.Close() })
$form.Controls.Add($cancel)

$form.Add_DragEnter({
    if ($_.Data.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) {
        $files = [string[]]$_.Data.GetData([System.Windows.Forms.DataFormats]::FileDrop)
        $extension = [System.IO.Path]::GetExtension($files[0]).ToLowerInvariant()
        if ($allowed -contains $extension) {
            $_.Effect = [System.Windows.Forms.DragDropEffects]::Link
            $status.Text = 'Release to use this original file without copying.'
            return
        }
    }
    $_.Effect = [System.Windows.Forms.DragDropEffects]::None
    $status.Text = 'That is not a supported video file.'
})
$form.Add_DragLeave({
    $status.Text = 'Waiting for MP4, MKV, WebM, MOV, AVI, M4V, or TS...'
})
$form.Add_DragDrop({
    $files = [string[]]$_.Data.GetData([System.Windows.Forms.DataFormats]::FileDrop)
    if ($files.Count -gt 0) {
        $extension = [System.IO.Path]::GetExtension($files[0]).ToLowerInvariant()
        if ($allowed -contains $extension) {
            $script:selected = $files[0]
            $form.Close()
        }
    }
})
$form.Add_KeyDown({
    if ($_.KeyCode -eq [System.Windows.Forms.Keys]::Escape) { $form.Close() }
})
$form.Add_Shown({ $form.Activate() })
[void]$form.ShowDialog()

if ($selected) {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Write-Output $selected
}
'''

app = FastAPI(title="AI SubContext", version=__version__)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$",
    allow_methods=["*"],
    allow_headers=["*"],
)


def _is_loopback_browser_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
    except ValueError:
        return False
    return parsed.scheme in {"http", "https"} and parsed.hostname in {"localhost", "127.0.0.1", "::1"}


@app.middleware("http")
async def reject_foreign_browser_api_requests(request: Request, call_next):
    """Keep browser pages outside loopback from reading or mutating the local app."""
    if request.url.path.startswith("/api/"):
        browser_source = request.headers.get("origin") or request.headers.get("referer")
        if browser_source and not _is_loopback_browser_url(browser_source):
            return JSONResponse(status_code=403, content={"detail": "Browser origin is not allowed"})
    return await call_next(request)


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def _job_payload(job) -> dict:
    return job.model_dump(mode="json", exclude={"video_path"})


_SUMMARY_SETTING_FIELDS = {
    "model",
    "source_language",
    "target_language",
    "batch_size",
    "structured_context",
    "visual_scene_context",
    "adaptive_vision",
    "request_timeout_seconds",
}
_REVIEW_SETTING_FIELDS = {
    "model",
    "source_language",
    "target_language",
    "batch_size",
}
_SUMMARY_JOB_FIELDS = {
    "id",
    "filename",
    "source_filename",
    "title",
    "job_kind",
    "video_filename",
    "video_managed",
    "validation_stats",
    "vision_stats",
    "status",
    "progress",
    "eta_seconds",
    "estimated_completion_at",
    "message",
    "created_at",
    "started_at",
    "completed_at",
    "error",
    "current_batch",
    "total_batches",
    "active_batch_index",
    "active_batch_positions",
    "active_recovery_positions",
    "pause_requested",
    "stop_requested",
}
_REVIEW_JOB_FIELDS = {
    "id",
    "filename",
    "source_filename",
    "title",
    "job_kind",
    "original_lines",
    "translated_lines",
    "reference_tracks",
    "session_context",
    "validation_stats",
    "pending_retranslations",
    "status",
    "progress",
    "current_batch",
    "total_batches",
    "active_batch_index",
    "active_batch_positions",
    "active_recovery_positions",
    "message",
}


def _job_summary_payload(job: TranslationJob) -> dict:
    """Return only the live console card and visual-timeline data for a job."""
    payload = job.model_dump(mode="json", include=_SUMMARY_JOB_FIELDS)
    payload["settings"] = job.settings.model_dump(
        mode="json",
        include=_SUMMARY_SETTING_FIELDS,
    )
    status_value = job.status.value
    if status_value in {"queued", "processing", "paused"}:
        payload["session_context"] = (
            job.session_context.model_dump(mode="json") if job.session_context else None
        )
        payload["session_context_history"] = [
            item.model_dump(mode="json") if hasattr(item, "model_dump") else item
            for item in job.session_context_history[:2]
        ]
    payload["reference_tracks"] = [
        track.model_dump(
            mode="json",
            include={
                "filename",
                "language",
                "total_lines",
                "matched_lines",
                "average_confidence",
                "alignment_mode",
            },
        )
        for track in job.reference_tracks
    ]
    payload["visual_frames"] = [
        frame.model_dump(
            mode="json",
            include={
                "id",
                "batch_index",
                "timestamp_ms",
                "related_positions",
                "categories",
                "revised_positions",
                "status",
            },
        )
        for frame in job.visual_frames[-80:]
    ]
    activity_needles = (
        "Starting batch ",
        "Submitting batch to model",
        "Retrying batch with stricter translation instruction",
        "Validation after attempt",
        "Model request timed out after",
    )
    model_activity_logs = []
    if status_value in {"processing", "paused", "failed"}:
        for entry in reversed(job.logs):
            if not any(needle in entry.message for needle in activity_needles):
                continue
            model_activity_logs.append(entry.model_dump(mode="json"))
            if len(model_activity_logs) == 12:
                break
        model_activity_logs.reverse()
    review_counts = {
        "suspect": 0,
        "error": 0,
        "auto_fixed": 0,
        "manual_fixed": 0,
    }
    for issue in job.validation_issues:
        if issue.status in review_counts:
            review_counts[issue.status] += 1
    review_counts["fixed"] = review_counts["auto_fixed"] + review_counts["manual_fixed"]
    payload.update(
        source_count=len(job.original_lines),
        translated_count=len(job.translated_lines),
        log_count=len(job.logs),
        issue_count=len(job.validation_issues),
        pending_retranslation_count=len(job.pending_retranslations),
        reference_track_count=len(job.reference_tracks),
        visual_frame_count=len(job.visual_frames),
        visual_observation_count=len(job.visual_observations),
        visual_scene_count=len(job.visual_scene_contexts),
        batch_context_snapshot_count=len(job.batch_context_snapshots),
        latest_log=job.logs[-1].model_dump(mode="json") if job.logs else None,
        model_activity_logs=model_activity_logs,
        review_counts=review_counts,
    )
    return payload


def _job_review_payload(job: TranslationJob) -> dict:
    """Return the subtitle and context data used by the Review Workspace."""
    payload = job.model_dump(mode="json", include=_REVIEW_JOB_FIELDS)
    payload["settings"] = job.settings.model_dump(
        mode="json",
        include=_REVIEW_SETTING_FIELDS,
    )
    # Historical cards can outweigh the subtitle text several times over. The
    # workspace only displays one card at a time, so poll with metadata and load
    # the selected card from the dedicated endpoint below.
    payload["batch_context_snapshots"] = [
        snapshot.model_dump(
            mode="json",
            include={"batch_index", "start_position", "end_position", "created_at"},
        )
        | {"has_snapshot": True}
        for snapshot in job.batch_context_snapshots
    ]
    payload["validation_issues"] = [
        issue.model_dump(
            mode="json",
            include={"position", "status", "reason_codes", "notes", "batch_index"},
        )
        for issue in job.validation_issues
    ]
    return payload


def _batch_context_payload(job: TranslationJob, batch_index: int) -> dict | None:
    session_context = job.session_context.model_dump(mode="json") if job.session_context else None
    snapshot = next(
        (item for item in job.batch_context_snapshots if item.batch_index == batch_index),
        None,
    )
    if snapshot is not None:
        return snapshot.model_dump(mode="json") | {
            "has_snapshot": True,
            "session_context": session_context,
        }

    batch_size = max(1, int(job.settings.batch_size or 1))
    start = (batch_index - 1) * batch_size
    batch_lines = job.original_lines[start:start + batch_size]
    if batch_index < 1 or not batch_lines:
        return None
    return {
        "batch_index": batch_index,
        "start_position": batch_lines[0].position,
        "end_position": batch_lines[-1].position,
        "input_context": None,
        "output_context": None,
        "has_snapshot": False,
        "session_context": session_context,
    }


@app.get("/")
async def root() -> FileResponse:
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/review/{job_id}")
async def review_workspace(job_id: str) -> FileResponse:
    return FileResponse(os.path.join(STATIC_DIR, "review.html"))


@app.get("/prompt-lab")
async def prompt_lab() -> FileResponse:
    return FileResponse(os.path.join(STATIC_DIR, "prompt_lab.html"))


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/runtime/defaults", response_model=RuntimeDefaultsResponse)
async def runtime_defaults() -> RuntimeDefaultsResponse:
    return RuntimeDefaultsResponse(**job_manager.translator.runtime_defaults())


@app.get("/api/jobs")
async def list_jobs(view: Literal["full", "summary"] = "full") -> list[dict]:
    payload_builder = _job_summary_payload if view == "summary" else _job_payload
    return [payload_builder(job) for job in job_manager.list_jobs()]


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str, view: Literal["full", "review"] = "full") -> dict:
    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return _job_review_payload(job) if view == "review" else _job_payload(job)


@app.get("/api/jobs/{job_id}/reload", response_model=ReloadJobResponse)
async def get_job_reload(job_id: str) -> ReloadJobResponse:
    payload = job_manager.build_reload_payload(job_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return payload


@app.get("/api/jobs/{job_id}/vision/frames/{frame_id}")
async def get_vision_frame(job_id: str, frame_id: str) -> FileResponse:
    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    frame = next((item for item in job.visual_frames if item.id == frame_id), None)
    if frame is None:
        raise HTTPException(status_code=404, detail="Vision frame not found")
    is_scene_frame = "scene_context" in frame.categories or frame.id.startswith("b-")
    cache_batch_index = -frame.batch_index if is_scene_frame else frame.batch_index
    frame_path = job_manager.vision.frame_path(job.id, cache_batch_index, frame.timestamp_ms)
    if not frame_path.is_file():
        raise HTTPException(status_code=404, detail="Vision frame file not found")
    return FileResponse(
        frame_path,
        media_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=3600"},
    )


async def _read_reference_sources(
    reference_files: list[UploadFile] | None,
    reference_languages: list[str] | None,
) -> list[dict[str, str]]:
    files = [item for item in (reference_files or []) if item and item.filename]
    languages = [str(item or "").strip() for item in (reference_languages or [])]
    if not files:
        return []
    if len(files) != len(languages):
        raise HTTPException(status_code=400, detail="Reference subtitle files and languages must match")

    references: list[dict[str, str]] = []
    for upload, language in zip(files, languages, strict=False):
        if not upload.filename.lower().endswith(".srt"):
            raise HTTPException(status_code=400, detail="Reference subtitles must be .srt files")
        if not language:
            raise HTTPException(status_code=400, detail="Each reference subtitle needs a language code")
        references.append(
            {
                "filename": upload.filename,
                "language": language,
                "content": (await upload.read()).decode("utf-8-sig", errors="replace"),
            }
        )
    return references


async def _save_video_upload(upload: UploadFile) -> str:
    filename = str(upload.filename or "").strip()
    suffix = Path(filename).suffix.lower()
    if suffix not in VIDEO_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="Unsupported video format. Use MP4, MKV, WebM, MOV, AVI, M4V, or TS.",
        )
    job_manager.video_dir.mkdir(parents=True, exist_ok=True)
    destination = job_manager.video_dir / f"{uuid4().hex}{suffix}"
    try:
        with destination.open("wb") as output:
            while chunk := await upload.read(1024 * 1024):
                output.write(chunk)
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    if not destination.is_file() or destination.stat().st_size == 0:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="The uploaded video is empty")
    return str(destination)


def _resolve_local_video_path(raw_path: str) -> Path:
    cleaned = str(raw_path or "").strip().strip('"')
    if not cleaned:
        raise HTTPException(status_code=400, detail="Choose a local video or upload a copy")
    candidate = Path(os.path.expandvars(cleaned)).expanduser()
    if not candidate.is_absolute():
        raise HTTPException(status_code=400, detail="The local video path must be absolute")
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as exc:
        raise HTTPException(status_code=400, detail="The selected local video is no longer available") from exc
    if not resolved.is_file() or resolved.stat().st_size <= 0:
        raise HTTPException(status_code=400, detail="The selected local video is empty or unavailable")
    if resolved.suffix.lower() not in VIDEO_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="Unsupported video format. Use MP4, MKV, WebM, MOV, AVI, M4V, or TS.",
        )
    return resolved


def _open_local_video_picker() -> str:
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    try:
        root.attributes("-topmost", True)
        return str(
            filedialog.askopenfilename(
                parent=root,
                title="Choose source video for vision",
                filetypes=[
                    ("Video files", "*.mp4 *.mkv *.webm *.mov *.avi *.m4v *.ts"),
                    ("All files", "*.*"),
                ],
            )
            or ""
        )
    finally:
        root.destroy()


def _open_local_video_drop_target() -> str:
    if os.name != "nt":
        raise RuntimeError("Native video drop is available only when the app runs on Windows")
    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    result = subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-STA",
            "-Command",
            _WINDOWS_VIDEO_DROP_SCRIPT,
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
        creationflags=creation_flags,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "Native video drop window failed")
    return result.stdout.strip().lstrip("\ufeff")


def _require_local_app_origin(request: Request) -> None:
    origin = request.headers.get("origin", "").strip()
    if origin and urlparse(origin).netloc != request.headers.get("host", ""):
        raise HTTPException(status_code=403, detail="Local video selection requires the app page")


@app.post("/api/local-video/pick")
async def pick_local_video(request: Request) -> dict[str, str | bool]:
    _require_local_app_origin(request)
    try:
        selected = await asyncio.to_thread(_open_local_video_picker)
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail="The native video picker is unavailable. Paste the full local path instead.",
        ) from exc
    if not selected:
        return {"cancelled": True, "path": "", "filename": ""}
    video_path = _resolve_local_video_path(selected)
    return {
        "cancelled": False,
        "path": str(video_path),
        "filename": video_path.name,
    }


@app.post("/api/local-video/drop")
async def drop_local_video(request: Request) -> dict[str, str | bool]:
    _require_local_app_origin(request)
    try:
        selected = await asyncio.to_thread(_open_local_video_drop_target)
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail="The native drop window is unavailable. Use Choose Video or paste the full local path instead.",
        ) from exc
    if not selected:
        return {"cancelled": True, "path": "", "filename": ""}
    video_path = _resolve_local_video_path(selected)
    return {
        "cancelled": False,
        "path": str(video_path),
        "filename": video_path.name,
    }


def _reuse_job_video(job_id: str) -> tuple[str, str, bool]:
    source_job = job_manager.get_job(job_id)
    if not source_job or not source_job.video_path or not source_job.video_filename:
        raise HTTPException(status_code=400, detail="The stored source video is no longer available")

    source = Path(source_job.video_path).resolve()
    video_dir = job_manager.video_dir.resolve()
    if not source.is_file():
        raise HTTPException(status_code=400, detail="The stored source video is no longer available")

    suffix = source.suffix.lower()
    if suffix not in VIDEO_EXTENSIONS:
        raise HTTPException(status_code=400, detail="The stored source video format is unsupported")

    if not source_job.video_managed:
        return str(source), source_job.video_filename, False

    if source.parent != video_dir:
        raise HTTPException(status_code=400, detail="The stored source video is no longer available")

    destination = video_dir / f"{uuid4().hex}{suffix}"
    try:
        os.link(source, destination)
    except OSError as exc:
        destination.unlink(missing_ok=True)
        raise HTTPException(
            status_code=500,
            detail="The stored video could not be reused. Select the video file manually and retry.",
        ) from exc
    return str(destination), source_job.video_filename, True


@app.post("/api/jobs", response_model=CreateJobResponse)
async def create_job(
    file: UploadFile = File(...),
    video_file: UploadFile | None = File(default=None),
    local_video_path: str = Form(default=""),
    reuse_video_job_id: str = Form(default=""),
    reuse_visual_context_job_id: str = Form(default=""),
    reference_files: list[UploadFile] | None = File(default=None),
    reference_languages: list[str] | None = Form(default=None),
    title: str = Form(default=""),
    base_url: str = Form(...),
    api_key: str = Form(default="lm-studio"),
    model: str = Form(...),
    source_language: str = Form(...),
    target_language: str = Form(...),
    target_language_tips: str = Form(default=""),
    batch_size: int = Form(default=10),
    temperature: float = Form(default=0.2),
    structured_context: bool = Form(default=True),
    visual_scene_context: bool = Form(default=False),
    visual_scene_frames: int = Form(default=4),
    visual_scene_frame_max_side: int = Form(default=640),
    adaptive_vision: bool = Form(default=False),
    vision_max_doubts: int = Form(default=1),
    vision_max_frames: int = Form(default=4),
    vision_frame_max_side: int = Form(default=448),
    initial_card_strategy: str = Form(default="auto"),
    initial_card_max_chars: int = Form(default=24000),
    max_completion_tokens: int = Form(default=1800),
    request_timeout_seconds: int = Form(default=120),
    prompt_translation_system: str = Form(default=""),
    prompt_translation_strict_retry: str = Form(default=""),
    prompt_initial_context_system: str = Form(default=""),
    prompt_full_context_refresh_system: str = Form(default=""),
    prompt_batch_context_refresh_system: str = Form(default=""),
    prompt_line_revision_system: str = Form(default=""),
) -> CreateJobResponse:
    if not file.filename.lower().endswith(".srt"):
        raise HTTPException(status_code=400, detail="Only .srt files are supported")
    content = (await file.read()).decode("utf-8-sig", errors="replace")
    try:
        settings = TranslationSettings(
            base_url=base_url,
            api_key=api_key,
            model=model,
            source_language=source_language,
            target_language=target_language,
            target_language_tips=target_language_tips,
            title=title or file.filename.rsplit(".", 1)[0],
            batch_size=batch_size,
            temperature=temperature,
            structured_context=structured_context,
            visual_scene_context=visual_scene_context,
            visual_scene_frames=visual_scene_frames,
            visual_scene_frame_max_side=visual_scene_frame_max_side,
            adaptive_vision=adaptive_vision,
            vision_max_doubts=vision_max_doubts,
            vision_max_frames=vision_max_frames,
            vision_frame_max_side=vision_frame_max_side,
            initial_card_strategy=initial_card_strategy,
            initial_card_max_chars=initial_card_max_chars,
            max_completion_tokens=max_completion_tokens,
            request_timeout_seconds=request_timeout_seconds,
            prompt_translation_system=prompt_translation_system,
            prompt_translation_strict_retry=prompt_translation_strict_retry,
            prompt_initial_context_system=prompt_initial_context_system,
            prompt_full_context_refresh_system=prompt_full_context_refresh_system,
            prompt_batch_context_refresh_system=prompt_batch_context_refresh_system,
            prompt_line_revision_system=prompt_line_revision_system,
        )
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail=exc.errors()) from exc

    vision_enabled = adaptive_vision or visual_scene_context
    has_video_upload = bool(video_file and video_file.filename)
    has_local_video = bool(local_video_path.strip())
    has_reusable_video = bool(reuse_video_job_id.strip())
    if vision_enabled and not (has_video_upload or has_local_video or has_reusable_video):
        raise HTTPException(status_code=400, detail="Visual features require a video file")

    reference_sources = await _read_reference_sources(reference_files, reference_languages)
    video_path = ""
    video_filename = ""
    video_managed = False
    if vision_enabled and has_local_video:
        selected_video = _resolve_local_video_path(local_video_path)
        video_path = str(selected_video)
        video_filename = selected_video.name
    elif vision_enabled and has_video_upload and video_file:
        video_path = await _save_video_upload(video_file)
        video_filename = str(video_file.filename or "")
        video_managed = True
    elif vision_enabled and has_reusable_video:
        video_path, video_filename, video_managed = _reuse_job_video(reuse_video_job_id.strip())
    try:
        job = job_manager.create_job(
            filename=file.filename,
            title=title,
            original_srt=content,
            settings=settings,
            reference_sources=reference_sources,
            video_filename=video_filename,
            video_path=video_path,
            video_managed=video_managed,
            reuse_visual_context_job_id=reuse_visual_context_job_id.strip(),
        )
    except DuplicateActiveJobError as exc:
        if video_path and video_managed:
            Path(video_path).unlink(missing_ok=True)
        raise HTTPException(
            status_code=409,
            detail=(
                f"This subtitle is already being translated by active job {exc.job.id} "
                f"at batch {exc.job.current_batch}/{exc.job.total_batches or '?'}."
            ),
        ) from exc
    except VisualContextReuseError as exc:
        if video_path and video_managed:
            Path(video_path).unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception:
        if video_path and video_managed:
            Path(video_path).unlink(missing_ok=True)
        raise
    return CreateJobResponse(job_id=job.id)


@app.post("/api/jobs/review", response_model=CreateJobResponse)
async def create_review_job(
    source_file: UploadFile = File(...),
    translated_file: UploadFile = File(...),
    reference_files: list[UploadFile] | None = File(default=None),
    reference_languages: list[str] | None = Form(default=None),
    title: str = Form(default=""),
    base_url: str = Form(...),
    api_key: str = Form(default="lm-studio"),
    model: str = Form(...),
    source_language: str = Form(...),
    target_language: str = Form(...),
    target_language_tips: str = Form(default=""),
    batch_size: int = Form(default=10),
    temperature: float = Form(default=0.2),
    structured_context: bool = Form(default=True),
    initial_card_strategy: str = Form(default="auto"),
    initial_card_max_chars: int = Form(default=24000),
    max_completion_tokens: int = Form(default=1800),
    request_timeout_seconds: int = Form(default=120),
    prompt_translation_system: str = Form(default=""),
    prompt_translation_strict_retry: str = Form(default=""),
    prompt_initial_context_system: str = Form(default=""),
    prompt_full_context_refresh_system: str = Form(default=""),
    prompt_batch_context_refresh_system: str = Form(default=""),
    prompt_line_revision_system: str = Form(default=""),
) -> CreateJobResponse:
    if not source_file.filename.lower().endswith(".srt") or not translated_file.filename.lower().endswith(".srt"):
        raise HTTPException(status_code=400, detail="Only .srt files are supported")

    source_content = (await source_file.read()).decode("utf-8-sig", errors="replace")
    translated_content = (await translated_file.read()).decode("utf-8-sig", errors="replace")
    try:
        settings = TranslationSettings(
            base_url=base_url,
            api_key=api_key,
            model=model,
            source_language=source_language,
            target_language=target_language,
            target_language_tips=target_language_tips,
            title=title or translated_file.filename.rsplit(".", 1)[0],
            batch_size=batch_size,
            temperature=temperature,
            structured_context=structured_context,
            initial_card_strategy=initial_card_strategy,
            initial_card_max_chars=initial_card_max_chars,
            max_completion_tokens=max_completion_tokens,
            request_timeout_seconds=request_timeout_seconds,
            prompt_translation_system=prompt_translation_system,
            prompt_translation_strict_retry=prompt_translation_strict_retry,
            prompt_initial_context_system=prompt_initial_context_system,
            prompt_full_context_refresh_system=prompt_full_context_refresh_system,
            prompt_batch_context_refresh_system=prompt_batch_context_refresh_system,
            prompt_line_revision_system=prompt_line_revision_system,
        )
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail=exc.errors()) from exc

    reference_sources = await _read_reference_sources(reference_files, reference_languages)
    job = job_manager.create_review_job(
        source_filename=source_file.filename,
        translated_filename=translated_file.filename,
        title=title,
        source_srt=source_content,
        translated_srt=translated_content,
        settings=settings,
        reference_sources=reference_sources,
    )
    return CreateJobResponse(job_id=job.id)


@app.post("/api/model/test", response_model=ModelTestResponse)
async def test_model(request: TranslationSettings) -> ModelTestResponse:
    result = await job_manager.translator.probe_connection(request)
    return ModelTestResponse(**result)


@app.post("/api/model/list", response_model=ModelListResponse)
async def list_models(request: TranslationSettings) -> ModelListResponse:
    result = await job_manager.translator.list_models(request)
    return ModelListResponse(**result)


@app.post("/api/jobs/{job_id}/pause")
async def pause_job(job_id: str) -> dict[str, str]:
    if not job_manager.request_pause(job_id):
        raise HTTPException(status_code=409, detail="Job cannot be paused")
    job = job_manager.get_job(job_id)
    return {"status": job.status.value, "message": job.message}


@app.post("/api/jobs/{job_id}/resume")
async def resume_job(job_id: str, request: ResumeJobRequest | None = None) -> dict[str, str]:
    if request and request.runtime_settings:
        job_manager.update_runtime_settings(job_id, request.runtime_settings)
    if not job_manager.resume(job_id):
        raise HTTPException(status_code=409, detail="Job cannot be resumed")
    return {"status": JobStatus.QUEUED.value, "message": "Job resumed"}


@app.post("/api/jobs/{job_id}/stop")
async def stop_job(job_id: str) -> dict[str, str]:
    if not job_manager.request_stop(job_id):
        raise HTTPException(status_code=409, detail="Job cannot be stopped")
    job = job_manager.get_job(job_id)
    return {"status": job.status.value, "message": job.message}


@app.patch("/api/jobs/{job_id}/context")
async def update_context(job_id: str, request: UpdateContextRequest) -> dict:
    try:
        context = SessionContext(**request.session_context)
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail=exc.errors()) from exc
    if not job_manager.update_context(job_id, context, request.target_language_tips):
        raise HTTPException(status_code=409, detail="Job context cannot be updated")
    job = job_manager.get_job(job_id)
    return _job_payload(job)


@app.post("/api/jobs/{job_id}/context/generate", response_model=GenerateContextResponse)
async def generate_job_context(job_id: str) -> GenerateContextResponse:
    try:
        context = await job_manager.generate_job_context(job_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Context generation failed: {exc}") from exc
    if not context:
        raise HTTPException(status_code=404, detail="Job not found")
    return GenerateContextResponse(session_context=context)


@app.patch("/api/jobs/{job_id}/batch-context/{batch_index}")
async def update_batch_context_snapshot(
    job_id: str,
    batch_index: int,
    request: UpdateBatchContextSnapshotRequest,
    view: Literal["full", "review"] = "full",
) -> dict:
    try:
        context = SessionContext(**request.session_context)
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail=exc.errors()) from exc
    job = job_manager.update_batch_context_snapshot(job_id, batch_index, context)
    if not job:
        raise HTTPException(status_code=404, detail="Batch context snapshot not found")
    return _job_review_payload(job) if view == "review" else _job_payload(job)


@app.get("/api/jobs/{job_id}/batch-context/{batch_index}")
async def get_batch_context_snapshot(job_id: str, batch_index: int) -> dict:
    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    payload = _batch_context_payload(job, batch_index)
    if payload is None:
        raise HTTPException(status_code=404, detail="Batch context snapshot not found")
    return payload


@app.post("/api/jobs/{job_id}/batch-context/{batch_index}/generate", response_model=GenerateContextResponse)
async def generate_batch_context_snapshot(job_id: str, batch_index: int) -> GenerateContextResponse:
    try:
        context = await job_manager.generate_batch_context_snapshot(job_id, batch_index)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Batch context generation failed: {exc}") from exc
    if not context:
        raise HTTPException(status_code=404, detail="Batch context snapshot not found")
    return GenerateContextResponse(session_context=context)


@app.patch("/api/jobs/{job_id}/lines/{position}")
async def update_translated_line(
    job_id: str,
    position: int,
    request: UpdateTranslatedLineRequest,
    view: Literal["full", "review"] = "full",
) -> dict:
    job = job_manager.update_translated_line(job_id, position, request.text, request.resolution_mode)
    if not job:
        raise HTTPException(status_code=404, detail="Translated subtitle line not found")
    return _job_review_payload(job) if view == "review" else _job_payload(job)


@app.post("/api/jobs/{job_id}/lines/{position}/retranslate")
async def retranslate_line(
    job_id: str,
    position: int,
    request: RetranslateLineRequest,
    view: Literal["full", "review"] = "full",
) -> dict:
    result = await job_manager.request_line_retranslation(job_id, position, request.extra_instruction)
    if not result:
        raise HTTPException(status_code=404, detail="Translated subtitle line not found")
    job, queued = result
    return {
        "queued": queued,
        "message": (
            f"Retranslation queued for line {position + 1}"
            if queued
            else f"Retranslation finished for line {position + 1}"
        ),
        "job": _job_review_payload(job) if view == "review" else _job_payload(job),
    }


@app.delete("/api/jobs/{job_id}")
async def delete_job(job_id: str) -> dict[str, str]:
    if not job_manager.delete_job(job_id):
        raise HTTPException(status_code=409, detail="Job cannot be deleted")
    return {"status": "deleted", "message": "Job deleted"}


@app.delete("/api/jobs")
async def clear_finished_jobs() -> dict[str, int | str]:
    removed = job_manager.clear_finished_jobs()
    return {"status": "ok", "removed": removed}


@app.get("/api/jobs/{job_id}/download")
async def download_job(job_id: str) -> JSONResponse:
    job = job_manager.get_job(job_id)
    if not job or job.status != JobStatus.COMPLETED or not job.translated_srt:
        raise HTTPException(status_code=404, detail="Translated subtitle not available")
    filename = f"{os.path.splitext(job.filename)[0]}.{job.settings.target_language}.srt"
    return JSONResponse(
        {
            "filename": filename,
            "content": job.translated_srt,
        }
    )


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("SUBTITLE_STUDIO_PORT", "7861"))
    uvicorn.run("app.main:app", host="127.0.0.1", port=port, reload=False)
