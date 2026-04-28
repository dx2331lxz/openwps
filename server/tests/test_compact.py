from __future__ import annotations

import json
import unittest

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from server.app.compact import (
    build_compact_policy,
    build_compacted_messages,
    count_messages_tokens,
    drop_oldest_api_round,
    microcompact_messages,
    strip_large_payloads_for_summary,
)


def _tool_result(tool_name: str, index: int, *, large: bool = True) -> ToolMessage:
    payload = {
        "success": True,
        "toolName": tool_name,
        "message": f"ok {index}",
        "data": {"content": ("正文" * 1000 if large else "短结果"), "index": index},
    }
    return ToolMessage(content=json.dumps(payload, ensure_ascii=False), tool_call_id=f"call_{index}")


class CompactPolicyTest(unittest.TestCase):
    def test_model_windows_and_provider_overrides(self) -> None:
        openai = build_compact_policy({"id": "openai"}, "gpt-5")
        self.assertEqual(openai.context_window_tokens, 128_000)
        self.assertEqual(openai.compact_summary_max_output_tokens, 20_000)
        self.assertEqual(openai.auto_compact_threshold_tokens, 95_000)

        claude = build_compact_policy({"id": "anthropic"}, "claude-4-sonnet")
        self.assertEqual(claude.context_window_tokens, 200_000)

        local = build_compact_policy({"id": "ollama", "endpoint": "http://localhost:11434/v1"}, "unknown")
        self.assertEqual(local.context_window_tokens, 32_000)

        overridden = build_compact_policy(
            {"id": "custom", "contextWindowTokens": 64_000, "compactSummaryMaxOutputTokens": 30_000},
            "custom-model",
        )
        self.assertEqual(overridden.context_window_tokens, 64_000)
        self.assertEqual(overridden.compact_summary_max_output_tokens, 20_000)

    def test_message_tokens_are_counted_with_tokenizer(self) -> None:
        messages = [
            SystemMessage(content="system"),
            HumanMessage(content="你好 world"),
            AIMessage(content="", tool_calls=[{
                "id": "call_1",
                "name": "search_text",
                "args": {"text": "你好"},
                "type": "tool_call",
            }]),
        ]

        count = count_messages_tokens(messages, model="gpt-4o")

        self.assertGreater(count, 10)
        self.assertLess(count, 100)


class MicrocompactTest(unittest.TestCase):
    def test_microcompact_only_old_read_only_results(self) -> None:
        messages = [SystemMessage(content="system"), HumanMessage(content="user")]
        for index in range(5):
            messages.append(AIMessage(content="", tool_calls=[{
                "id": f"call_{index}",
                "name": "get_document_content",
                "args": {},
                "type": "tool_call",
            }]))
            messages.append(_tool_result("get_document_content", index))
        messages.append(AIMessage(content="", tool_calls=[{
            "id": "call_write",
            "name": "complete_streaming_write",
            "args": {},
            "type": "tool_call",
        }]))
        messages.append(_tool_result("complete_streaming_write", 99))

        result = microcompact_messages(messages, keep_recent_results=3)

        self.assertTrue(result.changed)
        self.assertEqual(result.compacted_tool_results, 2)
        compacted = [message for message in result.messages if isinstance(message, ToolMessage) and "compacted" in str(message.content)]
        self.assertEqual(len(compacted), 2)
        write_result = result.messages[-1]
        self.assertIsInstance(write_result, ToolMessage)
        self.assertNotIn("compacted", str(write_result.content))


class CompactLifecycleTest(unittest.TestCase):
    def test_compacted_message_order_preserves_system_then_boundary_summary_tail_restore(self) -> None:
        messages = [
            SystemMessage(content="system"),
            HumanMessage(content="first"),
            AIMessage(content="worked"),
            HumanMessage(content="latest"),
        ]
        policy = build_compact_policy({"id": "openai"}, "gpt-4o")
        restored = [HumanMessage(content="[系统附件] type=workspace_docs_snapshot\n{}")]

        result = build_compacted_messages(messages, summary="摘要", policy=policy, source="auto", restored_attachments=restored)

        self.assertIsInstance(result.messages[0], SystemMessage)
        non_system = result.messages[1:]
        self.assertIn("type=compact_boundary", str(non_system[0].content))
        self.assertIn("type=compact_summary", str(non_system[1].content))
        self.assertEqual(non_system[-1].content, restored[0].content)
        self.assertIn("workspace_docs_snapshot", result.restored_attachment_types)

    def test_summary_payload_strips_data_urls_and_large_documents(self) -> None:
        data_url = "data:image/png;base64," + ("A" * 5000)
        messages = [
            HumanMessage(content=json.dumps({"image": data_url, "content": "文档" * 4000}, ensure_ascii=False)),
        ]

        stripped = strip_large_payloads_for_summary(messages)
        content = str(stripped[0].content)

        self.assertIn("[image]", content)
        self.assertIn("[document]", content)
        self.assertNotIn("A" * 100, content)

    def test_drop_oldest_api_round(self) -> None:
        messages = [
            SystemMessage(content="system"),
            HumanMessage(content="first"),
            AIMessage(content="first done"),
            HumanMessage(content="second"),
            AIMessage(content="second done"),
        ]

        trimmed, changed = drop_oldest_api_round(messages)

        self.assertTrue(changed)
        self.assertEqual(trimmed[0].content, "system")
        self.assertNotIn("first", [str(message.content) for message in trimmed])
        self.assertIn("second", [str(message.content) for message in trimmed])


if __name__ == "__main__":
    unittest.main()
