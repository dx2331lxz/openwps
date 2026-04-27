from __future__ import annotations

import asyncio
import json
import subprocess
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from .config import BASE_DIR


DEFAULT_DOC_JSON: dict[str, Any] = {
    "type": "doc",
    "content": [
        {
            "type": "paragraph",
            "content": [{"type": "text", "text": "开始输入文字，当内容超过一页高度时将自动出现第二张 A4 白纸..."}],
        }
    ],
}

DEFAULT_PAGE_CONFIG: dict[str, int] = {
    "pageWidth": 794,
    "pageHeight": 1123,
    "marginTop": 96,
    "marginBottom": 96,
    "marginLeft": 113,
    "marginRight": 113,
}

SERVER_EXECUTABLE_DOCUMENT_TOOLS = {
    "search_text",
    "get_document_info",
    "get_document_outline",
    "get_document_content",
    "get_page_content",
    "get_page_style_summary",
    "get_paragraph",
    "get_comments",
    "set_text_style",
    "set_paragraph_style",
    "clear_formatting",
    "apply_style_batch",
    "set_page_config",
    "insert_page_break",
    "insert_horizontal_rule",
    "insert_table_of_contents",
    "insert_table",
    "begin_streaming_write",
    "insert_text",
    "insert_paragraph_after",
    "replace_paragraph_text",
    "replace_selection_text",
    "delete_selection_text",
    "delete_paragraph",
    "insert_image",
    "insert_mermaid",
    "capture_page_screenshot",
    "analyze_document_image",
    "insert_table_row_before",
    "insert_table_row_after",
    "delete_table_row",
    "insert_table_column_before",
    "insert_table_column_after",
    "delete_table_column",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_doc_json(value: Any) -> dict[str, Any]:
    if isinstance(value, dict) and value.get("type") == "doc":
        return value
    return json.loads(json.dumps(DEFAULT_DOC_JSON))


def _normalize_page_config(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return dict(DEFAULT_PAGE_CONFIG)
    return {
        "pageWidth": value.get("pageWidth") if isinstance(value.get("pageWidth"), (int, float)) else DEFAULT_PAGE_CONFIG["pageWidth"],
        "pageHeight": value.get("pageHeight") if isinstance(value.get("pageHeight"), (int, float)) else DEFAULT_PAGE_CONFIG["pageHeight"],
        "marginTop": value.get("marginTop") if isinstance(value.get("marginTop"), (int, float)) else DEFAULT_PAGE_CONFIG["marginTop"],
        "marginBottom": value.get("marginBottom") if isinstance(value.get("marginBottom"), (int, float)) else DEFAULT_PAGE_CONFIG["marginBottom"],
        "marginLeft": value.get("marginLeft") if isinstance(value.get("marginLeft"), (int, float)) else DEFAULT_PAGE_CONFIG["marginLeft"],
        "marginRight": value.get("marginRight") if isinstance(value.get("marginRight"), (int, float)) else DEFAULT_PAGE_CONFIG["marginRight"],
    }


@dataclass
class DocumentSession:
    session_id: str
    doc_json: dict[str, Any]
    page_config: dict[str, Any]
    selection_context: dict[str, Any] | None = None
    version: int = 1
    created_at: str = field(default_factory=utc_now)
    updated_at: str = field(default_factory=utc_now)
    dirty: bool = False
    current_document_name: str | None = None
    subscribers: list[asyncio.Queue[dict[str, Any] | None]] = field(default_factory=list)

    def snapshot(self) -> dict[str, Any]:
        return {
            "documentSessionId": self.session_id,
            "docJson": self.doc_json,
            "pageConfig": self.page_config,
            "selectionContext": self.selection_context,
            "version": self.version,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "dirty": self.dirty,
            "currentDocumentName": self.current_document_name,
        }


_sessions: dict[str, DocumentSession] = {}
_active_session_id: str | None = None
_lock = asyncio.Lock()


def is_document_tool(tool_name: str) -> bool:
    return tool_name in SERVER_EXECUTABLE_DOCUMENT_TOOLS


async def create_document_session(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    global _active_session_id
    data = payload or {}
    session = DocumentSession(
        session_id=f"doc_{uuid.uuid4().hex[:12]}",
        doc_json=_normalize_doc_json(data.get("docJson")),
        page_config=_normalize_page_config(data.get("pageConfig")),
        selection_context=data.get("selectionContext") if isinstance(data.get("selectionContext"), dict) else None,
        current_document_name=str(data.get("currentDocumentName") or "") or None,
    )
    async with _lock:
        _sessions[session.session_id] = session
        _active_session_id = session.session_id
    return session.snapshot()


async def get_document_session(session_id: str) -> DocumentSession:
    async with _lock:
        session = _sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Document session not found")
    return session


async def read_document_session(session_id: str) -> dict[str, Any]:
    return (await get_document_session(session_id)).snapshot()


async def set_active_document_session(session_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    global _active_session_id
    session = await get_document_session(session_id)
    data = payload or {}
    current_document_name = data.get("currentDocumentName")
    if isinstance(current_document_name, str):
        session.current_document_name = current_document_name.strip() or None
    async with _lock:
        _active_session_id = session.session_id
    return {"documentSessionId": session.session_id, "version": session.version, "active": True}


async def read_active_document_session() -> dict[str, Any]:
    async with _lock:
        session_id = _active_session_id
    if not session_id:
        raise HTTPException(status_code=404, detail="No active document session. Open a document in the frontend or pass --session.")
    return await read_document_session(session_id)


async def update_document_session_from_client(session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    session = await get_document_session(session_id)
    base_version = payload.get("baseVersion")
    if isinstance(base_version, int) and base_version != session.version:
        raise HTTPException(status_code=409, detail={"message": "Document version conflict", "version": session.version})

    doc_json = payload.get("docJson")
    page_config = payload.get("pageConfig")
    selection_context = payload.get("selectionContext")
    origin_client_id = str(payload.get("clientId") or "").strip() or None

    events: list[dict[str, Any]] = []
    if doc_json is not None:
        session.doc_json = _normalize_doc_json(doc_json)
        events.append({"type": "document_replace", "docJson": session.doc_json, "source": "client_patch"})
    if page_config is not None:
        session.page_config = _normalize_page_config(page_config)
        events.append({"type": "page_config_changed", "pageConfig": session.page_config, "source": "client_patch"})
    if isinstance(selection_context, dict) or selection_context is None:
        session.selection_context = selection_context

    session.version += 1
    session.updated_at = utc_now()
    session.dirty = True
    for event in events:
        event["version"] = session.version
        if origin_client_id:
            event["originClientId"] = origin_client_id
        await publish_document_event(session, event)
    return session.snapshot()


def _worker_path() -> Path:
    return BASE_DIR / "node" / "document_worker.mjs"


def _run_worker(payload: dict[str, Any]) -> dict[str, Any]:
    worker = _worker_path()
    if not worker.exists():
        return {"success": False, "message": f"Document worker not found: {worker}"}
    proc = subprocess.run(
        ["node", str(worker)],
        input=json.dumps(payload, ensure_ascii=False),
        capture_output=True,
        text=True,
        cwd=str(BASE_DIR.parent),
        timeout=60,
        check=False,
    )
    if proc.returncode != 0:
        return {"success": False, "message": proc.stderr.strip() or f"Document worker exited with {proc.returncode}"}
    try:
        result = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as exc:
        return {"success": False, "message": f"Document worker returned invalid JSON: {exc}", "data": {"stdout": proc.stdout, "stderr": proc.stderr}}
    return result if isinstance(result, dict) else {"success": False, "message": "Document worker returned non-object result"}


async def execute_document_tool(
    session_id: str,
    tool_name: str,
    params: dict[str, Any] | None = None,
    *,
    base_version: int | None = None,
    selection_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not is_document_tool(tool_name):
        return {"success": False, "message": f"Not a document tool: {tool_name}"}

    session = await get_document_session(session_id)
    if base_version is not None and base_version != session.version:
        return {
            "success": False,
            "message": f"文档版本冲突：当前版本 {session.version}，请求版本 {base_version}",
            "data": {"version": session.version},
        }

    effective_selection = selection_context if selection_context is not None else session.selection_context
    worker_payload = {
        "toolName": tool_name,
        "params": params or {},
        "docJson": session.doc_json,
        "pageConfig": session.page_config,
        "selectionContext": effective_selection,
        "baseVersion": session.version,
    }
    result = await asyncio.to_thread(_run_worker, worker_payload)

    document_events: list[dict[str, Any]] = []
    if result.get("success") is True:
        next_doc = result.get("docJson")
        next_page_config = result.get("pageConfig")
        if isinstance(next_doc, dict):
            session.doc_json = _normalize_doc_json(next_doc)
            document_events.append({"type": "document_replace", "docJson": session.doc_json, "source": "server_tool"})
        if isinstance(next_page_config, dict):
            session.page_config = _normalize_page_config(next_page_config)
            document_events.append({"type": "page_config_changed", "pageConfig": session.page_config, "source": "server_tool"})
        if document_events:
            session.version += 1
            session.updated_at = utc_now()
            session.dirty = True
            for event in document_events:
                event["version"] = session.version
                await publish_document_event(session, event)

    data = result.get("data") if isinstance(result.get("data"), dict) else result.get("data")
    if not isinstance(data, dict):
        data = {} if data is None else {"value": data}
    data.update({
        "documentSessionId": session.session_id,
        "version": session.version,
        "documentEvents": document_events,
    })
    return {
        "success": result.get("success") is True,
        "message": str(result.get("message") or ""),
        "data": data,
    }


async def execute_ai_document_tool(tool_name: str, params: dict[str, Any], context: dict[str, Any] | None) -> dict[str, Any]:
    context = context or {}
    session_id = str(context.get("documentSessionId") or "").strip()
    if not session_id:
        return {"success": False, "message": "缺少 documentSessionId，无法在后端执行文档工具", "data": None}
    selection_context = context.get("selection") if isinstance(context.get("selection"), dict) else None
    return await execute_document_tool(session_id, tool_name, params, selection_context=selection_context)


async def publish_document_event(session: DocumentSession, event: dict[str, Any]) -> None:
    payload = {"documentSessionId": session.session_id, **event}
    for queue in list(session.subscribers):
        await queue.put(payload)


async def subscribe_document_events(session_id: str):
    session = await get_document_session(session_id)
    queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
    session.subscribers.append(queue)
    try:
        yield {"type": "snapshot", **session.snapshot()}
        while True:
            item = await queue.get()
            if item is None:
                break
            yield item
    finally:
        if queue in session.subscribers:
            session.subscribers.remove(queue)
