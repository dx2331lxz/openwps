from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi import HTTPException

from server.app import documents


class DocumentsModuleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.internal_dir = self.root / "internal"
        self.wps_dir = self.root / "wps"
        self.settings_path = self.root / "document_settings.json"
        self.internal_dir.mkdir(parents=True, exist_ok=True)
        self.wps_dir.mkdir(parents=True, exist_ok=True)
        self.patchers = [
          patch.object(documents, "DOCUMENTS_DIR", self.internal_dir),
          patch.object(documents, "DOCUMENT_SETTINGS_PATH", self.settings_path),
        ]
        for patcher in self.patchers:
            patcher.start()

    def tearDown(self) -> None:
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.tempdir.cleanup()

    def test_internal_source_crud(self) -> None:
        saved = documents.save_document("report", b"docx-bytes", "internal")
        self.assertEqual(saved["name"], "report.docx")
        listed = documents.list_documents("internal")
        self.assertEqual([item["name"] for item in listed], ["report.docx"])
        path = documents.read_document_path("report.docx", "internal")
        self.assertEqual(path.read_bytes(), b"docx-bytes")
        documents.delete_document("report.docx", "internal")
        self.assertEqual(documents.list_documents("internal"), [])

    def test_wps_directory_source_crud(self) -> None:
        settings = documents.update_document_settings({
            "activeSource": "wps_directory",
            "wpsDirectory": str(self.wps_dir),
        })
        self.assertTrue(settings["available"])

        saved = documents.save_document("wps-file", b"wps-bytes", "wps_directory")
        self.assertEqual(saved["source"], "wps_directory")
        self.assertEqual(saved["directory"], str(self.wps_dir.resolve()))
        listed = documents.list_documents("wps_directory")
        self.assertEqual([item["name"] for item in listed], ["wps-file.docx"])
        path = documents.read_document_path("wps-file.docx", "wps_directory")
        self.assertEqual(path.read_bytes(), b"wps-bytes")
        documents.delete_document("wps-file.docx", "wps_directory")
        self.assertEqual(documents.list_documents("wps_directory"), [])

    def test_wps_directory_must_be_absolute(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            documents.update_document_settings({"wpsDirectory": "relative/path"})
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("绝对路径", str(ctx.exception.detail))

    def test_wps_directory_unavailable_is_reported(self) -> None:
        missing_dir = self.root / "missing"
        settings = documents.update_document_settings({
            "activeSource": "wps_directory",
            "wpsDirectory": str(missing_dir),
        })
        self.assertFalse(settings["available"])
        self.assertIn("不存在", settings["errorMessage"])

        with self.assertRaises(HTTPException) as ctx:
            documents.list_documents("wps_directory")
        self.assertEqual(ctx.exception.status_code, 400)

    def test_only_top_level_docx_files_are_listed(self) -> None:
        documents.update_document_settings({"wpsDirectory": str(self.wps_dir)})
        (self.wps_dir / "top.docx").write_bytes(b"top")
        (self.wps_dir / "notes.txt").write_text("ignore", encoding="utf-8")
        nested = self.wps_dir / "nested"
        nested.mkdir()
        (nested / "child.docx").write_bytes(b"nested")

        listed = documents.list_documents("wps_directory")
        self.assertEqual([item["name"] for item in listed], ["top.docx"])

    def test_normalized_filename_stays_inside_root(self) -> None:
        documents.update_document_settings({"wpsDirectory": str(self.wps_dir)})
        saved = documents.save_document("../escape", b"safe", "wps_directory")
        self.assertEqual(saved["name"], "escape.docx")
        self.assertTrue((self.wps_dir / "escape.docx").exists())
        self.assertFalse((self.root / "escape.docx").exists())


if __name__ == "__main__":
    unittest.main()
