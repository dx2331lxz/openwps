from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException

from .config import CONVERSATIONS_DIR
from .tasks import delete_task_list


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def conv_path(conv_id: str) -> Path:
    return CONVERSATIONS_DIR / f"{conv_id}.json"


def read_conversation(conv_id: str) -> dict:
    path = conv_path(conv_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="会话不存在")
    return json.loads(path.read_text(encoding="utf-8"))


def write_conversation(conv: dict) -> None:
    conv["updatedAt"] = now_iso()
    conv_path(conv["id"]).write_text(
        json.dumps(conv, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def list_conversations() -> list[dict]:
    conversations: list[dict] = []
    for path in CONVERSATIONS_DIR.glob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue

        conversations.append({
            "id": data["id"],
            "title": data.get("title", ""),
            "createdAt": data.get("createdAt", ""),
            "updatedAt": data.get("updatedAt", ""),
        })

    conversations.sort(key=lambda item: item.get("updatedAt", ""), reverse=True)
    return conversations


def create_conversation(title: str = "新会话") -> dict:
    conv_id = str(uuid.uuid4())
    ts = now_iso()
    conv = {
        "id": conv_id,
        "title": title[:30],
        "createdAt": ts,
        "updatedAt": ts,
        "messages": [],
    }
    write_conversation(conv)
    return conv


def append_messages(conv_id: str, messages: list[dict]) -> dict:
    conv = read_conversation(conv_id)
    conv["messages"].extend(messages)
    write_conversation(conv)
    return conv


def delete_conversation(conv_id: str) -> None:
    path = conv_path(conv_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="会话不存在")
    path.unlink()
    delete_task_list(conv_id)
