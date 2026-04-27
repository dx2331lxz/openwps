from __future__ import annotations

import json
import unittest

from server.app.ai import LoopState, StopDecision, _evaluate_stop_hooks


class StopHookTest(unittest.TestCase):
    def test_different_params_do_not_trigger_duplicate_tool_loop(self) -> None:
        state = LoopState()
        calls = [
            {"id": "call_1", "name": "insert_paragraph_after", "params": {"paragraphIndex": 1, "text": "第一段"}},
            {"id": "call_2", "name": "insert_paragraph_after", "params": {"paragraphIndex": 2, "text": "第二段"}},
            {"id": "call_3", "name": "insert_paragraph_after", "params": {"paragraphIndex": 3, "text": "第三段"}},
        ]

        for call in calls:
            evaluation = _evaluate_stop_hooks(state, [call], [])

        self.assertEqual(evaluation.decision, StopDecision.CONTINUE)

    def test_same_params_trigger_duplicate_tool_loop(self) -> None:
        state = LoopState()
        call = {
            "id": "call_1",
            "name": "insert_paragraph_after",
            "params": {"paragraphIndex": 1, "text": "同一段"},
        }

        for _ in range(3):
            evaluation = _evaluate_stop_hooks(state, [call], [])

        self.assertEqual(evaluation.decision, StopDecision.RETRY_WITH_HINT)
        self.assertEqual(evaluation.reason, "tool_loop_detected")

    def test_args_field_is_still_supported_for_signatures(self) -> None:
        state = LoopState()
        call = {
            "id": "call_1",
            "name": "search_text",
            "args": {"query": "同一个关键词"},
        }

        for _ in range(3):
            evaluation = _evaluate_stop_hooks(state, [call], [])

        self.assertEqual(evaluation.decision, StopDecision.RETRY_WITH_HINT)

    def test_vision_capability_block_updates_state_without_warning(self) -> None:
        state = LoopState()
        call = {
            "id": "call_1",
            "name": "capture_page_screenshot",
            "params": {"page": 2},
        }
        result = {
            "content": json.dumps({
                "success": False,
                "toolName": "capture_page_screenshot",
                "capabilityBlocked": "vision",
                "recoverable": False,
            }, ensure_ascii=False),
        }

        evaluation = _evaluate_stop_hooks(state, [call], [result])

        self.assertEqual(evaluation.decision, StopDecision.CONTINUE)
        self.assertTrue(state.vision_capability_blocked)
        self.assertEqual(state.tool_failure_counts, {})


if __name__ == "__main__":
    unittest.main()
