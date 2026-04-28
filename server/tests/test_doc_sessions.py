from __future__ import annotations

import asyncio
import json
import unittest

from fastapi import HTTPException

from server.app.doc_sessions import (
    create_document_session,
    execute_document_tool,
    read_active_document_session,
    set_active_document_session,
    subscribe_document_events,
    update_document_session_from_client,
)


class DocumentSessionTest(unittest.TestCase):
    def test_server_tool_updates_authoritative_doc(self) -> None:
        async def run():
            session = await create_document_session({
                "docJson": {
                    "type": "doc",
                    "content": [{
                        "type": "paragraph",
                        "content": [{"type": "text", "text": "hello world"}],
                    }],
                },
            })
            result = await execute_document_tool(
                session["documentSessionId"],
                "set_text_style",
                {"range": {"type": "contains_text", "text": "hello"}, "bold": True},
            )
            updated = result["data"]["documentEvents"][0]["docJson"]
            marks = updated["content"][0]["content"][0]["marks"]
            return result, marks

        result, marks = asyncio.run(run())
        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["version"], 2)
        self.assertEqual(marks[0]["type"], "textStyle")
        self.assertTrue(marks[0]["attrs"]["bold"])

    def test_client_patch_rejects_stale_version(self) -> None:
        async def run():
            session = await create_document_session({})
            await update_document_session_from_client(session["documentSessionId"], {"baseVersion": 1, "selectionContext": None})
            with self.assertRaises(HTTPException) as raised:
                await update_document_session_from_client(session["documentSessionId"], {"baseVersion": 1, "selectionContext": None})
            return raised.exception

        exc = asyncio.run(run())
        self.assertEqual(exc.status_code, 409)

    def test_active_session_can_be_registered_and_read(self) -> None:
        async def run():
            first = await create_document_session({"currentDocumentName": "first"})
            second = await create_document_session({"currentDocumentName": "second"})
            await set_active_document_session(first["documentSessionId"], {"currentDocumentName": "front"})
            active = await read_active_document_session()
            return first, second, active

        first, second, active = asyncio.run(run())
        self.assertNotEqual(first["documentSessionId"], second["documentSessionId"])
        self.assertEqual(active["documentSessionId"], first["documentSessionId"])
        self.assertEqual(active["currentDocumentName"], "front")

    def test_document_event_includes_session_version_and_origin_client(self) -> None:
        async def run():
            session = await create_document_session({})
            stream = subscribe_document_events(session["documentSessionId"])
            snapshot = await anext(stream)
            update_task = asyncio.create_task(update_document_session_from_client(
                session["documentSessionId"],
                {
                    "baseVersion": session["version"],
                    "clientId": "client_a",
                    "docJson": {
                        "type": "doc",
                        "content": [{
                            "type": "paragraph",
                            "content": [{"type": "text", "text": "updated"}],
                        }],
                    },
                },
            ))
            event = await asyncio.wait_for(anext(stream), timeout=1)
            await update_task
            await stream.aclose()
            return snapshot, event

        snapshot, event = asyncio.run(run())
        self.assertEqual(snapshot["type"], "snapshot")
        self.assertEqual(event["type"], "document_replace")
        self.assertEqual(event["source"], "client_patch")
        self.assertEqual(event["originClientId"], "client_a")
        self.assertIsInstance(event["version"], int)
        self.assertTrue(event["documentSessionId"].startswith("doc_"))

    def test_table_row_tool_runs_on_server_worker(self) -> None:
        async def run():
            session = await create_document_session({
                "docJson": {
                    "type": "doc",
                    "content": [
                        {"type": "paragraph", "content": [{"type": "text", "text": "before"}]},
                        {
                            "type": "table",
                            "content": [{
                                "type": "table_row",
                                "content": [
                                    {"type": "table_cell", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "A"}]}]},
                                    {"type": "table_cell", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "B"}]}]},
                                ],
                            }],
                        },
                        {"type": "paragraph"},
                    ],
                },
            })
            result = await execute_document_tool(
                session["documentSessionId"],
                "insert_table_row_after",
                {"tableIndex": 0, "rowIndex": 0},
            )
            return result

        result = asyncio.run(run())
        self.assertTrue(result["success"])
        table = result["data"]["table"]
        self.assertEqual(table["rowCount"], 2)
        self.assertEqual(result["data"]["version"], 2)

    def test_delete_table_tool_removes_entire_table(self) -> None:
        async def run():
            session = await create_document_session({
                "docJson": {
                    "type": "doc",
                    "content": [
                        {"type": "paragraph", "content": [{"type": "text", "text": "before"}]},
                        {
                            "type": "table",
                            "content": [{
                                "type": "table_row",
                                "content": [
                                    {"type": "table_cell", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "A"}]}]},
                                    {"type": "table_cell", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "B"}]}]},
                                ],
                            }],
                        },
                        {"type": "paragraph", "content": [{"type": "text", "text": "after"}]},
                    ],
                },
            })
            result = await execute_document_tool(
                session["documentSessionId"],
                "delete_table",
                {"tableIndex": 0},
            )
            return result

        result = asyncio.run(run())
        self.assertTrue(result["success"], result["message"])
        content = result["data"]["documentEvents"][0]["docJson"]["content"]
        self.assertEqual([node["type"] for node in content], ["paragraph", "paragraph"])
        self.assertNotIn('"type": "table"', json.dumps(content))

    def test_layout_content_lock_blocks_text_changes(self) -> None:
        async def run():
            session = await create_document_session({
                "docJson": {
                    "type": "doc",
                    "content": [
                        {"type": "paragraph", "content": [{"type": "text", "text": "故事一"}]},
                    ],
                },
            })
            blocked = await execute_document_tool(
                session["documentSessionId"],
                "replace_paragraph_text",
                {"paragraphIndex": 0, "text": "被误改的正文"},
                preserve_content_structure=True,
            )
            return blocked, await execute_document_tool(
                session["documentSessionId"],
                "get_document_content",
                {},
            )

        blocked, current = asyncio.run(run())
        self.assertFalse(blocked["success"])
        self.assertTrue(blocked["data"]["contentLockViolation"])
        self.assertIn("故事一", json.dumps(current["data"], ensure_ascii=False))
        self.assertNotIn("被误改的正文", json.dumps(current["data"], ensure_ascii=False))

    def test_layout_content_lock_allows_style_tools_without_text_change(self) -> None:
        async def run():
            session = await create_document_session({
                "docJson": {
                    "type": "doc",
                    "content": [
                        {"type": "paragraph", "content": [{"type": "text", "text": "故事一"}]},
                    ],
                },
            })
            return await execute_document_tool(
                session["documentSessionId"],
                "set_paragraph_style",
                {"range": {"type": "paragraph", "paragraphIndex": 0}, "align": "center"},
                preserve_content_structure=True,
            )

        result = asyncio.run(run())
        self.assertTrue(result["success"], result["message"])
        doc = result["data"]["documentEvents"][0]["docJson"]
        self.assertEqual(doc["content"][0]["attrs"]["align"], "center")

    def test_begin_streaming_write_commits_markdown_on_server(self) -> None:
        async def run():
            session = await create_document_session({
                "docJson": {
                    "type": "doc",
                    "content": [{"type": "paragraph", "content": [{"type": "text", "text": "seed"}]}],
                },
            })
            result = await execute_document_tool(
                session["documentSessionId"],
                "begin_streaming_write",
                {
                    "action": "insert_after_paragraph",
                    "afterParagraph": 0,
                    "markdown": "# 新标题\n\n正文",
                },
            )
            doc = result["data"]["documentEvents"][0]["docJson"]
            return result, doc

        result, doc = asyncio.run(run())
        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["version"], 2)
        self.assertEqual(doc["content"][1]["attrs"]["headingLevel"], 1)
        self.assertEqual(doc["content"][1]["content"][0]["text"], "新标题")

    def test_begin_streaming_write_requires_markdown_parameter(self) -> None:
        async def run():
            session = await create_document_session({
                "docJson": {
                    "type": "doc",
                    "content": [{"type": "paragraph", "content": [{"type": "text", "text": "seed"}]}],
                },
            })
            return await execute_document_tool(
                session["documentSessionId"],
                "begin_streaming_write",
                {"action": "insert_after_paragraph", "afterParagraph": 0},
            )

        result = asyncio.run(run())
        self.assertFalse(result["success"])
        self.assertIn("markdown", result["message"])

    def test_insert_streaming_write_does_not_inherit_page_break_before(self) -> None:
        async def run():
            session = await create_document_session({
                "docJson": {
                    "type": "doc",
                    "content": [{
                        "type": "paragraph",
                        "attrs": {"pageBreakBefore": True},
                        "content": [{"type": "text", "text": "seed"}],
                    }],
                },
            })
            result = await execute_document_tool(
                session["documentSessionId"],
                "begin_streaming_write",
                {
                    "action": "insert_after_paragraph",
                    "afterParagraph": 0,
                    "markdown": "## 标题\n\n正文",
                },
            )
            return result, result["data"]["documentEvents"][0]["docJson"]

        result, doc = asyncio.run(run())
        self.assertTrue(result["success"])
        self.assertTrue(doc["content"][0]["attrs"]["pageBreakBefore"])
        self.assertFalse(doc["content"][1]["attrs"]["pageBreakBefore"])
        self.assertFalse(doc["content"][2]["attrs"]["pageBreakBefore"])

    def test_insert_paragraph_after_does_not_inherit_page_break_before(self) -> None:
        async def run():
            session = await create_document_session({
                "docJson": {
                    "type": "doc",
                    "content": [{
                        "type": "paragraph",
                        "attrs": {"pageBreakBefore": True},
                        "content": [{"type": "text", "text": "seed"}],
                    }],
                },
            })
            result = await execute_document_tool(
                session["documentSessionId"],
                "insert_paragraph_after",
                {"afterParagraph": 0, "text": "新增段落"},
            )
            return result, result["data"]["documentEvents"][0]["docJson"]

        result, doc = asyncio.run(run())
        self.assertTrue(result["success"])
        self.assertTrue(doc["content"][0]["attrs"]["pageBreakBefore"])
        self.assertFalse(doc["content"][1]["attrs"]["pageBreakBefore"])

    def test_replace_streaming_write_preserves_only_first_page_break_before(self) -> None:
        async def run():
            session = await create_document_session({
                "docJson": {
                    "type": "doc",
                    "content": [{
                        "type": "paragraph",
                        "attrs": {"pageBreakBefore": True},
                        "content": [{"type": "text", "text": "seed"}],
                    }],
                },
            })
            result = await execute_document_tool(
                session["documentSessionId"],
                "begin_streaming_write",
                {
                    "action": "replace_paragraph",
                    "paragraphIndex": 0,
                    "markdown": "## 标题\n\n正文",
                },
            )
            return result, result["data"]["documentEvents"][0]["docJson"]

        result, doc = asyncio.run(run())
        self.assertTrue(result["success"])
        self.assertTrue(doc["content"][0]["attrs"]["pageBreakBefore"])
        self.assertFalse(doc["content"][1]["attrs"]["pageBreakBefore"])

    def test_capture_page_screenshot_returns_image_payload(self) -> None:
        async def run():
            session = await create_document_session({
                "docJson": {
                    "type": "doc",
                    "content": [{"type": "paragraph", "content": [{"type": "text", "text": "截图验证"}]}],
                },
                "pageConfig": {"pageWidth": 300, "pageHeight": 200, "marginTop": 20, "marginBottom": 20, "marginLeft": 20, "marginRight": 20},
            })
            return await execute_document_tool(
                session["documentSessionId"],
                "capture_page_screenshot",
                {"page": 1},
            )

        result = asyncio.run(run())
        self.assertTrue(result["success"], result["message"])
        self.assertTrue(str(result["data"]["dataUrl"]).startswith("data:image/png;base64,"))

    def test_get_page_content_returns_compact_text_structure(self) -> None:
        async def run():
            session = await create_document_session({
                "docJson": {
                    "type": "doc",
                    "content": [
                        {
                            "type": "paragraph",
                            "attrs": {"headingLevel": 1, "align": "center"},
                            "content": [{"type": "text", "text": "标题"}],
                        },
                        {
                            "type": "paragraph",
                            "content": [
                                {"type": "text", "text": "正文"},
                                {
                                    "type": "image",
                                    "attrs": {
                                        "src": "data:image/png;base64,AAAA",
                                        "alt": "示意图",
                                        "width": 30,
                                        "height": 30,
                                    },
                                },
                            ],
                        },
                        {
                            "type": "table",
                            "content": [{
                                "type": "table_row",
                                "content": [
                                    {"type": "table_cell", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "A"}]}]},
                                    {"type": "table_cell", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "B"}]}]},
                                ],
                            }],
                        },
                    ],
                },
                "pageConfig": {"pageWidth": 300, "pageHeight": 220, "marginTop": 20, "marginBottom": 20, "marginLeft": 20, "marginRight": 20},
            })
            return await execute_document_tool(
                session["documentSessionId"],
                "get_page_content",
                {"page": 1, "includeTextRuns": True},
            )

        result = asyncio.run(run())
        self.assertTrue(result["success"], result["message"])
        data = result["data"]
        payload = json.dumps(data, ensure_ascii=False)
        self.assertEqual(data["detail"], "content")
        self.assertIn("标题", data["text"])
        self.assertIn("A | B", data["text"])
        table_blocks = [block for block in data["blocks"] if block["type"] == "table"]
        self.assertEqual(table_blocks[0]["tableIndex"], 0)
        self.assertEqual(table_blocks[0]["rows"][0]["cells"][0]["columnIndex"], 0)
        self.assertIn('"srcKind": "data"', payload)
        self.assertNotIn("textRuns", payload)
        self.assertNotIn("data:image/png", payload)
        self.assertNotIn('"style"', payload)
        self.assertNotIn('"lines"', payload)

    def test_get_document_content_ignores_extra_detail_parameter(self) -> None:
        async def run():
            session = await create_document_session({
                "docJson": {
                    "type": "doc",
                    "content": [{
                        "type": "paragraph",
                        "content": [{"type": "text", "text": "正文"}],
                    }],
                },
            })
            return await execute_document_tool(
                session["documentSessionId"],
                "get_document_content",
                {"fromParagraph": 0, "toParagraph": 0, "detail": "format"},
            )

        result = asyncio.run(run())
        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["detail"], "content")
        self.assertEqual(result["data"]["paragraphs"][0]["text"], "正文")

    def test_get_page_style_summary_is_single_page_style_tool(self) -> None:
        async def run():
            session = await create_document_session({
                "docJson": {
                    "type": "doc",
                    "content": [
                        {
                            "type": "paragraph",
                            "attrs": {"headingLevel": 1, "align": "center"},
                            "content": [{"type": "text", "text": "标题"}],
                        },
                        {
                            "type": "paragraph",
                            "attrs": {"firstLineIndent": 2, "lineHeight": 1.75},
                            "content": [{"type": "text", "text": "正文"}],
                        },
                    ],
                },
                "pageConfig": {"pageWidth": 300, "pageHeight": 220, "marginTop": 20, "marginBottom": 20, "marginLeft": 20, "marginRight": 20},
            })
            return await execute_document_tool(
                session["documentSessionId"],
                "get_page_style_summary",
                {"page": 1},
            )

        result = asyncio.run(run())
        self.assertTrue(result["success"], result["message"])
        self.assertEqual(result["data"]["page"], 1)
        self.assertIn("paragraphs", result["data"])
        self.assertIn("style", result["data"]["paragraphs"][0])


if __name__ == "__main__":
    unittest.main()
