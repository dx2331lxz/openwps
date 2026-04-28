from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage

try:
    import tiktoken
except ImportError:  # pragma: no cover - dependency should be present via langchain-openai
    tiktoken = None


AUTO_COMPACT_BUFFER_TOKENS = 13_000
DEFAULT_COMPACT_SUMMARY_MAX_OUTPUT_TOKENS = 20_000
MAX_COMPACT_SUMMARY_MAX_OUTPUT_TOKENS = 20_000

GPT_CONTEXT_WINDOW_TOKENS = 128_000
CLAUDE_CONTEXT_WINDOW_TOKENS = 200_000
LOCAL_CONTEXT_WINDOW_TOKENS = 32_000
UNKNOWN_REMOTE_CONTEXT_WINDOW_TOKENS = 128_000

COMPACTABLE_READ_ONLY_TOOLS = {
    "analyze_document_image",
    "analyze_image_with_ocr",
    "capture_page_screenshot",
    "get_document_content",
    "get_page_content",
    "get_page_style_summary",
    "get_paragraph",
    "search_text",
    "web_search",
    "workspace_read",
    "workspace_search",
}

WRITE_OR_GATE_TOOLS = {
    "TaskCreate",
    "TaskList",
    "TaskUpdate",
    "begin_streaming_write",
    "complete_streaming_write",
    "insert_content",
    "replace_content",
    "update_content",
    "verify_document_content",
}

DATA_URL_RE = re.compile(r"data:(image|application|text)/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s_-]+")


@dataclass(frozen=True)
class CompactPolicy:
    provider_id: str
    model: str
    context_window_tokens: int
    compact_summary_max_output_tokens: int = DEFAULT_COMPACT_SUMMARY_MAX_OUTPUT_TOKENS
    auto_compact_buffer_tokens: int = AUTO_COMPACT_BUFFER_TOKENS

    @property
    def auto_compact_threshold_tokens(self) -> int:
        reserved = min(self.compact_summary_max_output_tokens, MAX_COMPACT_SUMMARY_MAX_OUTPUT_TOKENS)
        return max(4_000, self.context_window_tokens - reserved - self.auto_compact_buffer_tokens)


@dataclass(frozen=True)
class CompactBoundary:
    source: str
    pre_token_count: int
    policy: CompactPolicy
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_message(self) -> HumanMessage:
        payload = {
            "type": "compact_boundary",
            "mode": "snapshot",
            "source": self.source,
            "preTokenCount": self.pre_token_count,
            "contextWindowTokens": self.policy.context_window_tokens,
            "autoCompactThresholdTokens": self.policy.auto_compact_threshold_tokens,
            "createdAt": self.created_at,
            "note": "这是上下文压缩边界，用于恢复执行状态，不是用户新增内容。",
        }
        return HumanMessage(content="[系统附件] type=compact_boundary\n" + json.dumps(payload, ensure_ascii=False, sort_keys=True))


@dataclass(frozen=True)
class MicrocompactResult:
    messages: list[BaseMessage]
    changed: bool
    pre_token_count: int
    post_token_count: int
    compacted_tool_results: int = 0


@dataclass(frozen=True)
class CompactionResult:
    messages: list[BaseMessage]
    boundary: CompactBoundary
    summary_chars: int
    pre_token_count: int
    post_token_count: int
    source: str
    restored_attachment_types: list[str] = field(default_factory=list)
    preserved_tail_count: int = 0


def _encoding_for_model(model: str | None = None):
    if tiktoken is None:
        return None
    model_name = str(model or "").strip()
    if model_name:
        try:
            return tiktoken.encoding_for_model(model_name)
        except Exception:
            pass
    for encoding_name in ("o200k_base", "cl100k_base"):
        try:
            return tiktoken.get_encoding(encoding_name)
        except Exception:
            continue
    return None


def count_text_tokens(text: Any, *, model: str | None = None) -> int:
    value = _stringify_content(text)
    if not value:
        return 0
    encoding = _encoding_for_model(model)
    if encoding is not None:
        return len(encoding.encode(value, disallowed_special=()))
    return max(1, len(value.encode("utf-8")) // 4)


def count_messages_tokens(messages: list[BaseMessage], *, model: str | None = None) -> int:
    """Count request tokens with the configured tokenizer before an API call.

    API usage is only available after a request completes. Auto-compaction needs
    a preflight count, so this uses tiktoken's chat-message accounting rather
    than the previous character heuristic.
    """
    encoding = _encoding_for_model(model)
    total = 0
    for message in messages:
        total += 3
        total += count_text_tokens(message.content, model=model)
        name = getattr(message, "name", None)
        if name:
            total += 1 + count_text_tokens(name, model=model)
        if isinstance(message, AIMessage):
            for tool_call in message.tool_calls:
                tool_name = str(tool_call.get("name") or "")
                args = json.dumps(tool_call.get("args", {}), ensure_ascii=False, sort_keys=True)
                total += count_text_tokens(tool_name, model=model)
                total += count_text_tokens(args, model=model)
    if encoding is None:
        return total + 3
    return total + 3


def estimate_tokens(text: Any) -> int:
    return count_text_tokens(text)


def estimate_messages_tokens(messages: list[BaseMessage]) -> int:
    return count_messages_tokens(messages)


def build_compact_policy(provider: dict[str, Any] | None, model: str | None) -> CompactPolicy:
    provider = provider or {}
    provider_id = str(provider.get("id") or provider.get("providerId") or "").strip().lower()
    model_text = str(model or provider.get("defaultModel") or "").strip()
    window = _coerce_positive_int(provider.get("contextWindowTokens"))
    summary_max = _coerce_positive_int(provider.get("compactSummaryMaxOutputTokens"))
    if window is None:
        window = infer_context_window_tokens(provider_id, model_text, provider.get("endpoint"))
    if summary_max is None:
        summary_max = DEFAULT_COMPACT_SUMMARY_MAX_OUTPUT_TOKENS
    summary_max = min(summary_max, MAX_COMPACT_SUMMARY_MAX_OUTPUT_TOKENS)
    return CompactPolicy(
        provider_id=provider_id,
        model=model_text,
        context_window_tokens=window,
        compact_summary_max_output_tokens=summary_max,
    )


def infer_context_window_tokens(provider_id: str, model: str, endpoint: Any = "") -> int:
    haystack = " ".join([provider_id, model, str(endpoint or "")]).lower()
    if any(marker in haystack for marker in ("claude-3.5", "claude-3-5", "claude-3.7", "claude-3-7", "claude-4", "sonnet-4", "opus-4")):
        return CLAUDE_CONTEXT_WINDOW_TOKENS
    if any(marker in haystack for marker in ("gpt-4o", "gpt-4.1", "gpt-5", "o3", "o4")):
        return GPT_CONTEXT_WINDOW_TOKENS
    if any(marker in haystack for marker in ("openrouter", "qwen", "deepseek", "siliconflow")):
        return UNKNOWN_REMOTE_CONTEXT_WINDOW_TOKENS
    if any(marker in haystack for marker in ("ollama", "localhost", "127.0.0.1", "local")):
        return LOCAL_CONTEXT_WINDOW_TOKENS
    return UNKNOWN_REMOTE_CONTEXT_WINDOW_TOKENS


def should_auto_compact(messages: list[BaseMessage], policy: CompactPolicy) -> bool:
    return count_messages_tokens(messages, model=policy.model) >= policy.auto_compact_threshold_tokens


def microcompact_messages(messages: list[BaseMessage], *, keep_recent_results: int = 3, model: str | None = None) -> MicrocompactResult:
    pre_tokens = count_messages_tokens(messages, model=model)
    compactable_indices: list[int] = []
    for index, message in enumerate(messages):
        if not isinstance(message, ToolMessage):
            continue
        tool_name = _tool_name_from_message(message)
        if tool_name in WRITE_OR_GATE_TOOLS:
            continue
        if tool_name in COMPACTABLE_READ_ONLY_TOOLS:
            compactable_indices.append(index)
    keep = set(compactable_indices[-max(0, keep_recent_results):])
    compact_indices = [index for index in compactable_indices if index not in keep]
    if not compact_indices:
        return MicrocompactResult(messages, False, pre_tokens, pre_tokens, 0)

    result: list[BaseMessage] = []
    compact_set = set(compact_indices)
    for index, message in enumerate(messages):
        if index in compact_set and isinstance(message, ToolMessage):
            result.append(_compact_tool_message(message))
        else:
            result.append(message)

    post_tokens = count_messages_tokens(result, model=model)
    return MicrocompactResult(result, True, pre_tokens, post_tokens, len(compact_indices))


def build_compact_prompt(messages: list[BaseMessage], *, policy: CompactPolicy, source: str) -> list[BaseMessage]:
    stripped = strip_large_payloads_for_summary(messages)
    transcript = _messages_to_compact_transcript(stripped)
    system = SystemMessage(content=(
        "你是 openwps 的上下文压缩器。只输出压缩摘要，不要调用工具，不要向用户说话。"
        "摘要必须保留继续执行任务所需事实，删除重复和无关细节。"
    ))
    human = HumanMessage(content=(
        "[compact_request]\n"
        f"source: {source}\n"
        f"contextWindowTokens: {policy.context_window_tokens}\n"
        f"maxOutputTokens: {policy.compact_summary_max_output_tokens}\n\n"
        "请按以下结构输出中文摘要：\n"
        "1. 用户目标\n"
        "2. 已完成动作\n"
        "3. 关键工具结果\n"
        "4. 当前文档状态\n"
        "5. 仍相关的未完成事项\n"
        "6. 下一步注意点\n\n"
        "对话转录如下：\n"
        f"{transcript}"
    ))
    return [system, human]


def strip_large_payloads_for_summary(messages: list[BaseMessage]) -> list[BaseMessage]:
    stripped: list[BaseMessage] = []
    for message in messages:
        content = _strip_large_content(message.content)
        if isinstance(message, SystemMessage):
            stripped.append(SystemMessage(content=content))
        elif isinstance(message, HumanMessage):
            stripped.append(HumanMessage(content=content))
        elif isinstance(message, AIMessage):
            stripped.append(AIMessage(
                content=content,
                tool_calls=list(message.tool_calls or []),
                additional_kwargs=dict(message.additional_kwargs or {}),
            ))
        elif isinstance(message, ToolMessage):
            stripped.append(ToolMessage(content=content, tool_call_id=message.tool_call_id, name=getattr(message, "name", None)))
        else:
            stripped.append(message)
    return stripped


def drop_oldest_api_round(messages: list[BaseMessage]) -> tuple[list[BaseMessage], bool]:
    systems = [message for message in messages if isinstance(message, SystemMessage)]
    rest = [(index, message) for index, message in enumerate(messages) if not isinstance(message, SystemMessage)]
    if len(rest) <= 3:
        return messages, False

    human_positions = [pos for pos, (_, message) in enumerate(rest) if isinstance(message, HumanMessage)]
    if len(human_positions) >= 2:
        start = human_positions[0]
        end = human_positions[1]
    else:
        start = 0
        end = min(3, len(rest))
    kept_rest = [message for pos, (_, message) in enumerate(rest) if not (start <= pos < end)]
    return systems + kept_rest, len(kept_rest) < len(rest)


def build_compacted_messages(
    original_messages: list[BaseMessage],
    *,
    summary: str,
    policy: CompactPolicy,
    source: str,
    restored_attachments: list[BaseMessage] | None = None,
    tail_rounds: int = 2,
    max_tail_messages: int = 12,
) -> CompactionResult:
    pre_tokens = count_messages_tokens(original_messages, model=policy.model)
    systems = [message for message in original_messages if isinstance(message, SystemMessage)]
    boundary = CompactBoundary(source=source, pre_token_count=pre_tokens, policy=policy)
    tail = preserve_tail_messages(original_messages, tail_rounds=tail_rounds, max_messages=max_tail_messages)
    summary_message = HumanMessage(content="[系统附件] type=compact_summary\n" + summary.strip())
    restored = list(restored_attachments or [])
    messages = systems + [boundary.to_message(), summary_message] + tail + restored
    result = CompactionResult(
        messages=messages,
        boundary=boundary,
        summary_chars=len(summary),
        pre_token_count=pre_tokens,
        post_token_count=count_messages_tokens(messages, model=policy.model),
        source=source,
        restored_attachment_types=[_attachment_type(message) for message in restored],
        preserved_tail_count=len(tail),
    )
    return result


def preserve_tail_messages(messages: list[BaseMessage], *, tail_rounds: int = 2, max_messages: int = 12) -> list[BaseMessage]:
    non_system = [message for message in messages if not isinstance(message, SystemMessage)]
    if not non_system:
        return []
    groups: list[list[BaseMessage]] = []
    current: list[BaseMessage] = []
    for message in non_system:
        if isinstance(message, HumanMessage) and current:
            groups.append(current)
            current = [message]
        else:
            current.append(message)
    if current:
        groups.append(current)
    tail: list[BaseMessage] = []
    for group in groups[-max(1, tail_rounds):]:
        tail.extend(group)
    if len(tail) > max_messages:
        tail = tail[-max_messages:]
        while tail and isinstance(tail[0], ToolMessage):
            tail = tail[1:]
    return tail


def _coerce_positive_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except Exception:
        return None
    return parsed if parsed > 0 else None


def _stringify_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    try:
        return json.dumps(content, ensure_ascii=False)
    except Exception:
        return str(content)


def _strip_large_content(content: Any) -> str:
    text = _stringify_content(content)
    text = DATA_URL_RE.sub(lambda match: f"[{match.group(1)}]", text)
    text = re.sub(r'"(?:image|image_url|dataUrl|dataURL)"\s*:\s*"[^"]{200,}"', '"image":"[image]"', text)
    text = re.sub(r'"(?:document|attachment|content)"\s*:\s*"[^"]{5000,}"', '"document":"[document]"', text)
    return text


def _messages_to_compact_transcript(messages: list[BaseMessage]) -> str:
    parts: list[str] = []
    for index, message in enumerate(messages, start=1):
        role = message.__class__.__name__.replace("Message", "").lower() or "message"
        line = f"[{index}] {role}: {_stringify_content(message.content)}"
        if isinstance(message, AIMessage) and message.tool_calls:
            tool_names = [str(item.get("name") or "") for item in message.tool_calls]
            line += "\n  tool_calls=" + json.dumps(tool_names, ensure_ascii=False)
        parts.append(line)
    return "\n\n".join(parts)


def _tool_name_from_message(message: ToolMessage) -> str:
    payload = _parse_json_object(message.content)
    if isinstance(payload, dict):
        name = str(payload.get("toolName") or "").strip()
        if name:
            return name
    name = getattr(message, "name", None)
    return str(name or "").strip()


def _compact_tool_message(message: ToolMessage) -> ToolMessage:
    payload = _parse_json_object(message.content)
    tool_name = ""
    success: Any = None
    message_text = ""
    summary = ""
    if isinstance(payload, dict):
        tool_name = str(payload.get("toolName") or "").strip()
        success = payload.get("success")
        message_text = str(payload.get("message") or "").strip()
        data = payload.get("data")
        summary = _summarize_data(data if data is not None else payload)
    else:
        summary = _truncate(_stringify_content(message.content), 700)
    compact_payload = {
        "compacted": True,
        "toolName": tool_name,
        "success": success,
        "message": _truncate(message_text, 180),
        "summary": summary,
        "reference": "这是旧的只读工具结果摘要。如需原文，请按当前任务需要重新调用对应读取/搜索工具。",
    }
    return ToolMessage(
        content=json.dumps(compact_payload, ensure_ascii=False, sort_keys=True),
        tool_call_id=message.tool_call_id,
        name=getattr(message, "name", None),
    )


def _parse_json_object(value: Any) -> dict[str, Any] | None:
    try:
        parsed = json.loads(_stringify_content(value))
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


def _summarize_data(value: Any) -> str:
    if isinstance(value, dict):
        candidates = []
        for key in ("summary", "message", "title", "text", "content", "markdown", "result"):
            if key in value:
                candidates.append(f"{key}: {_truncate(_stringify_content(value.get(key)), 350)}")
        if candidates:
            return "; ".join(candidates[:4])
    if isinstance(value, list):
        return _truncate(f"{len(value)} items: " + _stringify_content(value[:3]), 700)
    return _truncate(_stringify_content(value), 700)


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "..."


def _attachment_type(message: BaseMessage) -> str:
    content = _stringify_content(message.content)
    match = re.search(r"\[系统附件\]\s+type=([a-zA-Z0-9_-]+)", content)
    if match:
        return match.group(1)
    return message.__class__.__name__
