from __future__ import annotations

import unittest

from langchain_core.messages import AIMessageChunk

from server.app.ai import _extract_reasoning


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


if __name__ == "__main__":
    unittest.main()
