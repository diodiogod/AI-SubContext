from typing import Literal

from pydantic import BaseModel, Field


DEFAULT_MAX_COMPLETION_TOKENS = 1800
DEFAULT_REQUEST_TIMEOUT_SECONDS = 120


class TranslationSettings(BaseModel):
    base_url: str = Field(..., description="OpenAI-compatible base URL, e.g. http://127.0.0.1:1234/v1")
    api_key: str = Field(default="lm-studio")
    model: str = Field(...)
    source_language: str = Field(...)
    target_language: str = Field(...)
    title: str = Field(default="")
    batch_size: int = Field(default=10, ge=1, le=100)
    temperature: float = Field(default=0.2, ge=0.0, le=2.0)
    structured_context: bool = Field(default=True)
    initial_card_strategy: Literal["auto", "whole", "sample"] = Field(default="auto")
    initial_card_max_chars: int = Field(default=24000, ge=2000, le=200000)
    max_completion_tokens: int = Field(default=DEFAULT_MAX_COMPLETION_TOKENS, ge=128, le=16000)
    request_timeout_seconds: int = Field(default=DEFAULT_REQUEST_TIMEOUT_SECONDS, ge=15, le=900)
    prompt_translation_system: str = Field(default="")
    prompt_translation_strict_retry: str = Field(default="")
    prompt_initial_context_system: str = Field(default="")
    prompt_full_context_refresh_system: str = Field(default="")
    prompt_batch_context_refresh_system: str = Field(default="")
    prompt_line_revision_system: str = Field(default="")
