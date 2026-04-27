from __future__ import annotations

import base64
import struct
import unittest
import json
import zlib

from server.app.models import ChatRequest
from server.app.content import (
    build_delta_content,
    build_initial_context_content,
    build_prompt_cache_config,
    build_subagent_content,
    build_system_content,
    build_user_content,
)
from server.app.ai import VISION_TEST_IMAGE_DATA_URL, _prepare_page_screenshot_tool_result
from server.app.agents import AgentDefinition
from server.app.config import PRESET_PROVIDERS, normalize_config


class DummyMessage:
    def __init__(self, content: str):
        self.content = content


class ContentModuleTest(unittest.TestCase):
    def test_builtin_vision_test_image_is_valid_png(self) -> None:
        header, encoded = VISION_TEST_IMAGE_DATA_URL.split(",", 1)
        self.assertEqual(header, "data:image/png;base64")
        raw = base64.b64decode(encoded, validate=True)
        self.assertEqual(raw[:8], b"\x89PNG\r\n\x1a\n")

        cursor = 8
        found_iend = False
        while cursor < len(raw):
            length = struct.unpack(">I", raw[cursor:cursor + 4])[0]
            chunk_type = raw[cursor + 4:cursor + 8]
            chunk_data = raw[cursor + 8:cursor + 8 + length]
            expected_crc = struct.unpack(">I", raw[cursor + 8 + length:cursor + 12 + length])[0]
            actual_crc = zlib.crc32(chunk_type + chunk_data) & 0xFFFFFFFF
            self.assertEqual(actual_crc, expected_crc, chunk_type.decode("ascii", errors="replace"))
            cursor += 12 + length
            if chunk_type == b"IEND":
                found_iend = True
                break

        self.assertTrue(found_iend)

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

    def test_initial_workspace_docs_are_not_described_as_new(self) -> None:
        context = {
            "workspaceDocs": [{
                "id": "doc_1",
                "name": "初试成绩.pdf",
                "type": "pdf",
                "size": 1024,
                "textLength": 88,
            }],
        }

        initial = build_initial_context_content(context)

        self.assertIn("当前工作区已有文档", initial.content)
        self.assertIn("已有文档", initial.content)
        self.assertNotIn("新增文档", initial.content)
        self.assertIn("不代表当前任务执行过程中新增", initial.content)

    def test_workspace_docs_without_prior_delta_are_treated_as_initial(self) -> None:
        context = {
            "workspaceDocs": [{
                "id": "doc_1",
                "name": "初试成绩.pdf",
                "type": "pdf",
                "size": 1024,
                "textLength": 88,
            }],
        }

        delta = build_delta_content(context, [])

        self.assertEqual(delta.trace["deltaCount"], 1)
        self.assertIn("当前工作区已有文档", delta.content[0])
        self.assertIn("已有文档", delta.content[0])
        self.assertNotIn("新增文档", delta.content[0])

    def test_workspace_delta_after_initial_context_describes_new_docs(self) -> None:
        initial_context = {
            "workspaceDocs": [{
                "id": "doc_1",
                "name": "参考资料.pdf",
                "type": "pdf",
                "size": 1024,
                "textLength": 88,
            }],
        }
        initial = build_initial_context_content(initial_context)
        changed = build_delta_content(
            {
                "workspaceDocs": [
                    *initial_context["workspaceDocs"],
                    {
                        "id": "doc_2",
                        "name": "新增资料.pdf",
                        "type": "pdf",
                        "size": 2048,
                        "textLength": 120,
                    },
                ],
            },
            [DummyMessage(initial.content)],
        )

        self.assertEqual(changed.trace["deltaCount"], 1)
        self.assertIn("新增文档", changed.content[0])
        self.assertIn("新增资料.pdf", changed.content[0])

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

    def test_page_screenshot_tool_result_blocks_non_vision_model(self) -> None:
        raw = {
            "success": True,
            "message": "已截取第 2 页截图",
            "toolName": "capture_page_screenshot",
            "data": {
                "page": 2,
                "pageCount": 3,
                "previewText": "页面预览",
                "dataUrl": "data:image/png;base64,AAAA",
            },
        }
        safe_content, image_message = _prepare_page_screenshot_tool_result(
            json.dumps(raw, ensure_ascii=False),
            ChatRequest(
                message="检查页面视觉效果",
                providerId="siliconflow",
                model="Qwen/Qwen2.5-72B-Instruct",
            ),
        )
        payload = json.loads(safe_content)

        self.assertIsNone(image_message)
        self.assertFalse(payload["success"])
        self.assertNotIn("data:image/png", safe_content)
        self.assertEqual(payload["capabilityBlocked"], "vision")
        self.assertEqual(payload["data"]["capabilityBlocked"], "vision")
        self.assertFalse(payload["recoverable"])
        self.assertEqual(payload["suggestedAction"], "finalize_or_switch_vision_model")


if __name__ == "__main__":
    unittest.main()
