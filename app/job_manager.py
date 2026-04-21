from __future__ import annotations

import asyncio
import json
import os
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile

from app.models import (
    BatchContextSnapshot,
    JobLogEntry,
    JobStatus,
    QueuedLineRetranslation,
    SessionContext,
    SubtitleLine,
    SubtitleValidationIssue,
    TranslationJob,
)
from app.srt_utils import chunk_lines, compose_translated_srt, parse_srt_text
from app.translator import OpenAICompatibleTranslator


class JobManager:
    def __init__(self) -> None:
        self.jobs: dict[str, TranslationJob] = {}
        self.tasks: dict[str, asyncio.Task] = {}
        self.translator = OpenAICompatibleTranslator()
        self.state_file = self._default_state_file()
        self._load_state()

    def _default_state_file(self) -> Path:
        project_root = Path(__file__).resolve().parent.parent
        data_dir = project_root / "data"
        data_dir.mkdir(parents=True, exist_ok=True)
        return data_dir / "jobs.json"

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

    def _merge_validation_issues(self, job: TranslationJob, issues) -> None:
        if not issues:
            return
        existing = {issue.position: issue for issue in job.validation_issues}
        for issue in issues:
            existing[issue.position] = issue
        job.validation_issues = [existing[position] for position in sorted(existing)]

    def _line_by_position(self, lines: list[SubtitleLine], position: int) -> SubtitleLine | None:
        for line in lines:
            if line.position == position:
                return line
        return None

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
        issue.notes = notes
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
        generated = await self.translator.generate_context_from_lines(
            job.settings,
            job.original_lines,
            base_context=job.session_context,
            scope_label="full subtitle file",
            max_lines=300,
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
        elif resolution_mode == "remove":
            notes = ["Subtitle removed from the review panel."]
        else:
            notes = ["Manually updated from the review panel."]
        self._update_validation_issue(
            job,
            position,
            "manual_fixed",
            text,
            notes,
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
                    issue.batch_index,
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
        self._save_state()
        return True

    def clear_finished_jobs(self) -> int:
        removable_statuses = {JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED}
        removable_ids = [job.id for job in self.jobs.values() if job.status in removable_statuses]
        for job_id in removable_ids:
            self.tasks.pop(job_id, None)
            self.jobs.pop(job_id, None)
        if removable_ids:
            self._save_state()
        return len(removable_ids)

    def create_job(
        self,
        filename: str,
        title: str,
        original_srt: str,
        settings,
    ) -> TranslationJob:
        _, lines = parse_srt_text(original_srt)
        job = TranslationJob(
            filename=filename,
            title=title or filename.rsplit(".", 1)[0],
            settings=settings,
            original_srt=original_srt,
            original_lines=lines,
        )
        self._append_log(job, "info", f"Job created for {filename}", save=False)
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
    ) -> TranslationJob:
        _, source_lines = parse_srt_text(source_srt)
        _, translated_lines = parse_srt_text(translated_srt)
        job = TranslationJob(
            filename=translated_filename,
            title=title or translated_filename.rsplit(".", 1)[0],
            job_kind="review",
            settings=settings,
            original_srt=source_srt,
            original_lines=source_lines,
            translated_srt=translated_srt,
            translated_lines=translated_lines,
        )
        self._append_log(
            job,
            "info",
            f"Validation review created for {translated_filename} against source {source_filename}",
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
                job.message = "Job stopped by user"
                self._append_log(job, "warn", "Job stopped by user", save=False)
            else:
                job.stop_requested = True
                job.pause_requested = False
                job.message = "Stop requested; waiting for current batch to finish"
                self._append_log(job, "warn", "Stop requested; waiting for current batch to finish", save=False)
            self._save_state()
            return True
        return False

    def resume(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if not job or job.status != JobStatus.PAUSED:
            return False
        job.status = JobStatus.QUEUED
        job.pause_requested = False
        job.stop_requested = False
        job.message = "Queued to resume translation"
        self._append_log(job, "info", "Job resumed", save=False)
        self._start_task(job_id)
        self._save_state()
        return True

    def update_context(self, job_id: str, context: SessionContext) -> bool:
        job = self.jobs.get(job_id)
        if not job or job.status not in {JobStatus.PROCESSING, JobStatus.PAUSED}:
            return False
        self._record_context(job, context)
        job.message = "Context updated; next batch will use the edited card"
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

            if job.settings.structured_context and job.session_context is None:
                self._append_log(job, "info", "Building initial context card", save=False)
                initial_context = await self.translator.build_initial_context(job.settings, job.original_lines)
                self._record_context(job, initial_context)
                self._append_log(job, "info", "Initial context card ready", save=False)
                self._save_state()

            translated_by_position = {line.position: line for line in job.translated_lines}

            for batch_index in range(job.current_batch, len(batches)):
                if job.stop_requested:
                    job.status = JobStatus.CANCELLED
                    job.completed_at = datetime.now(timezone.utc)
                    job.message = "Job stopped by user"
                    self._append_log(job, "warn", "Job stopped before next batch started", save=False)
                    return

                current_context = deepcopy(job.session_context) if job.session_context else None
                self._append_log(
                    job,
                    "info",
                    f"Starting batch {batch_index + 1}/{len(batches)} with {len(batches[batch_index])} subtitle lines",
                    batch_index=batch_index + 1,
                    save=False,
                )
                translated_batch, updated_context, batch_stats = await self.translator.translate_batch(
                    job.settings,
                    batches[batch_index],
                    current_context,
                    batch_index=batch_index + 1,
                    log_event=lambda level, message, batch_no=batch_index + 1: self._append_log(
                        job,
                        level,
                        message,
                        batch_index=batch_no,
                    ),
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
                job.message = f"Processed batch {job.current_batch}/{len(batches)}"
                self._append_log(
                    job,
                    "info",
                    f"Finished batch {job.current_batch}/{len(batches)}",
                    batch_index=job.current_batch,
                    save=False,
                )
                self._save_state()

                if job.pause_requested:
                    await self._process_pending_retranslations(job, "pause boundary")
                    job.pause_requested = False
                    job.status = JobStatus.PAUSED
                    job.message = "Paused after current batch"
                    self._append_log(job, "info", "Paused after current batch", batch_index=job.current_batch, save=False)
                    self._save_state()
                    return

                if job.stop_requested:
                    job.status = JobStatus.CANCELLED
                    job.completed_at = datetime.now(timezone.utc)
                    job.message = "Job stopped by user"
                    self._append_log(job, "warn", "Job stopped after current batch", batch_index=job.current_batch, save=False)
                    self._save_state()
                    return

            await self._process_pending_retranslations(job, "job end")
            job.translated_srt = compose_translated_srt(subtitles, job.translated_lines)
            job.status = JobStatus.COMPLETED
            job.progress = 100
            job.completed_at = datetime.now(timezone.utc)
            job.message = "Translation completed"
            self._append_log(job, "info", "Translation completed", save=False)
            self._save_state()
        except Exception as exc:
            job.status = JobStatus.FAILED
            job.error = str(exc)
            job.completed_at = datetime.now(timezone.utc)
            job.message = f"Translation failed: {exc}"
            self._append_log(job, "error", f"Translation failed: {exc}", save=False)
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
