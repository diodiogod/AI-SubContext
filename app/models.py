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


class JobVisionStats(BaseModel):
    scene_cards_total: int = 0
    scene_cards_created: int = 0
    scene_context_failures: int = 0
    doubts_requested: int = 0
    doubts_approved: int = 0
    doubts_rejected: int = 0
    clarification_requests: int = 0
    lines_revised: int = 0
    clarification_failures: int = 0


class VisualDoubt(BaseModel):
    position: int
    category: str
    question: str
    timestamp_hint: str = "middle"
    current_translation: str = ""
    alternative_translation: str = ""
    translation_impact: str = ""


class VisualObservation(BaseModel):
    position: int
    category: str
    answer: str = ""
    confidence: str = "unknown"


class VisualFrameLineDetail(BaseModel):
    position: int
    category: str
    question: str = ""
    alternative_translation: str = ""
    translation_impact: str = ""
    source_text: str = ""
    provisional_translation: str = ""
    final_translation: str = ""
    answer: str = ""
    confidence: str = "unknown"
    revised: bool = False


class VisualFrameRecord(BaseModel):
    id: str
    batch_index: int
    timestamp_ms: int
    related_positions: list[int] = Field(default_factory=list)
    categories: list[str] = Field(default_factory=list)
    revised_positions: list[int] = Field(default_factory=list)
    details: list[VisualFrameLineDetail] = Field(default_factory=list)
    status: str = "used"
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class VisualSceneContext(BaseModel):
    scene_index: int
    start_position: int
    end_position: int
    start_time: str = ""
    end_time: str = ""
    setting: str = ""
    visible_characters: list[str] = Field(default_factory=list)
    actions: list[str] = Field(default_factory=list)
    objects: list[str] = Field(default_factory=list)
    on_screen_text: list[str] = Field(default_factory=list)
    speaker_evidence: list[str] = Field(default_factory=list)
    uncertainties: list[str] = Field(default_factory=list)
    summary: str = ""
    frame_ids: list[str] = Field(default_factory=list)


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


class BatchTimingSample(BaseModel):
    batch_index: int
    line_count: int
    duration_seconds: float
    lines_per_second: float
    completed_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


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


class StoredReferenceUpload(BaseModel):
    filename: str
    language: str
    content: str = ""


class TranslationJob(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    filename: str
    source_filename: str = ""
    title: str
    job_kind: str = "translation"
    settings: TranslationSettings
    original_srt: str
    original_lines: list[SubtitleLine]
    translated_lines: list[SubtitleLine] = Field(default_factory=list)
    reference_tracks: list[ReferenceSubtitleTrack] = Field(default_factory=list)
    reference_uploads: list[StoredReferenceUpload] = Field(default_factory=list)
    video_filename: str = ""
    video_path: str = ""
    video_managed: bool = True
    session_context: SessionContext | None = None
    session_context_history: list[dict[str, Any]] = Field(default_factory=list)
    batch_context_snapshots: list[BatchContextSnapshot] = Field(default_factory=list)
    validation_stats: JobValidationStats = Field(default_factory=JobValidationStats)
    vision_stats: JobVisionStats = Field(default_factory=JobVisionStats)
    visual_observations: list[VisualObservation] = Field(default_factory=list)
    visual_frames: list[VisualFrameRecord] = Field(default_factory=list)
    visual_scene_contexts: list[VisualSceneContext] = Field(default_factory=list)
    validation_issues: list[SubtitleValidationIssue] = Field(default_factory=list)
    pending_retranslations: list[QueuedLineRetranslation] = Field(default_factory=list)
    logs: list[JobLogEntry] = Field(default_factory=list)
    status: JobStatus = JobStatus.QUEUED
    progress: int = 0
    eta_seconds: int | None = None
    estimated_completion_at: datetime | None = None
    batch_timing_samples: list[BatchTimingSample] = Field(default_factory=list)
    message: str = ""
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    started_at: datetime | None = None
    completed_at: datetime | None = None
    error: str | None = None
    current_batch: int = 0
    total_batches: int = 0
    active_batch_index: int | None = None
    active_batch_positions: list[int] = Field(default_factory=list)
    active_recovery_positions: list[int] = Field(default_factory=list)
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


class ReloadJobFile(BaseModel):
    filename: str
    content: str


class ReloadJobReferenceFile(BaseModel):
    filename: str
    language: str
    content: str


class ReloadJobVideo(BaseModel):
    filename: str = ""
    available: bool = False


class ReloadJobResponse(BaseModel):
    job_id: str
    job_kind: str
    title: str
    settings: TranslationSettings
    source_file: ReloadJobFile
    translated_file: ReloadJobFile | None = None
    reference_files: list[ReloadJobReferenceFile] = Field(default_factory=list)
    video_file: ReloadJobVideo = Field(default_factory=ReloadJobVideo)
    visual_context_available: bool = False
    visual_context_count: int = 0
    warnings: list[str] = Field(default_factory=list)


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
    legacy_prompt_fingerprints: dict[str, list[str]] = Field(default_factory=dict)


class UpdateContextRequest(BaseModel):
    session_context: dict[str, Any]
    target_language_tips: str | None = None


class ResumeJobRequest(BaseModel):
    runtime_settings: dict[str, Any] = Field(default_factory=dict)
