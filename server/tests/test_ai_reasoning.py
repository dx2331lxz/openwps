from __future__ import annotations

import unittest

from langchain_core.messages import AIMessageChunk

from server.app.ai import ReasoningContentChatOpenAI, _build_ai_message, _extract_reasoning, _to_langchain_message


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

    def test_replays_persisted_thinking_as_reasoning_content(self) -> None:
        message = _to_langchain_message({
            "role": "assistant",
            "content": "已完成。",
            "thinking": "先调用工具再总结。",
        })

        self.assertEqual(message.additional_kwargs.get("reasoning_content"), "先调用工具再总结。")


if __name__ == "__main__":
    unittest.main()
