from __future__ import annotations

import json
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app.config import TranslationSettings
from app.job_manager import job_manager
from app.main import app, _batch_context_payload, _job_payload, _job_review_payload, _job_summary_payload
from app.models import (
    BatchContextSnapshot,
    JobLogEntry,
    JobStatus,
    JobValidationStats,
    JobVisionStats,
    QueuedLineRetranslation,
    ReferenceSubtitleMatch,
    ReferenceSubtitleTrack,
    SessionContext,
    SubtitleLine,
    SubtitleValidationIssue,
    TranslationJob,
    VisualFrameLineDetail,
    VisualFrameRecord,
    VisualObservation,
    VisualSceneContext,
)


def _large_job() -> TranslationJob:
    source_lines = [
        SubtitleLine(
            position=index,
            text=f"SOURCE_LINE_SECRET_{index} " + ("source " * 28),
            start_time=f"00:00:{index % 60:02d},000",
            end_time=f"00:00:{index % 60:02d},900",
        )
        for index in range(80)
    ]
    translated_lines = [
        SubtitleLine(
            position=index,
            text=f"TRANSLATED_LINE_{index} " + ("translated " * 24),
            start_time=line.start_time,
            end_time=line.end_time,
        )
        for index, line in enumerate(source_lines)
    ]
    aligned_lines = [
        ReferenceSubtitleMatch(
            position=index,
            text=f"REFERENCE_ALIGNED_SECRET_{index} " + ("reference " * 24),
            confidence=0.92,
            matched_positions=[index],
            start_time=line.start_time,
            end_time=line.end_time,
        )
        for index, line in enumerate(source_lines)
    ]
    context = SessionContext(
        movie_title="Payload Test",
        source_language="en",
        target_language="pt-BR",
        premise="A compact premise retained for the active context card.",
        scene_context="The current scene remains available in summary and review views.",
    )
    logs = [
        JobLogEntry(
            level="info",
            message=f"LOG_DETAIL_SECRET_{index} " + ("runtime detail " * 28),
            batch_index=(index % 8) + 1,
        )
        for index in range(79)
    ]
    logs.append(JobLogEntry(level="info", message="Latest runtime state", batch_index=8))
    issues = [
        SubtitleValidationIssue(
            position=index,
            status="suspect",
            source_text=f"ISSUE_SOURCE_SECRET_{index} " + ("source " * 18),
            translated_text=f"ISSUE_TRANSLATION_SECRET_{index} " + ("translation " * 18),
            reason_codes=["language_overlap"],
            notes=["ISSUE_NOTE_SECRET " + ("note " * 24)],
            batch_index=(index // 10) + 1,
        )
        for index in range(40)
    ]
    frames = [
        VisualFrameRecord(
            id=f"frame-{index}",
            batch_index=(index // 5) + 1,
            timestamp_ms=index * 1500,
            related_positions=[index, index + 1],
            categories=["scene_context" if index % 2 == 0 else "speaker_identity"],
            revised_positions=[index] if index % 4 == 0 else [],
            status="scene" if index % 2 == 0 else "used",
            details=[
                VisualFrameLineDetail(
                    position=index,
                    category="speaker_identity",
                    question="FRAME_DETAIL_SECRET " + ("question " * 24),
                    source_text="FRAME_SOURCE_SECRET " + ("source " * 20),
                    provisional_translation="FRAME_PROVISIONAL_SECRET " + ("before " * 20),
                    final_translation="FRAME_FINAL_SECRET " + ("after " * 20),
                    answer="FRAME_ANSWER_SECRET " + ("answer " * 20),
                )
            ],
        )
        for index in range(40)
    ]
    scene_contexts = [
        VisualSceneContext(
            scene_index=index + 1,
            start_position=index * 8,
            end_position=(index * 8) + 7,
            summary="SCENE_DETAIL_SECRET " + ("visual scene " * 24),
            frame_ids=[f"frame-{index * 4 + offset}" for offset in range(4)],
        )
        for index in range(10)
    ]
    snapshots = [
        BatchContextSnapshot(
            batch_index=index + 1,
            start_position=index * 10,
            end_position=(index * 10) + 9,
            input_context=context,
            output_context=context,
        )
        for index in range(8)
    ]
    settings = TranslationSettings(
        base_url="https://private-endpoint.example/v1",
        api_key="API_KEY_SECRET",
        model="test/model",
        source_language="en",
        target_language="pt-BR",
        batch_size=10,
        structured_context=True,
        visual_scene_context=True,
        adaptive_vision=True,
        request_timeout_seconds=180,
        target_language_tips="PRIVATE_LANGUAGE_TIPS",
        prompt_translation_system="PROMPT_SECRET",
        prompt_translation_strict_retry="STRICT_PROMPT_SECRET",
    )
    return TranslationJob(
        filename="payload-test.en.srt",
        source_filename="payload-test.en.srt",
        title="Payload Test",
        job_kind="translation",
        settings=settings,
        original_srt="SOURCE_SRT_BODY_SECRET\n" + ("source srt body " * 6000),
        original_lines=source_lines,
        translated_lines=translated_lines,
        reference_tracks=[
            ReferenceSubtitleTrack(
                filename="payload-test.es.srt",
                language="es",
                total_lines=80,
                matched_lines=80,
                average_confidence=0.92,
                alignment_mode="timestamp",
                aligned_lines=aligned_lines,
            )
        ],
        session_context=context,
        session_context_history=[context.model_dump(mode="json"), context.model_dump(mode="json")],
        batch_context_snapshots=snapshots,
        validation_stats=JobValidationStats(suspicious_subtitles=40, auto_fixed_subtitles=2),
        vision_stats=JobVisionStats(scene_cards_total=10, scene_cards_created=10),
        visual_observations=[
            VisualObservation(
                position=index,
                category="speaker_identity",
                answer="VISUAL_OBSERVATION_SECRET " + ("answer " * 20),
            )
            for index in range(20)
        ],
        visual_frames=frames,
        visual_scene_contexts=scene_contexts,
        validation_issues=issues,
        pending_retranslations=[QueuedLineRetranslation(position=3, extra_instruction="PRIVATE_RETRY")],
        logs=logs,
        status=JobStatus.COMPLETED,
        progress=100,
        current_batch=8,
        total_batches=8,
        message="Translation completed",
        video_filename="payload-test.mkv",
        video_path="C:/private/payload-test.mkv",
        translated_srt="TRANSLATED_SRT_BODY_SECRET\n" + ("translated srt body " * 6000),
    )


class JobPayloadViewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.client = TestClient(app)
        cls.job = _large_job()

    def test_summary_payload_is_compact_and_contains_card_metadata(self) -> None:
        payload = _job_summary_payload(self.job)

        self.assertEqual(payload["source_count"], 80)
        self.assertEqual(payload["translated_count"], 80)
        self.assertEqual(payload["log_count"], 80)
        self.assertEqual(payload["issue_count"], 40)
        self.assertEqual(payload["latest_log"]["message"], "Latest runtime state")
        self.assertEqual(payload["model_activity_logs"], [])
        self.assertEqual(payload["review_counts"]["suspect"], 40)
        self.assertEqual(payload["review_counts"]["fixed"], 0)
        self.assertNotIn("session_context", payload)
        self.assertEqual(
            set(payload["settings"]),
            {
                "model",
                "source_language",
                "target_language",
                "batch_size",
                "structured_context",
                "visual_scene_context",
                "adaptive_vision",
                "request_timeout_seconds",
            },
        )
        self.assertNotIn("aligned_lines", payload["reference_tracks"][0])
        self.assertNotIn("details", payload["visual_frames"][0])
        for omitted in {
            "original_srt",
            "translated_srt",
            "original_lines",
            "translated_lines",
            "reference_uploads",
            "logs",
            "validation_issues",
            "visual_observations",
            "visual_scene_contexts",
            "batch_context_snapshots",
            "pending_retranslations",
        }:
            self.assertNotIn(omitted, payload)

        encoded = json.dumps(payload, separators=(",", ":"))
        for secret in {
            "API_KEY_SECRET",
            "PROMPT_SECRET",
            "SOURCE_SRT_BODY_SECRET",
            "SOURCE_LINE_SECRET",
            "REFERENCE_ALIGNED_SECRET",
            "LOG_DETAIL_SECRET",
            "ISSUE_SOURCE_SECRET",
            "FRAME_DETAIL_SECRET",
            "TRANSLATED_SRT_BODY_SECRET",
        }:
            self.assertNotIn(secret, encoded)

    def test_review_payload_contains_workspace_data_but_not_runtime_bulk(self) -> None:
        payload = _job_review_payload(self.job)

        self.assertEqual(len(payload["original_lines"]), 80)
        self.assertEqual(len(payload["translated_lines"]), 80)
        self.assertEqual(len(payload["validation_issues"]), 40)
        self.assertIn("aligned_lines", payload["reference_tracks"][0])
        self.assertNotIn("input_context", payload["batch_context_snapshots"][0])
        self.assertNotIn("output_context", payload["batch_context_snapshots"][0])
        self.assertTrue(payload["batch_context_snapshots"][0]["has_snapshot"])
        self.assertNotIn("source_text", payload["validation_issues"][0])
        self.assertNotIn("translated_text", payload["validation_issues"][0])
        self.assertEqual(
            set(payload["settings"]),
            {"model", "source_language", "target_language", "batch_size"},
        )
        for omitted in {
            "original_srt",
            "translated_srt",
            "reference_uploads",
            "logs",
            "visual_observations",
            "visual_frames",
            "visual_scene_contexts",
            "session_context_history",
        }:
            self.assertNotIn(omitted, payload)

        encoded = json.dumps(payload, separators=(",", ":"))
        for secret in {
            "API_KEY_SECRET",
            "PROMPT_SECRET",
            "SOURCE_SRT_BODY_SECRET",
            "LOG_DETAIL_SECRET",
            "FRAME_DETAIL_SECRET",
            "TRANSLATED_SRT_BODY_SECRET",
        }:
            self.assertNotIn(secret, encoded)

    def test_active_summary_keeps_only_bounded_model_activity(self) -> None:
        logs = [
            JobLogEntry(level="info", message=f"unrelated verbose detail {index}", batch_index=1)
            for index in range(20)
        ] + [
            JobLogEntry(level="info", message=f"Starting batch {index}", batch_index=index)
            for index in range(1, 18)
        ]
        active = self.job.model_copy(update={"status": JobStatus.PROCESSING, "logs": logs})
        payload = _job_summary_payload(active)

        self.assertIn("session_context", payload)
        self.assertLessEqual(len(payload["session_context_history"]), 2)
        self.assertEqual(len(payload["model_activity_logs"]), 12)
        self.assertTrue(all("Starting batch" in entry["message"] for entry in payload["model_activity_logs"]))
        self.assertNotIn("unrelated verbose detail", json.dumps(payload["model_activity_logs"]))

    def test_summary_caps_visual_frame_metadata_to_the_newest_eighty(self) -> None:
        frames = [
            self.job.visual_frames[index % len(self.job.visual_frames)].model_copy(
                update={"id": f"many-frame-{index}", "timestamp_ms": index * 1000},
            )
            for index in range(120)
        ]
        payload = _job_summary_payload(self.job.model_copy(update={"visual_frames": frames}))

        self.assertEqual(payload["visual_frame_count"], 120)
        self.assertEqual(len(payload["visual_frames"]), 80)
        self.assertEqual(payload["visual_frames"][0]["id"], "many-frame-40")
        self.assertEqual(payload["visual_frames"][-1]["id"], "many-frame-119")

    def test_compact_views_substantially_reduce_serialized_size(self) -> None:
        full_size = len(json.dumps(_job_payload(self.job), separators=(",", ":")).encode())
        summary_size = len(json.dumps(_job_summary_payload(self.job), separators=(",", ":")).encode())
        review_size = len(json.dumps(_job_review_payload(self.job), separators=(",", ":")).encode())

        self.assertLess(summary_size, full_size * 0.15)
        self.assertLess(review_size, full_size * 0.35)

    def test_batch_context_payload_loads_saved_and_derived_cards_safely(self) -> None:
        saved = _batch_context_payload(self.job, 1)
        self.assertTrue(saved["has_snapshot"])
        self.assertIsNotNone(saved["input_context"])
        self.assertIsNotNone(saved["output_context"])

        without_last_snapshot = self.job.model_copy(
            update={"batch_context_snapshots": self.job.batch_context_snapshots[:-1]},
        )
        derived = _batch_context_payload(without_last_snapshot, 8)
        self.assertFalse(derived["has_snapshot"])
        self.assertEqual(derived["start_position"], 70)
        self.assertEqual(derived["end_position"], 79)
        self.assertIsNone(_batch_context_payload(without_last_snapshot, 9))

        no_context = without_last_snapshot.model_copy(update={"session_context": None})
        self.assertIsNone(_batch_context_payload(no_context, 8)["session_context"])

    def test_routes_default_to_full_and_require_explicit_compact_views(self) -> None:
        with patch.object(job_manager, "list_jobs", return_value=[self.job]):
            full_response = self.client.get("/api/jobs")
            summary_response = self.client.get("/api/jobs?view=summary")

        self.assertEqual(full_response.status_code, 200)
        self.assertIn("original_srt", full_response.json()[0])
        self.assertEqual(full_response.json()[0]["settings"]["api_key"], "API_KEY_SECRET")
        self.assertEqual(summary_response.status_code, 200)
        self.assertNotIn("original_srt", summary_response.json()[0])
        self.assertEqual(summary_response.json()[0]["source_count"], 80)

        with patch.object(job_manager, "get_job", return_value=self.job):
            full_job_response = self.client.get(f"/api/jobs/{self.job.id}")
            review_response = self.client.get(f"/api/jobs/{self.job.id}?view=review")

        self.assertEqual(full_job_response.status_code, 200)
        self.assertIn("visual_frames", full_job_response.json())
        self.assertIn("original_srt", full_job_response.json())
        self.assertEqual(review_response.status_code, 200)
        self.assertIn("original_lines", review_response.json())
        self.assertNotIn("visual_frames", review_response.json())

        with patch.object(job_manager, "get_job", return_value=self.job):
            batch_response = self.client.get(f"/api/jobs/{self.job.id}/batch-context/1")
        self.assertEqual(batch_response.status_code, 200)
        self.assertTrue(batch_response.json()["has_snapshot"])
        self.assertIn("output_context", batch_response.json())

    def test_foreign_browser_origins_cannot_read_or_mutate_local_api(self) -> None:
        with patch.object(job_manager, "list_jobs", return_value=[self.job]):
            foreign = self.client.get(
                "/api/jobs",
                headers={"Origin": "https://attacker.example"},
            )
            loopback = self.client.get(
                "/api/jobs?view=summary",
                headers={"Origin": "http://127.0.0.1:7861"},
            )
            cli = self.client.get("/api/jobs?view=summary")
        foreign_post = self.client.post(
            f"/api/jobs/{self.job.id}/stop",
            headers={"Origin": "https://attacker.example"},
        )

        self.assertEqual(foreign.status_code, 403)
        self.assertNotIn("access-control-allow-origin", foreign.headers)
        self.assertEqual(foreign_post.status_code, 403)
        self.assertEqual(loopback.status_code, 200)
        self.assertEqual(loopback.headers.get("access-control-allow-origin"), "http://127.0.0.1:7861")
        self.assertEqual(cli.status_code, 200)

    def test_line_and_batch_mutations_offer_review_sized_responses(self) -> None:
        with patch.object(job_manager, "update_translated_line", return_value=self.job):
            full_line = self.client.patch(
                f"/api/jobs/{self.job.id}/lines/0",
                json={"text": "Updated", "resolution_mode": "save"},
            )
            review_line = self.client.patch(
                f"/api/jobs/{self.job.id}/lines/0?view=review",
                json={"text": "Updated", "resolution_mode": "save"},
            )

        self.assertIn("original_srt", full_line.json())
        self.assertNotIn("original_srt", review_line.json())
        self.assertIn("original_lines", review_line.json())

        with patch.object(job_manager, "request_line_retranslation", new=AsyncMock(return_value=(self.job, False))):
            retranslated = self.client.post(
                f"/api/jobs/{self.job.id}/lines/0/retranslate?view=review",
                json={"extra_instruction": "Keep it concise"},
            )

        self.assertNotIn("original_srt", retranslated.json()["job"])
        self.assertIn("translated_lines", retranslated.json()["job"])

        with patch.object(job_manager, "update_batch_context_snapshot", return_value=self.job):
            batch = self.client.patch(
                f"/api/jobs/{self.job.id}/batch-context/1?view=review",
                json={"session_context": self.job.session_context.model_dump(mode="json")},
            )

        self.assertNotIn("original_srt", batch.json())
        self.assertIn("batch_context_snapshots", batch.json())


if __name__ == "__main__":
    unittest.main()
