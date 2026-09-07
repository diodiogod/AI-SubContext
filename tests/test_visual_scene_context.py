from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from app.config import TranslationSettings
from app.models import SubtitleLine
from app.translator import OpenAICompatibleTranslator


class VisualSceneContextTests(unittest.IsolatedAsyncioTestCase):
    async def test_model_echoed_metadata_cannot_override_scene_metadata(self) -> None:
        translator = OpenAICompatibleTranslator()
        translator._chat_json = AsyncMock(
            return_value={
                "scene_index": 999,
                "start_position": 999,
                "frame_ids": ["model-owned-frame"],
                "setting": {
                    "location": "A dimly lit room",
                    "lighting": "low-key lighting",
                },
                "visible_characters": [{"count": 2, "description": "two people"}],
                "actions": {"primary": "They are talking."},
                "objects": ["table"],
                "on_screen_text": [],
                "speaker_evidence": [],
                "uncertainties": ["Their identities are unclear."],
                "summary": "Two people talk across a table.",
            }
        )
        settings = TranslationSettings(
            base_url="http://127.0.0.1:8080/v1",
            model="qwen3.8-27b",
            source_language="en",
            target_language="pt-BR",
        )
        lines = [
            SubtitleLine(
                position=4,
                text="Hello.",
                start_time="00:00:10,000",
                end_time="00:00:11,000",
            )
        ]
        frame = SimpleNamespace(
            id="actual-frame",
            timestamp_ms=10_500,
            as_data_url=lambda: "data:image/jpeg;base64,AA==",
        )

        result = await translator.analyze_visual_scene(
            settings=settings,
            scene_index=2,
            scene_lines=lines,
            movie_context=None,
            previous_scene=None,
            frames=[frame],
        )

        self.assertEqual(result.scene_index, 2)
        self.assertEqual(result.start_position, 4)
        self.assertEqual(result.end_position, 4)
        self.assertEqual(result.frame_ids, ["actual-frame"])
        self.assertEqual(result.setting, "location: A dimly lit room; lighting: low-key lighting")
        self.assertEqual(result.visible_characters, ["count: 2; description: two people"])
        self.assertEqual(result.actions, ["primary: They are talking."])


if __name__ == "__main__":
    unittest.main()
