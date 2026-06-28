from __future__ import annotations

import asyncio
import json
import os
import time
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile

from app.models import (
    BatchContextSnapshot,
    BatchTimingSample,
    JobLogEntry,
    JobStatus,
    QueuedLineRetranslation,
    ReloadJobFile,
    ReloadJobReferenceFile,
    ReloadJobResponse,
    ReloadJobVideo,
    ReferenceSubtitleTrack,
    SessionContext,
    StoredReferenceUpload,
    SubtitleLine,
    SubtitleValidationIssue,
    TranslationJob,
    VisualFrameRecord,
    VisualFrameLineDetail,
    VisualSceneContext,
)
from app.srt_utils import (
    align_reference_track,
    chunk_lines,
    compose_translated_srt,
    parse_srt_text,
    strip_ai_disclosure_line,
)
from app.translator import (
    OpenAICompatibleTranslator,
    TranslationStopRequested,
    _line_looks_untranslated,
    _looks_like_unchanged_proper_name,
    _validate_translated_batch,
)
from app.vision import VideoFrameProvider, build_visual_scene_windows, validate_visual_doubts


class DuplicateActiveJobError(RuntimeError):
    def __init__(self, job: TranslationJob):
        self.job = job
        super().__init__(f"An active job already exists for this subtitle: {job.id}")


class JobManager:
    def __init__(self) -> None:
        self.jobs: dict[str, TranslationJob] = {}
        self.tasks: dict[str, asyncio.Task] = {}
        self.translator = OpenAICompatibleTranslator()
        self.state_file = self._default_state_file()
        self.video_dir = self.state_file.parent / "videos"
        self.vision = VideoFrameProvider(self.state_file.parent / "vision_cache")
        self._load_state()

    def _default_state_file(self) -> Path:
        project_root = Path(__file__).resolve().parent.parent
        data_dir = project_root / "data"
        data_dir.mkdir(parents=True, exist_ok=True)
        return data_dir / "jobs.json"

    def _delete_job_video(self, job: TranslationJob) -> None:
        if not job.video_path:
            return
        try:
            video_path = Path(job.video_path).resolve()
            video_dir = self.video_dir.resolve()
            if video_path.parent == video_dir:
                video_path.unlink(missing_ok=True)
        except OSError:
            return

    def _save_state(self) -> None:
        payload = {
            "jobs": [job.model_dump(mode="json") for job in self.jobs.values()],
        }

        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        with NamedTemporaryFile("w", delete=False, dir=self.state_file.parent, encoding="utf-8") as tmp:
            json.dump(payload, tmp, ensure_ascii=False, indent=2)
            tmp.flush()
            os.fsync(tmp.fileno())
            temp_path = Path(tmp.name)
        temp_path.replace(self.state_file)

    def _recover_job_after_restart(self, job: TranslationJob) -> TranslationJob:
        retained_issues: list[SubtitleValidationIssue] = []
        for issue in job.validation_issues:
            false_positive = (
                "unchanged_from_source" in issue.reason_codes
                and _looks_like_unchanged_proper_name(
                    issue.source_text,
                    issue.translated_text,
                    job.session_context,
                )
            )
            if false_positive:
                if issue.status == "error" and job.validation_stats.error_subtitles > 0:
                    job.validation_stats.error_subtitles -= 1
                elif issue.status == "suspect" and job.validation_stats.suspicious_subtitles > 0:
                    job.validation_stats.suspicious_subtitles -= 1
                continue
            retained_issues.append(issue)
        job.validation_issues = retained_issues

        for frame in job.visual_frames:
            if frame.status == "pending":
                frame.status = "failed"
        if job.status in {JobStatus.PROCESSING, JobStatus.QUEUED}:
            job.status = JobStatus.PAUSED
            job.pause_requested = False
            job.stop_requested = False
            job.message = "Recovered after restart; resume to continue"
            job.task_name = None
        elif job.status == JobStatus.PAUSED:
            job.message = job.message or "Paused and ready to resume"
        job.completed_at = job.completed_at if job.status in {JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED} else None
        return job

    def _load_state(self) -> None:
        if not self.state_file.exists():
            return

        try:
            payload = json.loads(self.state_file.read_text(encoding="utf-8"))
            jobs = payload.get("jobs") or []
            for raw_job in jobs:
                try:
                    job = TranslationJob.model_validate(raw_job)
                    job = self._recover_job_after_restart(job)
                    self.jobs[job.id] = job
                except Exception:
                    continue
        except Exception:
            return

    def list_jobs(self) -> list[TranslationJob]:
        return sorted(self.jobs.values(), key=lambda job: job.created_at, reverse=True)

    def get_job(self, job_id: str) -> TranslationJob | None:
        return self.jobs.get(job_id)

    def build_reload_payload(self, job_id: str, *, video_download_url: str = "") -> ReloadJobResponse | None:
        job = self.jobs.get(job_id)
        if job is None:
            return None

        warnings: list[str] = []
        source_filename = job.source_filename or ""
        if not source_filename:
            if job.job_kind == "review":
                source_filename = "source.srt"
                warnings.append("This older review job did not preserve the original source filename, so a generic name was used.")
            else:
                source_filename = job.filename or "source.srt"
        translated_file = None
        if job.job_kind == "review":
            translated_content = job.translated_srt or ""
            if translated_content:
                translated_file = ReloadJobFile(
                    filename=job.filename or "translated.srt",
                    content=translated_content,
                )
            else:
                warnings.append("The translated review subtitle is no longer stored for this job.")

        reference_files = [
            ReloadJobReferenceFile(
                filename=item.filename or "reference.srt",
                language=item.language,
                content=item.content,
            )
            for item in job.reference_uploads
            if item.content
        ]
        if job.reference_tracks and not reference_files:
            warnings.append("Reference subtitle uploads were not stored for this older job, so they could not be reloaded.")

        video_available = bool(job.video_filename and job.video_path and Path(job.video_path).is_file())
        if job.video_filename and not video_available:
            warnings.append("The original video file is no longer available, so visual features will need a new upload.")

        return ReloadJobResponse(
            job_id=job.id,
            job_kind=job.job_kind,
            title=job.title,
            settings=job.settings,
            source_file=ReloadJobFile(
                filename=source_filename,
                content=job.original_srt,
            ),
            translated_file=translated_file,
            reference_files=reference_files,
            video_file=ReloadJobVideo(
                filename=job.video_filename or "",
                available=video_available,
                download_url=video_download_url if video_available else "",
            ),
            warnings=warnings,
        )

    def _append_log(
        self,
        job: TranslationJob,
        level: str,
        message: str,
        batch_index: int | None = None,
        save: bool = True,
    ) -> None:
        job.logs.append(
            JobLogEntry(
                level=level,
                message=message,
                batch_index=batch_index,
            )
        )
        if len(job.logs) > 400:
            job.logs = job.logs[-400:]
        if save:
            self._save_state()

    def _apply_validation_stats(self, job: TranslationJob, stats) -> None:
        job.validation_stats.suspicious_subtitles += int(getattr(stats, "suspicious_count", 0) or 0)
        job.validation_stats.auto_fixed_subtitles += int(getattr(stats, "fixed_count", 0) or 0)
        job.validation_stats.manual_fixed_subtitles += int(getattr(stats, "manual_fixed_count", 0) or 0)
        job.validation_stats.error_subtitles += int(getattr(stats, "error_count", 0) or 0)
        job.validation_stats.retried_batches += int(getattr(stats, "retried_batches", 0) or 0)
        job.validation_stats.split_batches += int(getattr(stats, "split_batches", 0) or 0)
        self._merge_validation_issues(job, list(getattr(stats, "issues", []) or []))

    async def _apply_adaptive_vision(
        self,
        job: TranslationJob,
        batch_index: int,
        batch_lines: list[SubtitleLine],
        translated_lines: list[SubtitleLine],
        session_context: SessionContext | None,
        stats,
    ) -> list[SubtitleLine]:
        doubts = list(getattr(stats, "visual_doubts", []) or [])
        if not doubts:
            return translated_lines

        job.vision_stats.doubts_requested += len(doubts)
        approved, rejected = validate_visual_doubts(
            doubts,
            batch_lines,
            max_doubts=job.settings.vision_max_doubts,
            translated_lines=translated_lines,
        )
        job.vision_stats.doubts_approved += len(approved)
        job.vision_stats.doubts_rejected += len(rejected)
        if rejected:
            self._append_log(
                job,
                "info",
                f"Rejected {len(rejected)} visual doubt(s) that exceeded limits or failed validation",
                batch_index=batch_index,
                save=False,
            )
        if not approved:
            return translated_lines

        frames = []
        try:
            frames = await self.vision.extract_for_doubts(
                job.id,
                job.video_path,
                batch_index,
                batch_lines,
                approved,
                max_frames=job.settings.vision_max_frames,
                max_side=job.settings.vision_frame_max_side,
            )
            if not frames:
                raise RuntimeError("No usable frames were selected")
            framed_positions = {
                position for frame in frames for position in frame.related_positions
            }
            unframed = [
                doubt for doubt in approved if doubt.position not in framed_positions
            ]
            if unframed:
                job.vision_stats.doubts_approved -= len(unframed)
                job.vision_stats.doubts_rejected += len(unframed)
                approved = [
                    doubt for doubt in approved if doubt.position in framed_positions
                ]
                self._append_log(
                    job,
                    "info",
                    f"Rejected {len(unframed)} visual doubt(s) because no frame was selected for them",
                    batch_index=batch_index,
                    save=False,
                )
            if not approved:
                return translated_lines
            job.vision_stats.clarification_requests += 1
            before = {line.position: line.text for line in translated_lines}
            self._record_visual_frames(
                job,
                batch_index,
                frames,
                approved,
                batch_lines,
                before,
                before,
                [],
                [],
                status="pending",
            )
            self._save_state()
            revised_lines, observations = await self.translator.clarify_visual_doubts(
                job.settings,
                batch_lines,
                translated_lines,
                session_context,
                approved,
                frames,
                log_event=lambda level, message: self._append_log(
                    job,
                    level,
                    message,
                    batch_index=batch_index,
                ),
            )
            source_by_position = {line.position: line for line in batch_lines}
            provisional_by_position = {line.position: line for line in translated_lines}
            validated_lines: list[SubtitleLine] = []
            rejected_revisions = 0
            for line in revised_lines:
                provisional = provisional_by_position.get(line.position, line)
                source = source_by_position.get(line.position)
                if source is None or line.text == provisional.text:
                    validated_lines.append(line)
                    continue
                validation = _validate_translated_batch(
                    job.settings,
                    [source],
                    [line],
                    session_context,
                )
                untranslated = _line_looks_untranslated(
                    source.text,
                    line.text,
                    session_context,
                ) and not _looks_like_unchanged_proper_name(
                    source.text,
                    line.text,
                    session_context,
                )
                unchanged_source = (
                    " ".join(source.text.split()).strip().casefold()
                    == " ".join(line.text.split()).strip().casefold()
                    and not _looks_like_unchanged_proper_name(
                        source.text,
                        line.text,
                        session_context,
                    )
                )
                if (
                    unchanged_source
                    or untranslated
                    or validation.failed
                    or validation.suspicious_positions
                ):
                    validated_lines.append(provisional)
                    rejected_revisions += 1
                else:
                    validated_lines.append(line)
            revised_lines = validated_lines
            if rejected_revisions:
                self._append_log(
                    job,
                    "warn",
                    f"Rejected {rejected_revisions} visual revision(s) that failed translation validation",
                    batch_index=batch_index,
                    save=False,
                )
            revised_count = sum(
                1
                for line in revised_lines
                if line.position in before and line.text != before[line.position]
            )
            revised_positions = [
                line.position
                for line in revised_lines
                if line.position in before and line.text != before[line.position]
            ]
            job.vision_stats.lines_revised += revised_count
            if observations:
                job.visual_observations.extend(observations)
                job.visual_observations = job.visual_observations[-200:]
            self._record_visual_frames(
                job,
                batch_index,
                frames,
                approved,
                batch_lines,
                before,
                {line.position: line.text for line in revised_lines},
                observations,
                revised_positions,
                status="used",
            )
            self._append_log(
                job,
                "info",
                f"Visual clarification completed; revised {revised_count}/{len(approved)} requested line(s)",
                batch_index=batch_index,
                save=False,
            )
            return revised_lines
        except Exception as exc:
            job.vision_stats.clarification_failures += 1
            if frames:
                self._record_visual_frames(
                    job,
                    batch_index,
                    frames,
                    approved,
                    batch_lines,
                    {line.position: line.text for line in translated_lines},
                    {line.position: line.text for line in translated_lines},
                    [],
                    [],
                    status="failed",
                )
            self._append_log(
                job,
                "warn",
                f"Visual clarification failed; keeping provisional translations: {exc}",
                batch_index=batch_index,
                save=False,
            )
            return translated_lines

    def _visual_contexts_for_lines(
        self,
        job: TranslationJob,
        batch_lines: list[SubtitleLine],
    ) -> list[VisualSceneContext]:
        if not batch_lines or not job.visual_scene_contexts:
            return []
        start_position = batch_lines[0].position
        end_position = batch_lines[-1].position
        return [
            context
            for context in job.visual_scene_contexts
            if context.end_position >= start_position
            and context.start_position <= end_position
        ]

    async def _build_visual_scene_contexts(self, job: TranslationJob) -> None:
        scenes = build_visual_scene_windows(job.original_lines)
        if not scenes:
            return
        self._append_log(
            job,
            "info",
            f"Building visual scene context from {len(scenes)} scene window(s)",
            save=False,
        )
        job.vision_stats.scene_cards_total = len(scenes)
        completed = {item.scene_index: item for item in job.visual_scene_contexts}
        previous_scene: VisualSceneContext | None = None
        for scene in scenes:
            if job.stop_requested:
                raise TranslationStopRequested("Translation stopped by user")
            if job.pause_requested and job.visual_scene_contexts:
                break
            if scene.scene_index in completed:
                previous_scene = completed[scene.scene_index]
                continue
            try:
                job.message = f"Preparing visual scene guide {scene.scene_index}/{len(scenes)}"
                frames = await self.vision.extract_for_scene(
                    job.id,
                    job.video_path,
                    scene,
                    frame_count=job.settings.visual_scene_frames,
                    max_side=job.settings.visual_scene_frame_max_side,
                )
                for frame in frames:
                    existing = {item.id: item for item in job.visual_frames}
                    existing[frame.id] = VisualFrameRecord(
                        id=frame.id,
                        batch_index=scene.scene_index,
                        timestamp_ms=frame.timestamp_ms,
                        related_positions=list(frame.related_positions),
                        categories=["scene_context"],
                        status="pending",
                    )
                    job.visual_frames = sorted(
                        existing.values(),
                        key=lambda item: (item.timestamp_ms, item.batch_index),
                    )[-240:]
                self._save_state()
                context = await self.translator.analyze_visual_scene(
                    job.settings,
                    scene.scene_index,
                    scene.lines,
                    job.session_context,
                    previous_scene,
                    frames,
                    log_event=lambda level, message, scene_no=scene.scene_index: self._append_log(
                        job,
                        level,
                        message,
                        batch_index=None,
                    ),
                )
                job.visual_scene_contexts.append(context)
                job.visual_scene_contexts.sort(key=lambda item: item.scene_index)
                for frame in job.visual_frames:
                    if frame.id in context.frame_ids:
                        frame.status = "scene"
                job.vision_stats.scene_cards_created += 1
                previous_scene = context
                job.message = f"Prepared visual scene guide {scene.scene_index}/{len(scenes)}"
                self._append_log(
                    job,
                    "info",
                    f"Visual scene {scene.scene_index}/{len(scenes)} ready",
                    save=False,
                )
                self._save_state()
            except TranslationStopRequested:
                raise
            except Exception as exc:
                job.vision_stats.scene_context_failures += 1
                for frame in job.visual_frames:
                    if frame.batch_index == scene.scene_index and frame.status == "pending":
                        frame.status = "failed"
                self._append_log(
                    job,
                    "warn",
                    f"Visual scene {scene.scene_index} failed and will be skipped: {exc}",
                    save=False,
                )
                self._save_state()
        job.message = f"Visual scene guides ready: {len(job.visual_scene_contexts)}/{len(scenes)}"

    def _record_visual_frames(
        self,
        job: TranslationJob,
        batch_index: int,
        frames,
        doubts,
        batch_lines: list[SubtitleLine],
        provisional_by_position: dict[int, str],
        final_by_position: dict[int, str],
        observations,
        revised_positions: list[int],
        status: str,
    ) -> None:
        category_by_position = {doubt.position: doubt.category for doubt in doubts}
        doubt_by_position = {doubt.position: doubt for doubt in doubts}
        source_by_position = {line.position: line.text for line in batch_lines}
        observation_by_position = {item.position: item for item in observations}
        existing = {frame.id: frame for frame in job.visual_frames}
        for frame in frames:
            categories = list(
                dict.fromkeys(
                    category_by_position[position]
                    for position in frame.related_positions
                    if position in category_by_position
                )
            )
            details: list[VisualFrameLineDetail] = []
            for position in frame.related_positions:
                doubt = doubt_by_position.get(position)
                if doubt is None:
                    continue
                observation = observation_by_position.get(position)
                details.append(
                    VisualFrameLineDetail(
                        position=position,
                        category=doubt.category,
                        question=doubt.question,
                        alternative_translation=doubt.alternative_translation,
                        translation_impact=doubt.translation_impact,
                        source_text=source_by_position.get(position, ""),
                        provisional_translation=provisional_by_position.get(position, ""),
                        final_translation=final_by_position.get(position, ""),
                        answer=observation.answer if observation else "",
                        confidence=observation.confidence if observation else "unknown",
                        revised=position in revised_positions,
                    )
                )
            existing[frame.id] = VisualFrameRecord(
                id=frame.id,
                batch_index=batch_index,
                timestamp_ms=frame.timestamp_ms,
                related_positions=list(frame.related_positions),
                categories=categories,
                revised_positions=[
                    position for position in frame.related_positions if position in revised_positions
                ],
                details=details,
                status=status,
            )
        job.visual_frames = sorted(
            existing.values(),
            key=lambda frame: (frame.timestamp_ms, frame.batch_index),
        )[-240:]

    def _merge_validation_issues(self, job: TranslationJob, issues) -> None:
        if not issues:
            return
        existing = {issue.position: issue for issue in job.validation_issues}
        for issue in issues:
            previous = existing.get(issue.position)
            issue.notes = self._notes_with_previous_context(
                previous,
                issue.status,
                list(issue.notes or []),
            )
            existing[issue.position] = issue
        job.validation_issues = [existing[position] for position in sorted(existing)]

    def _notes_with_previous_context(
        self,
        previous_issue: SubtitleValidationIssue | None,
        status: str,
        notes: list[str],
    ) -> list[str]:
        merged: list[str] = []
        seen: set[str] = set()

        def add_note(value: str) -> None:
            note = str(value or "").strip()
            if not note or note in seen:
                return
            seen.add(note)
            merged.append(note)

        for note in notes:
            add_note(note)

        # When a retry fixes a previously flagged subtitle, keep the prior findings
        # so users can understand what was wrong before the fix.
        if (
            previous_issue
            and status == "auto_fixed"
            and previous_issue.status in {"suspect", "error"}
        ):
            previous_codes = [
                str(code or "").strip()
                for code in (previous_issue.reason_codes or [])
                if str(code or "").strip()
            ]
            if previous_codes:
                add_note(f"Previous reason codes: {', '.join(previous_codes)}")
            for note in previous_issue.notes or []:
                cleaned = str(note or "").strip()
                if not cleaned:
                    continue
                add_note(f"Previous issue: {cleaned}")

        return merged

    def _line_by_position(self, lines: list[SubtitleLine], position: int) -> SubtitleLine | None:
        for line in lines:
            if line.position == position:
                return line
        return None

    def _build_reference_tracks(
        self,
        primary_lines: list[SubtitleLine],
        reference_sources: list[dict[str, str]] | None = None,
    ) -> list[ReferenceSubtitleTrack]:
        tracks: list[ReferenceSubtitleTrack] = []
        for source in reference_sources or []:
            language = str(source.get("language") or "").strip()
            content = str(source.get("content") or "")
            filename = str(source.get("filename") or "reference.srt").strip() or "reference.srt"
            if not language or not content:
                continue
            _, reference_lines = parse_srt_text(content)
            tracks.append(
                align_reference_track(
                    primary_lines,
                    reference_lines,
                    filename=filename,
                    language=language,
                )
            )
        return tracks

    def _build_reference_uploads(
        self,
        reference_sources: list[dict[str, str]] | None = None,
    ) -> list[StoredReferenceUpload]:
        uploads: list[StoredReferenceUpload] = []
        for source in reference_sources or []:
            uploads.append(
                StoredReferenceUpload(
                    filename=str(source.get("filename") or "reference.srt").strip() or "reference.srt",
                    language=str(source.get("language") or "").strip(),
                    content=str(source.get("content") or ""),
                )
            )
        return uploads

    def _reference_payload_for_positions(
        self,
        job: TranslationJob,
        positions: list[int],
    ) -> dict[int, list[dict[str, object]]]:
        if not job.reference_tracks or not positions:
            return {}

        wanted = set(positions)
        payload: dict[int, list[dict[str, object]]] = {}
        for track in job.reference_tracks:
            for match in track.aligned_lines:
                if match.position not in wanted or not match.text.strip():
                    continue
                payload.setdefault(match.position, []).append(
                    {
                        "language": track.language,
                        "filename": track.filename,
                        "text": match.text,
                        "confidence": round(float(match.confidence or 0.0), 4),
                        "alignment_mode": track.alignment_mode,
                    }
                )

        for references in payload.values():
            references.sort(key=lambda item: float(item.get("confidence") or 0.0), reverse=True)
        return payload

    def _record_batch_context_snapshot(
        self,
        job: TranslationJob,
        batch_index: int,
        batch_lines: list[SubtitleLine],
        input_context: SessionContext | None,
        output_context: SessionContext | None,
    ) -> None:
        if not batch_lines:
            return
        snapshot = BatchContextSnapshot(
            batch_index=batch_index,
            start_position=batch_lines[0].position,
            end_position=batch_lines[-1].position,
            input_context=deepcopy(input_context) if input_context else None,
            output_context=deepcopy(output_context) if output_context else None,
        )
        existing = {item.batch_index: item for item in job.batch_context_snapshots}
        existing[batch_index] = snapshot
        job.batch_context_snapshots = [existing[index] for index in sorted(existing)]

    def _record_batch_timing(
        self,
        job: TranslationJob,
        batch_index: int,
        line_count: int,
        duration_seconds: float,
    ) -> None:
        duration = max(0.001, float(duration_seconds or 0.0))
        sample = BatchTimingSample(
            batch_index=batch_index,
            line_count=max(0, int(line_count or 0)),
            duration_seconds=round(duration, 3),
            lines_per_second=round(max(0.0, float(line_count or 0) / duration), 6),
        )
        existing = {item.batch_index: item for item in job.batch_timing_samples}
        existing[batch_index] = sample
        job.batch_timing_samples = [existing[index] for index in sorted(existing)][-40:]
        self._refresh_job_eta(job)

    def _refresh_job_eta(self, job: TranslationJob) -> None:
        if job.status in {JobStatus.COMPLETED, JobStatus.CANCELLED, JobStatus.FAILED}:
            job.eta_seconds = None
            job.estimated_completion_at = None
            return

        total_lines = len(job.original_lines)
        completed_lines = len({line.position for line in job.translated_lines})
        remaining_lines = max(0, total_lines - completed_lines)
        samples = [sample for sample in job.batch_timing_samples if sample.line_count > 0 and sample.duration_seconds > 0]
        if not remaining_lines or not samples:
            job.eta_seconds = None
            job.estimated_completion_at = None
            return

        # Recent batches should dominate because model latency changes as context,
        # retries, and batch complexity change over a long subtitle job.
        weighted_duration_per_line = 0.0
        weight_total = 0.0
        recent_samples = samples[-8:]
        for offset, sample in enumerate(recent_samples, start=1):
            duration_per_line = sample.duration_seconds / max(1, sample.line_count)
            weight = float(offset)
            weighted_duration_per_line += duration_per_line * weight
            weight_total += weight

        if weight_total <= 0:
            job.eta_seconds = None
            job.estimated_completion_at = None
            return

        eta_seconds = max(1, int(round((weighted_duration_per_line / weight_total) * remaining_lines)))
        job.eta_seconds = eta_seconds
        job.estimated_completion_at = datetime.now(timezone.utc) + timedelta(seconds=eta_seconds)

    def _batch_lines_for_index(self, job: TranslationJob, batch_index: int) -> list[SubtitleLine]:
        if batch_index <= 0:
            return []
        batches = chunk_lines(job.original_lines, job.settings.batch_size)
        if batch_index > len(batches):
            return []
        return batches[batch_index - 1]

    def _context_for_line(self, job: TranslationJob, position: int) -> SessionContext | None:
        issue = None
        for candidate in job.validation_issues:
            if candidate.position == position:
                issue = candidate
                break

        if issue and issue.batch_index is not None:
            for snapshot in job.batch_context_snapshots:
                if snapshot.batch_index == issue.batch_index:
                    return deepcopy(snapshot.input_context or snapshot.output_context)

        for snapshot in job.batch_context_snapshots:
            if snapshot.start_position <= position <= snapshot.end_position:
                return deepcopy(snapshot.input_context or snapshot.output_context)

        return deepcopy(job.session_context) if job.session_context else None

    def _update_validation_issue(
        self,
        job: TranslationJob,
        position: int,
        status: str,
        translated_text: str,
        notes: list[str],
        reason_codes: list[str] | None = None,
        batch_index: int | None = None,
    ) -> SubtitleValidationIssue:
        issue = None
        for candidate in job.validation_issues:
            if candidate.position == position:
                issue = candidate
                break
        if issue is None:
            source_line = self._line_by_position(job.original_lines, position)
            issue = SubtitleValidationIssue(
                position=position,
                source_text=source_line.text if source_line else "",
                translated_text=translated_text,
                batch_index=batch_index,
            )
            job.validation_issues.append(issue)
            job.validation_issues.sort(key=lambda item: item.position)

        previous_status = issue.status
        if previous_status == "suspect" and job.validation_stats.suspicious_subtitles > 0:
            job.validation_stats.suspicious_subtitles -= 1
        if previous_status == "error" and job.validation_stats.error_subtitles > 0:
            job.validation_stats.error_subtitles -= 1
        if previous_status == "auto_fixed" and job.validation_stats.auto_fixed_subtitles > 0:
            job.validation_stats.auto_fixed_subtitles -= 1
        if previous_status == "manual_fixed" and job.validation_stats.manual_fixed_subtitles > 0:
            job.validation_stats.manual_fixed_subtitles -= 1

        issue.status = status
        issue.translated_text = translated_text
        issue.reason_codes = list(reason_codes or [])
        issue.notes = self._notes_with_previous_context(issue, status, notes)
        issue.batch_index = batch_index

        if status == "suspect":
            job.validation_stats.suspicious_subtitles += 1
        elif status == "error":
            job.validation_stats.error_subtitles += 1
        elif status == "auto_fixed":
            job.validation_stats.auto_fixed_subtitles += 1
        elif status == "manual_fixed":
            job.validation_stats.manual_fixed_subtitles += 1

        return issue

    def _refresh_translated_srt(self, job: TranslationJob) -> None:
        subtitles, _ = parse_srt_text(job.original_srt)
        job.translated_srt = compose_translated_srt(subtitles, job.translated_lines)

    def update_batch_context_snapshot(
        self,
        job_id: str,
        batch_index: int,
        context: SessionContext,
    ) -> TranslationJob | None:
        job = self.jobs.get(job_id)
        if not job:
            return None

        target = None
        for snapshot in job.batch_context_snapshots:
            if snapshot.batch_index == batch_index:
                target = snapshot
                break
        if target is None:
            batch_lines = self._batch_lines_for_index(job, batch_index)
            if not batch_lines:
                return None
            target = BatchContextSnapshot(
                batch_index=batch_index,
                start_position=batch_lines[0].position,
                end_position=batch_lines[-1].position,
            )
            job.batch_context_snapshots.append(target)
            job.batch_context_snapshots.sort(key=lambda item: item.batch_index)

        target.input_context = deepcopy(context)
        job.message = f"Batch {batch_index} snapshot updated"
        self._append_log(job, "info", f"Updated saved context snapshot for batch {batch_index}", batch_index=batch_index, save=False)
        self._save_state()
        return job

    async def generate_job_context(self, job_id: str) -> SessionContext | None:
        job = self.jobs.get(job_id)
        if not job:
            return None
        generated = await self.translator.generate_context_from_full_subtitle(
            job.settings,
            job.original_lines,
            base_context=job.session_context,
        )
        return generated

    async def generate_batch_context_snapshot(self, job_id: str, batch_index: int) -> SessionContext | None:
        job = self.jobs.get(job_id)
        if not job:
            return None
        target = None
        for snapshot in job.batch_context_snapshots:
            if snapshot.batch_index == batch_index:
                target = snapshot
                break
        batch_lines = self._batch_lines_for_index(job, batch_index)
        if not batch_lines:
            return None
        generated = await self.translator.generate_context_from_lines(
            job.settings,
            batch_lines,
            base_context=(target.input_context if target else None) or job.session_context,
            scope_label=f"batch {batch_index}",
            max_lines=len(batch_lines) or 120,
        )
        return generated

    def update_translated_line(
        self,
        job_id: str,
        position: int,
        text: str,
        resolution_mode: str = "save",
    ) -> TranslationJob | None:
        job = self.jobs.get(job_id)
        if not job:
            return None

        target = self._line_by_position(job.translated_lines, position)
        if target is None:
            source_line = self._line_by_position(job.original_lines, position)
            if source_line is None:
                return None
            target = SubtitleLine(position=position, text="")
            job.translated_lines.append(target)
            job.translated_lines.sort(key=lambda item: item.position)

        target.text = text
        self._refresh_translated_srt(job)
        if resolution_mode == "resolve":
            notes = ["Confirmed as correct from the review panel."]
            reason_codes = ["manual_fix"]
        elif resolution_mode == "remove":
            notes = ["Subtitle removed from the review panel."]
            reason_codes = ["manual_fix", "missing_output"]
        else:
            notes = ["Manually updated from the review panel."]
            reason_codes = ["manual_fix"]
        self._update_validation_issue(
            job,
            position,
            "manual_fixed",
            text,
            notes,
            reason_codes=reason_codes,
        )

        if resolution_mode == "resolve":
            log_message = f"Line {position + 1} marked resolved from review panel"
            job.message = f"Line {position + 1} marked resolved"
        elif resolution_mode == "remove":
            log_message = f"Line {position + 1} removed from review panel"
            job.message = f"Line {position + 1} removed"
        else:
            log_message = f"Line {position + 1} manually updated from review panel"
            job.message = f"Line {position + 1} updated"
        self._append_log(job, "info", log_message, save=False)
        self._save_state()
        return job

    async def request_line_retranslation(
        self,
        job_id: str,
        position: int,
        extra_instruction: str = "",
    ) -> tuple[TranslationJob, bool] | None:
        job = self.jobs.get(job_id)
        if not job:
            return None
        source_line = self._line_by_position(job.original_lines, position)
        if source_line is None:
            return None
        target = self._line_by_position(job.translated_lines, position)
        if target is None:
            target = SubtitleLine(position=position, text="")
            job.translated_lines.append(target)
            job.translated_lines.sort(key=lambda item: item.position)

        normalized_instruction = extra_instruction.strip()
        if job.status in {JobStatus.PROCESSING, JobStatus.QUEUED}:
            replaced = False
            for request in job.pending_retranslations:
                if request.position == position:
                    request.extra_instruction = normalized_instruction
                    replaced = True
                    break
            if not replaced:
                job.pending_retranslations.append(
                    QueuedLineRetranslation(position=position, extra_instruction=normalized_instruction)
                )
            self._append_log(
                job,
                "info",
                f"Queued retranslation for line {position + 1}"
                + (" with extra instruction" if normalized_instruction else ""),
                save=False,
            )
            job.message = f"Queued retranslation for line {position + 1}"
            self._save_state()
            return job, True

        await self._run_line_retranslation(job, position, normalized_instruction, trigger="manual")
        self._save_state()
        return job, False

    async def _run_line_retranslation(
        self,
        job: TranslationJob,
        position: int,
        extra_instruction: str = "",
        trigger: str = "manual",
    ) -> None:
        source_line = self._line_by_position(job.original_lines, position)
        translated_line = self._line_by_position(job.translated_lines, position)
        if source_line is None:
            raise ValueError(f"Subtitle line {position + 1} not found")
        if translated_line is None:
            translated_line = SubtitleLine(position=position, text="")
            job.translated_lines.append(translated_line)
            job.translated_lines.sort(key=lambda item: item.position)

        self._append_log(
            job,
            "info",
            f"Running retranslation for line {position + 1}"
            + (" with extra instruction" if extra_instruction else "")
            + (f" ({trigger})" if trigger else ""),
            save=False,
        )
        revised_line, stats = await self.translator.retranslate_line(
            job.settings,
            source_line,
            translated_line,
            self._context_for_line(job, position),
            reference_subtitles=self._reference_payload_for_positions(job, [position]).get(position, []),
            extra_instruction=extra_instruction,
            log_event=lambda level, message: self._append_log(job, level, message, save=False),
        )
        translated_line.text = revised_line.text
        self._refresh_translated_srt(job)
        if stats.issues:
            for issue in stats.issues:
                self._update_validation_issue(
                    job,
                    issue.position,
                    issue.status,
                    issue.translated_text,
                    list(issue.notes),
                    reason_codes=list(issue.reason_codes),
                    batch_index=issue.batch_index,
                )
        job.validation_stats.retried_batches += 1
        if stats.issues:
            last_issue = stats.issues[-1]
            if last_issue.status == "auto_fixed":
                job.message = f"Line {position + 1} retranslated successfully"
            elif last_issue.status == "error":
                job.message = f"Line {position + 1} still looks suspicious after retranslation"
        else:
            job.message = f"Line {position + 1} retranslated"

    async def _process_pending_retranslations(self, job: TranslationJob, trigger: str) -> None:
        if not job.pending_retranslations:
            return
        queued_by_position: dict[int, QueuedLineRetranslation] = {}
        for item in job.pending_retranslations:
            queued_by_position[item.position] = item
        job.pending_retranslations = []
        self._append_log(
            job,
            "info",
            f"Processing {len(queued_by_position)} queued retranslation request(s) at {trigger}",
            save=False,
        )
        for request in queued_by_position.values():
            await self._run_line_retranslation(
                job,
                request.position,
                request.extra_instruction,
                trigger=trigger,
            )
        self._save_state()

    def delete_job(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if not job:
            return False
        if job.status in {JobStatus.PROCESSING, JobStatus.QUEUED}:
            return False
        self.tasks.pop(job_id, None)
        self.jobs.pop(job_id, None)
        self.vision.remove_job_cache(job_id)
        self._delete_job_video(job)
        self._save_state()
        return True

    def clear_finished_jobs(self) -> int:
        removable_statuses = {JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED}
        removable_ids = [job.id for job in self.jobs.values() if job.status in removable_statuses]
        for job_id in removable_ids:
            job = self.jobs[job_id]
            self.tasks.pop(job_id, None)
            self.jobs.pop(job_id, None)
            self.vision.remove_job_cache(job_id)
            self._delete_job_video(job)
        if removable_ids:
            self._save_state()
        return len(removable_ids)

    def create_job(
        self,
        filename: str,
        title: str,
        original_srt: str,
        settings,
        reference_sources: list[dict[str, str]] | None = None,
        video_filename: str = "",
        video_path: str = "",
    ) -> TranslationJob:
        duplicate = next(
            (
                job
                for job in self.jobs.values()
                if job.job_kind == "translation"
                and job.status in {JobStatus.QUEUED, JobStatus.PROCESSING}
                and job.original_srt == original_srt
                and job.settings.source_language == settings.source_language
                and job.settings.target_language == settings.target_language
                and job.settings.model == settings.model
                and job.settings.base_url.rstrip("/") == settings.base_url.rstrip("/")
            ),
            None,
        )
        if duplicate is not None:
            raise DuplicateActiveJobError(duplicate)

        _, lines = parse_srt_text(original_srt)
        reference_tracks = self._build_reference_tracks(lines, reference_sources)
        reference_uploads = self._build_reference_uploads(reference_sources)
        job = TranslationJob(
            filename=filename,
            source_filename=filename,
            title=title or filename.rsplit(".", 1)[0],
            settings=settings,
            original_srt=original_srt,
            original_lines=lines,
            reference_tracks=reference_tracks,
            reference_uploads=reference_uploads,
            video_filename=video_filename,
            video_path=video_path,
        )
        self._append_log(job, "info", f"Job created for {filename}", save=False)
        if reference_tracks:
            self._append_log(job, "info", f"Loaded {len(reference_tracks)} reference subtitle track(s)", save=False)
            for track in reference_tracks:
                self._append_log(
                    job,
                    "info",
                    (
                        f"Reference {track.language} ({track.filename}) aligned "
                        f"{track.matched_lines}/{len(lines)} primary lines "
                        f"with average confidence {track.average_confidence:.2f} via {track.alignment_mode}"
                    ),
                    save=False,
                )
        if video_path:
            modes = []
            if settings.visual_scene_context:
                modes.append("visual scene context")
            if settings.adaptive_vision:
                modes.append("adaptive clarification")
            self._append_log(
                job,
                "info",
                f"Vision video loaded for {', '.join(modes)}: {video_filename}",
                save=False,
            )
        self.jobs[job.id] = job
        self._save_state()
        self._start_task(job.id)
        return job

    def create_review_job(
        self,
        source_filename: str,
        translated_filename: str,
        title: str,
        source_srt: str,
        translated_srt: str,
        settings,
        reference_sources: list[dict[str, str]] | None = None,
    ) -> TranslationJob:
        _, source_lines = parse_srt_text(source_srt)
        _, translated_lines = parse_srt_text(translated_srt)
        translated_lines = strip_ai_disclosure_line(translated_lines)
        reference_tracks = self._build_reference_tracks(source_lines, reference_sources)
        reference_uploads = self._build_reference_uploads(reference_sources)
        job = TranslationJob(
            filename=translated_filename,
            source_filename=source_filename,
            title=title or translated_filename.rsplit(".", 1)[0],
            job_kind="review",
            settings=settings,
            original_srt=source_srt,
            original_lines=source_lines,
            translated_srt=translated_srt,
            translated_lines=translated_lines,
            reference_tracks=reference_tracks,
            reference_uploads=reference_uploads,
        )
        self._append_log(
            job,
            "info",
            f"Validation review created for {translated_filename} against source {source_filename}",
            save=False,
        )
        if reference_tracks:
            self._append_log(job, "info", f"Loaded {len(reference_tracks)} reference subtitle track(s)", save=False)
            for track in reference_tracks:
                self._append_log(
                    job,
                    "info",
                    (
                        f"Reference {track.language} ({track.filename}) aligned "
                        f"{track.matched_lines}/{len(source_lines)} primary lines "
                        f"with average confidence {track.average_confidence:.2f} via {track.alignment_mode}"
                    ),
                    save=False,
                )
        self.jobs[job.id] = job
        self._save_state()
        self._start_task(job.id)
        return job

    def _start_task(self, job_id: str) -> None:
        task = asyncio.create_task(self._run_job(job_id), name=f"ai-subcontext-{job_id}")
        self.tasks[job_id] = task
        job = self.jobs[job_id]
        job.task_name = task.get_name()
        self._save_state()

    def request_pause(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if not job:
            return False
        if job.status == JobStatus.PROCESSING:
            job.pause_requested = True
            job.message = "Pause requested; waiting for current batch to finish"
            self._append_log(job, "info", "Pause requested; waiting for current batch to finish", save=False)
            self._save_state()
            return True
        if job.status == JobStatus.QUEUED:
            job.status = JobStatus.PAUSED
            job.message = "Paused before processing"
            self._append_log(job, "info", "Paused before processing", save=False)
            self._save_state()
            return True
        return job.status == JobStatus.PAUSED

    def request_stop(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if not job:
            return False
        if job.status in {JobStatus.PROCESSING, JobStatus.PAUSED, JobStatus.QUEUED}:
            if job.status == JobStatus.PAUSED:
                job.status = JobStatus.CANCELLED
                job.completed_at = datetime.now(timezone.utc)
                job.eta_seconds = None
                job.estimated_completion_at = None
                job.message = "Job stopped by user"
                self._append_log(job, "warn", "Job stopped by user", save=False)
            else:
                job.stop_requested = True
                job.pause_requested = False
                job.message = "Stop requested; cancelling active request"
                self._append_log(job, "warn", "Stop requested; cancelling active request", save=False)
                task = self.tasks.get(job_id)
                if task and not task.done():
                    task.cancel()
            self._save_state()
            return True
        return False

    def resume(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if not job or job.status not in {JobStatus.PAUSED, JobStatus.FAILED}:
            return False
        if job.job_kind == "review":
            return False
        was_failed = job.status == JobStatus.FAILED
        job.status = JobStatus.QUEUED
        job.pause_requested = False
        job.stop_requested = False
        job.completed_at = None
        job.error = None
        if was_failed:
            job.message = f"Queued to resume from batch {job.current_batch + 1}"
            self._append_log(
                job,
                "info",
                f"Failed job resumed from batch {job.current_batch + 1}",
                save=False,
            )
        else:
            job.message = "Queued to resume translation"
            self._append_log(job, "info", "Job resumed", save=False)
        self._start_task(job_id)
        self._save_state()
        return True

    def update_runtime_settings(self, job_id: str, values: dict[str, object]) -> bool:
        job = self.jobs.get(job_id)
        if not job or job.status not in {JobStatus.PAUSED, JobStatus.FAILED}:
            return False

        allowed_fields = {
            "max_completion_tokens",
            "request_timeout_seconds",
            "prompt_translation_system",
            "prompt_translation_strict_retry",
            "prompt_initial_context_system",
            "prompt_full_context_refresh_system",
            "prompt_batch_context_refresh_system",
            "prompt_line_revision_system",
        }
        changed: list[str] = []
        for field_name in allowed_fields:
            if field_name not in values:
                continue
            previous = getattr(job.settings, field_name, None)
            try:
                setattr(job.settings, field_name, values[field_name])
            except Exception:
                continue
            if getattr(job.settings, field_name, None) != previous:
                changed.append(field_name)

        if changed:
            self._append_log(
                job,
                "info",
                "Updated runtime settings before resume: " + ", ".join(sorted(changed)),
                save=False,
            )
            self._save_state()
        return True

    def update_context(self, job_id: str, context: SessionContext, target_language_tips: str | None = None) -> bool:
        job = self.jobs.get(job_id)
        if not job or job.job_kind == "review":
            return False
        if job.status not in {
            JobStatus.QUEUED,
            JobStatus.PROCESSING,
            JobStatus.PAUSED,
            JobStatus.COMPLETED,
            JobStatus.FAILED,
            JobStatus.CANCELLED,
        }:
            return False
        self._record_context(job, context)
        if target_language_tips is not None:
            job.settings.target_language_tips = str(target_language_tips or "").strip()
        if job.status in {JobStatus.QUEUED, JobStatus.PROCESSING, JobStatus.PAUSED}:
            job.message = "Context updated; next batch will use the edited card"
        else:
            job.message = "Context updated; future line retranslations will use the edited card"
        self._append_log(job, "info", "Context updated from UI", save=False)
        self._save_state()
        return True

    def _record_context(self, job: TranslationJob, context: SessionContext) -> None:
        snapshot = context.model_dump()
        if job.session_context and job.session_context.model_dump() != snapshot:
            job.session_context_history = [snapshot] + job.session_context_history[:1]
        elif not job.session_context:
            job.session_context_history = [snapshot] + job.session_context_history[:1]
        job.session_context = context
        self._save_state()

    async def _run_job(self, job_id: str) -> None:
        job = self.jobs[job_id]
        try:
            if job.status == JobStatus.PAUSED:
                return
            if job.job_kind == "review":
                await self._run_review_job(job)
                return
            job.status = JobStatus.PROCESSING
            if job.started_at is None:
                job.started_at = datetime.now(timezone.utc)
            self._append_log(job, "info", "Translation started", save=False)
            subtitles, _ = parse_srt_text(job.original_srt)
            batches = chunk_lines(job.original_lines, job.settings.batch_size)
            job.total_batches = len(batches)
            self._refresh_job_eta(job)

            if job.settings.structured_context and job.session_context is None:
                self._append_log(job, "info", "Building initial context card", save=False)
                initial_context = await self.translator.build_initial_context(job.settings, job.original_lines)
                self._record_context(job, initial_context)
                self._append_log(job, "info", "Initial context card ready", save=False)
                self._save_state()

            if (
                job.settings.visual_scene_context
                and job.video_path
            ):
                await self._build_visual_scene_contexts(job)
                if job.pause_requested:
                    job.pause_requested = False
                    job.status = JobStatus.PAUSED
                    job.estimated_completion_at = None
                    job.message = "Paused after visual scene guide"
                    self._append_log(
                        job,
                        "info",
                        "Paused after visual scene guide",
                        save=False,
                    )
                    self._save_state()
                    return

            translated_by_position = {line.position: line for line in job.translated_lines}

            for batch_index in range(job.current_batch, len(batches)):
                if job.stop_requested:
                    job.status = JobStatus.CANCELLED
                    job.completed_at = datetime.now(timezone.utc)
                    job.eta_seconds = None
                    job.estimated_completion_at = None
                    job.message = "Job stopped by user"
                    self._append_log(job, "warn", "Job stopped before next batch started", save=False)
                    return

                current_context = deepcopy(job.session_context) if job.session_context else None
                batch_started = time.monotonic()
                self._append_log(
                    job,
                    "info",
                    f"Starting batch {batch_index + 1}/{len(batches)} with {len(batches[batch_index])} subtitle lines",
                    batch_index=batch_index + 1,
                    save=False,
                )
                batch_positions = [line.position for line in batches[batch_index]]
                translated_batch, updated_context, batch_stats = await self.translator.translate_batch(
                    job.settings,
                    batches[batch_index],
                    current_context,
                    reference_subtitles_by_position=self._reference_payload_for_positions(job, batch_positions),
                    visual_scene_contexts=self._visual_contexts_for_lines(
                        job,
                        batches[batch_index],
                    ),
                    batch_index=batch_index + 1,
                    should_stop=lambda active_job=job: bool(active_job.stop_requested),
                    log_event=lambda level, message, batch_no=batch_index + 1: self._append_log(
                        job,
                        level,
                        message,
                        batch_index=batch_no,
                    ),
                )
                if job.settings.adaptive_vision and job.video_path:
                    translated_batch = await self._apply_adaptive_vision(
                        job,
                        batch_index + 1,
                        batches[batch_index],
                        translated_batch,
                        updated_context,
                        batch_stats,
                    )
                self._apply_validation_stats(job, batch_stats)
                for item in translated_batch:
                    translated_by_position[item.position] = item
                job.translated_lines = [translated_by_position[index] for index in sorted(translated_by_position)]
                self._record_batch_context_snapshot(
                    job,
                    batch_index + 1,
                    batches[batch_index],
                    current_context,
                    updated_context,
                )
                if updated_context is not None:
                    self._record_context(job, updated_context)

                job.current_batch = batch_index + 1
                job.progress = int((job.current_batch / len(batches)) * 100)
                self._record_batch_timing(
                    job,
                    job.current_batch,
                    len(batches[batch_index]),
                    time.monotonic() - batch_started,
                )
                job.message = f"Processed batch {job.current_batch}/{len(batches)}"
                self._append_log(
                    job,
                    "info",
                    (
                        f"Finished batch {job.current_batch}/{len(batches)}"
                        + (f"; ETA {job.eta_seconds}s" if job.eta_seconds else "")
                    ),
                    batch_index=job.current_batch,
                    save=False,
                )
                self._save_state()

                if job.pause_requested:
                    await self._process_pending_retranslations(job, "pause boundary")
                    job.pause_requested = False
                    job.status = JobStatus.PAUSED
                    job.estimated_completion_at = None
                    job.message = "Paused after current batch"
                    self._append_log(job, "info", "Paused after current batch", batch_index=job.current_batch, save=False)
                    self._save_state()
                    return

                if job.stop_requested:
                    job.status = JobStatus.CANCELLED
                    job.completed_at = datetime.now(timezone.utc)
                    job.eta_seconds = None
                    job.estimated_completion_at = None
                    job.message = "Job stopped by user"
                    self._append_log(job, "warn", "Job stopped after current batch", batch_index=job.current_batch, save=False)
                    self._save_state()
                    return

            await self._process_pending_retranslations(job, "job end")
            job.translated_srt = compose_translated_srt(subtitles, job.translated_lines)
            job.status = JobStatus.COMPLETED
            job.progress = 100
            job.eta_seconds = None
            job.estimated_completion_at = None
            job.completed_at = datetime.now(timezone.utc)
            job.message = "Translation completed"
            self._append_log(job, "info", "Translation completed", save=False)
            self._save_state()
        except (asyncio.CancelledError, TranslationStopRequested):
            if job.stop_requested:
                job.status = JobStatus.CANCELLED
                job.completed_at = datetime.now(timezone.utc)
                job.eta_seconds = None
                job.estimated_completion_at = None
                job.message = "Job stopped by user"
                self._append_log(job, "warn", "Job stopped by user", batch_index=job.current_batch or None, save=False)
                self._save_state()
                return
            raise
        except Exception as exc:
            error_text = str(exc).strip() or exc.__class__.__name__
            job.status = JobStatus.FAILED
            job.error = error_text
            job.completed_at = datetime.now(timezone.utc)
            job.eta_seconds = None
            job.estimated_completion_at = None
            job.message = f"Translation failed: {error_text}"
            self._append_log(job, "error", f"Translation failed: {error_text}", save=False)
            self._save_state()
        finally:
            self.tasks.pop(job_id, None)

    async def _run_review_job(self, job: TranslationJob) -> None:
        job.status = JobStatus.PROCESSING
        if job.started_at is None:
            job.started_at = datetime.now(timezone.utc)
        self._append_log(job, "info", "Validation review started", save=False)
        self._save_state()

        issues, stats = await self.translator.validate_existing_translation(
            job.settings,
            job.original_lines,
            job.translated_lines,
            log_event=lambda level, message: self._append_log(job, level, message),
        )
        job.validation_issues = issues
        job.validation_stats = stats
        job.progress = 100
        job.status = JobStatus.COMPLETED
        job.completed_at = datetime.now(timezone.utc)
        if issues:
            job.message = f"Validation found {len(issues)} suspect subtitle(s)"
        else:
            job.message = "Validation found no obvious untranslated subtitle lines"
        self._append_log(job, "info", job.message, save=False)
        self._save_state()


job_manager = JobManager()
