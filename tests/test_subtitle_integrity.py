from __future__ import annotations

import asyncio
import json
import unittest
from unittest.mock import patch

from app.config import TranslationSettings
from app.models import SubtitleLine
from app.subtitle_formatting import (
    protect_subtitle_formatting,
    restore_subtitle_formatting,
    subtitle_formatting_matches,
)
from app.translator import OpenAICompatibleTranslator, _validate_translated_batch


def settings() -> TranslationSettings:
    return TranslationSettings(
        base_url="http://localhost/v1",
        model="test",
        source_language="en",
        target_language="pt-BR",
        structured_context=False,
    )


class SubtitleFormattingTests(unittest.TestCase):
    def test_multicolor_markup_is_hidden_and_restored_exactly(self) -> None:
        source = (
            '<font color="#ffffff">Hey.</font>'
            '<font color="#00ff00"> Come here.</font>'
        )
        protected = protect_subtitle_formatting(source)

        self.assertNotIn("<font", protected.model_text)
        translated = restore_subtitle_formatting(
            source,
            "[[SUBFMT_0]]Ei.[[SUBFMT_1]][[SUBFMT_2]] Venha aqui.[[SUBFMT_3]]",
        )

        self.assertEqual(
            translated,
            '<font color="#ffffff">Ei.</font>'
            '<font color="#00ff00"> Venha aqui.</font>',
        )
        self.assertTrue(subtitle_formatting_matches(source, translated))

    def test_uniform_style_has_safe_program_owned_fallback(self) -> None:
        source = (
            '<font color="#00ffff">First line.</font>\n'
            '<font color="#00ffff">Second line.</font>'
        )
        translated = restore_subtitle_formatting(source, "Primeira linha.\nSegunda linha.")

        self.assertEqual(
            translated,
            '<font color="#00ffff">Primeira linha.\nSegunda linha.</font>',
        )
        self.assertTrue(subtitle_formatting_matches(source, translated))

    def test_line_breaks_are_hidden_and_restored_by_program_markers(self) -> None:
        source = (
            '<font color="#00ffff">First line.</font>\n'
            '<font color="#00ffff">Second line.</font>'
        )
        protected = protect_subtitle_formatting(source)
        self.assertNotIn("\n", protected.model_text)
        self.assertIn("[[SUBBR_0]]", protected.model_text)

        translated = restore_subtitle_formatting(
            source,
            (
                "[[SUBFMT_0]]Primeira linha.[[SUBFMT_1]]"
                "[[SUBBR_0]]"
                "[[SUBFMT_2]]Segunda linha.[[SUBFMT_3]]"
            ),
        )
        self.assertEqual(
            translated,
            '<font color="#00ffff">Primeira linha.</font>\n'
            '<font color="#00ffff">Segunda linha.</font>',
        )
        self.assertTrue(subtitle_formatting_matches(source, translated))

    def test_corrupted_marker_fragments_never_leak_into_output(self) -> None:
        source = (
            '<font color="#00ffff">First line.</font>\n'
            '<font color="#00ffff">Second line.</font>'
        )
        translated = restore_subtitle_formatting(
            source,
            "Primeira linha.[[SUBBR_0]]Segunda linha.[SUBFMT_3]",
        )
        self.assertEqual(
            translated,
            '<font color="#00ffff">Primeira linha.\nSegunda linha.</font>',
        )
        self.assertNotIn("SUBF", translated)

    def test_translation_request_never_exposes_raw_markup(self) -> None:
        translator = OpenAICompatibleTranslator()
        source = SubtitleLine(
            position=4,
            text='<font color="#ffffff">Hello.</font>',
        )

        async def fake_chat(_settings, messages, *_args, **_kwargs):
            payload = json.loads(messages[1]["content"])
            self.assertEqual(payload["lines"][0]["text"], "[[SUBFMT_0]]Hello.[[SUBFMT_1]]")
            self.assertNotIn("<font", messages[1]["content"])
            return {
                "translations": [
                    {"position": 4, "text": "[[SUBFMT_0]]Olá.[[SUBFMT_1]]"}
                ]
            }

        translator._chat_json = fake_chat  # type: ignore[method-assign]
        translated, _, _ = asyncio.run(
            translator._translate_batch_once(settings(), [source], None)
        )
        self.assertEqual(
            translated[0].text,
            '<font color="#ffffff">Olá.</font>',
        )


class SubtitleValidationTests(unittest.TestCase):
    def test_styled_names_and_vocal_sounds_are_not_false_errors(self) -> None:
        source = [
            SubtitleLine(position=0, text='<font color="#ffffff">Avery!</font>'),
            SubtitleLine(position=1, text='<font color="#00ffff">Mm.</font>'),
            SubtitleLine(position=2, text='<font color="#ffff00">Zoe?</font>'),
        ]
        translated = [
            SubtitleLine(position=line.position, text=line.text)
            for line in source
        ]

        with patch("app.translator._detect_language_code", return_value="pt"):
            result = _validate_translated_batch(settings(), source, translated)

        self.assertEqual(result.suspicious_positions, [])
        self.assertFalse(result.failed)

    def test_malformed_or_changed_multicolor_formatting_is_rejected(self) -> None:
        source = [
            SubtitleLine(
                position=0,
                text=(
                    '<font color="#ffffff">Hello.</font>'
                    '<font color="#00ff00"> Come here.</font>'
                ),
            )
        ]
        translated = [
            SubtitleLine(
                position=0,
                text='<font color="#ffffff">Olá. Venha aqui.',
            )
        ]

        with patch("app.translator._detect_language_code", return_value="pt"):
            result = _validate_translated_batch(settings(), source, translated)

        self.assertEqual(result.formatting_positions, [0])
        self.assertTrue(result.failed)

    def test_sustained_neighboring_cue_shift_is_detected(self) -> None:
        source_texts = [
            "Of me? What am I...for?",
            "And I couldn't...",
            "I couldn't really work\nthat one out, unfortunately.",
            "So I...",
            "I mean, you could call it\nwhatever you want to call it. I...",
            "I sort of went mad.",
            "I went to the dark side!\nInto... Into a big black hole.",
            "Down to the fucking bottom!",
        ]
        translated_texts = [
            "E eu não consegui...",
            "Não consegui resolver isso direito,\ninfelizmente.",
            "Então eu...",
            "Quer dizer, você pode chamar do jeito que quiser. Eu...",
            "Acabei ficando louco.",
            "Fui para o lado sombrio!\nPara... Para um grande buraco negro.",
            "Lá embaixo no fundo do poço!",
            "Onde dá para ir mais longe.",
        ]
        source = [SubtitleLine(position=i, text=text) for i, text in enumerate(source_texts)]
        translated = [
            SubtitleLine(position=i, text=text)
            for i, text in enumerate(translated_texts)
        ]

        with patch("app.translator._detect_language_code", return_value="pt"):
            result = _validate_translated_batch(settings(), source, translated)

        self.assertTrue(result.sequence_drift_positions)
        self.assertTrue(result.failed)


if __name__ == "__main__":
    unittest.main()
