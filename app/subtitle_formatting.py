from __future__ import annotations

import re
from dataclasses import dataclass


_INLINE_TAG_RE = re.compile(r"</?(?:font|b|i|u)\b[^>]*>", re.IGNORECASE)
_PROTECTED_MARKER_RE = re.compile(r"\[\[SUBFMT_(\d+)\]\]")
_PROTECTED_BREAK_RE = re.compile(r"\[\[SUBBR_(\d+)\]\]")
_MARKER_ARTIFACT_RE = re.compile(
    r"\[*\s*(?:SUBF[A-Z]*|SUBBR)_\d+\s*\]*",
    re.IGNORECASE,
)
_FONT_OPEN_RE = re.compile(
    r"<font\b(?:\s+[a-z][\w-]*\s*=\s*(?:\"[^\"]*\"|'[^']*'))*\s*>",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class ProtectedSubtitleText:
    model_text: str
    tags: tuple[str, ...]
    line_break_count: int = 0

    @property
    def markers(self) -> tuple[str, ...]:
        return tuple(f"[[SUBFMT_{index}]]" for index in range(len(self.tags)))

    @property
    def line_break_markers(self) -> tuple[str, ...]:
        return tuple(f"[[SUBBR_{index}]]" for index in range(self.line_break_count))


def strip_subtitle_formatting(value: str) -> str:
    """Return visible subtitle text without supported inline SRT/HTML styling."""
    text = _INLINE_TAG_RE.sub("", str(value or ""))
    text = _PROTECTED_MARKER_RE.sub("", text)
    return _PROTECTED_BREAK_RE.sub("\n", text)


def protect_subtitle_formatting(value: str) -> ProtectedSubtitleText:
    """Replace formatting with neutral immutable markers before an LLM call."""
    tags: list[str] = []

    def replace(match: re.Match[str]) -> str:
        marker = f"[[SUBFMT_{len(tags)}]]"
        tags.append(match.group(0))
        return marker

    model_text = _INLINE_TAG_RE.sub(replace, str(value or ""))
    line_break_count = 0

    def replace_line_break(_match: re.Match[str]) -> str:
        nonlocal line_break_count
        marker = f"[[SUBBR_{line_break_count}]]"
        line_break_count += 1
        return marker

    model_text = re.sub(r"\r?\n", replace_line_break, model_text)
    return ProtectedSubtitleText(
        model_text=model_text,
        tags=tuple(tags),
        line_break_count=line_break_count,
    )


def _remove_marker_artifacts(value: str, source_text: str) -> str:
    cleaned = _MARKER_ARTIFACT_RE.sub("", value)
    visible_source = _INLINE_TAG_RE.sub("", str(source_text or ""))
    if "[" not in visible_source and "]" not in visible_source:
        cleaned = "\n".join(line.strip("[] ") for line in cleaned.splitlines())
    return cleaned


def subtitle_has_internal_marker_artifact(value: str) -> bool:
    return bool(_MARKER_ARTIFACT_RE.search(str(value or "")))


def restore_subtitle_formatting(source_text: str, translated_text: str) -> str:
    """Restore source-owned tags when the model preserved the neutral markers.

    A cue using one uniform style can be restored deterministically even if the
    model dropped its markers. Multi-style cues deliberately remain unformatted
    on marker failure so validation can force a retry instead of assigning the
    wrong speaker color.
    """
    protected = protect_subtitle_formatting(source_text)
    translated = str(translated_text or "")
    raw_markers = tuple(match.group(0) for match in _PROTECTED_MARKER_RE.finditer(translated))
    raw_break_markers = tuple(match.group(0) for match in _PROTECTED_BREAK_RE.finditer(translated))
    clean_translation = _INLINE_TAG_RE.sub("", translated)

    if raw_break_markers == protected.line_break_markers:
        for index in range(protected.line_break_count):
            clean_translation = clean_translation.replace(f"[[SUBBR_{index}]]", "\n", 1)

    if raw_markers == protected.markers:
        restored = clean_translation
        for index, tag in enumerate(protected.tags):
            restored = restored.replace(f"[[SUBFMT_{index}]]", tag, 1)
        return _remove_marker_artifacts(restored, source_text)

    if not protected.tags:
        return _remove_marker_artifacts(clean_translation, source_text)

    visible = _remove_marker_artifacts(clean_translation, source_text).strip()
    opening_tags = [tag for tag in protected.tags if not tag.startswith("</")]
    closing_tags = [tag for tag in protected.tags if tag.startswith("</")]
    unique_opening_tags = {tag.casefold() for tag in opening_tags}
    if visible and len(unique_opening_tags) == 1 and len(opening_tags) == len(closing_tags):
        return f"{opening_tags[0]}{visible}{closing_tags[-1]}"
    return visible


def subtitle_formatting_matches(source_text: str, translated_text: str) -> bool:
    """Check that translated styling is balanced and source-compatible."""
    if subtitle_has_internal_marker_artifact(translated_text):
        return False
    if str(source_text or "").count("\n") != str(translated_text or "").count("\n"):
        return False
    source_tags = tuple(_INLINE_TAG_RE.findall(str(source_text or "")))
    translated_tags = tuple(_INLINE_TAG_RE.findall(str(translated_text or "")))
    if not source_tags:
        return not translated_tags
    if not translated_tags:
        return False

    stack: list[str] = []
    for tag in translated_tags:
        lowered = tag.casefold()
        if lowered.startswith("</"):
            name_match = re.match(r"</\s*([a-z]+)", lowered)
            if not name_match or not stack or stack.pop() != name_match.group(1):
                return False
            continue
        name_match = re.match(r"<\s*([a-z]+)", lowered)
        if not name_match:
            return False
        name = name_match.group(1)
        if name == "font" and not _FONT_OPEN_RE.fullmatch(tag):
            return False
        stack.append(name)
    if stack:
        return False

    source_openings = [tag.casefold() for tag in source_tags if not tag.startswith("</")]
    translated_openings = [tag.casefold() for tag in translated_tags if not tag.startswith("</")]
    source_styles = list(dict.fromkeys(source_openings))
    translated_styles = list(dict.fromkeys(translated_openings))
    return translated_styles == source_styles
