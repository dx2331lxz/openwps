from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from langchain_core.messages import AIMessageChunk

from server.app.ai import (
    ReasoningContentChatOpenAI,
    _build_ai_message,
    _extract_reasoning,
    _extract_token_usage,
    _http_error_message,
    _normalize_ai_api_error_detail,
    _serialize_tool_result_payload,
    _to_langchain_message,
    _with_backend_workspace_docs,
)
from server.app.models import ChatRequest


class ReasoningExtractionTest(unittest.TestCase):
    def test_extracts_reasoning_from_additional_kwargs(self) -> None:
        chunk = AIMessageChunk(
            content="",
            additional_kwargs={"reasoning_content": "先分析文档结构。", "thinking": "再选择工具。"},
        )

        self.assertEqual(_extract_reasoning(chunk), "先分析文档结构。再选择工具。")

    def test_extracts_reasoning_from_response_metadata(self) -> None:
        chunk = AIMessageChunk(
            content="",
            response_metadata={"reasoning_content": "需要先读取全文。"},
        )

        self.assertEqual(_extract_reasoning(chunk), "需要先读取全文。")

    def test_extracts_reasoning_from_typed_content_blocks(self) -> None:
        chunk = AIMessageChunk(
            content=[
                {"type": "reasoning", "text": "判断是否需要调用 verification。"},
                {"type": "text", "text": "这是普通正文。"},
                {"type": "thinking_delta", "delta": "确认后再写入。"},
            ],
        )

        self.assertEqual(_extract_reasoning(chunk), "判断是否需要调用 verification。确认后再写入。")

    def test_does_not_extract_plain_content_as_reasoning(self) -> None:
        self.assertEqual(_extract_reasoning(AIMessageChunk(content="普通正文")), "")
        self.assertEqual(
            _extract_reasoning(AIMessageChunk(content=[{"type": "text", "text": "普通正文"}])),
            "",
        )

    def test_builds_ai_message_with_reasoning_content_for_next_round(self) -> None:
        message = _build_ai_message("需要调用工具。", reasoning_content="先分析段落。")

        self.assertEqual(message.content, "需要调用工具。")
        self.assertEqual(message.additional_kwargs.get("reasoning_content"), "先分析段落。")

    def test_request_payload_preserves_reasoning_content(self) -> None:
        llm = ReasoningContentChatOpenAI(
            model="test-model",
            api_key="not-needed",
            base_url="https://example.test/v1",
        )
        message = _build_ai_message(
            "需要调用工具。",
            tool_calls=[{"id": "call_1", "name": "search_text", "args": {"query": "标题"}, "type": "tool_call"}],
            reasoning_content="先分析段落。",
        )

        payload = llm._get_request_payload([message])

        self.assertEqual(payload["messages"][0].get("reasoning_content"), "先分析段落。")
        self.assertIn("tool_calls", payload["messages"][0])

    def test_request_payload_can_pass_empty_reasoning_content(self) -> None:
        message = _build_ai_message(
            "需要调用工具。",
            tool_calls=[{"id": "call_1", "name": "search_text", "args": {}, "type": "tool_call"}],
            reasoning_content="",
        )

        default_llm = ReasoningContentChatOpenAI(
            model="test-model",
            api_key="not-needed",
            base_url="https://example.test/v1",
        )
        default_payload = default_llm._get_request_payload([message])
        self.assertNotIn("reasoning_content", default_payload["messages"][0])

        thinking_llm = ReasoningContentChatOpenAI(
            model="test-model",
            api_key="not-needed",
            base_url="https://example.test/v1",
            pass_empty_reasoning_content=True,
        )
        thinking_payload = thinking_llm._get_request_payload([message])
        self.assertEqual(thinking_payload["messages"][0].get("reasoning_content"), "")

    def test_extracts_openai_compatible_token_usage(self) -> None:
        chunk = AIMessageChunk(
            content="",
            response_metadata={"token_usage": {"prompt_tokens": 12, "completion_tokens": 3, "total_tokens": 15}},
        )

        self.assertEqual(_extract_token_usage(chunk), {
            "inputTokens": 12,
            "outputTokens": 3,
            "totalTokens": 15,
        })

    def test_replays_persisted_thinking_as_reasoning_content(self) -> None:
        message = _to_langchain_message({
            "role": "assistant",
            "content": "已完成。",
            "thinking": "先调用工具再总结。",
        })

        self.assertEqual(message.additional_kwargs.get("reasoning_content"), "先调用工具再总结。")

    def test_html_error_detail_is_compacted_for_model_context(self) -> None:
        html = "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>" + ("cloudflare " * 500) + "</body></html>"
        body = ChatRequest(message="检查页面", model="text-model")

        normalized = _normalize_ai_api_error_detail(body, html)
        self.assertNotIn("<!DOCTYPE html>", normalized)
        self.assertLess(len(normalized), 500)

        http_message = _http_error_message(HTTPException(status_code=502, detail=f"多模态模型请求失败: {html}"))
        self.assertNotIn("<!DOCTYPE html>", http_message)
        self.assertLess(len(http_message), 1000)

        payload = json.loads(_serialize_tool_result_payload(
            tool_name="capture_page_screenshot",
            success=False,
            message=f"后端视觉模型未能完成页面截图验收：{html}",
            executed_params={"page": 1},
        ))
        self.assertNotIn("<!DOCTYPE html>", payload["message"])
        self.assertLess(len(payload["message"]), 1000)

    def test_workspace_manifest_is_backend_owned(self) -> None:
        client_context = {
            "paragraphCount": 1,
            "workspaceDocs": [{"id": "client_doc", "name": "客户端伪造.pdf"}],
        }
        backend_docs = [{
            "id": "backend_doc",
            "name": "后端资料.pdf",
            "type": "pdf",
            "size": 128,
            "textLength": 32,
            "uploadedAt": "2026-04-28T10:00:00",
        }]

        with patch("server.app.ai.list_workspace_docs", return_value=backend_docs):
            context = _with_backend_workspace_docs(client_context)

        self.assertEqual(context["paragraphCount"], 1)
        self.assertEqual(context["workspaceDocs"], backend_docs)
        self.assertNotIn("client_doc", json.dumps(context, ensure_ascii=False))


if __name__ == "__main__":
    unittest.main()
