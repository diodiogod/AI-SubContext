from __future__ import annotations

import json
import logging
import math
import os
import platform
import re
import shutil
from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import Path
from statistics import median
from typing import Any, Callable
from urllib.parse import urlparse, urlunparse

import httpx

from app.config import (
    DEFAULT_MAX_COMPLETION_TOKENS,
    DEFAULT_REQUEST_TIMEOUT_SECONDS,
    TranslationSettings,
)
from app.models import (
    JobValidationStats,
    SessionContext,
    SubtitleLine,
    SubtitleValidationIssue,
    VisualDoubt,
    VisualObservation,
    VisualSceneContext,
)
from app.srt_utils import chunk_lines
from app.subtitle_formatting import (
    protect_subtitle_formatting,
    restore_subtitle_formatting,
    strip_subtitle_formatting,
    subtitle_formatting_matches,
)
from app.vision import ExtractedVisualFrame

logger = logging.getLogger(__name__)

try:
    from fast_langdetect import LangDetectConfig, LangDetector
except Exception:  # pragma: no cover - dependency is optional at import time
    LangDetectConfig = None
    LangDetector = None

_WORD_RE = re.compile(r"[A-Za-zÀ-ÿ']+")
_CJK_RE = re.compile(r"[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]")
_LANGUAGE_DETECTOR: Any = None
_LANGUAGE_DETECTOR_FAILED = False

_STRICT_RETRY_INSTRUCTION = (
    "Validation warning: previous output may have left lines untranslated or in the source language. "
    "Translate every line fully from {{source_language}} into {{target_language}}. "
    "Do not keep {{source_language}} text unless it is a proper name "
    "or a term explicitly marked to keep in the context glossary. Preserve line order and return all positions. "
    "Each output line must translate only its matching source line. Never pull text from adjacent subtitle lines, "
    "even when a sentence spans multiple subtitles."
)

_LANGUAGE_ALIASES = {
    "english": "en",
    "spanish": "es",
    "espanol": "es",
    "español": "es",
    "portuguese": "pt",
    "portugues": "pt",
    "português": "pt",
    "brazilian portuguese": "pt",
    "pt-br": "pt",
    "french": "fr",
    "german": "de",
    "italian": "it",
    "japanese": "ja",
    "chinese": "zh",
    "korean": "ko",
    "russian": "ru",
}

_LANGUAGE_DISPLAY_NAMES = {
    "ar": "Arabic",
    "cs": "Czech",
    "da": "Danish",
    "de": "German",
    "el": "Greek",
    "en": "English",
    "es": "Spanish",
    "fi": "Finnish",
    "fr": "French",
    "he": "Hebrew",
    "hi": "Hindi",
    "hu": "Hungarian",
    "id": "Indonesian",
    "it": "Italian",
    "ja": "Japanese",
    "ko": "Korean",
    "ms": "Malay",
    "nl": "Dutch",
    "no": "Norwegian",
    "pl": "Polish",
    "pt": "Portuguese",
    "pt-br": "Brazilian Portuguese",
    "pt-pt": "European Portuguese",
    "ro": "Romanian",
    "ru": "Russian",
    "sv": "Swedish",
    "th": "Thai",
    "tr": "Turkish",
    "uk": "Ukrainian",
    "vi": "Vietnamese",
    "zh": "Chinese",
    "zh-cn": "Simplified Chinese",
    "zh-tw": "Traditional Chinese",
}

_LANGUAGE_DISPLAY_CODES = {
    "pt-br": "pt-BR",
    "pt-pt": "pt-PT",
    "zh-cn": "zh-CN",
    "zh-tw": "zh-TW",
}

_LANGUAGE_NAME_ALIASES = {
    **{name.casefold(): code for code, name in _LANGUAGE_DISPLAY_NAMES.items()},
    "brazilian": "pt-br",
    "portuguese brazil": "pt-br",
    "portuguese brazilian": "pt-br",
    "european portuguese": "pt-pt",
    "portuguese portugal": "pt-pt",
    "mandarin": "zh",
}

DEFAULT_TRANSLATION_SYSTEM_PROMPT = (
    "You are an expert subtitle translator from {{source_language}} into {{target_language}}. "
    "Translate naturally, preserve subtitle meaning, punctuation, and line intent. "
    "Return JSON only. "
    "Do not explain your reasoning, do not think out loud, and do not include analysis or commentary outside the JSON object. "
    "Use character gender only as a grammar hint and prefer unknown over guessing. "
    "The primary subtitle text is always the canonical source. "
    "Each output line must translate only its matching source line. Never merge adjacent subtitle lines or shift text "
    "forward or backward across positions, even if the sentence continues across multiple subtitles. "
    "Preserve boundary cues like opening or closing quotes and leading dialogue dashes on the correct subtitle line whenever possible. "
    "Some source lines contain immutable markers such as [[SUBFMT_0]] and [[SUBBR_0]]. They represent program-owned styling and line breaks, not text. "
    "Copy every marker exactly once, unchanged and in the same order, around the translation of the text it originally surrounds."
)

REFERENCE_EVIDENCE_INSTRUCTION = (
    "Reference subtitle evidence is present for some lines in {reference_languages}. "
    "Use it only to resolve meaning that is genuinely ambiguous in the canonical {{source_language}} text. "
    "Never copy its grammar, word order, register, dialect, punctuation, or omissions into {{target_language}}. "
    "The reference alignment_confidence measures timing alignment only, not translation authority or linguistic quality. "
    "Ignore reference evidence when the canonical source is already clear or when the reference conflicts with it."
)

VISUAL_SCENE_EVIDENCE_INSTRUCTION = (
    "Visual scene context is present for this batch as cached factual evidence from ordered video frames. "
    "Use it only when relevant, preserve its stated uncertainties, and prefer the canonical subtitle text when they conflict."
)

STATE_UPDATE_INSTRUCTION = (
    "Also return a compact state_update for future batches. "
    "For state_update: premise means the whole movie premise (global story setup), not a scene recap. "
    "Keep premise stable across batches, but correct it when new evidence clearly contradicts earlier assumptions. "
    "You may revise any state_update field when current lines provide stronger evidence that earlier context was wrong. "
    "Write all state_update fields in English only. "
    "Make scene_context specific to the current batch only. "
    "Keep state_update compact and factual. "
    "Do not repeat a broad movie synopsis in scene_context if the current lines are about a narrower exchange, location, or action beat."
)

ADAPTIVE_VISION_TRANSLATION_INSTRUCTION = (
    "You may flag up to {max_doubts} lines for one visual follow-up. "
    "Flag only a concrete ambiguity that would materially change the target-language subtitle and that images can answer, "
    "using category speaker_gender, speaker_identity, "
    "object_identity, visible_action, location_context, or on_screen_text and timestamp_hint start, middle, or end. "
    "For every doubt, provide current_translation, one meaningfully different alternative_translation, and a concise "
    "translation_impact explaining why the visual answer selects between them. "
    "Do not flag ordinary vocabulary, grammar, general uncertainty, story curiosity, or prior-scene questions. "
    "Do not flag a line when the uncertainty would leave the translation unchanged. "
    "Keep every provisional translation usable and do not put an unconfirmed visual assumption in state_update."
)

DEFAULT_STRICT_RETRY_PROMPT = _STRICT_RETRY_INSTRUCTION

DEFAULT_INITIAL_CONTEXT_SYSTEM_PROMPT = (
    "You are preparing a compact movie subtitle translation card from {{source_language}} dialogue "
    "for later translation into {{target_language}}. "
    "Use only evidence from the provided cleaned subtitle text. "
    "Ignore timestamps, translation instructions, formatting instructions, JSON-related wording, opening-credit boilerplate, and song-only metadata. "
    "Do not describe the translation task itself. "
    "Do not mention source language, target language, subtitle translation, subtitles, movie card, context card, or the title as metadata. "
    "Premise means whole movie premise (global setup), not local scene context. "
    "Premise must describe the story or setup only when the evidence is strong enough; otherwise leave it empty. "
    "Style notes must describe real narrative, dialog, register, or recurring linguistic traits from the subtitle text, not generic instructions. "
    "Write all fields in English only. "
    "Infer only stable facts. Prefer unknown over guessing. "
    "Return JSON only."
)

DEFAULT_FULL_CONTEXT_REFRESH_SYSTEM_PROMPT = (
    "You are refreshing a compact subtitle translation context card from cleaned {{source_language}} subtitle text "
    "covering the whole title for later translation into {{target_language}}. "
    "Use the existing card as a base, revise only with evidence from the provided text, and prefer unknown over guessing. "
    "Ignore timestamps, translation instructions, formatting instructions, JSON-related wording, opening-credit boilerplate, and song-only metadata. "
    "Do not describe the translation task itself. "
    "Do not mention source language, target language, subtitle translation, subtitles, movie card, context card, or the title as metadata. "
    "Keep premise for stable whole-title facts only. "
    "Premise means whole movie premise (global setup), not local scene context. "
    "If new evidence clearly contradicts the existing card, correct any wrong field instead of keeping stale assumptions. "
    "Write all fields in English only. "
    "Keep the card compact. "
    "Return JSON only."
)

DEFAULT_BATCH_CONTEXT_REFRESH_SYSTEM_PROMPT = (
    "You are updating a compact subtitle translation context card from {{source_language}} dialogue "
    "for later translation into {{target_language}}. "
    "Use the existing card as a base, revise only with evidence from the provided subtitle lines, "
    "and prefer unknown over guessing. "
    "Premise means whole movie premise (global setup), not local scene context. "
    "Keep premise for stable whole-title facts, but if these lines clearly disprove the current premise or other fields, correct them. "
    "Make scene_context describe the local scene or conversation in these lines only. "
    "Write all fields in English only. "
    "Do not restate the full movie setup in scene_context unless these lines genuinely cover that setup. "
    "Keep the card compact. "
    "Return JSON only."
)

DEFAULT_LINE_REVISION_SYSTEM_PROMPT = (
    "You are revising a single subtitle line from {{source_language}} into {{target_language}}. "
    "Use the source text, current translation, and session context to produce the best final target-language line. "
    "The source_text remains canonical. "
    "Return only JSON. "
    "Do not explain your reasoning."
)

_LEGACY_DEFAULT_PROMPTS = {
    "prompt_translation_system": (
        "You are an expert subtitle translator. "
        "Translate naturally, preserve subtitle meaning, punctuation, and line intent. "
        "Return JSON only. Also return a compact state_update for future batches. "
        "Do not explain your reasoning, do not think out loud, and do not include analysis or commentary outside the JSON object. "
        "Use character gender only as a grammar hint and prefer unknown over guessing. "
        "The primary subtitle text is always the canonical source. "
        "If reference_subtitles are present for a line, they are supporting aligned subtitles from other languages. "
        "Use them to clarify ambiguity, but do not follow them blindly and do not change line count or order because of them. "
        "Each output line must translate only its matching source line. Never merge adjacent subtitle lines or shift text "
        "forward or backward across positions, even if the sentence continues across multiple subtitles. "
        "Preserve boundary cues like opening or closing quotes and leading dialogue dashes on the correct subtitle line whenever possible. "
        "If visual_scene_context is present, treat it as cached factual evidence from ordered video frames for the current scene. "
        "Use it only when relevant, preserve its stated uncertainties, and prefer the canonical subtitle text when they conflict. "
        "For state_update: premise means the whole movie premise (global story setup), not a scene recap. "
        "Keep premise stable across batches, but correct it when new evidence clearly contradicts earlier assumptions. "
        "You may revise any state_update field when current lines provide stronger evidence that earlier context was wrong. "
        "Write all state_update fields in English only. "
        "Make scene_context specific to the current batch only. "
        "Keep state_update compact and factual. "
        "Do not repeat a broad movie synopsis in scene_context if the current lines are about a narrower exchange, location, or action beat."
    ),
    "prompt_line_revision_system": (
        "You are revising a single subtitle line translation. "
        "Use the source text, current translation, and session context to produce the best final target-language line. "
        "If reference_subtitles are present, treat them as supporting aligned subtitle references from other languages. "
        "The source_text remains canonical. "
        "Return only JSON. "
        "Do not explain your reasoning."
    ),
}

_OLDER_TRANSLATION_SYSTEM_PROMPT = (
    "You are an expert subtitle translator. Translate naturally, preserve subtitle meaning, punctuation, and line intent. "
    "Return JSON only. Also return a compact state_update for future batches. Do not explain your reasoning, do not think "
    "out loud, and do not include analysis or commentary outside the JSON object. Use character gender only as a grammar "
    "hint and prefer unknown over guessing. The primary subtitle text is always the canonical source. If reference_subtitles "
    "are present for a line, they are supporting aligned subtitles from other languages. Use them to clarify ambiguity, but "
    "do not follow them blindly and do not change line count or order because of them. For state_update: keep premise as stable "
    "whole-title context, but make scene_context specific to the current batch only. Keep state_update compact and factual. "
    "Do not repeat a broad movie synopsis in scene_context if the current lines are about a narrower exchange, location, or action beat."
)

_PRE_FORMATTING_TRANSLATION_SYSTEM_PROMPT = (
    "You are an expert subtitle translator from {{source_language}} into {{target_language}}. "
    "Translate naturally, preserve subtitle meaning, punctuation, and line intent. "
    "Return JSON only. "
    "Do not explain your reasoning, do not think out loud, and do not include analysis or commentary outside the JSON object. "
    "Use character gender only as a grammar hint and prefer unknown over guessing. "
    "The primary subtitle text is always the canonical source. "
    "Each output line must translate only its matching source line. Never merge adjacent subtitle lines or shift text "
    "forward or backward across positions, even if the sentence continues across multiple subtitles. "
    "Preserve boundary cues like opening or closing quotes and leading dialogue dashes on the correct subtitle line whenever possible."
)

_PRE_LINE_BREAK_TRANSLATION_SYSTEM_PROMPT = (
    "You are an expert subtitle translator from {{source_language}} into {{target_language}}. "
    "Translate naturally, preserve subtitle meaning, punctuation, and line intent. "
    "Return JSON only. "
    "Do not explain your reasoning, do not think out loud, and do not include analysis or commentary outside the JSON object. "
    "Use character gender only as a grammar hint and prefer unknown over guessing. "
    "The primary subtitle text is always the canonical source. "
    "Each output line must translate only its matching source line. Never merge adjacent subtitle lines or shift text "
    "forward or backward across positions, even if the sentence continues across multiple subtitles. "
    "Preserve boundary cues like opening or closing quotes and leading dialogue dashes on the correct subtitle line whenever possible. "
    "Some source lines contain immutable markers such as [[SUBFMT_0]]. They represent program-owned subtitle styling, not text. "
    "Copy every marker exactly once, unchanged and in the same order, around the translation of the text it originally surrounds."
)

_LEGACY_DEFAULT_PROMPT_VARIANTS = {
    field_name: (prompt,)
    for field_name, prompt in _LEGACY_DEFAULT_PROMPTS.items()
}
_LEGACY_DEFAULT_PROMPT_VARIANTS["prompt_translation_system"] += (
    _OLDER_TRANSLATION_SYSTEM_PROMPT,
    _PRE_FORMATTING_TRANSLATION_SYSTEM_PROMPT,
    _PRE_LINE_BREAK_TRANSLATION_SYSTEM_PROMPT,
)
_LEGACY_DEFAULT_PROMPT_VARIANTS["prompt_translation_strict_retry"] = (
    "Validation warning: previous output may have left lines untranslated or in the source language. "
    "Translate every line fully into the target language. Do not keep source-language text unless it is a proper name "
    "or a term explicitly marked to keep in the context glossary. Preserve line order and return all positions.",
)


def _prompt_fingerprint(value: str) -> str:
    fingerprint = 2166136261
    for byte in value.encode("utf-8"):
        fingerprint ^= byte
        fingerprint = (fingerprint * 16777619) & 0xFFFFFFFF
    return f"{fingerprint:08x}"

PROMPT_DEFAULTS = {
    "prompt_translation_system": DEFAULT_TRANSLATION_SYSTEM_PROMPT,
    "prompt_translation_strict_retry": DEFAULT_STRICT_RETRY_PROMPT,
    "prompt_initial_context_system": DEFAULT_INITIAL_CONTEXT_SYSTEM_PROMPT,
    "prompt_full_context_refresh_system": DEFAULT_FULL_CONTEXT_REFRESH_SYSTEM_PROMPT,
    "prompt_batch_context_refresh_system": DEFAULT_BATCH_CONTEXT_REFRESH_SYSTEM_PROMPT,
    "prompt_line_revision_system": DEFAULT_LINE_REVISION_SYSTEM_PROMPT,
}


class ModelRequestTimeout(RuntimeError):
    def __init__(self, seconds: int):
        self.seconds = int(seconds)
        super().__init__(f"Model request timed out after {self.seconds}s")


class TranslationStopRequested(RuntimeError):
    pass


def _timeout_guidance(seconds: int) -> str:
    return (
        f"Model request timed out after {seconds}s. "
        "The model server may still be generating the abandoned request in the background; "
        "if retries stall, cancel/stop that generation in the model server. "
        "You can raise Request Timeout in Prompt Lab > Safety Controls for slower local models."
    )


def _approx_token_count(value: str) -> int:
    text = str(value or "")
    if not text:
        return 0
    cjk_count = len(_CJK_RE.findall(text))
    non_cjk_count = max(0, len(text) - cjk_count)
    # This is intentionally conservative for local-model capacity planning.
    # Exact counts require the specific model tokenizer, which LM Studio may vary.
    return cjk_count + math.ceil(non_cjk_count / 4)


def _json_for_prompt_size(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _prompt_size_summary(messages: list[dict[str, Any]], sections: dict[str, str]) -> str:
    message_text = "\n".join(str(message.get("content") or "") for message in messages)
    message_chars = len(message_text)
    message_tokens = _approx_token_count(message_text)
    section_parts = []
    for label, value in sections.items():
        text = str(value or "")
        section_parts.append(f"{label} {len(text)} chars/~{_approx_token_count(text)} tok")
    return (
        f"Prompt size estimate: {message_chars} message chars/~{message_tokens} prompt tokens"
        + (f" ({'; '.join(section_parts)})" if section_parts else "")
    )


def _raise_if_stop_requested(should_stop: StopCheck | None) -> None:
    if should_stop and should_stop():
        raise TranslationStopRequested("Translation stopped by user")


@dataclass
class BatchValidationResult:
    failed: bool
    suspicious_positions: list[int]
    detected_language: str | None
    reason: str
    boundary_positions: list[int] = field(default_factory=list)
    sequence_drift_positions: list[int] = field(default_factory=list)
    formatting_positions: list[int] = field(default_factory=list)


@dataclass
class BatchProcessingStats:
    suspicious_count: int = 0
    fixed_count: int = 0
    error_count: int = 0
    retried_batches: int = 0
    split_batches: int = 0
    issues: list[SubtitleValidationIssue] = field(default_factory=list)
    visual_doubts: list[VisualDoubt] = field(default_factory=list)

    def merge(self, other: "BatchProcessingStats") -> "BatchProcessingStats":
        self.suspicious_count += other.suspicious_count
        self.fixed_count += other.fixed_count
        self.error_count += other.error_count
        self.retried_batches += other.retried_batches
        self.split_batches += other.split_batches
        self.issues.extend(other.issues)
        self.visual_doubts.extend(other.visual_doubts)
        return self


LogEvent = Callable[[str, str], None]
StopCheck = Callable[[], bool]
PartialBatchUpdate = Callable[
    [list[SubtitleLine], list[SubtitleValidationIssue], str, list[int]],
    None,
]

MAX_ISOLATED_REPAIRS_PER_BATCH = 4

_META_STYLE_NOTE_PATTERNS = (
    "prefer unknown",
    "infer only stable facts",
    "return json",
    "compact format",
    "source language",
    "target language",
    "translation of",
    "subtitle translation",
    "literal translation",
    "preserve line breaks",
)

_META_CONTEXT_PATTERNS = (
    "translation of",
    "subtitle translation",
    "opening credits",
    "song lyrics",
    "translation card",
    "context card",
    "movie card",
    "subtitle file",
)

_META_LANGUAGE_MARKERS = (
    "english",
    "spanish",
    "portuguese",
    "french",
    "german",
    "italian",
    "japanese",
    "chinese",
    "korean",
    "russian",
    "pt-br",
    "pt br",
    "en",
    "es",
    "fr",
    "de",
    "ja",
    "zh",
    "ko",
    "ru",
)

_NON_NAME_TITLE_WORDS = {
    "afternoon",
    "birthday",
    "christmas",
    "doctor",
    "evening",
    "good",
    "goodbye",
    "hello",
    "help",
    "hey",
    "morning",
    "night",
    "please",
    "run",
    "sorry",
    "stop",
    "thank",
    "thanks",
    "welcome",
    "yes",
    "you",
}


def _extract_message_text(payload: dict[str, Any]) -> str:
    choices = payload.get("choices") or []
    if not choices:
        raise ValueError("No choices returned by model")
    message = choices[0].get("message") or {}
    content = message.get("content")
    if isinstance(content, str) and content.strip():
        return content
    if isinstance(content, list):
        text_parts = [part.get("text", "") for part in content if isinstance(part, dict)]
        merged = "".join(text_parts).strip()
        if merged:
            return merged
    reasoning = message.get("reasoning_content")
    if isinstance(reasoning, str) and reasoning.strip():
        return reasoning
    raise ValueError("Model returned empty content")


def _extract_json_blob(text: str) -> dict[str, Any]:
    text = text.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if len(lines) >= 3:
            text = "\n".join(lines[1:-1]).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError("No JSON object found in model response")
    blob = text[start:end + 1]
    try:
        return json.loads(blob)
    except json.JSONDecodeError as exc:
        line = int(getattr(exc, "lineno", 0) or 0)
        column = int(getattr(exc, "colno", 0) or 0)
        context_line = ""
        lines = blob.splitlines()
        if line and 1 <= line <= len(lines):
            context_line = lines[line - 1].strip()
        if len(context_line) > 160:
            context_line = context_line[:157] + "..."
        message = (
            f"Model returned invalid JSON at line {line}, column {column}. "
            "This usually means the response was truncated, mixed JSON with commentary, "
            "or broke the required schema."
        )
        if context_line:
            message += f" Near: {context_line}"
        raise ValueError(message) from exc


def _clean_subtitle_block_text(value: str) -> str:
    parts = [
        " ".join(part.split())
        for part in strip_subtitle_formatting(str(value or "")).splitlines()
    ]
    return "\n".join(part for part in parts if part).strip()


def _subtitle_text_blocks(lines: list[SubtitleLine]) -> list[str]:
    return [block for block in (_clean_subtitle_block_text(line.text) for line in lines) if block]


def _join_blocks_until_limit(blocks: list[str], char_limit: int) -> str:
    if char_limit <= 0:
        return "\n".join(blocks).strip()

    parts: list[str] = []
    used = 0
    for block in blocks:
        separator = 1 if parts else 0
        cost = len(block) + separator
        if parts and used + cost > char_limit:
            break
        if not parts and len(block) > char_limit:
            return block[:char_limit].strip()
        if parts:
            parts.append("\n")
        parts.append(block)
        used += cost
    return "".join(parts).strip()


def _distributed_sample_blocks(blocks: list[str], char_limit: int) -> str:
    if not blocks:
        return ""
    full_text = "\n".join(blocks).strip()
    if char_limit <= 0 or len(full_text) <= char_limit:
        return full_text

    segment_count = min(5, max(3, len(blocks) // 160 + 1))
    segment_count = max(1, segment_count)
    window_size = max(24, min(120, len(blocks) // max(1, segment_count)))
    per_segment_limit = max(600, char_limit // segment_count)

    ranges: list[tuple[int, int]] = []
    last_end = 0
    for index in range(segment_count):
        if segment_count == 1:
            center = 0
        else:
            center = round(index * (len(blocks) - 1) / (segment_count - 1))
        start = max(last_end, min(max(0, center - (window_size // 2)), max(0, len(blocks) - window_size)))
        end = min(len(blocks), start + window_size)
        if end <= start:
            continue
        ranges.append((start, end))
        last_end = end

    segments: list[str] = []
    for start, end in ranges:
        segment = _join_blocks_until_limit(blocks[start:end], per_segment_limit)
        if segment:
            segments.append(segment)

    sampled_text = "\n\n...\n\n".join(segments).strip()
    if len(sampled_text) <= char_limit:
        return sampled_text
    return sampled_text[:char_limit].rsplit("\n", 1)[0].strip()


def _build_full_subtitle_card_payload(
    settings: TranslationSettings,
    lines: list[SubtitleLine],
) -> dict[str, Any]:
    blocks = _subtitle_text_blocks(lines)
    full_text = "\n".join(blocks).strip()
    full_chars = len(full_text)
    requested_strategy = getattr(settings, "initial_card_strategy", "auto")
    max_chars = int(getattr(settings, "initial_card_max_chars", 24000) or 24000)

    if requested_strategy == "whole":
        strategy_used = "whole"
        subtitle_text = full_text
    elif requested_strategy == "sample":
        strategy_used = "sample"
        subtitle_text = _distributed_sample_blocks(blocks, max_chars)
    else:
        if full_chars <= max_chars:
            strategy_used = "whole"
            subtitle_text = full_text
        else:
            strategy_used = "sample"
            subtitle_text = _distributed_sample_blocks(blocks, max_chars)

    return {
        "requested_strategy": requested_strategy,
        "strategy_used": strategy_used,
        "subtitle_text": subtitle_text,
        "full_text_char_count": full_chars,
        "used_text_char_count": len(subtitle_text),
        "total_subtitle_blocks": len(blocks),
    }


def _looks_like_meta_context_text(value: str) -> bool:
    normalized = str(value or "").strip()
    if not normalized:
        return False
    lowered = normalized.casefold()

    if lowered.startswith("movie:") or lowered.startswith("title:"):
        return True
    if any(pattern in lowered for pattern in _META_CONTEXT_PATTERNS):
        return True
    if (
        ("subtitle" in lowered or "subtitles" in lowered or "translation" in lowered or "translated" in lowered)
        and any(marker in lowered for marker in _META_LANGUAGE_MARKERS)
    ):
        return True
    if " for " in lowered and ("subtitle" in lowered or "subtitles" in lowered):
        return True
    if "source language" in lowered or "target language" in lowered:
        return True
    return False


def _sanitize_context_scalar(value: str) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        return ""
    if _looks_like_meta_context_text(normalized):
        return ""
    return normalized


def _schema_payload(
    name: str,
    schema: dict[str, Any],
    *,
    strict: bool = True,
) -> dict[str, Any]:
    json_schema = {
        "name": name,
        "schema": schema,
    }
    if strict:
        json_schema["strict"] = True
    return {
        "type": "json_schema",
        "json_schema": json_schema,
    }


def _is_structured_output_compatibility_error(response: httpx.Response) -> bool:
    if response.status_code < 400:
        return False
    detail = response.text.casefold()
    return any(
        marker in detail
        for marker in (
            "response_format",
            "json_schema",
            "json schema",
            "structured output",
            "structured-output",
            "unknown field: strict",
            "unknown parameter: strict",
            "extra inputs are not permitted",
        )
    )


def _language_prompt_label(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return "Unknown language"
    normalized = raw.replace("_", "-").strip().casefold()
    code = normalized if normalized in _LANGUAGE_DISPLAY_NAMES else _LANGUAGE_NAME_ALIASES.get(normalized)
    if code is None:
        alias_code = _LANGUAGE_ALIASES.get(normalized)
        if alias_code:
            code = "pt-br" if normalized in {"brazilian portuguese", "pt-br"} else alias_code
    if code and code in _LANGUAGE_DISPLAY_NAMES:
        display_code = _LANGUAGE_DISPLAY_CODES.get(code, code)
        return f"{_LANGUAGE_DISPLAY_NAMES[code]} ({display_code})"
    return raw


def _prompt_template_variables(settings: TranslationSettings) -> dict[str, str]:
    return {
        "source_language": _language_prompt_label(settings.source_language),
        "target_language": _language_prompt_label(settings.target_language),
        "source_language_code": str(settings.source_language or "").strip(),
        "target_language_code": str(settings.target_language or "").strip(),
        "title": str(settings.title or "").strip(),
    }


def _language_prompt_payload(settings: TranslationSettings) -> dict[str, str]:
    return {
        "source_language": _language_prompt_label(settings.source_language),
        "source_language_code": str(settings.source_language or "").strip(),
        "target_language": _language_prompt_label(settings.target_language),
        "target_language_code": str(settings.target_language or "").strip(),
    }


def _render_prompt_template(template: str, settings: TranslationSettings) -> str:
    rendered = str(template or "")
    for name, value in _prompt_template_variables(settings).items():
        rendered = rendered.replace(f"{{{{{name}}}}}", value)
    return rendered.strip()


def _effective_prompt(settings: TranslationSettings, field_name: str, default_value: str) -> str:
    override = str(getattr(settings, field_name, "") or "").strip()
    if override in _LEGACY_DEFAULT_PROMPT_VARIANTS.get(field_name, ()):
        override = ""
    rendered = _render_prompt_template(override or default_value, settings)
    variables = _prompt_template_variables(settings)
    source_label = variables["source_language"]
    target_label = variables["target_language"]
    if source_label not in rendered or target_label not in rendered:
        rendered = f"Language task: {source_label} -> {target_label}. {rendered}"
    return rendered


def _reference_language_labels(
    reference_subtitles_by_position: dict[int, list[dict[str, Any]]] | None,
) -> list[str]:
    labels = {
        _language_prompt_label(str(reference.get("language") or ""))
        for references in (reference_subtitles_by_position or {}).values()
        for reference in references
        if str(reference.get("language") or "").strip()
    }
    return sorted(labels)


def _dynamic_reference_instruction(
    settings: TranslationSettings,
    reference_subtitles_by_position: dict[int, list[dict[str, Any]]] | None,
) -> str:
    has_references = any(reference_subtitles_by_position.values()) if reference_subtitles_by_position else False
    if not has_references:
        return ""
    labels = _reference_language_labels(reference_subtitles_by_position)
    reference_languages = ", ".join(labels) if labels else "an unspecified reference language"
    template = REFERENCE_EVIDENCE_INSTRUCTION.replace("{reference_languages}", reference_languages)
    return _render_prompt_template(template, settings)


def _visual_contexts_for_batch_lines(
    batch_lines: list[SubtitleLine],
    visual_scene_contexts: list[VisualSceneContext] | None,
) -> list[VisualSceneContext]:
    if not batch_lines or not visual_scene_contexts:
        return []
    start_position = min(line.position for line in batch_lines)
    end_position = max(line.position for line in batch_lines)
    return [
        context
        for context in visual_scene_contexts
        if context.end_position >= start_position and context.start_position <= end_position
    ]


def _effective_timeout_seconds(settings: TranslationSettings) -> int:
    return max(15, int(getattr(settings, "request_timeout_seconds", DEFAULT_REQUEST_TIMEOUT_SECONDS) or DEFAULT_REQUEST_TIMEOUT_SECONDS))


def _effective_max_completion_tokens(settings: TranslationSettings) -> int:
    return max(128, int(getattr(settings, "max_completion_tokens", DEFAULT_MAX_COMPLETION_TOKENS) or DEFAULT_MAX_COMPLETION_TOKENS))


def _target_language_tips(settings: TranslationSettings) -> str:
    return _render_prompt_template(
        str(getattr(settings, "target_language_tips", "") or ""),
        settings,
    )


def _with_target_language_tips(system_instruction: str, settings: TranslationSettings) -> str:
    tips = _target_language_tips(settings)
    if not tips:
        return system_instruction
    return (
        f"{system_instruction} "
        "Target-language tips (apply unless they conflict with source meaning): "
        f"{tips}"
    )


def _session_context_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "premise": {"type": "string", "maxLength": 500},
            "tone": {"type": "string", "maxLength": 160},
            "scene_context": {"type": "string", "maxLength": 500},
            "style_notes": {
                "type": "array",
                "maxItems": 12,
                "items": {"type": "string", "maxLength": 180},
            },
            "characters": {
                "type": "array",
                "maxItems": 16,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "name": {"type": "string", "maxLength": 120},
                        "role": {"type": "string", "maxLength": 260},
                        "aliases": {
                            "type": "array",
                            "maxItems": 8,
                            "items": {"type": "string", "maxLength": 80},
                        },
                        "gender": {"type": "string", "enum": ["f", "m", "neutral", "unknown"]},
                    },
                    "required": ["name", "role", "aliases", "gender"],
                },
            },
            "glossary": {
                "type": "array",
                "maxItems": 24,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "term": {"type": "string", "maxLength": 120},
                        "meaning": {"type": "string", "maxLength": 260},
                        "keep": {"type": "boolean"},
                    },
                    "required": ["term", "meaning", "keep"],
                },
            },
            "unresolved_ambiguities": {
                "type": "array",
                "maxItems": 12,
                "items": {"type": "string", "maxLength": 220},
            },
        },
        "required": [
            "premise",
            "tone",
            "scene_context",
            "style_notes",
            "characters",
            "glossary",
            "unresolved_ambiguities",
        ],
    }


def _translation_schema(
    *,
    include_state_update: bool = True,
    expected_positions: list[int] | None = None,
) -> dict[str, Any]:
    expected_positions = list(dict.fromkeys(expected_positions or []))
    position_schema: dict[str, Any] = {"type": "integer"}
    if expected_positions:
        position_schema["enum"] = expected_positions
    schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "translations": {
                "type": "array",
                "minItems": len(expected_positions) if expected_positions else 1,
                "maxItems": len(expected_positions) if expected_positions else 100,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "position": position_schema,
                        "text": {"type": "string", "maxLength": 500},
                    },
                    "required": ["position", "text"],
                },
            },
        },
        "required": ["translations"],
    }
    if include_state_update:
        schema["properties"]["state_update"] = _session_context_schema()
        schema["required"].append("state_update")
    return schema


def _adaptive_translation_schema(
    *,
    include_state_update: bool = True,
    expected_positions: list[int] | None = None,
) -> dict[str, Any]:
    schema = _translation_schema(
        include_state_update=include_state_update,
        expected_positions=expected_positions,
    )
    schema["properties"]["visual_doubts"] = {
        "type": "array",
        "maxItems": 3,
        "items": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "position": {"type": "integer"},
                "category": {
                    "type": "string",
                    "enum": [
                        "speaker_gender",
                        "speaker_identity",
                        "object_identity",
                        "visible_action",
                        "location_context",
                        "on_screen_text",
                    ],
                },
                "question": {"type": "string", "minLength": 12, "maxLength": 220},
                "current_translation": {"type": "string", "minLength": 1, "maxLength": 500},
                "alternative_translation": {"type": "string", "minLength": 1, "maxLength": 500},
                "translation_impact": {"type": "string", "minLength": 12, "maxLength": 220},
                "timestamp_hint": {
                    "type": "string",
                    "enum": ["start", "middle", "end"],
                },
            },
            "required": [
                "position",
                "category",
                "question",
                "current_translation",
                "alternative_translation",
                "translation_impact",
                "timestamp_hint",
            ],
        },
    }
    schema["required"].append("visual_doubts")
    return schema


def _visual_clarification_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "decisions": {
                "type": "array",
                "maxItems": 3,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "position": {"type": "integer"},
                        "selected": {
                            "type": "string",
                            "enum": ["current", "alternative", "inconclusive"],
                        },
                        "evidence_found": {"type": "boolean"},
                        "answer": {"type": "string", "maxLength": 240},
                        "confidence": {
                            "type": "string",
                            "enum": ["high", "medium", "low", "unknown"],
                        },
                    },
                    "required": [
                        "position",
                        "selected",
                        "evidence_found",
                        "answer",
                        "confidence",
                    ],
                },
            },
        },
        "required": ["decisions"],
    }


def _visual_scene_context_schema() -> dict[str, Any]:
    list_field = {
        "type": "array",
        "maxItems": 10,
        "items": {"type": "string", "maxLength": 180},
    }
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "setting": {"type": "string", "maxLength": 240},
            "visible_characters": list_field,
            "actions": list_field,
            "objects": list_field,
            "on_screen_text": list_field,
            "speaker_evidence": list_field,
            "uncertainties": list_field,
            "summary": {"type": "string", "maxLength": 500},
        },
        "required": [
            "setting",
            "visible_characters",
            "actions",
            "objects",
            "on_screen_text",
            "speaker_evidence",
            "uncertainties",
            "summary",
        ],
    }


def _single_line_revision_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "text": {"type": "string", "maxLength": 500},
        },
        "required": ["text"],
    }


def merge_session_context(current: SessionContext | None, update: dict[str, Any]) -> SessionContext:
    base = current.model_dump() if current else SessionContext().model_dump()

    for scalar_key in ("premise", "tone", "scene_context"):
        value = (update or {}).get(scalar_key)
        if isinstance(value, str) and value.strip():
            base[scalar_key] = _sanitize_context_scalar(value)

    for list_key in ("style_notes", "unresolved_ambiguities"):
        values = (update or {}).get(list_key) or []
        merged: list[str] = list(base.get(list_key, []))
        for item in values:
            if isinstance(item, str) and item.strip() and item.strip() not in merged:
                merged.append(item.strip())
        base[list_key] = merged[:12]

    characters_by_name = {item["name"].strip().lower(): item for item in base.get("characters", []) if item.get("name")}
    for item in (update or {}).get("characters") or []:
        name = str(item.get("name", "")).strip()
        if not name:
            continue
        key = name.lower()
        existing = characters_by_name.get(key, {"name": name, "role": "", "aliases": [], "gender": "unknown"})
        role = str(item.get("role", "")).strip()
        if role:
            existing["role"] = role
        aliases = [alias.strip() for alias in item.get("aliases", []) if isinstance(alias, str) and alias.strip()]
        existing["aliases"] = list(dict.fromkeys([*existing.get("aliases", []), *aliases]))[:8]
        gender = str(item.get("gender", "unknown")).strip().lower()
        if gender in {"f", "m", "neutral", "unknown"}:
            existing["gender"] = gender
        characters_by_name[key] = existing
    base["characters"] = list(characters_by_name.values())[:16]

    glossary_by_term = {item["term"].strip().lower(): item for item in base.get("glossary", []) if item.get("term")}
    for item in (update or {}).get("glossary") or []:
        term = str(item.get("term", "")).strip()
        if not term:
            continue
        glossary_by_term[term.lower()] = {
            "term": term,
            "meaning": str(item.get("meaning", "")).strip(),
            "keep": bool(item.get("keep", True)),
        }
    base["glossary"] = list(glossary_by_term.values())[:24]

    context = SessionContext(**base)

    cleaned_style_notes: list[str] = []
    for note in context.style_notes:
        normalized = note.strip()
        lowered = normalized.casefold()
        if not normalized:
            continue
        if any(pattern in lowered for pattern in _META_STYLE_NOTE_PATTERNS):
            continue
        if _looks_like_meta_context_text(normalized):
            continue
        if normalized not in cleaned_style_notes:
            cleaned_style_notes.append(normalized)
    context.style_notes = cleaned_style_notes[:12]

    for field_name in ("premise", "tone", "scene_context"):
        value = getattr(context, field_name, "").strip()
        if value and _looks_like_meta_context_text(value):
            setattr(context, field_name, "")

    return context


def _normalize_language_code(value: str | None) -> str:
    raw = str(value or "").strip().lower().replace("_", "-")
    if not raw:
        return ""
    return _LANGUAGE_ALIASES.get(raw, raw.split("-", 1)[0])


def _normalize_text(value: str) -> str:
    return " ".join(strip_subtitle_formatting(str(value or "")).strip().split())


def _word_tokens(value: str) -> list[str]:
    return [token.lower() for token in _WORD_RE.findall(value) if len(token) > 1]


def _alpha_character_count(value: str) -> int:
    return sum(1 for char in value if char.isalpha())


def _name_tokens(value: str) -> list[str]:
    return re.findall(r"[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’-]*", _normalize_text(value))


def _looks_like_unchanged_proper_name(
    source_text: str,
    translated_text: str,
    session_context: SessionContext | None = None,
) -> bool:
    source = _normalize_text(source_text)
    translated = _normalize_text(translated_text)
    if not source or source.casefold() != translated.casefold():
        return False

    tokens = _name_tokens(source)
    if not tokens or len(tokens) > 4:
        return False

    known_names: set[str] = set()
    if session_context:
        for character in session_context.characters:
            known_names.add(_normalize_text(character.name).casefold())
            known_names.update(
                _normalize_text(alias).casefold()
                for alias in character.aliases
                if _normalize_text(alias)
            )
    if source.strip(" .?!,:;\"'").casefold() in known_names:
        return True

    # Multiple title-cased words with no sentence punctuation are strongly name-like.
    if (
        len(tokens) >= 2
        and all(token[0].isupper() for token in tokens)
        and not any(token.casefold() in _NON_NAME_TITLE_WORDS for token in tokens)
    ):
        non_name_punctuation = re.sub(r"[\wÀ-ÿ'’\-\s.?,]", "", source)
        return not non_name_punctuation
    return False


def _line_looks_untranslated(
    source_text: str,
    translated_text: str,
    session_context: SessionContext | None = None,
) -> bool:
    source = _normalize_text(source_text)
    translated = _normalize_text(translated_text)
    if not translated:
        return True
    if len(source) >= 8 and source.casefold() == translated.casefold():
        if _looks_like_unchanged_proper_name(source, translated, session_context):
            return False
        return True

    source_tokens = set(_word_tokens(source))
    translated_tokens = set(_word_tokens(translated))
    if len(source_tokens) < 3 or len(translated_tokens) < 3:
        return False

    overlap = len(source_tokens & translated_tokens) / max(1, len(source_tokens))
    return overlap >= 0.82


def _line_boundary_markers(text: str) -> dict[str, bool]:
    stripped = strip_subtitle_formatting(text).strip()
    if not stripped:
        return {
            "leading_dash": False,
            "starts_with_quote": False,
            "ends_with_quote": False,
            "ends_with_ellipsis": False,
        }

    quote_chars = "\"'“”‘’«»"
    return {
        "leading_dash": stripped.startswith(("-", "–", "—")),
        "starts_with_quote": stripped[:1] in quote_chars,
        "ends_with_quote": stripped[-1:] in quote_chars,
        "ends_with_ellipsis": stripped.endswith(("...", "…")),
    }


def _boundary_drift_positions(
    batch_lines: list[SubtitleLine],
    translated_lines: list[SubtitleLine],
) -> list[int]:
    flagged: set[int] = set()
    for source, translated in zip(batch_lines, translated_lines, strict=False):
        source_markers = _line_boundary_markers(source.text)
        translated_markers = _line_boundary_markers(translated.text)
        core_mismatches = sum(
            1
            for key in ("leading_dash", "starts_with_quote", "ends_with_quote")
            if source_markers[key] != translated_markers[key]
        )
        soft_mismatch = source_markers["ends_with_ellipsis"] != translated_markers["ends_with_ellipsis"]
        if core_mismatches >= 1 or (core_mismatches == 0 and soft_mismatch):
            flagged.add(source.position)
    return sorted(flagged)


def _visible_alphanumeric_count(value: str) -> int:
    return max(1, sum(char.isalnum() for char in strip_subtitle_formatting(value)))


def _sequence_drift_positions(
    batch_lines: list[SubtitleLine],
    translated_lines: list[SubtitleLine],
) -> list[int]:
    """Detect runs whose target lengths align much better one cue away.

    This is intentionally a run-level detector. A single concise or expanded
    translation is normal; a sustained one-position alignment is the signature
    of the model shifting dialogue forward or backward across subtitle cues.
    """
    paired = list(zip(batch_lines, translated_lines, strict=False))
    window_size = min(8, len(paired))
    if window_size < 5:
        return []

    source_lengths = [_visible_alphanumeric_count(source.text) for source, _ in paired]
    target_lengths = [_visible_alphanumeric_count(translated.text) for _, translated in paired]
    flagged_indices: set[int] = set()

    for start in range(0, len(paired) - window_size + 1):
        end = start + window_size
        local_ratios = [
            target_lengths[index] / source_lengths[index]
            for index in range(start, end)
        ]
        typical_ratio = max(0.1, median(local_ratios))

        def alignment_cost(offset: int) -> float:
            costs: list[float] = []
            for index in range(start, end):
                source_index = index + offset
                if source_index < 0 or source_index >= len(paired):
                    continue
                ratio = target_lengths[index] / source_lengths[source_index]
                costs.append(abs(math.log(max(0.01, ratio / typical_ratio))))
            return sum(costs) / max(1, len(costs))

        direct_cost = alignment_cost(0)
        shifted_cost = min(alignment_cost(-1), alignment_cost(1))
        if direct_cost > 0.5 and shifted_cost < 0.4 and shifted_cost < direct_cost * 0.6:
            flagged_indices.update(range(start, end))

    return [paired[index][0].position for index in sorted(flagged_indices)]


def _line_has_strong_failure_signal(
    settings: TranslationSettings,
    source_text: str,
    translated_text: str,
    validation: BatchValidationResult | None = None,
    session_context: SessionContext | None = None,
    position: int | None = None,
) -> bool:
    source = _normalize_text(source_text)
    translated = _normalize_text(translated_text)
    source_code = _normalize_language_code(settings.source_language)

    if not translated:
        return True
    if validation and position is not None and position in {
        *validation.boundary_positions,
        *validation.sequence_drift_positions,
        *validation.formatting_positions,
    }:
        return True
    if len(source) >= 8 and source.casefold() == translated.casefold():
        if _looks_like_unchanged_proper_name(source, translated, session_context):
            return False
        return True
    if validation and validation.detected_language and validation.detected_language == source_code:
        return True
    return False


def _batch_failure_threshold(batch_size: int) -> int:
    if batch_size <= 3:
        return 1
    if batch_size <= 8:
        return 2
    return max(3, batch_size // 3)


def _get_language_detector() -> Any:
    global _LANGUAGE_DETECTOR, _LANGUAGE_DETECTOR_FAILED
    if _LANGUAGE_DETECTOR is not None or _LANGUAGE_DETECTOR_FAILED:
        return _LANGUAGE_DETECTOR
    if LangDetector is None or LangDetectConfig is None:
        _LANGUAGE_DETECTOR_FAILED = True
        return None
    try:
        _LANGUAGE_DETECTOR = LangDetector(LangDetectConfig(model="lite", max_input_length=400))
    except Exception:
        _LANGUAGE_DETECTOR_FAILED = True
        _LANGUAGE_DETECTOR = None
    return _LANGUAGE_DETECTOR


def _detect_language_code(text: str) -> str | None:
    detector = _get_language_detector()
    if detector is None:
        return None
    sample = _normalize_text(text)
    if _alpha_character_count(sample) < 20:
        return None
    try:
        result = detector.detect(sample, k=1)
    except Exception:
        return None
    if isinstance(result, list) and result:
        candidate = result[0]
    else:
        candidate = result
    if isinstance(candidate, dict):
        return _normalize_language_code(candidate.get("lang") or candidate.get("language"))
    return None


def _validate_translated_batch(
    settings: TranslationSettings,
    batch_lines: list[SubtitleLine],
    translated_lines: list[SubtitleLine],
    session_context: SessionContext | None = None,
) -> BatchValidationResult:
    source_code = _normalize_language_code(settings.source_language)
    target_code = _normalize_language_code(settings.target_language)
    if not source_code or not target_code or source_code == target_code:
        return BatchValidationResult(False, [], None, "")

    untranslated_positions = [
        source.position
        for source, translated in zip(batch_lines, translated_lines, strict=False)
        if _line_looks_untranslated(source.text, translated.text, session_context)
    ]
    boundary_positions = _boundary_drift_positions(batch_lines, translated_lines)
    sequence_drift_positions = _sequence_drift_positions(batch_lines, translated_lines)
    formatting_positions = [
        source.position
        for source, translated in zip(batch_lines, translated_lines, strict=False)
        if not subtitle_formatting_matches(source.text, translated.text)
    ]
    suspicious_positions = sorted(
        set(untranslated_positions)
        | set(boundary_positions)
        | set(sequence_drift_positions)
        | set(formatting_positions)
    )
    translated_batch_text = " ".join(
        translated.text for translated in translated_lines if _alpha_character_count(translated.text) >= 4
    )
    detected_language = _detect_language_code(translated_batch_text)

    failed = False
    reasons: list[str] = []
    if untranslated_positions and len(untranslated_positions) >= _batch_failure_threshold(len(batch_lines)):
        failed = True
        reasons.append(f"suspicious untranslated lines: {untranslated_positions[:5]}")
    if boundary_positions and len(boundary_positions) >= 2:
        failed = True
        reasons.append(f"possible subtitle boundary drift: {boundary_positions[:5]}")
    if sequence_drift_positions:
        failed = True
        reasons.append(
            "probable neighboring-cue translation shift: "
            f"{sequence_drift_positions[:8]}"
        )
    if formatting_positions:
        failed = True
        reasons.append(f"subtitle formatting mismatch: {formatting_positions[:8]}")
    if detected_language == source_code:
        failed = True
        reasons.append(f"batch output still looks like source language '{source_code}'")

    return BatchValidationResult(
        failed=failed,
        suspicious_positions=suspicious_positions,
        detected_language=detected_language,
        reason="; ".join(reasons),
        boundary_positions=boundary_positions,
        sequence_drift_positions=sequence_drift_positions,
        formatting_positions=formatting_positions,
    )


def _flagged_positions(
    validation: BatchValidationResult,
    batch_lines: list[SubtitleLine],
    settings: TranslationSettings,
) -> list[int]:
    if validation.suspicious_positions:
        return validation.suspicious_positions

    source_code = _normalize_language_code(settings.source_language)
    if validation.detected_language and validation.detected_language == source_code:
        return [line.position for line in batch_lines]
    return []


def _validation_notes(
    validation: BatchValidationResult,
    settings: TranslationSettings,
    flagged_positions: list[int],
) -> list[str]:
    notes: list[str] = []
    structural_positions = {
        *validation.boundary_positions,
        *validation.sequence_drift_positions,
        *validation.formatting_positions,
    }
    untranslated_only = [
        position for position in flagged_positions if position not in structural_positions
    ]
    if untranslated_only:
        notes.append("Line still looks untranslated or too close to the source text.")
    if validation.formatting_positions:
        notes.append("Program-owned subtitle formatting was missing, malformed, or changed.")
    if validation.sequence_drift_positions:
        notes.append("Translation content appears shifted into a neighboring subtitle cue.")
    elif validation.boundary_positions:
        notes.append("Subtitle boundary punctuation may have moved between cues.")
    source_code = _normalize_language_code(settings.source_language)
    if validation.detected_language and validation.detected_language == source_code:
        notes.append(f"Batch output still looks like source language '{source_code}'.")
    if validation.reason:
        notes.append(validation.reason)
    return notes


def _strong_repair_positions(
    settings: TranslationSettings,
    batch_lines: list[SubtitleLine],
    translated_lines: list[SubtitleLine],
    validation: BatchValidationResult,
    flagged_positions: list[int],
    session_context: SessionContext | None = None,
) -> list[int]:
    source_by_position = {line.position: line.text for line in batch_lines}
    translated_by_position = {line.position: line.text for line in translated_lines}
    return [
        position
        for position in flagged_positions
        if _line_has_strong_failure_signal(
            settings,
            source_by_position.get(position, ""),
            translated_by_position.get(position, ""),
            validation,
            session_context,
            position,
        )
    ]


def _reason_codes_for_line(
    settings: TranslationSettings,
    source_text: str,
    translated_text: str,
    validation: BatchValidationResult | None = None,
    session_context: SessionContext | None = None,
    *,
    position: int | None = None,
    status: str = "suspect",
    extra_codes: list[str] | None = None,
) -> list[str]:
    codes: list[str] = list(extra_codes or [])
    source = _normalize_text(source_text)
    translated = _normalize_text(translated_text)
    source_code = _normalize_language_code(settings.source_language)

    if not translated:
        codes.append("missing_output")
    elif (
        len(source) >= 8
        and source.casefold() == translated.casefold()
        and not _looks_like_unchanged_proper_name(source, translated, session_context)
    ):
        codes.append("unchanged_from_source")
    elif _line_looks_untranslated(source, translated, session_context):
        codes.append("source_language_leak")

    if not subtitle_formatting_matches(source_text, translated_text):
        codes.append("formatting_mismatch")
    if validation and position is not None:
        if position in validation.sequence_drift_positions:
            codes.append("boundary_sequence_drift")
        elif position in validation.boundary_positions:
            codes.append("boundary_drift")

    if validation and validation.detected_language and validation.detected_language == source_code:
        codes.append("validator_language_mismatch")
        if translated:
            codes.append("source_language_leak")

    if status == "auto_fixed":
        codes.append("retry_fixed")
    elif status == "manual_fixed":
        codes.append("manual_fix")

    unique: list[str] = []
    for code in codes:
        if code and code not in unique:
            unique.append(code)
    return unique or ["other"]


def _build_validation_issues(
    settings: TranslationSettings,
    status: str,
    positions: list[int],
    batch_lines: list[SubtitleLine],
    translated_lines: list[SubtitleLine],
    batch_index: int | None,
    notes: list[str],
    validation: BatchValidationResult | None = None,
    extra_codes: list[str] | None = None,
    session_context: SessionContext | None = None,
) -> list[SubtitleValidationIssue]:
    source_by_position = {line.position: line.text for line in batch_lines}
    translated_by_position = {line.position: line.text for line in translated_lines}
    return [
        SubtitleValidationIssue(
            position=position,
            status=status,
            source_text=source_by_position.get(position, ""),
            translated_text=translated_by_position.get(position, ""),
            reason_codes=_reason_codes_for_line(
                settings,
                source_by_position.get(position, ""),
                translated_by_position.get(position, ""),
                validation,
                session_context,
                position=position,
                status=status,
                extra_codes=extra_codes,
            ),
            notes=notes,
            batch_index=batch_index,
        )
        for position in positions
    ]


def _ordered_lines_from_map(batch_lines: list[SubtitleLine], translated_by_position: dict[int, SubtitleLine]) -> list[SubtitleLine]:
    return [translated_by_position.get(line.position, line) for line in batch_lines]


class OpenAICompatibleTranslator:
    def __init__(self) -> None:
        pass

    def runtime_defaults(self) -> dict[str, Any]:
        return {
            "max_completion_tokens": DEFAULT_MAX_COMPLETION_TOKENS,
            "request_timeout_seconds": DEFAULT_REQUEST_TIMEOUT_SECONDS,
            **PROMPT_DEFAULTS,
            "legacy_prompt_fingerprints": {
                field_name: [_prompt_fingerprint(prompt) for prompt in prompts]
                for field_name, prompts in _LEGACY_DEFAULT_PROMPT_VARIANTS.items()
            },
        }

    def _detect_wsl_host_ip(self) -> str | None:
        if platform.system().lower() != "linux":
            return None

        candidate = self._detect_windows_ipv4()
        if candidate:
            return candidate

        resolv_conf = Path("/etc/resolv.conf")
        if resolv_conf.exists():
            for line in resolv_conf.read_text(encoding="utf-8", errors="ignore").splitlines():
                line = line.strip()
                if line.startswith("nameserver "):
                    candidate = line.split(maxsplit=1)[1].strip()
                    if candidate and candidate not in {"127.0.0.1", "::1"}:
                        return candidate

        try:
            import subprocess

            result = subprocess.run(
                ["bash", "-lc", "ip route show default | awk '/default/ {print $3; exit}'"],
                capture_output=True,
                text=True,
                check=False,
            )
            candidate = result.stdout.strip()
            if candidate and candidate not in {"127.0.0.1", "::1"}:
                return candidate
        except Exception:
            return None

        return None

    def _detect_windows_ipv4(self) -> str | None:
        powershell = shutil.which("powershell.exe") or shutil.which("pwsh")
        if not powershell:
            return None

        try:
            import subprocess

            command = (
                "$route = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' "
                "| Sort-Object RouteMetric, InterfaceMetric | Select-Object -First 1; "
                "if ($route) { "
                "$ip = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.ifIndex "
                "| Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.*' "
                "-and $_.IPAddress -ne '0.0.0.0' } "
                "| Select-Object -First 1 -ExpandProperty IPAddress; "
                "if ($ip) { $ip } "
                "}"
            )
            result = subprocess.run(
                [powershell, "-NoProfile", "-Command", command],
                capture_output=True,
                text=True,
                check=False,
            )
            candidate = result.stdout.strip().splitlines()[0].strip() if result.stdout.strip() else ""
            if candidate and candidate not in {"127.0.0.1", "::1"}:
                return candidate
        except Exception:
            return None

        return None

    def _candidate_base_urls(self, base_url: str) -> list[str]:
        normalized = base_url.rstrip("/")
        candidates = [normalized]
        parsed = urlparse(normalized)
        if parsed.hostname in {"localhost", "127.0.0.1", "::1"}:
            host_ip = self._detect_wsl_host_ip()
            if host_ip:
                netloc = host_ip
                if parsed.port:
                    netloc = f"{host_ip}:{parsed.port}"
                fallback = urlunparse(parsed._replace(netloc=netloc))
                if fallback not in candidates:
                    candidates.append(fallback)
        return candidates

    async def probe_connection(self, settings: TranslationSettings) -> dict[str, Any]:
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {settings.api_key or 'lm-studio'}",
        }
        candidates = self._candidate_base_urls(settings.base_url)
        errors: list[str] = []

        async with httpx.AsyncClient(timeout=httpx.Timeout(7.0)) as client:
            for candidate in candidates:
                try:
                    response = await client.get(candidate + "/models", headers=headers)
                    response.raise_for_status()
                    payload = response.json()
                    models = payload.get("data") or payload.get("models") or []
                    found = any(
                        str(model.get("id") or model.get("name")) == settings.model
                        for model in models
                        if isinstance(model, dict)
                    )
                    return {
                        "ok": True,
                        "base_url": candidate,
                        "model": settings.model,
                        "message": (
                            f"Connected to model endpoint. "
                            f"{'Model found.' if found else 'Endpoint reachable; model not listed.'}"
                        ),
                    }
                except Exception as exc:
                    errors.append(f"{candidate}: {exc}")

        return {
            "ok": False,
            "base_url": candidates[0] if candidates else settings.base_url,
            "model": settings.model,
            "message": "All connection attempts failed: " + "; ".join(errors[-3:]),
        }

    async def list_models(self, settings: TranslationSettings) -> dict[str, Any]:
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {settings.api_key or 'lm-studio'}",
        }
        candidates = self._candidate_base_urls(settings.base_url)
        errors: list[str] = []

        async with httpx.AsyncClient(timeout=httpx.Timeout(7.0)) as client:
            for candidate in candidates:
                try:
                    response = await client.get(candidate + "/models", headers=headers)
                    response.raise_for_status()
                    payload = response.json()
                    items = payload.get("data") or payload.get("models") or []
                    models: list[str] = []
                    seen: set[str] = set()
                    for item in items:
                        if not isinstance(item, dict):
                            continue
                        name = str(item.get("id") or item.get("name") or "").strip()
                        if not name or name in seen:
                            continue
                        seen.add(name)
                        models.append(name)
                    return {
                        "ok": True,
                        "base_url": candidate,
                        "models": models,
                        "message": f"Fetched {len(models)} model(s).",
                    }
                except Exception as exc:
                    errors.append(f"{candidate}: {exc}")

        return {
            "ok": False,
            "base_url": candidates[0] if candidates else settings.base_url,
            "models": [],
            "message": "All connection attempts failed: " + "; ".join(errors[-3:]),
        }

    async def _chat_json(
        self,
        settings: TranslationSettings,
        messages: list[dict[str, Any]],
        schema_name: str,
        schema: dict[str, Any],
        log_event: LogEvent | None = None,
    ) -> dict[str, Any]:
        timeout_seconds = _effective_timeout_seconds(settings)
        base_payload = {
            "model": settings.model,
            "messages": messages,
            "temperature": settings.temperature,
            "max_tokens": _effective_max_completion_tokens(settings),
        }
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {settings.api_key or 'lm-studio'}",
        }
        candidates = self._candidate_base_urls(settings.base_url)
        last_error: Exception | None = None

        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout_seconds)) as client:
            for url in candidates:
                try:
                    request_modes = (
                        (
                            "strict JSON schema",
                            {**base_payload, "response_format": _schema_payload(schema_name, schema)},
                        ),
                        (
                            "JSON schema without strict enforcement",
                            {
                                **base_payload,
                                "response_format": _schema_payload(schema_name, schema, strict=False),
                            },
                        ),
                        ("prompt-only JSON", base_payload),
                    )
                    for mode_index, (mode_name, request_payload) in enumerate(request_modes):
                        response = await client.post(
                            url + "/chat/completions",
                            json=request_payload,
                            headers=headers,
                        )
                        if response.status_code >= 400:
                            can_fallback = (
                                mode_index < len(request_modes) - 1
                                and _is_structured_output_compatibility_error(response)
                            )
                            if can_fallback:
                                continue
                            response.raise_for_status()

                        level = "info" if mode_index == 0 else "warn"
                        message = f"Model response mode for {schema_name}: {mode_name}"
                        if log_event:
                            log_event(level, message)
                        else:
                            getattr(logger, "warning" if level == "warn" else "info")(message)
                        return _extract_json_blob(_extract_message_text(response.json()))
                except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
                    last_error = exc
                    continue
                except httpx.ReadTimeout:
                    last_error = ModelRequestTimeout(timeout_seconds)
                    continue

        if last_error:
            raise last_error
        raise ValueError("Unable to contact translation service")

    async def build_initial_context(
        self,
        settings: TranslationSettings,
        lines: list[SubtitleLine],
        log_event: LogEvent | None = None,
    ) -> SessionContext:
        subtitle_payload = _build_full_subtitle_card_payload(settings, lines)
        messages = [
            {
                "role": "system",
                "content": _with_target_language_tips(
                    _effective_prompt(settings, "prompt_initial_context_system", DEFAULT_INITIAL_CONTEXT_SYSTEM_PROMPT),
                    settings,
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "title": settings.title,
                        **_language_prompt_payload(settings),
                        "initial_card_strategy_requested": subtitle_payload["requested_strategy"],
                        "initial_card_strategy_used": subtitle_payload["strategy_used"],
                        "full_text_char_count": subtitle_payload["full_text_char_count"],
                        "used_text_char_count": subtitle_payload["used_text_char_count"],
                        "total_subtitle_blocks": subtitle_payload["total_subtitle_blocks"],
                        "subtitle_text": subtitle_payload["subtitle_text"],
                    },
                    ensure_ascii=False,
                ),
            },
        ]
        data = await self._chat_json(
            settings,
            messages,
            "session_context",
            _session_context_schema(),
            log_event=log_event,
        )
        merged = merge_session_context(
            SessionContext(
                movie_title=settings.title,
                source_language=settings.source_language,
                target_language=settings.target_language,
            ),
            data,
        )
        return merged

    async def analyze_visual_scene(
        self,
        settings: TranslationSettings,
        scene_index: int,
        scene_lines: list[SubtitleLine],
        movie_context: SessionContext | None,
        previous_scene: VisualSceneContext | None,
        frames: list[ExtractedVisualFrame],
        log_event: LogEvent | None = None,
    ) -> VisualSceneContext:
        task_payload = {
            "task": (
                "Describe this next visual scene as compact factual evidence for a later subtitle translator. "
                "Treat the images as an ordered sequence. Use the movie card and previous visual scene only to "
                "recognize continuity; do not repeat or trust them when current images contradict them. "
                "Do not translate subtitles, infer hidden events, or claim speaker identity without visible evidence."
            ),
            "scene_index": scene_index,
            "movie_context": movie_context.model_dump() if movie_context else {},
            "previous_visual_scene": previous_scene.model_dump() if previous_scene else {},
            "subtitle_lines": [
                {
                    "position": line.position,
                    "start_time": line.start_time,
                    "end_time": line.end_time,
                    "text": strip_subtitle_formatting(line.text),
                }
                for line in scene_lines
            ],
            "frames": [
                {"image_index": index + 1, "timestamp_ms": frame.timestamp_ms}
                for index, frame in enumerate(frames)
            ],
        }
        content: list[dict[str, Any]] = [
            {"type": "text", "text": json.dumps(task_payload, ensure_ascii=False)}
        ]
        for frame in frames:
            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": frame.as_data_url()},
                }
            )
        messages = [
            {
                "role": "system",
                "content": (
                    "You create factual visual scene cards from ordered video frames. "
                    "Prefer uncertainty over guessing. Return JSON only."
                ),
            },
            {"role": "user", "content": content},
        ]
        if log_event:
            log_event(
                "info",
                f"Analyzing visual scene {scene_index} with {len(scene_lines)} subtitle lines and {len(frames)} frames",
            )
        data = await self._chat_json(
            settings,
            messages,
            "visual_scene_context",
            _visual_scene_context_schema(),
            log_event=log_event,
        )
        return VisualSceneContext(
            scene_index=scene_index,
            start_position=scene_lines[0].position,
            end_position=scene_lines[-1].position,
            start_time=scene_lines[0].start_time,
            end_time=scene_lines[-1].end_time,
            frame_ids=[frame.id for frame in frames],
            **data,
        )

    async def generate_context_from_full_subtitle(
        self,
        settings: TranslationSettings,
        lines: list[SubtitleLine],
        base_context: SessionContext | None = None,
        log_event: LogEvent | None = None,
    ) -> SessionContext:
        subtitle_payload = _build_full_subtitle_card_payload(settings, lines)
        base = deepcopy(base_context) if base_context else SessionContext(
            movie_title=settings.title,
            source_language=settings.source_language,
            target_language=settings.target_language,
        )
        messages = [
            {
                "role": "system",
                "content": _with_target_language_tips(
                    _effective_prompt(
                        settings,
                        "prompt_full_context_refresh_system",
                        DEFAULT_FULL_CONTEXT_REFRESH_SYSTEM_PROMPT,
                    ),
                    settings,
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "title": settings.title,
                        **_language_prompt_payload(settings),
                        "scope": "full subtitle file",
                        "existing_context": base.model_dump(),
                        "initial_card_strategy_requested": subtitle_payload["requested_strategy"],
                        "initial_card_strategy_used": subtitle_payload["strategy_used"],
                        "full_text_char_count": subtitle_payload["full_text_char_count"],
                        "used_text_char_count": subtitle_payload["used_text_char_count"],
                        "total_subtitle_blocks": subtitle_payload["total_subtitle_blocks"],
                        "subtitle_text": subtitle_payload["subtitle_text"],
                    },
                    ensure_ascii=False,
                ),
            },
        ]
        data = await self._chat_json(
            settings,
            messages,
            "session_context_refresh",
            _session_context_schema(),
            log_event=log_event,
        )
        return merge_session_context(base, data)

    async def generate_context_from_lines(
        self,
        settings: TranslationSettings,
        lines: list[SubtitleLine],
        base_context: SessionContext | None = None,
        scope_label: str = "batch",
        max_lines: int = 120,
        log_event: LogEvent | None = None,
    ) -> SessionContext:
        snippet = [
            {"position": line.position, "text": strip_subtitle_formatting(line.text)}
            for line in lines[:max_lines]
        ]
        base = deepcopy(base_context) if base_context else SessionContext(
            movie_title=settings.title,
            source_language=settings.source_language,
            target_language=settings.target_language,
        )
        messages = [
            {
                "role": "system",
                "content": _with_target_language_tips(
                    _effective_prompt(
                        settings,
                        "prompt_batch_context_refresh_system",
                        DEFAULT_BATCH_CONTEXT_REFRESH_SYSTEM_PROMPT,
                    ),
                    settings,
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "title": settings.title,
                        **_language_prompt_payload(settings),
                        "scope": scope_label,
                        "existing_context": base.model_dump(),
                        "lines": snippet,
                    },
                    ensure_ascii=False,
                ),
            },
        ]
        data = await self._chat_json(
            settings,
            messages,
            "session_context_refresh",
            _session_context_schema(),
            log_event=log_event,
        )
        return merge_session_context(base, data)

    async def validate_existing_translation(
        self,
        settings: TranslationSettings,
        source_lines: list[SubtitleLine],
        translated_lines: list[SubtitleLine],
        log_event: LogEvent | None = None,
    ) -> tuple[list[SubtitleValidationIssue], JobValidationStats]:
        issues: list[SubtitleValidationIssue] = []
        stats = JobValidationStats()

        if len(source_lines) != len(translated_lines):
            missing_count = abs(len(source_lines) - len(translated_lines))
            stats.error_subtitles += missing_count
            if log_event:
                log_event(
                    "error",
                    f"Source and translated files have different subtitle counts: {len(source_lines)} vs {len(translated_lines)}",
                )

        paired_count = min(len(source_lines), len(translated_lines))
        if paired_count == 0:
            return issues, stats

        source_batches = chunk_lines(source_lines[:paired_count], settings.batch_size)
        translated_batches = chunk_lines(translated_lines[:paired_count], settings.batch_size)

        for batch_number, (source_batch, translated_batch) in enumerate(
            zip(source_batches, translated_batches, strict=False),
            start=1,
        ):
            validation = _validate_translated_batch(settings, source_batch, translated_batch)
            flagged_positions = _flagged_positions(validation, source_batch, settings)
            if not flagged_positions:
                if log_event:
                    detection_note = validation.detected_language or "unknown"
                    log_event("info", f"Batch {batch_number} passed validation. detected={detection_note}")
                continue

            stats.suspicious_subtitles += len(flagged_positions)
            notes = _validation_notes(validation, settings, flagged_positions)
            translated_by_position = {line.position: line.text for line in translated_batch}
            source_by_position = {line.position: line.text for line in source_batch}
            for position in flagged_positions:
                issues.append(
                    SubtitleValidationIssue(
                        position=position,
                        status="suspect",
                        source_text=source_by_position.get(position, ""),
                        translated_text=translated_by_position.get(position, ""),
                        reason_codes=_reason_codes_for_line(
                            settings,
                            source_by_position.get(position, ""),
                            translated_by_position.get(position, ""),
                            validation,
                            position=position,
                            status="suspect",
                        ),
                        notes=notes,
                        batch_index=batch_number,
                    )
                )
            if log_event:
                log_event(
                    "warn",
                    f"Batch {batch_number} flagged {len(flagged_positions)} suspect subtitle(s): positions {flagged_positions[:8]}",
                )

        if len(source_lines) > paired_count:
            for source_line in source_lines[paired_count:]:
                issues.append(
                    SubtitleValidationIssue(
                        position=source_line.position,
                        status="error",
                        source_text=source_line.text,
                        translated_text="",
                        reason_codes=["missing_output"],
                        notes=["Missing translated subtitle for this source line."],
                    )
                )
        elif len(translated_lines) > paired_count:
            for translated_line in translated_lines[paired_count:]:
                issues.append(
                    SubtitleValidationIssue(
                        position=translated_line.position,
                        status="error",
                        source_text="",
                        translated_text=translated_line.text,
                        reason_codes=["extra_output"],
                        notes=["Translated file has extra subtitle lines beyond the source file."],
                    )
                )

        return issues, stats

    async def _translate_batch_once(
        self,
        settings: TranslationSettings,
        batch_lines: list[SubtitleLine],
        session_context: SessionContext | None,
        reference_subtitles_by_position: dict[int, list[dict[str, Any]]] | None = None,
        visual_scene_contexts: list[VisualSceneContext] | None = None,
        allow_visual_doubts: bool = False,
        include_state_update: bool | None = None,
        extra_instruction: str = "",
        log_event: LogEvent | None = None,
    ) -> tuple[list[SubtitleLine], SessionContext | None, list[VisualDoubt]]:
        include_state_update = settings.structured_context if include_state_update is None else include_state_update
        visual_scene_contexts = _visual_contexts_for_batch_lines(batch_lines, visual_scene_contexts)
        context_payload = session_context.model_dump() if session_context else {}
        line_payload = []
        source_by_position = {line.position: line for line in batch_lines}
        reference_count = 0
        for line in batch_lines:
            protected = protect_subtitle_formatting(line.text)
            item = {
                "position": line.position,
                "text": protected.model_text,
            }
            if allow_visual_doubts:
                item["start_time"] = line.start_time
                item["end_time"] = line.end_time
            references = (reference_subtitles_by_position or {}).get(line.position) or []
            if references:
                reference_count += len(references)
                item["reference_subtitles"] = [
                    {
                        **reference,
                        "text": strip_subtitle_formatting(str(reference.get("text", ""))),
                    }
                    for reference in references
                ]
            line_payload.append(item)
        active_prompt_blocks: list[str] = []
        instruction_parts = [
            _effective_prompt(settings, "prompt_translation_system", DEFAULT_TRANSLATION_SYSTEM_PROMPT)
        ]
        if include_state_update:
            instruction_parts.append(_render_prompt_template(STATE_UPDATE_INSTRUCTION, settings))
            active_prompt_blocks.append("rolling context")
        reference_instruction = _dynamic_reference_instruction(settings, reference_subtitles_by_position)
        if reference_instruction:
            instruction_parts.append(reference_instruction)
            active_prompt_blocks.append("reference evidence")
        if visual_scene_contexts:
            instruction_parts.append(_render_prompt_template(VISUAL_SCENE_EVIDENCE_INSTRUCTION, settings))
            active_prompt_blocks.append("scene evidence")
        if allow_visual_doubts:
            instruction_parts.append(
                ADAPTIVE_VISION_TRANSLATION_INSTRUCTION.format(
                    max_doubts=min(3, int(getattr(settings, "vision_max_doubts", 3) or 3)),
                )
            )
            active_prompt_blocks.append("visual doubts")
        if extra_instruction:
            instruction_parts.append(_render_prompt_template(extra_instruction, settings))
            active_prompt_blocks.append("strict retry")
        system_instruction = _with_target_language_tips(" ".join(instruction_parts), settings)
        user_payload: dict[str, Any] = {
            "title": settings.title,
            **_language_prompt_payload(settings),
            "lines": line_payload,
        }
        if include_state_update:
            user_payload["session_context"] = context_payload
        if visual_scene_contexts:
            user_payload["visual_scene_context"] = [
                item.model_dump() for item in visual_scene_contexts
            ]
        messages = [
            {
                "role": "system",
                "content": system_instruction,
            },
            {
                "role": "user",
                "content": json.dumps(user_payload, ensure_ascii=False),
            },
        ]
        if log_event:
            references_payload = [
                reference
                for item in line_payload
                for reference in item.get("reference_subtitles", [])
            ]
            log_event(
                "info",
                _prompt_size_summary(
                    messages,
                    {
                        "system": system_instruction,
                        "context": _json_for_prompt_size(context_payload) if include_state_update else "",
                        "vision": _json_for_prompt_size(
                            [item.model_dump() for item in (visual_scene_contexts or [])]
                        ),
                        "lines": _json_for_prompt_size(line_payload),
                        "refs": _json_for_prompt_size(references_payload) if reference_count else "",
                    },
                )
                + f"; {len(batch_lines)} source line(s), {reference_count} reference match(es)"
                + f"; active prompt blocks: {', '.join(active_prompt_blocks) if active_prompt_blocks else 'base only'}",
            )
        data = await self._chat_json(
            settings,
            messages,
            "adaptive_translation_batch" if allow_visual_doubts else "translation_batch",
            (
                _adaptive_translation_schema(
                    include_state_update=include_state_update,
                    expected_positions=[line.position for line in batch_lines],
                )
                if allow_visual_doubts
                else _translation_schema(
                    include_state_update=include_state_update,
                    expected_positions=[line.position for line in batch_lines],
                )
            ),
            log_event=log_event,
        )
        expected_positions = {line.position for line in batch_lines}
        translated_by_position: dict[int, SubtitleLine] = {}
        duplicate_positions: set[int] = set()
        unexpected_positions: set[int] = set()
        for item in data.get("translations", []):
            position = int(item["position"])
            if position not in expected_positions:
                unexpected_positions.add(position)
                continue
            if position in translated_by_position:
                duplicate_positions.add(position)
            translated_by_position[position] = SubtitleLine(
                position=position,
                text=restore_subtitle_formatting(
                    source_by_position[position].text,
                    str(item["text"]),
                ),
            )
        for position in duplicate_positions:
            translated_by_position.pop(position, None)
        missing_positions = sorted(expected_positions - translated_by_position.keys())
        if log_event and (missing_positions or duplicate_positions or unexpected_positions):
            details = []
            if missing_positions:
                details.append(f"missing positions {missing_positions[:12]}")
            if duplicate_positions:
                details.append(f"duplicate positions {sorted(duplicate_positions)[:12]}")
            if unexpected_positions:
                details.append(f"unexpected positions {sorted(unexpected_positions)[:12]}")
            log_event("warn", "Malformed translation structure: " + "; ".join(details))
        ordered = [
            translated_by_position.get(line.position, SubtitleLine(position=line.position, text=""))
            for line in batch_lines
        ]
        merged_context = (
            merge_session_context(session_context, data.get("state_update") or {})
            if include_state_update
            else session_context
        )
        visual_doubts: list[VisualDoubt] = []
        if allow_visual_doubts:
            for item in data.get("visual_doubts") or []:
                try:
                    position = int(item.get("position"))
                    source = source_by_position.get(position)
                    if source is not None:
                        item = {
                            **item,
                            "current_translation": restore_subtitle_formatting(
                                source.text,
                                str(item.get("current_translation", "")),
                            ),
                            "alternative_translation": restore_subtitle_formatting(
                                source.text,
                                str(item.get("alternative_translation", "")),
                            ),
                        }
                    visual_doubts.append(VisualDoubt.model_validate(item))
                except Exception:
                    continue
        return ordered, merged_context, visual_doubts

    async def clarify_visual_doubts(
        self,
        settings: TranslationSettings,
        batch_lines: list[SubtitleLine],
        translated_lines: list[SubtitleLine],
        session_context: SessionContext | None,
        doubts: list[VisualDoubt],
        frames: list[ExtractedVisualFrame],
        log_event: LogEvent | None = None,
    ) -> tuple[list[SubtitleLine], list[VisualObservation]]:
        source_by_position = {line.position: line for line in batch_lines}
        translated_by_position = {line.position: line for line in translated_lines}
        requested_positions = {doubt.position for doubt in doubts}
        doubtful_lines = []
        for doubt in doubts:
            source = source_by_position.get(doubt.position)
            provisional = translated_by_position.get(doubt.position)
            if source is None or provisional is None:
                continue
            doubtful_lines.append(
                {
                    "position": doubt.position,
                    "source_text": strip_subtitle_formatting(source.text),
                    "start_time": source.start_time,
                    "end_time": source.end_time,
                    "provisional_translation": provisional.text,
                    "current_translation": doubt.current_translation,
                    "alternative_translation": doubt.alternative_translation,
                    "translation_impact": doubt.translation_impact,
                    "category": doubt.category,
                    "visual_question": doubt.question,
                }
            )

        nearby_positions = {
            position
            for requested in requested_positions
            for position in (requested - 1, requested, requested + 1)
        }
        dialogue_context = [
            {
                "position": line.position,
                "text": strip_subtitle_formatting(line.text),
                "start_time": line.start_time,
                "end_time": line.end_time,
            }
            for line in batch_lines
            if line.position in nearby_positions
        ]
        frame_metadata = [
            {
                "image_index": index + 1,
                "timestamp_ms": frame.timestamp_ms,
                "related_positions": frame.related_positions,
            }
            for index, frame in enumerate(frames)
        ]
        task_payload = {
            "task": (
                "Use each ordered frame sequence to choose between the supplied current and alternative translations. "
                "Do not invent a third translation. Select inconclusive when the images do not visibly decide the stated question. "
                "For speaker gender or identity, use low confidence or inconclusive unless the visible sequence strongly links "
                "the person to the subtitle."
            ),
            **_language_prompt_payload(settings),
            "session_context": session_context.model_dump() if session_context else {},
            "doubtful_lines": doubtful_lines,
            "dialogue_context": dialogue_context,
            "frames": frame_metadata,
        }
        content: list[dict[str, Any]] = [
            {
                "type": "text",
                "text": json.dumps(task_payload, ensure_ascii=False),
            }
        ]
        for frame in frames:
            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": frame.as_data_url()},
                }
            )
        messages: list[dict[str, Any]] = [
            {
                "role": "system",
                "content": (
                    "You are resolving bounded visual ambiguities in subtitle translation. "
                    "Use only the supplied images and text. Return JSON only. "
                    "Choose only current, alternative, or inconclusive for requested positions. "
                    "Do not infer a person's gender or identity from appearance alone when the speaker link is uncertain."
                ),
            },
            {"role": "user", "content": content},
        ]
        if log_event:
            log_event(
                "info",
                f"Submitting one visual clarification request for {len(doubtful_lines)} line(s) with {len(frames)} frame(s)",
            )
        data = await self._chat_json(
            settings,
            messages,
            "visual_subtitle_clarification",
            _visual_clarification_schema(),
            log_event=log_event,
        )

        observations: list[VisualObservation] = []
        doubt_by_position = {doubt.position: doubt for doubt in doubts}
        for item in data.get("decisions") or []:
            try:
                position = int(item.get("position"))
            except (TypeError, ValueError):
                continue
            doubt = doubt_by_position.get(position)
            if doubt is None:
                continue
            selected = str(item.get("selected") or "inconclusive").strip()
            evidence_found = bool(item.get("evidence_found"))
            confidence = str(item.get("confidence") or "unknown").strip()
            answer = str(item.get("answer") or "").strip()
            source = source_by_position.get(position)
            text = (
                doubt.alternative_translation.strip()
                if selected == "alternative"
                and evidence_found
                and confidence == "high"
                else translated_by_position[position].text
            )
            if (
                position in requested_positions
                and source is not None
                and text
                and not (
                    _normalize_text(source.text).casefold()
                    == _normalize_text(text).casefold()
                    and not _looks_like_unchanged_proper_name(
                        source.text,
                        text,
                        session_context,
                    )
                )
                and not _line_looks_untranslated(source.text, text, session_context)
            ):
                translated_by_position[position] = SubtitleLine(position=position, text=text)
            observations.append(
                VisualObservation(
                    position=position,
                    category=doubt.category,
                    answer=answer,
                    confidence=confidence,
                )
            )

        return _ordered_lines_from_map(batch_lines, translated_by_position), observations

    async def retranslate_line(
        self,
        settings: TranslationSettings,
        source_line: SubtitleLine,
        current_translation: SubtitleLine | None,
        session_context: SessionContext | None,
        reference_subtitles: list[dict[str, Any]] | None = None,
        extra_instruction: str = "",
        batch_index: int | None = None,
        log_event: LogEvent | None = None,
    ) -> tuple[SubtitleLine, BatchProcessingStats]:
        instruction_parts = [
            _effective_prompt(settings, "prompt_line_revision_system", DEFAULT_LINE_REVISION_SYSTEM_PROMPT)
        ]
        reference_instruction = _dynamic_reference_instruction(
            settings,
            {source_line.position: reference_subtitles or []},
        )
        if reference_instruction:
            instruction_parts.append(reference_instruction)
        if extra_instruction.strip():
            instruction_parts.append(
                "Additional instruction: "
                + _render_prompt_template(extra_instruction.strip(), settings)
            )
        instruction_parts.append(
            "Copy every [[SUBFMT_N]] and [[SUBBR_N]] marker from source_text exactly once, unchanged and in the same order."
        )
        system_instruction = _with_target_language_tips(" ".join(instruction_parts), settings)

        protected_source = protect_subtitle_formatting(source_line.text)
        line_payload: dict[str, Any] = {
            "position": source_line.position,
            "source_text": protected_source.model_text,
            "current_translation": (
                strip_subtitle_formatting(current_translation.text)
                if current_translation
                else ""
            ),
        }
        if reference_subtitles:
            line_payload["reference_subtitles"] = [
                {
                    **reference,
                    "text": strip_subtitle_formatting(str(reference.get("text", ""))),
                }
                for reference in reference_subtitles
            ]

        messages = [
            {
                "role": "system",
                "content": system_instruction,
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "title": settings.title,
                        **_language_prompt_payload(settings),
                        "session_context": session_context.model_dump() if session_context else {},
                        "line": line_payload,
                    },
                    ensure_ascii=False,
                ),
            },
        ]
        if log_event:
            log_event("info", f"Submitting isolated revision request for line {source_line.position + 1}")
        data = await self._chat_json(
            settings,
            messages,
            "subtitle_line_revision",
            _single_line_revision_schema(),
            log_event=log_event,
        )
        revised_line = SubtitleLine(
            position=source_line.position,
            text=restore_subtitle_formatting(source_line.text, str(data.get("text", ""))),
        )
        validation = _validate_translated_batch(settings, [source_line], [revised_line], session_context)
        flagged_positions = _flagged_positions(validation, [source_line], settings)
        if flagged_positions:
            notes = _validation_notes(validation, settings, flagged_positions)
            if extra_instruction.strip():
                notes.append("Retranslation used extra review instruction.")
            if log_event:
                log_event(
                    "error",
                    f"Retranslated line {source_line.position + 1} still looks suspicious: {validation.reason or 'validator still suspicious'}",
                )
            return revised_line, BatchProcessingStats(
                suspicious_count=len(flagged_positions),
                error_count=len(flagged_positions),
                issues=_build_validation_issues(
                    settings,
                    "error",
                    flagged_positions,
                    [source_line],
                    [revised_line],
                    batch_index,
                    notes,
                    validation=validation,
                    session_context=session_context,
                ),
            )

        notes = ["Line retranslated from the review panel."]
        if extra_instruction.strip():
            notes.append("Retranslation used extra review instruction.")
        if log_event:
            log_event("info", f"Retranslated line {source_line.position + 1} passed validation")
        return revised_line, BatchProcessingStats(
            fixed_count=1,
            issues=_build_validation_issues(
                settings,
                "auto_fixed",
                [source_line.position],
                [source_line],
                [revised_line],
                batch_index,
                notes,
                extra_codes=["manual_retranslation"],
                session_context=session_context,
            ),
        )

    async def _repair_suspicious_lines(
        self,
        settings: TranslationSettings,
        batch_lines: list[SubtitleLine],
        translated_lines: list[SubtitleLine],
        session_context: SessionContext | None,
        suspicious_positions: list[int],
        reference_subtitles_by_position: dict[int, list[dict[str, Any]]] | None = None,
        batch_index: int | None = None,
        log_event: LogEvent | None = None,
        should_stop: StopCheck | None = None,
        partial_update: PartialBatchUpdate | None = None,
    ) -> tuple[list[SubtitleLine], BatchProcessingStats]:
        _raise_if_stop_requested(should_stop)
        if not suspicious_positions:
            return translated_lines, BatchProcessingStats()

        translated_by_position = {line.position: line for line in translated_lines}
        source_by_position = {line.position: line for line in batch_lines}
        repair_stats = BatchProcessingStats(
            suspicious_count=len(suspicious_positions),
            retried_batches=1,
        )

        for position in suspicious_positions:
            _raise_if_stop_requested(should_stop)
            source_line = source_by_position.get(position)
            if source_line is None:
                continue
            if log_event:
                log_event("warn", f"Retrying suspicious line {position + 1} with a lightweight line-only request")

            retried_line = await self._retry_line_lightweight(
                settings,
                source_line,
                translated_by_position.get(position),
                session_context,
                batch_lines,
                reference_subtitles=(reference_subtitles_by_position or {}).get(position) or [],
                log_event=log_event,
            )
            _raise_if_stop_requested(should_stop)
            retried_validation = _validate_translated_batch(
                settings,
                [source_line],
                [retried_line],
                session_context,
            )
            flagged_positions = _flagged_positions(retried_validation, [source_line], settings)
            if flagged_positions:
                translated_by_position[position] = retried_line
                repair_stats.error_count += 1
                notes = _validation_notes(retried_validation, settings, flagged_positions)
                line_issues = _build_validation_issues(
                    settings,
                    "error",
                    flagged_positions,
                    [source_line],
                    [retried_line],
                    batch_index,
                    notes,
                    validation=retried_validation,
                    session_context=session_context,
                )
                repair_stats.issues.extend(line_issues)
                if log_event:
                    log_event(
                        "error",
                        f"Isolated retry still failed for line {position + 1}: {retried_validation.reason or 'validator still suspicious'}",
                    )
            else:
                repair_stats.fixed_count += 1
                translated_by_position[position] = retried_line
                line_issues = _build_validation_issues(
                    settings,
                    "auto_fixed",
                    [position],
                    [source_line],
                    [retried_line],
                    batch_index,
                    ["Validation cleared after isolated retry."],
                    extra_codes=["isolated_retry"],
                    session_context=session_context,
                )
                repair_stats.issues.extend(line_issues)
                if log_event:
                    log_event("info", f"Isolated retry fixed line {position + 1}")
            if partial_update:
                remaining_positions = [
                    item
                    for item in suspicious_positions
                    if item > position
                ]
                partial_update(
                    [retried_line],
                    line_issues,
                    "isolated repair",
                    remaining_positions,
                )

        return _ordered_lines_from_map(batch_lines, translated_by_position), repair_stats

    async def _retry_line_lightweight(
        self,
        settings: TranslationSettings,
        source_line: SubtitleLine,
        current_translation: SubtitleLine | None,
        session_context: SessionContext | None,
        batch_lines: list[SubtitleLine],
        reference_subtitles: list[dict[str, Any]],
        log_event: LogEvent | None = None,
    ) -> SubtitleLine:
        compact_context: dict[str, Any] = {}
        if session_context:
            compact_context = {
                "scene_context": session_context.scene_context,
                "characters": [
                    {
                        "name": character.name,
                        "aliases": character.aliases,
                        "gender": character.gender,
                    }
                    for character in session_context.characters
                ],
                "glossary": [
                    {
                        "term": entry.term,
                        "meaning": entry.meaning,
                        "keep": entry.keep,
                    }
                    for entry in session_context.glossary
                ],
            }

        nearby = [
            {"position": line.position, "text": strip_subtitle_formatting(line.text)}
            for line in batch_lines
            if abs(line.position - source_line.position) <= 1
            and line.position != source_line.position
        ]
        instruction_parts = [
            _render_prompt_template(
                "Translate one subtitle line from {{source_language}} into {{target_language}}. "
                "Return only JSON with the final text. Preserve proper names unchanged when appropriate. "
                "Use nearby_lines only as context. Translate only the target line and do not pull text from adjacent subtitle positions. "
                "Copy every [[SUBFMT_N]] and [[SUBBR_N]] marker from source_text exactly once, unchanged and in the same order. "
                "Do not update context or explain your reasoning.",
                settings,
            ),
            _effective_prompt(
                settings,
                "prompt_translation_strict_retry",
                DEFAULT_STRICT_RETRY_PROMPT,
            ),
        ]
        reference_instruction = _dynamic_reference_instruction(
            settings,
            {source_line.position: reference_subtitles},
        )
        if reference_instruction:
            instruction_parts.append(reference_instruction)
        system_instruction = _with_target_language_tips(" ".join(instruction_parts), settings)
        protected_source = protect_subtitle_formatting(source_line.text)
        line_payload: dict[str, Any] = {
            "position": source_line.position,
            "source_text": protected_source.model_text,
            "current_translation": (
                strip_subtitle_formatting(current_translation.text)
                if current_translation
                else ""
            ),
        }
        if reference_subtitles:
            line_payload["reference_subtitles"] = [
                {
                    **reference,
                    "text": strip_subtitle_formatting(str(reference.get("text", ""))),
                }
                for reference in reference_subtitles
            ]
        messages = [
            {"role": "system", "content": system_instruction},
            {
                "role": "user",
                "content": json.dumps(
                    {
                        **_language_prompt_payload(settings),
                        "context": compact_context,
                        "nearby_lines": nearby,
                        "line": line_payload,
                    },
                    ensure_ascii=False,
                ),
            },
        ]
        if log_event:
            log_event(
                "info",
                _prompt_size_summary(
                    messages,
                    {
                        "system": system_instruction,
                        "context": _json_for_prompt_size(compact_context),
                        "line": _json_for_prompt_size(messages[1]["content"]),
                    },
                ),
            )
        data = await self._chat_json(
            settings,
            messages,
            "subtitle_line_retry",
            _single_line_revision_schema(),
            log_event=log_event,
        )
        return SubtitleLine(
            position=source_line.position,
            text=restore_subtitle_formatting(
                source_line.text,
                str(data.get("text") or "").strip(),
            ),
        )

    async def _split_batch_and_translate(
        self,
        settings: TranslationSettings,
        batch_lines: list[SubtitleLine],
        session_context: SessionContext | None,
        reference_subtitles_by_position: dict[int, list[dict[str, Any]]] | None = None,
        visual_scene_contexts: list[VisualSceneContext] | None = None,
        batch_index: int | None = None,
        log_event: LogEvent | None = None,
        depth: int = 0,
        reason: str = "Splitting batch",
        should_stop: StopCheck | None = None,
        partial_update: PartialBatchUpdate | None = None,
    ) -> tuple[list[SubtitleLine], SessionContext | None, BatchProcessingStats]:
        _raise_if_stop_requested(should_stop)
        midpoint = max(1, len(batch_lines) // 2)
        first_half, second_half = batch_lines[:midpoint], batch_lines[midpoint:]
        if log_event:
            log_event(
                "warn",
                f"{reason}; splitting batch into chunks of {len(first_half)} and {len(second_half)} lines",
            )
        translated_first, context_after_first, first_stats = await self._translate_batch_with_validation(
            settings,
            first_half,
            session_context,
            reference_subtitles_by_position=reference_subtitles_by_position,
            visual_scene_contexts=visual_scene_contexts,
            batch_index=batch_index,
            log_event=log_event,
            depth=depth + 1,
            should_stop=should_stop,
            partial_update=partial_update,
        )
        _raise_if_stop_requested(should_stop)
        translated_second, context_after_second, second_stats = await self._translate_batch_with_validation(
            settings,
            second_half,
            context_after_first,
            reference_subtitles_by_position=reference_subtitles_by_position,
            visual_scene_contexts=visual_scene_contexts,
            batch_index=batch_index,
            log_event=log_event,
            depth=depth + 1,
            should_stop=should_stop,
            partial_update=partial_update,
        )
        merged_stats = BatchProcessingStats(retried_batches=1, split_batches=1)
        merged_stats.merge(first_stats).merge(second_stats)
        return [*translated_first, *translated_second], context_after_second, merged_stats

    async def _translate_batch_with_validation(
        self,
        settings: TranslationSettings,
        batch_lines: list[SubtitleLine],
        session_context: SessionContext | None,
        reference_subtitles_by_position: dict[int, list[dict[str, Any]]] | None = None,
        visual_scene_contexts: list[VisualSceneContext] | None = None,
        batch_index: int | None = None,
        log_event: LogEvent | None = None,
        depth: int = 0,
        should_stop: StopCheck | None = None,
        partial_update: PartialBatchUpdate | None = None,
    ) -> tuple[list[SubtitleLine], SessionContext | None, BatchProcessingStats]:
        _raise_if_stop_requested(should_stop)
        strict_retry_instruction = _effective_prompt(
            settings,
            "prompt_translation_strict_retry",
            DEFAULT_STRICT_RETRY_PROMPT,
        )
        if log_event:
            log_event("info", f"Submitting batch to model with {len(batch_lines)} lines")
        try:
            translated_lines, merged_context, visual_doubts = await self._translate_batch_once(
                settings,
                batch_lines,
                session_context,
                reference_subtitles_by_position=reference_subtitles_by_position,
                visual_scene_contexts=visual_scene_contexts,
                allow_visual_doubts=bool(getattr(settings, "adaptive_vision", False)),
                log_event=log_event,
            )
        except ModelRequestTimeout as exc:
            _raise_if_stop_requested(should_stop)
            if len(batch_lines) > 1 and depth < 4:
                return await self._split_batch_and_translate(
                    settings,
                    batch_lines,
                    session_context,
                    reference_subtitles_by_position=reference_subtitles_by_position,
                    visual_scene_contexts=visual_scene_contexts,
                    batch_index=batch_index,
                    log_event=log_event,
                    depth=depth,
                    reason=_timeout_guidance(exc.seconds),
                    should_stop=should_stop,
                    partial_update=partial_update,
                )
            if log_event:
                log_event("error", _timeout_guidance(exc.seconds))
            raise
        _raise_if_stop_requested(should_stop)

        def validate(lines: list[SubtitleLine]) -> tuple[BatchValidationResult, list[int]]:
            result = _validate_translated_batch(settings, batch_lines, lines, merged_context)
            return result, _flagged_positions(result, batch_lines, settings)

        def log_validation(label: str, validation: BatchValidationResult) -> None:
            if not log_event:
                return
            detection_note = (
                f"detected output language: {validation.detected_language}"
                if validation.detected_language
                else "language detector had no confident batch result"
            )
            if validation.suspicious_positions:
                detection_note += f"; suspicious line positions: {validation.suspicious_positions[:8]}"
            log_event(
                "warn" if validation.failed else "info",
                f"Validation {label}: {detection_note}"
                + (f"; reason: {validation.reason}" if validation.reason else ""),
            )

        validation, flagged_positions = validate(translated_lines)
        log_validation("after initial translation", validation)
        live_issues = _build_validation_issues(
            settings,
            "suspect",
            flagged_positions,
            batch_lines,
            translated_lines,
            batch_index,
            ["Initial translation is visible while automatic recovery runs.", *_validation_notes(validation, settings, flagged_positions)],
            validation=validation,
            session_context=merged_context,
        ) if flagged_positions else []
        if partial_update:
            partial_update(
                translated_lines,
                live_issues,
                "checking translation" if flagged_positions else "translated",
                flagged_positions,
            )

        if not validation.failed:
            if not flagged_positions:
                return translated_lines, merged_context, BatchProcessingStats(visual_doubts=visual_doubts)
            strong_positions = _strong_repair_positions(
                settings,
                batch_lines,
                translated_lines,
                validation,
                flagged_positions,
                merged_context,
            )[:MAX_ISOLATED_REPAIRS_PER_BATCH]
            if not strong_positions:
                return translated_lines, merged_context, BatchProcessingStats(
                    suspicious_count=len(flagged_positions),
                    issues=live_issues,
                    visual_doubts=visual_doubts,
                )
            repaired_lines, repair_stats = await self._repair_suspicious_lines(
                settings,
                batch_lines,
                translated_lines,
                merged_context,
                strong_positions,
                reference_subtitles_by_position=reference_subtitles_by_position,
                batch_index=batch_index,
                log_event=log_event,
                should_stop=should_stop,
                partial_update=partial_update,
            )
            untouched_positions = [position for position in flagged_positions if position not in strong_positions]
            if untouched_positions:
                repair_stats.suspicious_count += len(untouched_positions)
                repair_stats.issues.extend(
                    _build_validation_issues(
                        settings,
                        "suspect",
                        untouched_positions,
                        batch_lines,
                        repaired_lines,
                        batch_index,
                        _validation_notes(validation, settings, untouched_positions),
                        validation=validation,
                        session_context=merged_context,
                    )
                )
            repair_stats.visual_doubts.extend(visual_doubts)
            return repaired_lines, merged_context, repair_stats

        recovery_positions = flagged_positions or [line.position for line in batch_lines]
        recovery_lines = [line for line in batch_lines if line.position in set(recovery_positions)]
        if log_event:
            log_event(
                "warn",
                f"Retrying only {len(recovery_lines)} failed line(s); valid translations remain visible",
            )
        recovered_lines: list[SubtitleLine] = []
        recovery_chunks = (
            [recovery_lines[index:index + 4] for index in range(0, len(recovery_lines), 4)]
            if validation.sequence_drift_positions
            else [recovery_lines]
        )
        if validation.sequence_drift_positions and log_event:
            log_event(
                "warn",
                "Neighboring-cue drift detected; retrying in anchored groups of at most four lines",
            )
        for recovery_chunk in recovery_chunks:
            try:
                chunk_lines_result, _, _ = await self._translate_batch_once(
                    settings,
                    recovery_chunk,
                    merged_context,
                    reference_subtitles_by_position=reference_subtitles_by_position,
                    visual_scene_contexts=visual_scene_contexts,
                    allow_visual_doubts=False,
                    include_state_update=False,
                    extra_instruction=strict_retry_instruction,
                    log_event=log_event,
                )
                recovered_lines.extend(chunk_lines_result)
            except ModelRequestTimeout as exc:
                if log_event:
                    log_event(
                        "warn",
                        _timeout_guidance(exc.seconds) + "; continuing with bounded line repair",
                    )
        _raise_if_stop_requested(should_stop)

        translated_by_position = {line.position: line for line in translated_lines}
        before_recovery = {
            position: translated_by_position.get(position, SubtitleLine(position=position, text="")).text
            for position in recovery_positions
        }
        for line in recovered_lines:
            if line.text.strip():
                translated_by_position[line.position] = line
        merged_lines = [
            translated_by_position.get(line.position, SubtitleLine(position=line.position, text=""))
            for line in batch_lines
        ]
        recovery_validation, remaining_positions = validate(merged_lines)
        log_validation("after targeted retry", recovery_validation)
        if log_event and remaining_positions and all(
            translated_by_position.get(position, SubtitleLine(position=position, text="")).text
            == before_recovery.get(position, "")
            for position in remaining_positions
        ):
            log_event("warn", "Targeted retry made no progress on the remaining failed lines; recursive splitting was skipped")

        fixed_after_targeted = [position for position in recovery_positions if position not in remaining_positions]
        targeted_live_issues = [
            *_build_validation_issues(
                settings,
                "auto_fixed",
                fixed_after_targeted,
                batch_lines,
                merged_lines,
                batch_index,
                ["Validation cleared after targeted retry."],
                extra_codes=["retry_fixed"],
                session_context=merged_context,
            ),
            *_build_validation_issues(
                settings,
                "suspect",
                remaining_positions,
                batch_lines,
                merged_lines,
                batch_index,
                ["Targeted retry did not clear this line; bounded isolated repair may follow.", *_validation_notes(recovery_validation, settings, remaining_positions)],
                validation=recovery_validation,
                session_context=merged_context,
            ),
        ]
        if partial_update:
            partial_update(merged_lines, targeted_live_issues, "targeted retry", remaining_positions)

        if remaining_positions:
            repair_positions = remaining_positions[:MAX_ISOLATED_REPAIRS_PER_BATCH]
            merged_lines, _ = await self._repair_suspicious_lines(
                settings,
                batch_lines,
                merged_lines,
                merged_context,
                repair_positions,
                reference_subtitles_by_position=reference_subtitles_by_position,
                batch_index=batch_index,
                log_event=log_event,
                should_stop=should_stop,
                partial_update=partial_update,
            )

        final_validation, final_failed_positions = validate(merged_lines)
        fixed_positions = [position for position in recovery_positions if position not in final_failed_positions]
        final_issues = [
            *_build_validation_issues(
                settings,
                "auto_fixed",
                fixed_positions,
                batch_lines,
                merged_lines,
                batch_index,
                ["Validation cleared during bounded recovery."],
                extra_codes=["retry_fixed"],
                session_context=merged_context,
            ),
            *_build_validation_issues(
                settings,
                "error",
                final_failed_positions,
                batch_lines,
                merged_lines,
                batch_index,
                ["Automatic recovery stopped at the per-batch safety limit.", *_validation_notes(final_validation, settings, final_failed_positions)],
                validation=final_validation,
                session_context=merged_context,
            ),
        ]
        if partial_update:
            partial_update(merged_lines, final_issues, "recovery complete", [])
        if final_failed_positions and log_event:
            log_event(
                "error",
                f"Bounded recovery stopped with {len(final_failed_positions)} unresolved line(s): {final_failed_positions[:12]}",
            )
        return merged_lines, merged_context, BatchProcessingStats(
            suspicious_count=len(recovery_positions),
            fixed_count=len(fixed_positions),
            error_count=len(final_failed_positions),
            retried_batches=1 + (1 if remaining_positions else 0),
            issues=final_issues,
            visual_doubts=visual_doubts,
        )

    async def translate_batch(
        self,
        settings: TranslationSettings,
        batch_lines: list[SubtitleLine],
        session_context: SessionContext | None,
        reference_subtitles_by_position: dict[int, list[dict[str, Any]]] | None = None,
        visual_scene_contexts: list[VisualSceneContext] | None = None,
        batch_index: int | None = None,
        log_event: LogEvent | None = None,
        should_stop: StopCheck | None = None,
        partial_update: PartialBatchUpdate | None = None,
    ) -> tuple[list[SubtitleLine], SessionContext | None, BatchProcessingStats]:
        return await self._translate_batch_with_validation(
            settings,
            batch_lines,
            session_context,
            reference_subtitles_by_position=reference_subtitles_by_position,
            visual_scene_contexts=visual_scene_contexts,
            batch_index=batch_index,
            log_event=log_event,
            should_stop=should_stop,
            partial_update=partial_update,
        )
