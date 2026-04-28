from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from server.app import workspace


class WorkspaceDirectoryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.workspaces_dir = self.root / "workspaces"
        self.patches = [
            patch.object(workspace, "WORKSPACES_DIR", self.workspaces_dir),
            patch.object(workspace, "WORKSPACES_META_PATH", self.workspaces_dir / "meta.json"),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self) -> None:
        for item in reversed(self.patches):
            item.stop()
        self.tmp.cleanup()

    def test_default_workspace_tree_search_and_open_markdown(self) -> None:
        workspaces = workspace.list_workspaces()
        self.assertEqual(workspaces["activeWorkspaceId"], "default")

        memory = self.workspaces_dir / "default" / "files" / ".openwps" / "memory" / "MEMORY.md"
        self.assertTrue(memory.exists())
        self.assertFalse((self.workspaces_dir / "default" / "files" / "OPENWPS.md").exists())

        saved = workspace.save_file("default", "docs/report.md", b"# Title\nbody text")
        self.assertEqual(saved["path"], "docs/report.md")

        tree = workspace.get_workspace_tree("default")
        self.assertEqual([item["path"] for item in tree["root"]["children"][:2]], [".openwps", "_references"])
        openwps_node = next(item for item in tree["root"]["children"] if item["path"] == ".openwps")
        self.assertEqual(openwps_node["role"], "openwps")
        memory_dir = openwps_node["children"][0]
        self.assertEqual(memory_dir["path"], ".openwps/memory")
        memory_node = next(item for item in memory_dir["children"] if item["path"] == ".openwps/memory/MEMORY.md")
        self.assertEqual(memory_node["role"], "memoryIndex")
        self.assertTrue(memory_node["editable"])

        docs_dir = next(item for item in tree["root"]["children"] if item["path"] == "docs")
        self.assertEqual(docs_dir["path"], "docs")
        self.assertEqual(docs_dir["children"][0]["path"], "docs/report.md")

        found = workspace.search_workspace("body", workspace_id="default", scope="workspace")
        self.assertEqual(found["matchedDocs"], 1)
        self.assertEqual(found["results"][0]["docPath"], "docs/report.md")

        opened = workspace.open_file_as_document("default", "docs/report.md")
        first = opened["docJson"]["content"][0]
        self.assertEqual(first["attrs"]["headingLevel"], 1)
        self.assertEqual(opened["filePath"], "docs/report.md")

    def test_references_are_listed_as_workspace_docs(self) -> None:
        uploaded = workspace.upload_workspace_file(
            "default",
            "_references",
            "spec.txt",
            "text/plain",
            b"reference text",
        )
        self.assertEqual(uploaded["path"], "_references/spec.txt")

        docs = workspace.list_workspace_docs()
        self.assertEqual(len(docs), 1)
        self.assertEqual(docs[0]["role"], "reference")
        self.assertEqual(docs[0]["id"], "_references/spec.txt")

    def test_rejects_unsafe_paths_and_internal_directory_writes(self) -> None:
        with self.assertRaises(HTTPException):
            workspace.save_file("default", "../escape.txt", b"bad")
        with self.assertRaises(HTTPException):
            workspace.save_file("default", ".openwps/cache.txt", b"bad")
        with self.assertRaises(HTTPException):
            workspace.save_file("default", ".openwps/memory/bad.md", b"bad")

    def test_workspace_memory_files_are_indexed_searchable_and_editable(self) -> None:
        saved = workspace.save_memory_file(
            "default",
            "preferences.md",
            "用户喜欢紧凑回答。",
            name="回答偏好",
            description="用户偏好简洁直接的回答",
            memory_type="feedback",
        )
        self.assertEqual(saved["path"], ".openwps/memory/preferences.md")

        memory = workspace.get_workspace_memory("default", query="简洁")
        entrypoint = memory["entrypoint"]
        self.assertEqual(entrypoint["path"], ".openwps/memory/MEMORY.md")
        self.assertIn("preferences.md", entrypoint["content"])
        self.assertEqual(len(memory["manifest"]), 1)
        self.assertEqual(memory["selected"][0]["path"], ".openwps/memory/preferences.md")

        found = workspace.search_workspace("紧凑", workspace_id="default", scope="memory")
        self.assertEqual(found["matchedDocs"], 1)
        self.assertEqual(found["results"][0]["docPath"], ".openwps/memory/preferences.md")

        content = workspace.get_document_content(".openwps/memory/preferences.md", workspace_id="default")
        self.assertIn("紧凑回答", content["content"])

        opened = workspace.open_file_as_document("default", ".openwps/memory/preferences.md")
        self.assertEqual(opened["filePath"], ".openwps/memory/preferences.md")
        self.assertEqual(opened["fileType"], "md")

        moved = workspace.move_memory_file("default", "preferences.md", "notes/preferences.md")
        self.assertEqual(moved["path"], ".openwps/memory/notes/preferences.md")
        self.assertIn("notes/preferences.md", workspace.get_workspace_memory("default")["entrypoint"]["content"])

        deleted = workspace.delete_memory_file("default", "notes/preferences.md")
        self.assertTrue(deleted["success"])
        self.assertNotIn("notes/preferences.md", workspace.get_workspace_memory("default")["entrypoint"]["content"])

    def test_root_openwps_is_plain_workspace_file_not_memory_source(self) -> None:
        root = self.workspaces_dir / "default" / "files"
        workspace.list_workspaces()
        workspace.save_file("default", "OPENWPS.md", b"plain workspace file")

        tree = workspace.get_workspace_tree("default")

        openwps_file = next(item for item in tree["root"]["children"] if item["path"] == "OPENWPS.md")
        self.assertEqual(openwps_file["role"], "document")
        self.assertEqual(sorted(path.name for path in (root / ".openwps" / "memory").iterdir()), ["MEMORY.md"])
        self.assertNotIn("OPENWPS.md", (root / ".openwps" / "memory" / "MEMORY.md").read_text(encoding="utf-8"))

    def test_move_and_delete_file(self) -> None:
        workspace.save_file("default", "a.txt", b"hello")
        moved = workspace.move_file("default", "a.txt", "folder/b.txt")
        self.assertEqual(moved["path"], "folder/b.txt")
        self.assertTrue((self.workspaces_dir / "default" / "files" / "folder" / "b.txt").exists())

        deleted = workspace.delete_file("default", "folder/b.txt")
        self.assertTrue(deleted["success"])
        self.assertFalse((self.workspaces_dir / "default" / "files" / "folder" / "b.txt").exists())


if __name__ == "__main__":
    unittest.main()
