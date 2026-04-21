from __future__ import annotations

from typing import Iterable

import srt

from app.models import SubtitleLine


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
    return srt.compose(new_subtitles)
