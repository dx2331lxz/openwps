from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from .config import DOCUMENT_SETTINGS_PATH, DOCUMENTS_DIR

DOCUMENT_SOURCE_INTERNAL = "internal"
DOCUMENT_SOURCE_WPS_DIRECTORY = "wps_directory"
DOCUMENT_SOURCES = {DOCUMENT_SOURCE_INTERNAL, DOCUMENT_SOURCE_WPS_DIRECTORY}
DEFAULT_DOCUMENT_SETTINGS = {
    "activeSource": DOCUMENT_SOURCE_INTERNAL,
    "wpsDirectory": "",
}


def _document_timestamp(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def _sanitize_document_source(source: Any) -> str:
    normalized = str(source or "").strip().lower()
    if normalized not in DOCUMENT_SOURCES:
        raise HTTPException(status_code=400, detail="无效的文档来源")
    return normalized


def _sanitize_wps_directory(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""

    path = Path(text).expanduser()
    if not path.is_absolute():
        raise HTTPException(status_code=400, detail="WPS 目录必须是绝对路径")
    return str(path.resolve())


def _load_document_settings_raw() -> dict[str, Any]:
    if not DOCUMENT_SETTINGS_PATH.exists():
        return dict(DEFAULT_DOCUMENT_SETTINGS)

    try:
        raw = json.loads(DOCUMENT_SETTINGS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return dict(DEFAULT_DOCUMENT_SETTINGS)

    if not isinstance(raw, dict):
        return dict(DEFAULT_DOCUMENT_SETTINGS)

    active_source = raw.get("activeSource", DEFAULT_DOCUMENT_SETTINGS["activeSource"])
    try:
        normalized_source = _sanitize_document_source(active_source)
    except HTTPException:
        normalized_source = DEFAULT_DOCUMENT_SETTINGS["activeSource"]

    wps_directory = raw.get("wpsDirectory", DEFAULT_DOCUMENT_SETTINGS["wpsDirectory"])
    try:
        normalized_directory = _sanitize_wps_directory(wps_directory)
    except HTTPException:
        normalized_directory = ""

    return {
        "activeSource": normalized_source,
        "wpsDirectory": normalized_directory,
    }


def _save_document_settings_raw(settings: dict[str, Any]) -> None:
    DOCUMENT_SETTINGS_PATH.write_text(
        json.dumps(settings, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def normalize_document_name(name: str) -> str:
    candidate = Path(str(name).strip()).name
    if not candidate:
        raise HTTPException(status_code=400, detail="文件名不能为空")
    if not candidate.lower().endswith(".docx"):
        candidate = f"{candidate}.docx"
    if candidate in {".docx", "..docx"}:
        raise HTTPException(status_code=400, detail="文件名无效")
    return candidate


def _validate_wps_directory(path: Path) -> tuple[bool, str | None]:
    if not path.exists():
        return False, "WPS 目录不存在"
    if not path.is_dir():
        return False, "WPS 目录不是文件夹"
    if not os.access(path, os.R_OK):
        return False, "WPS 目录不可读"
    if not os.access(path, os.W_OK):
        return False, "WPS 目录不可写"
    return True, None


def _build_document_settings_response(settings: dict[str, Any]) -> dict[str, Any]:
    active_source = settings["activeSource"]
    wps_directory = settings["wpsDirectory"]
    internal_directory = str(DOCUMENTS_DIR.resolve())

    available = True
    error_message: str | None = None
    active_directory = internal_directory

    if active_source == DOCUMENT_SOURCE_WPS_DIRECTORY:
        if not wps_directory:
            available = False
            error_message = "尚未配置 WPS 目录"
            active_directory = ""
        else:
            active_directory = wps_directory
            ok, error = _validate_wps_directory(Path(wps_directory))
            available = ok
            error_message = error

    return {
        "activeSource": active_source,
        "wpsDirectory": wps_directory,
        "available": available,
        "errorMessage": error_message,
        "activeDirectory": active_directory,
        "internalDirectory": internal_directory,
    }


def get_document_settings() -> dict[str, Any]:
    return _build_document_settings_response(_load_document_settings_raw())


def update_document_settings(payload: dict[str, Any]) -> dict[str, Any]:
    current = _load_document_settings_raw()

    if "activeSource" in payload:
        current["activeSource"] = _sanitize_document_source(payload.get("activeSource"))

    if "wpsDirectory" in payload:
        current["wpsDirectory"] = _sanitize_wps_directory(payload.get("wpsDirectory"))

    _save_document_settings_raw(current)
    return _build_document_settings_response(current)


def resolve_document_source(source: str | None = None) -> str:
    if source is not None:
        return _sanitize_document_source(source)
    return _load_document_settings_raw()["activeSource"]


def _resolve_document_root(source: str | None = None) -> tuple[str, Path]:
    resolved_source = resolve_document_source(source)
    if resolved_source == DOCUMENT_SOURCE_INTERNAL:
        return resolved_source, DOCUMENTS_DIR

    settings = _load_document_settings_raw()
    wps_directory = settings["wpsDirectory"]
    if not wps_directory:
        raise HTTPException(status_code=400, detail="尚未配置 WPS 目录")

    root = Path(wps_directory)
    ok, error = _validate_wps_directory(root)
    if not ok:
        raise HTTPException(status_code=400, detail=error or "WPS 目录不可用")
    return resolved_source, root


def document_path(name: str, source: str | None = None) -> tuple[str, Path, Path]:
    normalized = normalize_document_name(name)
    resolved_source, root = _resolve_document_root(source)
    path = root / normalized
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="文件路径无效") from exc
    return resolved_source, root, path


def _list_documents_in_directory(root: Path, source: str) -> list[dict[str, Any]]:
    documents: list[dict[str, Any]] = []
    for path in root.glob("*.docx"):
        if not path.is_file():
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        documents.append({
            "name": path.name,
            "size": stat.st_size,
            "updatedAt": _document_timestamp(path),
            "source": source,
            "directory": str(root.resolve()),
        })

    documents.sort(key=lambda item: item.get("updatedAt", ""), reverse=True)
    return documents


def list_documents(source: str | None = None) -> list[dict[str, Any]]:
    resolved_source, root = _resolve_document_root(source)
    return _list_documents_in_directory(root, resolved_source)


def save_document(name: str, content: bytes, source: str | None = None) -> dict[str, Any]:
    if not content:
        raise HTTPException(status_code=400, detail="文档内容不能为空")

    resolved_source, root, path = document_path(name, source)
    path.write_bytes(content)
    stat = path.stat()
    return {
        "name": path.name,
        "size": stat.st_size,
        "updatedAt": _document_timestamp(path),
        "source": resolved_source,
        "directory": str(root.resolve()),
    }


def read_document_path(name: str, source: str | None = None) -> Path:
    _, _, path = document_path(name, source)
    if not path.exists():
        raise HTTPException(status_code=404, detail="文档不存在")
    return path


def delete_document(name: str, source: str | None = None) -> None:
    path = read_document_path(name, source)
    path.unlink()
