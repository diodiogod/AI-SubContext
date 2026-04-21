from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field

from app.config import TranslationSettings


class JobStatus(str, Enum):
    QUEUED = "queued"
    PROCESSING = "processing"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class SubtitleLine(BaseModel):
    position: int
    text: str
    start_time: str = ""
    end_time: str = ""


class SessionCharacter(BaseModel):
    name: str
    role: str = ""
    aliases: list[str] = Field(default_factory=list)
    gender: str = "unknown"


class GlossaryEntry(BaseModel):
    term: str
    meaning: str = ""
    keep: bool = True


class SessionContext(BaseModel):
    movie_title: str = ""
    media_type: str = "Movie"
    source_language: str = ""
    target_language: str = ""
    premise: str = ""
    tone: str = ""
    scene_context: str = ""
    style_notes: list[str] = Field(default_factory=list)
    characters: list[SessionCharacter] = Field(default_factory=list)
    glossary: list[GlossaryEntry] = Field(default_factory=list)
    unresolved_ambiguities: list[str] = Field(default_factory=list)


class JobLogEntry(BaseModel):
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    level: str = "info"
    message: str
    batch_index: int | None = None


class JobValidationStats(BaseModel):
    suspicious_subtitles: int = 0
    auto_fixed_subtitles: int = 0
    manual_fixed_subtitles: int = 0
    error_subtitles: int = 0
    retried_batches: int = 0
    split_batches: int = 0


class SubtitleValidationIssue(BaseModel):
    position: int
    status: str = "suspect"
    source_text: str = ""
    translated_text: str = ""
    reason_codes: list[str] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
    batch_index: int | None = None


class QueuedLineRetranslation(BaseModel):
    position: int
    extra_instruction: str = ""
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class BatchContextSnapshot(BaseModel):
    batch_index: int
    start_position: int
    end_position: int
    input_context: SessionContext | None = None
    output_context: SessionContext | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class ReferenceSubtitleMatch(BaseModel):
    position: int
    text: str = ""
    confidence: float = 0.0
    matched_positions: list[int] = Field(default_factory=list)
    start_time: str = ""
    end_time: str = ""


class ReferenceSubtitleTrack(BaseModel):
    filename: str
    language: str
    total_lines: int = 0
    matched_lines: int = 0
    average_confidence: float = 0.0
    alignment_mode: str = "timestamp"
    aligned_lines: list[ReferenceSubtitleMatch] = Field(default_factory=list)


class TranslationJob(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    filename: str
    title: str
    job_kind: str = "translation"
    settings: TranslationSettings
    original_srt: str
    original_lines: list[SubtitleLine]
    translated_lines: list[SubtitleLine] = Field(default_factory=list)
    reference_tracks: list[ReferenceSubtitleTrack] = Field(default_factory=list)
    session_context: SessionContext | None = None
    session_context_history: list[dict[str, Any]] = Field(default_factory=list)
    batch_context_snapshots: list[BatchContextSnapshot] = Field(default_factory=list)
    validation_stats: JobValidationStats = Field(default_factory=JobValidationStats)
    validation_issues: list[SubtitleValidationIssue] = Field(default_factory=list)
    pending_retranslations: list[QueuedLineRetranslation] = Field(default_factory=list)
    logs: list[JobLogEntry] = Field(default_factory=list)
    status: JobStatus = JobStatus.QUEUED
    progress: int = 0
    message: str = ""
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    started_at: datetime | None = None
    completed_at: datetime | None = None
    error: str | None = None
    current_batch: int = 0
    total_batches: int = 0
    pause_requested: bool = False
    stop_requested: bool = False
    translated_srt: str | None = None
    task_name: str | None = None


class UpdateTranslatedLineRequest(BaseModel):
    text: str
    resolution_mode: str = "save"


class RetranslateLineRequest(BaseModel):
    extra_instruction: str = ""


class UpdateBatchContextSnapshotRequest(BaseModel):
    session_context: dict[str, Any]


class GenerateContextResponse(BaseModel):
    session_context: SessionContext


class CreateJobResponse(BaseModel):
    job_id: str


class ModelTestResponse(BaseModel):
    ok: bool
    base_url: str | None = None
    model: str | None = None
    message: str


class ModelListResponse(BaseModel):
    ok: bool
    base_url: str | None = None
    models: list[str] = Field(default_factory=list)
    message: str


class RuntimeDefaultsResponse(BaseModel):
    max_completion_tokens: int
    request_timeout_seconds: int
    prompt_translation_system: str
    prompt_translation_strict_retry: str
    prompt_initial_context_system: str
    prompt_full_context_refresh_system: str
    prompt_batch_context_refresh_system: str
    prompt_line_revision_system: str


class UpdateContextRequest(BaseModel):
    session_context: dict[str, Any]
