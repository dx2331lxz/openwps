from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from server.app import ai, plans
from server.app.ai import QueryCoordinator, _get_model_tools_for_body, _make_planned_execution
from server.app.models import ChatRequest


class PlanStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.patch = patch.object(plans, "PLANS_DIR", self.root / "plans")
        self.patch.start()

    def tearDown(self) -> None:
        self.patch.stop()
        self.tmp.cleanup()

    def test_submit_approve_reject_plan_lifecycle(self) -> None:
        submitted = plans.submit_plan_for_approval("conv-1", "<proposed_plan>\n计划\n</proposed_plan>")
        self.assertEqual(submitted["status"], "pending_approval")
        self.assertIn("计划", submitted["content"])

        approved = plans.approve_plan("conv-1")
        self.assertEqual(approved["status"], "approved")
        self.assertTrue(approved.get("approvedAt"))
        self.assertIn("approved_plan", plans.get_approved_plan_attachment("conv-1"))

        rejected = plans.reject_plan("conv-1", "范围太大")
        self.assertEqual(rejected["status"], "rejected")
        self.assertEqual(rejected["feedback"], "范围太大")
        self.assertIn("范围太大", plans.get_rejected_plan_attachment("conv-1"))

    def test_question_answer_returns_to_drafting(self) -> None:
        plan = plans.request_plan_questions(
            "conv-2",
            [{
                "id": "scope",
                "question": "范围选哪个？",
                "options": [
                    {"value": "small", "label": "小范围", "description": "先做核心"},
                    {"value": "full", "label": "完整", "description": "一次做完"},
                ],
            }],
        )
        self.assertEqual(plan["status"], "needs_user_input")

        answered = plans.answer_plan_question("conv-2", "scope", "small")

        self.assertEqual(answered["status"], "drafting")
        self.assertEqual(answered["questions"][0]["answer"], "small")


class PlanModeToolGateTest(unittest.TestCase):
    def test_plan_mode_hides_mutating_tools_and_exposes_plan_tools(self) -> None:
        body = ChatRequest(message="先规划", mode="agent", operationMode="plan")
        tool_names = {
            str(tool.get("function", {}).get("name", ""))
            for tool in _get_model_tools_for_body(body)
        }

        self.assertIn("AskUserQuestion", tool_names)
        self.assertIn("SubmitPlanForApproval", tool_names)
        self.assertIn("TaskList", tool_names)
        self.assertNotIn("TaskCreate", tool_names)
        self.assertNotIn("begin_streaming_write", tool_names)
        self.assertNotIn("set_text_style", tool_names)

    def test_plan_mode_blocks_mutating_execution_even_if_called(self) -> None:
        session = ai.create_react_session(ChatRequest(message="先规划", mode="agent", operationMode="plan"))
        coordinator = QueryCoordinator(session)
        execution = _make_planned_execution(
            tool_name="begin_streaming_write",
            params={"markdown": "bad"},
            source_calls=[],
        )

        blocked = coordinator._blocked_execution_content(execution)

        self.assertIsNotNone(blocked)
        self.assertIn("Plan Mode 已阻断", blocked or "")

    def test_plan_mode_blocks_workspace_memory_write(self) -> None:
        session = ai.create_react_session(ChatRequest(message="先规划", mode="agent", operationMode="plan"))
        coordinator = QueryCoordinator(session)
        execution = _make_planned_execution(
            tool_name="workspace_memory_write",
            params={"path": "notes.md", "content": "temporary"},
            source_calls=[],
        )

        blocked = coordinator._blocked_execution_content(execution)

        self.assertIsNotNone(blocked)
        self.assertIn("workspace_memory_write", blocked or "")


if __name__ == "__main__":
    unittest.main()
