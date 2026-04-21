from __future__ import annotations

from datetime import timedelta
from statistics import median
from typing import Iterable

import srt

from app.models import ReferenceSubtitleMatch, ReferenceSubtitleTrack, SubtitleLine


AI_DISCLOSURE_TEXT = "# Context control translated subtitles by AI SubContext #"
AI_DISCLOSURE_DELAY_SECONDS = 60
AI_DISCLOSURE_DURATION_SECONDS = 2


def parse_srt_text(content: str) -> tuple[list[srt.Subtitle], list[SubtitleLine]]:
    subtitles = list(srt.parse(content))
    lines = [
        SubtitleLine(
            position=index,
            text=sub.content,
            start_time=srt.timedelta_to_srt_timestamp(sub.start),
            end_time=srt.timedelta_to_srt_timestamp(sub.end),
        )
        for index, sub in enumerate(subtitles)
    ]
    return subtitles, lines


def chunk_lines(lines: list[SubtitleLine], batch_size: int) -> list[list[SubtitleLine]]:
    return [lines[index:index + batch_size] for index in range(0, len(lines), batch_size)]


def compose_translated_srt(subtitles: list[srt.Subtitle], translated_lines: Iterable[SubtitleLine]) -> str:
    translated_map = {line.position: line.text for line in translated_lines}
    new_subtitles: list[srt.Subtitle] = []
    for index, sub in enumerate(subtitles):
        new_subtitles.append(
            srt.Subtitle(
                index=sub.index,
                start=sub.start,
                end=sub.end,
                content=translated_map.get(index, sub.content),
                proprietary=sub.proprietary,
            )
        )
    if new_subtitles:
        last_end = max(sub.end for sub in new_subtitles)
        disclosure_start = last_end + timedelta(seconds=AI_DISCLOSURE_DELAY_SECONDS)
        disclosure_end = disclosure_start + timedelta(seconds=AI_DISCLOSURE_DURATION_SECONDS)
        new_subtitles.append(
            srt.Subtitle(
                index=len(new_subtitles) + 1,
                start=disclosure_start,
                end=disclosure_end,
                content=AI_DISCLOSURE_TEXT,
            )
        )
    return srt.compose(new_subtitles)


def strip_ai_disclosure_line(lines: list[SubtitleLine]) -> list[SubtitleLine]:
    if not lines:
        return lines
    trailing_text = _normalize_disclosure_text(lines[-1].text)
    if trailing_text != _normalize_disclosure_text(AI_DISCLOSURE_TEXT):
        return lines
    return list(lines[:-1])


def _normalize_disclosure_text(value: str) -> str:
    return " ".join(str(value or "").split()).strip()


def timestamp_to_milliseconds(value: str) -> int:
    try:
        hours_part, minutes_part, rest = value.split(":")
        seconds_part, millis_part = rest.split(",")
        return (
            int(hours_part) * 3_600_000
            + int(minutes_part) * 60_000
            + int(seconds_part) * 1_000
            + int(millis_part)
        )
    except Exception:
        return 0


def _line_window_ms(line: SubtitleLine, offset_ms: int = 0) -> tuple[int, int]:
    start = timestamp_to_milliseconds(line.start_time) - offset_ms
    end = timestamp_to_milliseconds(line.end_time) - offset_ms
    if end < start:
        end = start
    return start, end


def _midpoint_ms(start_ms: int, end_ms: int) -> float:
    return (start_ms + end_ms) / 2


def _joined_candidate_text(lines: list[SubtitleLine]) -> str:
    return "\n".join(line.text.strip() for line in lines if line.text.strip()).strip()


def _candidate_alignment_score(
    primary_line: SubtitleLine,
    candidate_lines: list[SubtitleLine],
    offset_ms: int = 0,
) -> float:
    if not candidate_lines:
        return 0.0

    primary_start, primary_end = _line_window_ms(primary_line)
    candidate_starts: list[int] = []
    candidate_ends: list[int] = []
    for line in candidate_lines:
        start_ms, end_ms = _line_window_ms(line, offset_ms=offset_ms)
        candidate_starts.append(start_ms)
        candidate_ends.append(end_ms)

    candidate_start = min(candidate_starts)
    candidate_end = max(candidate_ends)
    overlap_ms = max(0, min(primary_end, candidate_end) - max(primary_start, candidate_start))
    primary_duration = max(primary_end - primary_start, 1)
    candidate_duration = max(candidate_end - candidate_start, 1)
    overlap_score = overlap_ms / max(primary_duration, candidate_duration)

    midpoint_diff = abs(
        _midpoint_ms(primary_start, primary_end) - _midpoint_ms(candidate_start, candidate_end)
    )
    midpoint_window = max(1_800, primary_duration * 3)
    midpoint_score = max(0.0, 1.0 - (midpoint_diff / midpoint_window))

    duration_score = min(primary_duration, candidate_duration) / max(primary_duration, candidate_duration)

    return (overlap_score * 0.55) + (midpoint_score * 0.35) + (duration_score * 0.10)


def _estimate_index_offset_ms(primary_lines: list[SubtitleLine], secondary_lines: list[SubtitleLine]) -> int:
    if not primary_lines or len(primary_lines) != len(secondary_lines):
        return 0

    sample_total = min(len(primary_lines), 25)
    if sample_total <= 1:
        indices = [0]
    else:
        step = (len(primary_lines) - 1) / (sample_total - 1)
        indices = sorted({round(index * step) for index in range(sample_total)})

    deltas: list[float] = []
    for index in indices:
        primary_start, primary_end = _line_window_ms(primary_lines[index])
        secondary_start, secondary_end = _line_window_ms(secondary_lines[index])
        deltas.append(
            _midpoint_ms(secondary_start, secondary_end) - _midpoint_ms(primary_start, primary_end)
        )

    return int(round(median(deltas))) if deltas else 0


def _build_reference_track(
    filename: str,
    language: str,
    total_lines: int,
    matches: list[ReferenceSubtitleMatch],
    alignment_mode: str,
) -> ReferenceSubtitleTrack:
    confidences = [match.confidence for match in matches]
    average_confidence = round(sum(confidences) / len(confidences), 4) if confidences else 0.0
    return ReferenceSubtitleTrack(
        filename=filename,
        language=language,
        total_lines=total_lines,
        matched_lines=len(matches),
        average_confidence=average_confidence,
        alignment_mode=alignment_mode,
        aligned_lines=matches,
    )


def _align_by_index(
    primary_lines: list[SubtitleLine],
    secondary_lines: list[SubtitleLine],
    *,
    filename: str,
    language: str,
    minimum_confidence: float,
) -> ReferenceSubtitleTrack:
    offset_ms = _estimate_index_offset_ms(primary_lines, secondary_lines)
    matches: list[ReferenceSubtitleMatch] = []
    for primary_line, secondary_line in zip(primary_lines, secondary_lines, strict=False):
        confidence = _candidate_alignment_score(primary_line, [secondary_line], offset_ms=offset_ms)
        text = secondary_line.text.strip()
        if confidence < minimum_confidence or not text:
            continue
        matches.append(
            ReferenceSubtitleMatch(
                position=primary_line.position,
                text=text,
                confidence=round(confidence, 4),
                matched_positions=[secondary_line.position],
                start_time=secondary_line.start_time,
                end_time=secondary_line.end_time,
            )
        )
    return _build_reference_track(
        filename=filename,
        language=language,
        total_lines=len(secondary_lines),
        matches=matches,
        alignment_mode="index",
    )


def _align_by_timestamp(
    primary_lines: list[SubtitleLine],
    secondary_lines: list[SubtitleLine],
    *,
    filename: str,
    language: str,
    minimum_confidence: float,
) -> ReferenceSubtitleTrack:
    matches: list[ReferenceSubtitleMatch] = []
    cursor = 0
    max_group_size = 3
    search_window = 8

    for primary_line in primary_lines:
        if cursor >= len(secondary_lines):
            break

        best_score = 0.0
        best_start: int | None = None
        best_length = 0
        for start_index in range(cursor, min(len(secondary_lines), cursor + search_window)):
            for group_size in range(1, min(max_group_size, len(secondary_lines) - start_index) + 1):
                candidate_lines = secondary_lines[start_index:start_index + group_size]
                score = _candidate_alignment_score(primary_line, candidate_lines)
                if score > best_score:
                    best_score = score
                    best_start = start_index
                    best_length = group_size

        if best_start is None or best_score < minimum_confidence:
            continue

        selected_lines = secondary_lines[best_start:best_start + best_length]
        text = _joined_candidate_text(selected_lines)
        if not text:
            continue

        matches.append(
            ReferenceSubtitleMatch(
                position=primary_line.position,
                text=text,
                confidence=round(best_score, 4),
                matched_positions=[line.position for line in selected_lines],
                start_time=selected_lines[0].start_time,
                end_time=selected_lines[-1].end_time,
            )
        )
        cursor = best_start + best_length

    return _build_reference_track(
        filename=filename,
        language=language,
        total_lines=len(secondary_lines),
        matches=matches,
        alignment_mode="timestamp",
    )


def align_reference_track(
    primary_lines: list[SubtitleLine],
    secondary_lines: list[SubtitleLine],
    *,
    filename: str,
    language: str,
    minimum_confidence: float = 0.42,
) -> ReferenceSubtitleTrack:
    if not primary_lines or not secondary_lines:
        return ReferenceSubtitleTrack(
            filename=filename,
            language=language,
            total_lines=len(secondary_lines),
        )

    if len(primary_lines) == len(secondary_lines):
        index_track = _align_by_index(
            primary_lines,
            secondary_lines,
            filename=filename,
            language=language,
            minimum_confidence=minimum_confidence,
        )
        if index_track.matched_lines >= max(1, int(len(primary_lines) * 0.7)):
            return index_track

    return _align_by_timestamp(
        primary_lines,
        secondary_lines,
        filename=filename,
        language=language,
        minimum_confidence=minimum_confidence,
    )
