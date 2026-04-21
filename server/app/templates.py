from __future__ import annotations

import base64
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException

from .config import TEMPLATE_SOURCES_DIR, TEMPLATES_DIR


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def template_path(template_id: str) -> Path:
    return TEMPLATES_DIR / f"{template_id}.json"


def template_source_path(template_id: str, filename: str | None = None) -> Path:
    suffix = Path(filename or "template.docx").suffix or ".docx"
    return TEMPLATE_SOURCES_DIR / f"{template_id}{suffix}"


def _read_template_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"模板数据读取失败：{error}") from error


def _write_template_json(data: dict) -> None:
    data["updatedAt"] = now_iso()
    template_path(str(data["id"])).write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _build_template_summary(data: dict) -> dict:
    return {
        "id": data.get("id", ""),
        "name": data.get("name", ""),
        "note": data.get("note", ""),
        "summary": data.get("summary", ""),
        "createdAt": data.get("createdAt", ""),
        "updatedAt": data.get("updatedAt", ""),
        "sourceFilename": data.get("sourceFilename", ""),
        "sourceSize": data.get("sourceSize", 0),
    }


def list_templates() -> list[dict]:
    templates: list[dict] = []
    for path in TEMPLATES_DIR.glob("*.json"):
        if path.parent == TEMPLATE_SOURCES_DIR:
            continue
        try:
            data = _read_template_json(path)
        except HTTPException:
            continue
        templates.append(_build_template_summary(data))
    templates.sort(key=lambda item: item.get("updatedAt", ""), reverse=True)
    return templates


def read_template(template_id: str) -> dict:
    path = template_path(template_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="模板不存在")
    data = _read_template_json(path)
    return {
        "id": data.get("id", ""),
        "name": data.get("name", ""),
        "note": data.get("note", ""),
        "summary": data.get("summary", ""),
        "createdAt": data.get("createdAt", ""),
        "updatedAt": data.get("updatedAt", ""),
        "sourceFilename": data.get("sourceFilename", ""),
        "sourceSize": data.get("sourceSize", 0),
        "templateText": data.get("templateText", ""),
    }


def create_template(body: dict) -> dict:
    name = str(body.get("name") or "").strip()
    summary = str(body.get("summary") or "").strip()
    source_filename = str(body.get("sourceFilename") or "").strip()
    source_content_base64 = str(body.get("sourceContentBase64") or "").strip()
    template_text = str(body.get("templateText") or "").strip()

    if not name:
        raise HTTPException(status_code=400, detail="模板名称不能为空")
    if not summary:
        raise HTTPException(status_code=400, detail="模板摘要不能为空")
    if not source_filename.lower().endswith(".docx"):
        raise HTTPException(status_code=400, detail="当前仅支持上传 DOCX 模板")
    if not template_text:
        raise HTTPException(status_code=400, detail="模板 templateText 不能为空")

    try:
        source_content = base64.b64decode(source_content_base64)
    except Exception as error:
        raise HTTPException(status_code=400, detail=f"模板源文件解码失败：{error}") from error

    if not source_content:
        raise HTTPException(status_code=400, detail="模板源文件内容不能为空")

    template_id = str(uuid.uuid4())
    timestamp = now_iso()
    source_path = template_source_path(template_id, source_filename)
    source_path.write_bytes(source_content)

    data = {
        "id": template_id,
        "name": name,
        "note": str(body.get("note") or ""),
        "summary": summary,
        "createdAt": timestamp,
        "updatedAt": timestamp,
        "sourceFilename": source_filename,
        "sourceSize": len(source_content),
        "templateText": template_text,
        "sourcePath": source_path.name,
    }
    _write_template_json(data)
    return data


def update_template(template_id: str, body: dict) -> dict:
    data = read_template(template_id)
    name = body.get("name")
    note = body.get("note")
    template_text = body.get("templateText")

    if name is not None:
        next_name = str(name).strip()
        if not next_name:
            raise HTTPException(status_code=400, detail="模板名称不能为空")
        data["name"] = next_name
    if note is not None:
        data["note"] = str(note)
    if template_text is not None:
        next_text = str(template_text).strip()
        if not next_text:
            raise HTTPException(status_code=400, detail="模板内容不能为空")
        data["templateText"] = next_text

    _write_template_json(data)
    return data


def delete_template(template_id: str) -> None:
    data = read_template(template_id)
    path = template_path(template_id)
    if path.exists():
        path.unlink()

    source_path = TEMPLATE_SOURCES_DIR / str(data.get("sourcePath") or "")
    if source_path.exists():
        source_path.unlink()
