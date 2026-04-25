from __future__ import annotations

import unittest

from server.app.agents import build_agent_system_prompt
from server.app.content import build_system_content
from server.app.tool_registry import TOOL_SEARCH_NAME, build_tool_guidance_section
from server.app.tooling import (
    AGENT_TOOL_NAMES,
    EDIT_TOOL_NAMES,
    LAYOUT_TOOL_NAMES,
    TOOLS,
    get_model_tools,
    get_tool_definition,
    get_tool_metadata_payload,
    get_tools,
    search_deferred_tool_definitions,
)


def _tool_names(tools: list[dict]) -> set[str]:
    return {
        str(tool.get("function", {}).get("name", ""))
        for tool in tools
    }


def _base_tool(name: str) -> dict:
    for tool in TOOLS:
        if tool["function"]["name"] == name:
            return tool
    raise AssertionError(f"missing tool: {name}")


class ToolPromptInjectionTest(unittest.TestCase):
    def test_get_tools_keeps_mode_tool_sets(self) -> None:
        self.assertEqual(_tool_names(get_tools("layout")), LAYOUT_TOOL_NAMES)
        self.assertEqual(_tool_names(get_tools("edit")), EDIT_TOOL_NAMES)
        self.assertEqual(_tool_names(get_tools("agent")), AGENT_TOOL_NAMES)

    def test_get_tools_enhances_copy_without_mutating_global_tools(self) -> None:
        original = _base_tool("get_document_outline")
        original_description = original["function"]["description"]

        enhanced = next(tool for tool in get_tools("agent") if tool["function"]["name"] == "get_document_outline")
        self.assertIn("使用时机", enhanced["function"]["description"])
        self.assertIn("长文档", enhanced["function"]["description"])
        self.assertEqual(original["function"]["description"], original_description)
        self.assertNotIn("使用时机", original["function"]["description"])

    def test_enhanced_tool_schema_is_stable(self) -> None:
        definition = get_tool_definition("apply_style_batch")
        self.assertIsNotNone(definition)
        first = definition.to_openai_tool(agent_type="agent") if definition else {}
        second = definition.to_openai_tool(agent_type="agent") if definition else {}
        self.assertEqual(first, second)
        self.assertIn("避免", first["function"]["description"])
        self.assertIn("结果语义", first["function"]["description"])

    def test_model_tools_defer_low_frequency_tools_until_tool_search(self) -> None:
        first_round_names = _tool_names(get_model_tools("agent", set()))
        self.assertIn(TOOL_SEARCH_NAME, first_round_names)
        self.assertNotIn("web_search", first_round_names)
        self.assertNotIn("insert_mermaid", first_round_names)

        loaded_names = _tool_names(get_model_tools("agent", {"web_search"}))
        self.assertIn("web_search", loaded_names)
        self.assertIn(TOOL_SEARCH_NAME, loaded_names)

    def test_tool_search_matches_deferred_tools(self) -> None:
        matches = search_deferred_tool_definitions("agent", "select:web_search", set())
        self.assertEqual([definition.name for definition in matches], ["web_search"])
        empty = search_deferred_tool_definitions("agent", "select:not_a_tool", set())
        self.assertEqual(empty, [])

    def test_execution_metadata_is_registry_derived(self) -> None:
        self.assertEqual(get_tool_metadata_payload("web_search")["executorLocation"], "server")
        self.assertTrue(get_tool_metadata_payload("get_document_outline")["readOnly"])
        self.assertTrue(get_tool_metadata_payload("get_document_outline")["parallelSafe"])
        self.assertFalse(get_tool_metadata_payload("apply_style_batch")["parallelSafe"])
        self.assertFalse(get_tool_metadata_payload("apply_style_batch")["allowedForAgent"])

    def test_guidance_is_trimmed_to_enabled_mode_tools(self) -> None:
        layout_guidance = build_tool_guidance_section("layout", sorted(LAYOUT_TOOL_NAMES))
        self.assertIn("排版阶梯", layout_guidance)
        self.assertNotIn("web_search", layout_guidance)
        self.assertNotIn("begin_streaming_write", layout_guidance)

        agent_guidance = build_tool_guidance_section("agent", sorted(AGENT_TOOL_NAMES))
        self.assertIn("子代理调度", agent_guidance)
        self.assertIn("workspace_search", agent_guidance)
        self.assertIn("web_search", agent_guidance)

    def test_subagent_guidance_is_read_only_and_verification_scoped(self) -> None:
        tool_names = [
            "TaskList",
            "get_document_content",
            "get_document_outline",
            "get_page_content",
            "get_paragraph",
            "search_text",
        ]
        prompt = build_agent_system_prompt(
            type("Agent", (), {
                "agent_type": "verification",
                "prompt": "你是结果校验子代理。",
            })(),
            tool_names,
        )
        self.assertIn("只读子代理", prompt)
        self.assertIn("PASS / PARTIAL / FAIL", prompt)
        self.assertNotIn("begin_streaming_write", prompt)
        self.assertNotIn("apply_style_batch", prompt)

    def test_system_content_trace_includes_tool_prompt_metadata_only(self) -> None:
        system_content = build_system_content("agent", {"id": "openai", "promptCacheMode": "openai_auto"}, get_tools("agent"))
        self.assertIn("工具使用原则", system_content.prompt)
        self.assertIn("toolPrompt", system_content.trace)
        self.assertGreater(system_content.trace["toolPrompt"]["toolCount"], 0)
        self.assertGreater(system_content.trace["toolPrompt"]["guidanceChars"], 0)
        self.assertNotIn("工具使用原则", str(system_content.trace))
        self.assertNotIn("prompt_cache_key", str(system_content.trace))

    def test_prompt_hash_changes_with_tool_guidance_and_schema(self) -> None:
        without_tools = build_system_content("agent", {"id": "openai", "promptCacheMode": "openai_auto"}, [])
        with_tools = build_system_content("agent", {"id": "openai", "promptCacheMode": "openai_auto"}, get_tools("agent"))
        self.assertNotEqual(without_tools.static_prompt_hash, with_tools.static_prompt_hash)
        self.assertNotEqual(without_tools.tool_schema_hash, with_tools.tool_schema_hash)


if __name__ == "__main__":
    unittest.main()
