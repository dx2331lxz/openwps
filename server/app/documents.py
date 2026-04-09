from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException

from .config import DOCUMENTS_DIR


def _document_timestamp(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def normalize_document_name(name: str) -> str:
    candidate = Path(str(name).strip()).name
    if not candidate:
        raise HTTPException(status_code=400, detail="文件名不能为空")
    if not candidate.lower().endswith(".docx"):
        candidate = f"{candidate}.docx"
    if candidate in {".docx", "..docx"}:
        raise HTTPException(status_code=400, detail="文件名无效")
    return candidate


def document_path(name: str) -> Path:
    normalized = normalize_document_name(name)
    return DOCUMENTS_DIR / normalized


def list_documents() -> list[dict]:
    documents: list[dict] = []
    for path in DOCUMENTS_DIR.glob("*.docx"):
        try:
            stat = path.stat()
        except OSError:
            continue
        documents.append({
            "name": path.name,
            "size": stat.st_size,
            "updatedAt": _document_timestamp(path),
        })

    documents.sort(key=lambda item: item.get("updatedAt", ""), reverse=True)
    return documents


def save_document(name: str, content: bytes) -> dict:
    if not content:
        raise HTTPException(status_code=400, detail="文档内容不能为空")

    path = document_path(name)
    path.write_bytes(content)
    stat = path.stat()
    return {
        "name": path.name,
        "size": stat.st_size,
        "updatedAt": _document_timestamp(path),
    }


def read_document_path(name: str) -> Path:
    path = document_path(name)
    if not path.exists():
        raise HTTPException(status_code=404, detail="文档不存在")
    return path


def delete_document(name: str) -> None:
    path = read_document_path(name)
    path.unlink()
