from __future__ import annotations

import unittest
import json

from server.app.content import (
    build_delta_content,
    build_initial_context_content,
    build_prompt_cache_config,
    build_subagent_content,
    build_system_content,
    build_user_content,
)
from server.app.ai import _prepare_page_screenshot_tool_result
from server.app.agents import AgentDefinition
from server.app.config import PRESET_PROVIDERS, normalize_config


class DummyMessage:
    def __init__(self, content: str):
        self.content = content


class ContentModuleTest(unittest.TestCase):
    def test_system_prompt_hash_ignores_dynamic_context(self) -> None:
        provider = {"id": "openai", "promptCacheMode": "openai_auto", "promptCacheRetention": "in_memory"}
        first = build_system_content("agent", provider, tools=[])
        second = build_system_content("agent", provider, tools=[])
        self.assertEqual(first.static_prompt_hash, second.static_prompt_hash)
        self.assertEqual(first.trace["staticPromptHash"], first.static_prompt_hash)
        self.assertNotIn("当前文档上下文", str(first.trace))

    def test_initial_and_delta_context_content(self) -> None:
        context = {
            "paragraphCount": 2,
            "wordCount": 12,
            "pageCount": 1,
            "selection": {"text": "hello"},
        }
        initial = build_initial_context_content(context)
        self.assertTrue(initial.trace["hasContent"])
        self.assertIn("context.selection", initial.content)

        messages = [DummyMessage(initial.content)]
        unchanged = build_delta_content(context, messages)
        self.assertEqual(unchanged.content, [])

        changed_context = {**context, "selection": {"text": "changed"}}
        changed = build_delta_content(changed_context, messages)
        self.assertGreaterEqual(changed.trace["deltaCount"], 1)
        self.assertTrue(any("changed" in item for item in changed.content))

        full = build_delta_content(changed_context, messages, force_full=True)
        self.assertGreaterEqual(full.trace["deltaCount"], 1)
        self.assertTrue(full.trace["forceFull"])

    def test_user_attachment_trace_counts_clipped_chars_without_content(self) -> None:
        result = build_user_content(
            "请总结附件",
            attachments=[{
                "name": "long.txt",
                "textContent": "A" * 25000,
                "textFormat": "text",
            }],
        )
        trace = result.trace
        self.assertEqual(trace["attachmentCount"], 1)
        self.assertEqual(trace["textAttachmentCount"], 1)
        self.assertEqual(trace["includedChars"], 24000)
        self.assertEqual(trace["clippedChars"], 1000)
        self.assertNotIn("A" * 100, str(trace))

    def test_image_content_keeps_user_text_exact_without_image_instruction(self) -> None:
        result = build_user_content(
            "你能描述图片的内容么",
            images=[{"dataUrl": "data:image/png;base64,AAAA"}],
            image_processing_mode="direct_multimodal",
        )

        self.assertIsInstance(result.content, list)
        text = result.content[0]["text"]
        self.assertEqual(text, "你能描述图片的内容么")
        self.assertNotIn("[图片输入]", text)
        self.assertNotIn("请按用户原始请求", text)
        self.assertNotIn("复现到当前文档", text)

    def test_prompt_cache_defaults_and_key(self) -> None:
        normalized = normalize_config({"providers": PRESET_PROVIDERS, "activeProviderId": "openai"})
        providers = {provider["id"]: provider for provider in normalized["providers"]}
        openai = providers["openai"]
        siliconflow = providers["siliconflow"]

        openai_cache = build_prompt_cache_config(
            openai,
            mode="agent",
            static_prompt_hash="abc",
            tool_schema_hash="def",
        )
        self.assertTrue(openai_cache["enabled"])
        self.assertEqual(openai_cache["modelKwargs"]["prompt_cache_retention"], "in_memory")
        self.assertIn("prompt_cache_key", openai_cache["modelKwargs"])

        siliconflow_cache = build_prompt_cache_config(
            siliconflow,
            mode="agent",
            static_prompt_hash="abc",
            tool_schema_hash="def",
        )
        self.assertFalse(siliconflow_cache["enabled"])
        self.assertEqual(siliconflow_cache["modelKwargs"], {})

        custom_cache = build_prompt_cache_config(
            {"id": "custom", "promptCacheMode": "openai_auto", "promptCacheRetention": "24h"},
            mode="layout",
            static_prompt_hash="abc",
            tool_schema_hash="def",
        )
        self.assertTrue(custom_cache["enabled"])
        self.assertEqual(custom_cache["modelKwargs"]["prompt_cache_retention"], "24h")

    def test_subagent_content_trace_is_metadata_only(self) -> None:
        agent = AgentDefinition(
            agent_type="verification",
            description="校验",
            prompt="只读校验 prompt",
            tools=["get_document_content"],
        )
        result = build_subagent_content(
            agent=agent,
            tool_names=["get_document_content"],
            description="检查正文",
            prompt="请检查正文是否正确",
            context={"selection": {"text": "敏感正文"}},
        )
        payload = result.content
        self.assertIn("systemPrompt", payload)
        self.assertIn("userPrompt", payload)
        self.assertIn("敏感正文", payload["userPrompt"])
        self.assertNotIn("敏感正文", str(result.trace))
        self.assertEqual(result.trace["agentType"], "verification")

    def test_page_screenshot_tool_result_injects_image_without_text_data_url(self) -> None:
        raw = {
            "success": True,
            "message": "已截取第 2 页截图",
            "toolName": "capture_page_screenshot",
            "data": {
                "page": 2,
                "pageCount": 3,
                "previewText": "页面预览",
                "instruction": "检查图片是否压住文字",
                "dataUrl": "data:image/png;base64,AAAA",
            },
        }
        safe_content, image_message = _prepare_page_screenshot_tool_result(
            json.dumps(raw, ensure_ascii=False),
        )

        self.assertNotIn("data:image/png", safe_content)
        self.assertIsNotNone(image_message)
        self.assertIsInstance(image_message.content, list)
        self.assertEqual(image_message.content[1]["type"], "image_url")
        self.assertEqual(image_message.content[1]["image_url"]["url"], "data:image/png;base64,AAAA")


if __name__ == "__main__":
    unittest.main()
