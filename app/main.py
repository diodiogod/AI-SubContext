from __future__ import annotations

import os
from mimetypes import guess_type
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from app.config import TranslationSettings
from app.job_manager import DuplicateActiveJobError, job_manager
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
    UpdateBatchContextSnapshotRequest,
    UpdateTranslatedLineRequest,
    UpdateContextRequest,
)
from app.version import __version__


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
VIDEO_EXTENSIONS = {".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v", ".ts"}

app = FastAPI(title="AI SubContext", version=__version__)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def _job_payload(job) -> dict:
    return job.model_dump(mode="json", exclude={"video_path"})


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
async def list_jobs() -> list[dict]:
    return [_job_payload(job) for job in job_manager.list_jobs()]


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str) -> dict:
    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return _job_payload(job)


@app.get("/api/jobs/{job_id}/reload", response_model=ReloadJobResponse)
async def get_job_reload(job_id: str) -> ReloadJobResponse:
    payload = job_manager.build_reload_payload(
        job_id,
        video_download_url=f"/api/jobs/{job_id}/reload/video",
    )
    if payload is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return payload


@app.get("/api/jobs/{job_id}/reload/video")
async def get_job_reload_video(job_id: str) -> FileResponse:
    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if not job.video_filename or not job.video_path:
        raise HTTPException(status_code=404, detail="Job video is not available")
    video_path = Path(job.video_path)
    if not video_path.is_file():
        raise HTTPException(status_code=404, detail="Job video is not available")
    media_type = guess_type(job.video_filename)[0] or "application/octet-stream"
    return FileResponse(
        video_path,
        media_type=media_type,
        filename=job.video_filename,
        headers={"Cache-Control": "private, max-age=3600"},
    )


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
    except DuplicateActiveJobError as exc:
        if video_path:
            Path(video_path).unlink(missing_ok=True)
        raise HTTPException(
            status_code=409,
            detail=(
                f"This subtitle is already being translated by active job {exc.job.id} "
                f"at batch {exc.job.current_batch}/{exc.job.total_batches or '?'}."
            ),
        ) from exc
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    if not destination.is_file() or destination.stat().st_size == 0:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="The uploaded video is empty")
    return str(destination)


@app.post("/api/jobs", response_model=CreateJobResponse)
async def create_job(
    file: UploadFile = File(...),
    video_file: UploadFile | None = File(default=None),
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
    if vision_enabled and not (video_file and video_file.filename):
        raise HTTPException(status_code=400, detail="Visual features require a video file")

    reference_sources = await _read_reference_sources(reference_files, reference_languages)
    video_path = ""
    if vision_enabled and video_file and video_file.filename:
        video_path = await _save_video_upload(video_file)
    try:
        job = job_manager.create_job(
            filename=file.filename,
            title=title,
            original_srt=content,
            settings=settings,
            reference_sources=reference_sources,
            video_filename=str(video_file.filename or "") if vision_enabled and video_file else "",
            video_path=video_path,
        )
    except Exception:
        if video_path:
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
async def update_batch_context_snapshot(job_id: str, batch_index: int, request: UpdateBatchContextSnapshotRequest) -> dict:
    try:
        context = SessionContext(**request.session_context)
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail=exc.errors()) from exc
    job = job_manager.update_batch_context_snapshot(job_id, batch_index, context)
    if not job:
        raise HTTPException(status_code=404, detail="Batch context snapshot not found")
    return _job_payload(job)


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
async def update_translated_line(job_id: str, position: int, request: UpdateTranslatedLineRequest) -> dict:
    job = job_manager.update_translated_line(job_id, position, request.text, request.resolution_mode)
    if not job:
        raise HTTPException(status_code=404, detail="Translated subtitle line not found")
    return _job_payload(job)


@app.post("/api/jobs/{job_id}/lines/{position}/retranslate")
async def retranslate_line(job_id: str, position: int, request: RetranslateLineRequest) -> dict:
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
        "job": _job_payload(job),
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
