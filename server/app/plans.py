from __future__ import annotations

import json
import re
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from .config import PLANS_DIR


PLAN_STATUSES = {"drafting", "needs_user_input", "pending_approval", "approved", "rejected", "superseded"}

_PLAN_LOCKS: dict[str, threading.RLock] = {}
_LOCKS_GUARD = threading.Lock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sanitize_path_component(value: str) -> str:
    sanitized = re.sub(r"[^a-zA-Z0-9_-]", "-", str(value).strip())
    return sanitized or "default"


def _get_lock(conversation_id: str) -> threading.RLock:
    with _LOCKS_GUARD:
        lock = _PLAN_LOCKS.get(conversation_id)
        if lock is None:
            lock = threading.RLock()
            _PLAN_LOCKS[conversation_id] = lock
        return lock


def _plan_dir(conversation_id: str) -> Path:
    path = PLANS_DIR / _sanitize_path_component(conversation_id)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _current_plan_path(conversation_id: str) -> Path:
    return _plan_dir(conversation_id) / "current.json"


def _normalize_question(raw: dict[str, Any], index: int) -> dict[str, Any]:
    question_id = str(raw.get("id") or f"q{index + 1}").strip() or f"q{index + 1}"
    prompt = str(raw.get("question") or raw.get("prompt") or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="计划问题缺少 question")
    options_raw = raw.get("options") or []
    if not isinstance(options_raw, list) or len(options_raw) < 2:
        raise HTTPException(status_code=400, detail="计划问题至少需要 2 个选项")
    options: list[dict[str, str]] = []
    for option_index, option in enumerate(options_raw):
        if isinstance(option, dict):
            label = str(option.get("label") or option.get("value") or "").strip()
            description = str(option.get("description") or "").strip()
            value = str(option.get("value") or label or f"option_{option_index + 1}").strip()
        else:
            label = str(option).strip()
            description = ""
            value = label or f"option_{option_index + 1}"
        if not label:
            continue
        item = {"value": value, "label": label}
        if description:
            item["description"] = description
        options.append(item)
    if len(options) < 2:
        raise HTTPException(status_code=400, detail="计划问题至少需要 2 个有效选项")
    header = str(raw.get("header") or "").strip()
    result = {
        "id": question_id,
        "question": prompt,
        "options": options[:4],
        "answered": False,
    }
    if header:
        result["header"] = header[:24]
    return result


def _normalize_plan(raw: dict[str, Any]) -> dict[str, Any]:
    status = str(raw.get("status") or "drafting").strip()
    if status not in PLAN_STATUSES:
        status = "drafting"
    questions = raw.get("questions") if isinstance(raw.get("questions"), list) else []
    return {
        "planId": str(raw.get("planId") or uuid.uuid4().hex[:12]),
        "conversationId": str(raw.get("conversationId") or ""),
        "status": status,
        "content": str(raw.get("content") or ""),
        "questions": [question for question in questions if isinstance(question, dict)],
        "feedback": str(raw.get("feedback") or ""),
        "createdAt": str(raw.get("createdAt") or _now_iso()),
        "updatedAt": str(raw.get("updatedAt") or _now_iso()),
        **({"approvedAt": str(raw.get("approvedAt"))} if raw.get("approvedAt") else {}),
    }


def _read_plan_unsafe(conversation_id: str) -> dict[str, Any] | None:
    path = _current_plan_path(conversation_id)
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=500, detail="计划文件损坏") from exc
    if not isinstance(raw, dict):
        raise HTTPException(status_code=500, detail="计划文件格式错误")
    plan = _normalize_plan(raw)
    plan["conversationId"] = conversation_id
    return plan


def _write_plan_unsafe(conversation_id: str, plan: dict[str, Any]) -> dict[str, Any]:
    now = _now_iso()
    next_plan = _normalize_plan({**plan, "conversationId": conversation_id, "updatedAt": now})
    _current_plan_path(conversation_id).write_text(
        json.dumps(next_plan, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return next_plan


def get_plan(conversation_id: str) -> dict[str, Any] | None:
    with _get_lock(conversation_id):
        return _read_plan_unsafe(conversation_id)


def submit_plan_for_approval(conversation_id: str | None, content: str) -> dict[str, Any]:
    if not conversation_id:
        raise HTTPException(status_code=400, detail="提交计划需要 conversationId")
    text = str(content or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="计划内容不能为空")
    with _get_lock(conversation_id):
        existing = _read_plan_unsafe(conversation_id)
        created_at = existing.get("createdAt") if existing and existing.get("status") in {"drafting", "needs_user_input"} else _now_iso()
        plan = {
            "planId": uuid.uuid4().hex[:12] if existing and existing.get("status") in {"approved", "pending_approval", "rejected"} else (existing or {}).get("planId", uuid.uuid4().hex[:12]),
            "conversationId": conversation_id,
            "status": "pending_approval",
            "content": text,
            "questions": (existing or {}).get("questions", []),
            "feedback": "",
            "createdAt": created_at,
            "updatedAt": _now_iso(),
        }
        return _write_plan_unsafe(conversation_id, plan)


def request_plan_questions(conversation_id: str | None, questions: list[dict[str, Any]], context: str = "") -> dict[str, Any]:
    if not conversation_id:
        raise HTTPException(status_code=400, detail="提交计划问题需要 conversationId")
    if not isinstance(questions, list) or not questions:
        raise HTTPException(status_code=400, detail="questions 不能为空")
    normalized_questions = [_normalize_question(question, index) for index, question in enumerate(questions[:4])]
    with _get_lock(conversation_id):
        existing = _read_plan_unsafe(conversation_id) or {
            "planId": uuid.uuid4().hex[:12],
            "conversationId": conversation_id,
            "status": "drafting",
            "content": "",
            "questions": [],
            "createdAt": _now_iso(),
        }
        plan = {
            **existing,
            "status": "needs_user_input",
            "content": str(context or existing.get("content") or ""),
            "questions": normalized_questions,
        }
        return _write_plan_unsafe(conversation_id, plan)


def answer_plan_question(conversation_id: str, question_id: str, answer: str) -> dict[str, Any]:
    with _get_lock(conversation_id):
        plan = _read_plan_unsafe(conversation_id)
        if plan is None:
            raise HTTPException(status_code=404, detail="计划不存在")
        questions = list(plan.get("questions") or [])
        matched = False
        for question in questions:
            if str(question.get("id")) != question_id:
                continue
            matched = True
            valid_values = {str(option.get("value") or option.get("label")) for option in question.get("options", []) if isinstance(option, dict)}
            selected = str(answer or "").strip()
            if valid_values and selected not in valid_values:
                raise HTTPException(status_code=400, detail="答案不在可选项中")
            question["answer"] = selected
            question["answered"] = True
            question["answeredAt"] = _now_iso()
        if not matched:
            raise HTTPException(status_code=404, detail="计划问题不存在")
        plan["questions"] = questions
        if all(bool(question.get("answered")) for question in questions):
            plan["status"] = "drafting"
        return _write_plan_unsafe(conversation_id, plan)


def approve_plan(conversation_id: str) -> dict[str, Any]:
    with _get_lock(conversation_id):
        plan = _read_plan_unsafe(conversation_id)
        if plan is None:
            raise HTTPException(status_code=404, detail="计划不存在")
        if plan.get("status") != "pending_approval":
            raise HTTPException(status_code=400, detail="只有待审批计划可以批准")
        now = _now_iso()
        plan["status"] = "approved"
        plan["approvedAt"] = now
        return _write_plan_unsafe(conversation_id, plan)


def reject_plan(conversation_id: str, feedback: str = "") -> dict[str, Any]:
    with _get_lock(conversation_id):
        plan = _read_plan_unsafe(conversation_id)
        if plan is None:
            raise HTTPException(status_code=404, detail="计划不存在")
        if plan.get("status") not in {"pending_approval", "needs_user_input", "drafting", "approved"}:
            raise HTTPException(status_code=400, detail="当前计划不能退回")
        plan["status"] = "rejected"
        plan["feedback"] = str(feedback or "").strip()
        return _write_plan_unsafe(conversation_id, plan)


def get_approved_plan_attachment(conversation_id: str | None) -> str:
    if not conversation_id:
        return ""
    plan = get_plan(conversation_id)
    if not plan or plan.get("status") != "approved" or not str(plan.get("content") or "").strip():
        return ""
    payload = {
        "type": "approved_plan",
        "planId": plan.get("planId"),
        "approvedAt": plan.get("approvedAt"),
        "content": plan.get("content"),
        "note": "这是用户已批准的执行计划。Build 模式下应按此计划执行；如遇事实变化或风险，应先说明并请求用户调整。",
    }
    return "[系统附件] type=approved_plan\n" + json.dumps(payload, ensure_ascii=False, sort_keys=True)


def get_rejected_plan_attachment(conversation_id: str | None) -> str:
    if not conversation_id:
        return ""
    plan = get_plan(conversation_id)
    if not plan or plan.get("status") != "rejected":
        return ""
    payload = {
        "type": "rejected_plan",
        "planId": plan.get("planId"),
        "content": plan.get("content"),
        "feedback": plan.get("feedback"),
        "note": "上一个计划已被用户退回。Plan 模式下请吸收 feedback，重新调研或提问后提交替代计划。",
    }
    return "[系统附件] type=rejected_plan\n" + json.dumps(payload, ensure_ascii=False, sort_keys=True)


def delete_plan(conversation_id: str) -> None:
    with _get_lock(conversation_id):
        shutil.rmtree(_plan_dir(conversation_id), ignore_errors=True)
