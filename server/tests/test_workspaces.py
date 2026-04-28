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
        self.legacy_dir = self.root / "legacy-workspace"
        self.documents_dir = self.root / "documents"
        self.documents_dir.mkdir(parents=True)
        self.patches = [
            patch.object(workspace, "WORKSPACES_DIR", self.workspaces_dir),
            patch.object(workspace, "WORKSPACES_META_PATH", self.workspaces_dir / "meta.json"),
            patch.object(workspace, "LEGACY_WORKSPACE_DIR", self.legacy_dir),
            patch.object(workspace, "DOCUMENTS_DIR", self.documents_dir),
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

        saved = workspace.save_file("default", "docs/report.md", b"# Title\nbody text")
        self.assertEqual(saved["path"], "docs/report.md")

        tree = workspace.get_workspace_tree("default")
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

    def test_references_are_listed_as_legacy_workspace_docs(self) -> None:
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
