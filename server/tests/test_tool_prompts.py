from __future__ import annotations

import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from server.app.agents import AgentDefinition, build_agent_system_prompt, get_agent_definition, resolve_agent_tool_names
from server.app.ai import (
    PlannedToolExecution,
    QueryCoordinator,
    RuntimeCapabilities,
    SourceToolCall,
    _build_layout_preflight_prompt,
    _build_parallel_execution_batches,
    _get_model_tools_for_body,
    _get_tool_definitions_for_body,
    _is_layout_content_tool_blocked,
    _should_require_layout_preflight,
    _resolve_subagent_model,
    create_react_session,
)
from server.app.content import build_system_content
from server.app.models import ChatRequest, OCRConfig, VisionConfig
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


def _find_tool(tools: list[dict], name: str) -> dict:
    for tool in tools:
        if str(tool.get("function", {}).get("name", "")) == name:
            return tool
    raise AssertionError(f"missing tool: {name}")


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

    def test_model_tools_expose_table_delete_and_structure_tools_when_loaded(self) -> None:
        table_tools = {
            "delete_table",
            "insert_table_row_before",
            "insert_table_row_after",
            "delete_table_row",
            "insert_table_column_before",
            "insert_table_column_after",
            "delete_table_column",
        }
        names = _tool_names(get_model_tools("agent", table_tools))
        self.assertTrue(table_tools.issubset(names))
        self.assertIn("delete_table", _tool_names(get_model_tools("edit", {"delete_table"})))
        self.assertNotIn("delete_table", _tool_names(get_model_tools("layout", {"delete_table"})))

    def test_tool_search_matches_deferred_tools(self) -> None:
        matches = search_deferred_tool_definitions("agent", "select:web_search", set())
        self.assertEqual([definition.name for definition in matches], ["web_search"])
        empty = search_deferred_tool_definitions("agent", "select:not_a_tool", set())
        self.assertEqual(empty, [])

    def test_runtime_tools_hide_vision_tools_without_runtime(self) -> None:
        body = ChatRequest(
            message="检查页面",
            mode="agent",
            providerId="siliconflow",
            model="Qwen/Qwen2.5-72B-Instruct",
        )
        with (
            patch("server.app.ai._headless_screenshot_available", return_value=True),
            patch("server.app.ai._resolve_vision_config", return_value=VisionConfig(enabled=False)),
            patch("server.app.ai._normalize_ocr_config", return_value=OCRConfig(enabled=False)),
        ):
            names = _tool_names(_get_model_tools_for_body(body, {"analyze_document_image"}))

        self.assertNotIn("capture_page_screenshot", names)
        self.assertNotIn("analyze_document_image", names)

    def test_runtime_tools_allow_screenshot_with_vision_fallback(self) -> None:
        body = ChatRequest(
            message="检查页面",
            mode="agent",
            providerId="siliconflow",
            model="Qwen/Qwen2.5-72B-Instruct",
        )
        with (
            patch("server.app.ai._headless_screenshot_available", return_value=True),
            patch(
                "server.app.ai._resolve_vision_config",
                return_value=VisionConfig(
                    enabled=True,
                    endpoint="https://vision.example/v1",
                    model="vision-model",
                    apiKey="key",
                    hasApiKey=True,
                ),
            ),
            patch("server.app.ai._normalize_ocr_config", return_value=OCRConfig(enabled=False)),
        ):
            tools = _get_model_tools_for_body(body, {"analyze_document_image"})
            names = _tool_names(tools)

        self.assertIn("capture_page_screenshot", names)
        self.assertIn("analyze_document_image", names)
        self.assertIn("后端多模态 fallback", _find_tool(tools, "capture_page_screenshot")["function"]["description"])

    def test_runtime_tools_limit_document_image_to_ocr_when_only_ocr_available(self) -> None:
        body = ChatRequest(
            message="分析图片",
            mode="agent",
            providerId="siliconflow",
            model="Qwen/Qwen2.5-72B-Instruct",
        )
        with (
            patch("server.app.ai._headless_screenshot_available", return_value=True),
            patch("server.app.ai._resolve_vision_config", return_value=VisionConfig(enabled=False)),
            patch(
                "server.app.ai._normalize_ocr_config",
                return_value=OCRConfig(
                    enabled=True,
                    endpoint="https://ocr.example/v1",
                    model="ocr-model",
                    apiKey="key",
                    hasApiKey=True,
                ),
            ),
        ):
            tools = _get_model_tools_for_body(body, {"analyze_document_image"})
            names = _tool_names(tools)
            image_tool = _find_tool(tools, "analyze_document_image")

        self.assertNotIn("capture_page_screenshot", names)
        self.assertIn("analyze_document_image", names)
        analysis_mode = image_tool["function"]["parameters"]["properties"]["analysisMode"]
        self.assertEqual(analysis_mode["enum"], ["ocr"])

    def test_layout_preflight_intent_detection_is_broad_not_local(self) -> None:
        context = {"documentSessionId": "doc_test", "pageCount": 3}
        broad = ChatRequest(message="请严格按照当前模板对全文进行排版", context=context)
        local = ChatRequest(message="把第 3 段加粗", context=context)
        no_session = ChatRequest(message="请对全文进行排版", context={})

        self.assertTrue(_should_require_layout_preflight(broad, context))
        self.assertFalse(_should_require_layout_preflight(local, context))
        self.assertFalse(_should_require_layout_preflight(no_session, {}))

    def test_layout_content_lock_blocks_content_tools(self) -> None:
        self.assertTrue(_is_layout_content_tool_blocked("begin_streaming_write"))
        self.assertTrue(_is_layout_content_tool_blocked("delete_paragraph"))
        self.assertTrue(_is_layout_content_tool_blocked("delete_table"))
        self.assertFalse(_is_layout_content_tool_blocked("set_paragraph_style"))

    def test_layout_preflight_prompt_requires_single_page_style_evidence(self) -> None:
        prompt = _build_layout_preflight_prompt(2, 5, screenshot_available=True)
        self.assertIn("第 2/5 页", prompt)
        self.assertIn("get_page_content(page=2)", prompt)
        self.assertIn("get_page_style_summary(page=2)", prompt)
        self.assertIn("capture_page_screenshot(page=2", prompt)

    def test_layout_preflight_runs_one_page_analysis_per_page(self) -> None:
        async def run():
            body = ChatRequest(
                message="请严格按照模板对全文进行排版",
                context={"documentSessionId": "doc_test", "pageCount": 3},
            )
            session = create_react_session(body)
            coordinator = QueryCoordinator(session)

            async def fake_page(self, page, page_count, *, screenshot_available):
                return {
                    "page": page,
                    "success": True,
                    "result": f"page={page}; count={page_count}; screenshot={screenshot_available}",
                }

            with (
                patch.object(QueryCoordinator, "_resolve_layout_preflight_page_count", AsyncMock(return_value=3)),
                patch.object(QueryCoordinator, "_run_layout_preflight_page", fake_page),
                patch(
                    "server.app.ai._resolve_runtime_capabilities",
                    return_value=RuntimeCapabilities(
                        main_model_supports_vision=False,
                        vision_fallback_available=False,
                        vision_runtime_available=False,
                        ocr_available=False,
                        headless_screenshot_available=True,
                    ),
                ),
            ):
                events = []
                async for event in coordinator._run_layout_preflight():
                    events.append(event)
                return session, events

        session, events = asyncio.run(run())
        self.assertTrue(session.state.layout_preflight_required)
        self.assertTrue(session.state.layout_preflight_completed)
        self.assertTrue(session.state.content_locked_for_layout)
        self.assertEqual(len(session.state.layout_style_dossier["pages"]), 3)
        self.assertEqual([event["type"] for event in events if event["type"] == "layout_preflight_page_done"], [
            "layout_preflight_page_done",
            "layout_preflight_page_done",
            "layout_preflight_page_done",
        ])

    def test_execution_metadata_is_registry_derived(self) -> None:
        self.assertEqual(get_tool_metadata_payload("web_search")["executorLocation"], "server")
        self.assertTrue(get_tool_metadata_payload("get_document_outline")["readOnly"])
        self.assertTrue(get_tool_metadata_payload("get_document_outline")["parallelSafe"])
        self.assertTrue(get_tool_metadata_payload("capture_page_screenshot")["readOnly"])
        self.assertTrue(get_tool_metadata_payload("capture_page_screenshot")["parallelSafe"])
        self.assertTrue(get_tool_metadata_payload("capture_page_screenshot")["allowedForAgent"])
        self.assertTrue(get_tool_metadata_payload("Agent")["parallelSafe"])
        self.assertFalse(get_tool_metadata_payload("apply_style_batch")["parallelSafe"])
        self.assertFalse(get_tool_metadata_payload("apply_style_batch")["allowedForAgent"])

    def test_agent_tool_does_not_expose_model_override(self) -> None:
        agent_tool = _find_tool(get_tools("agent"), "Agent")
        properties = agent_tool["function"]["parameters"]["properties"]
        self.assertNotIn("model", properties)

    def test_layout_plan_screenshot_tool_follows_runtime_capability(self) -> None:
        body = ChatRequest(
            message="分析页面样式",
            mode="agent",
            providerId="siliconflow",
            model="Qwen/Qwen2.5-72B-Instruct",
        )
        agent = get_agent_definition("layout-plan")
        with (
            patch("server.app.ai._headless_screenshot_available", return_value=True),
            patch("server.app.ai._resolve_vision_config", return_value=VisionConfig(enabled=False)),
            patch("server.app.ai._normalize_ocr_config", return_value=OCRConfig(enabled=False)),
        ):
            available = {definition.name for definition in _get_tool_definitions_for_body(body)}
            names = resolve_agent_tool_names(agent, available)
        self.assertNotIn("capture_page_screenshot", names)

        with (
            patch("server.app.ai._headless_screenshot_available", return_value=True),
            patch(
                "server.app.ai._resolve_vision_config",
                return_value=VisionConfig(
                    enabled=True,
                    endpoint="https://vision.example/v1",
                    model="vision-model",
                    apiKey="key",
                    hasApiKey=True,
                ),
            ),
            patch("server.app.ai._normalize_ocr_config", return_value=OCRConfig(enabled=False)),
        ):
            available = {definition.name for definition in _get_tool_definitions_for_body(body)}
            names = resolve_agent_tool_names(agent, available)
        self.assertIn("capture_page_screenshot", names)

    def test_subagent_model_inherits_parent_model(self) -> None:
        body = ChatRequest(message="校验文档", providerId="openai", model="gpt-5.4")
        agent = AgentDefinition(
            agent_type="verification",
            description="校验",
            prompt="只读校验",
        )
        self.assertEqual(_resolve_subagent_model(body, agent), "gpt-5.4")

    def test_subagent_definition_model_can_override_parent(self) -> None:
        body = ChatRequest(message="校验文档", providerId="openai", model="gpt-5.4")
        agent = AgentDefinition(
            agent_type="verification",
            description="校验",
            prompt="只读校验",
            model="special-verifier",
        )
        self.assertEqual(_resolve_subagent_model(body, agent), "special-verifier")

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
            "capture_page_screenshot",
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
        self.assertIn("capture_page_screenshot", prompt)
        self.assertNotIn("begin_streaming_write", prompt)
        self.assertNotIn("apply_style_batch", prompt)

    def test_parallel_agent_executions_are_batched(self) -> None:
        executions = [
            PlannedToolExecution(
                execution_id=f"exec_{index}",
                tool_name="Agent",
                params={"prompt": f"check page {index}", "subagent_type": "verification"},
                source_calls=[SourceToolCall(id=f"call_{index}", name="Agent", params={})],
                parallel_group="parallel_agents",
                executor_location="server",
                parallel_safe=True,
            )
            for index in range(1, 4)
        ]
        batches = _build_parallel_execution_batches(executions)
        self.assertEqual(len(batches), 1)
        self.assertEqual([item.execution_id for item in batches[0]], ["exec_1", "exec_2", "exec_3"])

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
