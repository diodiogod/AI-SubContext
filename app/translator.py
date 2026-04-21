from __future__ import annotations

import json
import os
import platform
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse, urlunparse

import httpx

from app.config import TranslationSettings
from app.models import JobValidationStats, SessionContext, SubtitleLine, SubtitleValidationIssue
from app.srt_utils import chunk_lines

try:
    from fast_langdetect import LangDetectConfig, LangDetector
except Exception:  # pragma: no cover - dependency is optional at import time
    LangDetectConfig = None
    LangDetector = None

_WORD_RE = re.compile(r"[A-Za-zÀ-ÿ']+")
_LANGUAGE_DETECTOR: Any = None
_LANGUAGE_DETECTOR_FAILED = False

_STRICT_RETRY_INSTRUCTION = (
    "Validation warning: previous output may have left lines untranslated or in the source language. "
    "Translate every line fully into the target language. Do not keep source-language text unless it is a proper name "
    "or a term explicitly marked to keep in the context glossary. Preserve line order and return all positions."
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


@dataclass
class BatchValidationResult:
    failed: bool
    suspicious_positions: list[int]
    detected_language: str | None
    reason: str


@dataclass
class BatchProcessingStats:
    suspicious_count: int = 0
    fixed_count: int = 0
    error_count: int = 0
    retried_batches: int = 0
    split_batches: int = 0
    issues: list[SubtitleValidationIssue] = field(default_factory=list)

    def merge(self, other: "BatchProcessingStats") -> "BatchProcessingStats":
        self.suspicious_count += other.suspicious_count
        self.fixed_count += other.fixed_count
        self.error_count += other.error_count
        self.retried_batches += other.retried_batches
        self.split_batches += other.split_batches
        self.issues.extend(other.issues)
        return self


LogEvent = Callable[[str, str], None]

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
    return json.loads(text[start:end + 1])


def _clean_subtitle_block_text(value: str) -> str:
    parts = [" ".join(part.split()) for part in str(value or "").splitlines()]
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


def _schema_payload(name: str, schema: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": name,
            "schema": schema,
        },
    }


def _session_context_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "premise": {"type": "string"},
            "tone": {"type": "string"},
            "scene_context": {"type": "string"},
            "style_notes": {"type": "array", "items": {"type": "string"}},
            "characters": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "name": {"type": "string"},
                        "role": {"type": "string"},
                        "aliases": {"type": "array", "items": {"type": "string"}},
                        "gender": {"type": "string", "enum": ["f", "m", "neutral", "unknown"]},
                    },
                    "required": ["name", "role", "aliases", "gender"],
                },
            },
            "glossary": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "term": {"type": "string"},
                        "meaning": {"type": "string"},
                        "keep": {"type": "boolean"},
                    },
                    "required": ["term", "meaning", "keep"],
                },
            },
            "unresolved_ambiguities": {"type": "array", "items": {"type": "string"}},
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


def _translation_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "translations": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "position": {"type": "integer"},
                        "text": {"type": "string"},
                    },
                    "required": ["position", "text"],
                },
            },
            "state_update": _session_context_schema(),
        },
        "required": ["translations", "state_update"],
    }


def _single_line_revision_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "text": {"type": "string"},
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
    return " ".join(str(value or "").strip().split())


def _word_tokens(value: str) -> list[str]:
    return [token.lower() for token in _WORD_RE.findall(value) if len(token) > 1]


def _alpha_character_count(value: str) -> int:
    return sum(1 for char in value if char.isalpha())


def _line_looks_untranslated(source_text: str, translated_text: str) -> bool:
    source = _normalize_text(source_text)
    translated = _normalize_text(translated_text)
    if not translated:
        return True
    if len(source) >= 8 and source.casefold() == translated.casefold():
        return True

    source_tokens = set(_word_tokens(source))
    translated_tokens = set(_word_tokens(translated))
    if len(source_tokens) < 3 or len(translated_tokens) < 3:
        return False

    overlap = len(source_tokens & translated_tokens) / max(1, len(source_tokens))
    return overlap >= 0.82


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
) -> BatchValidationResult:
    source_code = _normalize_language_code(settings.source_language)
    target_code = _normalize_language_code(settings.target_language)
    if not source_code or not target_code or source_code == target_code:
        return BatchValidationResult(False, [], None, "")

    suspicious_positions = [
        source.position
        for source, translated in zip(batch_lines, translated_lines, strict=False)
        if _line_looks_untranslated(source.text, translated.text)
    ]
    translated_batch_text = " ".join(
        translated.text for translated in translated_lines if _alpha_character_count(translated.text) >= 4
    )
    detected_language = _detect_language_code(translated_batch_text)

    failed = False
    reasons: list[str] = []
    if suspicious_positions and len(suspicious_positions) >= _batch_failure_threshold(len(batch_lines)):
        failed = True
        reasons.append(f"suspicious untranslated lines: {suspicious_positions[:5]}")
    if detected_language == source_code:
        failed = True
        reasons.append(f"batch output still looks like source language '{source_code}'")

    return BatchValidationResult(
        failed=failed,
        suspicious_positions=suspicious_positions,
        detected_language=detected_language,
        reason="; ".join(reasons),
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
    if flagged_positions:
        notes.append("Line still looks untranslated or too close to the source text.")
    source_code = _normalize_language_code(settings.source_language)
    if validation.detected_language and validation.detected_language == source_code:
        notes.append(f"Batch output still looks like source language '{source_code}'.")
    if validation.reason:
        notes.append(validation.reason)
    return notes


def _reason_codes_for_line(
    settings: TranslationSettings,
    source_text: str,
    translated_text: str,
    validation: BatchValidationResult | None = None,
    *,
    status: str = "suspect",
    extra_codes: list[str] | None = None,
) -> list[str]:
    codes: list[str] = list(extra_codes or [])
    source = _normalize_text(source_text)
    translated = _normalize_text(translated_text)
    source_code = _normalize_language_code(settings.source_language)

    if not translated:
        codes.append("missing_output")
    elif len(source) >= 8 and source.casefold() == translated.casefold():
        codes.append("unchanged_from_source")
    elif _line_looks_untranslated(source, translated):
        codes.append("source_language_leak")

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
        self.timeout = httpx.Timeout(300.0)

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
        messages: list[dict[str, str]],
        schema_name: str,
        schema: dict[str, Any],
    ) -> dict[str, Any]:
        payload = {
            "model": settings.model,
            "messages": messages,
            "temperature": settings.temperature,
            "response_format": _schema_payload(schema_name, schema),
        }
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {settings.api_key or 'lm-studio'}",
        }
        candidates = self._candidate_base_urls(settings.base_url)
        last_error: Exception | None = None

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            for url in candidates:
                try:
                    response = await client.post(url + "/chat/completions", json=payload, headers=headers)
                    if response.status_code >= 400:
                        detail = response.text
                        if "response_format.type" in detail or "json_schema" in detail:
                            fallback_payload = dict(payload)
                            fallback_payload.pop("response_format", None)
                            response = await client.post(url + "/chat/completions", json=fallback_payload, headers=headers)
                            response.raise_for_status()
                            return _extract_json_blob(_extract_message_text(response.json()))
                        response.raise_for_status()
                    return _extract_json_blob(_extract_message_text(response.json()))
                except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout) as exc:
                    last_error = exc
                    continue

        if last_error:
            raise last_error
        raise ValueError("Unable to contact translation service")

    async def build_initial_context(
        self,
        settings: TranslationSettings,
        lines: list[SubtitleLine],
    ) -> SessionContext:
        subtitle_payload = _build_full_subtitle_card_payload(settings, lines)
        messages = [
            {
                "role": "system",
                "content": (
                    "You are preparing a compact movie subtitle translation card. "
                    "Use only evidence from the provided cleaned subtitle text. "
                    "Ignore timestamps, translation instructions, formatting instructions, JSON-related wording, opening-credit boilerplate, and song-only metadata. "
                    "Do not describe the translation task itself. "
                    "Do not mention source language, target language, subtitle translation, subtitles, movie card, context card, or the title as metadata. "
                    "Premise must describe the story or setup only when the evidence is strong enough; otherwise leave it empty. "
                    "Style notes must describe real narrative, dialog, register, or recurring linguistic traits from the subtitle text, not generic instructions. "
                    "Infer only stable facts. Prefer unknown over guessing."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "title": settings.title,
                        "source_language": settings.source_language,
                        "target_language": settings.target_language,
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
        data = await self._chat_json(settings, messages, "session_context", _session_context_schema())
        merged = merge_session_context(
            SessionContext(
                movie_title=settings.title,
                source_language=settings.source_language,
                target_language=settings.target_language,
            ),
            data,
        )
        return merged

    async def generate_context_from_full_subtitle(
        self,
        settings: TranslationSettings,
        lines: list[SubtitleLine],
        base_context: SessionContext | None = None,
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
                "content": (
                    "You are refreshing a compact subtitle translation context card from cleaned subtitle text covering the whole title. "
                    "Use the existing card as a base, revise only with evidence from the provided text, and prefer unknown over guessing. "
                    "Ignore timestamps, translation instructions, formatting instructions, JSON-related wording, opening-credit boilerplate, and song-only metadata. "
                    "Do not describe the translation task itself. "
                    "Do not mention source language, target language, subtitle translation, subtitles, movie card, context card, or the title as metadata. "
                    "Keep premise for stable whole-title facts only. "
                    "Return JSON only."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "title": settings.title,
                        "source_language": settings.source_language,
                        "target_language": settings.target_language,
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
        data = await self._chat_json(settings, messages, "session_context_refresh", _session_context_schema())
        return merge_session_context(base, data)

    async def generate_context_from_lines(
        self,
        settings: TranslationSettings,
        lines: list[SubtitleLine],
        base_context: SessionContext | None = None,
        scope_label: str = "batch",
        max_lines: int = 120,
    ) -> SessionContext:
        snippet = [{"position": line.position, "text": line.text} for line in lines[:max_lines]]
        base = deepcopy(base_context) if base_context else SessionContext(
            movie_title=settings.title,
            source_language=settings.source_language,
            target_language=settings.target_language,
        )
        messages = [
            {
                "role": "system",
                "content": (
                    "You are updating a compact subtitle translation context card. "
                    "Use the existing card as a base, revise only with evidence from the provided subtitle lines, "
                    "and prefer unknown over guessing. "
                    "Keep premise for stable whole-title facts, but make scene_context describe the local scene or conversation in these lines only. "
                    "Do not restate the full movie setup in scene_context unless these lines genuinely cover that setup. "
                    "Return JSON only."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "title": settings.title,
                        "source_language": settings.source_language,
                        "target_language": settings.target_language,
                        "scope": scope_label,
                        "existing_context": base.model_dump(),
                        "lines": snippet,
                    },
                    ensure_ascii=False,
                ),
            },
        ]
        data = await self._chat_json(settings, messages, "session_context_refresh", _session_context_schema())
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
        extra_instruction: str = "",
    ) -> tuple[list[SubtitleLine], SessionContext | None]:
        system_instruction = (
            "You are an expert subtitle translator. "
            "Translate naturally, preserve subtitle meaning, punctuation, and line intent. "
            "Return JSON only. Also return a compact state_update for future batches. "
            "Use character gender only as a grammar hint and prefer unknown over guessing. "
            "The primary subtitle text is always the canonical source. "
            "If reference_subtitles are present for a line, they are supporting aligned subtitles from other languages. "
            "Use them to clarify ambiguity, but do not follow them blindly and do not change line count or order because of them. "
            "For state_update: keep premise as stable whole-title context, but make scene_context specific to the current batch only. "
            "Do not repeat a broad movie synopsis in scene_context if the current lines are about a narrower exchange, location, or action beat."
        )
        if extra_instruction:
            system_instruction += " " + extra_instruction

        context_payload = session_context.model_dump() if session_context else {}
        line_payload = []
        for line in batch_lines:
            item = {
                "position": line.position,
                "text": line.text,
            }
            references = (reference_subtitles_by_position or {}).get(line.position) or []
            if references:
                item["reference_subtitles"] = references
            line_payload.append(item)
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
                        "source_language": settings.source_language,
                        "target_language": settings.target_language,
                        "session_context": context_payload,
                        "lines": line_payload,
                    },
                    ensure_ascii=False,
                ),
            },
        ]
        data = await self._chat_json(settings, messages, "translation_batch", _translation_schema())
        translations = [
            SubtitleLine(position=int(item["position"]), text=str(item["text"]))
            for item in data.get("translations", [])
        ]
        translated_by_position = {line.position: line for line in translations}
        ordered = [translated_by_position.get(line.position, line) for line in batch_lines]
        merged_context = (
            merge_session_context(session_context, data.get("state_update") or {})
            if settings.structured_context
            else session_context
        )
        return ordered, merged_context

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
        system_instruction = (
            "You are revising a single subtitle line translation. "
            "Use the source text, current translation, and session context to produce the best final target-language line. "
            "If reference_subtitles are present, treat them as supporting aligned subtitle references from other languages. "
            "The source_text remains canonical. "
            "Return only JSON."
        )
        if extra_instruction.strip():
            system_instruction += " Additional instruction: " + extra_instruction.strip()

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
                        "source_language": settings.source_language,
                        "target_language": settings.target_language,
                        "session_context": session_context.model_dump() if session_context else {},
                        "line": {
                            "position": source_line.position,
                            "source_text": source_line.text,
                            "current_translation": current_translation.text if current_translation else "",
                            "reference_subtitles": reference_subtitles or [],
                        },
                    },
                    ensure_ascii=False,
                ),
            },
        ]
        if log_event:
            log_event("info", f"Submitting isolated revision request for line {source_line.position + 1}")
        data = await self._chat_json(settings, messages, "subtitle_line_revision", _single_line_revision_schema())
        revised_line = SubtitleLine(position=source_line.position, text=str(data.get("text", "")))
        validation = _validate_translated_batch(settings, [source_line], [revised_line])
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
    ) -> tuple[list[SubtitleLine], BatchProcessingStats]:
        if not suspicious_positions:
            return translated_lines, BatchProcessingStats()

        translated_by_position = {line.position: line for line in translated_lines}
        source_by_position = {line.position: line for line in batch_lines}
        repair_stats = BatchProcessingStats(
            suspicious_count=len(suspicious_positions),
            retried_batches=1,
        )

        for position in suspicious_positions:
            source_line = source_by_position.get(position)
            if source_line is None:
                continue
            if log_event:
                log_event("warn", f"Retrying suspicious line {position + 1} as an isolated micro-batch")

            retried_lines, _ = await self._translate_batch_once(
                settings,
                [source_line],
                session_context,
                reference_subtitles_by_position=reference_subtitles_by_position,
                extra_instruction=(
                    _STRICT_RETRY_INSTRUCTION
                    + " Focus only on this subtitle line and translate it fully into the target language."
                ),
            )
            retried_line = retried_lines[0]
            retried_validation = _validate_translated_batch(settings, [source_line], [retried_line])
            flagged_positions = _flagged_positions(retried_validation, [source_line], settings)
            if flagged_positions:
                translated_by_position[position] = retried_line
                repair_stats.error_count += 1
                notes = _validation_notes(retried_validation, settings, flagged_positions)
                repair_stats.issues.extend(
                    _build_validation_issues(
                        settings,
                        "error",
                        flagged_positions,
                        [source_line],
                        [retried_line],
                        batch_index,
                        notes,
                        validation=retried_validation,
                    )
                )
                if log_event:
                    log_event(
                        "error",
                        f"Isolated retry still failed for line {position + 1}: {retried_validation.reason or 'validator still suspicious'}",
                    )
            else:
                repair_stats.fixed_count += 1
                translated_by_position[position] = retried_line
                repair_stats.issues.extend(
                    _build_validation_issues(
                        settings,
                        "auto_fixed",
                        [position],
                        [source_line],
                        [retried_line],
                        batch_index,
                        ["Validation cleared after isolated retry."],
                        extra_codes=["isolated_retry"],
                    )
                )
                if log_event:
                    log_event("info", f"Isolated retry fixed line {position + 1}")

        return _ordered_lines_from_map(batch_lines, translated_by_position), repair_stats

    async def _translate_batch_with_validation(
        self,
        settings: TranslationSettings,
        batch_lines: list[SubtitleLine],
        session_context: SessionContext | None,
        reference_subtitles_by_position: dict[int, list[dict[str, Any]]] | None = None,
        batch_index: int | None = None,
        log_event: LogEvent | None = None,
        depth: int = 0,
    ) -> tuple[list[SubtitleLine], SessionContext | None, BatchProcessingStats]:
        last_translated: list[SubtitleLine] | None = None
        last_context: SessionContext | None = session_context
        last_validation = BatchValidationResult(False, [], None, "")
        first_failed_positions: list[int] = []

        for attempt_index, extra_instruction in enumerate(("", _STRICT_RETRY_INSTRUCTION), start=1):
            if log_event:
                if attempt_index == 1:
                    log_event("info", f"Submitting batch to model with {len(batch_lines)} lines")
                else:
                    log_event("warn", "Retrying batch with stricter translation instruction")
            translated_lines, merged_context = await self._translate_batch_once(
                settings,
                batch_lines,
                session_context,
                reference_subtitles_by_position=reference_subtitles_by_position,
                extra_instruction=extra_instruction,
            )
            validation = _validate_translated_batch(settings, batch_lines, translated_lines)
            flagged_positions = _flagged_positions(validation, batch_lines, settings)
            if log_event:
                detection_note = (
                    f"detected output language: {validation.detected_language}"
                    if validation.detected_language
                    else "language detector had no confident batch result"
                )
                if validation.suspicious_positions:
                    detection_note += f"; suspicious line positions: {validation.suspicious_positions[:8]}"
                log_event(
                    "warn" if validation.failed else "info",
                    f"Validation after attempt {attempt_index}: {detection_note}"
                    + (f"; reason: {validation.reason}" if validation.reason else ""),
                )
            if not validation.failed:
                if flagged_positions:
                    repaired_lines, repair_stats = await self._repair_suspicious_lines(
                        settings,
                        batch_lines,
                        translated_lines,
                        merged_context,
                        flagged_positions,
                        reference_subtitles_by_position=reference_subtitles_by_position,
                        batch_index=batch_index,
                        log_event=log_event,
                    )
                    return repaired_lines, merged_context, repair_stats
                if attempt_index == 2 and first_failed_positions:
                    notes = ["Validation cleared after retry with stricter instruction."]
                    return translated_lines, merged_context, BatchProcessingStats(
                        suspicious_count=len(first_failed_positions),
                        fixed_count=len(first_failed_positions),
                        retried_batches=1,
                        issues=_build_validation_issues(
                            settings,
                            "auto_fixed",
                            first_failed_positions,
                            batch_lines,
                            translated_lines,
                            batch_index,
                            notes,
                            validation=validation,
                        ),
                    )
                return translated_lines, merged_context, BatchProcessingStats()
            last_translated = translated_lines
            last_context = merged_context
            last_validation = validation
            if attempt_index == 1:
                first_failed_positions = flagged_positions

        if len(batch_lines) > 1 and depth < 4:
            midpoint = max(1, len(batch_lines) // 2)
            first_half, second_half = batch_lines[:midpoint], batch_lines[midpoint:]
            if log_event:
                log_event(
                    "warn",
                    f"Validation still failing; splitting batch into chunks of {len(first_half)} and {len(second_half)} lines",
                )
            translated_first, context_after_first, first_stats = await self._translate_batch_with_validation(
                settings,
                first_half,
                session_context,
                reference_subtitles_by_position=reference_subtitles_by_position,
                batch_index=batch_index,
                log_event=log_event,
                depth=depth + 1,
            )
            translated_second, context_after_second, second_stats = await self._translate_batch_with_validation(
                settings,
                second_half,
                context_after_first,
                reference_subtitles_by_position=reference_subtitles_by_position,
                batch_index=batch_index,
                log_event=log_event,
                depth=depth + 1,
            )
            merged_stats = BatchProcessingStats(retried_batches=1, split_batches=1)
            merged_stats.merge(first_stats).merge(second_stats)
            return [*translated_first, *translated_second], context_after_second, merged_stats

        if last_translated is not None:
            flagged_positions = first_failed_positions or _flagged_positions(last_validation, batch_lines, settings)
            notes = _validation_notes(last_validation, settings, flagged_positions)
            if log_event:
                log_event(
                    "error",
                    f"Validation did not clear after retries; using last model result. {last_validation.reason or 'No validator reason available.'}",
                )
            return last_translated, last_context, BatchProcessingStats(
                suspicious_count=len(flagged_positions),
                error_count=len(flagged_positions),
                retried_batches=1,
                issues=_build_validation_issues(
                    settings,
                    "error",
                    flagged_positions,
                    batch_lines,
                    last_translated,
                    batch_index,
                    notes,
                    validation=last_validation,
                ),
            )
        raise ValueError(f"Batch validation failed: {last_validation.reason or 'unknown validation failure'}")

    async def translate_batch(
        self,
        settings: TranslationSettings,
        batch_lines: list[SubtitleLine],
        session_context: SessionContext | None,
        reference_subtitles_by_position: dict[int, list[dict[str, Any]]] | None = None,
        batch_index: int | None = None,
        log_event: LogEvent | None = None,
    ) -> tuple[list[SubtitleLine], SessionContext | None, BatchProcessingStats]:
        return await self._translate_batch_with_validation(
            settings,
            batch_lines,
            session_context,
            reference_subtitles_by_position=reference_subtitles_by_position,
            batch_index=batch_index,
            log_event=log_event,
        )
