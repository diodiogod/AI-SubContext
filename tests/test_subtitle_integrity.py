from __future__ import annotations

import asyncio
import json
import unittest
from unittest.mock import patch

import httpx

from app.config import TranslationSettings
from app.models import SubtitleLine
from app.subtitle_formatting import (
    protect_subtitle_formatting,
    restore_subtitle_formatting,
    subtitle_formatting_matches,
)
from app.translator import (
    OpenAICompatibleTranslator,
    _extract_json_blob,
    _looks_like_ambiguous_unchanged_fragment,
    _looks_like_unchanged_proper_name,
    _strong_repair_positions,
    _translation_item_text,
    _translation_items,
    _single_translation_text,
    _validate_translated_batch,
)


def settings() -> TranslationSettings:
    return TranslationSettings(
        base_url="http://localhost/v1",
        model="test",
        source_language="en",
        target_language="pt-BR",
        structured_context=False,
    )


class SubtitleFormattingTests(unittest.TestCase):
    def test_prompt_only_json_fallback_is_cached_and_warned_once(self) -> None:
        responses = [
            httpx.Response(400, text="response_format is unsupported", request=httpx.Request("POST", "http://localhost")),
            httpx.Response(400, text="response_format is unsupported", request=httpx.Request("POST", "http://localhost")),
            httpx.Response(200, json={"choices": [{"message": {"content": '{"ok": true}'}}]}),
            httpx.Response(200, json={"choices": [{"message": {"content": '{"ok": true}'}}]}),
        ]

        class FakeClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def post(self, *_args, **_kwargs):
                return responses.pop(0)

        events: list[tuple[str, str]] = []
        translator = OpenAICompatibleTranslator()

        async def run_twice() -> None:
            for _ in range(2):
                result = await translator._chat_json(
                    settings(),
                    [{"role": "user", "content": "Return JSON"}],
                    "translation_batch",
                    {"type": "object"},
                    lambda level, message: events.append((level, message)),
                )
                self.assertTrue(result["ok"])

        with patch("app.translator.httpx.AsyncClient", return_value=FakeClient()):
            asyncio.run(run_twice())

        self.assertEqual(responses, [])
        self.assertEqual(
            events,
            [("warn", "Model response mode for translation_batch: prompt-only JSON")],
        )

    def test_malformed_model_json_is_repaired(self) -> None:
        payload = _extract_json_blob(
            """```json
            {"translations": [
              {"position": 504, ""Sorrindo de um jeito enorme[[SUBBR_0]]como uma torcedora ciborgue"},
            ]}
            ```"""
        )

        self.assertEqual(payload["translations"][0]["position"], 504)
        self.assertEqual(
            _translation_item_text(payload["translations"][0]),
            "Sorrindo de um jeito enorme[[SUBBR_0]]como uma torcedora ciborgue",
        )

    def test_translation_text_accepts_common_model_aliases(self) -> None:
        self.assertEqual(
            _translation_item_text({"position": 4, "translated_text": "Olá."}),
            "Olá.",
        )

    def test_single_revision_accepts_top_level_translation_alias(self) -> None:
        self.assertEqual(
            _single_translation_text({"translation": "Tradução corrigida"}, 439),
            "Tradução corrigida",
        )

    def test_single_revision_accepts_collection_wrapper(self) -> None:
        self.assertEqual(
            _single_translation_text(
                {"lines": [{"translation": "Tradução corrigida"}]},
                439,
            ),
            "Tradução corrigida",
        )

    def test_translation_collection_accepts_prompt_only_lines_alias(self) -> None:
        items = [{"position": 56, "text": "Eu... um..."}]

        self.assertIs(_translation_items({"lines": items}), items)

    def test_required_translation_collection_takes_precedence_over_aliases(self) -> None:
        translations = [{"position": 1, "text": "Correto"}]

        self.assertIs(
            _translation_items(
                {
                    "translations": translations,
                    "lines": [{"position": 1, "text": "Ignorar"}],
                }
            ),
            translations,
        )

    def test_complete_ordered_string_collection_recovers_expected_positions(self) -> None:
        self.assertEqual(
            _translation_items(
                {"lines": ["Primeira", "Segunda"]},
                [80, 81],
            ),
            [
                {"position": 80, "text": "Primeira"},
                {"position": 81, "text": "Segunda"},
            ],
        )

    def test_partial_ordered_string_collection_is_not_positionally_assigned(self) -> None:
        self.assertEqual(
            _translation_items({"lines": ["Somente uma"]}, [80, 81]),
            ["Somente uma"],
        )

    def test_complete_positionless_objects_recover_expected_positions(self) -> None:
        self.assertEqual(
            _translation_items(
                {"items": [{"text": "Primeira"}, {"translation": "Segunda"}]},
                [90, 91],
            ),
            [
                {"position": 90, "text": "Primeira"},
                {"position": 91, "translation": "Segunda"},
            ],
        )

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
    def test_punctuated_multi_token_names_are_valid_unchanged_text(self) -> None:
        for value in ("Murray, Julían!", "Sra. Lagard…"):
            with self.subTest(value=value):
                self.assertTrue(_looks_like_unchanged_proper_name(value, value))
                result = _validate_translated_batch(
                    settings(),
                    [SubtitleLine(position=0, text=value)],
                    [SubtitleLine(position=0, text=value)],
                )
                self.assertEqual(result.suspicious_positions, [])

    def test_short_unchanged_phrase_is_deferred_without_failing_batch(self) -> None:
        value = "Thank you!"
        self.assertTrue(_looks_like_ambiguous_unchanged_fragment(value, value))
        result = _validate_translated_batch(
            settings(),
            [SubtitleLine(position=0, text=value)],
            [SubtitleLine(position=0, text=value)],
        )
        self.assertEqual(result.suspicious_positions, [0])
        self.assertEqual(result.ambiguous_unchanged_positions, [0])
        self.assertFalse(result.failed)
        self.assertEqual(
            _strong_repair_positions(
                settings(),
                [SubtitleLine(position=0, text=value)],
                [SubtitleLine(position=0, text=value)],
                result,
                [0],
            ),
            [],
        )

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

    def test_unchanged_mmm_hmm_is_a_language_neutral_vocalization(self) -> None:
        source = [SubtitleLine(position=0, text="Mmm-hmm.")]
        translated = [SubtitleLine(position=0, text="Mmm-hmm.")]

        with patch("app.translator._detect_language_code", return_value="pt"):
            result = _validate_translated_batch(settings(), source, translated)

        self.assertEqual(result.suspicious_positions, [])
        self.assertFalse(result.failed)

    def test_leading_contraction_apostrophe_is_not_a_quote_boundary(self) -> None:
        source = [SubtitleLine(position=169, text="'cause otherwise,\nthis is definitely")]
        translated = [SubtitleLine(position=169, text="porque, senão,\nisso definitivamente")]

        with patch("app.translator._detect_language_code", return_value="pt"):
            result = _validate_translated_batch(settings(), source, translated)

        self.assertEqual(result.boundary_positions, [])
        self.assertFalse(result.failed)

    def test_localized_sentence_final_quote_is_not_a_cue_boundary(self) -> None:
        source = [SubtitleLine(position=356, text='Good, bad, men, women, "other."')]
        translated = [SubtitleLine(position=356, text='Boa, ruim, homens, mulheres, "outros".')]

        with patch("app.translator._detect_language_code", return_value="pt"):
            result = _validate_translated_batch(settings(), source, translated)

        self.assertEqual(result.boundary_positions, [])
        self.assertFalse(result.failed)

    def test_removed_outer_dialogue_quotes_are_still_flagged(self) -> None:
        source = [SubtitleLine(position=0, text='"Tell me the truth."')]
        translated = [SubtitleLine(position=0, text="Diga-me a verdade.")]

        with patch("app.translator._detect_language_code", return_value="pt"):
            result = _validate_translated_batch(settings(), source, translated)

        self.assertEqual(result.boundary_positions, [0])

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
