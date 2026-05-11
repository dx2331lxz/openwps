from __future__ import annotations

import tempfile
import unittest
import json
import asyncio
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from server.app import skills, workspace
from server.app.ai import PlannedToolExecution, QueryCoordinator, SourceToolCall, create_react_session
from server.app.models import ChatRequest


class SkillMechanismTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.workspaces_dir = self.root / "workspaces"
        self.user_skills_dir = self.root / "home" / ".openwps" / "skills"
        self.builtin_skills_dir = self.root / "app" / "builtin_skills"
        self.patches = [
            patch.object(workspace, "WORKSPACES_DIR", self.workspaces_dir),
            patch.object(workspace, "WORKSPACES_META_PATH", self.workspaces_dir / "meta.json"),
            patch.object(skills, "USER_SKILLS_DIR", self.user_skills_dir),
            patch.object(skills, "BUILTIN_SKILLS_DIR", self.builtin_skills_dir),
        ]
        for item in self.patches:
            item.start()
        workspace.list_workspaces()

    def tearDown(self) -> None:
        for item in reversed(self.patches):
            item.stop()
        self.tmp.cleanup()

    def write_skill(self, root: Path, slug: str, text: str) -> Path:
        path = root / slug / "SKILL.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def workspace_skill_root(self, workspace_id: str = "default") -> Path:
        return self.workspaces_dir / workspace_id / "files" / ".openwps" / "skills"

    def test_builtin_skills_are_scanned_as_read_only(self) -> None:
        self.write_skill(
            self.builtin_skills_dir,
            "builtin-helper",
            "---\nname: Builtin Helper\ndescription: bundled helper\nwhen_to_use: bundled work\n---\n\nUse builtin version.\n\n## 来源索引\n- Test",
        )

        data = skills.list_skills(scope="builtin")

        self.assertEqual(len(data["skills"]), 1)
        item = data["skills"][0]
        self.assertEqual(item["scope"], "builtin")
        self.assertIsNone(item["workspaceId"])
        self.assertTrue(item["readOnly"])
        self.assertFalse(item["canEdit"])
        self.assertFalse(item["canDelete"])
        self.assertTrue(item["availableForModel"])

    def test_workspace_user_builtin_override_priority(self) -> None:
        self.write_skill(
            self.builtin_skills_dir,
            "review",
            "---\nname: Builtin Review\ndescription: builtin review\n---\n\nUse builtin version.",
        )
        self.write_skill(
            self.user_skills_dir,
            "review",
            "---\nname: User Review\ndescription: global review\n---\n\nUse user version.",
        )
        self.write_skill(
            self.workspace_skill_root(),
            "review",
            "---\nname: Workspace Review\ndescription: workspace review\n---\n\nUse workspace version.",
        )

        data = skills.list_skills(scope="all")

        by_scope = {(item["scope"], item["slug"]): item for item in data["skills"]}
        self.assertTrue(by_scope[("workspace", "review")]["availableForModel"])
        self.assertFalse(by_scope[("user", "review")]["availableForModel"])
        self.assertEqual(by_scope[("user", "review")]["overriddenBy"], "default")
        self.assertFalse(by_scope[("builtin", "review")]["availableForModel"])
        self.assertEqual(by_scope[("builtin", "review")]["overriddenBy"], "default")

    def test_scan_workspace_and_user_skills_with_workspace_override(self) -> None:
        self.write_skill(
            self.user_skills_dir,
            "review",
            "---\nname: User Review\ndescription: global review\n---\n\nUse user version.",
        )
        self.write_skill(
            self.workspace_skill_root(),
            "review",
            "---\nname: Workspace Review\nwhen_to_use: project review\ncontext: fork\nagent: document-research\n---\n\nUse workspace version.",
        )

        data = skills.list_skills(scope="all")

        by_scope = {(item["scope"], item["slug"]): item for item in data["skills"]}
        self.assertTrue(by_scope[("workspace", "review")]["availableForModel"])
        self.assertEqual(by_scope[("workspace", "review")]["context"], "fork")
        self.assertEqual(by_scope[("workspace", "review")]["agent"], "document-research")
        self.assertFalse(by_scope[("user", "review")]["availableForModel"])
        self.assertEqual(by_scope[("user", "review")]["overriddenBy"], "default")

    def test_builtin_skill_can_be_loaded_for_model(self) -> None:
        self.write_skill(
            self.builtin_skills_dir,
            "builtin-helper",
            "---\nname: Builtin Helper\ndescription: bundled helper\n---\n\nBuiltin instructions for $ARGUMENTS.",
        )

        expanded = skills.expand_skill_for_model(
            "builtin-helper",
            "draft",
            session_id="sess-1",
            workspace_id="default",
        )

        self.assertEqual(expanded["scope"], "builtin")
        self.assertIn("Builtin instructions for draft", expanded["prompt"])
        self.assertIn("type=skill_context", expanded["attachment"])

    def test_builtin_skills_cannot_be_created_updated_or_deleted(self) -> None:
        self.write_skill(
            self.builtin_skills_dir,
            "builtin-helper",
            "---\nname: Builtin Helper\ndescription: bundled helper\n---\n\nUse builtin version.",
        )
        builtin_id = skills.encode_skill_id("builtin", None, "builtin-helper")

        with self.assertRaises(HTTPException) as create_ctx:
            skills.create_skill({"scope": "builtin", "directoryName": "new-builtin", "content": "no"})
        self.assertEqual(create_ctx.exception.status_code, 403)

        with self.assertRaises(HTTPException) as update_ctx:
            skills.update_skill(builtin_id, {"content": "changed"})
        self.assertEqual(update_ctx.exception.status_code, 403)

        with self.assertRaises(HTTPException) as delete_ctx:
            skills.delete_skill(builtin_id)
        self.assertEqual(delete_ctx.exception.status_code, 403)
        self.assertTrue((self.builtin_skills_dir / "builtin-helper" / "SKILL.md").exists())

    def test_packaged_chinese_builtin_skills_are_valid(self) -> None:
        packaged_root = Path(skills.__file__).parent / "builtin_skills"
        records = skills._scan_skill_root(packaged_root, "builtin", None)

        self.assertEqual(len(records), 14)
        slugs = {record.slug for record in records}
        self.assertIn("chinese-official-document-writing", slugs)
        self.assertIn("chinese-layout-typography-check", slugs)
        for record in records:
            self.assertRegex(record.slug, skills.SKILL_NAME_RE)
            self.assertTrue(record.name)
            self.assertTrue(record.description)
            self.assertTrue(record.when_to_use)
            self.assertIn("来源索引", record.content)
            self.assertTrue(record.read_only)

    def test_crud_writes_renames_and_deletes_inside_skill_root(self) -> None:
        created = skills.create_skill({
            "scope": "workspace",
            "directoryName": "draft-helper",
            "name": "Draft Helper",
            "description": "drafts text",
            "whenToUse": "writing drafts",
            "content": "Write with care.",
        })
        self.assertEqual(created["slug"], "draft-helper")
        self.assertTrue((self.workspace_skill_root() / "draft-helper" / "SKILL.md").exists())

        updated = skills.update_skill(created["id"], {
            "directoryName": "draft-helper-v2",
            "description": "drafts better text",
            "content": "Write with more care.",
        })
        self.assertEqual(updated["slug"], "draft-helper-v2")
        self.assertFalse((self.workspace_skill_root() / "draft-helper").exists())
        self.assertIn("more care", updated["content"])

        deleted = skills.delete_skill(updated["id"])
        self.assertTrue(deleted["success"])
        self.assertFalse((self.workspace_skill_root() / "draft-helper-v2").exists())

        with self.assertRaises(HTTPException) as ctx:
            skills.create_skill({"scope": "workspace", "directoryName": "../bad", "content": "bad"})
        self.assertEqual(ctx.exception.status_code, 400)

    def test_argument_and_runtime_variable_substitution(self) -> None:
        created = skills.create_skill({
            "scope": "workspace",
            "directoryName": "arg-skill",
            "name": "Argument Skill",
            "arguments": ["topic", "audience"],
            "content": (
                "topic=$topic audience=$audience first=$0 second=$ARGUMENTS[1] "
                "all=$ARGUMENTS dir=${OPENWPS_SKILL_DIR} session=${OPENWPS_SESSION_ID}"
            ),
        })

        expanded = skills.expand_skill_for_model(
            created["slug"],
            '"hello world" readers',
            session_id="sess-1",
            workspace_id="default",
        )

        prompt = expanded["prompt"]
        self.assertIn("topic=hello world", prompt)
        self.assertIn("audience=readers", prompt)
        self.assertIn("first=hello world", prompt)
        self.assertIn("second=readers", prompt)
        self.assertIn('all="hello world" readers', prompt)
        self.assertIn("session=sess-1", prompt)
        self.assertIn("/arg-skill", prompt)

    def test_disabled_skill_is_not_model_discoverable(self) -> None:
        skills.create_skill({
            "scope": "workspace",
            "directoryName": "hidden-skill",
            "name": "Hidden Skill",
            "description": "should stay hidden",
            "disableModelInvocation": True,
            "content": "Hidden.",
        })

        data = skills.list_skills(scope="workspace")
        self.assertFalse(data["skills"][0]["availableForModel"])
        discovery = skills.build_skill_discovery_delta("default")
        self.assertEqual(discovery, [])

    def test_ai_skill_inline_execution_appends_skill_context(self) -> None:
        skills.create_skill({
            "scope": "workspace",
            "directoryName": "inline-skill",
            "name": "Inline Skill",
            "description": "inline helper",
            "content": "Inline instructions for $ARGUMENTS.",
        })
        session = create_react_session(ChatRequest(message="use inline", mode="agent", context={"workspaceId": "default"}))
        coordinator = QueryCoordinator(session)
        execution = PlannedToolExecution(
            execution_id="exec_skill",
            tool_name="Skill",
            params={"skill": "inline-skill", "arguments": "drafting"},
            source_calls=[SourceToolCall(id="call_skill", name="Skill", params={})],
            executor_location="server",
            read_only=True,
        )

        _result, _summary, events = asyncio.run(coordinator._execute_server_execution(execution))

        self.assertTrue(session.loaded_skills)
        self.assertTrue(any("type=skill_context" in value for value in session.loaded_skills.values()))
        self.assertTrue(any(event.get("type") == "skill_loaded" for event in events))

    def test_ai_skill_fork_execution_uses_agent_path(self) -> None:
        created = skills.create_skill({
            "scope": "workspace",
            "directoryName": "fork-skill",
            "name": "Fork Skill",
            "description": "fork helper",
            "context": "fork",
            "agent": "document-research",
            "content": "Fork instructions.",
        })
        session = create_react_session(ChatRequest(message="use fork", mode="agent", context={"workspaceId": "default"}))
        coordinator = QueryCoordinator(session)
        execution = PlannedToolExecution(
            execution_id="exec_fork_skill",
            tool_name="Skill",
            params={"skill": created["slug"], "reason": "test"},
            source_calls=[SourceToolCall(id="call_fork_skill", name="Skill", params={})],
            executor_location="server",
            read_only=True,
        )

        async def fake_run_subagent(*_args, **kwargs):
            yield {"type": "agent_start", "agentId": kwargs["agent_id"], "agentType": kwargs["agent"].agent_type}
            yield {"type": "_subagent_result", "content": "fork result"}

        with patch.object(QueryCoordinator, "_run_subagent", fake_run_subagent):
            result, _summary, events = asyncio.run(coordinator._execute_server_execution(execution))

        payload = json.loads(result["content"])
        self.assertTrue(payload["success"])
        self.assertEqual(payload["data"]["context"], "fork")
        self.assertEqual(payload["data"]["result"], "fork result")
        self.assertFalse(session.loaded_skills)
        self.assertTrue(any(event.get("type") == "agent_start" for event in events))


if __name__ == "__main__":
    unittest.main()
