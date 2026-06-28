from __future__ import annotations

import asyncio
import base64
import os
import shutil
from dataclasses import dataclass
from pathlib import Path

from app.models import SubtitleLine, VisualDoubt
from app.srt_utils import timestamp_to_milliseconds


ALLOWED_VISUAL_DOUBT_CATEGORIES = {
    "speaker_gender",
    "speaker_identity",
    "object_identity",
    "visible_action",
    "location_context",
    "on_screen_text",
}
ALLOWED_TIMESTAMP_HINTS = {"start", "middle", "end"}
VAGUE_VISUAL_QUESTIONS = {
    "how should i translate",
    "how do i translate",
    "need more context",
    "need visual context",
    "i am unsure",
    "i'm unsure",
}


@dataclass
class ExtractedVisualFrame:
    id: str
    path: Path
    timestamp_ms: int
    related_positions: list[int]

    def as_data_url(self) -> str:
        encoded = base64.b64encode(self.path.read_bytes()).decode("ascii")
        return f"data:image/jpeg;base64,{encoded}"


@dataclass
class VisualSceneWindow:
    scene_index: int
    lines: list[SubtitleLine]
    start_ms: int
    end_ms: int


def build_visual_scene_windows(
    lines: list[SubtitleLine],
    gap_threshold_ms: int = 15000,
    max_lines: int = 80,
    max_duration_ms: int = 240000,
) -> list[VisualSceneWindow]:
    windows: list[VisualSceneWindow] = []
    current: list[SubtitleLine] = []
    current_start = 0
    previous_end = 0

    def flush() -> None:
        if not current:
            return
        windows.append(
            VisualSceneWindow(
                scene_index=len(windows) + 1,
                lines=list(current),
                start_ms=current_start,
                end_ms=max(current_start, timestamp_to_milliseconds(current[-1].end_time)),
            )
        )

    for line in lines:
        start_ms = timestamp_to_milliseconds(line.start_time)
        end_ms = max(start_ms, timestamp_to_milliseconds(line.end_time))
        starts_new_scene = bool(
            current
            and (
                start_ms - previous_end >= gap_threshold_ms
                or len(current) >= max_lines
                or end_ms - current_start >= max_duration_ms
            )
        )
        if starts_new_scene:
            flush()
            current.clear()
        if not current:
            current_start = start_ms
        current.append(line)
        previous_end = end_ms
    flush()

    merged: list[VisualSceneWindow] = []
    for window in windows:
        duration_ms = window.end_ms - window.start_ms
        if (
            merged
            and (len(window.lines) < 4 or duration_ms < 10000)
            and len(merged[-1].lines) + len(window.lines) <= max_lines
            and window.end_ms - merged[-1].start_ms <= max_duration_ms
        ):
            previous = merged[-1]
            previous.lines.extend(window.lines)
            previous.end_ms = window.end_ms
            continue
        merged.append(window)
    for index, window in enumerate(merged, start=1):
        window.scene_index = index
    return merged


def validate_visual_doubts(
    doubts: list[VisualDoubt],
    batch_lines: list[SubtitleLine],
    max_doubts: int,
    translated_lines: list[SubtitleLine] | None = None,
) -> tuple[list[VisualDoubt], list[VisualDoubt]]:
    valid_positions = {line.position for line in batch_lines}
    translated_by_position = {
        line.position: " ".join(line.text.split()).strip().casefold()
        for line in (translated_lines or [])
    }
    approved: list[VisualDoubt] = []
    rejected: list[VisualDoubt] = []
    seen_positions: set[int] = set()

    for doubt in doubts:
        question = " ".join(str(doubt.question or "").split()).strip()
        lowered_question = question.casefold()
        category = str(doubt.category or "").strip()
        hint = str(doubt.timestamp_hint or "middle").strip().lower()
        valid = (
            doubt.position in valid_positions
            and doubt.position not in seen_positions
            and category in ALLOWED_VISUAL_DOUBT_CATEGORIES
            and hint in ALLOWED_TIMESTAMP_HINTS
            and 12 <= len(question) <= 220
            and bool(doubt.current_translation.strip())
            and (
                not translated_by_position
                or translated_by_position.get(doubt.position)
                == " ".join(doubt.current_translation.split()).strip().casefold()
            )
            and bool(doubt.alternative_translation.strip())
            and doubt.current_translation.strip().casefold()
            != doubt.alternative_translation.strip().casefold()
            and 12 <= len(doubt.translation_impact.strip()) <= 220
            and not any(phrase in lowered_question for phrase in VAGUE_VISUAL_QUESTIONS)
        )
        if not valid or len(approved) >= max_doubts:
            rejected.append(doubt)
            continue
        doubt.question = question
        doubt.timestamp_hint = hint
        approved.append(doubt)
        seen_positions.add(doubt.position)

    return approved, rejected


class VideoFrameProvider:
    def __init__(self, cache_root: Path) -> None:
        self.cache_root = cache_root

    def available(self) -> bool:
        return shutil.which("ffmpeg") is not None

    async def extract_for_doubts(
        self,
        job_id: str,
        video_path: str,
        batch_index: int,
        batch_lines: list[SubtitleLine],
        doubts: list[VisualDoubt],
        max_frames: int,
        max_side: int,
    ) -> list[ExtractedVisualFrame]:
        if not self.available():
            raise RuntimeError("FFmpeg is not installed or not available on PATH")

        video = Path(video_path)
        if not video.is_file():
            raise RuntimeError("The uploaded video file is no longer available")

        line_by_position = {line.position: line for line in batch_lines}
        candidates: list[tuple[int, int]] = []
        frames_per_doubt = max(1, max_frames // max(1, len(doubts)))
        for doubt in doubts:
            line = line_by_position.get(doubt.position)
            if line is None:
                continue
            start_ms = timestamp_to_milliseconds(line.start_time)
            end_ms = max(start_ms, timestamp_to_milliseconds(line.end_time))
            duration_ms = end_ms - start_ms
            midpoint_ms = start_ms + (duration_ms // 2)
            sequence = [
                max(0, start_ms - 1500),
                start_ms + min(200, duration_ms // 4),
                midpoint_ms,
                end_ms + 1500,
            ]
            if doubt.timestamp_hint == "start":
                sequence = [sequence[0], sequence[1], sequence[2], sequence[3]]
            elif doubt.timestamp_hint == "end":
                sequence = [sequence[3], sequence[2], sequence[1], sequence[0]]
            selected_indexes = (
                [len(sequence) // 2]
                if frames_per_doubt == 1
                else sorted(
                    {
                        round(index * (len(sequence) - 1) / (frames_per_doubt - 1))
                        for index in range(frames_per_doubt)
                    }
                )
            )
            candidates.extend((sequence[index], doubt.position) for index in selected_indexes)

        grouped: list[tuple[int, list[int]]] = []
        for timestamp_ms, position in sorted(candidates):
            if grouped and abs(timestamp_ms - grouped[-1][0]) <= 400:
                if position not in grouped[-1][1]:
                    grouped[-1][1].append(position)
                continue
            grouped.append((timestamp_ms, [position]))

        if len(grouped) > max_frames:
            indexes = {
                round(index * (len(grouped) - 1) / (max_frames - 1))
                for index in range(max_frames)
            }
            grouped = [grouped[index] for index in sorted(indexes)]

        return await self._extract_candidates(
            job_id,
            video,
            batch_index,
            grouped,
            max_side,
        )

    async def extract_for_scene(
        self,
        job_id: str,
        video_path: str,
        scene: VisualSceneWindow,
        frame_count: int,
        max_side: int,
    ) -> list[ExtractedVisualFrame]:
        if not self.available():
            raise RuntimeError("FFmpeg is not installed or not available on PATH")
        video = Path(video_path)
        if not video.is_file():
            raise RuntimeError("The uploaded video file is no longer available")

        anchor_indexes = sorted(
            {
                round(index * (len(scene.lines) - 1) / max(1, frame_count - 1))
                for index in range(frame_count)
            }
        )
        timestamps = []
        for index in anchor_indexes:
            line = scene.lines[index]
            start_ms = timestamp_to_milliseconds(line.start_time)
            end_ms = max(start_ms, timestamp_to_milliseconds(line.end_time))
            timestamps.append(start_ms + ((end_ms - start_ms) // 2))
        related_positions = [line.position for line in scene.lines]
        candidates = [(timestamp_ms, related_positions) for timestamp_ms in timestamps]
        return await self._extract_candidates(
            job_id,
            video,
            -scene.scene_index,
            candidates,
            max_side,
        )

    async def _extract_candidates(
        self,
        job_id: str,
        video: Path,
        batch_index: int,
        candidates: list[tuple[int, list[int]]],
        max_side: int,
    ) -> list[ExtractedVisualFrame]:
        cache_dir = self.cache_root / job_id
        cache_dir.mkdir(parents=True, exist_ok=True)
        frames: list[ExtractedVisualFrame] = []
        for timestamp_ms, positions in candidates:
            frame_id = f"b{batch_index}-t{timestamp_ms}"
            output_path = self.frame_path(job_id, batch_index, timestamp_ms)
            if not output_path.is_file() or output_path.stat().st_size == 0:
                await self._extract_frame(video, output_path, timestamp_ms, max_side)
            frames.append(
                ExtractedVisualFrame(
                    id=frame_id,
                    path=output_path,
                    timestamp_ms=timestamp_ms,
                    related_positions=positions,
                )
            )
        return frames

    def frame_path(self, job_id: str, batch_index: int, timestamp_ms: int) -> Path:
        return self.cache_root / job_id / f"batch-{batch_index}-{timestamp_ms}.jpg"

    def clone_scene_cache(self, source_job_id: str, target_job_id: str) -> int:
        source_dir = self.cache_root / source_job_id
        if not source_dir.is_dir():
            return 0
        target_dir = self.cache_root / target_job_id
        copied = 0
        for source in source_dir.glob("batch--*.jpg"):
            if not source.is_file() or source.stat().st_size == 0:
                continue
            target_dir.mkdir(parents=True, exist_ok=True)
            target = target_dir / source.name
            try:
                os.link(source, target)
            except OSError:
                shutil.copy2(source, target)
            copied += 1
        return copied

    async def _extract_frame(
        self,
        video_path: Path,
        output_path: Path,
        timestamp_ms: int,
        max_side: int,
    ) -> None:
        timestamp_seconds = max(0, timestamp_ms) / 1000
        scale_filter = (
            f"scale='if(gt(iw,ih),min(iw,{max_side}),-2)':"
            f"'if(gt(iw,ih),-2,min(ih,{max_side}))'"
        )
        process = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            f"{timestamp_seconds:.3f}",
            "-i",
            str(video_path),
            "-frames:v",
            "1",
            "-vf",
            scale_filter,
            "-q:v",
            "6",
            "-y",
            str(output_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await process.communicate()
        if process.returncode != 0 or not output_path.is_file() or output_path.stat().st_size == 0:
            message = stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(message or "FFmpeg could not extract the requested video frame")

    def remove_job_cache(self, job_id: str) -> None:
        shutil.rmtree(self.cache_root / job_id, ignore_errors=True)
