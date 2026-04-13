from __future__ import annotations

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, AsyncGenerator, TypedDict

import httpx
from fastapi import HTTPException
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.runnables import RunnableLambda
from langgraph.graph import END, START, StateGraph
from langchain_openai import ChatOpenAI
from langchain_core.runnables import Runnable

from .config import get_provider, read_config
from .models import ChatMessage, ChatRequest, ToolResultsRequest
from .prompts import get_system_prompt
from .tooling import get_tools

logger = logging.getLogger("uvicorn.error")


class AgentState(TypedDict):
    messages: list[BaseMessage]
    response: AIMessage


def _stringify_content(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "".join(parts)
    return str(content)


def _extract_reasoning(chunk: AIMessageChunk) -> str:
    values = [
        chunk.additional_kwargs.get("reasoning_content"),
        chunk.additional_kwargs.get("thinking"),
    ]
    return "".join(value for value in values if isinstance(value, str))


def _extract_finish_reason(payload: Any) -> str:
    if payload is None or isinstance(payload, str):
        return ""

    if isinstance(payload, dict):
        for key in ("finish_reason", "finishReason", "stop_reason", "stopReason"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        for key in ("response_metadata", "additional_kwargs", "llm_output", "output", "message", "generations"):
            reason = _extract_finish_reason(payload.get(key))
            if reason:
                return reason
        return ""

    if isinstance(payload, (list, tuple)):
        for item in payload:
            reason = _extract_finish_reason(item)
            if reason:
                return reason
        return ""

    for attr in ("response_metadata", "additional_kwargs", "llm_output", "output", "message", "generations"):
        if hasattr(payload, attr):
            reason = _extract_finish_reason(getattr(payload, attr))
            if reason:
                return reason
    return ""


def _is_output_truncated_finish_reason(finish_reason: str) -> bool:
    normalized = finish_reason.strip().lower()
    if not normalized:
        return False
    return (
        normalized == "length"
        or "max_tokens" in normalized
        or "max_output_tokens" in normalized
    )


def _repair_tool_args_json(raw_args: str) -> str | None:
    text = (raw_args or "").strip()
    if not text:
        return None

    stack: list[str] = []
    in_string = False
    escaped = False

    for char in text:
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue

        if char == '"':
            in_string = True
        elif char == "{":
            stack.append("}")
        elif char == "[":
            stack.append("]")
        elif char in {"}", "]"}:
            if not stack or stack[-1] != char:
                return None
            stack.pop()

    repaired = text
    if in_string:
        repaired += '"'
    if escaped:
        repaired += '"'
    if stack:
        repaired += "".join(reversed(stack))

    repaired = repaired.replace(",}", "}").replace(",]", "]")
    return repaired if repaired != text else None


def _tool_calls_from_ai_message(message: AIMessage) -> list[dict[str, Any]]:
    tool_calls: list[dict[str, Any]] = []
    for call in message.tool_calls:
        tool_calls.append({
            "id": call.get("id"),
            "name": call.get("name", ""),
            "params": call.get("args", {}) or {},
        })
    return tool_calls


def _parse_tool_args(arguments: Any) -> dict[str, Any]:
    if isinstance(arguments, dict):
        return arguments
    if not isinstance(arguments, str):
        return {}

    try:
        parsed = json.loads(arguments)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        repaired_args = _repair_tool_args_json(arguments)
        if not repaired_args:
            return {}
        try:
            parsed = json.loads(repaired_args)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}


def _to_langchain_message(message: ChatMessage | dict[str, Any]) -> BaseMessage:
    raw = message.model_dump(exclude_none=True) if isinstance(message, ChatMessage) else dict(message)
    role = raw.get("role", "user")
    content = _stringify_content(raw.get("content"))

    if role == "system":
        return SystemMessage(content=content)
    if role == "assistant":
        tool_calls = []
        for call in raw.get("tool_calls") or []:
            fn = call.get("function") or {}
            args = _parse_tool_args(fn.get("arguments", "{}"))
            tool_calls.append({
                "id": call.get("id"),
                "name": fn.get("name", ""),
                "args": args or {},
                "type": "tool_call",
            })
        return AIMessage(content=content, tool_calls=tool_calls)
    if role == "tool":
        return ToolMessage(content=content, tool_call_id=str(raw.get("tool_call_id", "")))
    return HumanMessage(content=content)


def _build_context_block(context: dict) -> str:
    """Serialize context dict into a text block the LLM can read."""
    if not context:
        return ""
    parts: list[str] = []
    parts.append("[当前文档上下文]")
    document_context = {
        "paragraphCount": context.get("paragraphCount"),
        "wordCount": context.get("wordCount"),
        "pageCount": context.get("pageCount"),
    }
    parts.append(f"context.document = {json.dumps(document_context, ensure_ascii=False)}")

    preview = context.get("preview")
    if preview and isinstance(preview, dict):
        parts.append("")
        parts.append("context.preview = " + json.dumps(preview, ensure_ascii=False, indent=2))
        parts.append("以上是为长文档准备的紧凑预览，可用来决定是否继续调用 get_document_outline / get_page_content / get_document_content。")

    selection = context.get("selection")
    if selection and isinstance(selection, dict):
        parts.append("")
        parts.append("context.selection = " + json.dumps(selection, ensure_ascii=False, indent=2))
        parts.append("以上是 context.selection 的序列化结果，请按这些字段名理解选区信息。")

    return "\n".join(parts)


def _already_has_context_block(content: str) -> bool:
    return "[当前文档上下文]" in content and "[用户请求]" in content


def _normalize_user_text(message: str, context_block: str) -> str:
    user_text = message
    if context_block and not _already_has_context_block(user_text):
        user_text = context_block + "\n\n" + user_text
    return user_text


def _build_human_content(message: str, context_block: str, images: list[dict[str, Any]] | None = None) -> str | list[dict[str, Any]]:
    user_text = _normalize_user_text(message, context_block)
    if not images:
        return user_text

    content: list[dict[str, Any]] = [{"type": "text", "text": user_text}]
    for image in images:
        url = image.get("dataUrl")
        if not isinstance(url, str) or not url:
            continue
        content.append({
            "type": "image_url",
            "image_url": {"url": url},
        })
    return content

def _log_final_user_message(body: ChatRequest, messages: list[BaseMessage]) -> None:
    last_user = next(
        (
            msg for msg in reversed(messages)
            if isinstance(msg, HumanMessage)
        ),
        None,
    )
    if not last_user:
        return

    logger.info(
        "[openwps.ai] final user prompt conversationId=%s mode=%s\n%s",
        body.conversationId or "-",
        body.mode,
        _stringify_content(last_user.content),
    )


# ─── Session-based ReAct infrastructure ──────────────────────────────────────

MAX_REACT_ROUNDS = 50
KEEP_FULL_ROUNDS = 3
TOOL_RESULT_TIMEOUT = 300  # seconds
MAX_RETRIES_PER_ROUND = 2
MAX_FORCED_FOLLOW_UPS = 3
MAX_OUTPUT_CONTINUATIONS = 3
RETRY_DELAYS = [1.0, 2.0, 4.0]
# Token budget: trigger compression when estimated input tokens exceed this
TOKEN_BUDGET_SOFT = 24_000   # tier-1 compression kicks in
TOKEN_BUDGET_HARD = 48_000   # tier-2 round summary
TOKEN_BUDGET_CRITICAL = 80_000  # tier-3 aggressive truncation


# ─── Token Estimation ─────────────────────────────────────────────────────────

def _estimate_tokens(text: str) -> int:
    """Rough token count: ~1.5 chars/token for CJK, ~4 chars/token for Latin."""
    if not text:
        return 0
    cjk = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
    other = len(text) - cjk
    return int(cjk / 1.5 + other / 4)


def _estimate_messages_tokens(messages: list[BaseMessage]) -> int:
    total = 0
    for msg in messages:
        total += _estimate_tokens(_stringify_content(msg.content))
        if isinstance(msg, AIMessage):
            for tc in msg.tool_calls:
                total += _estimate_tokens(json.dumps(tc.get("args", {}), ensure_ascii=False))
        total += 4  # per-message overhead
    return total


# ─── State Machine ─────────────────────────────────────────────────────────────

class Transition(str, Enum):
    """Named reasons for continuing or ending the ReAct loop."""
    NEXT_TURN = "next_turn"
    ERROR_RETRY = "error_retry"
    CONTEXT_COMPRESSED = "context_compressed"
    OUTPUT_CONTINUE = "output_continue"
    FOLLOW_UP_CONTINUE = "follow_up_continue"
    STOP_HOOK_RETRY = "stop_hook_retry"
    COMPLETED = "completed"
    STOPPED_BY_CLIENT = "stopped_by_client"
    MAX_ROUNDS = "max_rounds"
    TIMEOUT = "timeout"
    FATAL_ERROR = "fatal_error"


@dataclass
class LoopState:
    """Mutable state carried across iterations of the ReAct loop."""
    transition: Transition = Transition.NEXT_TURN
    round: int = 0
    retries_this_round: int = 0
    consecutive_errors: int = 0
    compression_tier: int = 0  # 0=none, 1=tool_compress, 2=round_summary, 3=aggressive
    estimated_tokens: int = 0
    pending_write_follow_up: bool = False
    forced_follow_up_attempts: int = 0
    # Stop-hook tracking
    recent_tool_patterns: list[str] = field(default_factory=list)
    consecutive_empty_content: int = 0
    tool_failure_counts: dict[str, int] = field(default_factory=dict)
    requires_content_verification: bool = False
    requires_todo_check: bool = False
    last_mutation_tools: list[str] = field(default_factory=list)
    round_budget_warning_level: int = 0
    last_token_budget_warning_tier: int = 0
    last_budget_progress_signature: str = ""
    stagnant_budget_rounds: int = 0
    budget_stagnation_warning_level: int = 0
    output_continuation_attempts: int = 0
    last_model_finish_reason: str = ""


# ─── Stop Hooks ────────────────────────────────────────────────────────────────

class StopDecision(str, Enum):
    CONTINUE = "continue"
    STOP = "stop"
    RETRY_WITH_HINT = "retry_with_hint"


@dataclass
class StopEvaluation:
    decision: StopDecision
    reason: str = ""
    hint: str = ""


class CompletionDecision(str, Enum):
    CONTINUE_WITH_HINT = "continue_with_hint"
    COMPLETE = "complete"
    FAIL = "fail"


@dataclass
class CompletionEvaluation:
    decision: CompletionDecision
    reason: str = ""
    hint: str = ""
    pending_todo_count: int = 0


@dataclass
class BudgetEvaluation:
    should_warn: bool
    reason: str = ""
    hint: str = ""
    remaining_rounds: int = 0
    estimated_tokens: int = 0
    stagnant_rounds: int = 0


class RoundDecisionAction(str, Enum):
    CONTINUE = "continue"
    FINISH = "finish"
    ERROR = "error"


@dataclass
class RoundDecision:
    action: RoundDecisionAction
    transition: Transition
    reason: str
    hint_to_model: str = ""
    client_message: str = ""
    pending_todo_count: int = 0
    finish_reason: str = ""
    error_message: str = ""
    budget_evaluation: BudgetEvaluation | None = None
    stop_hook_hint: str = ""


@dataclass(frozen=True)
class SourceToolCall:
    id: str
    name: str
    params: dict[str, Any]


@dataclass(frozen=True)
class PlannedToolExecution:
    execution_id: str
    tool_name: str
    params: dict[str, Any]
    source_calls: list[SourceToolCall]
    merge_strategy: str = "single"
    continue_on_error: bool = True


@dataclass(frozen=True)
class ToolExecutionPlan:
    plan_id: str
    round: int
    executions: list[PlannedToolExecution]


@dataclass(frozen=True)
class PostedToolResult:
    execution_id: str
    content: str


@dataclass(frozen=True)
class PostedToolResults:
    plan_id: str | None
    round: int | None
    results: list[PostedToolResult]
    stop: bool = False


@dataclass
class SessionTrace:
    session_id: str
    conversation_id: str | None
    mode: str
    model: str | None
    provider_id: str | None
    created_at: str
    events: list[dict[str, Any]] = field(default_factory=list)
    checkpoints: list[dict[str, Any]] = field(default_factory=list)
    final_state: dict[str, Any] = field(default_factory=dict)


def _evaluate_stop_hooks(state: LoopState, tool_calls: list[dict[str, Any]],
                          tool_results: list[dict[str, str]]) -> StopEvaluation:
    """Evaluate whether the loop should stop, continue, or hint the LLM."""
    # ── 1. Tool-loop detection: same tool pattern 3 times in a row ──
    if tool_calls:
        pattern = "|".join(sorted(tc["name"] for tc in tool_calls))
        state.recent_tool_patterns.append(pattern)
        if len(state.recent_tool_patterns) > 6:
            state.recent_tool_patterns = state.recent_tool_patterns[-6:]
        if (len(state.recent_tool_patterns) >= 3
                and len(set(state.recent_tool_patterns[-3:])) == 1):
            return StopEvaluation(
                StopDecision.RETRY_WITH_HINT,
                "tool_loop_detected",
                "你正在重复调用完全相同的工具组合。请检查当前文档状态：如果目标已达成，请直接回复用户；如果未达成，请尝试不同策略。",
            )

    # ── 2. Repeated failures of the same tool ──
    for item in tool_results:
        try:
            data = json.loads(item.get("content", "{}"))
        except Exception:
            continue
        tool_name = data.get("toolName", "")
        if not tool_name:
            continue
        if data.get("success"):
            state.tool_failure_counts.pop(tool_name, None)
        else:
            state.tool_failure_counts[tool_name] = state.tool_failure_counts.get(tool_name, 0) + 1
            if state.tool_failure_counts[tool_name] >= 3:
                return StopEvaluation(
                    StopDecision.RETRY_WITH_HINT,
                    f"repeated_failure:{tool_name}",
                    f"工具 {tool_name} 已连续失败 {state.tool_failure_counts[tool_name]} 次。"
                    f"请重新检查参数是否正确，或换用其他工具完成目标。",
                )

    # ── 3. Too many consecutive LLM errors (after retries exhausted) ──
    if state.consecutive_errors >= 3:
        return StopEvaluation(StopDecision.STOP, "consecutive_api_errors")

    return StopEvaluation(StopDecision.CONTINUE)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _truncate_preview(value: Any, max_len: int = 160) -> str:
    text = _stringify_content(value).replace("\n", " ").strip()
    if len(text) <= max_len:
        return text
    return text[:max_len] + "..."


def _parse_tool_result_payload(content: Any) -> dict[str, Any]:
    text = _stringify_content(content)
    if not text:
        return {}
    try:
        payload = json.loads(text)
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def _extract_todos_from_payload(payload: dict[str, Any]) -> list[dict[str, str]] | None:
    candidates = [
        payload.get("data"),
        payload.get("executedParams"),
        payload.get("originalParams"),
    ]
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        raw_todos = candidate.get("todos")
        if not isinstance(raw_todos, list):
            continue
        todos: list[dict[str, str]] = []
        for item in raw_todos:
            if not isinstance(item, dict):
                continue
            todos.append({
                "id": str(item.get("id", "")).strip(),
                "title": str(item.get("title", "")).strip(),
                "status": str(item.get("status", "pending")).strip().lower(),
            })
        return todos
    return None


def _get_latest_todos(messages: list[BaseMessage]) -> list[dict[str, str]]:
    for message in reversed(messages):
        if not isinstance(message, ToolMessage):
            continue
        payload = _parse_tool_result_payload(message.content)
        todos = _extract_todos_from_payload(payload)
        if todos is not None:
            return todos
    return []


def _get_incomplete_todos(messages: list[BaseMessage]) -> list[dict[str, str]]:
    return [
        todo for todo in _get_latest_todos(messages)
        if todo.get("status") in {"pending", "in_progress"}
    ]


def _tool_results_started_streaming_write(tool_results: list[dict[str, str]]) -> bool:
    for item in tool_results:
        payload = _parse_tool_result_payload(item.get("content", ""))
        if payload.get("toolName") != "begin_streaming_write":
            continue
        if payload.get("success") is True:
            return True
    return False


def _build_follow_up_hint(
    needs_write_follow_up: bool,
    needs_content_verification: bool,
    needs_todo_check: bool,
    incomplete_todos: list[dict[str, str]],
) -> tuple[str, str]:
    parts: list[str] = []
    reasons: list[str] = []

    if needs_write_follow_up:
        reasons.append("post_write_follow_up")
        parts.append("你刚刚完成的是正文流式写入阶段，这一轮纯文本输出属于写入文档的正文，不是最终结束信号。")
        parts.append("现在必须继续执行后续流程：先验证正文是否已经正确写入，再更新任务状态，然后完成剩余步骤。")

    if needs_content_verification:
        reasons.append("content_verification_required")
        parts.append("你最近执行了正文修改工具，但还没有在修改后调用 get_document_content 或 get_paragraph 进行验证。")
        parts.append("现在必须先读取并确认正文结果是否正确，再决定是否继续或结束。")

    if needs_todo_check:
        reasons.append("todo_status_unchecked")
        parts.append("你最近更新过任务计划，但还没有再次调用 get_todo_list 核对最终状态。")
        parts.append("结束前必须先确认当前 todo 列表，不能直接假设任务已经全部完成。")

    if incomplete_todos:
        reasons.append("todo_incomplete")
        preview_titles = [todo.get("title", "") for todo in incomplete_todos if todo.get("title")][:3]
        title_text = f" 未完成项示例：{'；'.join(preview_titles)}。" if preview_titles else ""
        parts.append(
            f"当前任务计划仍有 {len(incomplete_todos)} 个未完成项（pending / in_progress）。{title_text}"
        )
    else:
        parts.append("如果本轮没有 todo，也至少先调用验证工具确认写入结果，再决定是否结束。")

    parts.append("只有在验证完成，且 get_todo_list 显示不存在 pending / in_progress 后，才能结束并向用户总结。")
    return "\n".join(parts), reasons[0] if reasons else "continue_required"


CONTENT_MUTATION_TOOLS = {
    "begin_streaming_write",
    "insert_text",
    "insert_paragraph_after",
    "replace_paragraph_text",
    "replace_selection_text",
    "delete_selection_text",
    "delete_paragraph",
}

CONTENT_VERIFICATION_TOOLS = {
    "get_document_content",
    "get_paragraph",
}

TODO_UPDATE_TOOLS = {"update_todo_list"}
TODO_CHECK_TOOLS = {"get_todo_list"}


def _update_completion_gate_state(state: LoopState, tool_results: list[dict[str, str]]) -> None:
    """Track whether the agent is currently allowed to stop."""
    for item in tool_results:
        payload = _parse_tool_result_payload(item.get("content", ""))
        tool_name = str(payload.get("toolName", "")).strip()
        success = payload.get("success") is True
        if not tool_name or not success:
            continue

        if tool_name in CONTENT_MUTATION_TOOLS:
            state.requires_content_verification = True
            if tool_name not in state.last_mutation_tools:
                state.last_mutation_tools.append(tool_name)
            continue

        if tool_name in CONTENT_VERIFICATION_TOOLS:
            state.requires_content_verification = False
            state.last_mutation_tools.clear()
            continue

        if tool_name in TODO_UPDATE_TOOLS:
            state.requires_todo_check = True
            continue

        if tool_name in TODO_CHECK_TOOLS:
            state.requires_todo_check = False


def _needs_forced_continuation(state: LoopState, messages: list[BaseMessage]) -> tuple[bool, list[dict[str, str]]]:
    incomplete_todos = _get_incomplete_todos(messages)
    needs_continue = any([
        state.pending_write_follow_up,
        state.requires_content_verification,
        state.requires_todo_check,
        bool(incomplete_todos),
    ])
    return needs_continue, incomplete_todos


def _evaluate_completion_policy(state: LoopState, messages: list[BaseMessage]) -> CompletionEvaluation:
    needs_continue, incomplete_todos = _needs_forced_continuation(state, messages)
    if not needs_continue:
        return CompletionEvaluation(
            decision=CompletionDecision.COMPLETE,
            reason="completed",
            pending_todo_count=0,
        )

    if state.forced_follow_up_attempts >= MAX_FORCED_FOLLOW_UPS:
        return CompletionEvaluation(
            decision=CompletionDecision.FAIL,
            reason="forced_follow_up_limit_reached",
            pending_todo_count=len(incomplete_todos),
        )

    hint, reason = _build_follow_up_hint(
        state.pending_write_follow_up,
        state.requires_content_verification,
        state.requires_todo_check,
        incomplete_todos,
    )
    return CompletionEvaluation(
        decision=CompletionDecision.CONTINUE_WITH_HINT,
        reason=reason,
        hint=hint,
        pending_todo_count=len(incomplete_todos),
    )


def _evaluate_budget_policy(state: LoopState, messages: list[BaseMessage]) -> BudgetEvaluation:
    needs_continue, _ = _needs_forced_continuation(state, messages)
    remaining_rounds = max(MAX_REACT_ROUNDS - state.round, 0)
    stagnant_rounds = _track_budget_progress(state, messages, needs_continue)
    if not needs_continue:
        return BudgetEvaluation(False, remaining_rounds=remaining_rounds, estimated_tokens=state.estimated_tokens)

    if remaining_rounds <= 2 and stagnant_rounds >= 1 and state.budget_stagnation_warning_level < 2:
        return BudgetEvaluation(
            should_warn=True,
            reason="critical_budget_stagnation",
            hint=(
                f"自动执行轮次仅剩 {remaining_rounds} 轮，且最近 {stagnant_rounds + 1} 轮没有缩小未完成状态。"
                f"下一轮只能执行直接收口动作：如果还未验证正文，立刻调用 get_document_content 或 get_paragraph；"
                f"如果 todo 还未核对，立刻调用 get_todo_list；随后输出最终总结。"
            ),
            remaining_rounds=remaining_rounds,
            estimated_tokens=state.estimated_tokens,
            stagnant_rounds=stagnant_rounds,
        )

    if (
        stagnant_rounds >= 2
        and state.budget_stagnation_warning_level < 1
        and (
            remaining_rounds <= 5
            or (state.compression_tier >= 2 and state.estimated_tokens >= TOKEN_BUDGET_HARD)
        )
    ):
        return BudgetEvaluation(
            should_warn=True,
            reason="budget_stagnation",
            hint=(
                f"最近 {stagnant_rounds + 1} 轮没有缩小未完成状态。"
                f"后续必须放弃新的探索，只做能直接清空 completion gate 的动作：正文验证、todo 核对、最终总结。"
            ),
            remaining_rounds=remaining_rounds,
            estimated_tokens=state.estimated_tokens,
            stagnant_rounds=stagnant_rounds,
        )

    if remaining_rounds <= 2 and state.round_budget_warning_level < 2:
        return BudgetEvaluation(
            should_warn=True,
            reason="critical_round_budget",
            hint=(
                f"自动执行轮次仅剩 {remaining_rounds} 轮。后续必须收敛到最小动作："
                f"优先完成验证、get_todo_list 核对和最终总结，不要再扩散任务或重新读取大段内容。"
            ),
            remaining_rounds=remaining_rounds,
            estimated_tokens=state.estimated_tokens,
            stagnant_rounds=stagnant_rounds,
        )

    if state.compression_tier >= 2 and state.estimated_tokens >= TOKEN_BUDGET_HARD and state.last_token_budget_warning_tier < state.compression_tier:
        return BudgetEvaluation(
            should_warn=True,
            reason="compressed_context_budget",
            hint=(
                f"上下文已进入压缩阶段（级别 {state.compression_tier}）。"
                f"接下来只执行必要动作：优先验证、todo 核对和总结，不要再扩展新的探索步骤。"
            ),
            remaining_rounds=remaining_rounds,
            estimated_tokens=state.estimated_tokens,
            stagnant_rounds=stagnant_rounds,
        )

    if remaining_rounds <= 5 and state.round_budget_warning_level < 1:
        return BudgetEvaluation(
            should_warn=True,
            reason="low_round_budget",
            hint=(
                f"自动执行轮次接近上限，还剩 {remaining_rounds} 轮。"
                f"后续请保持最小化，只做必要验证、todo 核对和收尾。"
            ),
            remaining_rounds=remaining_rounds,
            estimated_tokens=state.estimated_tokens,
            stagnant_rounds=stagnant_rounds,
        )

    return BudgetEvaluation(
        False,
        remaining_rounds=remaining_rounds,
        estimated_tokens=state.estimated_tokens,
        stagnant_rounds=stagnant_rounds,
    )


def _mark_budget_warning_emitted(state: LoopState, evaluation: BudgetEvaluation) -> None:
    if not evaluation.should_warn:
        return
    if evaluation.reason == "budget_stagnation":
        state.budget_stagnation_warning_level = max(state.budget_stagnation_warning_level, 1)
        return
    if evaluation.reason == "critical_budget_stagnation":
        state.budget_stagnation_warning_level = max(state.budget_stagnation_warning_level, 2)
        return
    if evaluation.reason == "low_round_budget":
        state.round_budget_warning_level = max(state.round_budget_warning_level, 1)
        return
    if evaluation.reason == "critical_round_budget":
        state.round_budget_warning_level = max(state.round_budget_warning_level, 2)
        return
    if evaluation.reason == "compressed_context_budget":
        state.last_token_budget_warning_tier = max(state.last_token_budget_warning_tier, state.compression_tier)


def _build_budget_progress_signature(state: LoopState, messages: list[BaseMessage]) -> str:
    incomplete_todos = _get_incomplete_todos(messages)
    return json.dumps(
        {
            "requiresContentVerification": state.requires_content_verification,
            "requiresTodoCheck": state.requires_todo_check,
            "incompleteTodoCount": len(incomplete_todos),
            "lastMutationTools": list(state.last_mutation_tools),
        },
        ensure_ascii=False,
        sort_keys=True,
    )


def _track_budget_progress(state: LoopState, messages: list[BaseMessage], needs_continue: bool) -> int:
    if not needs_continue:
        state.last_budget_progress_signature = ""
        state.stagnant_budget_rounds = 0
        state.budget_stagnation_warning_level = 0
        return 0

    signature = _build_budget_progress_signature(state, messages)
    if not state.last_budget_progress_signature:
        state.last_budget_progress_signature = signature
        state.stagnant_budget_rounds = 0
        return 0

    if signature == state.last_budget_progress_signature:
        state.stagnant_budget_rounds += 1
        return state.stagnant_budget_rounds

    state.last_budget_progress_signature = signature
    state.stagnant_budget_rounds = 0
    state.budget_stagnation_warning_level = 0
    return 0


def _build_output_continue_hint(attempt: int) -> str:
    if attempt <= 1:
        return (
            "上一轮输出因长度限制被截断。请从刚才中断的位置继续，"
            "不要重复已经生成的内容；优先完成当前步骤并收束输出。"
        )
    return (
        "上一轮输出再次因长度限制被截断。请只补全剩余内容，"
        "严禁重复前文，也不要重新展开新的分析分支。"
    )


def _decide_output_truncation(
    state: LoopState,
    finish_reason: str,
    round_tool_calls: list[dict[str, Any]],
) -> RoundDecision | None:
    if round_tool_calls or not _is_output_truncated_finish_reason(finish_reason):
        return None

    if state.output_continuation_attempts >= MAX_OUTPUT_CONTINUATIONS:
        return RoundDecision(
            action=RoundDecisionAction.ERROR,
            transition=Transition.FATAL_ERROR,
            reason="output_truncation_limit_reached",
            error_message="AI 输出连续被截断，已达到自动续写上限。请缩小任务范围后重试。",
            finish_reason=finish_reason,
        )

    next_attempt = state.output_continuation_attempts + 1
    return RoundDecision(
        action=RoundDecisionAction.CONTINUE,
        transition=Transition.OUTPUT_CONTINUE,
        reason="output_truncated_continue",
        hint_to_model=_build_output_continue_hint(next_attempt),
        client_message="模型输出被截断，正在继续生成剩余内容...",
        finish_reason=finish_reason,
    )


def _decide_text_round(state: LoopState, messages: list[BaseMessage]) -> RoundDecision:
    completion_evaluation = _evaluate_completion_policy(state, messages)

    if completion_evaluation.decision == CompletionDecision.FAIL:
        return RoundDecision(
            action=RoundDecisionAction.ERROR,
            transition=Transition.FATAL_ERROR,
            reason=completion_evaluation.reason,
            error_message="AI 在正文写入后未继续完成剩余步骤，已达到自动续跑上限。",
        )

    if completion_evaluation.decision == CompletionDecision.COMPLETE:
        return RoundDecision(
            action=RoundDecisionAction.FINISH,
            transition=Transition.COMPLETED,
            reason=completion_evaluation.reason,
            finish_reason="completed",
        )

    budget_evaluation = _evaluate_budget_policy(state, messages)
    hint_to_model = completion_evaluation.hint
    if budget_evaluation.should_warn:
        hint_to_model = hint_to_model + "\n" + budget_evaluation.hint

    return RoundDecision(
        action=RoundDecisionAction.CONTINUE,
        transition=Transition.FOLLOW_UP_CONTINUE,
        reason=completion_evaluation.reason,
        hint_to_model=hint_to_model,
        client_message=(
            "正文已写入，正在继续执行后续步骤..."
            if completion_evaluation.reason == "post_write_follow_up"
            else "任务计划尚未完成，继续执行后续步骤..."
        ),
        pending_todo_count=completion_evaluation.pending_todo_count,
        budget_evaluation=budget_evaluation if budget_evaluation.should_warn else None,
    )


def _decide_tool_round(
    state: LoopState,
    messages: list[BaseMessage],
    round_tool_calls: list[dict[str, Any]],
    execution_results: list[dict[str, str]],
) -> RoundDecision:
    stop_evaluation = _evaluate_stop_hooks(state, round_tool_calls, execution_results)
    if stop_evaluation.decision == StopDecision.STOP:
        return RoundDecision(
            action=RoundDecisionAction.FINISH,
            transition=Transition.FATAL_ERROR,
            reason=stop_evaluation.reason,
            finish_reason=stop_evaluation.reason,
        )

    if stop_evaluation.decision == StopDecision.RETRY_WITH_HINT:
        return RoundDecision(
            action=RoundDecisionAction.CONTINUE,
            transition=Transition.STOP_HOOK_RETRY,
            reason=stop_evaluation.reason,
            hint_to_model=stop_evaluation.hint,
            stop_hook_hint=stop_evaluation.hint,
        )

    budget_evaluation = _evaluate_budget_policy(state, messages)
    return RoundDecision(
        action=RoundDecisionAction.CONTINUE,
        transition=Transition.NEXT_TURN,
        reason=budget_evaluation.reason if budget_evaluation.should_warn else "next_turn",
        hint_to_model=budget_evaluation.hint if budget_evaluation.should_warn else "",
        budget_evaluation=budget_evaluation if budget_evaluation.should_warn else None,
    )


def _snapshot_completion_gate(state: LoopState, messages: list[BaseMessage]) -> dict[str, Any]:
    incomplete_todos = _get_incomplete_todos(messages)
    return {
        "pendingWriteFollowUp": state.pending_write_follow_up,
        "requiresContentVerification": state.requires_content_verification,
        "requiresTodoCheck": state.requires_todo_check,
        "incompleteTodoCount": len(incomplete_todos),
        "lastMutationTools": list(state.last_mutation_tools),
        "forcedFollowUpAttempts": state.forced_follow_up_attempts,
        "stagnantBudgetRounds": state.stagnant_budget_rounds,
        "budgetStagnationWarningLevel": state.budget_stagnation_warning_level,
        "outputContinuationAttempts": state.output_continuation_attempts,
    }


def _record_trace_event(session: "ReactSession", event_type: str, **data: Any) -> None:
    session.trace.events.append({
        "type": event_type,
        "at": _now_iso(),
        **data,
    })


def _record_round_checkpoint(
    session: "ReactSession",
    *,
    round_number: int,
    kind: str,
    assistant_preview: str,
    transition: Transition,
    tool_calls: list[str] | None = None,
    plan_id: str | None = None,
    execution_count: int = 0,
    tool_results: list[dict[str, Any]] | None = None,
    reason: str | None = None,
    model_finish_reason: str | None = None,
) -> None:
    session.trace.checkpoints.append({
        "round": round_number,
        "kind": kind,
        "assistantPreview": assistant_preview,
        "toolCalls": tool_calls or [],
        "planId": plan_id,
        "executionCount": execution_count,
        "toolResults": tool_results or [],
        "transition": transition.value,
        "reason": reason,
        "modelFinishReason": model_finish_reason or session.state.last_model_finish_reason,
        "estimatedTokens": session.state.estimated_tokens,
        "compressionTier": session.state.compression_tier,
        "remainingRounds": max(MAX_REACT_ROUNDS - session.state.round, 0),
        "roundBudgetWarningLevel": session.state.round_budget_warning_level,
        "lastTokenBudgetWarningTier": session.state.last_token_budget_warning_tier,
        "stagnantBudgetRounds": session.state.stagnant_budget_rounds,
        "budgetStagnationWarningLevel": session.state.budget_stagnation_warning_level,
        "outputContinuationAttempts": session.state.output_continuation_attempts,
        "completionGate": _snapshot_completion_gate(session.state, session.messages),
        "at": _now_iso(),
    })


def _ensure_tool_call_id(raw_id: Any, round_number: int, index: int) -> str:
    text = str(raw_id or "").strip()
    if text:
        return text
    return f"call_r{round_number}_{index}_{uuid.uuid4().hex[:8]}"


def _stable_stringify(value: Any) -> str:
    if isinstance(value, list):
        return "[" + ",".join(_stable_stringify(item) for item in value) + "]"
    if isinstance(value, dict):
        items = sorted(value.items(), key=lambda item: str(item[0]))
        return "{" + ",".join(
            f"{json.dumps(str(key), ensure_ascii=False)}:{_stable_stringify(item)}"
            for key, item in items
        ) + "}"
    return json.dumps(value, ensure_ascii=False, default=str)


def _normalize_paragraph_index_list(value: Any) -> list[int]:
    if not isinstance(value, list):
        return []
    indexes: set[int] = set()
    for item in value:
        try:
            index = int(item)
        except Exception:
            continue
        if index >= 0:
            indexes.add(index)
    return sorted(indexes)


def _extract_paragraph_indexes_for_merge(range_value: Any) -> list[int] | None:
    if not isinstance(range_value, dict):
        return None
    range_type = str(range_value.get("type", ""))
    if range_type == "paragraph":
        paragraph_index = range_value.get("paragraphIndex")
        try:
            value = int(paragraph_index)
        except Exception:
            return None
        return [value] if value >= 0 else None
    if range_type == "paragraphs":
        try:
            start = int(range_value.get("from"))
            end = int(range_value.get("to"))
        except Exception:
            return None
        if start < 0 or end < start:
            return None
        return list(range(start, end + 1))
    if range_type == "paragraph_indexes":
        indexes = _normalize_paragraph_index_list(range_value.get("paragraphIndexes"))
        return indexes or None
    return None


def _build_range_from_paragraph_indexes(indexes: list[int]) -> dict[str, Any] | None:
    normalized = sorted({index for index in indexes if index >= 0})
    if not normalized:
        return None
    if len(normalized) == 1:
        return {"type": "paragraph", "paragraphIndex": normalized[0]}
    contiguous = all(
        index == normalized[position - 1] + 1
        for position, index in enumerate(normalized[1:], start=1)
    )
    if contiguous:
        return {"type": "paragraphs", "from": normalized[0], "to": normalized[-1]}
    return {"type": "paragraph_indexes", "paragraphIndexes": normalized}


def _get_mergeable_tool_attrs(params: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in params.items()
        if key != "range"
    }


def _extract_delete_paragraph_indexes(params: dict[str, Any]) -> list[int] | None:
    indexes = _normalize_paragraph_index_list(params.get("indices"))
    if indexes:
        return indexes
    try:
        index = int(params.get("index"))
    except Exception:
        return None
    return [index] if index >= 0 else None


def _build_execution_plan(round_number: int, tool_calls: list[dict[str, Any]]) -> ToolExecutionPlan:
    executions: list[PlannedToolExecution] = []
    mergeable_style_tools = {"set_text_style", "set_paragraph_style", "clear_formatting"}
    index = 0

    while index < len(tool_calls):
        current = tool_calls[index]
        current_name = str(current.get("name", ""))
        current_params = dict(current.get("params", {}) or {})
        current_source = SourceToolCall(
            id=str(current.get("id", "")),
            name=current_name,
            params=current_params,
        )

        if current_name in mergeable_style_tools:
            current_indexes = _extract_paragraph_indexes_for_merge(current_params.get("range"))
            current_attrs = _get_mergeable_tool_attrs(current_params)
            if current_indexes:
                source_calls = [current_source]
                merged_indexes = list(current_indexes)
                next_index = index + 1

                while next_index < len(tool_calls):
                    nxt = tool_calls[next_index]
                    next_name = str(nxt.get("name", ""))
                    next_params = dict(nxt.get("params", {}) or {})
                    next_indexes = _extract_paragraph_indexes_for_merge(next_params.get("range"))
                    if (
                        next_name != current_name
                        or not next_indexes
                        or _stable_stringify(_get_mergeable_tool_attrs(next_params)) != _stable_stringify(current_attrs)
                    ):
                        break

                    source_calls.append(SourceToolCall(
                        id=str(nxt.get("id", "")),
                        name=next_name,
                        params=next_params,
                    ))
                    merged_indexes.extend(next_indexes)
                    next_index += 1

                merged_range = _build_range_from_paragraph_indexes(merged_indexes)
                merged_params = {**current_attrs, "range": merged_range} if merged_range else current_params
                executions.append(PlannedToolExecution(
                    execution_id=f"exec_{uuid.uuid4().hex[:10]}",
                    tool_name=current_name,
                    params=merged_params,
                    source_calls=source_calls,
                    merge_strategy="style_batch" if len(source_calls) > 1 else "single",
                ))
                index = next_index
                continue

        if current_name == "delete_paragraph":
            current_indexes = _extract_delete_paragraph_indexes(current_params)
            if current_indexes:
                source_calls = [current_source]
                merged_indexes = list(current_indexes)
                next_index = index + 1

                while next_index < len(tool_calls):
                    nxt = tool_calls[next_index]
                    next_name = str(nxt.get("name", ""))
                    next_params = dict(nxt.get("params", {}) or {})
                    next_indexes = _extract_delete_paragraph_indexes(next_params)
                    if next_name != current_name or not next_indexes:
                        break
                    source_calls.append(SourceToolCall(
                        id=str(nxt.get("id", "")),
                        name=next_name,
                        params=next_params,
                    ))
                    merged_indexes.extend(next_indexes)
                    next_index += 1

                normalized_indexes = sorted(set(merged_indexes), reverse=True)
                merged_params = (
                    {"index": normalized_indexes[0]}
                    if len(normalized_indexes) == 1
                    else {"indices": normalized_indexes}
                )
                executions.append(PlannedToolExecution(
                    execution_id=f"exec_{uuid.uuid4().hex[:10]}",
                    tool_name=current_name,
                    params=merged_params,
                    source_calls=source_calls,
                    merge_strategy="delete_batch" if len(source_calls) > 1 else "single",
                ))
                index = next_index
                continue

        executions.append(PlannedToolExecution(
            execution_id=f"exec_{uuid.uuid4().hex[:10]}",
            tool_name=current_name,
            params=current_params,
            source_calls=[current_source],
        ))
        index += 1

    return ToolExecutionPlan(
        plan_id=f"plan_{uuid.uuid4().hex[:10]}",
        round=round_number,
        executions=executions,
    )


def _serialize_execution_plan(plan: ToolExecutionPlan) -> dict[str, Any]:
    return {
        "type": "tool_plan",
        "planId": plan.plan_id,
        "round": plan.round,
        "executions": [
            {
                "executionId": execution.execution_id,
                "toolName": execution.tool_name,
                "params": execution.params,
                "sourceToolCallIds": [source.id for source in execution.source_calls],
                "mergeStrategy": execution.merge_strategy,
                "continueOnError": execution.continue_on_error,
            }
            for execution in plan.executions
        ],
    }


def _decorate_tool_result_content(
    content: str,
    execution: PlannedToolExecution,
    source_call: SourceToolCall,
) -> str:
    payload = _parse_tool_result_payload(content)
    decorated = dict(payload) if payload else {
        "success": True,
        "message": _stringify_content(content),
    }
    decorated["toolName"] = source_call.name
    decorated["executionId"] = execution.execution_id
    decorated["mergeStrategy"] = execution.merge_strategy
    decorated["sourceToolCallId"] = source_call.id
    decorated["sourceToolCallIds"] = [item.id for item in execution.source_calls]
    decorated["sourceToolName"] = source_call.name
    decorated["executedParams"] = execution.params
    decorated["originalParams"] = source_call.params
    return json.dumps(decorated, ensure_ascii=False)


# ─── Multi-tier Compression ────────────────────────────────────────────────────


class ReactSession:
    """Manages a single ReAct loop session with state-machine-driven control."""

    __slots__ = (
        "session_id", "body", "messages", "tool_result_queue",
        "state", "finished", "expected_plan", "trace",
    )

    def __init__(self, session_id: str, body: ChatRequest, messages: list[BaseMessage]):
        self.session_id = session_id
        self.body = body
        self.messages = messages
        self.tool_result_queue: asyncio.Queue[PostedToolResults | None] = asyncio.Queue()
        self.state = LoopState()
        self.finished = False
        self.expected_plan: ToolExecutionPlan | None = None
        self.trace = SessionTrace(
            session_id=session_id,
            conversation_id=body.conversationId,
            mode=body.mode,
            model=body.model,
            provider_id=body.providerId,
            created_at=_now_iso(),
        )


_active_sessions: dict[str, ReactSession] = {}
_completed_react_traces: dict[str, dict[str, Any]] = {}
_conversation_react_trace_index: dict[str, list[str]] = {}
MAX_COMPLETED_REACT_TRACES = 50


def create_react_session(body: ChatRequest) -> ReactSession:
    session_id = uuid.uuid4().hex[:12]
    messages = build_messages(body)
    session = ReactSession(session_id, body, messages)
    _active_sessions[session_id] = session
    return session


def get_react_session(session_id: str) -> ReactSession | None:
    return _active_sessions.get(session_id)


def _remove_session(session_id: str) -> None:
    _active_sessions.pop(session_id, None)


def _serialize_trace(session: ReactSession) -> dict[str, Any]:
    return {
        "sessionId": session.trace.session_id,
        "conversationId": session.trace.conversation_id,
        "mode": session.trace.mode,
        "model": session.trace.model,
        "providerId": session.trace.provider_id,
        "createdAt": session.trace.created_at,
        "events": list(session.trace.events),
        "checkpoints": list(session.trace.checkpoints),
        "finalState": dict(session.trace.final_state),
    }


def _evict_completed_trace(session_id: str, trace: dict[str, Any]) -> None:
    _completed_react_traces.pop(session_id, None)
    conversation_id = trace.get("conversationId")
    if isinstance(conversation_id, str) and conversation_id in _conversation_react_trace_index:
        _conversation_react_trace_index[conversation_id] = [
            trace_id
            for trace_id in _conversation_react_trace_index[conversation_id]
            if trace_id != session_id
        ]
        if not _conversation_react_trace_index[conversation_id]:
            _conversation_react_trace_index.pop(conversation_id, None)


def _store_completed_trace(session: ReactSession) -> None:
    trace = _serialize_trace(session)
    _completed_react_traces[session.session_id] = trace
    conversation_id = session.trace.conversation_id
    if conversation_id:
        trace_ids = _conversation_react_trace_index.setdefault(conversation_id, [])
        if session.session_id not in trace_ids:
            trace_ids.append(session.session_id)

    while len(_completed_react_traces) > MAX_COMPLETED_REACT_TRACES:
        oldest_session_id = next(iter(_completed_react_traces.keys()))
        oldest_trace = _completed_react_traces.get(oldest_session_id)
        if oldest_trace is None:
            break
        _evict_completed_trace(oldest_session_id, oldest_trace)


def get_react_session_trace(session_id: str) -> dict[str, Any] | None:
    active = _active_sessions.get(session_id)
    if active:
        return _serialize_trace(active)
    return _completed_react_traces.get(session_id)


def list_conversation_react_traces(conversation_id: str) -> list[dict[str, Any]]:
    traces: list[dict[str, Any]] = []
    seen_session_ids: set[str] = set()

    for session in _active_sessions.values():
        if session.trace.conversation_id != conversation_id:
            continue
        seen_session_ids.add(session.session_id)
        traces.append(_serialize_trace(session))

    for session_id in _conversation_react_trace_index.get(conversation_id, []):
        if session_id in seen_session_ids:
            continue
        trace = _completed_react_traces.get(session_id)
        if trace:
            traces.append(trace)

    traces.sort(key=lambda item: str(item.get("createdAt", "")))
    return traces


def submit_react_tool_results(session: ReactSession, body: ToolResultsRequest) -> None:
    if body.stop:
        _record_trace_event(session, "client_stop_requested")
        session.tool_result_queue.put_nowait(None)
        return

    expected_plan = session.expected_plan
    if expected_plan is None:
        raise HTTPException(status_code=409, detail="当前 session 不在等待工具结果")

    if body.plan_id and body.plan_id != expected_plan.plan_id:
        raise HTTPException(status_code=409, detail="tool result planId 与当前执行计划不匹配")
    if body.round is not None and body.round != expected_plan.round:
        raise HTTPException(status_code=409, detail="tool result round 与当前轮次不匹配")

    if not body.results:
        raise HTTPException(status_code=400, detail="results 不能为空")

    valid_execution_ids = {execution.execution_id for execution in expected_plan.executions}
    seen_execution_ids: set[str] = set()
    posted_results: list[PostedToolResult] = []

    for item in body.results:
        execution_id = str(item.execution_id or item.tool_call_id or "").strip()
        if not execution_id:
            raise HTTPException(status_code=400, detail="每条 tool result 都必须包含 execution_id")
        if execution_id not in valid_execution_ids:
            raise HTTPException(status_code=409, detail=f"未知 execution_id: {execution_id}")
        if execution_id in seen_execution_ids:
            raise HTTPException(status_code=409, detail=f"重复的 execution_id: {execution_id}")
        seen_execution_ids.add(execution_id)
        posted_results.append(PostedToolResult(
            execution_id=execution_id,
            content=item.content,
        ))

    missing_execution_ids = valid_execution_ids - seen_execution_ids
    if missing_execution_ids:
        missing_text = ", ".join(sorted(missing_execution_ids))
        raise HTTPException(status_code=409, detail=f"缺少 execution result: {missing_text}")

    session.tool_result_queue.put_nowait(PostedToolResults(
        plan_id=body.plan_id,
        round=body.round,
        results=posted_results,
        stop=False,
    ))
    _record_trace_event(
        session,
        "tool_results_posted",
        planId=body.plan_id,
        round=body.round,
        executionCount=len(posted_results),
    )


def _compress_tool_content(content: str, max_len: int = 200) -> str:
    """Compress a tool result content string, keeping key status info."""
    try:
        data = json.loads(content)
        compressed: dict[str, Any] = {
            "success": data.get("success"),
            "message": str(data.get("message", ""))[:120],
            "toolName": data.get("toolName", ""),
        }
        return json.dumps(compressed, ensure_ascii=False)
    except Exception:
        return content[:max_len] + "..." if len(content) > max_len else content


@dataclass(frozen=True)
class CompressionOutcome:
    messages: list[BaseMessage]
    source: str = "none"
    summarized_rounds: list[int] = field(default_factory=list)


def _latest_round_checkpoints(checkpoints: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    if not checkpoints:
        return []
    latest_by_round: dict[int, dict[str, Any]] = {}
    for checkpoint in checkpoints:
        try:
            round_number = int(checkpoint.get("round"))
        except Exception:
            continue
        latest_by_round[round_number] = checkpoint
    return [latest_by_round[round_number] for round_number in sorted(latest_by_round)]


def _build_message_round_summary(
    messages: list[BaseMessage],
    collapse_ranges: list[tuple[int, int]],
    *,
    compact: bool,
) -> tuple[str, list[int]]:
    summary_parts: list[str] = []
    summarized_rounds: list[int] = []
    for round_index, (start, end) in enumerate(collapse_ranges, start=1):
        ai_msg = messages[start]
        if not isinstance(ai_msg, AIMessage):
            continue
        summarized_rounds.append(round_index)
        tool_names = [tc.get("name", "?") for tc in ai_msg.tool_calls]
        ok = fail = 0
        for idx in range(start + 1, end + 1):
            tm = messages[idx]
            if isinstance(tm, ToolMessage):
                try:
                    payload = json.loads(tm.content)
                    if payload.get("success"):
                        ok += 1
                    else:
                        fail += 1
                except Exception:
                    ok += 1
        content_preview = _truncate_preview(ai_msg.content, 60)
        if compact:
            part = f"R{round_index}:tools={tool_names}"
            if fail:
                part += f" fail={fail}"
            summary_parts.append(part)
        else:
            summary_parts.append(
                f"[Round {round_index}] tools={tool_names} ok={ok} fail={fail}"
                + (f' text="{content_preview}"' if content_preview else "")
            )
    prefix = "[历史操作摘要] " if compact else "[历史操作摘要]\n"
    separator = "; " if compact else "\n"
    return prefix + separator.join(summary_parts), summarized_rounds


def _build_checkpoint_round_summary(
    checkpoints: list[dict[str, Any]],
    *,
    compact: bool,
) -> tuple[str, list[int]]:
    summary_parts: list[str] = []
    summarized_rounds: list[int] = []

    for checkpoint in checkpoints:
        try:
            round_number = int(checkpoint.get("round"))
        except Exception:
            continue
        summarized_rounds.append(round_number)
        tool_calls = [str(item) for item in checkpoint.get("toolCalls", []) if str(item)]
        tool_results = checkpoint.get("toolResults", [])
        success_count = sum(1 for item in tool_results if isinstance(item, dict) and item.get("success") is True)
        failure_count = sum(1 for item in tool_results if isinstance(item, dict) and item.get("success") is False)
        transition = str(checkpoint.get("transition", ""))
        reason = str(checkpoint.get("reason", "")).strip()
        assistant_preview = _truncate_preview(checkpoint.get("assistantPreview", ""), 60)
        completion_gate = checkpoint.get("completionGate") if isinstance(checkpoint.get("completionGate"), dict) else {}
        todo_count = int(completion_gate.get("incompleteTodoCount", 0) or 0)

        if compact:
            part = f"R{round_number}:"
            part += ",".join(tool_calls) if tool_calls else str(checkpoint.get("kind", "text"))
            if transition:
                part += f"->{transition}"
            if failure_count:
                part += f" fail={failure_count}"
            if todo_count:
                part += f" todo={todo_count}"
            summary_parts.append(part)
            continue

        part = f"[Round {round_number}] kind={checkpoint.get('kind', 'unknown')}"
        if tool_calls:
            part += f" tools={tool_calls}"
        if success_count or failure_count:
            part += f" ok={success_count} fail={failure_count}"
        if transition:
            part += f" transition={transition}"
        if reason:
            part += f" reason={reason}"
        if todo_count:
            part += f" incompleteTodo={todo_count}"
        if assistant_preview:
            part += f' text="{assistant_preview}"'
        summary_parts.append(part)

    prefix = "[历史操作摘要] " if compact else "[历史操作摘要]\n"
    separator = "; " if compact else "\n"
    return prefix + separator.join(summary_parts), summarized_rounds


def _identify_rounds(messages: list[BaseMessage]) -> list[tuple[int, int]]:
    """Identify round boundaries: (ai_index, last_tool_index) pairs."""
    rounds: list[tuple[int, int]] = []
    i = 0
    while i < len(messages):
        msg = messages[i]
        if isinstance(msg, AIMessage) and msg.tool_calls:
            start = i
            j = i + 1
            while j < len(messages) and isinstance(messages[j], ToolMessage):
                j += 1
            rounds.append((start, j - 1))
            i = j
        else:
            i += 1
    return rounds


def _compress_tier1(messages: list[BaseMessage], keep_full: int = KEEP_FULL_ROUNDS) -> list[BaseMessage]:
    """Tier-1: Compress old ToolMessage content to status summaries."""
    rounds = _identify_rounds(messages)
    if len(rounds) <= keep_full:
        return messages

    compress_set: set[int] = set()
    for start, end in rounds[:-keep_full]:
        for idx in range(start, end + 1):
            if isinstance(messages[idx], ToolMessage):
                compress_set.add(idx)

    result: list[BaseMessage] = []
    for idx, msg in enumerate(messages):
        if idx in compress_set and isinstance(msg, ToolMessage):
            result.append(ToolMessage(
                content=_compress_tool_content(msg.content),
                tool_call_id=msg.tool_call_id,
            ))
        else:
            result.append(msg)
    return result


def _compress_tier2(
    messages: list[BaseMessage],
    checkpoints: list[dict[str, Any]] | None = None,
    keep_full: int = 2,
) -> CompressionOutcome:
    """Tier-2: Collapse entire old rounds into a single summary AIMessage.

    Old rounds (AI+ToolMessages) are replaced with a compact summary,
    keeping only the last *keep_full* rounds intact.
    """
    rounds = _identify_rounds(messages)
    if len(rounds) <= keep_full:
        return CompressionOutcome(_compress_tier1(messages, keep_full), source="tier1_fallback")

    # Indices of messages that belong to old rounds
    collapse_ranges: list[tuple[int, int]] = []
    for start, end in rounds[:-keep_full]:
        collapse_ranges.append((start, end))

    if not collapse_ranges:
        return CompressionOutcome(_compress_tier1(messages, keep_full), source="tier1_fallback")

    checkpoint_rounds = _latest_round_checkpoints(checkpoints)
    summarized_rounds: list[int] = []
    summary_text = ""
    summary_source = "messages"
    if checkpoint_rounds:
        keep_round_numbers = {int(item.get("round")) for item in checkpoint_rounds[-keep_full:]}
        collapsed_checkpoints = [
            checkpoint
            for checkpoint in checkpoint_rounds
            if int(checkpoint.get("round", 0) or 0) not in keep_round_numbers
        ]
        if collapsed_checkpoints:
            summary_text, summarized_rounds = _build_checkpoint_round_summary(collapsed_checkpoints, compact=False)
            summary_source = "checkpoints"

    if not summary_text:
        summary_text, summarized_rounds = _build_message_round_summary(messages, collapse_ranges, compact=False)
        summary_source = "messages"

    # Collect indices to remove
    remove_set: set[int] = set()
    for start, end in collapse_ranges:
        for idx in range(start, end + 1):
            remove_set.add(idx)

    result: list[BaseMessage] = []
    summary_inserted = False
    for idx, msg in enumerate(messages):
        if idx in remove_set:
            if not summary_inserted:
                # Insert summary as a single AIMessage right before the kept rounds
                result.append(AIMessage(content=summary_text))
                summary_inserted = True
            continue
        result.append(msg)
    return CompressionOutcome(result, source=summary_source, summarized_rounds=summarized_rounds)


def _compress_tier3(
    messages: list[BaseMessage],
    checkpoints: list[dict[str, Any]] | None = None,
    keep_full: int = 1,
) -> CompressionOutcome:
    """Tier-3: Aggressive truncation — keep system prompt + summary + last round."""
    rounds = _identify_rounds(messages)
    if len(rounds) <= keep_full:
        return _compress_tier2(messages, checkpoints=checkpoints, keep_full=keep_full)

    # Always keep system message(s) and last user message
    system_msgs = [m for m in messages if isinstance(m, SystemMessage)]
    # Find the last HumanMessage
    last_human_idx = -1
    for i in range(len(messages) - 1, -1, -1):
        if isinstance(messages[i], HumanMessage):
            last_human_idx = i
            break

    # Keep messages from the last N rounds onwards
    if rounds:
        keep_from = rounds[-keep_full][0] if len(rounds) >= keep_full else rounds[0][0]
    else:
        keep_from = len(messages)

    collapsed_ranges = list(rounds[:-keep_full] if len(rounds) > keep_full else [])
    summary_text = ""
    summary_source = "messages"
    summarized_rounds: list[int] = []
    checkpoint_rounds = _latest_round_checkpoints(checkpoints)
    if checkpoint_rounds:
        keep_round_numbers = {int(item.get("round")) for item in checkpoint_rounds[-keep_full:]}
        collapsed_checkpoints = [
            checkpoint
            for checkpoint in checkpoint_rounds
            if int(checkpoint.get("round", 0) or 0) not in keep_round_numbers
        ]
        if collapsed_checkpoints:
            summary_text, summarized_rounds = _build_checkpoint_round_summary(collapsed_checkpoints, compact=True)
            summary_source = "checkpoints"

    if not summary_text and collapsed_ranges:
        summary_text, summarized_rounds = _build_message_round_summary(messages, collapsed_ranges, compact=True)
        summary_source = "messages"

    result: list[BaseMessage] = list(system_msgs)
    # Insert the last human message if it precedes the kept rounds
    if last_human_idx >= 0 and last_human_idx < keep_from:
        result.append(messages[last_human_idx])
    if summary_text:
        result.append(AIMessage(content=summary_text))
    # Append the kept tail
    for idx in range(keep_from, len(messages)):
        msg = messages[idx]
        if isinstance(msg, SystemMessage):
            continue  # already included
        if idx == last_human_idx and last_human_idx < keep_from:
            continue  # already included
        result.append(msg)
    return CompressionOutcome(result, source=summary_source, summarized_rounds=summarized_rounds)


def compress_messages(
    messages: list[BaseMessage],
    tier: int = 0,
    checkpoints: list[dict[str, Any]] | None = None,
) -> CompressionOutcome:
    """Apply progressive compression to conversation messages.

    tier 0 = no compression, tier 1 = tool content, tier 2 = round summary, tier 3 = aggressive.
    """
    if tier <= 0:
        return CompressionOutcome(messages, source="none")
    if tier == 1:
        return CompressionOutcome(_compress_tier1(messages), source="tool_content")
    if tier == 2:
        return _compress_tier2(messages, checkpoints=checkpoints)
    return _compress_tier3(messages, checkpoints=checkpoints)


def _determine_compression_tier(messages: list[BaseMessage], current_tier: int) -> int:
    """Decide the appropriate compression tier based on token estimates."""
    tokens = _estimate_messages_tokens(messages)
    if tokens >= TOKEN_BUDGET_CRITICAL:
        return max(current_tier, 3)
    if tokens >= TOKEN_BUDGET_HARD:
        return max(current_tier, 2)
    if tokens >= TOKEN_BUDGET_SOFT:
        return max(current_tier, 1)
    return current_tier


def build_messages(body: ChatRequest) -> list[BaseMessage]:
    messages: list[BaseMessage] = [SystemMessage(content=get_system_prompt(body.mode))]
    context_block = _build_context_block(body.context)

    if body.reactMessages:
        last_user_idx = -1
        if context_block:
            for i in range(len(body.reactMessages) - 1, -1, -1):
                if dict(body.reactMessages[i]).get("role") == "user":
                    last_user_idx = i
                    break

        for i, item in enumerate(body.reactMessages):
            if i == last_user_idx:
                raw = dict(item)
                original = _stringify_content(raw.get("content"))
                messages.append(HumanMessage(content=_build_human_content(original, context_block, body.images)))
            else:
                messages.append(_to_langchain_message(item))
        _log_final_user_message(body, messages)
        return messages

    for item in body.history[-10:]:
        messages.append(_to_langchain_message(item))

    messages.append(HumanMessage(content=_build_human_content(body.message, context_block, body.images)))
    _log_final_user_message(body, messages)
    return messages


def build_llm(streaming: bool, body: ChatRequest) -> Runnable:
    cfg = read_config()
    provider = get_provider(cfg, body.providerId)
    api_key = str(provider.get("apiKey", "") or "")
    endpoint = str(provider.get("endpoint", "https://api.siliconflow.cn/v1")).rstrip("/")
    model = str(body.model or provider.get("defaultModel") or "Qwen/Qwen2.5-72B-Instruct")

    return ChatOpenAI(
        model=model,
        api_key=api_key or "not-needed",
        base_url=endpoint,
        temperature=0.3,
        streaming=streaming,
    ).bind_tools(get_tools(body.mode))


def build_graph(llm) -> Any:
    graph = StateGraph(AgentState)
    assistant = (
        RunnableLambda(lambda state: state["messages"]).with_config(run_name="select_messages")
        | llm.with_config(run_name="chat_model")
        | RunnableLambda(lambda response: {"response": response}).with_config(run_name="store_response")
    )
    graph.add_node("assistant", assistant)
    graph.add_edge(START, "assistant")
    graph.add_edge("assistant", END)
    return graph.compile()


async def run_chat(body: ChatRequest) -> dict[str, Any]:
    try:
        llm = build_llm(streaming=False, body=body)
        graph = build_graph(llm)
        result = await graph.ainvoke({"messages": build_messages(body)})
        response: AIMessage = result["response"]
        reply = _stringify_content(response.content)
        tool_calls = _tool_calls_from_ai_message(response)

        if tool_calls and not reply:
            reply = f"好的，我来帮你执行：{', '.join(call['name'] for call in tool_calls)}"

        cfg = read_config()
        provider = get_provider(cfg, body.providerId)
        return {
            "reply": reply,
            "toolCalls": tool_calls,
            "model": body.model or provider.get("defaultModel", ""),
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"AI API 请求失败: {exc}") from exc


async def stream_react_round(body: ChatRequest) -> AsyncGenerator[dict[str, Any], None]:
    llm = build_llm(streaming=True, body=body)
    graph = build_graph(llm)
    tool_call_acc: dict[int, dict[str, Any]] = {}
    range_required_tools = {"set_text_style", "set_paragraph_style", "clear_formatting"}

    try:
        async for event in graph.astream_events({"messages": build_messages(body)}, version="v2"):
            if event.get("event") != "on_chat_model_stream":
                continue

            chunk = event.get("data", {}).get("chunk")
            if not isinstance(chunk, AIMessageChunk):
                continue

            reasoning = _extract_reasoning(chunk)
            if reasoning:
                yield {"type": "thinking", "content": reasoning}

            content = _stringify_content(chunk.content)
            if content:
                yield {"type": "content", "content": content}

            for tc in chunk.tool_call_chunks or []:
                index = tc.get("index") or 0
                entry = tool_call_acc.setdefault(index, {"id": "", "name": "", "args_str": ""})
                if tc.get("id"):
                    entry["id"] = tc["id"]
                if tc.get("name"):
                    entry["name"] = tc["name"]
                if tc.get("args"):
                    entry["args_str"] += tc["args"]

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"AI API 请求失败: {exc}") from exc

    if tool_call_acc:
        for index in sorted(tool_call_acc.keys()):
            item = tool_call_acc[index]
            raw_args = item["args_str"]
            try:
                params = json.loads(raw_args) if raw_args else {}
            except Exception as exc:
                repaired_args = _repair_tool_args_json(raw_args)
                if repaired_args:
                    try:
                        params = json.loads(repaired_args)
                        logger.warning(
                            "[openwps.ai] tool args repaired conversationId=%s mode=%s index=%s tool=%s id=%s raw_args=%r repaired_args=%r",
                            body.conversationId or "-",
                            body.mode,
                            index,
                            item["name"] or "-",
                            item["id"] or "-",
                            raw_args,
                            repaired_args,
                        )
                    except Exception:
                        logger.warning(
                            "[openwps.ai] tool args parse failed conversationId=%s mode=%s index=%s tool=%s id=%s raw_args=%r repaired_args=%r error=%s",
                            body.conversationId or "-",
                            body.mode,
                            index,
                            item["name"] or "-",
                            item["id"] or "-",
                            raw_args,
                            repaired_args,
                            exc,
                        )
                        params = {}
                else:
                    logger.warning(
                        "[openwps.ai] tool args parse failed conversationId=%s mode=%s index=%s tool=%s id=%s raw_args=%r error=%s",
                        body.conversationId or "-",
                        body.mode,
                        index,
                        item["name"] or "-",
                        item["id"] or "-",
                        raw_args,
                        exc,
                    )
                    params = {}

            if item["name"] in range_required_tools and not params:
                logger.warning(
                    "[openwps.ai] suspicious empty tool args conversationId=%s mode=%s index=%s tool=%s id=%s raw_args=%r",
                    body.conversationId or "-",
                    body.mode,
                    index,
                    item["name"] or "-",
                    item["id"] or "-",
                    raw_args,
                )
            yield {
                "type": "tool_call",
                "id": item["id"],
                "name": item["name"],
                "params": params,
            }


async def _run_llm_round(
    graph: Any,
    messages: list[BaseMessage],
    body: ChatRequest,
    round_number: int,
) -> AsyncGenerator[dict[str, Any], None]:
    """Run one LLM call through the graph, yielding SSE-compatible events.

    Returns accumulated content and parsed tool calls via the final
    ``_round_result`` pseudo-event (not forwarded to the client).
    """
    tool_call_acc: dict[int, dict[str, Any]] = {}
    assistant_content = ""
    finish_reason = ""

    try:
        async for event in graph.astream_events({"messages": messages}, version="v2"):
            event_name = event.get("event")
            if event_name == "on_chat_model_end":
                extracted_finish_reason = _extract_finish_reason(event.get("data", {}).get("output"))
                if extracted_finish_reason:
                    finish_reason = extracted_finish_reason
                continue

            if event_name != "on_chat_model_stream":
                continue
            chunk = event.get("data", {}).get("chunk")
            if not isinstance(chunk, AIMessageChunk):
                continue

            extracted_finish_reason = _extract_finish_reason(chunk)
            if extracted_finish_reason:
                finish_reason = extracted_finish_reason

            reasoning = _extract_reasoning(chunk)
            if reasoning:
                yield {"type": "thinking", "content": reasoning}

            content = _stringify_content(chunk.content)
            if content:
                assistant_content += content
                yield {"type": "content", "content": content}

            for tc in chunk.tool_call_chunks or []:
                index = tc.get("index") or 0
                entry = tool_call_acc.setdefault(index, {"id": "", "name": "", "args_str": ""})
                if tc.get("id"):
                    entry["id"] = tc["id"]
                if tc.get("name"):
                    entry["name"] = tc["name"]
                if tc.get("args"):
                    entry["args_str"] += tc["args"]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"AI API 请求失败: {exc}") from exc

    parsed_tool_calls: list[dict[str, Any]] = []
    if tool_call_acc:
        for index in sorted(tool_call_acc.keys()):
            item = tool_call_acc[index]
            raw_args = item["args_str"]
            tool_call_id = _ensure_tool_call_id(item.get("id"), round_number, index)
            try:
                params = json.loads(raw_args) if raw_args else {}
            except Exception:
                repaired = _repair_tool_args_json(raw_args)
                try:
                    params = json.loads(repaired) if repaired else {}
                except Exception:
                    params = {}

            parsed_tool_calls.append({
                "id": tool_call_id,
                "name": item["name"],
                "params": params,
            })
            yield {
                "type": "tool_call",
                "id": tool_call_id,
                "name": item["name"],
                "params": params,
            }

    # Internal pseudo-event carrying round summary (not sent to client)
    yield {
        "type": "_round_result",
        "content": assistant_content,
        "tool_calls": parsed_tool_calls,
        "finish_reason": finish_reason,
    }


class QueryCoordinator:
    """Backend-owned ReAct coordinator, modelled after Claude Code's query loop."""

    def __init__(self, session: ReactSession):
        self.session = session
        self.state = session.state
        self.llm = build_llm(streaming=True, body=session.body)

    def _summarize_execution_results(
        self,
        plan: ToolExecutionPlan,
        posted_results: PostedToolResults,
    ) -> list[dict[str, Any]]:
        results_by_execution = {
            item.execution_id: item
            for item in posted_results.results
        }
        summary: list[dict[str, Any]] = []

        for execution in plan.executions:
            posted = results_by_execution.get(execution.execution_id)
            payload = _parse_tool_result_payload(posted.content if posted else "")
            summary.append({
                "executionId": execution.execution_id,
                "toolName": execution.tool_name,
                "success": payload.get("success") is True,
                "message": _truncate_preview(payload.get("message", ""), 120),
                "mergeStrategy": execution.merge_strategy,
                "sourceToolCallCount": len(execution.source_calls),
            })
        return summary

    def _make_recovery_event(self, action: str, **data: Any) -> dict[str, Any]:
        _record_trace_event(self.session, "recovery", round=self.state.round, action=action, **data)
        return {
            "type": "recovery",
            "action": action,
            **data,
        }

    async def _run_model_round(self, messages: list[BaseMessage]) -> AsyncGenerator[dict[str, Any], None]:
        round_content = ""
        round_tool_calls: list[dict[str, Any]] = []
        round_finish_reason = ""

        for attempt in range(MAX_RETRIES_PER_ROUND + 1):
            round_content = ""
            round_tool_calls = []
            round_finish_reason = ""
            graph = build_graph(self.llm)

            try:
                async for event in _run_llm_round(graph, messages, self.session.body, self.state.round):
                    if event["type"] == "_round_result":
                        round_content = event["content"]
                        round_tool_calls = event["tool_calls"]
                        round_finish_reason = str(event.get("finish_reason", "") or "")
                    else:
                        yield event
                self.state.consecutive_errors = 0
                yield {
                    "type": "_round_result",
                    "content": round_content,
                    "tool_calls": round_tool_calls,
                    "finish_reason": round_finish_reason,
                }
                return
            except HTTPException as exc:
                self.state.consecutive_errors += 1
                is_context_overflow = any(
                    keyword in str(exc.detail).lower()
                    for keyword in ("too long", "context_length", "maximum context", "max_tokens")
                )
                if is_context_overflow:
                    new_tier = min(self.state.compression_tier + 1, 3)
                    if new_tier > self.state.compression_tier:
                        self.state.compression_tier = new_tier
                        yield self._make_recovery_event(
                            "context_compress",
                            tier=new_tier,
                            attempt=attempt + 1,
                        )
                        continue
                if exc.status_code == 502 and attempt < MAX_RETRIES_PER_ROUND:
                    delay = RETRY_DELAYS[min(attempt, len(RETRY_DELAYS) - 1)]
                    yield self._make_recovery_event(
                        "retry",
                        attempt=attempt + 1,
                        delay=delay,
                    )
                    await asyncio.sleep(delay)
                    continue
                raise
            except Exception as exc:
                self.state.consecutive_errors += 1
                error_text = str(exc).lower()
                if (
                    any(keyword in error_text for keyword in ("too long", "context_length", "maximum context", "max_tokens"))
                    and self.state.compression_tier < 3
                ):
                    self.state.compression_tier += 1
                    yield self._make_recovery_event(
                        "context_compress",
                        tier=self.state.compression_tier,
                        attempt=attempt + 1,
                    )
                    continue
                raise

        yield {
            "type": "_round_result",
            "content": round_content,
            "tool_calls": round_tool_calls,
            "finish_reason": round_finish_reason,
        }

    def _apply_execution_results(
        self,
        plan: ToolExecutionPlan,
        posted_results: PostedToolResults,
    ) -> list[dict[str, str]]:
        results_by_execution = {
            item.execution_id: item
            for item in posted_results.results
        }
        execution_results: list[dict[str, str]] = []

        for execution in plan.executions:
            posted_result = results_by_execution[execution.execution_id]
            execution_results.append({
                "execution_id": execution.execution_id,
                "content": posted_result.content,
            })
            for source_call in execution.source_calls:
                self.session.messages.append(ToolMessage(
                    content=_decorate_tool_result_content(posted_result.content, execution, source_call),
                    tool_call_id=source_call.id,
                ))

        return execution_results

    async def stream(self) -> AsyncGenerator[dict[str, Any], None]:
        _record_trace_event(self.session, "session_created")
        yield {"type": "session_created", "sessionId": self.session.session_id}

        try:
            while self.state.round < MAX_REACT_ROUNDS and not self.session.finished:
                self.state.round += 1
                self.state.retries_this_round = 0
                _record_trace_event(self.session, "round_start", round=self.state.round)
                yield {"type": "round_start", "round": self.state.round}

                previous_tier = self.state.compression_tier
                self.state.compression_tier = _determine_compression_tier(
                    self.session.messages,
                    self.state.compression_tier,
                )
                compression_outcome = compress_messages(
                    self.session.messages,
                    tier=self.state.compression_tier,
                    checkpoints=self.session.trace.checkpoints,
                )
                compressed_messages = compression_outcome.messages
                self.state.estimated_tokens = _estimate_messages_tokens(compressed_messages)
                if self.state.compression_tier > previous_tier:
                    _record_trace_event(
                        self.session,
                        "compression",
                        round=self.state.round,
                        tier=self.state.compression_tier,
                        estimatedTokens=self.state.estimated_tokens,
                        source=compression_outcome.source,
                        summarizedRounds=compression_outcome.summarized_rounds,
                    )
                    yield {
                        "type": "compression",
                        "tier": self.state.compression_tier,
                        "estimated_tokens": self.state.estimated_tokens,
                        "source": compression_outcome.source,
                        "summarizedRounds": compression_outcome.summarized_rounds,
                    }
                self.state.consecutive_empty_content = 0

                round_content = ""
                round_tool_calls: list[dict[str, Any]] = []
                round_finish_reason = ""
                async for event in self._run_model_round(compressed_messages):
                    if event["type"] == "_round_result":
                        round_content = event["content"]
                        round_tool_calls = event["tool_calls"]
                        round_finish_reason = str(event.get("finish_reason", "") or "")
                    else:
                        yield event

                self.state.last_model_finish_reason = round_finish_reason
                if round_tool_calls or not _is_output_truncated_finish_reason(round_finish_reason):
                    self.state.output_continuation_attempts = 0

                if not round_tool_calls:
                    self.session.messages.append(AIMessage(content=round_content))
                    truncation_decision = _decide_output_truncation(self.state, round_finish_reason, round_tool_calls)
                    if truncation_decision is not None:
                        if truncation_decision.action == RoundDecisionAction.ERROR:
                            self.session.finished = True
                            self.state.transition = truncation_decision.transition
                            _record_round_checkpoint(
                                self.session,
                                round_number=self.state.round,
                                kind="text_round",
                                assistant_preview=_truncate_preview(round_content),
                                transition=self.state.transition,
                                reason=truncation_decision.reason,
                                model_finish_reason=round_finish_reason,
                            )
                            _record_trace_event(
                                self.session,
                                "error",
                                round=self.state.round,
                                message=truncation_decision.error_message,
                            )
                            yield {
                                "type": "error",
                                "message": truncation_decision.error_message,
                            }
                            break

                        self.state.output_continuation_attempts += 1
                        self.session.messages.append(HumanMessage(content=truncation_decision.hint_to_model))
                        self.state.transition = truncation_decision.transition
                        _record_round_checkpoint(
                            self.session,
                            round_number=self.state.round,
                            kind="text_round",
                            assistant_preview=_truncate_preview(round_content),
                            transition=self.state.transition,
                            reason=truncation_decision.reason,
                            model_finish_reason=round_finish_reason,
                        )
                        yield self._make_recovery_event(
                            "output_continue",
                            finishReason=round_finish_reason,
                            attempt=self.state.output_continuation_attempts,
                            limit=MAX_OUTPUT_CONTINUATIONS,
                            message=truncation_decision.client_message,
                        )
                        continue

                    round_decision = _decide_text_round(self.state, self.session.messages)
                    if round_decision.action == RoundDecisionAction.CONTINUE:
                        self.state.consecutive_empty_content += 1
                        if round_decision.budget_evaluation:
                            _mark_budget_warning_emitted(self.state, round_decision.budget_evaluation)
                            _record_trace_event(
                                self.session,
                                "budget_warning",
                                round=self.state.round,
                                reason=round_decision.budget_evaluation.reason,
                                remainingRounds=round_decision.budget_evaluation.remaining_rounds,
                                estimatedTokens=round_decision.budget_evaluation.estimated_tokens,
                            )
                            yield {
                                "type": "budget_warning",
                                "reason": round_decision.budget_evaluation.reason,
                                "message": round_decision.budget_evaluation.hint,
                                "remainingRounds": round_decision.budget_evaluation.remaining_rounds,
                                "estimatedTokens": round_decision.budget_evaluation.estimated_tokens,
                                "stagnantRounds": round_decision.budget_evaluation.stagnant_rounds,
                            }
                        self.state.pending_write_follow_up = False
                        self.state.forced_follow_up_attempts += 1
                        self.session.messages.append(HumanMessage(content=round_decision.hint_to_model))
                        self.state.transition = round_decision.transition
                        _record_round_checkpoint(
                            self.session,
                            round_number=self.state.round,
                            kind="text_round",
                            assistant_preview=_truncate_preview(round_content),
                            transition=self.state.transition,
                            reason=round_decision.reason,
                            model_finish_reason=round_finish_reason,
                        )
                        _record_trace_event(
                            self.session,
                            "round_complete",
                            round=self.state.round,
                            reason=round_decision.reason,
                            pendingTodoCount=round_decision.pending_todo_count,
                        )
                        yield {
                            "type": "round_complete",
                            "reason": round_decision.reason,
                            "message": round_decision.client_message,
                            "pendingTodoCount": round_decision.pending_todo_count,
                            "attempt": self.state.forced_follow_up_attempts,
                        }
                        continue

                    if round_decision.action == RoundDecisionAction.ERROR:
                        self.session.finished = True
                        self.state.transition = round_decision.transition
                        _record_round_checkpoint(
                            self.session,
                            round_number=self.state.round,
                            kind="text_round",
                            assistant_preview=_truncate_preview(round_content),
                            transition=self.state.transition,
                            reason=round_decision.reason,
                            model_finish_reason=round_finish_reason,
                        )
                        _record_trace_event(
                            self.session,
                            "error",
                            round=self.state.round,
                            message=round_decision.error_message,
                        )
                        yield {
                            "type": "error",
                            "message": round_decision.error_message,
                        }
                        break

                    self.session.finished = True
                    self.state.transition = round_decision.transition
                    _record_round_checkpoint(
                        self.session,
                        round_number=self.state.round,
                        kind="text_round",
                        assistant_preview=_truncate_preview(round_content),
                        transition=self.state.transition,
                        reason=round_decision.reason,
                        model_finish_reason=round_finish_reason,
                    )
                    _record_trace_event(self.session, "done", round=self.state.round, reason=round_decision.finish_reason)
                    yield {"type": "done", "reason": round_decision.finish_reason}
                    break

                self.session.messages.append(AIMessage(
                    content=round_content,
                    tool_calls=[
                        {"id": tool_call["id"], "name": tool_call["name"], "args": tool_call["params"], "type": "tool_call"}
                        for tool_call in round_tool_calls
                    ],
                ))

                execution_plan = _build_execution_plan(self.state.round, round_tool_calls)
                self.session.expected_plan = execution_plan
                _record_trace_event(
                    self.session,
                    "tool_plan",
                    round=self.state.round,
                    planId=execution_plan.plan_id,
                    executionCount=len(execution_plan.executions),
                    sourceToolCallCount=len(round_tool_calls),
                )
                yield _serialize_execution_plan(execution_plan)
                _record_trace_event(
                    self.session,
                    "awaiting_tool_results",
                    round=self.state.round,
                    planId=execution_plan.plan_id,
                    executionCount=len(execution_plan.executions),
                )
                yield {
                    "type": "awaiting_tool_results",
                    "round": execution_plan.round,
                    "planId": execution_plan.plan_id,
                    "count": len(execution_plan.executions),
                    "toolCallCount": len(round_tool_calls),
                }

                try:
                    posted_results = await asyncio.wait_for(
                        self.session.tool_result_queue.get(),
                        timeout=TOOL_RESULT_TIMEOUT,
                    )
                except asyncio.TimeoutError:
                    self.session.expected_plan = None
                    self.state.transition = Transition.TIMEOUT
                    _record_trace_event(self.session, "error", round=self.state.round, message="等待工具结果超时")
                    yield {"type": "error", "message": "等待工具结果超时"}
                    self.session.finished = True
                    break

                if posted_results is None:
                    self.session.expected_plan = None
                    self.state.transition = Transition.STOPPED_BY_CLIENT
                    self.session.finished = True
                    _record_trace_event(self.session, "done", round=self.state.round, reason="stopped_by_client")
                    yield {"type": "done", "reason": "stopped_by_client"}
                    break

                execution_results = self._apply_execution_results(execution_plan, posted_results)
                execution_summary = self._summarize_execution_results(execution_plan, posted_results)
                self.session.expected_plan = None
                _update_completion_gate_state(self.state, execution_results)
                self.state.pending_write_follow_up = _tool_results_started_streaming_write(execution_results)
                self.state.forced_follow_up_attempts = 0
                self.state.consecutive_empty_content = 0

                round_decision = _decide_tool_round(self.state, self.session.messages, round_tool_calls, execution_results)
                if round_decision.action == RoundDecisionAction.FINISH:
                    self.state.transition = round_decision.transition
                    self.session.finished = True
                    _record_round_checkpoint(
                        self.session,
                        round_number=self.state.round,
                        kind="tool_round",
                        assistant_preview=_truncate_preview(round_content),
                        transition=self.state.transition,
                        tool_calls=[tool_call["name"] for tool_call in round_tool_calls],
                        plan_id=execution_plan.plan_id,
                        execution_count=len(execution_plan.executions),
                        tool_results=execution_summary,
                        reason=round_decision.reason,
                        model_finish_reason=round_finish_reason,
                    )
                    _record_trace_event(self.session, "done", round=self.state.round, reason=round_decision.finish_reason)
                    yield {"type": "done", "reason": round_decision.finish_reason}
                    break

                if round_decision.transition == Transition.STOP_HOOK_RETRY:
                    self.session.messages.append(HumanMessage(content=round_decision.hint_to_model))
                    self.state.transition = round_decision.transition
                    _record_round_checkpoint(
                        self.session,
                        round_number=self.state.round,
                        kind="tool_round",
                        assistant_preview=_truncate_preview(round_content),
                        transition=self.state.transition,
                        tool_calls=[tool_call["name"] for tool_call in round_tool_calls],
                        plan_id=execution_plan.plan_id,
                        execution_count=len(execution_plan.executions),
                        tool_results=execution_summary,
                        reason=round_decision.reason,
                        model_finish_reason=round_finish_reason,
                    )
                    _record_trace_event(
                        self.session,
                        "stop_hook",
                        round=self.state.round,
                        reason=round_decision.reason,
                    )
                    yield {
                        "type": "stop_hook",
                        "reason": round_decision.reason,
                        "hint": round_decision.stop_hook_hint,
                    }
                    continue

                if round_decision.budget_evaluation:
                    _mark_budget_warning_emitted(self.state, round_decision.budget_evaluation)
                    self.session.messages.append(HumanMessage(content=round_decision.hint_to_model))
                    _record_trace_event(
                        self.session,
                        "budget_warning",
                        round=self.state.round,
                        reason=round_decision.budget_evaluation.reason,
                        remainingRounds=round_decision.budget_evaluation.remaining_rounds,
                        estimatedTokens=round_decision.budget_evaluation.estimated_tokens,
                    )
                    yield {
                        "type": "budget_warning",
                        "reason": round_decision.budget_evaluation.reason,
                        "message": round_decision.budget_evaluation.hint,
                        "remainingRounds": round_decision.budget_evaluation.remaining_rounds,
                        "estimatedTokens": round_decision.budget_evaluation.estimated_tokens,
                        "stagnantRounds": round_decision.budget_evaluation.stagnant_rounds,
                    }

                self.state.transition = round_decision.transition
                _record_round_checkpoint(
                    self.session,
                    round_number=self.state.round,
                    kind="tool_round",
                    assistant_preview=_truncate_preview(round_content),
                    transition=self.state.transition,
                    tool_calls=[tool_call["name"] for tool_call in round_tool_calls],
                    plan_id=execution_plan.plan_id,
                    execution_count=len(execution_plan.executions),
                    tool_results=execution_summary,
                    reason=round_decision.reason,
                    model_finish_reason=round_finish_reason,
                )
                _record_trace_event(self.session, "round_transition", round=self.state.round, transition=self.state.transition.value)

            if self.state.round >= MAX_REACT_ROUNDS and not self.session.finished:
                self.state.transition = Transition.MAX_ROUNDS
                _record_trace_event(self.session, "done", round=self.state.round, reason="max_rounds")
                yield {"type": "done", "reason": "max_rounds"}

        except HTTPException:
            raise
        except asyncio.CancelledError:
            logger.info("[openwps.ai] session %s cancelled (client disconnected)", self.session.session_id)
        except Exception as exc:
            self.state.transition = Transition.FATAL_ERROR
            logger.exception("[openwps.ai] session %s fatal error", self.session.session_id)
            _record_trace_event(self.session, "error", round=self.state.round, message=f"AI 请求失败: {exc}")
            yield {"type": "error", "message": f"AI 请求失败: {exc}"}
        finally:
            self.session.trace.final_state = {
                "transition": self.state.transition.value,
                "round": self.state.round,
                "finished": self.session.finished,
                "remainingRounds": max(MAX_REACT_ROUNDS - self.state.round, 0),
                "roundBudgetWarningLevel": self.state.round_budget_warning_level,
                "lastTokenBudgetWarningTier": self.state.last_token_budget_warning_tier,
                "stagnantBudgetRounds": self.state.stagnant_budget_rounds,
                "budgetStagnationWarningLevel": self.state.budget_stagnation_warning_level,
                "outputContinuationAttempts": self.state.output_continuation_attempts,
                "lastModelFinishReason": self.state.last_model_finish_reason,
                "completionGate": _snapshot_completion_gate(self.state, self.session.messages),
            }
            _store_completed_trace(self.session)
            self.session.expected_plan = None
            _remove_session(self.session.session_id)


async def stream_react_session(session: ReactSession) -> AsyncGenerator[dict[str, Any], None]:
    async for event in QueryCoordinator(session).stream():
        yield event


async def list_models(endpoint: str, api_key: str = "") -> list[dict[str, str]]:
    base_url = str(endpoint or "").strip().rstrip("/")
    if not base_url:
        raise HTTPException(status_code=400, detail="端点地址不能为空")

    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(f"{base_url}/models", headers=headers)
        response.raise_for_status()
        payload = response.json()
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text.strip() or str(exc)
        raise HTTPException(status_code=502, detail=f"获取模型列表失败: {detail}") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"获取模型列表失败: {exc}") from exc

    raw_models = payload.get("data", []) if isinstance(payload, dict) else []
    models: list[dict[str, str]] = []
    for item in raw_models:
        if not isinstance(item, dict):
            continue
        model_id = str(item.get("id") or "").strip()
        if not model_id:
            continue
        models.append(
            {
                "id": model_id,
                "label": str(item.get("name") or model_id),
            }
        )

    return sorted(models, key=lambda item: item["id"].lower())
