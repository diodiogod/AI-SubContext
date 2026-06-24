from __future__ import annotations

import asyncio
import base64
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


def validate_visual_doubts(
    doubts: list[VisualDoubt],
    batch_lines: list[SubtitleLine],
    max_doubts: int,
) -> tuple[list[VisualDoubt], list[VisualDoubt]]:
    valid_positions = {line.position for line in batch_lines}
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
        for doubt in doubts:
            line = line_by_position.get(doubt.position)
            if line is None:
                continue
            start_ms = timestamp_to_milliseconds(line.start_time)
            end_ms = max(start_ms, timestamp_to_milliseconds(line.end_time))
            duration_ms = end_ms - start_ms
            if doubt.timestamp_hint == "start":
                timestamp_ms = start_ms + min(250, duration_ms // 3)
            elif doubt.timestamp_hint == "end":
                timestamp_ms = max(start_ms, end_ms - min(250, duration_ms // 3))
            else:
                timestamp_ms = start_ms + (duration_ms // 2)
            candidates.append((timestamp_ms, doubt.position))

        grouped: list[tuple[int, list[int]]] = []
        for timestamp_ms, position in sorted(candidates):
            if grouped and abs(timestamp_ms - grouped[-1][0]) <= 1500:
                grouped[-1][1].append(position)
                continue
            grouped.append((timestamp_ms, [position]))

        if len(grouped) > max_frames:
            if max_frames == 1:
                grouped = [grouped[len(grouped) // 2]]
            else:
                indexes = {
                    round(index * (len(grouped) - 1) / (max_frames - 1))
                    for index in range(max_frames)
                }
                grouped = [grouped[index] for index in sorted(indexes)]

        cache_dir = self.cache_root / job_id
        cache_dir.mkdir(parents=True, exist_ok=True)
        frames: list[ExtractedVisualFrame] = []
        for timestamp_ms, positions in grouped:
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
