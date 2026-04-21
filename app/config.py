from pydantic import BaseModel, Field


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
