from __future__ import annotations

import json
import re
import shutil
import threading
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from .config import TASKS_DIR

TASK_STATUSES = {"pending", "in_progress", "completed"}
HIGH_WATER_MARK_FILE = ".highwatermark"

_TASK_LIST_LOCKS: dict[str, threading.RLock] = {}
_LOCKS_GUARD = threading.Lock()


def _get_lock(conversation_id: str) -> threading.RLock:
    with _LOCKS_GUARD:
        lock = _TASK_LIST_LOCKS.get(conversation_id)
        if lock is None:
            lock = threading.RLock()
            _TASK_LIST_LOCKS[conversation_id] = lock
        return lock


def _sanitize_path_component(value: str) -> str:
    sanitized = re.sub(r"[^a-zA-Z0-9_-]", "-", str(value).strip())
    return sanitized or "default"


def _tasks_dir(conversation_id: str) -> Path:
    path = TASKS_DIR / _sanitize_path_component(conversation_id)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _task_path(conversation_id: str, task_id: str) -> Path:
    return _tasks_dir(conversation_id) / f"{_sanitize_path_component(task_id)}.json"


def _high_water_mark_path(conversation_id: str) -> Path:
    return _tasks_dir(conversation_id) / HIGH_WATER_MARK_FILE


def _read_high_water_mark(conversation_id: str) -> int:
    path = _high_water_mark_path(conversation_id)
    try:
        return max(int(path.read_text(encoding="utf-8").strip()), 0)
    except Exception:
        return 0


def _write_high_water_mark(conversation_id: str, value: int) -> None:
    _high_water_mark_path(conversation_id).write_text(str(max(value, 0)), encoding="utf-8")


def _parse_numeric_id(value: str) -> int | None:
    try:
        parsed = int(str(value))
    except Exception:
        return None
    return parsed if parsed >= 0 else None


def _sort_tasks(tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    def sort_key(task: dict[str, Any]) -> tuple[int, str]:
        task_id = str(task.get("id", ""))
        numeric = _parse_numeric_id(task_id)
        return (0, str(numeric)) if numeric is not None else (1, task_id)

    return sorted(tasks, key=sort_key)


def _normalize_task_payload(raw: dict[str, Any], *, task_id: str | None = None) -> dict[str, Any]:
    status = str(raw.get("status") or "pending").strip().lower()
    if status not in TASK_STATUSES:
        raise HTTPException(status_code=400, detail=f"无效任务状态: {status}")

    metadata = raw.get("metadata")
    if metadata is not None and not isinstance(metadata, dict):
        raise HTTPException(status_code=400, detail="metadata 必须是对象")

    blocks = raw.get("blocks") or []
    blocked_by = raw.get("blockedBy") or []
    if not isinstance(blocks, list) or not isinstance(blocked_by, list):
        raise HTTPException(status_code=400, detail="blocks / blockedBy 必须是数组")

    subject = str(raw.get("subject") or "").strip()
    description = str(raw.get("description") or "").strip()
    if not subject:
        raise HTTPException(status_code=400, detail="subject 不能为空")
    if not description:
        raise HTTPException(status_code=400, detail="description 不能为空")

    normalized: dict[str, Any] = {
        "id": str(task_id if task_id is not None else raw.get("id") or "").strip(),
        "subject": subject,
        "description": description,
        "status": status,
        "blocks": [str(item).strip() for item in blocks if str(item).strip()],
        "blockedBy": [str(item).strip() for item in blocked_by if str(item).strip()],
    }
    active_form = str(raw.get("activeForm") or "").strip()
    owner = str(raw.get("owner") or "").strip()
    if active_form:
        normalized["activeForm"] = active_form
    if owner:
        normalized["owner"] = owner
    if metadata:
        normalized["metadata"] = metadata
    return normalized


def _read_task_unsafe(conversation_id: str, task_id: str) -> dict[str, Any] | None:
    path = _task_path(conversation_id, task_id)
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"任务文件损坏: {task_id}") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=500, detail=f"任务文件格式错误: {task_id}")
    return _normalize_task_payload(payload, task_id=str(payload.get("id") or task_id))


def _write_task_unsafe(conversation_id: str, task: dict[str, Any]) -> None:
    _task_path(conversation_id, str(task["id"])).write_text(
        json.dumps(task, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def list_tasks(conversation_id: str) -> list[dict[str, Any]]:
    with _get_lock(conversation_id):
        tasks: list[dict[str, Any]] = []
        for path in _tasks_dir(conversation_id).glob("*.json"):
            task = _read_task_unsafe(conversation_id, path.stem)
            if task is not None:
                tasks.append(task)
        return _sort_tasks(tasks)


def get_task(conversation_id: str, task_id: str) -> dict[str, Any]:
    with _get_lock(conversation_id):
        task = _read_task_unsafe(conversation_id, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="任务不存在")
        return task


def create_task(conversation_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    with _get_lock(conversation_id):
        highest = _read_high_water_mark(conversation_id)
        for existing in _tasks_dir(conversation_id).glob("*.json"):
            numeric = _parse_numeric_id(existing.stem)
            if numeric is not None and numeric > highest:
                highest = numeric
        task_id = str(highest + 1)
        _write_high_water_mark(conversation_id, int(task_id))
        task = _normalize_task_payload(
            {
                "subject": payload.get("subject"),
                "description": payload.get("description"),
                "activeForm": payload.get("activeForm"),
                "owner": payload.get("owner"),
                "status": "pending",
                "blocks": [],
                "blockedBy": [],
                "metadata": payload.get("metadata"),
            },
            task_id=task_id,
        )
        _write_task_unsafe(conversation_id, task)
        return task


def _merge_metadata(existing: dict[str, Any], incoming: dict[str, Any] | None) -> dict[str, Any] | None:
    if incoming is None:
        return existing.get("metadata")
    merged = dict(existing.get("metadata") or {})
    for key, value in incoming.items():
        if value is None:
            merged.pop(str(key), None)
        else:
            merged[str(key)] = value
    return merged or None


def update_task(conversation_id: str, task_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    with _get_lock(conversation_id):
        existing = _read_task_unsafe(conversation_id, task_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="任务不存在")

        next_task = dict(existing)
        if "subject" in payload and payload["subject"] is not None:
            next_task["subject"] = str(payload["subject"]).strip()
        if "description" in payload and payload["description"] is not None:
            next_task["description"] = str(payload["description"]).strip()
        if "activeForm" in payload:
            active_form = str(payload.get("activeForm") or "").strip()
            if active_form:
                next_task["activeForm"] = active_form
            else:
                next_task.pop("activeForm", None)
        if "owner" in payload:
            owner = str(payload.get("owner") or "").strip()
            if owner:
                next_task["owner"] = owner
            else:
                next_task.pop("owner", None)
        if "status" in payload and payload["status"] is not None:
            next_task["status"] = str(payload["status"]).strip().lower()

        metadata = payload.get("metadata") if "metadata" in payload else None
        if "metadata" in payload:
            if metadata is not None and not isinstance(metadata, dict):
                raise HTTPException(status_code=400, detail="metadata 必须是对象")
            merged_metadata = _merge_metadata(existing, metadata)
            if merged_metadata:
                next_task["metadata"] = merged_metadata
            else:
                next_task.pop("metadata", None)

        add_blocks = payload.get("addBlocks") or []
        add_blocked_by = payload.get("addBlockedBy") or []
        if add_blocks and not isinstance(add_blocks, list):
            raise HTTPException(status_code=400, detail="addBlocks 必须是数组")
        if add_blocked_by and not isinstance(add_blocked_by, list):
            raise HTTPException(status_code=400, detail="addBlockedBy 必须是数组")

        blocks = list(existing.get("blocks") or [])
        blocked_by = list(existing.get("blockedBy") or [])
        for related_id in add_blocks:
            related_task = _read_task_unsafe(conversation_id, str(related_id))
            if related_task is None:
                raise HTTPException(status_code=404, detail=f"被阻塞任务不存在: {related_id}")
            if str(related_id) != task_id and str(related_id) not in blocks:
                blocks.append(str(related_id))
            related_blocks = list(related_task.get("blockedBy") or [])
            if task_id not in related_blocks and str(related_id) != task_id:
                related_blocks.append(task_id)
                related_task["blockedBy"] = related_blocks
                related_task = _normalize_task_payload(related_task, task_id=str(related_task["id"]))
                _write_task_unsafe(conversation_id, related_task)

        for related_id in add_blocked_by:
            related_task = _read_task_unsafe(conversation_id, str(related_id))
            if related_task is None:
                raise HTTPException(status_code=404, detail=f"阻塞任务不存在: {related_id}")
            if str(related_id) != task_id and str(related_id) not in blocked_by:
                blocked_by.append(str(related_id))
            related_targets = list(related_task.get("blocks") or [])
            if task_id not in related_targets and str(related_id) != task_id:
                related_targets.append(task_id)
                related_task["blocks"] = related_targets
                related_task = _normalize_task_payload(related_task, task_id=str(related_task["id"]))
                _write_task_unsafe(conversation_id, related_task)

        next_task["blocks"] = blocks
        next_task["blockedBy"] = blocked_by
        normalized = _normalize_task_payload(next_task, task_id=task_id)
        _write_task_unsafe(conversation_id, normalized)
        return normalized


def delete_task(conversation_id: str, task_id: str) -> dict[str, bool]:
    with _get_lock(conversation_id):
        path = _task_path(conversation_id, task_id)
        if not path.exists():
            raise HTTPException(status_code=404, detail="任务不存在")

        numeric_id = _parse_numeric_id(task_id)
        if numeric_id is not None and numeric_id > _read_high_water_mark(conversation_id):
            _write_high_water_mark(conversation_id, numeric_id)

        path.unlink()
        for task in list_tasks(conversation_id):
            next_blocks = [item for item in task.get("blocks", []) if item != task_id]
            next_blocked_by = [item for item in task.get("blockedBy", []) if item != task_id]
            if next_blocks != task.get("blocks") or next_blocked_by != task.get("blockedBy"):
                task["blocks"] = next_blocks
                task["blockedBy"] = next_blocked_by
                _write_task_unsafe(conversation_id, _normalize_task_payload(task, task_id=str(task["id"])))
        return {"success": True}


def reset_completed_tasks(conversation_id: str) -> dict[str, bool]:
    with _get_lock(conversation_id):
        tasks = list_tasks(conversation_id)
        if not tasks or any(task.get("status") != "completed" for task in tasks):
            return {"success": False}
        for task in tasks:
            _task_path(conversation_id, str(task["id"])).unlink(missing_ok=True)
        return {"success": True}


def delete_task_list(conversation_id: str) -> None:
    with _get_lock(conversation_id):
        shutil.rmtree(_tasks_dir(conversation_id), ignore_errors=True)
