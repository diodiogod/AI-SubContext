from __future__ import annotations

import os

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from app.config import TranslationSettings
from app.job_manager import job_manager
from app.models import (
    CreateJobResponse,
    GenerateContextResponse,
    JobStatus,
    ModelListResponse,
    ModelTestResponse,
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

app = FastAPI(title="AI SubContext", version=__version__)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


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
    return [job.model_dump(mode="json") for job in job_manager.list_jobs()]


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str) -> dict:
    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job.model_dump(mode="json")


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


@app.post("/api/jobs", response_model=CreateJobResponse)
async def create_job(
    file: UploadFile = File(...),
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
    job = job_manager.create_job(
        filename=file.filename,
        title=title,
        original_srt=content,
        settings=settings,
        reference_sources=reference_sources,
    )
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
async def resume_job(job_id: str) -> dict[str, str]:
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
    return job.model_dump(mode="json")


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
    return job.model_dump(mode="json")


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
    return job.model_dump(mode="json")


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
        "job": job.model_dump(mode="json"),
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
