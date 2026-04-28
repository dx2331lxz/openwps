from __future__ import annotations

import asyncio
import copy
import hashlib
import html as html_lib
import json
import logging
import re
import uuid
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, AsyncGenerator, TypedDict

import httpx
from fastapi import HTTPException
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.runnables import RunnableLambda
from langgraph.graph import END, START, StateGraph
from langchain_openai import ChatOpenAI
from langchain_core.runnables import Runnable

try:
    from tavily import AsyncTavilyClient
except ImportError:  # pragma: no cover - optional dependency until installed
    AsyncTavilyClient = None

from .config import (
    DEFAULT_IMAGE_PROCESSING_MODE,
    DEFAULT_OCR_BACKEND,
    DEFAULT_OCR_CONFIG,
    DEFAULT_TAVILY_CONFIG,
    DEFAULT_VISION_CONFIG,
    get_provider,
    read_config,
)
from .agents import (
    AgentDefinition,
    AgentRunRecord,
    get_agent_definition,
    new_agent_run_id,
    register_background_task,
    resolve_agent_tool_names,
    save_agent_run,
    unregister_background_task,
)
from .models import ChatMessage, ChatRequest, CompletionRequest, OCRCommandRequest, OCRConfig, VisionAnalyzeRequest, VisionConfig, VisionTestRequest
from .tool_registry import TOOL_SEARCH_NAME
from .tooling import (
    get_deferred_tool_definitions,
    get_tool_definitions,
    get_model_tools,
    get_tool_metadata_payload,
    search_deferred_tool_definitions,
)
from .content import (
    build_delta_content,
    build_initial_context_content,
    build_subagent_content,
    build_system_content,
    build_task_reminder_content,
    build_user_content,
    format_text_attachments_for_model,
)
from .compact import (
    CompactPolicy,
    build_compact_policy,
    build_compact_prompt,
    build_compacted_messages,
    count_messages_tokens,
    drop_oldest_api_round,
    microcompact_messages,
    should_auto_compact,
)
from .doc_sessions import create_document_session, execute_ai_document_tool, is_document_tool, read_document_session, set_active_document_session
from .tasks import create_task, get_task, list_tasks, update_task
from .workspace import get_document_content as get_workspace_document_content
from .workspace import delete_memory_file, get_workspace_manifest, get_workspace_tree, list_workspace_docs, open_file_as_document
from .workspace import save_memory_file
from .workspace import search_workspace

logger = logging.getLogger("uvicorn.error")


class ReasoningContentChatOpenAI(ChatOpenAI):
    """Preserve OpenAI-compatible reasoning_content in multi-turn messages."""

    pass_empty_reasoning_content: bool = False

    def _get_request_payload(
        self,
        input_: Any,
        *,
        stop: list[str] | None = None,
        **kwargs: Any,
    ) -> dict:
        payload = super()._get_request_payload(input_, stop=stop, **kwargs)
        payload_messages = payload.get("messages")
        if not isinstance(payload_messages, list):
            return payload

        try:
            source_messages = self._convert_input(input_).to_messages()
        except Exception:
            return payload

        for source, target in zip(source_messages, payload_messages):
            if not isinstance(source, AIMessage) or not isinstance(target, dict):
                continue
            if "reasoning_content" not in source.additional_kwargs:
                continue
            reasoning = source.additional_kwargs.get("reasoning_content")
            reasoning_text = _stringify_content(reasoning)
            if reasoning_text.strip() or self.pass_empty_reasoning_content:
                target["reasoning_content"] = reasoning_text
        return payload


def _looks_like_tool_result_json_leak(text: str) -> bool:
    try:
        payload = json.loads(text)
    except Exception:
        return (
            re.search(r'"success"\s*:\s*(true|false)', text) is not None
            and re.search(r'"message"\s*:', text) is not None
            and re.search(r'("data"|"toolName"|"executedParams"|"originalParams"|"paramsRepaired")\s*:', text) is not None
        )
    if not isinstance(payload, dict):
        return False
    return (
        isinstance(payload.get("success"), bool)
        and isinstance(payload.get("message"), str)
        and any(key in payload for key in ("data", "toolName", "executedParams", "originalParams", "paramsRepaired"))
    )


def _strip_tool_result_json_leaks(text: str) -> str:
    result: list[str] = []
    cursor = 0
    while cursor < len(text):
        start = text.find("{", cursor)
        if start < 0:
            result.append(text[cursor:])
            break

        result.append(text[cursor:start])
        depth = 0
        in_string = False
        escaped = False
        end = -1

        for index in range(start, len(text)):
            char = text[index]
            if in_string and escaped:
                escaped = False
                continue
            if in_string and char == "\\":
                escaped = True
                continue
            if char == '"':
                in_string = not in_string
                continue
            if in_string:
                continue
            if char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    end = index + 1
                    break

        if end < 0:
            tail = text[start:]
            if _looks_like_tool_result_json_leak(tail):
                break
            result.append(tail)
            break

        candidate = text[start:end]
        if not _looks_like_tool_result_json_leak(candidate):
            result.append(candidate)
        cursor = end

    return re.sub(r"[ \t]+\n", "\n", "".join(result))


OCR_ANALYSIS_SYSTEM_PROMPT = """你是 openwps 的 OCR 与样式分析器。你的任务不是聊天，而是把图片里的文档内容和样式线索提取成稳定 JSON。

返回严格 JSON，对象字段必须包含：
- plainText: 字符串，尽量完整的正文文本
- markdown: 字符串，按标题、列表、表格尽量转成 Markdown；若无法稳定转 Markdown，可留空字符串
- styleSummary: 对象，尽量包含 documentType、dominantAlignment、overallTone、layoutNotes；如果样式判断不确定，可填 null，但不要因此省略正文
- blocks: 数组，每项包含 kind、text、styleHints
- tables: 数组，每项包含 title、markdown、rowCount、columnCount
- warnings: 数组，写识别不确定、缺失、遮挡、样式判断不确定等

styleHints 尽量包含以下字段：titleLevel、alignment、fontWeightGuess、fontSizeTier、listType、indentLevel、tableStructure、emphasis。
如果无法判断，就填 null 或省略，不要编造。
即使样式无法识别，也必须尽量返回 plainText、markdown、blocks、tables，不要只返回空结构。只返回 JSON，不要输出解释。"""

OCR_STYLE_ANALYSIS_SYSTEM_PROMPT = """你是 openwps 的 OCR 第二阶段样式分析器。你的任务不是重新抄正文，而是根据图片视觉布局和已提取的文本块，为每个 block 补充适合文档排版的样式线索。

返回严格 JSON，对象字段必须包含：
- styleSummary: 对象，尽量包含 documentType、dominantAlignment、layoutNotes
- blockStyles: 数组，每项包含 blockIndex、styleHints
- warnings: 数组，写视觉判断不确定、块级文本可能不完整等

styleHints 尽量包含以下字段：
- titleLevel: 1-6 的整数
- alignment: left/center/right/justify/unknown
- fontWeightGuess: bold/regular
- fontSizeTier: xlarge/large/medium/small
- listType: bullet/ordered/none
- indentLevel: 整数
- sectionRole: cover_title/cover_field/body_heading/body_text/date/signature/footer/form_field
- underlinePlaceholder: 布尔值
- labelValuePattern: 布尔值
- emphasis: 数组，可包含 bold/italic/underline
- confidence: high/medium/low
- notes: 简短说明

优先识别：封面标题、表单字段+下划线占位、日期/签名、居中标题、列表、缩进。
若无法确认，请保守返回 null，不要编造。不要重新输出全文，只分析 blockIndex 对应的样式。只返回 JSON。"""


OCR_TASK_GUIDANCE = {
    "general_parse": "请面向通用文档解析，尽量提取正文、表格、图表标题、手写批注、公式和必要警告。",
    "document_text": "请专注提取文档正文与层级结构，适合扫描件、拍照文本和复杂文档段落解析。",
    "table": "请专注识别表格，优先返回 tables 数组和 markdown 表格；忽略与表格无关的背景描述。",
    "chart": "请专注识别图表，尽量提取图表标题、图例、坐标轴标签、关键数据系列和摘要。",
    "handwriting": "请专注识别手写文字，优先返回 handwritingText 和不确定片段说明。",
    "formula": "请专注识别公式与数学表达，优先返回 formulas 数组，并保留必要上下文。",
}

OCR_TASK_ALIASES = {
    "general": "general_parse",
    "parse": "general_parse",
    "document": "document_text",
    "text": "document_text",
    "doc": "document_text",
    "table": "table",
    "tables": "table",
    "chart": "chart",
    "charts": "chart",
    "graph": "chart",
    "handwriting": "handwriting",
    "handwritten": "handwriting",
    "handwrite": "handwriting",
    "formula": "formula",
    "math": "formula",
}

OCR_BACKEND_COMPAT_CHAT = "compat_chat"
OCR_BACKEND_PADDLEOCR_SERVICE = "paddleocr_service"

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
    values: list[str] = []

    def add_candidate(value: Any) -> None:
        if isinstance(value, str):
            values.append(value)

    for payload in (chunk.additional_kwargs, chunk.response_metadata):
        if not isinstance(payload, dict):
            continue
        for key in (
            "reasoning_content",
            "thinking",
            "reasoning",
            "reasoningText",
            "reasoning_text",
        ):
            add_candidate(payload.get(key))

    content = chunk.content
    if isinstance(content, list):
        for item in content:
            if not isinstance(item, dict):
                continue
            block_type = str(item.get("type") or item.get("kind") or "").lower()
            if block_type not in {
                "reasoning",
                "thinking",
                "reasoning_content",
                "reasoning_text",
                "thinking_delta",
            }:
                continue
            for key in ("text", "content", "reasoning", "thinking", "delta"):
                add_candidate(item.get(key))

    return "".join(values)


def _ai_reasoning_kwargs(reasoning_content: Any) -> dict[str, Any]:
    if reasoning_content is None:
        return {}
    text = _stringify_content(reasoning_content)
    return {"reasoning_content": text}


def _build_ai_message(
    content: Any,
    *,
    tool_calls: list[dict[str, Any]] | None = None,
    reasoning_content: Any = "",
) -> AIMessage:
    additional_kwargs = _ai_reasoning_kwargs(reasoning_content)
    if tool_calls is None:
        return AIMessage(content=_stringify_content(content), additional_kwargs=additional_kwargs)
    return AIMessage(
        content=_stringify_content(content),
        tool_calls=tool_calls,
        additional_kwargs=additional_kwargs,
    )


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


def _extract_token_usage(payload: Any) -> dict[str, int]:
    if payload is None or isinstance(payload, str):
        return {}

    if isinstance(payload, dict):
        candidates: list[Any] = [
            payload.get("usage_metadata"),
            payload.get("usage"),
            payload.get("token_usage"),
        ]
        response_metadata = payload.get("response_metadata")
        if isinstance(response_metadata, dict):
            candidates.extend([
                response_metadata.get("usage_metadata"),
                response_metadata.get("usage"),
                response_metadata.get("token_usage"),
            ])
        for candidate in candidates:
            normalized = _normalize_token_usage(candidate)
            if normalized:
                return normalized
        for key in ("response_metadata", "additional_kwargs", "llm_output", "output", "message", "generations"):
            usage = _extract_token_usage(payload.get(key))
            if usage:
                return usage
        return {}

    if isinstance(payload, (list, tuple)):
        for item in payload:
            usage = _extract_token_usage(item)
            if usage:
                return usage
        return {}

    for attr in ("usage_metadata", "response_metadata", "additional_kwargs", "llm_output", "output", "message", "generations"):
        if hasattr(payload, attr):
            usage = _extract_token_usage(getattr(payload, attr))
            if usage:
                return usage
    return {}


def _normalize_token_usage(value: Any) -> dict[str, int]:
    if not isinstance(value, dict):
        return {}

    def read_int(*keys: str) -> int | None:
        for key in keys:
            raw = value.get(key)
            try:
                parsed = int(raw)
            except Exception:
                continue
            if parsed >= 0:
                return parsed
        return None

    input_tokens = read_int("input_tokens", "prompt_tokens")
    output_tokens = read_int("output_tokens", "completion_tokens")
    total_tokens = read_int("total_tokens")
    if total_tokens is None and (input_tokens is not None or output_tokens is not None):
        total_tokens = int(input_tokens or 0) + int(output_tokens or 0)
    if input_tokens is None and total_tokens is not None and output_tokens is not None:
        input_tokens = max(0, total_tokens - output_tokens)
    if output_tokens is None and total_tokens is not None and input_tokens is not None:
        output_tokens = max(0, total_tokens - input_tokens)
    usage: dict[str, int] = {}
    if input_tokens is not None:
        usage["inputTokens"] = input_tokens
    if output_tokens is not None:
        usage["outputTokens"] = output_tokens
    if total_tokens is not None:
        usage["totalTokens"] = total_tokens
    return usage


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
    attachments = raw.get("attachments") if isinstance(raw.get("attachments"), list) else []

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
        return _build_ai_message(
            content=content,
            tool_calls=tool_calls,
            reasoning_content=raw.get("thinking") or raw.get("reasoning_content") or "",
        )
    if role == "tool":
        return ToolMessage(content=content, tool_call_id=str(raw.get("tool_call_id", "")))
    attachment_block = _format_text_attachments_for_model(attachments)
    if attachment_block:
        content = f"{content}\n\n{attachment_block}" if content else attachment_block
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
        parts.append("以上是为长文档准备的紧凑预览，可用来决定是否继续调用 get_document_outline / get_page_content / get_document_content；需要样式详情时用 get_page_style_summary(page=N)，一次只读一页。")

    selection = context.get("selection")
    if selection and isinstance(selection, dict):
        parts.append("")
        parts.append("context.selection = " + json.dumps(selection, ensure_ascii=False, indent=2))
        parts.append("以上是 context.selection 的序列化结果，请按这些字段名理解选区信息。")

    active_template = context.get("activeTemplate")
    if active_template and isinstance(active_template, dict):
        parts.append("")
        parts.append("context.activeTemplate = " + json.dumps(active_template, ensure_ascii=False, indent=2))
        parts.append("以上是当前激活模板。若用户要求按模板排版，优先遵循其中的 templateText，并结合页面设置与批量样式完成排版。")

    available_templates = context.get("availableTemplates")
    if available_templates and isinstance(available_templates, list):
        parts.append("")
        parts.append("context.availableTemplates = " + json.dumps(available_templates, ensure_ascii=False, indent=2))
        parts.append("如果用户明确提到某个模板名，可结合这个列表理解模板候选；当前真正生效的模板以 context.activeTemplate 为准。")

    workspaceDocs = context.get("workspaceDocs")
    if workspaceDocs and isinstance(workspaceDocs, list):
        parts.append("")
        parts.append("[工作区文档列表]")
        parts.append("以下为当前工作区 _references/ 下的参考文档，可使用 workspace_search 搜索内容或 workspace_read(path) 查看全文。")
        parts.append("参考目录中的文件默认只作为资料来源；普通工作区文件可用 workspace_open(path) 切换为当前编辑文件。")
        for doc in workspaceDocs:
            name = doc.get("name", "?")
            doc_id = doc.get("path") or doc.get("id", "?")
            doc_type = doc.get("type", "?")
            size = doc.get("size", 0)
            text_length = doc.get("textLength", 0)
            parts.append(f"  - [{doc_id}] {name} ({doc_type}, {size} bytes, {text_length} chars)")

    workspace_manifest = context.get("workspaceManifest")
    if workspace_manifest and isinstance(workspace_manifest, dict):
        parts.append("")
        parts.append("[当前工作区目录]")
        memory = workspace_manifest.get("memory")
        if isinstance(memory, dict):
            entrypoint = memory.get("entrypoint")
            if isinstance(entrypoint, dict) and entrypoint.get("content"):
                parts.append(".openwps/memory/MEMORY.md 记忆索引：")
                parts.append(str(entrypoint.get("content") or ""))
                parts.append("MEMORY.md 只是索引；需要完整记忆时使用 workspace_read(path) 读取 .openwps/memory 下的具体文件。")
            selected = memory.get("selected")
            if isinstance(selected, list) and selected:
                parts.append("本轮按需命中的记忆文件：")
                for item in selected[:5]:
                    parts.append(f"--- Memory: {item.get('path')} ---")
                    parts.append(str(item.get("content") or ""))
            manifest = memory.get("manifest")
            if isinstance(manifest, list) and manifest:
                parts.append("可用记忆文件 manifest（按需读取，不要默认全量读取）：")
                for item in manifest[:40]:
                    desc = str(item.get("description") or "")
                    memory_type = str(item.get("type") or "")
                    suffix = f" [{memory_type}]" if memory_type else ""
                    parts.append(f"  - {item.get('path')}{suffix}: {desc}")
            parts.append("记忆可能过期；当记忆提到文件、函数、资料路径或当前事实时，先读取当前工作区真实文件验证。")
        files = workspace_manifest.get("files")
        refs = workspace_manifest.get("references")
        if isinstance(files, list):
            parts.append("普通可编辑/可读文件：")
            for item in files[:80]:
                parts.append(f"  - {item.get('path')} ({item.get('type')}, editable={item.get('editable')})")
        if isinstance(refs, list):
            parts.append("_references/ 参考资料：")
            for item in refs[:80]:
                parts.append(f"  - {item.get('path')} ({item.get('type')}, {item.get('textLength', 0)} chars)")

    return "\n".join(parts)


def _with_backend_workspace_docs(context: dict[str, Any] | None, *, query: str | None = None) -> dict[str, Any]:
    """Attach the backend-owned workspace manifest to model context.

    Workspace files are uploaded to and persisted by the backend, so the frontend
    must not be the source of truth for this manifest. This mirrors Claude Code's
    attachment model: runtime context is assembled close to the tool/runtime state.
    """
    merged = dict(context or {})
    merged["workspaceDocs"] = list_workspace_docs()
    merged["workspaceManifest"] = get_workspace_manifest(query=query)
    return merged


def _already_has_context_block(content: str) -> bool:
    return "[当前文档上下文]" in content and "[用户请求]" in content


def _normalize_user_text(message: str, context_block: str) -> str:
    user_text = message
    if context_block and not _already_has_context_block(user_text):
        user_text = context_block + "\n\n" + user_text
    return user_text


def _normalize_image_processing_mode(mode: str | None) -> str:
    normalized = str(mode or "").strip().lower().replace("-", "_")
    if normalized in {"ocr", "ocr_text"}:
        return "ocr_text"
    return DEFAULT_IMAGE_PROCESSING_MODE


def _normalize_ocr_backend(value: Any) -> str:
    normalized = str(value or "").strip().lower().replace("-", "_")
    if normalized in {OCR_BACKEND_PADDLEOCR_SERVICE, "official_service", "layout_parsing"}:
        return OCR_BACKEND_PADDLEOCR_SERVICE
    return OCR_BACKEND_COMPAT_CHAT


def _ocr_backend_requires_model(backend: str) -> bool:
    return _normalize_ocr_backend(backend) == OCR_BACKEND_COMPAT_CHAT


def _normalize_ocr_config(body: ChatRequest) -> OCRConfig:
    return _resolve_ocr_config(body.ocrConfig)


def _resolve_ocr_config(request_config: OCRConfig | None) -> OCRConfig:
    cfg = read_config()
    saved = dict(cfg.get("ocrConfig") or DEFAULT_OCR_CONFIG)
    request_config_data = request_config.model_dump(exclude_none=True) if request_config else {}

    merged: dict[str, Any] = dict(saved)
    for key, value in request_config_data.items():
        if key == "hasApiKey":
            continue
        if isinstance(value, str):
            normalized = value.strip()
            if normalized:
                merged[key] = normalized.rstrip("/") if key == "endpoint" else normalized
            continue
        merged[key] = value

    provider_id = str(merged.get("providerId") or DEFAULT_OCR_CONFIG["providerId"]).strip() or DEFAULT_OCR_CONFIG["providerId"]
    provider = get_provider(cfg, provider_id)
    backend = _normalize_ocr_backend(merged.get("backend") or DEFAULT_OCR_BACKEND)
    endpoint = str(merged.get("endpoint") or provider.get("endpoint") or DEFAULT_OCR_CONFIG["endpoint"]).strip().rstrip("/")
    api_key = str(merged.get("apiKey") or provider.get("apiKey") or "").strip()
    model = str(merged.get("model") or "").strip()
    if _ocr_backend_requires_model(backend):
        model = model or DEFAULT_OCR_CONFIG["model"]

    return OCRConfig(
        enabled=bool(merged.get("enabled", True)),
        backend=backend,
        providerId=provider["id"],
        endpoint=endpoint,
        model=model,
        apiKey=api_key or None,
        hasApiKey=bool(api_key),
        timeoutSeconds=max(int(merged.get("timeoutSeconds") or DEFAULT_OCR_CONFIG["timeoutSeconds"]), 5),
        maxImages=max(int(merged.get("maxImages") or DEFAULT_OCR_CONFIG["maxImages"]), 1),
    )


def _resolve_image_processing_mode(body: ChatRequest) -> str:
    cfg = read_config()
    return _normalize_image_processing_mode(body.imageProcessingMode or str(cfg.get("imageProcessingMode") or DEFAULT_IMAGE_PROCESSING_MODE))


def _normalize_ocr_task_type(value: Any) -> str:
    normalized = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    if not normalized:
        return "general_parse"
    return OCR_TASK_ALIASES.get(normalized, normalized if normalized in OCR_TASK_GUIDANCE else "general_parse")


def _build_ocr_user_instruction(task_type: str, instruction: str | None = None) -> str:
    base = OCR_TASK_GUIDANCE.get(task_type, OCR_TASK_GUIDANCE["general_parse"])
    shared = (
        "返回严格 JSON，对象字段必须包含：taskType、summary、plainText、markdown、tables、charts、handwritingText、formulas、blocks、warnings。"
        "未识别到的字段请返回空字符串、空数组或 null，不要输出解释性前后缀。"
    )
    extra = str(instruction or "").strip()
    if extra:
        return f"{base}\n{shared}\n额外要求：{extra}"
    return f"{base}\n{shared}"


def _model_name_supports_vision(model_name: str) -> bool:
    normalized = model_name.strip().lower()
    if not normalized:
        return False

    hints = (
        "gpt-4o",
        "gpt-4.1",
        "gpt-4-turbo",
        "vision",
        "multimodal",
        "qwen-vl",
        "qwen2-vl",
        "qwen2.5-vl",
        "glm-4v",
        "glm-4.1v",
        "glm-4.5v",
        "internvl",
        "llava",
        "pixtral",
        "gemini",
        "claude-3",
        "claude-3.5",
        "claude-3.7",
        "llama-3.2-11b-vision",
        "llama-3.2-90b-vision",
    )
    if any(hint in normalized for hint in hints):
        return True

    return normalized.endswith("-vl") or normalized.endswith("-vision") or normalized.endswith("-omni")


def _raw_model_supports_vision(raw_model: dict[str, Any]) -> bool:
    capability_sources = [
        raw_model.get("capabilities"),
        raw_model.get("architecture"),
    ]
    for source in capability_sources:
        if not isinstance(source, dict):
            continue
        for key in ("vision", "image_input", "supports_vision", "supportsVision", "multimodal"):
            value = source.get(key)
            if isinstance(value, bool) and value:
                return True
        for key in ("input_modalities", "modalities"):
            values = source.get(key)
            if isinstance(values, list) and any(str(item).lower() in {"image", "vision"} for item in values):
                return True

    for key in ("input_modalities", "modalities"):
        values = raw_model.get(key)
        if isinstance(values, list) and any(str(item).lower() in {"image", "vision"} for item in values):
            return True

    return False


def _provider_supports_vision(provider: dict[str, Any]) -> bool:
    return bool(provider.get("supportsVision"))


def _resolve_provider_and_model(body: ChatRequest) -> tuple[dict[str, Any], str]:
    cfg = read_config()
    provider = get_provider(cfg, body.providerId)
    model = str(body.model or provider.get("defaultModel") or "").strip()
    return provider, model


def _selected_model_supports_vision(provider: dict[str, Any], model_name: str) -> bool:
    if _model_name_supports_vision(model_name):
        return True
    if not model_name:
        return _provider_supports_vision(provider)
    return False


def _resolve_vision_config(request_config: VisionConfig | None = None) -> VisionConfig:
    cfg = read_config()
    saved = dict(cfg.get("visionConfig") or DEFAULT_VISION_CONFIG)
    request_data = request_config.model_dump(exclude_none=True) if request_config else {}

    merged: dict[str, Any] = dict(saved)
    for key, value in request_data.items():
        if key == "hasApiKey":
            continue
        if isinstance(value, str):
            normalized = value.strip()
            if normalized:
                merged[key] = normalized.rstrip("/") if key == "endpoint" else normalized
            continue
        merged[key] = value

    provider_id = str(merged.get("providerId") or DEFAULT_VISION_CONFIG["providerId"]).strip() or DEFAULT_VISION_CONFIG["providerId"]
    provider = get_provider(cfg, provider_id)
    endpoint = str(merged.get("endpoint") or provider.get("endpoint") or DEFAULT_VISION_CONFIG["endpoint"]).strip().rstrip("/")
    api_key = str(merged.get("apiKey") or provider.get("apiKey") or "").strip()
    model = str(merged.get("model") or provider.get("defaultModel") or DEFAULT_VISION_CONFIG["model"]).strip()
    try:
        timeout_seconds = int(merged.get("timeoutSeconds") or DEFAULT_VISION_CONFIG["timeoutSeconds"])
    except Exception:
        timeout_seconds = int(DEFAULT_VISION_CONFIG["timeoutSeconds"])

    return VisionConfig(
        enabled=bool(merged.get("enabled", False)),
        providerId=provider["id"],
        endpoint=endpoint,
        model=model,
        apiKey=api_key or None,
        hasApiKey=bool(api_key),
        timeoutSeconds=max(5, min(timeout_seconds, 120)),
    )


def _resolve_vision_runtime(provider_id: str | None = None, model: str | None = None) -> tuple[dict[str, Any], str, bool]:
    cfg = read_config()
    main_provider = get_provider(cfg, provider_id)
    main_model = str(model or main_provider.get("defaultModel") or "").strip()
    if _selected_model_supports_vision(main_provider, main_model):
        return main_provider, main_model, False

    vision_config = _resolve_vision_config()
    if not vision_config.enabled:
        raise HTTPException(status_code=400, detail="当前主模型不是多模态模型，且未启用多模态图片分析模型。请在设置中配置多模态模型。")
    if not vision_config.endpoint or not vision_config.model or not vision_config.hasApiKey:
        raise HTTPException(status_code=400, detail="多模态图片分析模型配置不完整，请在设置中补充端点、模型和 API Key。")

    provider = get_provider(cfg, vision_config.providerId)
    provider["endpoint"] = vision_config.endpoint
    provider["apiKey"] = vision_config.apiKey or ""
    provider["supportsVision"] = True
    return provider, vision_config.model, True


@dataclass(frozen=True)
class RuntimeCapabilities:
    main_model_supports_vision: bool
    vision_fallback_available: bool
    vision_runtime_available: bool
    ocr_available: bool
    headless_screenshot_available: bool


def _headless_screenshot_available() -> bool:
    package_json = Path(__file__).resolve().parents[2] / "package.json"
    try:
        package_data = json.loads(package_json.read_text(encoding="utf-8"))
    except Exception:
        return False
    deps = {
        **(package_data.get("dependencies") if isinstance(package_data.get("dependencies"), dict) else {}),
        **(package_data.get("devDependencies") if isinstance(package_data.get("devDependencies"), dict) else {}),
    }
    return "playwright" in deps


def _vision_fallback_available() -> bool:
    vision_config = _resolve_vision_config()
    return bool(
        vision_config.enabled
        and vision_config.endpoint
        and vision_config.model
        and vision_config.hasApiKey
    )


def _ocr_runtime_available(body: ChatRequest) -> bool:
    ocr_config = _normalize_ocr_config(body)
    if not ocr_config.enabled:
        return False
    if not ocr_config.endpoint:
        return False
    if _ocr_backend_requires_model(ocr_config.backend):
        return bool(ocr_config.model and ocr_config.hasApiKey)
    return True


def _resolve_runtime_capabilities(body: ChatRequest) -> RuntimeCapabilities:
    provider, model = _resolve_provider_and_model(body)
    main_model_supports_vision = _selected_model_supports_vision(provider, model)
    vision_fallback_available = _vision_fallback_available()
    return RuntimeCapabilities(
        main_model_supports_vision=main_model_supports_vision,
        vision_fallback_available=vision_fallback_available,
        vision_runtime_available=main_model_supports_vision or vision_fallback_available,
        ocr_available=_ocr_runtime_available(body),
        headless_screenshot_available=_headless_screenshot_available(),
    )


def _tool_name_from_schema(tool: dict[str, Any]) -> str:
    function = tool.get("function") if isinstance(tool.get("function"), dict) else {}
    return str(function.get("name") or "")


def _tool_available_for_runtime(tool_name: str, capabilities: RuntimeCapabilities) -> bool:
    if tool_name == "capture_page_screenshot":
        return capabilities.headless_screenshot_available and capabilities.vision_runtime_available
    if tool_name == "analyze_document_image":
        return capabilities.vision_runtime_available or capabilities.ocr_available
    if tool_name == "analyze_image_with_ocr":
        return capabilities.ocr_available
    return True


def _adjust_tool_schema_for_runtime(
    tool: dict[str, Any],
    capabilities: RuntimeCapabilities,
) -> dict[str, Any] | None:
    tool_name = _tool_name_from_schema(tool)
    if not _tool_available_for_runtime(tool_name, capabilities):
        return None

    adjusted = copy.deepcopy(tool)
    function = adjusted.get("function") if isinstance(adjusted.get("function"), dict) else {}
    if tool_name == "capture_page_screenshot" and not capabilities.main_model_supports_vision:
        function["description"] = (
            "截取指定正文页并由后端多模态 fallback 模型直接完成视觉分析，返回文本结论和结构化元数据。"
            "适合校验分页、图文混排、遮挡、重叠、表格/图片附近视觉效果。"
        )
    if tool_name == "analyze_document_image":
        params = function.get("parameters") if isinstance(function.get("parameters"), dict) else {}
        properties = params.get("properties") if isinstance(params.get("properties"), dict) else {}
        analysis_mode = properties.get("analysisMode") if isinstance(properties.get("analysisMode"), dict) else None
        if analysis_mode is not None:
            if capabilities.vision_runtime_available and capabilities.ocr_available:
                analysis_mode["enum"] = ["auto", "multimodal", "ocr", "both"]
                analysis_mode["description"] = "分析路径，默认 auto。"
            elif capabilities.vision_runtime_available:
                analysis_mode["enum"] = ["auto", "multimodal"]
                analysis_mode["description"] = "分析路径；当前运行时仅开放多模态视觉分析。"
            else:
                analysis_mode["enum"] = ["ocr"]
                analysis_mode["description"] = "分析路径；当前运行时仅开放 OCR。"
        if not capabilities.vision_runtime_available:
            function["description"] = (
                "使用 OCR 分析当前文档内的图片。可按 imageId 或 paragraphIndex+imageIndex 定位；"
                "当前运行时没有可用多模态视觉模型。"
            )
    return adjusted


def _filter_tool_schemas_for_runtime(
    tools: list[dict[str, Any]],
    capabilities: RuntimeCapabilities,
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for tool in tools:
        adjusted = _adjust_tool_schema_for_runtime(tool, capabilities)
        if adjusted is not None:
            result.append(adjusted)
    return result


def _get_model_tools_for_body(
    body: ChatRequest,
    loaded_deferred_tools: set[str] | None = None,
    *,
    agent_type: str | None = None,
) -> list[dict[str, Any]]:
    filtered = _filter_tool_schemas_for_runtime(
        get_model_tools(body.mode, loaded_deferred_tools or set(), agent_type=agent_type),
        _resolve_runtime_capabilities(body),
    )
    if not _get_deferred_tool_definitions_for_body(body, loaded_deferred_tools or set()):
        filtered = [tool for tool in filtered if _tool_name_from_schema(tool) != TOOL_SEARCH_NAME]
    return filtered


def _get_deferred_tool_definitions_for_body(
    body: ChatRequest,
    loaded_deferred_tools: set[str] | None = None,
) -> list[Any]:
    capabilities = _resolve_runtime_capabilities(body)
    return [
        definition
        for definition in get_deferred_tool_definitions(body.mode, loaded_deferred_tools or set())
        if _tool_available_for_runtime(definition.name, capabilities)
    ]


def _get_tool_definitions_for_body(body: ChatRequest) -> list[Any]:
    capabilities = _resolve_runtime_capabilities(body)
    return [
        definition
        for definition in get_tool_definitions(body.mode)
        if _tool_available_for_runtime(definition.name, capabilities)
    ]


def _search_deferred_tool_definitions_for_body(
    body: ChatRequest,
    query: str,
    loaded_deferred_tools: set[str] | None = None,
) -> list[Any]:
    capabilities = _resolve_runtime_capabilities(body)
    return [
        definition
        for definition in search_deferred_tool_definitions(body.mode, query, loaded_deferred_tools or set())
        if _tool_available_for_runtime(definition.name, capabilities)
    ]


def _parse_data_url_header(data_url: str) -> tuple[str, str] | None:
    if not isinstance(data_url, str) or not data_url.startswith("data:"):
        return None
    header, _, payload = data_url.partition(",")
    if not header or not payload:
        return None
    return header, payload


def _estimate_data_url_size_bytes(data_url: str) -> int:
    parsed = _parse_data_url_header(data_url)
    if not parsed:
        return 0
    _, payload = parsed
    normalized = payload.strip()
    if not normalized:
        return 0
    padding = len(normalized) - len(normalized.rstrip("="))
    return max(((len(normalized) * 3) // 4) - padding, 0)


def _validate_image_batch(images: list[dict[str, Any]], *, max_images: int) -> None:
    if len(images) > max_images:
        raise HTTPException(status_code=400, detail=f"最多只能上传 {max_images} 张图片")

    total_size = 0
    for index, image in enumerate(images, start=1):
        data_url = str(image.get("dataUrl") or "").strip()
        parsed = _parse_data_url_header(data_url)
        if not parsed:
            raise HTTPException(status_code=400, detail=f"第 {index} 张图片格式无效")

        header, _ = parsed
        mime = header[5:].split(";", 1)[0].strip().lower()
        if not mime.startswith("image/") or ";base64" not in header:
            raise HTTPException(status_code=400, detail=f"第 {index} 张图片不是支持的图片格式")

        declared_size = int(image.get("size") or 0)
        estimated_size = _estimate_data_url_size_bytes(data_url)
        image_size = max(declared_size, estimated_size)
        if image_size <= 0:
            raise HTTPException(status_code=400, detail=f"第 {index} 张图片内容为空")
        if image_size > MAX_IMAGE_SIZE_BYTES:
            raise HTTPException(status_code=400, detail=f"第 {index} 张图片超过 {MAX_IMAGE_SIZE_BYTES // (1024 * 1024)}MB 限制")

        total_size += image_size

    if total_size > MAX_TOTAL_IMAGE_BYTES:
        raise HTTPException(status_code=400, detail=f"图片总大小超过 {MAX_TOTAL_IMAGE_BYTES // (1024 * 1024)}MB 限制")


def _validate_multimodal_request(body: ChatRequest) -> None:
    images = body.images or []
    if not images:
        return

    _validate_image_batch(images, max_images=MAX_MULTIMODAL_IMAGES)


VISION_TEST_IMAGE_DATA_URL = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAj0lEQVR4nGP8//8/Ay0BE01NZxgOFrAgc+QnUsfQh/nDNoi"
    "w+pF4gDWEh34QMQ1MHGAH0bYI9tLDDFT2QbQtPi6lFkRjM444O4iwIBq3QUTYMfRTEdMgsGAp7hRJRGIl"
    "zgdLsRlEXFYgOoiWohpHdEYjJScvJdbQwRbJQ7I0ladS7c8wHIKIcbRtSgjQPA4Avi8aW/avCLMAAAAASUVORK5CYII="
)


def _build_vision_messages(prompt: str, image_data_url: str) -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": "你是 OpenWPS 的视觉理解引擎。请基于图片做简洁、可靠的中文分析。"},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": image_data_url}},
            ],
        },
    ]


async def _call_vision_chat(provider: dict[str, Any], model: str, prompt: str, image_data_url: str, timeout_seconds: int) -> str:
    endpoint = str(provider.get("endpoint") or "").strip().rstrip("/")
    api_key = str(provider.get("apiKey") or "").strip()
    if not endpoint or not model or not api_key:
        raise HTTPException(status_code=400, detail="多模态模型配置不完整，请检查端点、模型和 API Key。")

    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
    payload = {
        "model": model,
        "temperature": 0.2,
        "max_tokens": 1200,
        "messages": _build_vision_messages(prompt, image_data_url),
    }

    async with httpx.AsyncClient(timeout=float(timeout_seconds)) as client:
        try:
            response = await client.post(f"{endpoint}/chat/completions", headers=headers, json=payload)
            response.raise_for_status()
            body = response.json()
        except httpx.HTTPStatusError as exc:
            raw_detail = exc.response.text.strip() or str(exc)
            detail = _sanitize_upstream_error_detail(raw_detail, status_code=exc.response.status_code)
            if _looks_like_multimodal_capability_error(raw_detail):
                raise HTTPException(status_code=400, detail=f"多模态模型未配置或不支持图片输入：{_sanitize_upstream_error_detail(raw_detail, status_code=exc.response.status_code, limit=180)}") from exc
            raise HTTPException(status_code=502, detail=f"多模态模型请求失败: {detail}") from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"多模态模型请求失败: {_sanitize_upstream_error_detail(str(exc))}") from exc

    choices = body.get("choices") if isinstance(body, dict) else None
    if not isinstance(choices, list) or not choices:
        raise HTTPException(status_code=502, detail="多模态模型没有返回有效结果")
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    text = _stringify_content(content).strip()
    if not text:
        raise HTTPException(status_code=502, detail="多模态模型返回为空")
    return text


async def test_vision_model(body: VisionTestRequest) -> dict[str, Any]:
    cfg = read_config()
    if body.providerId:
        provider = get_provider(cfg, body.providerId)
        saved_vision = _resolve_vision_config()
        endpoint = str(body.endpoint or provider.get("endpoint") or "").strip().rstrip("/")
        saved_matches = (
            saved_vision.providerId == provider.get("id")
            and (not body.endpoint or body.endpoint.rstrip("/") == saved_vision.endpoint)
            and (not body.model or body.model == saved_vision.model)
        )
        api_key = str(
            body.apiKey
            if body.apiKey is not None
            else (saved_vision.apiKey if saved_matches else provider.get("apiKey"))
            or ""
        ).strip()
        model = str(body.model or provider.get("defaultModel") or "").strip()
        timeout_seconds = max(5, min(int(body.timeoutSeconds or 30), 120))
        runtime_provider = {**provider, "endpoint": endpoint, "apiKey": api_key, "supportsVision": True}
    else:
        vision_config = _resolve_vision_config()
        runtime_provider = get_provider(cfg, vision_config.providerId)
        runtime_provider.update(endpoint=vision_config.endpoint, apiKey=vision_config.apiKey or "", supportsVision=True)
        model = vision_config.model
        timeout_seconds = vision_config.timeoutSeconds

    prompt = "这是一次能力测试。请只回答：ok。"
    text = await _call_vision_chat(runtime_provider, model, prompt, VISION_TEST_IMAGE_DATA_URL, timeout_seconds)
    return {
        "success": True,
        "providerId": runtime_provider.get("id"),
        "model": model,
        "message": "多模态图片输入测试通过",
        "resultPreview": _compact_text_preview(text, 80),
    }


async def analyze_image_with_vision(body: VisionAnalyzeRequest) -> dict[str, Any]:
    data_url = str((body.image or {}).get("dataUrl") or "").strip()
    pseudo_request = ChatRequest(message=body.instruction or "", images=[body.image] if body.image else [])
    _validate_multimodal_request(pseudo_request)
    if not data_url:
        raise HTTPException(status_code=400, detail="未提供可分析的图片")

    provider, model, used_fallback = _resolve_vision_runtime(body.providerId, body.model)
    timeout_seconds = int(body.timeoutSeconds or DEFAULT_VISION_CONFIG["timeoutSeconds"])
    context = body.context or {}
    prompt = "\n".join([
        "请分析当前文档中的这张图片，返回严格 JSON 对象。",
        "字段：visualSummary, detectedObjects, chartSummary, styleHints, warnings, confidence。",
        "detectedObjects 和 warnings 使用数组；confidence 使用 0 到 1 的数字。",
        f"图片上下文：{json.dumps(context, ensure_ascii=False)[:1800]}",
        f"额外要求：{str(body.instruction or '').strip() or '按文档理解需要做图片语义分析。'}",
    ])
    raw_text = await _call_vision_chat(provider, model, prompt, data_url, timeout_seconds)
    parsed = _extract_json_object(raw_text)
    data = parsed if isinstance(parsed, dict) else {"visualSummary": raw_text}
    return {
        "success": True,
        "providerId": provider.get("id"),
        "model": model,
        "usedFallbackVisionConfig": used_fallback,
        "result": data,
    }


def _validate_ocr_request(body: ChatRequest, ocr_config: OCRConfig) -> None:
    images = body.images or []
    if not images:
        return

    if not ocr_config.enabled:
        raise HTTPException(status_code=400, detail="当前已切换到 OCR 模式，但 OCR 功能未启用。")
    if not ocr_config.endpoint:
        raise HTTPException(status_code=400, detail="OCR 端点未配置。")
    if _ocr_backend_requires_model(ocr_config.backend) and not ocr_config.model:
        raise HTTPException(status_code=400, detail="OCR 模型未配置。")
    if not ocr_config.hasApiKey:
        raise HTTPException(status_code=400, detail="OCR API Key 未配置，请在设置中补充后再使用 OCR 模式。")

    _validate_image_batch(images, max_images=max(int(ocr_config.maxImages), 1))


def _looks_like_multimodal_capability_error(detail: str) -> bool:
    normalized = detail.strip().lower()
    if not normalized:
        return False

    hints = (
        "image_url",
        "image input",
        "input image",
        "input_image",
        "unsupported image",
        "does not support image",
        "doesn't support image",
        "does not support vision",
        "vision is not supported",
        "multimodal",
        "multi-modal",
        "text-only",
        "only text",
        "input modalities",
        "unsupported content type",
        "unable to view images",
        "cannot process images",
    )
    return any(hint in normalized for hint in hints)


def _looks_like_html_error_text(detail: str) -> bool:
    normalized = detail.strip().lower()
    if not normalized:
        return False
    return (
        "<!doctype html" in normalized
        or "<html" in normalized
        or ("<head" in normalized and "<body" in normalized)
        or ("content-security-policy" in normalized and "</html>" in normalized)
    )


def _html_text_preview(detail: str, limit: int = 260) -> str:
    unescaped = html_lib.unescape(detail)
    without_assets = re.sub(r"(?is)<(script|style|svg|noscript)[^>]*>.*?</\1>", " ", unescaped)
    without_tags = re.sub(r"(?is)<[^>]+>", " ", without_assets)
    without_data_urls = re.sub(r"data:image/[^\\s\"')]+", "data:image/...省略", without_tags)
    return _compact_text_preview(without_data_urls, limit)


def _sanitize_upstream_error_detail(detail: Any, *, status_code: int | None = None, limit: int = 900) -> str:
    text = _stringify_content(detail).strip() or "未知错误"
    if _looks_like_html_error_text(text):
        normalized = text.lower()
        title_match = re.search(r"(?is)<title[^>]*>(.*?)</title>", text)
        title = _compact_text_preview(html_lib.unescape(title_match.group(1)), 120) if title_match else ""
        status_text = f"HTTP {status_code}，" if status_code else ""
        if "cloudflare" in normalized or "challenges.cloudflare.com" in normalized or "just a moment" in normalized:
            base = f"{status_text}上游返回了 Cloudflare 人机验证/挑战 HTML 页面，而不是模型 API JSON/SSE 响应。"
        else:
            base = f"{status_text}上游返回了 HTML 页面，而不是模型 API JSON/SSE 响应。"
        title_text = f" title={title!r}。" if title else ""
        preview = _html_text_preview(text, 240)
        preview_text = f"页面文本摘要：{preview}" if preview else ""
        return _compact_text_preview(f"{base}{title_text}{preview_text}", limit)
    return _compact_text_preview(text, limit)


def _sanitize_tool_result_message(message: Any, *, success: bool) -> str:
    text = _stringify_content(message).strip()
    if not text:
        return ""
    if _looks_like_html_error_text(text):
        return _sanitize_upstream_error_detail(text, limit=900)
    return _compact_text_preview(text, 1200 if success else 900)


def _normalize_ai_api_error_detail(body: ChatRequest, detail: str) -> str:
    text = detail.strip() or "未知错误"
    normalized = text.lower()
    provider, model_name = _resolve_provider_and_model(body)
    provider_name = str(provider.get("label") or provider.get("id") or "当前服务商")
    endpoint = str(provider.get("endpoint") or "").strip()
    endpoint_hint = f"（{endpoint}）" if endpoint else ""

    if (
        ("<!doctype html" in normalized or "<html" in normalized)
        and (
            "just a moment" in normalized
            or "cloudflare" in normalized
            or "challenges.cloudflare.com" in normalized
        )
    ):
        return (
            f"{provider_name}{endpoint_hint} 返回了 Cloudflare 人机验证/挑战页，而不是 OpenAI-compatible API 响应。"
            "当前端点不能被后端作为模型 API 直接调用，请在 AI 设置中切换到可直连的服务商/端点，或更换当前 API 网关。"
        )

    if _looks_like_html_error_text(text):
        return (
            f"{provider_name}{endpoint_hint} 返回了 HTML 页面，而不是模型 API 的 JSON/SSE 响应。"
            f"请检查端点是否填到了 API base URL；上游返回摘要：{_sanitize_upstream_error_detail(text, limit=220)}"
        )

    images = body.images or []
    if not images:
        return _sanitize_upstream_error_detail(text, limit=1200)
    if not _looks_like_multimodal_capability_error(text):
        return _sanitize_upstream_error_detail(text, limit=1200)

    model_text = model_name or str(provider.get("defaultModel") or "当前模型")
    return (
        f"当前模型 {model_text} 未接受图片输入，或 {provider_name} 接口不兼容 image_url 图片格式。"
        f"系统已按多模态路径尝试发送图片，但上游返回不支持。"
        f"请切换到明确支持视觉的模型，或改用 /ocr 命令 / OCR 工具处理识别型任务。上游错误：{_sanitize_upstream_error_detail(text, limit=180)}"
    )


def _raise_ai_api_request_error(body: ChatRequest, exc: Exception) -> None:
    detail = _normalize_ai_api_error_detail(body, str(exc))
    raise HTTPException(status_code=502, detail=f"AI API 请求失败: {detail}") from exc


def _extract_json_object(raw_text: str) -> dict[str, Any] | None:
    text = raw_text.strip()
    if not text:
        return None

    candidates: list[str] = []
    seen: set[str] = set()

    def add_candidate(candidate: str) -> None:
        normalized = candidate.strip()
        if not normalized or normalized in seen:
            return
        seen.add(normalized)
        candidates.append(normalized)

    add_candidate(text)

    for match in re.finditer(r"```(?:json)?\s*([\s\S]*?)```", text, flags=re.IGNORECASE):
        add_candidate(match.group(1))

    stack = 0
    start_index: int | None = None
    in_string = False
    escaped = False
    for index, char in enumerate(text):
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
            continue
        if char == "{":
            if stack == 0:
                start_index = index
            stack += 1
            continue
        if char == "}" and stack > 0:
            stack -= 1
            if stack == 0 and start_index is not None:
                add_candidate(text[start_index:index + 1])
                start_index = None

    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except Exception:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def _normalize_ocr_style_hints(raw_hints: Any) -> dict[str, Any]:
    if not isinstance(raw_hints, dict):
        return {}
    normalized: dict[str, Any] = {}
    for key in (
        "titleLevel",
        "alignment",
        "fontWeightGuess",
        "fontSizeTier",
        "listType",
        "indentLevel",
        "tableStructure",
        "emphasis",
        "sectionRole",
        "underlinePlaceholder",
        "labelValuePattern",
        "confidence",
        "notes",
        "styleSource",
    ):
        value = raw_hints.get(key)
        if value in (None, "", []):
            continue
        normalized[key] = value
    return normalized


def _infer_block_kind_from_text(text: str) -> str:
    stripped = text.strip()
    if not stripped:
        return "paragraph"
    if re.match(r"^\s{0,3}#{1,6}\s", stripped):
        return "heading"
    if re.match(r"^\s*(?:[-*]|\d+\.)\s", stripped):
        return "list_item"
    return "paragraph"


def _should_split_ocr_block(kind: str, text: str, lines: list[str]) -> bool:
    if kind != "paragraph" or len(lines) < 2 or len(lines) > 16:
        return False
    if any(len(line) > 80 for line in lines):
        return False
    average_length = sum(len(line) for line in lines) / max(len(lines), 1)
    has_placeholder = any(re.search(r"[_＿]{2,}|\.{3,}|…{2,}", line) for line in lines)
    return has_placeholder or "\n\n" in text or average_length <= 24


def _expand_ocr_blocks(blocks: list[dict[str, Any]], plain_text: str) -> list[dict[str, Any]]:
    source_blocks = blocks or ([{"kind": "paragraph", "text": plain_text, "styleHints": {}}] if plain_text else [])
    expanded: list[dict[str, Any]] = []

    for block in source_blocks:
        kind = str(block.get("kind") or "paragraph")
        text = _stringify_content(block.get("text")).strip()
        if not text:
            continue
        hints = dict(block.get("styleHints") or {})
        lines = [line.strip() for line in re.split(r"\n+", text) if line.strip()]
        if _should_split_ocr_block(kind, text, lines):
            for line in lines:
                expanded.append({
                    "kind": _infer_block_kind_from_text(line),
                    "text": line,
                    "styleHints": dict(hints),
                })
            continue
        expanded.append({
            "kind": kind,
            "text": text,
            "styleHints": dict(hints),
        })

    return expanded[:24]


def _looks_like_markdown(text: str) -> bool:
    return bool(re.search(r"(^\s{0,3}#{1,6}\s)|(^\s*(?:[-*]|\d+\.)\s)|(^\s*\|.+\|\s*$)", text, flags=re.MULTILINE))


def _compact_text_preview(text: str, limit: int = 220) -> str:
    normalized = re.sub(r"\s+", " ", text).strip()
    if len(normalized) <= limit:
        return normalized
    return normalized[: max(limit - 1, 0)].rstrip() + "…"


def _normalize_ocr_fallback_text(raw_text: str, *, max_lines: int = 80, max_chars: int = 4000) -> tuple[str, list[str]]:
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in raw_text.splitlines()]
    compressed: list[str] = []
    warnings: list[str] = []
    repeat_compressed = False

    previous_line: str | None = None
    repeat_count = 0

    def flush_repeat() -> None:
        nonlocal previous_line, repeat_count, repeat_compressed
        if previous_line is None:
            return
        keep_count = min(repeat_count, 3)
        compressed.extend(previous_line for _ in range(keep_count) if previous_line)
        if repeat_count > 3:
            compressed.append(f"[上行重复 {repeat_count - 3} 次已省略]")
            repeat_compressed = True
        previous_line = None
        repeat_count = 0

    for line in lines:
        if not line:
            flush_repeat()
            if compressed and compressed[-1] != "":
                compressed.append("")
            continue
        if line == previous_line:
            repeat_count += 1
            continue
        flush_repeat()
        previous_line = line
        repeat_count = 1

    flush_repeat()

    while compressed and not compressed[-1]:
        compressed.pop()

    truncated = False
    if len(compressed) > max_lines:
        compressed = compressed[:max_lines]
        truncated = True

    normalized = "\n".join(compressed).strip()
    if len(normalized) > max_chars:
        normalized = normalized[:max_chars].rstrip()
        truncated = True

    if repeat_compressed:
        warnings.append("OCR 纯文本回退结果包含大量重复内容，已压缩显示。")
    if truncated:
        normalized = normalized.rstrip() + "\n[后续内容已截断]"
        warnings.append("OCR 纯文本回退结果过长，已截断显示。")

    return normalized.strip(), warnings


def _has_meaningful_ocr_content(result: dict[str, Any]) -> bool:
    return bool(
        _stringify_content(result.get("plainText")).strip()
        or _stringify_content(result.get("markdown")).strip()
        or _stringify_content(result.get("handwritingText")).strip()
        or result.get("blocks")
        or result.get("tables")
        or result.get("charts")
        or result.get("formulas")
    )


def _normalize_ocr_tables(raw_tables: Any) -> list[dict[str, Any]]:
    tables: list[dict[str, Any]] = []
    for item in raw_tables or []:
        if not isinstance(item, dict):
            continue
        markdown = _stringify_content(item.get("markdown") or item.get("tableMarkdown")).strip()
        title = _stringify_content(item.get("title") or item.get("name")).strip()
        try:
            row_count = int(item.get("rowCount") or 0)
        except Exception:
            row_count = 0
        try:
            column_count = int(item.get("columnCount") or 0)
        except Exception:
            column_count = 0
        if not markdown and not title and row_count <= 0 and column_count <= 0:
            continue
        tables.append({
            "title": title,
            "markdown": markdown,
            "rowCount": max(row_count, 0),
            "columnCount": max(column_count, 0),
        })
    return tables[:12]


def _normalize_ocr_charts(raw_charts: Any) -> list[dict[str, Any]]:
    charts: list[dict[str, Any]] = []
    for item in raw_charts or []:
        if isinstance(item, str):
            text = item.strip()
            if text:
                charts.append({"title": "", "summary": text, "series": []})
            continue
        if not isinstance(item, dict):
            continue
        title = _stringify_content(item.get("title") or item.get("name")).strip()
        summary = _stringify_content(item.get("summary") or item.get("description")).strip()
        series = item.get("series") if isinstance(item.get("series"), list) else []
        axes = item.get("axes") if isinstance(item.get("axes"), dict) else {}
        legend = item.get("legend") if isinstance(item.get("legend"), list) else []
        if not title and not summary and not series and not axes and not legend:
            continue
        charts.append({
            "title": title,
            "summary": summary,
            "series": series,
            "axes": axes,
            "legend": legend,
        })
    return charts[:8]


def _normalize_ocr_formulas(raw_formulas: Any) -> list[dict[str, Any]]:
    formulas: list[dict[str, Any]] = []
    for item in raw_formulas or []:
        if isinstance(item, str):
            text = item.strip()
            if text:
                formulas.append({"latex": text, "text": text})
            continue
        if not isinstance(item, dict):
            continue
        latex = _stringify_content(item.get("latex") or item.get("formula")).strip()
        text = _stringify_content(item.get("text") or item.get("plainText")).strip()
        if not latex and not text:
            continue
        formulas.append({"latex": latex, "text": text})
    return formulas[:16]


def _normalize_ocr_task_result(raw_payload: dict[str, Any], image: dict[str, Any], index: int, task_type: str) -> dict[str, Any]:
    warnings = [str(item).strip() for item in (raw_payload.get("warnings") or []) if str(item).strip()]
    plain_text = _stringify_content(
        raw_payload.get("plainText")
        or raw_payload.get("text")
        or raw_payload.get("handwritingText")
    ).strip()
    markdown = _stringify_content(raw_payload.get("markdown")).strip()
    handwriting_text = _stringify_content(raw_payload.get("handwritingText")).strip()
    summary = _stringify_content(raw_payload.get("summary") or raw_payload.get("layoutNotes")).strip()
    blocks = _expand_ocr_blocks(raw_payload.get("blocks") or [], plain_text) if task_type in {"general_parse", "document_text"} else []
    tables = _normalize_ocr_tables(raw_payload.get("tables"))
    charts = _normalize_ocr_charts(raw_payload.get("charts"))
    formulas = _normalize_ocr_formulas(raw_payload.get("formulas"))

    if not summary:
        if task_type == "table" and tables:
            summary = f"识别到 {len(tables)} 个表格"
        elif task_type == "chart" and charts:
            summary = f"识别到 {len(charts)} 个图表"
        elif task_type == "handwriting" and handwriting_text:
            summary = "已提取手写文字"
        elif task_type == "formula" and formulas:
            summary = f"识别到 {len(formulas)} 条公式"
        elif plain_text:
            summary = "已提取图片中的文字内容"
        else:
            summary = "未提取到明确内容"

    return {
        "imageIndex": index,
        "name": str(image.get("name") or f"image-{index}"),
        "taskType": task_type,
        "summary": summary,
        "plainText": plain_text,
        "markdown": markdown,
        "tables": tables,
        "charts": charts,
        "handwritingText": handwriting_text,
        "formulas": formulas,
        "blocks": blocks[:24],
        "warnings": warnings[:12],
    }


def _append_ocr_warning(result: dict[str, Any], warning: str) -> dict[str, Any]:
    text = warning.strip()
    if not text:
        return result
    warnings = [str(item).strip() for item in (result.get("warnings") or []) if str(item).strip()]
    if text in warnings:
        return result
    result["warnings"] = [*warnings, text][:12]
    return result


def _set_style_source(existing: dict[str, Any], source: str) -> dict[str, Any]:
    current = _stringify_content(existing.get("styleSource")).strip()
    if not current:
        existing["styleSource"] = source
        return existing
    parts = [part for part in current.split("+") if part]
    if source not in parts:
        existing["styleSource"] = "+".join([*parts, source])
    return existing


def _infer_ocr_style_summary(
    raw_style_summary: dict[str, Any],
    plain_text: str,
    markdown: str,
    blocks: list[dict[str, Any]],
    tables: list[dict[str, Any]],
) -> tuple[dict[str, Any], bool]:
    fallback_used = False
    style_summary = dict(raw_style_summary)

    document_type = _stringify_content(style_summary.get("documentType")).strip()
    if document_type in {"", "unknown"}:
        if tables:
            document_type = "table_document"
        elif any(block.get("kind") in {"heading", "title"} for block in blocks) or _looks_like_markdown(markdown):
            document_type = "structured_document"
        elif plain_text:
            document_type = "document"
        else:
            document_type = "unknown"
        fallback_used = True

    dominant_alignment = _stringify_content(style_summary.get("dominantAlignment")).strip()
    if dominant_alignment in {"", "unknown"}:
        align_counts: dict[str, int] = {}
        for block in blocks:
            hints = block.get("styleHints") or {}
            alignment = _stringify_content(hints.get("alignment")).strip()
            if alignment and alignment != "unknown":
                align_counts[alignment] = align_counts.get(alignment, 0) + 1
        dominant_alignment = max(align_counts, key=align_counts.get) if align_counts else "unknown"
        fallback_used = True

    overall_tone = _stringify_content(style_summary.get("overallTone")).strip()
    if overall_tone in {"", "未明确"}:
        overall_tone = "未明确"
        fallback_used = True

    layout_notes = _stringify_content(style_summary.get("layoutNotes")).strip()
    if not layout_notes:
        notes: list[str] = []
        if any(block.get("kind") in {"heading", "title"} for block in blocks) or re.search(r"^\s{0,3}#{1,6}\s", markdown, flags=re.MULTILINE):
            notes.append("检测到标题或分节结构")
        if re.search(r"^\s*(?:[-*]|\d+\.)\s", markdown, flags=re.MULTILINE):
            notes.append("检测到列表结构")
        if tables:
            notes.append(f"检测到 {len(tables)} 个表格")
        if not notes and plain_text:
            notes.append("已提取正文文本，样式线索有限")
        layout_notes = "；".join(notes) if notes else "样式线索有限，建议结合原图复核"
        fallback_used = True

    return {
        "documentType": document_type,
        "dominantAlignment": dominant_alignment,
        "overallTone": overall_tone,
        "layoutNotes": layout_notes,
    }, fallback_used


def _normalize_ocr_style_analysis(raw_result: dict[str, Any] | None, block_count: int) -> dict[str, Any]:
    payload = raw_result if isinstance(raw_result, dict) else {}
    raw_summary = payload.get("styleSummary") if isinstance(payload.get("styleSummary"), dict) else {}
    if not raw_summary and isinstance(payload.get("documentStyleSummary"), dict):
        raw_summary = payload.get("documentStyleSummary") or {}

    block_styles: list[dict[str, Any]] = []
    for item in payload.get("blockStyles") or payload.get("styles") or []:
        if not isinstance(item, dict):
            continue
        try:
            block_index = int(item.get("blockIndex") or 0)
        except Exception:
            continue
        if block_index < 1 or block_index > block_count:
            continue
        raw_hints = item.get("styleHints") if isinstance(item.get("styleHints"), dict) else item
        hints = _normalize_ocr_style_hints(raw_hints)
        if not hints:
            continue
        hints = _set_style_source(hints, "ocr_style_pass")
        block_styles.append({
            "blockIndex": block_index,
            "styleHints": hints,
        })

    warnings = [str(item).strip() for item in (payload.get("warnings") or []) if str(item).strip()]
    return {
        "styleSummary": {
            "documentType": _stringify_content(raw_summary.get("documentType")).strip(),
            "dominantAlignment": _stringify_content(raw_summary.get("dominantAlignment")).strip(),
            "overallTone": _stringify_content(raw_summary.get("overallTone")).strip(),
            "layoutNotes": _stringify_content(raw_summary.get("layoutNotes")).strip(),
        },
        "blockStyles": block_styles,
        "warnings": warnings[:12],
    }


def _merge_ocr_style_analysis(base_result: dict[str, Any], style_analysis: dict[str, Any] | None) -> dict[str, Any]:
    if not style_analysis:
        return base_result

    result = dict(base_result)
    blocks = [
        {
            "kind": str(block.get("kind") or "paragraph"),
            "text": _stringify_content(block.get("text")).strip(),
            "styleHints": dict(block.get("styleHints") or {}),
        }
        for block in (base_result.get("blocks") or [])
        if _stringify_content(block.get("text")).strip()
    ]

    for item in style_analysis.get("blockStyles") or []:
        if not isinstance(item, dict):
            continue
        block_index = int(item.get("blockIndex") or 0) - 1
        if block_index < 0 or block_index >= len(blocks):
            continue
        block = dict(blocks[block_index])
        merged_hints = dict(block.get("styleHints") or {})
        for key, value in (item.get("styleHints") or {}).items():
            if value in (None, "", []):
                continue
            merged_hints[key] = value
        if merged_hints.get("titleLevel") and block.get("kind") == "paragraph":
            block["kind"] = "heading"
        elif merged_hints.get("listType") not in (None, "", "none") and block.get("kind") == "paragraph":
            block["kind"] = "list_item"
        elif merged_hints.get("sectionRole") in {"cover_title", "body_heading"} and block.get("kind") == "paragraph":
            block["kind"] = "heading"
        block["styleHints"] = merged_hints
        blocks[block_index] = block

    merged_summary = dict(base_result.get("styleSummary") or {})
    for key, value in (style_analysis.get("styleSummary") or {}).items():
        if value in (None, "", "unknown", "未明确"):
            continue
        merged_summary[key] = value

    result["blocks"] = blocks[:24]
    result["styleSummary"] = merged_summary
    for warning in style_analysis.get("warnings") or []:
        result = _append_ocr_warning(result, str(warning))
    return result


def _apply_ocr_style_heuristics(result: dict[str, Any]) -> dict[str, Any]:
    blocks = [
        {
            "kind": str(block.get("kind") or "paragraph"),
            "text": _stringify_content(block.get("text")).strip(),
            "styleHints": dict(block.get("styleHints") or {}),
        }
        for block in (result.get("blocks") or [])
        if _stringify_content(block.get("text")).strip()
    ]
    if not blocks:
        return result

    total = len(blocks)
    placeholder_count = 0
    heading_count = 0

    for index, block in enumerate(blocks):
        text = block["text"]
        hints = dict(block.get("styleHints") or {})
        line_length = len(text)
        added_by_heuristic = False

        if "underlinePlaceholder" not in hints and bool(re.search(r"[_＿]{2,}", text)):
            hints["underlinePlaceholder"] = True
            added_by_heuristic = True
        if hints.get("underlinePlaceholder"):
            placeholder_count += 1

        if "labelValuePattern" not in hints and bool(re.search(r"^[\u4e00-\u9fffA-Za-z0-9（）()《》、·\-\s]+[:：]?\s*[_＿]{2,}$", text)):
            hints["labelValuePattern"] = True
            added_by_heuristic = True

        if not hints.get("sectionRole"):
            if hints.get("labelValuePattern") or hints.get("underlinePlaceholder"):
                hints["sectionRole"] = "cover_field" if total <= 10 else "form_field"
                added_by_heuristic = True
            elif index == 0 and line_length <= 24 and not re.search(r"[_＿]{2,}", text):
                hints["sectionRole"] = "cover_title"
                added_by_heuristic = True
            elif index == total - 1 and re.search(r"(?:19|20)\d{2}|20xx", text, flags=re.IGNORECASE):
                hints["sectionRole"] = "date"
                added_by_heuristic = True

        if not hints.get("titleLevel"):
            if hints.get("sectionRole") == "cover_title":
                hints["titleLevel"] = 1
                added_by_heuristic = True
            elif index < 3 and line_length <= 18 and not hints.get("underlinePlaceholder") and not re.search(r"[。；，：:]$", text):
                hints["titleLevel"] = 2
                hints.setdefault("sectionRole", "body_heading")
                added_by_heuristic = True

        if hints.get("titleLevel"):
            heading_count += 1
            if block.get("kind") == "paragraph":
                block["kind"] = "heading"
            if not hints.get("fontWeightGuess"):
                hints["fontWeightGuess"] = "bold"
                added_by_heuristic = True
            if not hints.get("fontSizeTier"):
                hints["fontSizeTier"] = "xlarge" if hints.get("titleLevel") == 1 else "large"
                added_by_heuristic = True
            if not hints.get("alignment") and hints.get("sectionRole") == "cover_title":
                hints["alignment"] = "center"
                added_by_heuristic = True

        if not hints.get("listType") and re.match(r"^\s*(?:[-*]|\d+\.)\s", text):
            hints["listType"] = "ordered" if re.match(r"^\s*\d+\.\s", text) else "bullet"
            if block.get("kind") == "paragraph":
                block["kind"] = "list_item"
            added_by_heuristic = True

        if hints.get("labelValuePattern"):
            if not hints.get("fontSizeTier"):
                hints["fontSizeTier"] = "medium"
                added_by_heuristic = True
            if not hints.get("alignment"):
                hints["alignment"] = "left"
                added_by_heuristic = True

        if added_by_heuristic:
            hints = _set_style_source(hints, "heuristic")
            hints.setdefault("confidence", "low")

        block["styleHints"] = _normalize_ocr_style_hints(hints)
        blocks[index] = block

    result = dict(result)
    result["blocks"] = blocks[:24]
    if placeholder_count >= 3:
        result["styleSummary"] = {
            **dict(result.get("styleSummary") or {}),
            "documentType": "cover_form",
        }
        result = _append_ocr_warning(result, "检测到多处下划线占位，已按封面/表单结构补充样式线索。")
    elif heading_count >= 1 and _stringify_content((result.get("styleSummary") or {}).get("documentType")).strip() in {"", "document", "unknown"}:
        result["styleSummary"] = {
            **dict(result.get("styleSummary") or {}),
            "documentType": "structured_document",
        }
    return result


def _refresh_ocr_style_summary(result: dict[str, Any]) -> dict[str, Any]:
    summary, fallback_used = _infer_ocr_style_summary(
        dict(result.get("styleSummary") or {}),
        _stringify_content(result.get("plainText")).strip(),
        _stringify_content(result.get("markdown")).strip(),
        list(result.get("blocks") or []),
        list(result.get("tables") or []),
    )
    next_result = dict(result)
    next_result["styleSummary"] = summary
    if fallback_used and _has_meaningful_ocr_content(next_result):
        next_result = _append_ocr_warning(next_result, "部分样式摘要仍由结构与启发式规则推断生成，建议结合原图复核。")
    return next_result


def _build_ocr_style_analysis_user_text(result: dict[str, Any]) -> str:
    blocks_payload = []
    for index, block in enumerate(result.get("blocks") or [], start=1):
        blocks_payload.append({
            "blockIndex": index,
            "kind": block.get("kind") or "paragraph",
            "text": _stringify_content(block.get("text")).strip()[:200],
        })

    summary = result.get("styleSummary") or {}
    return (
        "请根据原图和以下已提取文本块，只补充对文档排版真正有用的样式线索。"
        "重点判断：标题层级、对齐、字体粗细、字号层级、列表、缩进、封面字段、下划线占位。\n\n"
        f"styleSummary = {json.dumps(summary, ensure_ascii=False)}\n"
        f"blocks = {json.dumps(blocks_payload, ensure_ascii=False, indent=2)}\n\n"
        "如果某个 block 像“题目 ____ / 指导老师 ____ / 姓名 ____”，请优先标记 underlinePlaceholder=true 和 labelValuePattern=true。"
    )


async def _call_ocr_style_analysis_for_image(
    ocr_config: OCRConfig,
    image: dict[str, Any],
    index: int,
    ocr_result: dict[str, Any],
) -> dict[str, Any] | None:
    blocks = ocr_result.get("blocks") or []
    if not blocks:
        return None

    headers = {"Content-Type": "application/json"}
    if ocr_config.apiKey:
        headers["Authorization"] = f"Bearer {ocr_config.apiKey}"

    base_payload = {
        "model": ocr_config.model,
        "temperature": 0.1,
        "max_tokens": 2200,
        "messages": [
            {"role": "system", "content": OCR_STYLE_ANALYSIS_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": _build_ocr_style_analysis_user_text(ocr_result),
                    },
                    {
                        "type": "image_url",
                        "image_url": {"url": str(image.get("dataUrl") or "")},
                    },
                ],
            },
        ],
    }
    attempts = [
        {**base_payload, "response_format": {"type": "json_object"}},
        base_payload,
    ]
    last_error = ""

    async with httpx.AsyncClient(timeout=float(ocr_config.timeoutSeconds)) as client:
        for payload in attempts:
            attempt_label = "style_json_object" if payload.get("response_format") is not None else "style_plain"
            try:
                response = await client.post(f"{ocr_config.endpoint}/chat/completions", headers=headers, json=payload)
                response.raise_for_status()
                body = response.json()
            except httpx.HTTPStatusError as exc:
                detail = _sanitize_upstream_error_detail(exc.response.text.strip() or str(exc), status_code=exc.response.status_code)
                last_error = detail
                logger.warning(
                    "[openwps.ocr] image=%s attempt=%s http_error status=%s endpoint=%s model=%s detail=%s",
                    index,
                    attempt_label,
                    exc.response.status_code,
                    ocr_config.endpoint,
                    ocr_config.model,
                    _compact_text_preview(detail),
                )
                if payload.get("response_format") is not None and exc.response.status_code in {400, 404, 422}:
                    continue
                return None
            except Exception as exc:
                logger.warning(
                    "[openwps.ocr] image=%s attempt=%s request_error endpoint=%s model=%s error=%s",
                    index,
                    attempt_label,
                    ocr_config.endpoint,
                    ocr_config.model,
                    exc,
                )
                return None

            content, finish_reason = _extract_ocr_response_content(body)
            logger.info(
                "[openwps.ocr] image=%s attempt=%s finish_reason=%s content_preview=%s",
                index,
                attempt_label,
                finish_reason or "-",
                _compact_text_preview(content or "<empty>"),
            )

            parsed = _extract_json_object(content)
            if parsed is not None:
                normalized = _normalize_ocr_style_analysis(parsed, len(blocks))
                if normalized.get("blockStyles") or normalized.get("styleSummary"):
                    return normalized
                last_error = "样式分析返回了 JSON，但没有可用的 blockStyles。"
                continue

            last_error = _compact_text_preview(content or "样式分析返回为空")

    if last_error:
        logger.warning("[openwps.ocr] image=%s style_analysis_skipped detail=%s", index, last_error)
    return None


def _build_fallback_ocr_payload(raw_text: str, finish_reason: str) -> dict[str, Any] | None:
    cleaned = raw_text.strip()
    if not cleaned:
        return None

    cleaned = re.sub(r"^```(?:json|markdown|md|text)?\s*", "", cleaned, flags=re.IGNORECASE).strip()
    cleaned = re.sub(r"\s*```$", "", cleaned).strip()
    if not cleaned:
        return None
    if cleaned.startswith("{") or cleaned.startswith("["):
        return None

    cleaned, extra_warnings = _normalize_ocr_fallback_text(cleaned)
    if not cleaned:
        return None

    warnings = ["OCR 返回了非 JSON 文本，已按纯文本结果回退；样式信息可能不完整。"]
    warnings.extend(extra_warnings)
    if _is_output_truncated_finish_reason(finish_reason):
        warnings.append("OCR 输出可能因响应长度限制被截断，请结合原图复核。")

    return {
        "plainText": cleaned,
        "markdown": cleaned if _looks_like_markdown(cleaned) else "",
        "blocks": [{"kind": "paragraph", "text": cleaned, "styleHints": {}}],
        "tables": [],
        "warnings": warnings,
    }


def _build_fallback_task_payload(raw_text: str, finish_reason: str, task_type: str) -> dict[str, Any] | None:
    fallback = _build_fallback_ocr_payload(raw_text, finish_reason)
    if fallback is None:
        return None

    return {
        "taskType": task_type,
        "summary": "OCR 返回了纯文本结果",
        **fallback,
        "charts": [],
        "handwritingText": fallback.get("plainText") if task_type == "handwriting" else "",
        "formulas": [],
    }


def _extract_ocr_response_content(body: Any) -> tuple[str, str]:
    finish_reason = _extract_finish_reason(body)
    candidates: list[str] = []

    def add_candidate(value: Any) -> None:
        text = _stringify_content(value).strip()
        if text:
            candidates.append(text)

    if isinstance(body, dict):
        add_candidate(body.get("output_text"))
        add_candidate(body.get("text"))

        choices = body.get("choices")
        if isinstance(choices, list):
            for choice in choices[:2]:
                if not isinstance(choice, dict):
                    continue
                message = choice.get("message")
                if isinstance(message, dict):
                    add_candidate(message.get("content"))
                    add_candidate(message.get("text"))
                add_candidate(choice.get("content"))
                add_candidate(choice.get("text"))
                delta = choice.get("delta")
                if isinstance(delta, dict):
                    add_candidate(delta.get("content"))

        output = body.get("output")
        if isinstance(output, list):
            for item in output[:2]:
                if not isinstance(item, dict):
                    continue
                add_candidate(item.get("content"))
                add_candidate(item.get("text"))

    return (candidates[0] if candidates else ""), finish_reason


def _normalize_ocr_result(raw_result: dict[str, Any] | None, image: dict[str, Any], index: int) -> dict[str, Any]:
    payload = raw_result if isinstance(raw_result, dict) else {}
    blocks: list[dict[str, Any]] = []
    for block in payload.get("blocks") or []:
        if not isinstance(block, dict):
            continue
        text = _stringify_content(block.get("text")).strip()
        if not text:
            continue
        blocks.append({
            "kind": str(block.get("kind") or "paragraph"),
            "text": text,
            "styleHints": _normalize_ocr_style_hints(block.get("styleHints")),
        })

    tables: list[dict[str, Any]] = []
    for table in payload.get("tables") or []:
        if not isinstance(table, dict):
            continue
        title = _stringify_content(table.get("title")).strip()
        markdown = _stringify_content(table.get("markdown")).strip()
        if not title and not markdown:
            continue
        tables.append({
            "title": title,
            "markdown": markdown,
            "rowCount": int(table.get("rowCount") or 0),
            "columnCount": int(table.get("columnCount") or 0),
        })

    style_summary = payload.get("styleSummary") if isinstance(payload.get("styleSummary"), dict) else {}
    warnings = [str(item).strip() for item in (payload.get("warnings") or []) if str(item).strip()]
    plain_text = _stringify_content(payload.get("plainText") or payload.get("text")).strip()
    markdown = _stringify_content(payload.get("markdown")).strip()
    blocks = _expand_ocr_blocks(blocks, plain_text)
    resolved_style_summary, fallback_used = _infer_ocr_style_summary(style_summary, plain_text, markdown, blocks, tables)
    if fallback_used and (plain_text or markdown or blocks or tables):
        warnings.insert(0, "styleSummary 未完整返回，已根据 OCR 提取到的结构生成默认样式摘要。")

    result = {
        "imageIndex": index,
        "name": str(image.get("name") or f"image-{index}"),
        "plainText": plain_text,
        "markdown": markdown,
        "styleSummary": resolved_style_summary,
        "blocks": blocks[:24],
        "tables": tables[:12],
        "warnings": warnings[:12],
    }
    result = _apply_ocr_style_heuristics(result)
    return _refresh_ocr_style_summary(result)


def _build_endpoint_url(base: str, path: str) -> str:
    normalized_base = str(base or "").strip().rstrip("/")
    normalized_path = "/" + path.lstrip("/")
    if normalized_base.endswith(normalized_path):
        return normalized_base
    return normalized_base + normalized_path


def _extract_paddleocr_service_inputs(image: dict[str, Any], index: int) -> tuple[str, int]:
    data_url = str(image.get("dataUrl") or "").strip()
    parsed = _parse_data_url_header(data_url)
    if not parsed:
        raise HTTPException(status_code=400, detail=f"第 {index} 张图片格式无效")

    header, payload = parsed
    mime = header[5:].split(";", 1)[0].strip().lower()
    if not payload:
        raise HTTPException(status_code=400, detail=f"第 {index} 张图片内容为空")
    if mime == "application/pdf":
        return payload, 0
    if not mime.startswith("image/"):
        raise HTTPException(status_code=400, detail=f"第 {index} 张图片不是支持的图片格式")
    return payload, 1


def _build_paddleocr_service_payload(
    image: dict[str, Any],
    index: int,
    task_type: str,
    instruction: str | None = None,
) -> dict[str, Any]:
    file_payload, file_type = _extract_paddleocr_service_inputs(image, index)
    normalized_task = _normalize_ocr_task_type(task_type)
    payload: dict[str, Any] = {
        "file": file_payload,
        "fileType": file_type,
        "useDocOrientationClassify": False,
        "useDocUnwarping": False,
        "useLayoutDetection": True,
        "useChartRecognition": normalized_task in {"chart", "general_parse"},
        "useSealRecognition": False,
        "useOcrForImageBlock": True,
        "formatBlockContent": True,
        "mergeLayoutBlocks": normalized_task in {"general_parse", "document_text"},
        "prettifyMarkdown": True,
        "showFormulaNumber": normalized_task == "formula",
    }
    if normalized_task == "handwriting":
        payload["useLayoutDetection"] = False
        payload["promptLabel"] = "ocr"
    return payload


def _extract_paddleocr_service_results(body: dict[str, Any]) -> list[dict[str, Any]]:
    candidates: Any = None
    if isinstance(body.get("result"), dict):
        candidates = body["result"].get("layoutParsingResults")
    if not isinstance(candidates, list):
        candidates = body.get("layoutParsingResults")
    if isinstance(candidates, list):
        return [item for item in candidates if isinstance(item, dict)]
    return []


def _extract_paddleocr_markdown(result: dict[str, Any]) -> str:
    markdown = result.get("markdown")
    if isinstance(markdown, dict):
        return _stringify_content(markdown.get("text") or markdown.get("content") or markdown.get("markdown")).strip()
    return _stringify_content(markdown).strip()


def _extract_paddleocr_parsing_items(result: dict[str, Any]) -> list[dict[str, Any]]:
    pruned = result.get("prunedResult")
    if not isinstance(pruned, dict):
        return []
    items = pruned.get("parsing_res_list")
    if not isinstance(items, list):
        items = pruned.get("parsingResList")
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


def _normalize_paddleocr_block_kind(value: Any) -> str:
    normalized = str(value or "paragraph").strip().lower().replace("-", "_")
    if normalized in {"doc_title", "title", "heading"}:
        return "heading"
    if normalized in {"table"}:
        return "table"
    if normalized in {"chart", "figure"}:
        return "chart"
    if normalized in {"formula", "equation", "math"}:
        return "formula"
    if normalized in {"list", "ordered_list", "unordered_list"}:
        return "list"
    return "paragraph"


def _extract_paddleocr_structured_content(result: dict[str, Any]) -> dict[str, Any]:
    parsing_items = _extract_paddleocr_parsing_items(result)
    markdown = _extract_paddleocr_markdown(result)
    blocks: list[dict[str, Any]] = []
    tables: list[dict[str, Any]] = []
    charts: list[dict[str, Any]] = []
    formulas: list[dict[str, Any]] = []
    plain_text_parts: list[str] = []

    for item in parsing_items:
        label = item.get("block_label") or item.get("blockLabel") or item.get("type")
        kind = _normalize_paddleocr_block_kind(label)
        content = _stringify_content(
            item.get("block_content")
            or item.get("blockContent")
            or item.get("text")
            or item.get("markdown")
        ).strip()
        if content:
            blocks.append({
                "kind": kind,
                "text": content,
                "styleHints": {},
            })

        if kind == "table" and (content or markdown):
            tables.append({
                "title": "",
                "markdown": content or markdown,
                "rowCount": 0,
                "columnCount": 0,
            })
        elif kind == "chart" and content:
            charts.append({"title": "", "summary": content, "series": []})
        elif kind == "formula" and content:
            formulas.append({"latex": content, "text": content})

        if content and kind not in {"table", "chart"}:
            plain_text_parts.append(content)

    plain_text = "\n".join(part for part in plain_text_parts if part).strip()
    if not plain_text:
        plain_text = markdown.strip()

    return {
        "plainText": plain_text,
        "markdown": markdown,
        "blocks": blocks[:24],
        "tables": tables[:12],
        "charts": charts[:8],
        "formulas": formulas[:16],
    }


async def _call_paddleocr_service_layout_parsing(
    ocr_config: OCRConfig,
    image: dict[str, Any],
    index: int,
    task_type: str,
    instruction: str | None = None,
) -> dict[str, Any]:
    headers = {"Content-Type": "application/json"}
    if ocr_config.apiKey:
        headers["Authorization"] = f"Bearer {ocr_config.apiKey}"

    payload = _build_paddleocr_service_payload(image, index, task_type, instruction)
    endpoint = _build_endpoint_url(ocr_config.endpoint, "/layout-parsing")
    async with httpx.AsyncClient(timeout=float(ocr_config.timeoutSeconds)) as client:
        try:
            response = await client.post(endpoint, headers=headers, json=payload)
            response.raise_for_status()
            body = response.json()
        except httpx.HTTPStatusError as exc:
            detail = _sanitize_upstream_error_detail(exc.response.text.strip() or str(exc), status_code=exc.response.status_code)
            logger.warning(
                "[openwps.ocr.service] image=%s task=%s http_error status=%s endpoint=%s detail=%s",
                index,
                _normalize_ocr_task_type(task_type),
                exc.response.status_code,
                endpoint,
                _compact_text_preview(detail),
            )
            raise HTTPException(status_code=502, detail=f"PaddleOCR 服务请求失败: {detail}") from exc
        except Exception as exc:
            logger.warning(
                "[openwps.ocr.service] image=%s task=%s request_error endpoint=%s error=%s",
                index,
                _normalize_ocr_task_type(task_type),
                endpoint,
                exc,
            )
            raise HTTPException(status_code=502, detail=f"PaddleOCR 服务请求失败: {_sanitize_upstream_error_detail(str(exc))}") from exc

    results = _extract_paddleocr_service_results(body if isinstance(body, dict) else {})
    if not results:
        logger.warning(
            "[openwps.ocr.service] image=%s task=%s empty_result preview=%s",
            index,
            _normalize_ocr_task_type(task_type),
            _compact_text_preview(json.dumps(body, ensure_ascii=False) if isinstance(body, dict) else str(body)),
        )
        raise HTTPException(status_code=502, detail="PaddleOCR 服务未返回 layoutParsingResults")
    return results[0]


def _normalize_paddleocr_service_image_result(
    service_result: dict[str, Any],
    image: dict[str, Any],
    index: int,
) -> dict[str, Any]:
    structured = _extract_paddleocr_structured_content(service_result)
    warnings = [
        "当前 OCR 使用 PaddleOCR 官方 layout-parsing 服务，返回结果以文档结构解析为主，样式摘要主要根据版面块推断。",
    ]
    raw = {
        **structured,
        "warnings": warnings,
        "styleSummary": {
            "documentType": None,
            "dominantAlignment": None,
            "overallTone": None,
            "layoutNotes": "官方服务模式返回结构化版面块与 Markdown，适合识别型任务。",
        },
    }
    return _normalize_ocr_result(raw, image, index)


def _normalize_paddleocr_service_task_result(
    service_result: dict[str, Any],
    image: dict[str, Any],
    index: int,
    task_type: str,
    instruction: str | None = None,
) -> dict[str, Any]:
    structured = _extract_paddleocr_structured_content(service_result)
    warnings: list[str] = []
    if instruction and instruction.strip():
        warnings.append("当前官方 PaddleOCR 服务模式主要按任务类型做结构化解析，自由文本指令不会像聊天模型那样完整透传。")

    handwriting_text = structured["plainText"] if task_type == "handwriting" else ""
    raw_payload: dict[str, Any] = {
        **structured,
        "warnings": warnings,
        "handwritingText": handwriting_text,
    }
    if task_type == "table" and not structured["tables"] and structured["markdown"]:
        raw_payload["tables"] = [{
            "title": "",
            "markdown": structured["markdown"],
            "rowCount": 0,
            "columnCount": 0,
        }]
    if task_type == "formula" and not structured["formulas"] and structured["plainText"]:
        raw_payload["formulas"] = [{
            "latex": structured["plainText"],
            "text": structured["plainText"],
        }]
    return _normalize_ocr_task_result(raw_payload, image, index, task_type)


async def _call_ocr_model_for_image(ocr_config: OCRConfig, image: dict[str, Any], index: int) -> dict[str, Any]:
    if _normalize_ocr_backend(ocr_config.backend) == OCR_BACKEND_PADDLEOCR_SERVICE:
        service_result = await _call_paddleocr_service_layout_parsing(ocr_config, image, index, "general_parse")
        return _normalize_paddleocr_service_image_result(service_result, image, index)

    headers = {"Content-Type": "application/json"}
    if ocr_config.apiKey:
        headers["Authorization"] = f"Bearer {ocr_config.apiKey}"

    base_payload = {
        "model": ocr_config.model,
        "temperature": 0.1,
        "max_tokens": 3200,
        "messages": [
            {"role": "system", "content": OCR_ANALYSIS_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "请提取图片中的正文、标题层级、列表、表格和样式线索，返回严格 JSON。",
                    },
                    {
                        "type": "image_url",
                        "image_url": {"url": str(image.get("dataUrl") or "")},
                    },
                ],
            },
        ],
    }
    attempts = [
        {**base_payload, "response_format": {"type": "json_object"}},
        base_payload,
    ]
    last_error = ""

    async with httpx.AsyncClient(timeout=float(ocr_config.timeoutSeconds)) as client:
        for attempt_index, payload in enumerate(attempts, start=1):
            attempt_label = "json_object" if payload.get("response_format") is not None else "plain"
            try:
                response = await client.post(f"{ocr_config.endpoint}/chat/completions", headers=headers, json=payload)
                response.raise_for_status()
                body = response.json()
            except httpx.HTTPStatusError as exc:
                detail = _sanitize_upstream_error_detail(exc.response.text.strip() or str(exc), status_code=exc.response.status_code)
                last_error = detail
                logger.warning(
                    "[openwps.ocr] image=%s attempt=%s http_error status=%s endpoint=%s model=%s detail=%s",
                    index,
                    attempt_label,
                    exc.response.status_code,
                    ocr_config.endpoint,
                    ocr_config.model,
                    _compact_text_preview(detail),
                )
                if payload.get("response_format") is not None and exc.response.status_code in {400, 404, 422}:
                    continue
                raise HTTPException(status_code=502, detail=f"OCR 模型请求失败: {detail}") from exc
            except Exception as exc:
                logger.warning(
                    "[openwps.ocr] image=%s attempt=%s request_error endpoint=%s model=%s error=%s",
                    index,
                    attempt_label,
                    ocr_config.endpoint,
                    ocr_config.model,
                    exc,
                )
                raise HTTPException(status_code=502, detail=f"OCR 模型请求失败: {_sanitize_upstream_error_detail(str(exc))}") from exc

            content, finish_reason = _extract_ocr_response_content(body)
            logger.info(
                "[openwps.ocr] image=%s attempt=%s finish_reason=%s content_preview=%s",
                index,
                attempt_label,
                finish_reason or "-",
                _compact_text_preview(content or "<empty>"),
            )

            parsed = _extract_json_object(content)
            if parsed is not None:
                normalized = _normalize_ocr_result(parsed, image, index)
                if _is_output_truncated_finish_reason(finish_reason):
                    normalized = _append_ocr_warning(normalized, "OCR 输出可能因响应长度限制被截断，请结合原图复核。")
                if _has_meaningful_ocr_content(normalized):
                    style_analysis = await _call_ocr_style_analysis_for_image(ocr_config, image, index, normalized)
                    enhanced = _merge_ocr_style_analysis(normalized, style_analysis)
                    enhanced = _apply_ocr_style_heuristics(enhanced)
                    enhanced = _refresh_ocr_style_summary(enhanced)
                    return enhanced
                last_error = "OCR 返回了 JSON，但未提取到可用正文、表格或结构信息。"
                logger.warning(
                    "[openwps.ocr] image=%s attempt=%s parsed_json_without_content preview=%s",
                    index,
                    attempt_label,
                    _compact_text_preview(content or "<empty>"),
                )
                continue

            fallback_payload = _build_fallback_ocr_payload(content, finish_reason)
            if fallback_payload is not None:
                logger.warning(
                    "[openwps.ocr] image=%s attempt=%s fallback_to_plain_text preview=%s",
                    index,
                    attempt_label,
                    _compact_text_preview(content),
                )
                return _normalize_ocr_result(fallback_payload, image, index)

            last_error = f"OCR 返回不可解析内容（finish_reason={finish_reason or '-' }）: {_compact_text_preview(content or 'OCR 返回为空')}"
            logger.warning(
                "[openwps.ocr] image=%s attempt=%s unparseable_response preview=%s",
                index,
                attempt_label,
                _compact_text_preview(content or "<empty>"),
            )

    raise HTTPException(status_code=502, detail=f"OCR 结果解析失败: {last_error}")


async def _process_ocr_images(body: ChatRequest, ocr_config: OCRConfig) -> list[dict[str, Any]]:
    images = body.images or []
    if not images:
        return []
    tasks = [
        _call_ocr_model_for_image(ocr_config, image, index)
        for index, image in enumerate(images, start=1)
    ]
    return await asyncio.gather(*tasks)


async def _call_ocr_model_for_task(
    ocr_config: OCRConfig,
    image: dict[str, Any],
    index: int,
    task_type: str,
    instruction: str | None,
) -> dict[str, Any]:
    normalized_task = _normalize_ocr_task_type(task_type)
    if _normalize_ocr_backend(ocr_config.backend) == OCR_BACKEND_PADDLEOCR_SERVICE:
        service_result = await _call_paddleocr_service_layout_parsing(ocr_config, image, index, normalized_task, instruction)
        return _normalize_paddleocr_service_task_result(service_result, image, index, normalized_task, instruction)

    headers = {"Content-Type": "application/json"}
    if ocr_config.apiKey:
        headers["Authorization"] = f"Bearer {ocr_config.apiKey}"

    base_payload = {
        "model": ocr_config.model,
        "temperature": 0.1,
        "max_tokens": 3200,
        "messages": [
            {"role": "system", "content": OCR_ANALYSIS_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": _build_ocr_user_instruction(normalized_task, instruction),
                    },
                    {
                        "type": "image_url",
                        "image_url": {"url": str(image.get("dataUrl") or "")},
                    },
                ],
            },
        ],
    }
    attempts = [
        {**base_payload, "response_format": {"type": "json_object"}},
        base_payload,
    ]
    last_error = ""

    async with httpx.AsyncClient(timeout=float(ocr_config.timeoutSeconds)) as client:
        for payload in attempts:
            attempt_label = "json_object" if payload.get("response_format") is not None else "plain"
            try:
                response = await client.post(f"{ocr_config.endpoint}/chat/completions", headers=headers, json=payload)
                response.raise_for_status()
                body = response.json()
            except httpx.HTTPStatusError as exc:
                detail = _sanitize_upstream_error_detail(exc.response.text.strip() or str(exc), status_code=exc.response.status_code)
                last_error = detail
                logger.warning(
                    "[openwps.ocr.task] image=%s task=%s attempt=%s http_error status=%s endpoint=%s model=%s detail=%s",
                    index,
                    normalized_task,
                    attempt_label,
                    exc.response.status_code,
                    ocr_config.endpoint,
                    ocr_config.model,
                    _compact_text_preview(detail),
                )
                if payload.get("response_format") is not None and exc.response.status_code in {400, 404, 422}:
                    continue
                raise HTTPException(status_code=502, detail=f"OCR 模型请求失败: {detail}") from exc
            except Exception as exc:
                logger.warning(
                    "[openwps.ocr.task] image=%s task=%s attempt=%s request_error endpoint=%s model=%s error=%s",
                    index,
                    normalized_task,
                    attempt_label,
                    ocr_config.endpoint,
                    ocr_config.model,
                    exc,
                )
                raise HTTPException(status_code=502, detail=f"OCR 模型请求失败: {_sanitize_upstream_error_detail(str(exc))}") from exc

            content, finish_reason = _extract_ocr_response_content(body)
            parsed = _extract_json_object(content)
            if parsed is not None:
                normalized = _normalize_ocr_task_result(parsed, image, index, normalized_task)
                if _is_output_truncated_finish_reason(finish_reason):
                    normalized = _append_ocr_warning(normalized, "OCR 输出可能因响应长度限制被截断，请结合原图复核。")
                if _has_meaningful_ocr_content(normalized):
                    return normalized
                last_error = "OCR 返回了 JSON，但未提取到可用内容。"
                continue

            fallback_payload = _build_fallback_task_payload(content, finish_reason, normalized_task)
            if fallback_payload is not None:
                return _normalize_ocr_task_result(fallback_payload, image, index, normalized_task)

            last_error = f"OCR 返回不可解析内容（finish_reason={finish_reason or '-'})"

    raise HTTPException(status_code=502, detail=f"OCR 结果解析失败: {last_error}")


def _select_ocr_images(images: list[dict[str, Any]], image_indices: list[int]) -> list[tuple[int, dict[str, Any]]]:
    if not image_indices:
        return list(enumerate(images, start=1))

    selected: list[tuple[int, dict[str, Any]]] = []
    seen: set[int] = set()
    for raw_index in image_indices:
        try:
            image_index = int(raw_index)
        except Exception:
            continue
        if image_index < 1 or image_index > len(images) or image_index in seen:
            continue
        seen.add(image_index)
        selected.append((image_index, images[image_index - 1]))
    return selected


async def analyze_images_with_ocr(body: OCRCommandRequest) -> dict[str, Any]:
    images = body.images or []
    if not images:
        raise HTTPException(status_code=400, detail="未提供可识别的图片")

    task_type = _normalize_ocr_task_type(body.taskType)
    ocr_config = _resolve_ocr_config(body.ocrConfig)
    selected_images = _select_ocr_images(images, body.imageIndices)
    if not selected_images:
        raise HTTPException(status_code=400, detail="没有可用的 OCR 图片索引")

    pseudo_request = ChatRequest(
        message=body.instruction or "",
        images=[image for _, image in selected_images],
        ocrConfig=ocr_config,
    )
    _validate_ocr_request(pseudo_request, ocr_config)

    results = await asyncio.gather(*[
        _call_ocr_model_for_task(ocr_config, image, image_index, task_type, body.instruction)
        for image_index, image in selected_images
    ])

    return {
        "taskType": task_type,
        "imageCount": len(selected_images),
        "results": results,
    }


def _format_ocr_results_for_model(ocr_results: list[dict[str, Any]]) -> str:
    parts = [
        "[OCR 识别结果]",
        "以下内容由 OCR 模型从图片中提取，包含正文、表格和样式线索。请优先使用 blocks[*].styleHints 中的标题层级、对齐、字号层级、占位线、表单字段等线索来复现内容和样式；不确定处可说明。",
    ]
    for result in ocr_results:
        parts.append("")
        parts.append(f"图片 {result.get('imageIndex')}: {result.get('name')}")
        style_summary = result.get("styleSummary") or {}
        if style_summary:
            parts.append("styleSummary = " + json.dumps(style_summary, ensure_ascii=False))
        markdown = _stringify_content(result.get("markdown")).strip()
        if markdown:
            parts.append("markdown:\n" + markdown)
        plain_text = _stringify_content(result.get("plainText")).strip()
        if plain_text and plain_text != markdown:
            parts.append("plainText:\n" + plain_text[:3000])
        tables = result.get("tables") or []
        if tables:
            parts.append("tables = " + json.dumps(tables, ensure_ascii=False, indent=2))
        blocks = result.get("blocks") or []
        if blocks:
            parts.append("blocks = " + json.dumps(blocks, ensure_ascii=False, indent=2))
        warnings = result.get("warnings") or []
        if warnings:
            parts.append("warnings = " + json.dumps(warnings, ensure_ascii=False))
    return "\n".join(parts)


def _format_text_attachments_for_model(attachments: list[dict[str, Any]] | None) -> str:
    return str(format_text_attachments_for_model(attachments).content or "")


async def prepare_chat_request(body: ChatRequest) -> ChatRequest:
    prepared = body.model_copy(update={
        "imageProcessingMode": DEFAULT_IMAGE_PROCESSING_MODE,
        "ocrResults": [],
    })
    if prepared.images:
        _validate_multimodal_request(prepared)
    return prepared


def _build_human_content(
    message: str,
    context_block: str,
    images: list[dict[str, Any]] | None = None,
    attachments: list[dict[str, Any]] | None = None,
    ocr_results: list[dict[str, Any]] | None = None,
    image_processing_mode: str = DEFAULT_IMAGE_PROCESSING_MODE,
) -> str | list[dict[str, Any]]:
    return build_user_content(
        message,
        context_block,
        images,
        attachments,
        ocr_results,
        image_processing_mode,
    ).content

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
TOOL_RESULT_TIMEOUT = 300  # seconds
MAX_RETRIES_PER_ROUND = 2
MAX_FORCED_FOLLOW_UPS = 3
MAX_OUTPUT_CONTINUATIONS = 3
MAX_COMPACT_RETRIES = 3
MAX_CONTEXT_OVERFLOW_RETRIES = 3
MAX_READ_ONLY_STAGNANT_ROUNDS = 3
MAX_MULTIMODAL_IMAGES = 5
TODO_REMINDER_INTERVAL = 10  # turns between task reminders (Claude Code pattern)
MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024
MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024
RETRY_DELAYS = [1.0, 2.0, 4.0]
LAYOUT_PREFLIGHT_BATCH_SIZE = 3

LAYOUT_PREFLIGHT_STYLE_TOOLS = {
    "apply_style_batch",
    "set_page_config",
    "set_text_style",
    "set_paragraph_style",
    "clear_formatting",
}

LAYOUT_LOCKED_CONTENT_TOOLS = {
    "begin_streaming_write",
    "insert_text",
    "insert_paragraph_after",
    "replace_paragraph_text",
    "replace_selection_text",
    "delete_selection_text",
    "delete_paragraph",
    "delete_table",
    "insert_page_break",
    "insert_image",
    "insert_mermaid",
    "insert_horizontal_rule",
    "insert_table_of_contents",
    "insert_table",
    "insert_table_row_before",
    "insert_table_row_after",
    "delete_table_row",
    "insert_table_column_before",
    "insert_table_column_after",
    "delete_table_column",
}


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
    estimated_tokens: int = 0
    last_compact_source: str = ""
    last_compact_pre_tokens: int = 0
    last_compact_post_tokens: int = 0
    compact_failure_count: int = 0
    microcompact_count: int = 0
    last_api_usage: dict[str, int] = field(default_factory=dict)
    pending_write_follow_up: bool = False
    pending_agent_follow_up: bool = False
    forced_follow_up_attempts: int = 0
    # Stop-hook tracking
    recent_tool_patterns: list[str] = field(default_factory=list)
    consecutive_empty_content: int = 0
    tool_failure_counts: dict[str, int] = field(default_factory=dict)
    requires_content_verification: bool = False
    requires_task_check: bool = False
    last_mutation_tools: list[str] = field(default_factory=list)
    round_budget_warning_level: int = 0
    last_compact_warning_source: str = ""
    last_budget_progress_signature: str = ""
    stagnant_budget_rounds: int = 0
    budget_stagnation_warning_level: int = 0
    read_only_stagnant_rounds: int = 0
    output_continuation_attempts: int = 0
    last_model_finish_reason: str = ""
    vision_capability_blocked: bool = False
    layout_preflight_required: bool = False
    layout_preflight_completed: bool = False
    layout_preflight_failed: bool = False
    content_locked_for_layout: bool = False
    layout_style_dossier: dict[str, Any] = field(default_factory=dict)
    layout_preflight_signature: dict[str, Any] = field(default_factory=dict)
    # Delta tracking (Claude Code-style attachment system)
    previous_workspace_docs: list[dict] = field(default_factory=list)
    previous_template: dict | None = None
    injected_dynamic_boundary: bool = False
    # Task reminder tracking
    rounds_since_last_task_update: int = 0


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


def _tool_call_params_for_signature(tool_call: dict[str, Any]) -> Any:
    if "params" in tool_call:
        return tool_call.get("params") or {}
    return tool_call.get("args") or {}


def _tool_result_has_capability_block(payload: dict[str, Any], capability: str) -> bool:
    if payload.get("capabilityBlocked") == capability:
        return True
    data = payload.get("data")
    return isinstance(data, dict) and data.get("capabilityBlocked") == capability


def _tool_results_have_capability_block(tool_results: list[dict[str, str]], capability: str) -> bool:
    for item in tool_results:
        try:
            payload = json.loads(item.get("content", "{}"))
        except Exception:
            continue
        if isinstance(payload, dict) and _tool_result_has_capability_block(payload, capability):
            return True
    return False


class CompletionDecision(str, Enum):
    CONTINUE_WITH_HINT = "continue_with_hint"
    COMPLETE = "complete"
    FAIL = "fail"


@dataclass
class CompletionEvaluation:
    decision: CompletionDecision
    reason: str = ""
    hint: str = ""
    pending_task_count: int = 0


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
    pending_task_count: int = 0
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
    parallel_group: str | None = None
    executor_location: str = "client"
    read_only: bool = False
    allowed_for_agent: bool = False
    parallel_safe: bool = False


@dataclass(frozen=True)
class ToolExecutionPlan:
    plan_id: str
    round: int
    executions: list[PlannedToolExecution]


def _is_parallel_safe_execution(execution: PlannedToolExecution) -> bool:
    return execution.parallel_safe


def _assign_parallel_groups(executions: list[PlannedToolExecution]) -> list[PlannedToolExecution]:
    if len(executions) < 2:
        return executions

    grouped: list[PlannedToolExecution] = []
    pending_parallel: list[PlannedToolExecution] = []

    def flush_pending() -> None:
        nonlocal pending_parallel
        if len(pending_parallel) > 1:
            group_id = f"parallel_{uuid.uuid4().hex[:8]}"
            grouped.extend(replace(item, parallel_group=group_id) for item in pending_parallel)
        else:
            grouped.extend(pending_parallel)
        pending_parallel = []

    for execution in executions:
        if _is_parallel_safe_execution(execution):
            pending_parallel.append(execution)
            continue
        flush_pending()
        grouped.append(execution)

    flush_pending()
    return grouped


def _build_parallel_execution_batches(executions: list[PlannedToolExecution]) -> list[list[PlannedToolExecution]]:
    batches: list[list[PlannedToolExecution]] = []
    index = 0
    while index < len(executions):
        current = executions[index]
        explicit_group = current.parallel_group or ""
        if explicit_group:
            batch = [current]
            index += 1
            while index < len(executions) and executions[index].parallel_group == explicit_group:
                batch.append(executions[index])
                index += 1
            batches.append(batch)
            continue
        if current.parallel_safe:
            batch = [current]
            index += 1
            while index < len(executions):
                candidate = executions[index]
                if candidate.parallel_group or not candidate.parallel_safe:
                    break
                batch.append(candidate)
                index += 1
            batches.append(batch)
            continue
        batches.append([current])
        index += 1
    return batches


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
    content_events: list[dict[str, Any]] = field(default_factory=list)
    final_state: dict[str, Any] = field(default_factory=dict)


def _evaluate_stop_hooks(state: LoopState, tool_calls: list[dict[str, Any]],
                           tool_results: list[dict[str, str]]) -> StopEvaluation:
    """Evaluate whether the loop should stop, continue, or hint the LLM."""
    # ── 0. Capability blocks are state, not prompt-level warnings ──
    vision_blocked = _tool_results_have_capability_block(tool_results, "vision")
    if vision_blocked:
        state.vision_capability_blocked = True

    # ── 1. Tool-loop detection: same tool pattern 3 times in a row ──
    if tool_calls:
        # Build pattern from tool name + parameter hash to detect true duplicates
        pattern_parts = []
        for tc in sorted(tool_calls, key=lambda x: x["name"]):
            name = tc["name"]
            args = _tool_call_params_for_signature(tc)
            # Hash the arguments to detect same call with same params
            args_str = json.dumps(args, sort_keys=True, default=str)
            pattern_parts.append(f"{name}:{args_str}")
        pattern = "|".join(pattern_parts)
        state.recent_tool_patterns.append(pattern)
        if len(state.recent_tool_patterns) > 6:
            state.recent_tool_patterns = state.recent_tool_patterns[-6:]
        if (len(state.recent_tool_patterns) >= 3
                and len(set(state.recent_tool_patterns[-3:])) == 1):
            return StopEvaluation(
                StopDecision.RETRY_WITH_HINT,
                "tool_loop_detected",
                "你正在重复调用完全相同的工具组合（相同的工具+相同参数）。请检查当前文档状态：如果目标已达成，请直接回复用户；如果未达成，请尝试不同策略。",
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
        if _tool_result_has_capability_block(data, "vision"):
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


def _body_model_supports_vision(body: ChatRequest) -> bool:
    provider, model = _resolve_provider_and_model(body)
    return _selected_model_supports_vision(provider, model)


def _prepare_page_screenshot_tool_result(
    content: str,
    body: ChatRequest | None = None,
) -> tuple[str, HumanMessage | None]:
    payload = _parse_tool_result_payload(content)
    if payload.get("toolName") != "capture_page_screenshot":
        return content, None
    data = payload.get("data")
    if not isinstance(data, dict):
        return content, None
    data_url = str(data.get("dataUrl") or "").strip()
    if not data_url:
        return content, None

    safe_data = dict(data)
    safe_data.pop("dataUrl", None)
    page = safe_data.get("page")
    page_count = safe_data.get("pageCount")
    instruction = _stringify_content(safe_data.get("instruction")).strip()
    preview_text = _stringify_content(safe_data.get("previewText")).strip()

    safe_payload = dict(payload)
    safe_payload["data"] = safe_data
    if body is not None and not _body_model_supports_vision(body):
        block_data = {
            "capabilityBlocked": "vision",
            "recoverable": False,
            "suggestedAction": "finalize_or_switch_vision_model",
            "modelSupportsVision": False,
            "guidance": "不要重试截图，也不要用工作区搜索补偿视觉能力；如结构化内容足够则总结，否则说明需要切换支持视觉的模型。",
        }
        safe_data.update(block_data)
        safe_payload.update(block_data)
        safe_payload["success"] = False
        safe_payload["data"] = safe_data
        safe_payload["message"] = (
            "已截取页面截图，但当前模型不支持 image_url 多模态输入，无法进行真实视觉验收。"
            "请不要重试截图；如果结构化页面内容已经足够，请直接总结；如果必须视觉验收，请切换到支持视觉的模型或配置视觉模型。"
        )
        return json.dumps(safe_payload, ensure_ascii=False), None

    text_parts = [
        "[页面截图]",
        f"页码：{page}/{page_count}" if page_count else f"页码：{page}",
    ]
    if instruction:
        text_parts.append(f"检查重点：{instruction}")
    if preview_text:
        text_parts.append(f"页面文字预览：{preview_text}")
    text_parts.append("请基于这张当前正文页截图检查真实视觉效果，并结合前面的工具结果给出验收结论。")

    image_message = HumanMessage(content=[
        {"type": "text", "text": "\n".join(text_parts)},
        {"type": "image_url", "image_url": {"url": data_url}},
    ])
    return json.dumps(safe_payload, ensure_ascii=False), image_message


async def _prepare_page_screenshot_tool_result_for_runtime(
    content: str,
    body: ChatRequest,
) -> tuple[str, HumanMessage | None]:
    payload = _parse_tool_result_payload(content)
    if payload.get("toolName") != "capture_page_screenshot":
        return content, None
    data = payload.get("data")
    if not isinstance(data, dict):
        return content, None
    data_url = str(data.get("dataUrl") or "").strip()
    if not data_url:
        return content, None

    if _body_model_supports_vision(body):
        return _prepare_page_screenshot_tool_result(content, body)

    safe_data = dict(data)
    safe_data.pop("dataUrl", None)

    if _vision_fallback_available():
        page = safe_data.get("page")
        page_count = safe_data.get("pageCount")
        instruction = _stringify_content(safe_data.get("instruction")).strip()
        preview_text = _stringify_content(safe_data.get("previewText")).strip()
        prompt = "\n".join([
            "请对 openwps 文档页面截图做视觉验收，返回严格 JSON 对象。",
            "字段：visualSummary, layoutIssues, overlapRisk, pass, confidence, warnings。",
            f"页码：{page}/{page_count}" if page_count else f"页码：{page}",
            f"页面文字预览：{preview_text}" if preview_text else "",
            f"重点检查：{instruction}" if instruction else "重点检查分页、图文混排、遮挡、重叠和视觉一致性。",
        ]).strip()
        try:
            provider, model, used_fallback = _resolve_vision_runtime(body.providerId, body.model)
            raw_text = await _call_vision_chat(
                provider,
                model,
                prompt,
                data_url,
                int(DEFAULT_VISION_CONFIG["timeoutSeconds"]),
            )
            parsed = _extract_json_object(raw_text)
            visual_data = parsed if isinstance(parsed, dict) else {"visualSummary": raw_text}
            safe_data.update({
                "visionAnalyzed": True,
                "usedVisionFallback": bool(used_fallback),
                "visionModel": model,
                "visionResult": visual_data,
            })
            safe_payload = dict(payload)
            safe_payload["success"] = True
            safe_payload["message"] = "已通过后端视觉模型完成页面截图验收"
            safe_payload["data"] = safe_data
            return json.dumps(safe_payload, ensure_ascii=False), None
        except HTTPException as exc:
            safe_payload = dict(payload)
            block_data = {
                "capabilityBlocked": "vision",
                "recoverable": False,
                "suggestedAction": "vision_runtime_failed",
                "modelSupportsVision": False,
                "visionError": _http_error_message(exc),
            }
            safe_data.update(block_data)
            safe_payload.update(block_data)
            safe_payload["success"] = False
            safe_payload["message"] = f"后端视觉模型未能完成页面截图验收：{_http_error_message(exc)}"
            safe_payload["data"] = safe_data
            return json.dumps(safe_payload, ensure_ascii=False), None

    return _prepare_page_screenshot_tool_result(content, body)


def _extract_tasks_from_payload(payload: dict[str, Any]) -> list[dict[str, str]] | None:
    candidates = [
        payload.get("data"),
        payload.get("executedParams"),
        payload.get("originalParams"),
    ]
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        raw_tasks = candidate.get("tasks")
        if not isinstance(raw_tasks, list):
            continue
        tasks: list[dict[str, str]] = []
        for item in raw_tasks:
            if not isinstance(item, dict):
                continue
            tasks.append({
                "id": str(item.get("id", "")).strip(),
                "subject": str(item.get("subject", item.get("title", ""))).strip(),
                "activeForm": str(item.get("activeForm", item.get("subject", item.get("title", "")))).strip(),
                "status": str(item.get("status", "pending")).strip().lower(),
            })
        return tasks
    return None


def _get_latest_tasks(messages: list[BaseMessage]) -> list[dict[str, str]]:
    for message in reversed(messages):
        if not isinstance(message, ToolMessage):
            continue
        payload = _parse_tool_result_payload(message.content)
        tasks = _extract_tasks_from_payload(payload)
        if tasks is not None:
            return tasks
    return []


def _get_incomplete_tasks(messages: list[BaseMessage]) -> list[dict[str, str]]:
    return [
        task for task in _get_latest_tasks(messages)
        if task.get("status") in {"pending", "in_progress"}
    ]


def _tool_results_started_streaming_write(tool_results: list[dict[str, str]]) -> bool:
    for item in tool_results:
        payload = _parse_tool_result_payload(item.get("content", ""))
        if payload.get("toolName") != "begin_streaming_write":
            continue
        data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
        if payload.get("success") is True and data.get("awaitingMarkdown") is True:
            return True
    return False


def _tool_results_completed_subagent(tool_results: list[dict[str, str]]) -> bool:
    for item in tool_results:
        payload = _parse_tool_result_payload(item.get("content", ""))
        if payload.get("toolName") != "Agent":
            continue
        return True
    return False


def _build_follow_up_hint(
    needs_write_follow_up: bool,
    needs_agent_follow_up: bool,
    needs_content_verification: bool,
    needs_task_check: bool,
    incomplete_tasks: list[dict[str, str]],
    vision_capability_blocked: bool = False,
) -> tuple[str, str]:
    parts: list[str] = []
    reasons: list[str] = []

    if needs_write_follow_up:
        reasons.append("post_write_follow_up")
        parts.append("你刚刚完成的是正文流式写入阶段，这一轮纯文本输出属于写入文档的正文，不是最终结束信号。")
        parts.append("现在必须继续执行后续流程：先验证正文是否已经正确写入，再更新任务状态，然后完成剩余步骤。")

    if needs_agent_follow_up:
        reasons.append("post_agent_follow_up")
        parts.append("你刚刚调用了子代理并收到了子代理结果，但主 Agent 还没有基于该结果给出后续决策或最终结论。")
        parts.append("现在必须读取上一条 Agent 工具结果，明确说明验证/分析结论，并决定继续执行工具、补救问题，或向用户给出最终总结。不能空输出或直接结束。")

    if needs_content_verification:
        reasons.append("content_verification_required")
        parts.append("你最近执行了正文修改工具，但还没有在修改后调用 get_document_content 或 get_paragraph 进行验证。")
        parts.append("现在必须先读取并确认正文结果是否正确，再决定是否继续或结束。")

    if needs_task_check:
        reasons.append("task_status_unchecked")
        parts.append("你最近更新过内部任务，但还没有再次调用 TaskList 核对最终状态。")
        parts.append("结束前必须先确认当前任务列表，不能直接假设任务已经全部完成。")

    if incomplete_tasks and vision_capability_blocked:
        preview_titles = [task.get("subject", "") for task in incomplete_tasks if task.get("subject")][:3]
        title_text = f" 未完成项示例：{'；'.join(preview_titles)}。" if preview_titles else ""
        parts.append(
            f"内部任务列表仍有 {len(incomplete_tasks)} 个未完成项，但当前模型缺少视觉能力。{title_text}"
            "这只是进度提醒，不是继续循环的理由；如果目标已能解释清楚，请总结限制并结束，不要继续读取全文或搜索工作区来拖延。"
        )
    elif incomplete_tasks:
        preview_titles = [task.get("subject", "") for task in incomplete_tasks if task.get("subject")][:3]
        title_text = f" 未完成项示例：{'；'.join(preview_titles)}。" if preview_titles else ""
        parts.append(
            f"内部任务列表仍有 {len(incomplete_tasks)} 个未完成项（pending / in_progress）。{title_text}"
            "这只是工作记忆提醒，不是继续循环的理由；如果任务仍与当前目标相关，请用 TaskUpdate 更新状态。"
            "如果已经不相关或用户没有新的编辑指令，可以忽略它并直接回复用户，不要只为了清空任务列表继续读取文档。"
        )

    if vision_capability_blocked:
        parts.append("视觉能力不可用时，不要把视觉验收作为继续循环的理由；完成可完成的结构化验证后即可总结限制并结束。")
    else:
        parts.append("完成上述必要验证或 TaskList 核对后，如果没有新的工具动作，就直接向用户总结；不要因为仍有 pending / in_progress 内部任务而继续循环。")
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

TASK_MUTATION_TOOLS = {"TaskCreate", "TaskUpdate"}
TASK_CHECK_TOOLS = {"TaskList"}
READ_ONLY_STAGNATION_TOOLS = {"TaskList", "TaskGet", "get_paragraph", "get_document_content", "search_text"}


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

        if tool_name in TASK_MUTATION_TOOLS:
            state.requires_task_check = True
            state.rounds_since_last_task_update = 0
            continue

        if tool_name in TASK_CHECK_TOOLS:
            state.requires_task_check = False
            state.rounds_since_last_task_update = 0


def _needs_forced_continuation(state: LoopState, messages: list[BaseMessage]) -> tuple[bool, list[dict[str, str]]]:
    incomplete_tasks = _get_incomplete_tasks(messages)
    needs_continue = any([
        state.pending_write_follow_up,
        state.pending_agent_follow_up,
        state.requires_content_verification,
        state.requires_task_check,
    ])
    return needs_continue, incomplete_tasks


def _evaluate_completion_policy(state: LoopState, messages: list[BaseMessage]) -> CompletionEvaluation:
    needs_continue, incomplete_tasks = _needs_forced_continuation(state, messages)
    if not needs_continue:
        return CompletionEvaluation(
            decision=CompletionDecision.COMPLETE,
            reason="completed",
            pending_task_count=0,
        )

    if state.forced_follow_up_attempts >= MAX_FORCED_FOLLOW_UPS:
        return CompletionEvaluation(
            decision=CompletionDecision.FAIL,
            reason="forced_follow_up_limit_reached",
            pending_task_count=len(incomplete_tasks),
        )

    hint, reason = _build_follow_up_hint(
        state.pending_write_follow_up,
        state.pending_agent_follow_up,
        state.requires_content_verification,
        state.requires_task_check,
        incomplete_tasks,
        state.vision_capability_blocked,
    )
    return CompletionEvaluation(
        decision=CompletionDecision.CONTINUE_WITH_HINT,
        reason=reason,
        hint=hint,
        pending_task_count=len(incomplete_tasks),
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
                f"如果任务列表还未核对，立刻调用 TaskList；随后输出最终总结。"
            ),
            remaining_rounds=remaining_rounds,
            estimated_tokens=state.estimated_tokens,
            stagnant_rounds=stagnant_rounds,
        )

    if (
        stagnant_rounds >= 2
        and state.budget_stagnation_warning_level < 1
        and remaining_rounds <= 5
    ):
        return BudgetEvaluation(
            should_warn=True,
            reason="budget_stagnation",
            hint=(
                f"最近 {stagnant_rounds + 1} 轮没有缩小未完成状态。"
                f"后续必须放弃新的探索，只做能直接清空 completion gate 的动作：正文验证、TaskList 核对、最终总结。"
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
                f"优先完成验证、TaskList 核对和最终总结，不要再扩散任务或重新读取大段内容。"
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
                f"后续请保持最小化，只做必要验证、TaskList 核对和收尾。"
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


def _build_budget_progress_signature(state: LoopState, messages: list[BaseMessage]) -> str:
    return json.dumps(
        {
            "requiresContentVerification": state.requires_content_verification,
            "requiresTaskCheck": state.requires_task_check,
            "lastMutationTools": list(state.last_mutation_tools),
            "visionCapabilityBlocked": state.vision_capability_blocked,
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


def _build_gate_progress_signature(state: LoopState, messages: list[BaseMessage]) -> str:
    incomplete_tasks = _get_incomplete_tasks(messages)
    return json.dumps(
        {
            "pendingWriteFollowUp": state.pending_write_follow_up,
            "pendingAgentFollowUp": state.pending_agent_follow_up,
            "requiresContentVerification": state.requires_content_verification,
            "requiresTaskCheck": state.requires_task_check,
            "incompleteTaskCount": len(incomplete_tasks),
            "lastMutationTools": list(state.last_mutation_tools),
            "visionCapabilityBlocked": state.vision_capability_blocked,
        },
        ensure_ascii=False,
        sort_keys=True,
    )


def _tool_round_is_read_only_stagnation_candidate(tool_calls: list[dict[str, Any]]) -> bool:
    if not tool_calls:
        return False
    return all(str(tool_call.get("name") or "") in READ_ONLY_STAGNATION_TOOLS for tool_call in tool_calls)


def _record_tool_round_progress(
    state: LoopState,
    messages: list[BaseMessage],
    tool_calls: list[dict[str, Any]],
    before_signature: str,
) -> bool:
    after_signature = _build_gate_progress_signature(state, messages)
    gate_changed = before_signature != after_signature
    if gate_changed:
        state.forced_follow_up_attempts = 0
        state.read_only_stagnant_rounds = 0
        return True

    needs_continue, incomplete_tasks = _needs_forced_continuation(state, messages)
    if _tool_round_is_read_only_stagnation_candidate(tool_calls) and (needs_continue or incomplete_tasks):
        state.read_only_stagnant_rounds += 1
    else:
        state.read_only_stagnant_rounds = 0
    return False


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
            error_message="AI 未继续完成必要的后续处理，已达到自动续跑上限。",
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
            else "子代理已完成，主 Agent 正在继续处理结果..."
            if completion_evaluation.reason == "post_agent_follow_up"
            else "任务计划尚未完成，继续执行后续步骤..."
        ),
        pending_task_count=completion_evaluation.pending_task_count,
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

    if state.read_only_stagnant_rounds >= MAX_READ_ONLY_STAGNANT_ROUNDS:
        return RoundDecision(
            action=RoundDecisionAction.ERROR,
            transition=Transition.FATAL_ERROR,
            reason="read_only_stagnation",
            error_message=(
                "AI 连续执行只读检查但没有推进必要的收口状态，已停止当前自动链路。"
                "请根据当前结果继续下达下一步指令。"
            ),
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
    incomplete_tasks = _get_incomplete_tasks(messages)
    return {
        "pendingWriteFollowUp": state.pending_write_follow_up,
        "pendingAgentFollowUp": state.pending_agent_follow_up,
        "requiresContentVerification": state.requires_content_verification,
        "requiresTaskCheck": state.requires_task_check,
        "incompleteTaskCount": len(incomplete_tasks),
        "lastMutationTools": list(state.last_mutation_tools),
        "forcedFollowUpAttempts": state.forced_follow_up_attempts,
        "stagnantBudgetRounds": state.stagnant_budget_rounds,
        "budgetStagnationWarningLevel": state.budget_stagnation_warning_level,
        "readOnlyStagnantRounds": state.read_only_stagnant_rounds,
        "outputContinuationAttempts": state.output_continuation_attempts,
        "visionCapabilityBlocked": state.vision_capability_blocked,
        "layoutPreflightRequired": state.layout_preflight_required,
        "layoutPreflightCompleted": state.layout_preflight_completed,
        "contentLockedForLayout": state.content_locked_for_layout,
    }


def _record_trace_event(session: "ReactSession", event_type: str, **data: Any) -> None:
    session.trace.events.append({
        "type": event_type,
        "at": _now_iso(),
        **data,
    })


def _record_content_event(session: "ReactSession", event: dict[str, Any]) -> None:
    session.trace.content_events.append({
        "at": _now_iso(),
        **event,
    })


def _record_content_events(session: "ReactSession", events: list[dict[str, Any]]) -> None:
    for event in events:
        _record_content_event(session, event)


def _message_text_for_intent(body: ChatRequest) -> str:
    return _stringify_content(body.message).lower()


def _has_document_session_context(body: ChatRequest, context: dict[str, Any] | None = None) -> bool:
    ctx = context or body.context or {}
    return bool(str(body.documentSessionId or ctx.get("documentSessionId") or "").strip())


def _layout_content_mutation_explicitly_requested(body: ChatRequest) -> bool:
    text = _message_text_for_intent(body)
    return bool(re.search(r"(删除|删掉|移除|清空|写入|撰写|生成|续写|改写|替换|插入|新增|添加|加入|目录|表格|图片|图表|mermaid)", text))


def _should_require_layout_preflight(body: ChatRequest, context: dict[str, Any] | None = None) -> bool:
    if not _has_document_session_context(body, context):
        return False
    text = _message_text_for_intent(body)
    broad_layout = bool(re.search(r"(按模板|模板排版|全文排版|整体排版|统一排版|统一格式|统一样式|排版|版式|页面设置|页边距|批量样式|全文格式|整体格式)", text))
    if not broad_layout and str(body.mode or "").strip() == "layout":
        broad_layout = bool(re.search(r"(全文|整体|模板|统一|页面|页边距|标题|正文|样式|格式)", text))
    if not broad_layout:
        return False

    local_edit = bool(re.search(r"(第\s*\d+\s*段|选中|当前选区|这个词|这句话|局部|单段)", text))
    if local_edit and not re.search(r"(全文|整体|模板|统一)", text):
        return False
    return True


def _coerce_context_page_count(context: dict[str, Any] | None) -> int:
    value = (context or {}).get("pageCount")
    try:
        parsed = int(value)
    except Exception:
        return 1
    return max(1, min(parsed, 200))


def _tool_call_touches_multiple_ranges(params: dict[str, Any]) -> bool:
    range_value = params.get("range")
    if not isinstance(range_value, dict):
        return False
    indexes = _extract_paragraph_indexes_for_merge(range_value)
    if indexes and len(set(indexes)) > 1:
        return True
    if str(range_value.get("type") or "") in {"all", "paragraphs", "heading_role", "role"}:
        return True
    return False


def _is_preflight_guarded_style_execution(execution: PlannedToolExecution) -> bool:
    if execution.tool_name in {"apply_style_batch", "set_page_config"}:
        return True
    if execution.tool_name in {"set_text_style", "set_paragraph_style", "clear_formatting"}:
        if len(execution.source_calls) > 1:
            return True
        return _tool_call_touches_multiple_ranges(execution.params)
    return False


def _is_layout_content_tool_blocked(tool_name: str) -> bool:
    return tool_name in LAYOUT_LOCKED_CONTENT_TOOLS


def _compact_dossier_result(value: str, max_len: int = 1800) -> str:
    text = value.strip()
    if len(text) <= max_len:
        return text
    return text[:max_len] + "\n...（已截断）"


def _build_layout_preflight_prompt(page: int, page_count: int, *, screenshot_available: bool) -> str:
    screenshot_step = (
        f"3. 必须调用 capture_page_screenshot(page={page}, instruction='检查本页真实视觉排版、标题层级、分页、遮挡、表格/图片附近效果')。"
        if screenshot_available
        else "3. 当前运行时未暴露截图工具，不要要求截图；只基于结构化内容和样式摘要分析。"
    )
    return "\n".join([
        f"父代理准备执行全文排版。你只分析第 {page}/{page_count} 页，不能修改文档，不能分析其他页。",
        "必须按顺序完成：",
        f"1. 调用 get_page_content(page={page}) 获取页内正文结构和文字。",
        f"2. 调用 get_page_style_summary(page={page}) 获取本页样式摘要。",
        screenshot_step,
        "输出固定字段：page、storyTitles、styleSummary、styleAnomalies、recommendedFormattingActions、preserveContentNotes。",
        "重点识别多故事/多章节边界：不要建议删除、合并或重写故事正文；只给样式和页面设置建议。",
    ])


def _format_layout_dossier_for_model(dossier: dict[str, Any]) -> str:
    compact = {
        "pageCount": dossier.get("pageCount"),
        "visualEnabled": dossier.get("visualEnabled"),
        "contentLockedForLayout": True,
        "pages": [
            {
                "page": page.get("page"),
                "success": page.get("success"),
                "result": _compact_dossier_result(str(page.get("result") or ""), 1200),
            }
            for page in dossier.get("pages", [])
            if isinstance(page, dict)
        ],
    }
    return "\n".join([
        "[Layout Preflight 完成]",
        "以下是后端逐页样式预检生成的 layoutStyleDossier。接下来只能基于这些证据做样式和页面设置修改。",
        "正文结构已锁定：排版阶段不得删除、重写、合并或插入故事正文；除非用户明确要求内容编辑。",
        json.dumps(compact, ensure_ascii=False, indent=2),
    ])


def _doc_text(value: Any) -> str:
    if not isinstance(value, dict):
        return ""
    text = value.get("text")
    if isinstance(text, str):
        return text
    content = value.get("content")
    if not isinstance(content, list):
        return ""
    return "".join(_doc_text(item) for item in content)


def _layout_content_signature_from_doc(doc_json: dict[str, Any]) -> dict[str, Any]:
    content = doc_json.get("content") if isinstance(doc_json.get("content"), list) else []
    top_level_types: list[str] = []
    paragraph_texts: list[str] = []
    table_texts: list[list[list[str]]] = []
    full_text_parts: list[str] = []
    for node in content:
        if not isinstance(node, dict):
            continue
        node_type = str(node.get("type") or "")
        top_level_types.append(node_type)
        full_text_parts.append(_doc_text(node))
        if node_type == "paragraph":
            paragraph_texts.append(_doc_text(node))
        elif node_type == "table":
            rows: list[list[str]] = []
            for row in node.get("content") or []:
                if not isinstance(row, dict):
                    continue
                rows.append([
                    _doc_text(cell)
                    for cell in row.get("content") or []
                    if isinstance(cell, dict)
                ])
            table_texts.append(rows)
    return {
        "topLevelTypes": top_level_types,
        "paragraphCount": len(paragraph_texts),
        "tableCount": len(table_texts),
        "paragraphTextsHash": hashlib.sha256(json.dumps(paragraph_texts, ensure_ascii=False).encode("utf-8")).hexdigest(),
        "tableTextsHash": hashlib.sha256(json.dumps(table_texts, ensure_ascii=False).encode("utf-8")).hexdigest(),
        "fullTextHash": hashlib.sha256("\n".join(full_text_parts).encode("utf-8")).hexdigest(),
    }


async def _read_layout_content_signature(context: dict[str, Any]) -> dict[str, Any]:
    session_id = str(context.get("documentSessionId") or "").strip()
    if not session_id:
        return {}
    try:
        snapshot = await read_document_session(session_id)
    except Exception:
        return {}
    doc_json = snapshot.get("docJson") if isinstance(snapshot.get("docJson"), dict) else {}
    return _layout_content_signature_from_doc(doc_json)


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
        "compactSource": session.state.last_compact_source,
        "lastCompactPreTokens": session.state.last_compact_pre_tokens,
        "lastCompactPostTokens": session.state.last_compact_post_tokens,
        "microcompactCount": session.state.microcompact_count,
        "lastApiUsage": dict(session.state.last_api_usage),
        "remainingRounds": max(MAX_REACT_ROUNDS - session.state.round, 0),
        "roundBudgetWarningLevel": session.state.round_budget_warning_level,
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


def _stable_short_hash(value: Any) -> str:
    return hashlib.sha256(_stable_stringify(value).encode("utf-8")).hexdigest()[:16]


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


def _is_server_side_tool(tool_name: str) -> bool:
    return get_tool_metadata_payload(tool_name).get("executorLocation") == "server"


def _select_model_tools_by_names(
    tool_names: list[str],
    *,
    loaded_deferred_tools: set[str],
    body: ChatRequest,
    agent_type: str | None = None,
) -> list[dict[str, Any]]:
    requested = set(tool_names)
    selected: list[dict[str, Any]] = []
    body_for_mode = body.model_copy(update={"mode": "agent"})
    for tool in _get_model_tools_for_body(body_for_mode, loaded_deferred_tools, agent_type=agent_type):
        name = str(tool.get("function", {}).get("name", ""))
        if name in requested or name == TOOL_SEARCH_NAME:
            selected.append(tool)
    return selected


def _make_planned_execution(
    *,
    tool_name: str,
    params: dict[str, Any],
    source_calls: list[SourceToolCall],
    merge_strategy: str = "single",
    continue_on_error: bool = True,
) -> PlannedToolExecution:
    metadata = get_tool_metadata_payload(tool_name)
    return PlannedToolExecution(
        execution_id=f"exec_{uuid.uuid4().hex[:10]}",
        tool_name=tool_name,
        params=params,
        source_calls=source_calls,
        merge_strategy=merge_strategy,
        continue_on_error=continue_on_error,
        executor_location=str(metadata.get("executorLocation") or "client"),
        read_only=bool(metadata.get("readOnly")),
        allowed_for_agent=bool(metadata.get("allowedForAgent")),
        parallel_safe=bool(metadata.get("parallelSafe")),
    )


def _split_execution_plan(plan: ToolExecutionPlan) -> tuple[list[PlannedToolExecution], list[PlannedToolExecution]]:
    server_executions: list[PlannedToolExecution] = []
    client_executions: list[PlannedToolExecution] = []
    for execution in plan.executions:
        server_executions.append(execution)
    return server_executions, client_executions


def _normalize_web_search_depth(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized == "advanced":
        return "advanced"
    return str(DEFAULT_TAVILY_CONFIG["searchDepth"])


def _normalize_web_search_topic(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"general", "news", "finance"}:
        return normalized
    return str(DEFAULT_TAVILY_CONFIG["topic"])


def _normalize_web_search_max_results(value: Any) -> int:
    try:
        parsed = int(value)
    except Exception:
        parsed = int(DEFAULT_TAVILY_CONFIG["maxResults"])
    return max(1, min(parsed, 10))


def _normalize_web_search_timeout(value: Any) -> int:
    try:
        parsed = int(value)
    except Exception:
        parsed = int(DEFAULT_TAVILY_CONFIG["timeoutSeconds"])
    return max(5, min(parsed, 60))


def _serialize_tool_result_payload(
    *,
    tool_name: str,
    success: bool,
    message: str,
    executed_params: dict[str, Any],
    original_params: dict[str, Any] | None = None,
    data: Any = None,
    extra: dict[str, Any] | None = None,
) -> str:
    payload: dict[str, Any] = {
        "success": success,
        "message": _sanitize_tool_result_message(message, success=success),
        "data": data,
        "toolName": tool_name,
        "originalParams": original_params if original_params is not None else None,
        "executedParams": executed_params,
        "paramsRepaired": False,
    }
    if extra:
        payload.update(extra)
    return json.dumps(payload, ensure_ascii=False)


def _build_tool_result_event(
    execution: PlannedToolExecution,
    source_call: SourceToolCall,
    payload: dict[str, Any],
) -> dict[str, Any]:
    return {
        "type": "tool_result",
        "id": source_call.id,
        "name": source_call.name,
        "executionId": execution.execution_id,
        "params": execution.params,
        "originalParams": source_call.params,
        "sourceToolCallIds": [item.id for item in execution.source_calls],
        "mergeStrategy": execution.merge_strategy,
        "result": {
            "success": payload.get("success") is True,
            "message": _stringify_content(payload.get("message")),
            "data": payload.get("data"),
        },
    }


def _build_agent_execution_outcome(
    execution: PlannedToolExecution,
    *,
    success: bool,
    message: str,
    executed_params: dict[str, Any],
    original_params: dict[str, Any] | None = None,
    data: Any = None,
) -> tuple[str, dict[str, Any], dict[str, str], dict[str, Any]]:
    content = _serialize_tool_result_payload(
        tool_name="Agent",
        success=success,
        message=message,
        executed_params=executed_params,
        original_params=original_params if original_params is not None else executed_params,
        data=data,
    )
    payload = _parse_tool_result_payload(content)
    result = {
        "execution_id": execution.execution_id,
        "content": content,
    }
    summary = {
        "executionId": execution.execution_id,
        "toolName": execution.tool_name,
        "success": payload.get("success") is True,
        "message": _truncate_preview(payload.get("message", ""), 120),
        "mergeStrategy": execution.merge_strategy,
        "sourceToolCallCount": len(execution.source_calls),
    }
    return content, payload, result, summary


def _append_agent_tool_result_messages(
    session: "ReactSession",
    execution: PlannedToolExecution,
    content: str,
    payload: dict[str, Any],
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for source_call in execution.source_calls:
        session.messages.append(ToolMessage(
            content=_decorate_tool_result_content(content, execution, source_call),
            tool_call_id=source_call.id,
        ))
        events.append(_build_tool_result_event(execution, source_call, payload))
    _record_content_event(session, {
        "type": "tool_results",
        "source": "agent",
        "toolName": execution.tool_name,
        "executionCount": 1,
        "sourceToolCallCount": len(execution.source_calls),
        "contentChars": len(content),
    })
    return events


def _build_and_append_agent_execution_result(
    session: "ReactSession",
    execution: PlannedToolExecution,
    *,
    success: bool,
    message: str,
    executed_params: dict[str, Any],
    original_params: dict[str, Any] | None = None,
    data: Any = None,
) -> tuple[dict[str, str], dict[str, Any], list[dict[str, Any]]]:
    content, payload, result, summary = _build_agent_execution_outcome(
        execution,
        success=success,
        message=message,
        executed_params=executed_params,
        original_params=original_params,
        data=data,
    )
    events = _append_agent_tool_result_messages(session, execution, content, payload)
    return result, summary, events


def _trim_tavily_result_item(item: Any) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    title = _stringify_content(item.get("title")).strip()
    url = _stringify_content(item.get("url")).strip()
    content = _stringify_content(item.get("content")).strip()
    if not (title or url or content):
        return None
    trimmed: dict[str, Any] = {
        "title": title,
        "url": url,
        "content": content[:500],
    }
    score = item.get("score")
    if isinstance(score, (int, float)):
        trimmed["score"] = round(float(score), 4)
    published_date = item.get("published_date")
    if isinstance(published_date, str) and published_date.strip():
        trimmed["publishedDate"] = published_date.strip()
    return trimmed


def _summarize_web_search_data(data: dict[str, Any]) -> str:
    results = data.get("results")
    if not isinstance(results, list) or not results:
        return "未找到合适的网页结果"
    previews: list[str] = []
    for item in results[:3]:
        if not isinstance(item, dict):
            continue
        title = _stringify_content(item.get("title")).strip() or _stringify_content(item.get("url")).strip()
        snippet = _stringify_content(item.get("content")).strip().replace("\n", " ")
        previews.append(f"{title}: {snippet[:80]}")
    if not previews:
        return f"已返回 {len(results)} 条联网搜索结果"
    return "；".join(previews)


async def _run_web_search_tool(params: dict[str, Any]) -> str:
    query = _stringify_content(params.get("query")).strip()
    if not query:
        return _serialize_tool_result_payload(
            tool_name="web_search",
            success=False,
            message="web_search 缺少 query 参数",
            executed_params=params,
            original_params=params,
        )

    cfg = read_config()
    tavily_cfg = dict(cfg.get("tavilyConfig") or {})
    if not bool(tavily_cfg.get("enabled", DEFAULT_TAVILY_CONFIG["enabled"])):
        return _serialize_tool_result_payload(
            tool_name="web_search",
            success=False,
            message="Tavily web search 当前未启用，请先在 AI 设置中开启。",
            executed_params=params,
            original_params=params,
        )

    api_key = str(tavily_cfg.get("apiKey") or "").strip()
    if not api_key:
        return _serialize_tool_result_payload(
            tool_name="web_search",
            success=False,
            message="尚未配置 Tavily API Key，请先在 AI 设置中填写。",
            executed_params=params,
            original_params=params,
        )

    if AsyncTavilyClient is None:
        return _serialize_tool_result_payload(
            tool_name="web_search",
            success=False,
            message="服务端缺少 tavily-python 依赖，请安装后重试。",
            executed_params=params,
            original_params=params,
        )

    topic = _normalize_web_search_topic(params.get("topic") or tavily_cfg.get("topic"))
    search_depth = _normalize_web_search_depth(params.get("searchDepth") or tavily_cfg.get("searchDepth"))
    max_results = _normalize_web_search_max_results(params.get("maxResults") or tavily_cfg.get("maxResults"))
    timeout = _normalize_web_search_timeout(tavily_cfg.get("timeoutSeconds"))
    normalized_params = {
        "query": query[:400],
        "topic": topic,
        "searchDepth": search_depth,
        "maxResults": max_results,
    }

    try:
        client = AsyncTavilyClient(api_key=api_key)
        response = await client.search(
            query=normalized_params["query"],
            topic=topic,
            search_depth=search_depth,
            max_results=max_results,
            include_answer=False,
            include_raw_content=False,
            include_images=False,
            include_image_descriptions=False,
            include_favicon=False,
            include_usage=False,
            timeout=timeout,
        )
    except httpx.TimeoutException:
        return _serialize_tool_result_payload(
            tool_name="web_search",
            success=False,
            message=f"Tavily 搜索超时（{timeout}s），请缩小问题范围后重试。",
            executed_params=normalized_params,
            original_params=params,
        )
    except Exception as exc:
        return _serialize_tool_result_payload(
            tool_name="web_search",
            success=False,
            message=f"Tavily 搜索失败：{_stringify_content(exc)}",
            executed_params=normalized_params,
            original_params=params,
        )

    raw_results = response.get("results") if isinstance(response, dict) else []
    trimmed_results = [
        item
        for item in (_trim_tavily_result_item(result) for result in (raw_results if isinstance(raw_results, list) else []))
        if item is not None
    ][:max_results]
    data = {
        "query": normalized_params["query"],
        "topic": topic,
        "searchDepth": search_depth,
        "responseTime": response.get("response_time") if isinstance(response, dict) else None,
        "requestId": response.get("request_id") if isinstance(response, dict) else None,
        "results": trimmed_results[:5],
        "resultCount": len(trimmed_results),
    }

    message = _summarize_web_search_data(data)
    if not trimmed_results:
        message = "未找到与当前问题足够相关的网页结果"

    return _serialize_tool_result_payload(
        tool_name="web_search",
        success=True,
        message=message,
        executed_params=normalized_params,
        original_params=params,
        data=data,
    )


def _task_stats(tasks: list[dict[str, Any]]) -> dict[str, int]:
    pending = sum(1 for task in tasks if str(task.get("status") or "").lower() == "pending")
    in_progress = sum(1 for task in tasks if str(task.get("status") or "").lower() == "in_progress")
    completed = sum(1 for task in tasks if str(task.get("status") or "").lower() == "completed")
    blocked = sum(1 for task in tasks if str(task.get("status") or "").lower() == "blocked")
    return {
        "taskCount": len(tasks),
        "pendingCount": pending,
        "inProgressCount": in_progress,
        "completedCount": completed,
        "blockedCount": blocked,
    }


def _http_error_message(exc: HTTPException) -> str:
    detail = exc.detail
    if isinstance(detail, str):
        return _sanitize_upstream_error_detail(detail, status_code=exc.status_code)
    return _sanitize_upstream_error_detail(_stringify_content(detail) or f"HTTP {exc.status_code}", status_code=exc.status_code)


async def _run_task_tool(tool_name: str, params: dict[str, Any], conversation_id: str | None) -> str:
    if not conversation_id:
        return _serialize_tool_result_payload(
            tool_name=tool_name,
            success=False,
            message="当前会话尚未创建，无法执行任务工具",
            executed_params=params,
            original_params=params,
        )

    try:
        if tool_name == "TaskCreate":
            task = create_task(conversation_id, params)
            tasks = list_tasks(conversation_id)
            data = {"task": task, "tasks": tasks, **_task_stats(tasks)}
            message = f"任务 #{task.get('id')} 已创建：{task.get('subject', '')}"
        elif tool_name == "TaskGet":
            task_id = str(params.get("taskId") or params.get("id") or "").strip()
            if not task_id:
                raise HTTPException(status_code=400, detail="TaskGet 缺少 taskId")
            task = get_task(conversation_id, task_id)
            data = {"task": task}
            message = f"已读取任务 #{task.get('id')}"
        elif tool_name == "TaskList":
            tasks = list_tasks(conversation_id)
            data = {"tasks": tasks, **_task_stats(tasks)}
            message = f"当前有 {len(tasks)} 个任务" if tasks else "当前还没有任务计划"
        elif tool_name == "TaskUpdate":
            task_id = str(params.get("taskId") or params.get("id") or "").strip()
            if not task_id:
                raise HTTPException(status_code=400, detail="TaskUpdate 缺少 taskId")
            task = update_task(conversation_id, task_id, params)
            tasks = list_tasks(conversation_id)
            data = {"task": task, "tasks": tasks, **_task_stats(tasks)}
            message = f"任务 #{task.get('id')} 已更新为 {task.get('status')}"
        else:
            return _serialize_tool_result_payload(
                tool_name=tool_name,
                success=False,
                message=f"未知任务工具：{tool_name}",
                executed_params=params,
                original_params=params,
            )
    except HTTPException as exc:
        return _serialize_tool_result_payload(
            tool_name=tool_name,
            success=False,
            message=_http_error_message(exc),
            executed_params=params,
            original_params=params,
        )

    return _serialize_tool_result_payload(
        tool_name=tool_name,
        success=True,
        message=message,
        data=data,
        executed_params=params,
        original_params=params,
    )


def _workspace_tool_cache_key(tool_name: str, params: dict[str, Any]) -> str:
    if tool_name == "workspace_tree":
        workspace_id = _stringify_content(params.get("workspace_id") or params.get("workspaceId")).strip()
        return f"{tool_name}:{workspace_id}"
    if tool_name == "workspace_search":
        query = _stringify_content(params.get("query")).strip()
        doc_id = _stringify_content(params.get("doc_id") or params.get("docId")).strip()
        scope = _stringify_content(params.get("scope") or "all").strip()
        path = _stringify_content(params.get("path")).strip()
        context_lines = str(params.get("context_lines") or params.get("contextLines") or 3)
        return f"{tool_name}:{query}:{doc_id}:{scope}:{path}:{context_lines}"
    if tool_name == "workspace_read":
        doc_id = _stringify_content(params.get("path") or params.get("doc_id") or params.get("docId")).strip()
        from_line = params.get("from_line", params.get("fromLine"))
        to_line = params.get("to_line", params.get("toLine"))
        return f"{tool_name}:{doc_id}:{from_line}:{to_line}"
    if tool_name == "workspace_open":
        path = _stringify_content(params.get("path")).strip()
        workspace_id = _stringify_content(params.get("workspace_id") or params.get("workspaceId")).strip()
        return f"{tool_name}:{workspace_id}:{path}"
    if tool_name == "workspace_memory_write":
        path = _stringify_content(params.get("path")).strip()
        workspace_id = _stringify_content(params.get("workspace_id") or params.get("workspaceId")).strip()
        content_hash = hashlib.sha256(_stringify_content(params.get("content")).encode("utf-8")).hexdigest()
        return f"{tool_name}:{workspace_id}:{path}:{content_hash}"
    if tool_name == "workspace_memory_delete":
        path = _stringify_content(params.get("path")).strip()
        workspace_id = _stringify_content(params.get("workspace_id") or params.get("workspaceId")).strip()
        return f"{tool_name}:{workspace_id}:{path}"
    return f"{tool_name}:{json.dumps(params, ensure_ascii=False, sort_keys=True)}"


async def _run_workspace_tool(
    tool_name: str,
    params: dict[str, Any],
    cache: set[str] | None = None,
    context: dict[str, Any] | None = None,
) -> str:
    try:
        cache_key = _workspace_tool_cache_key(tool_name, params)
        if cache is not None and cache_key in cache and tool_name not in {"workspace_open", "workspace_memory_write", "workspace_memory_delete"}:
            return _serialize_tool_result_payload(
                tool_name=tool_name,
                success=True,
                message="本次 ReAct 会话中已经执行过相同的工作区读取/搜索，已省略重复内容。",
                data={
                    "deduplicated": True,
                    "cacheKey": cache_key,
                    "guidance": "请使用前一次相同 workspace 工具调用的结果；只有工作区 delta 明确提示文件变化时才需要重新读取。",
                },
                executed_params=params,
                original_params=params,
            )
        if tool_name == "workspace_tree":
            workspace_id = _stringify_content(params.get("workspace_id") or params.get("workspaceId")).strip() or None
            data = get_workspace_tree(workspace_id)
            message = "已读取工作区目录树"
        elif tool_name == "workspace_search":
            query = _stringify_content(params.get("query")).strip()
            if not query:
                raise HTTPException(status_code=400, detail="workspace_search 缺少 query")
            doc_id = _stringify_content(params.get("doc_id") or params.get("docId")).strip() or None
            context_lines = int(params.get("context_lines") or params.get("contextLines") or 3)
            workspace_id = _stringify_content(params.get("workspace_id") or params.get("workspaceId")).strip() or None
            scope = _stringify_content(params.get("scope") or "all").strip() or "all"
            path = _stringify_content(params.get("path")).strip() or None
            data = search_workspace(query, doc_id, context_lines, workspace_id=workspace_id, scope=scope, path=path)
            message = f"工作区搜索完成，匹配 {data.get('matchedDocs', 0)} 个文档"
        elif tool_name == "workspace_read":
            doc_id = _stringify_content(params.get("path") or params.get("doc_id") or params.get("docId")).strip()
            if not doc_id:
                raise HTTPException(status_code=400, detail="workspace_read 缺少 path")
            from_line = params.get("from_line", params.get("fromLine"))
            to_line = params.get("to_line", params.get("toLine"))
            workspace_id = _stringify_content(params.get("workspace_id") or params.get("workspaceId")).strip() or None
            data = get_workspace_document_content(
                doc_id,
                int(from_line) if from_line is not None else None,
                int(to_line) if to_line is not None else None,
                workspace_id=workspace_id,
            )
            message = f"已读取工作区文档 {doc_id}"
        elif tool_name == "workspace_open":
            path = _stringify_content(params.get("path")).strip()
            if not path:
                raise HTTPException(status_code=400, detail="workspace_open 缺少 path")
            workspace_id = _stringify_content(params.get("workspace_id") or params.get("workspaceId")).strip() or None
            payload = open_file_as_document(workspace_id or "", path)
            session = await create_document_session(payload)
            await set_active_document_session(
                session["documentSessionId"],
                {
                    "currentDocumentName": payload.get("currentDocumentName"),
                    "workspaceId": payload.get("workspaceId"),
                    "filePath": payload.get("filePath"),
                    "fileType": payload.get("fileType"),
                },
            )
            data = {
                **payload,
                **session,
                "documentEvents": [
                    {
                        "type": "document_replace",
                        "docJson": payload.get("docJson"),
                        "source": "workspace_open",
                        "version": session.get("version"),
                    },
                    {
                        "type": "page_config_changed",
                        "pageConfig": payload.get("pageConfig"),
                        "source": "workspace_open",
                        "version": session.get("version"),
                    },
                ],
            }
            if context is not None:
                context["documentSessionId"] = session["documentSessionId"]
                context["workspaceId"] = payload.get("workspaceId")
                context["filePath"] = payload.get("filePath")
                context["fileType"] = payload.get("fileType")
            message = f"已打开工作区文件 {payload.get('filePath')}"
        elif tool_name == "workspace_memory_write":
            path = _stringify_content(params.get("path")).strip()
            content = _stringify_content(params.get("content"))
            if not path:
                raise HTTPException(status_code=400, detail="workspace_memory_write 缺少 path")
            workspace_id = _stringify_content(params.get("workspace_id") or params.get("workspaceId")).strip() or None
            data = save_memory_file(
                workspace_id or "",
                path,
                content,
                name=_stringify_content(params.get("name")).strip() or None,
                description=_stringify_content(params.get("description")).strip() or None,
                memory_type=_stringify_content(params.get("type") or params.get("memory_type") or params.get("memoryType")).strip() or None,
                index_title=_stringify_content(params.get("index_title") or params.get("indexTitle")).strip() or None,
                index_hook=_stringify_content(params.get("index_hook") or params.get("indexHook")).strip() or None,
            )
            message = f"已写入记忆文件 {data.get('path')}"
        elif tool_name == "workspace_memory_delete":
            path = _stringify_content(params.get("path")).strip()
            if not path:
                raise HTTPException(status_code=400, detail="workspace_memory_delete 缺少 path")
            workspace_id = _stringify_content(params.get("workspace_id") or params.get("workspaceId")).strip() or None
            data = delete_memory_file(workspace_id or "", path)
            message = f"已删除记忆文件 {data.get('path')}"
        else:
            return _serialize_tool_result_payload(
                tool_name=tool_name,
                success=False,
                message=f"未知工作区工具：{tool_name}",
                executed_params=params,
                original_params=params,
            )
    except HTTPException as exc:
        return _serialize_tool_result_payload(
            tool_name=tool_name,
            success=False,
            message=_http_error_message(exc),
            executed_params=params,
            original_params=params,
        )

    if cache is not None:
        cache.add(cache_key)
    return _serialize_tool_result_payload(
        tool_name=tool_name,
        success=True,
        message=message,
        data=data,
        executed_params=params,
        original_params=params,
    )


async def _run_ocr_attachment_tool(params: dict[str, Any], body: ChatRequest) -> str:
    images = body.images or []
    if not images:
        return _serialize_tool_result_payload(
            tool_name="analyze_image_with_ocr",
            success=False,
            message="当前轮没有可供 OCR 分析的图片",
            executed_params=params,
            original_params=params,
        )
    image_indices = params.get("imageIndices")
    if not isinstance(image_indices, list):
        image_indices = []
    try:
        result = await analyze_images_with_ocr(OCRCommandRequest(
            images=images,
            taskType=_normalize_ocr_task_type(params.get("taskType")),
            instruction=_stringify_content(params.get("instruction")).strip() or None,
            imageIndices=[int(value) for value in image_indices if str(value).strip()],
            ocrConfig=body.ocrConfig,
        ))
    except HTTPException as exc:
        return _serialize_tool_result_payload(
            tool_name="analyze_image_with_ocr",
            success=False,
            message=_http_error_message(exc),
            executed_params=params,
            original_params=params,
        )

    return _serialize_tool_result_payload(
        tool_name="analyze_image_with_ocr",
        success=True,
        message=f"已完成 OCR 识别（{result.get('taskType')}，{result.get('imageCount')} 张图片）",
        data=result,
        executed_params=params,
        original_params=params,
    )


def _choose_document_image_mode(target: dict[str, Any], requested_mode: str, task_type: str) -> str:
    if requested_mode in {"multimodal", "ocr", "both"}:
        return requested_mode
    context_text = " ".join([
        _stringify_content(target.get("alt")),
        _stringify_content(target.get("title")),
        _stringify_content(target.get("paragraphText")),
        _stringify_content(target.get("beforeText")),
        _stringify_content(target.get("afterText")),
    ]).lower()
    if task_type in {"table", "formula", "handwriting", "document_text"}:
        return "ocr"
    if re.search(r"扫描|表格|公式|手写|ocr|文字|正文|document|table|formula|handwriting", context_text, re.I):
        return "ocr"
    if re.search(r"图表|截图|chart|graph|dashboard|报表", context_text, re.I):
        return "both"
    return "multimodal"


async def _run_document_image_analysis_tool(params: dict[str, Any], body: ChatRequest, context: dict[str, Any]) -> str:
    located = await execute_ai_document_tool("analyze_document_image", params, context)
    if located.get("success") is not True:
        return _serialize_tool_result_payload(
            tool_name="analyze_document_image",
            success=False,
            message=str(located.get("message") or "未找到指定的文档图片"),
            data=located.get("data"),
            executed_params=params,
            original_params=params,
        )

    location_data = located.get("data") if isinstance(located.get("data"), dict) else {}
    target = location_data.get("target") if isinstance(location_data.get("target"), dict) else {}
    data_url = str(target.get("dataUrl") or "").strip()
    if not data_url.startswith("data:"):
        return _serialize_tool_result_payload(
            tool_name="analyze_document_image",
            success=False,
            message="当前图片不是内嵌 data URL，暂不能从文档内直接发送给图片分析模型",
            data={key: value for key, value in target.items() if key != "dataUrl"},
            executed_params=params,
            original_params=params,
        )

    task_type = _normalize_ocr_task_type(params.get("taskType"))
    mode_used = _choose_document_image_mode(target, str(params.get("analysisMode") or "auto"), task_type)
    instruction = _stringify_content(params.get("instruction")).strip()
    visual_result: dict[str, Any] = {}
    ocr_response: dict[str, Any] | None = None
    warnings: list[str] = []

    if mode_used in {"multimodal", "both"}:
        try:
            vision = await analyze_image_with_vision(VisionAnalyzeRequest(
                image={
                    "name": target.get("alt") or target.get("title") or target.get("imageId"),
                    "type": data_url.split(";", 1)[0].replace("data:", "") or "image/png",
                    "dataUrl": data_url,
                },
                providerId=body.providerId,
                model=body.model,
                instruction=instruction or None,
                context={key: value for key, value in target.items() if key != "dataUrl"},
            ))
            result = vision.get("result")
            if isinstance(result, dict):
                visual_result = result
        except HTTPException as exc:
            if mode_used == "multimodal":
                message = _http_error_message(exc)
                return _serialize_tool_result_payload(
                    tool_name="analyze_document_image",
                    success=False,
                    message=(
                        f"{message}。当前文档图片分析请求依赖多模态视觉能力，但当前模型/视觉配置不可用。"
                        "不要反复重试图片分析；如 OCR 或结构化上下文不足，请向用户说明需要切换支持视觉的模型或配置视觉模型。"
                    ),
                    data={
                        "capabilityBlocked": "vision",
                        "recoverable": False,
                        "suggestedAction": "finalize_or_switch_vision_model",
                        "modeUsed": mode_used,
                        "guidance": "不要继续调用 analyze_document_image 或 workspace_search 补偿视觉能力；请基于已有文本证据收口。",
                    },
                    executed_params=params,
                    original_params=params,
                )
            warnings.append(_http_error_message(exc))

    if mode_used in {"ocr", "both"}:
        try:
            ocr_response = await analyze_images_with_ocr(OCRCommandRequest(
                images=[{
                    "id": target.get("imageId"),
                    "name": target.get("alt") or target.get("title") or target.get("imageId"),
                    "type": data_url.split(";", 1)[0].replace("data:", "") or "image/png",
                    "dataUrl": data_url,
                }],
                taskType=task_type,
                instruction=instruction or None,
                ocrConfig=body.ocrConfig,
            ))
        except HTTPException as exc:
            if mode_used == "ocr":
                return _serialize_tool_result_payload(
                    tool_name="analyze_document_image",
                    success=False,
                    message=_http_error_message(exc),
                    executed_params=params,
                    original_params=params,
                )
            warnings.append(_http_error_message(exc))

    first_ocr = (ocr_response.get("results") or [{}])[0] if isinstance(ocr_response, dict) else {}
    if not isinstance(first_ocr, dict):
        first_ocr = {}
    data = {
        "imageId": target.get("imageId"),
        "fingerprint": target.get("fingerprint"),
        "paragraphIndex": target.get("paragraphIndex"),
        "imageIndex": target.get("imageIndex"),
        "page": target.get("page"),
        "modeUsed": mode_used,
        "visualSummary": str(visual_result.get("visualSummary") or visual_result.get("summary") or ""),
        "ocrText": first_ocr.get("markdown") or first_ocr.get("plainText") or first_ocr.get("handwritingText") or "",
        "tables": first_ocr.get("tables") or [],
        "detectedObjects": visual_result.get("detectedObjects") if isinstance(visual_result.get("detectedObjects"), list) else [],
        "chartSummary": visual_result.get("chartSummary") or "\n".join(str(chart.get("summary") or "") for chart in (first_ocr.get("charts") or []) if isinstance(chart, dict)),
        "styleHints": visual_result.get("styleHints") if isinstance(visual_result.get("styleHints"), dict) else {},
        "warnings": [
            *warnings,
            *([str(item) for item in visual_result.get("warnings", [])] if isinstance(visual_result.get("warnings"), list) else []),
            *([str(item) for item in first_ocr.get("warnings", [])] if isinstance(first_ocr.get("warnings"), list) else []),
        ],
        "confidence": visual_result.get("confidence") if isinstance(visual_result.get("confidence"), (int, float)) else (0.8 if first_ocr else 0.7),
    }
    return _serialize_tool_result_payload(
        tool_name="analyze_document_image",
        success=True,
        message=f"已完成文档图片分析：{data['imageId']}（{mode_used}）",
        data=data,
        executed_params=params,
        original_params=params,
    )


def _run_tool_search_tool(
    params: dict[str, Any],
    *,
    body: ChatRequest,
    loaded_deferred_tools: set[str],
) -> str:
    query = _stringify_content(params.get("query")).strip()
    if not query:
        return _serialize_tool_result_payload(
            tool_name=TOOL_SEARCH_NAME,
            success=False,
            message="ToolSearch 缺少 query 参数",
            executed_params=params,
            original_params=params,
        )

    matches = _search_deferred_tool_definitions_for_body(body, query, loaded_deferred_tools)
    loaded_names = [definition.name for definition in matches]
    loaded_deferred_tools.update(loaded_names)
    schemas = [definition.to_openai_tool() for definition in matches]
    if not schemas:
        return _serialize_tool_result_payload(
            tool_name=TOOL_SEARCH_NAME,
            success=True,
            message=f"没有找到匹配的延迟工具：{query}",
            executed_params={"query": query},
            original_params=params,
            data={
                "query": query,
                "loadedToolNames": [],
                "functions": [],
                "remainingDeferredTools": [
                    definition.to_deferred_summary()
                    for definition in _get_deferred_tool_definitions_for_body(body, loaded_deferred_tools)
                ],
            },
        )

    functions_block = json.dumps(schemas, ensure_ascii=False, sort_keys=True)
    return _serialize_tool_result_payload(
        tool_name=TOOL_SEARCH_NAME,
        success=True,
        message=(
            f"已加载 {len(schemas)} 个延迟工具：{', '.join(loaded_names)}。\n"
            f"<functions>\n{functions_block}\n</functions>\n"
            "下一轮可以直接调用这些工具。"
        ),
        executed_params={"query": query},
        original_params=params,
        data={
            "query": query,
            "loadedToolNames": loaded_names,
            "functions": schemas,
                "remainingDeferredTools": [
                    definition.to_deferred_summary()
                    for definition in _get_deferred_tool_definitions_for_body(body, loaded_deferred_tools)
                ],
            },
        )


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
                executions.append(_make_planned_execution(
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
                executions.append(_make_planned_execution(
                    tool_name=current_name,
                    params=merged_params,
                    source_calls=source_calls,
                    merge_strategy="delete_batch" if len(source_calls) > 1 else "single",
                ))
                index = next_index
                continue

        executions.append(_make_planned_execution(
            tool_name=current_name,
            params=current_params,
            source_calls=[current_source],
        ))
        index += 1

    executions = _assign_parallel_groups(executions)

    return ToolExecutionPlan(
        plan_id=f"plan_{uuid.uuid4().hex[:10]}",
        round=round_number,
        executions=executions,
    )


def _decorate_tool_result_content(
    content: str,
    execution: PlannedToolExecution,
    source_call: SourceToolCall,
) -> str:
    safe_content, _ = _prepare_page_screenshot_tool_result(content)
    payload = _parse_tool_result_payload(safe_content)
    decorated = dict(payload) if payload else {
        "success": True,
        "message": _stringify_content(safe_content),
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
        "session_id", "body", "messages",
        "state", "finished", "trace", "latest_context",
        "loaded_deferred_tools", "server_streaming_write", "workspace_tool_cache",
    )

    def __init__(self, session_id: str, body: ChatRequest, messages: list[BaseMessage]):
        self.session_id = session_id
        self.body = body
        self.messages = messages
        self.state = LoopState()
        self.finished = False
        self.latest_context: dict[str, Any] = _with_backend_workspace_docs(body.context, query=body.message)  # Updated each round
        if body.documentSessionId:
            self.latest_context["documentSessionId"] = body.documentSessionId
        workspace_docs = self.latest_context.get("workspaceDocs")
        if isinstance(workspace_docs, list):
            self.state.previous_workspace_docs = list(workspace_docs)
        self.loaded_deferred_tools: set[str] = set()
        self.server_streaming_write: dict[str, Any] | None = None
        self.workspace_tool_cache: set[str] = set()
        self.trace = SessionTrace(
            session_id=session_id,
            conversation_id=body.conversationId,
            mode=body.mode,
            model=body.model,
            provider_id=body.providerId,
            created_at=_now_iso(),
        )


def _build_task_snapshot_attachment(messages: list[BaseMessage]) -> HumanMessage | None:
    tasks = _get_latest_tasks(messages)
    if not tasks:
        return None
    payload = {
        "type": "task_snapshot",
        "mode": "snapshot",
        "tasks": tasks,
        "note": "这是压缩恢复后的内部任务快照。任务列表是模型组织工作的软约束，不是强制续跑条件。",
    }
    return HumanMessage(content="[系统附件] type=task_snapshot\n" + json.dumps(payload, ensure_ascii=False, sort_keys=True))


def _build_document_snapshot_attachment(context: dict[str, Any]) -> HumanMessage | None:
    payload: dict[str, Any] = {
        "type": "document_snapshot",
        "mode": "snapshot",
        "documentSessionId": context.get("documentSessionId"),
        "documentId": context.get("documentId"),
        "title": context.get("documentTitle") or context.get("title"),
        "pageCount": context.get("pageCount"),
        "paragraphCount": context.get("paragraphCount"),
        "wordCount": context.get("wordCount"),
        "selection": context.get("selection"),
        "activeTemplate": context.get("activeTemplate"),
        "previewContext": context.get("previewContext"),
        "note": "这是压缩恢复上下文，不是新增文档或新增内容。",
    }
    cleaned = {key: value for key, value in payload.items() if value not in (None, "", [], {})}
    if len(cleaned) <= 3:
        return None
    return HumanMessage(content="[系统附件] type=document_snapshot\n" + json.dumps(cleaned, ensure_ascii=False, sort_keys=True))


def _build_recent_read_snapshot_attachment(messages: list[BaseMessage], *, limit: int = 3) -> HumanMessage | None:
    read_tool_names = {
        "get_document_content",
        "get_page_content",
        "get_page_style_summary",
        "get_paragraph",
        "search_text",
        "workspace_tree",
        "workspace_read",
        "workspace_search",
    }
    summaries: list[dict[str, Any]] = []
    for message in reversed(messages):
        if not isinstance(message, ToolMessage):
            continue
        payload = _parse_tool_result_payload(message.content)
        tool_name = str(payload.get("toolName") or "").strip()
        if tool_name not in read_tool_names:
            continue
        summaries.append({
            "toolName": tool_name,
            "success": payload.get("success"),
            "message": _truncate_preview(payload.get("message", ""), 160),
            "preview": _compact_dossier_result(
                json.dumps(payload.get("data", payload), ensure_ascii=False),
                700,
            ),
        })
        if len(summaries) >= limit:
            break
    if not summaries:
        return None
    payload = {
        "type": "recent_read_snapshot",
        "mode": "snapshot",
        "items": list(reversed(summaries)),
        "note": "这是最近读取结果摘要。需要原文时按任务需要重新读取，不要无意义重复搜索。",
    }
    return HumanMessage(content="[系统附件] type=recent_read_snapshot\n" + json.dumps(payload, ensure_ascii=False, sort_keys=True))


def _build_post_compact_restore_attachments(session: ReactSession) -> list[BaseMessage]:
    attachments: list[BaseMessage] = []
    context = _with_backend_workspace_docs(session.latest_context, query=session.body.message)
    session.latest_context = context

    previous_workspace_docs = list(context.get("workspaceDocs") or [])
    delta_content = build_delta_content(
        context,
        [],
        force_full=True,
        previous_workspace_docs=previous_workspace_docs,
    )
    _record_content_event(session, delta_content.trace)
    for item in delta_content.content or []:
        attachments.append(HumanMessage(content=item))
    current_workspace_docs = context.get("workspaceDocs")
    if isinstance(current_workspace_docs, list):
        session.state.previous_workspace_docs = list(current_workspace_docs)

    document_snapshot = _build_document_snapshot_attachment(context)
    if document_snapshot is not None:
        attachments.append(document_snapshot)
    task_snapshot = _build_task_snapshot_attachment(session.messages)
    if task_snapshot is not None:
        attachments.append(task_snapshot)
    recent_read_snapshot = _build_recent_read_snapshot_attachment(session.messages)
    if recent_read_snapshot is not None:
        attachments.append(recent_read_snapshot)

    tooling_delta = _build_tooling_delta_attachment_for_body(session.body, session.loaded_deferred_tools)
    if tooling_delta:
        attachments.append(HumanMessage(content=tooling_delta))
    return attachments


_active_sessions: dict[str, ReactSession] = {}
_completed_react_traces: dict[str, dict[str, Any]] = {}
_conversation_react_trace_index: dict[str, list[str]] = {}
MAX_COMPLETED_REACT_TRACES = 50
MAX_REACT_RUN_EVENTS = 1000


@dataclass
class ReactGatewayRun:
    session: ReactSession
    events: list[dict[str, Any]] = field(default_factory=list)
    status: str = "running"
    error: str | None = None
    task: asyncio.Task[None] | None = None
    condition: asyncio.Condition = field(default_factory=asyncio.Condition)
    created_at: str = field(default_factory=_now_iso)
    updated_at: str = field(default_factory=_now_iso)
    last_seq: int = 0

    @property
    def session_id(self) -> str:
        return self.session.session_id

    @property
    def conversation_id(self) -> str | None:
        return self.session.body.conversationId

    async def append_event(self, event: dict[str, Any]) -> dict[str, Any]:
        self.last_seq += 1
        item = {"seq": self.last_seq, **event}
        event_type = str(item.get("type") or "")
        if event_type in {"tool_result", "agent_tool_result", "round_start", "content", "thinking"}:
            if self.status != "completed":
                self.status = "running"
        elif event_type == "done":
            self.status = "completed"
        elif event_type == "error":
            self.status = "failed"
            self.error = str(item.get("message") or "AI 请求失败")

        self.updated_at = _now_iso()
        self.events.append(item)
        if len(self.events) > MAX_REACT_RUN_EVENTS:
            self.events = self.events[-MAX_REACT_RUN_EVENTS:]
        async with self.condition:
            self.condition.notify_all()
        return item

    def snapshot(self) -> dict[str, Any]:
        return {
            "sessionId": self.session_id,
            "conversationId": self.conversation_id,
            "status": self.status,
            "error": self.error,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "lastSeq": self.last_seq,
        }


_react_gateway_runs: dict[str, ReactGatewayRun] = {}
_conversation_gateway_run_index: dict[str, str] = {}


def create_react_session(body: ChatRequest) -> ReactSession:
    session_id = uuid.uuid4().hex[:12]
    content_events: list[dict[str, Any]] = []
    messages = build_messages(body, content_events=content_events)
    session = ReactSession(session_id, body, messages)
    _record_content_events(session, content_events)
    _active_sessions[session_id] = session
    return session


async def create_react_gateway_run(body: ChatRequest) -> ReactGatewayRun:
    session = create_react_session(body)
    run = ReactGatewayRun(session=session)
    _react_gateway_runs[session.session_id] = run
    if body.conversationId:
        _conversation_gateway_run_index[body.conversationId] = session.session_id

    async def runner() -> None:
        try:
            async for event in stream_react_session(session):
                await run.append_event(event)
        except HTTPException as exc:
            await run.append_event({"type": "error", "message": _http_error_message(exc)})
        except asyncio.CancelledError:
            await run.append_event({"type": "done", "reason": "stopped_by_client"})
            raise
        except Exception as exc:
            logger.exception("[openwps.ai] gateway run %s failed", session.session_id)
            await run.append_event({"type": "error", "message": _sanitize_upstream_error_detail(str(exc))})

    run.task = asyncio.create_task(runner())
    return run


def get_react_gateway_run(session_id: str) -> ReactGatewayRun | None:
    return _react_gateway_runs.get(session_id)


def get_conversation_react_gateway_run(conversation_id: str) -> dict[str, Any] | None:
    session_id = _conversation_gateway_run_index.get(conversation_id)
    if not session_id:
        return None
    run = _react_gateway_runs.get(session_id)
    if not run:
        _conversation_gateway_run_index.pop(conversation_id, None)
        return None
    return run.snapshot()


async def stream_react_gateway_run_events(
    session_id: str,
    after: int = 0,
) -> AsyncGenerator[dict[str, Any], None]:
    run = _react_gateway_runs.get(session_id)
    if not run:
        raise HTTPException(status_code=404, detail="React run not found or expired")

    cursor = max(int(after or 0), 0)
    while True:
        pending = [event for event in run.events if int(event.get("seq") or 0) > cursor]
        if pending:
            for event in pending:
                cursor = int(event.get("seq") or cursor)
                yield event
            if run.status in {"completed", "failed"}:
                return
            continue

        if run.status in {"completed", "failed"}:
            return

        async with run.condition:
            await run.condition.wait()


def cancel_react_gateway_run(session_id: str) -> None:
    run = _react_gateway_runs.get(session_id)
    if not run:
        raise HTTPException(status_code=404, detail="React run not found or expired")
    if run.task and not run.task.done():
        run.task.cancel()


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
        "contentEvents": list(session.trace.content_events),
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


def _record_tooling_delta_message(
    messages: list[BaseMessage],
    *,
    body: ChatRequest,
    loaded_deferred_tools: set[str],
    content_events: list[dict[str, Any]] | None = None,
) -> None:
    attachment = _build_tooling_delta_attachment_for_body(body, loaded_deferred_tools)
    deferred_count = len(_get_deferred_tool_definitions_for_body(body, loaded_deferred_tools))
    if content_events is not None:
        content_events.append({
            "type": "tooling_delta",
            "mode": body.mode or "layout",
            "deferredToolCount": deferred_count,
            "loadedDeferredToolCount": len(loaded_deferred_tools),
            "contentChars": len(attachment),
        })
    if attachment:
        messages.append(HumanMessage(content=attachment))


def _build_tooling_delta_attachment_for_body(
    body: ChatRequest,
    loaded_deferred_tools: set[str] | None = None,
) -> str:
    loaded = sorted(set(loaded_deferred_tools or set()))
    deferred = [
        definition.to_deferred_summary()
        for definition in _get_deferred_tool_definitions_for_body(body, set(loaded))
    ]
    if not deferred and not loaded:
        return ""
    payload = {
        "type": "tooling_delta",
        "mode": body.mode or "layout",
        "availableToolCount": len(_get_tool_definitions_for_body(body)),
        "deferredTools": deferred,
        "loadedDeferredTools": loaded,
        "mcpInstructionsDelta": [],
        "skillDiscoveryDelta": [],
    }
    lines = [
        "[系统附件] type=tooling_delta",
        json.dumps(payload, ensure_ascii=False, sort_keys=True),
    ]
    if deferred:
        lines.append("")
        lines.append("[延迟工具摘要]")
        lines.extend(
            f"- {item['name']} ({item['category']}): {item.get('searchHint') or item.get('description')}"
            for item in deferred
        )
        lines.append("需要其中任一工具时，先调用 ToolSearch 加载完整 schema。")
    return "\n".join(lines)


def build_messages(
    body: ChatRequest,
    content_events: list[dict[str, Any]] | None = None,
    loaded_deferred_tools: set[str] | None = None,
) -> list[BaseMessage]:
    provider, _ = _resolve_provider_and_model(body)
    loaded = set(loaded_deferred_tools or set())
    selected_tools = _get_model_tools_for_body(body, loaded)
    system_content = build_system_content(
        body.mode,
        provider,
        selected_tools,
        deferred_tool_count=len(_get_deferred_tool_definitions_for_body(body, loaded)),
        loaded_deferred_tool_count=len(loaded),
    )
    messages: list[BaseMessage] = [SystemMessage(content=system_content.prompt)]
    if content_events is not None:
        content_events.append(system_content.trace)
    _record_tooling_delta_message(messages, body=body, loaded_deferred_tools=loaded, content_events=content_events)

    # Inject initial context as delta attachment (full state announcement)
    context = _with_backend_workspace_docs(body.context, query=body.message)
    initial_context = build_initial_context_content(context)
    initial_attachment = str(initial_context.content or "")
    if content_events is not None:
        content_events.append(initial_context.trace)
    if initial_attachment:
        messages.append(HumanMessage(content=initial_attachment))

    if body.reactMessages:
        for i, item in enumerate(body.reactMessages):
            raw = dict(item)
            original = _stringify_content(raw.get("content"))
            user_content = build_user_content(
                original,
                "",  # context now injected as delta attachment
                body.images,
                body.attachments,
                body.ocrResults,
                body.imageProcessingMode,
                source=f"react_message_{i}",
            )
            if content_events is not None:
                content_events.append(user_content.trace)
            messages.append(HumanMessage(content=user_content.content))
        _log_final_user_message(body, messages)
        return messages

    for item in body.history[-10:]:
        messages.append(_to_langchain_message(item))

    user_content = build_user_content(
        body.message,
        "",  # context now injected as delta attachment
        body.images,
        body.attachments,
        body.ocrResults,
        body.imageProcessingMode,
        source="current_user",
    )
    if content_events is not None:
        content_events.append(user_content.trace)
    messages.append(HumanMessage(content=user_content.content))
    _log_final_user_message(body, messages)
    return messages


def _should_pass_empty_reasoning_content(provider: dict[str, Any], model: str, endpoint: str) -> bool:
    haystack = " ".join(
        str(value or "").lower()
        for value in (
            provider.get("id"),
            provider.get("label"),
            provider.get("name"),
            endpoint,
            model,
        )
    )
    return any(
        marker in haystack
        for marker in (
            "deepseek",
            "siliconflow",
            "dashscope",
            "qwen",
            "aliyun",
            "alibaba",
        )
    )


def build_llm(
    streaming: bool,
    body: ChatRequest,
    tools: list[dict[str, Any]] | None = None,
    loaded_deferred_tools: set[str] | None = None,
    agent_type: str | None = None,
) -> Runnable:
    provider, model = _resolve_provider_and_model(body)
    api_key = str(provider.get("apiKey", "") or "")
    endpoint = str(provider.get("endpoint", "https://api.siliconflow.cn/v1")).rstrip("/")
    if not model:
        model = "Qwen/Qwen2.5-72B-Instruct"
    selected_tools = tools if tools is not None else _get_model_tools_for_body(body, loaded_deferred_tools or set(), agent_type=agent_type)
    system_content = build_system_content(
        body.mode,
        provider,
        selected_tools,
        deferred_tool_count=len(_get_deferred_tool_definitions_for_body(body, loaded_deferred_tools or set())),
        loaded_deferred_tool_count=len(loaded_deferred_tools or set()),
    )
    model_kwargs = dict(system_content.prompt_cache.get("modelKwargs") or {})

    llm = ReasoningContentChatOpenAI(
        model=model,
        api_key=api_key or "not-needed",
        base_url=endpoint,
        temperature=0.3,
        streaming=streaming,
        stream_usage=streaming,
        pass_empty_reasoning_content=_should_pass_empty_reasoning_content(provider, model, endpoint),
        **({"model_kwargs": model_kwargs} if model_kwargs else {}),
    )
    return llm.bind_tools(selected_tools) if selected_tools else llm


class ContextOverflowError(Exception):
    """Raised when the model rejects the current message set for context length."""


def _is_context_overflow_detail(detail: Any) -> bool:
    text = str(detail or "").lower()
    return any(
        keyword in text
        for keyword in (
            "context_length",
            "context length",
            "context too long",
            "maximum context",
            "max context",
            "too long",
            "max_tokens",
            "maximum tokens",
        )
    )


def _build_summary_llm(body: ChatRequest, policy: CompactPolicy) -> ReasoningContentChatOpenAI:
    provider, model = _resolve_provider_and_model(body)
    api_key = str(provider.get("apiKey", "") or "")
    endpoint = str(provider.get("endpoint", "https://api.siliconflow.cn/v1")).rstrip("/")
    model = model or str(provider.get("defaultModel") or "Qwen/Qwen2.5-72B-Instruct")
    return ReasoningContentChatOpenAI(
        model=model,
        api_key=api_key or "not-needed",
        base_url=endpoint,
        temperature=0.1,
        streaming=False,
        max_tokens=policy.compact_summary_max_output_tokens,
        pass_empty_reasoning_content=_should_pass_empty_reasoning_content(provider, model, endpoint),
    )


def _resolve_subagent_model(parent_body: ChatRequest, agent: AgentDefinition) -> str:
    if agent.model:
        return str(agent.model).strip()
    inherited = str(parent_body.model or "").strip()
    if inherited:
        return inherited
    _, resolved_model = _resolve_provider_and_model(parent_body)
    return str(resolved_model or "").strip()


COMPLETION_ACTIVITY_CONFIG = {
    "conservative": {
        "temperature": 0.25,
        "instruction": "风格偏保守：只有上下文已经形成清晰句意时才补全；明显不足或不适合时可以输出空字符串。",
    },
    "standard": {
        "temperature": 0.35,
        "instruction": "风格偏自然：优先给出顺畅、贴合上下文的短续写；只有完全没有有效文本或明显不适合时才输出空字符串。",
    },
    "active": {
        "temperature": 0.55,
        "instruction": "风格偏积极：尽量给出可用续写，帮助用户继续写下去；除非没有任何有效上下文，否则不要输出空字符串。",
    },
}


def _normalize_completion_activity(value: str | None) -> str:
    activity = str(value or "standard").strip()
    return activity if activity in COMPLETION_ACTIVITY_CONFIG else "standard"


def _normalize_completion_candidate_count(value: int | None) -> int:
    try:
        count = int(value or 1)
    except (TypeError, ValueError):
        count = 1
    return max(1, min(count, 3))


def _completion_extra_body(provider: dict[str, Any], endpoint: str) -> dict[str, Any] | None:
    provider_id = str(provider.get("id") or "").lower()
    provider_label = str(provider.get("label") or "").lower()
    normalized_endpoint = endpoint.lower()
    if "openrouter" not in provider_id and "openrouter" not in provider_label and "openrouter" not in normalized_endpoint:
        return None

    # Some OpenRouter reasoning models can spend the whole short completion budget
    # on hidden reasoning and return message.content=null. Copilot needs plain text.
    return {"reasoning": {"enabled": False}}


def build_completion_llm(body: CompletionRequest, candidate_count: int) -> ChatOpenAI:
    cfg = read_config()
    provider = get_provider(cfg, body.providerId)
    model = str(body.model or provider.get("defaultModel") or "").strip()
    endpoint = str(provider.get("endpoint", "https://api.siliconflow.cn/v1")).rstrip("/")
    api_key = str(provider.get("apiKey", "") or "")
    if not model:
        model = "Qwen/Qwen2.5-72B-Instruct"
    activity = _normalize_completion_activity(body.activity)
    temperature = float(COMPLETION_ACTIVITY_CONFIG[activity]["temperature"])

    return ReasoningContentChatOpenAI(
        model=model,
        api_key=api_key or "not-needed",
        base_url=endpoint,
        temperature=temperature,
        streaming=False,
        n=candidate_count,
        max_tokens=96,
        pass_empty_reasoning_content=_should_pass_empty_reasoning_content(provider, model, endpoint),
        extra_body=_completion_extra_body(provider, endpoint),
    )


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
        prepared_body = await prepare_chat_request(body)
        llm = build_llm(streaming=False, body=prepared_body)
        graph = build_graph(llm)
        result = await graph.ainvoke({"messages": build_messages(prepared_body)})
        response: AIMessage = result["response"]
        reply = _strip_tool_result_json_leaks(_stringify_content(response.content))
        tool_calls = _tool_calls_from_ai_message(response)

        if tool_calls and not reply:
            reply = f"好的，我来帮你执行：{', '.join(call['name'] for call in tool_calls)}"

        cfg = read_config()
        provider = get_provider(cfg, prepared_body.providerId)
        return {
            "reply": reply,
            "toolCalls": tool_calls,
            "model": prepared_body.model or provider.get("defaultModel", ""),
        }
    except HTTPException:
        raise
    except Exception as exc:
        _raise_ai_api_request_error(body, exc)


COMPLETION_SYSTEM_PROMPT = """你是 openwps 的 AI 伴写自动补全引擎。
任务：根据光标前后的上下文，续写光标后的短文本。
严格规则：
- 只输出将要插入到光标处的纯文本。
- 不要解释，不要寒暄，不要 Markdown，不要代码围栏。
- 不要重复光标前已有文本。
- 不要改写已存在内容。
- 续写半句到一句即可，最多约 80 个中文字符。
- 不要输出编号列表；每个候选只给一段可直接插入的文本。"""


MULTI_COMPLETION_SYSTEM_PROMPT = """你是 openwps 的 AI 伴写多候选补全引擎。
任务：根据光标前后的上下文，生成多条可替换选择的短续写。
严格规则：
- 只返回严格 JSON 数组，数组元素必须是字符串。
- 不要解释，不要寒暄，不要 Markdown，不要代码围栏。
- 每个数组元素都是一条可直接插入光标处的候选。
- 候选之间要有明显措辞差异，但都必须贴合上下文。
- 不要重复光标前已有文本，不要改写已存在内容。
- 每条候选续写半句到一句即可，最多约 80 个中文字符。"""


def _build_completion_user_prompt(body: CompletionRequest) -> str:
    max_chars = max(8, min(int(body.maxChars or 80), 120))
    activity = _normalize_completion_activity(body.activity)
    activity_instruction = COMPLETION_ACTIVITY_CONFIG[activity]["instruction"]
    return "\n".join([
        "[补全策略]",
        str(activity_instruction),
        "",
        "[文档统计]",
        f"页数：{body.pageCount}",
        f"段落数：{body.paragraphCount}",
        f"字数：{body.wordCount}",
        "",
        "[相邻段落]",
        f"上一段：{_compact_text_preview(body.previousParagraphText, 240)}",
        f"下一段：{_compact_text_preview(body.nextParagraphText, 240)}",
        "",
        "[当前段落]",
        f"光标前：{_compact_text_preview(body.prefixText, 500)}",
        f"光标后：{_compact_text_preview(body.suffixText, 240)}",
        f"整段：{_compact_text_preview(body.paragraphText, 700)}",
        "",
        f"请只输出适合插入光标处的续写文本，最多 {max_chars} 个中文字符。",
    ])


def _build_multi_completion_user_prompt(body: CompletionRequest, candidate_count: int) -> str:
    max_chars = max(8, min(int(body.maxChars or 80), 120))
    activity = _normalize_completion_activity(body.activity)
    activity_instruction = COMPLETION_ACTIVITY_CONFIG[activity]["instruction"]
    return "\n".join([
        "[补全策略]",
        str(activity_instruction),
        "",
        "[候选要求]",
        f"请生成 {candidate_count} 条不同候选。",
        f"每条最多 {max_chars} 个中文字符。",
        "返回格式必须是严格 JSON 数组，例如：[\"候选一\", \"候选二\"]",
        "",
        "[文档统计]",
        f"页数：{body.pageCount}",
        f"段落数：{body.paragraphCount}",
        f"字数：{body.wordCount}",
        "",
        "[相邻段落]",
        f"上一段：{_compact_text_preview(body.previousParagraphText, 240)}",
        f"下一段：{_compact_text_preview(body.nextParagraphText, 240)}",
        "",
        "[当前段落]",
        f"光标前：{_compact_text_preview(body.prefixText, 500)}",
        f"光标后：{_compact_text_preview(body.suffixText, 240)}",
        f"整段：{_compact_text_preview(body.paragraphText, 700)}",
    ])


def _clean_completion_text(raw_text: str, body: CompletionRequest) -> str:
    text = _strip_tool_result_json_leaks(raw_text or "")
    text = re.sub(r"^```(?:\w+)?\s*", "", text.strip())
    text = re.sub(r"\s*```$", "", text).strip()
    text = re.sub(r"^(?:补全|续写|建议|输出|回答)[:：]\s*", "", text).strip()
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"\n{3,}", "\n\n", text)

    prefix_tail = (body.prefixText or "").strip()[-80:]
    if prefix_tail and text.startswith(prefix_tail):
        text = text[len(prefix_tail):].lstrip()

    suffix_head = (body.suffixText or "").strip()[:80]
    if suffix_head and text.endswith(suffix_head):
        text = text[: -len(suffix_head)].rstrip()

    max_chars = max(8, min(int(body.maxChars or 80), 120))
    stop_match = re.search(r"(.{1,%d}?[。！？!?；;])" % max_chars, text, flags=re.S)
    if stop_match:
        text = stop_match.group(1)
    elif len(text) > max_chars:
        text = text[:max_chars].rstrip()

    return text.strip()


def _extract_completion_list(raw_text: str) -> list[str]:
    text = (raw_text or "").strip()
    if not text:
        return []

    candidates: list[str] = [text]
    candidates.extend(
        match.group(1).strip()
        for match in re.finditer(r"```(?:json)?\s*([\s\S]*?)```", text, flags=re.IGNORECASE)
        if match.group(1).strip()
    )

    array_start = text.find("[")
    array_end = text.rfind("]")
    if array_start >= 0 and array_end > array_start:
        candidates.append(text[array_start:array_end + 1])

    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except Exception:
            continue
        if isinstance(parsed, list):
            return [item for item in parsed if isinstance(item, str)]
        if isinstance(parsed, dict):
            values = parsed.get("completions") or parsed.get("candidates")
            if isinstance(values, list):
                return [item for item in values if isinstance(item, str)]

    lines = []
    for line in text.splitlines():
        normalized = re.sub(r"^\s*(?:[-*]|\d+[.)、])\s*", "", line).strip()
        if normalized:
            lines.append(normalized.strip('"“”'))
    return lines


def _dedupe_completion_texts(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        text = value.strip()
        if not text or text in seen:
            continue
        seen.add(text)
        result.append(text)
    return result


async def _generate_completion_texts(body: CompletionRequest, candidate_count: int) -> list[str]:
    messages = [
        SystemMessage(content=COMPLETION_SYSTEM_PROMPT),
        HumanMessage(content=_build_completion_user_prompt(body)),
    ]

    llm = build_completion_llm(body, candidate_count)
    result = await llm.agenerate([messages])
    generations = result.generations[0] if result.generations else []
    return [
        _clean_completion_text(_stringify_content(generation.message.content), body)
        for generation in generations
    ]


async def _generate_completion_list_texts(body: CompletionRequest, candidate_count: int) -> list[str]:
    messages = [
        SystemMessage(content=MULTI_COMPLETION_SYSTEM_PROMPT),
        HumanMessage(content=_build_multi_completion_user_prompt(body, candidate_count)),
    ]

    llm = build_completion_llm(body, 1)
    result = await llm.agenerate([messages])
    generations = result.generations[0] if result.generations else []
    values: list[str] = []
    for generation in generations:
        values.extend(_extract_completion_list(_stringify_content(generation.message.content)))
    return [_clean_completion_text(value, body) for value in values]


async def run_completion(body: CompletionRequest) -> dict[str, Any]:
    try:
        if not (body.prefixText or body.paragraphText or body.previousParagraphText).strip():
            return {"completion": "", "completions": [], "model": body.model or ""}

        candidate_count = _normalize_completion_candidate_count(body.candidateCount)
        completions = _dedupe_completion_texts(
            await (
                _generate_completion_texts(body, 1)
                if candidate_count <= 1
                else _generate_completion_list_texts(body, candidate_count)
            )
        )
        completions = completions[:candidate_count]

        cfg = read_config()
        provider = get_provider(cfg, body.providerId)
        return {
            "completion": completions[0] if completions else "",
            "completions": completions,
            "model": body.model or provider.get("defaultModel", ""),
        }
    except HTTPException:
        raise
    except Exception as exc:
        detail = _sanitize_upstream_error_detail(str(exc))
        raise HTTPException(status_code=502, detail=f"AI 伴写请求失败: {detail}") from exc


async def stream_react_round(body: ChatRequest) -> AsyncGenerator[dict[str, Any], None]:
    prepared_body = await prepare_chat_request(body)
    llm = build_llm(streaming=True, body=prepared_body)
    graph = build_graph(llm)
    tool_call_acc: dict[int, dict[str, Any]] = {}
    range_required_tools = {"set_text_style", "set_paragraph_style", "clear_formatting"}

    try:
        async for event in graph.astream_events({"messages": build_messages(prepared_body)}, version="v2"):
            if event.get("event") != "on_chat_model_stream":
                continue

            chunk = event.get("data", {}).get("chunk")
            if not isinstance(chunk, AIMessageChunk):
                continue

            reasoning = _extract_reasoning(chunk)
            if reasoning:
                yield {"type": "thinking", "content": reasoning}

            content = _strip_tool_result_json_leaks(_stringify_content(chunk.content))
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
        _raise_ai_api_request_error(prepared_body, exc)

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
    assistant_reasoning = ""
    finish_reason = ""
    token_usage: dict[str, int] = {}

    try:
        async for event in graph.astream_events({"messages": messages}, version="v2"):
            event_name = event.get("event")
            if event_name == "on_chat_model_end":
                output = event.get("data", {}).get("output")
                extracted_finish_reason = _extract_finish_reason(output)
                if extracted_finish_reason:
                    finish_reason = extracted_finish_reason
                extracted_usage = _extract_token_usage(output)
                if extracted_usage:
                    token_usage = extracted_usage
                continue

            if event_name != "on_chat_model_stream":
                continue
            chunk = event.get("data", {}).get("chunk")
            if not isinstance(chunk, AIMessageChunk):
                continue

            extracted_usage = _extract_token_usage(chunk)
            if extracted_usage:
                token_usage = extracted_usage

            extracted_finish_reason = _extract_finish_reason(chunk)
            if extracted_finish_reason:
                finish_reason = extracted_finish_reason

            reasoning = _extract_reasoning(chunk)
            if reasoning:
                assistant_reasoning += reasoning
                yield {"type": "thinking", "content": reasoning}

            content = _strip_tool_result_json_leaks(_stringify_content(chunk.content))
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
        _raise_ai_api_request_error(body, exc)

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
        "reasoning_content": assistant_reasoning,
        "tool_calls": parsed_tool_calls,
        "finish_reason": finish_reason,
        "token_usage": token_usage,
    }


class QueryCoordinator:
    """Backend-owned ReAct coordinator, modelled after Claude Code's query loop."""

    def __init__(self, session: ReactSession):
        self.session = session
        self.state = session.state

    def _make_recovery_event(self, action: str, **data: Any) -> dict[str, Any]:
        _record_trace_event(self.session, "recovery", round=self.state.round, action=action, **data)
        return {
            "type": "recovery",
            "action": action,
            **data,
        }

    def _compact_policy(self) -> CompactPolicy:
        provider, model = _resolve_provider_and_model(self.session.body)
        return build_compact_policy(provider, model)

    async def _generate_compact_summary(
        self,
        messages: list[BaseMessage],
        *,
        policy: CompactPolicy,
        source: str,
    ) -> str:
        candidate = list(messages)
        last_error: Exception | None = None
        for attempt in range(1, MAX_COMPACT_RETRIES + 1):
            prompt_messages = build_compact_prompt(candidate, policy=policy, source=source)
            llm = _build_summary_llm(self.session.body, policy)
            try:
                response = await llm.ainvoke(prompt_messages)
            except Exception as exc:
                last_error = exc
                if _is_context_overflow_detail(exc):
                    candidate, changed = drop_oldest_api_round(candidate)
                    if changed:
                        _record_trace_event(
                            self.session,
                            "compact_retry",
                            round=self.state.round,
                            source=source,
                            attempt=attempt,
                            reason="compact_prompt_too_long",
                            remainingMessages=len(candidate),
                        )
                        continue
                raise
            usage = _extract_token_usage(response)
            if usage:
                self.state.last_api_usage = usage
                _record_trace_event(
                    self.session,
                    "token_usage",
                    round=self.state.round,
                    source=f"compact:{source}",
                    **usage,
                )
            summary = _stringify_content(getattr(response, "content", response)).strip()
            if summary:
                return summary
            last_error = RuntimeError("compact summary is empty")
            candidate, changed = drop_oldest_api_round(candidate)
            if not changed:
                break
        if last_error is not None:
            raise RuntimeError(f"上下文压缩失败: {last_error}") from last_error
        raise RuntimeError("上下文压缩失败: compact summary is empty")

    async def _compact_session_messages(self, *, source: str, reactive: bool = False) -> dict[str, Any]:
        policy = self._compact_policy()
        pre_tokens = count_messages_tokens(self.session.messages, model=policy.model)
        _record_trace_event(
            self.session,
            "compact_start",
            round=self.state.round,
            source=source,
            preTokens=pre_tokens,
            contextWindowTokens=policy.context_window_tokens,
            autoCompactThresholdTokens=policy.auto_compact_threshold_tokens,
            reactive=reactive,
        )
        summary = await self._generate_compact_summary(self.session.messages, policy=policy, source=source)
        restored = _build_post_compact_restore_attachments(self.session)
        result = build_compacted_messages(
            self.session.messages,
            summary=summary,
            policy=policy,
            source=source,
            restored_attachments=restored,
        )
        self.session.messages = result.messages
        self.state.estimated_tokens = result.post_token_count
        self.state.last_compact_source = source
        self.state.last_compact_pre_tokens = result.pre_token_count
        self.state.last_compact_post_tokens = result.post_token_count
        self.state.compact_failure_count = 0
        payload = {
            "type": "compact_end",
            "source": source,
            "preTokens": result.pre_token_count,
            "postTokens": result.post_token_count,
            "summaryChars": result.summary_chars,
            "restoredAttachmentTypes": result.restored_attachment_types,
            "preservedTailCount": result.preserved_tail_count,
            "reactive": reactive,
        }
        _record_trace_event(self.session, "compact_end", round=self.state.round, **payload)
        return payload

    async def _maybe_microcompact(self) -> dict[str, Any] | None:
        policy = self._compact_policy()
        result = microcompact_messages(self.session.messages, model=policy.model)
        if not result.changed:
            self.state.estimated_tokens = result.post_token_count
            return None
        self.session.messages = result.messages
        self.state.estimated_tokens = result.post_token_count
        self.state.microcompact_count += result.compacted_tool_results
        payload = {
            "type": "microcompact",
            "preTokens": result.pre_token_count,
            "postTokens": result.post_token_count,
            "compactedToolResults": result.compacted_tool_results,
        }
        _record_trace_event(self.session, "microcompact", round=self.state.round, **payload)
        return payload

    async def _prepare_context_before_model(self) -> AsyncGenerator[dict[str, Any], None]:
        microcompact_event = await self._maybe_microcompact()
        if microcompact_event:
            yield microcompact_event

        policy = self._compact_policy()
        self.state.estimated_tokens = count_messages_tokens(self.session.messages, model=policy.model)
        if not should_auto_compact(self.session.messages, policy):
            return

        if self.state.compact_failure_count >= MAX_COMPACT_RETRIES:
            message = "上下文压缩连续失败，已停止自动链路。请缩短对话或重新开始当前任务。"
            _record_trace_event(self.session, "compact_failed", round=self.state.round, source="auto", message=message)
            yield {"type": "compact_failed", "source": "auto", "message": message}
            self.session.finished = True
            self.state.transition = Transition.FATAL_ERROR
            return

        yield {
            "type": "compact_start",
            "source": "auto",
            "preTokens": self.state.estimated_tokens,
            "contextWindowTokens": policy.context_window_tokens,
            "autoCompactThresholdTokens": policy.auto_compact_threshold_tokens,
        }
        try:
            compact_event = await self._compact_session_messages(source="auto", reactive=False)
        except Exception as exc:
            self.state.compact_failure_count += 1
            message = f"自动上下文压缩失败: {_normalize_ai_api_error_detail(self.session.body, str(exc))}"
            _record_trace_event(self.session, "compact_failed", round=self.state.round, source="auto", message=message)
            yield {"type": "compact_failed", "source": "auto", "message": message}
            self.session.finished = True
            self.state.transition = Transition.FATAL_ERROR
            return
        yield compact_event
        yield {
            "type": "compression",
            "source": "auto",
            "estimated_tokens": compact_event["postTokens"],
            "preTokens": compact_event["preTokens"],
            "postTokens": compact_event["postTokens"],
        }

    async def _run_model_round(self, messages: list[BaseMessage]) -> AsyncGenerator[dict[str, Any], None]:
        round_content = ""
        round_reasoning = ""
        round_tool_calls: list[dict[str, Any]] = []
        round_finish_reason = ""

        for attempt in range(MAX_RETRIES_PER_ROUND + 1):
            round_content = ""
            round_reasoning = ""
            round_tool_calls = []
            round_finish_reason = ""
            round_token_usage: dict[str, int] = {}
            llm = build_llm(
                streaming=True,
                body=self.session.body,
                loaded_deferred_tools=self.session.loaded_deferred_tools,
            )
            graph = build_graph(llm)

            try:
                async for event in _run_llm_round(graph, messages, self.session.body, self.state.round):
                    if event["type"] == "_round_result":
                        round_content = event["content"]
                        round_reasoning = str(event.get("reasoning_content", "") or "")
                        round_tool_calls = event["tool_calls"]
                        round_finish_reason = str(event.get("finish_reason", "") or "")
                        round_token_usage = event.get("token_usage") if isinstance(event.get("token_usage"), dict) else {}
                    else:
                        yield event
                self.state.consecutive_errors = 0
                yield {
                    "type": "_round_result",
                    "content": round_content,
                    "reasoning_content": round_reasoning,
                    "tool_calls": round_tool_calls,
                    "finish_reason": round_finish_reason,
                    "token_usage": round_token_usage,
                }
                return
            except HTTPException as exc:
                self.state.consecutive_errors += 1
                if _is_context_overflow_detail(exc.detail):
                    raise ContextOverflowError(str(exc.detail)) from exc
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
                if _is_context_overflow_detail(exc):
                    raise ContextOverflowError(str(exc)) from exc
                raise

        yield {
            "type": "_round_result",
            "content": round_content,
            "reasoning_content": round_reasoning,
            "tool_calls": round_tool_calls,
            "finish_reason": round_finish_reason,
            "token_usage": round_token_usage,
        }

    async def _resolve_layout_preflight_page_count(self) -> int:
        context_page_count = _coerce_context_page_count(self.session.latest_context)
        probe = await execute_ai_document_tool(
            "get_page_content",
            {"page": 1},
            self.session.latest_context or self.session.body.context or {},
        )
        data = probe.get("data") if isinstance(probe.get("data"), dict) else {}
        try:
            measured = int(data.get("pageCount"))
        except Exception:
            measured = 0
        return max(context_page_count, measured, 1)

    async def _run_layout_preflight_page(
        self,
        page: int,
        page_count: int,
        *,
        screenshot_available: bool,
    ) -> dict[str, Any]:
        agent = get_agent_definition("layout-plan")
        agent_id = new_agent_run_id()
        result_text = ""
        trace_events: list[dict[str, Any]] = []
        prompt = _build_layout_preflight_prompt(page, page_count, screenshot_available=screenshot_available)
        async for event in self._run_subagent(
            agent_id=agent_id,
            agent=agent,
            description=f"分析第 {page} 页样式",
            prompt=prompt,
            background=False,
        ):
            if event["type"] == "_subagent_result":
                result_text = str(event.get("content") or "")
            else:
                trace_events.append(event)
        used_tools = {
            str(event.get("name") or "")
            for event in trace_events
            if event.get("type") == "agent_tool_call"
        }
        fallback_parts: list[str] = []
        for required_tool in ("get_page_content", "get_page_style_summary"):
            if required_tool in used_tools:
                continue
            direct_result = await execute_ai_document_tool(
                required_tool,
                {"page": page},
                self.session.latest_context or self.session.body.context or {},
            )
            data = direct_result.get("data") if isinstance(direct_result.get("data"), dict) else {}
            fallback_parts.append(
                f"[后端补充证据:{required_tool}] success={direct_result.get('success') is True} "
                f"message={direct_result.get('message')}\n"
                f"{_truncate_preview(json.dumps(data, ensure_ascii=False), 1600)}"
            )
        if fallback_parts:
            result_text = "\n\n".join([part for part in [result_text.strip(), *fallback_parts] if part])
        return {
            "page": page,
            "agentId": agent_id,
            "success": bool(result_text.strip()),
            "result": result_text.strip(),
            "usedTools": sorted(tool for tool in used_tools if tool),
            "traceEventCount": len(trace_events),
        }

    async def _run_layout_preflight(self) -> AsyncGenerator[dict[str, Any], None]:
        if self.state.layout_preflight_completed or self.state.layout_preflight_failed:
            return
        if not _should_require_layout_preflight(self.session.body, self.session.latest_context):
            return

        self.state.layout_preflight_required = True
        self.state.content_locked_for_layout = not _layout_content_mutation_explicitly_requested(self.session.body)
        self.session.latest_context["contentLockedForLayout"] = self.state.content_locked_for_layout
        self.state.layout_preflight_signature = await _read_layout_content_signature(self.session.latest_context)

        capabilities = _resolve_runtime_capabilities(self.session.body)
        screenshot_available = _tool_available_for_runtime("capture_page_screenshot", capabilities)
        page_count = await self._resolve_layout_preflight_page_count()
        yield {
            "type": "layout_preflight_start",
            "pageCount": page_count,
            "batchSize": LAYOUT_PREFLIGHT_BATCH_SIZE,
            "visualEnabled": screenshot_available,
            "contentLockedForLayout": self.state.content_locked_for_layout,
        }
        _record_trace_event(
            self.session,
            "layout_preflight_start",
            pageCount=page_count,
            visualEnabled=screenshot_available,
            contentLockedForLayout=self.state.content_locked_for_layout,
        )

        pages: list[dict[str, Any]] = []
        try:
            for start in range(1, page_count + 1, LAYOUT_PREFLIGHT_BATCH_SIZE):
                batch_pages = list(range(start, min(start + LAYOUT_PREFLIGHT_BATCH_SIZE, page_count + 1)))
                for page in batch_pages:
                    yield {
                        "type": "layout_preflight_page_start",
                        "page": page,
                        "pageCount": page_count,
                    }
                results = await asyncio.gather(*[
                    self._run_layout_preflight_page(page, page_count, screenshot_available=screenshot_available)
                    for page in batch_pages
                ], return_exceptions=True)
                for page, result in zip(batch_pages, results):
                    if isinstance(result, Exception):
                        page_result = {
                            "page": page,
                            "success": False,
                            "error": str(result),
                            "result": "",
                        }
                    else:
                        page_result = result
                    pages.append(page_result)
                    yield {
                        "type": "layout_preflight_page_done",
                        "page": page,
                        "pageCount": page_count,
                        "success": page_result.get("success") is True,
                        "summary": _compact_dossier_result(str(page_result.get("result") or page_result.get("error") or ""), 240),
                    }
        except Exception as exc:
            self.state.layout_preflight_failed = True
            safe_error = _sanitize_upstream_error_detail(str(exc))
            _record_trace_event(self.session, "layout_preflight_failed", error=safe_error)
            yield {
                "type": "layout_preflight_done",
                "pageCount": page_count,
                "success": False,
                "error": safe_error,
            }
            return

        dossier = {
            "pageCount": page_count,
            "visualEnabled": screenshot_available,
            "contentLockedForLayout": self.state.content_locked_for_layout,
            "pages": pages,
        }
        all_success = len(pages) == page_count and all(page.get("success") is True for page in pages)
        self.state.layout_style_dossier = dossier
        self.state.layout_preflight_completed = all_success
        self.state.layout_preflight_failed = not all_success
        self.session.latest_context["layoutStyleDossier"] = dossier
        self.session.messages.append(HumanMessage(content=_format_layout_dossier_for_model(dossier)))
        _record_trace_event(
            self.session,
            "layout_preflight_done",
            pageCount=page_count,
            successCount=sum(1 for page in pages if page.get("success") is True),
            success=all_success,
            contentLockedForLayout=self.state.content_locked_for_layout,
        )
        yield {
            "type": "layout_preflight_done",
            "pageCount": page_count,
            "success": all_success,
            "successCount": sum(1 for page in pages if page.get("success") is True),
            "contentLockedForLayout": self.state.content_locked_for_layout,
        }

    def _blocked_execution_content(self, execution: PlannedToolExecution) -> str | None:
        if (
            self.state.layout_preflight_required
            and not self.state.layout_preflight_completed
            and _is_preflight_guarded_style_execution(execution)
        ):
            return _serialize_tool_result_payload(
                tool_name=execution.tool_name,
                success=False,
                message="排版样式工具已被后端阻断：逐页 Layout Preflight 尚未完成。",
                data={"layoutPreflightRequired": True, "layoutPreflightCompleted": False},
                executed_params=execution.params,
                original_params=execution.params,
            )
        if (
            self.state.content_locked_for_layout
            and _is_layout_content_tool_blocked(execution.tool_name)
            and not _layout_content_mutation_explicitly_requested(self.session.body)
        ):
            return _serialize_tool_result_payload(
                tool_name=execution.tool_name,
                success=False,
                message="排版结构保护已阻断：当前任务只允许修改样式和页面设置，不能删除、重写或插入正文结构。",
                data={"contentLockedForLayout": True, "blockedTool": execution.tool_name},
                executed_params=execution.params,
                original_params=execution.params,
            )
        return None

    async def _execute_server_execution(
        self,
        execution: PlannedToolExecution,
    ) -> tuple[dict[str, str], dict[str, Any], list[dict[str, Any]]]:
        blocked_content = self._blocked_execution_content(execution)
        if blocked_content is not None:
            content = blocked_content
            newly_loaded = []
        elif execution.tool_name == TOOL_SEARCH_NAME:
            before_loaded = set(self.session.loaded_deferred_tools)
            content = _run_tool_search_tool(
                execution.params,
                body=self.session.body,
                loaded_deferred_tools=self.session.loaded_deferred_tools,
            )
            newly_loaded = sorted(self.session.loaded_deferred_tools - before_loaded)
        elif execution.tool_name in {"TaskCreate", "TaskGet", "TaskList", "TaskUpdate"}:
            content = await _run_task_tool(execution.tool_name, execution.params, self.session.body.conversationId)
            newly_loaded = []
        elif execution.tool_name in {"workspace_tree", "workspace_search", "workspace_read", "workspace_open", "workspace_memory_write", "workspace_memory_delete"}:
            content = await _run_workspace_tool(
                execution.tool_name,
                execution.params,
                self.session.workspace_tool_cache,
                self.session.latest_context,
            )
            newly_loaded = []
        elif execution.tool_name == "analyze_image_with_ocr":
            content = await _run_ocr_attachment_tool(execution.params, self.session.body)
            newly_loaded = []
        elif execution.tool_name == "web_search":
            content = await _run_web_search_tool(execution.params)
            newly_loaded = []
        elif execution.tool_name == "analyze_document_image":
            content = await _run_document_image_analysis_tool(
                execution.params,
                self.session.body,
                self.session.latest_context or self.session.body.context or {},
            )
            newly_loaded = []
        elif is_document_tool(execution.tool_name):
            tool_context = dict(self.session.latest_context or self.session.body.context or {})
            if self.state.content_locked_for_layout and execution.tool_name in LAYOUT_PREFLIGHT_STYLE_TOOLS:
                tool_context["contentLockedForLayout"] = True
            tool_result = await execute_ai_document_tool(
                execution.tool_name,
                execution.params,
                tool_context,
            )
            content = _serialize_tool_result_payload(
                tool_name=execution.tool_name,
                success=tool_result.get("success") is True,
                message=str(tool_result.get("message") or ""),
                data=tool_result.get("data"),
                executed_params=execution.params,
                original_params=execution.params,
            )
            newly_loaded = []
        else:
            content = _serialize_tool_result_payload(
                tool_name=execution.tool_name,
                success=False,
                message=f"未知服务端工具：{execution.tool_name}",
                executed_params=execution.params,
                original_params=execution.params,
            )

        safe_content, image_message = await _prepare_page_screenshot_tool_result_for_runtime(content, self.session.body)
        payload = _parse_tool_result_payload(safe_content)
        result = {
            "execution_id": execution.execution_id,
            "content": safe_content,
        }
        summary = {
            "executionId": execution.execution_id,
            "toolName": execution.tool_name,
            "success": payload.get("success") is True,
            "message": _truncate_preview(payload.get("message", ""), 120),
            "mergeStrategy": execution.merge_strategy,
            "sourceToolCallCount": len(execution.source_calls),
        }

        events: list[dict[str, Any]] = []
        for source_call in execution.source_calls:
            self.session.messages.append(ToolMessage(
                content=_decorate_tool_result_content(safe_content, execution, source_call),
                tool_call_id=source_call.id,
            ))
            events.append(_build_tool_result_event(execution, source_call, payload))
        if image_message is not None:
            self.session.messages.append(image_message)

        _record_content_event(self.session, {
            "type": "tool_results",
            "source": "server",
            "toolName": execution.tool_name,
            "executionCount": 1,
            "sourceToolCallCount": len(execution.source_calls),
            "contentChars": len(safe_content),
        })
        if execution.tool_name == TOOL_SEARCH_NAME:
            _record_content_event(self.session, {
                "type": "tooling_delta",
                "mode": self.session.body.mode or "layout",
                "source": "ToolSearch",
                "loadedToolNamesHash": _stable_short_hash(newly_loaded),
                "loadedDeferredToolCount": len(self.session.loaded_deferred_tools),
                "deferredToolCount": len(_get_deferred_tool_definitions_for_body(self.session.body, self.session.loaded_deferred_tools)),
            })
            events.append({
                "type": "tooling_delta",
                "loadedToolNames": newly_loaded,
                "loadedDeferredToolCount": len(self.session.loaded_deferred_tools),
                "deferredToolCount": len(_get_deferred_tool_definitions_for_body(self.session.body, self.session.loaded_deferred_tools)),
            })
        return result, summary, events

    async def _commit_server_streaming_write(self, markdown: str) -> dict[str, Any]:
        pending = self.session.server_streaming_write
        self.session.server_streaming_write = None
        if not pending:
            return {"success": False, "message": "没有待提交的服务端流式写入"}
        params = {**pending, "markdown": markdown}
        result = await execute_ai_document_tool(
            "begin_streaming_write",
            params,
            self.session.latest_context or self.session.body.context or {},
        )
        success = result.get("success") is True
        _record_content_event(self.session, {
            "type": "server_streaming_write_committed",
            "success": success,
            "message": str(result.get("message") or ""),
            "contentChars": len(markdown),
        })
        return result

    async def _run_subagent(
        self,
        *,
        agent_id: str,
        agent: AgentDefinition,
        description: str,
        prompt: str,
        background: bool = False,
    ) -> AsyncGenerator[dict[str, Any], None]:
        child_loaded_deferred_tools: set[str] = set()
        body_data = self.session.body.model_dump()
        selected_model = _resolve_subagent_model(self.session.body, agent)
        if selected_model:
            body_data["model"] = selected_model
        child_body = ChatRequest(**body_data)
        agent_body = child_body.model_copy(update={"mode": "agent"})
        available_tool_names = {
            definition.name
            for definition in _get_tool_definitions_for_body(agent_body)
        }
        tool_names = resolve_agent_tool_names(agent, available_tool_names, background=background)
        subagent_content = build_subagent_content(
            agent=agent,
            tool_names=tool_names,
            description=description,
            prompt=prompt,
            context=self.session.latest_context or {},
            background=background,
        )
        _record_content_event(self.session, subagent_content.trace)
        subagent_payload = dict(subagent_content.content)
        child_messages: list[BaseMessage] = [
            SystemMessage(content=str(subagent_payload.get("systemPrompt") or ""))
        ]
        child_messages.append(HumanMessage(content=str(subagent_payload.get("userPrompt") or "")))

        yield {
            "type": "agent_start",
            "agentId": agent_id,
            "agentType": agent.agent_type,
            "description": description,
            "runMode": "background" if background else "sync",
            "tools": tool_names,
            "maxTurns": agent.max_turns,
            "model": selected_model,
        }

        final_text = ""
        for child_round in range(1, agent.max_turns + 1):
            yield {
                "type": "agent_progress",
                "agentId": agent_id,
                "agentType": agent.agent_type,
                "phase": "round_start",
                "round": child_round,
            }

            round_content = ""
            round_reasoning = ""
            round_tool_calls: list[dict[str, Any]] = []
            child_tools = _select_model_tools_by_names(
                tool_names,
                loaded_deferred_tools=child_loaded_deferred_tools,
                body=child_body,
                agent_type=agent.agent_type,
            )
            graph = build_graph(build_llm(
                streaming=True,
                body=child_body,
                tools=child_tools,
                loaded_deferred_tools=child_loaded_deferred_tools,
                agent_type=agent.agent_type,
            ))
            async for event in _run_llm_round(graph, child_messages, child_body, child_round):
                event_type = event["type"]
                if event_type == "_round_result":
                    round_content = event["content"]
                    round_reasoning = str(event.get("reasoning_content", "") or "")
                    round_tool_calls = event["tool_calls"]
                    continue
                if event_type == "content":
                    yield {
                        "type": "agent_progress",
                        "agentId": agent_id,
                        "agentType": agent.agent_type,
                        "phase": "content",
                        "content": event.get("content", ""),
                    }
                    continue
                if event_type == "thinking":
                    yield {
                        "type": "agent_progress",
                        "agentId": agent_id,
                        "agentType": agent.agent_type,
                        "phase": "thinking",
                        "content": event.get("content", ""),
                    }
                    continue
                if event_type == "tool_call":
                    yield {
                        "type": "agent_tool_call",
                        "agentId": agent_id,
                        "agentType": agent.agent_type,
                        "id": event.get("id"),
                        "name": event.get("name"),
                        "params": event.get("params"),
                    }

            if not round_tool_calls:
                final_text = round_content.strip()
                child_messages.append(_build_ai_message(
                    content=round_content,
                    reasoning_content=round_reasoning,
                ))
                break

            child_messages.append(_build_ai_message(
                content=round_content,
                tool_calls=[
                    {"id": tool_call["id"], "name": tool_call["name"], "args": tool_call["params"], "type": "tool_call"}
                    for tool_call in round_tool_calls
                ],
                reasoning_content=round_reasoning,
            ))

            execution_plan = _build_execution_plan(child_round, round_tool_calls)
            server_executions, client_executions = _split_execution_plan(execution_plan)

            for server_execution in server_executions:
                if server_execution.tool_name == "Agent":
                    content = _serialize_tool_result_payload(
                        tool_name="Agent",
                        success=False,
                        message="子代理不能再启动子代理",
                        executed_params=server_execution.params,
                        original_params=server_execution.params,
                    )
                    for source_call in server_execution.source_calls:
                        child_messages.append(ToolMessage(
                            content=_decorate_tool_result_content(content, server_execution, source_call),
                            tool_call_id=source_call.id,
                        ))
                    continue
                if server_execution.tool_name == TOOL_SEARCH_NAME:
                    server_content = _run_tool_search_tool(
                        server_execution.params,
                        body=child_body,
                        loaded_deferred_tools=child_loaded_deferred_tools,
                    )
                elif server_execution.tool_name in {"TaskCreate", "TaskGet", "TaskList", "TaskUpdate"}:
                    server_content = await _run_task_tool(
                        server_execution.tool_name,
                        server_execution.params,
                        self.session.body.conversationId,
                    )
                elif server_execution.tool_name in {"workspace_tree", "workspace_search", "workspace_read", "workspace_open", "workspace_memory_write", "workspace_memory_delete"}:
                    server_content = await _run_workspace_tool(
                        server_execution.tool_name,
                        server_execution.params,
                        self.session.workspace_tool_cache,
                        self.session.latest_context,
                    )
                elif server_execution.tool_name == "analyze_image_with_ocr":
                    server_content = await _run_ocr_attachment_tool(server_execution.params, self.session.body)
                elif server_execution.tool_name == "web_search":
                    server_content = await _run_web_search_tool(server_execution.params)
                elif server_execution.tool_name == "analyze_document_image":
                    server_content = await _run_document_image_analysis_tool(
                        server_execution.params,
                        self.session.body,
                        self.session.latest_context or self.session.body.context or {},
                    )
                elif is_document_tool(server_execution.tool_name):
                    tool_result = await execute_ai_document_tool(
                        server_execution.tool_name,
                        server_execution.params,
                        self.session.latest_context or self.session.body.context or {},
                    )
                    server_content = _serialize_tool_result_payload(
                        tool_name=server_execution.tool_name,
                        success=tool_result.get("success") is True,
                        message=str(tool_result.get("message") or ""),
                        data=tool_result.get("data"),
                        executed_params=server_execution.params,
                        original_params=server_execution.params,
                    )
                else:
                    server_content = _serialize_tool_result_payload(
                        tool_name=server_execution.tool_name,
                        success=False,
                        message=f"子代理不能执行服务端工具：{server_execution.tool_name}",
                        executed_params=server_execution.params,
                        original_params=server_execution.params,
                    )
                server_safe_content, server_image_message = await _prepare_page_screenshot_tool_result_for_runtime(server_content, self.session.body)
                server_payload = _parse_tool_result_payload(server_safe_content)
                for source_call in server_execution.source_calls:
                    child_messages.append(ToolMessage(
                        content=_decorate_tool_result_content(server_safe_content, server_execution, source_call),
                        tool_call_id=source_call.id,
                    ))
                    yield {
                        "type": "agent_tool_result",
                        "agentId": agent_id,
                        "agentType": agent.agent_type,
                        "toolResult": _build_tool_result_event(server_execution, source_call, server_payload),
                    }
                if server_image_message is not None:
                    child_messages.append(server_image_message)

            for client_execution in client_executions:
                content = _serialize_tool_result_payload(
                    tool_name=client_execution.tool_name,
                    success=False,
                    message=f"工具 {client_execution.tool_name} 未实现服务端执行器，前端工具执行路径已删除。",
                    executed_params=client_execution.params,
                    original_params=client_execution.params,
                )
                for source_call in client_execution.source_calls:
                    child_messages.append(ToolMessage(
                        content=_decorate_tool_result_content(content, client_execution, source_call),
                        tool_call_id=source_call.id,
                    ))

        if not final_text:
            final_text = f"子代理 {agent.agent_type} 已达到最大轮次，未形成完整结论。"
        _record_content_event(self.session, {
            "type": "subagent_result",
            "agentType": agent.agent_type,
            "runMode": "background" if background else "sync",
            "resultChars": len(final_text),
        })
        yield {
            "type": "_subagent_result",
            "agentId": agent_id,
            "agentType": agent.agent_type,
            "content": final_text,
        }

    async def _run_background_agent_lifecycle(
        self,
        record: AgentRunRecord,
        agent: AgentDefinition,
    ) -> None:
        try:
            async for event in self._run_subagent(
                agent_id=record.id,
                agent=agent,
                description=record.description,
                prompt=record.prompt,
                background=True,
            ):
                if event["type"] == "_subagent_result":
                    record.status = "completed"
                    record.result = str(event.get("content") or "")
                else:
                    record.trace.append(event)
                save_agent_run(record)
        except asyncio.CancelledError:
            record.status = "cancelled"
            record.error = "用户取消"
            save_agent_run(record)
        except Exception as exc:
            logger.exception("[openwps.ai] background agent %s failed", record.id)
            record.status = "failed"
            record.error = _stringify_content(exc)
            save_agent_run(record)
        finally:
            unregister_background_task(record.id)

    async def _execute_agent_execution(
        self,
        execution: PlannedToolExecution,
    ) -> AsyncGenerator[dict[str, Any], None]:
        params = dict(execution.params or {})
        description = _stringify_content(params.get("description")).strip() or "子代理任务"
        prompt = _stringify_content(params.get("prompt")).strip()
        subagent_type = _stringify_content(params.get("subagent_type")).strip() or "general-purpose"
        params.pop("model", None)
        run_in_background = bool(params.get("run_in_background"))

        if not prompt:
            result, summary, events = _build_and_append_agent_execution_result(
                self.session,
                execution,
                success=False,
                message="Agent 缺少 prompt 参数",
                executed_params=params,
                original_params=params,
            )
            for event in events:
                yield event
            yield {"type": "_server_execution_result", "result": result, "summary": summary}
            return

        agent_id = new_agent_run_id()
        try:
            agent = get_agent_definition(subagent_type)
            if run_in_background or agent.background:
                conversation_id = self.session.body.conversationId or self.session.session_id
                record = AgentRunRecord(
                    id=agent_id,
                    conversation_id=conversation_id,
                    agent_type=agent.agent_type,
                    description=description,
                    prompt=prompt,
                    run_mode="background",
                )
                save_agent_run(record)
                task = asyncio.create_task(self._run_background_agent_lifecycle(record, agent))
                register_background_task(agent_id, task)
                result, summary, events = _build_and_append_agent_execution_result(
                    self.session,
                    execution,
                    success=True,
                    message=f"后台子代理已启动：{description}",
                    executed_params=params,
                    original_params=params,
                    data={
                        "agentId": agent_id,
                        "agentType": agent.agent_type,
                        "status": "background_launched",
                        "conversationId": conversation_id,
                    },
                )
                yield {
                    "type": "agent_background_launched",
                    "agentId": agent_id,
                    "agentType": agent.agent_type,
                    "description": description,
                    "conversationId": conversation_id,
                }
            else:
                final_content = ""
                async for event in self._run_subagent(
                    agent_id=agent_id,
                    agent=agent,
                    description=description,
                    prompt=prompt,
                    background=False,
                ):
                    if event["type"] == "_subagent_result":
                        final_content = str(event.get("content") or "")
                    else:
                        yield event
                agent_success = bool(final_content.strip())
                result, summary, events = _build_and_append_agent_execution_result(
                    self.session,
                    execution,
                    success=agent_success,
                    message=(
                        f"子代理 {agent.agent_type} 已完成：{description}"
                        if agent_success
                        else "Agent 执行未返回结果"
                    ),
                    executed_params=params,
                    original_params=params,
                    data={
                        "agentId": agent_id,
                        "agentType": agent.agent_type,
                        "result": final_content,
                    },
                )
                yield {
                    "type": "agent_done",
                    "agentId": agent_id,
                    "agentType": agent.agent_type,
                    "description": description,
                    "result": final_content,
                }
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception("[openwps.ai] Agent execution %s failed", execution.execution_id)
            message = f"Agent 执行失败：{_truncate_preview(_stringify_content(exc), 240)}"
            result, summary, events = _build_and_append_agent_execution_result(
                self.session,
                execution,
                success=False,
                message=message,
                executed_params=params,
                original_params=params,
                data={
                    "agentId": agent_id,
                    "agentType": subagent_type,
                    "error": _stringify_content(exc),
                },
            )

        for event in events:
            yield event
        yield {"type": "_server_execution_result", "result": result, "summary": summary}

    async def _execute_server_execution_events(
        self,
        execution: PlannedToolExecution,
    ) -> tuple[dict[str, str], dict[str, Any], list[dict[str, Any]]]:
        if execution.tool_name == "Agent":
            server_result = None
            server_summary = None
            events: list[dict[str, Any]] = []
            async for agent_event in self._execute_agent_execution(execution):
                if agent_event["type"] == "_server_execution_result":
                    server_result = agent_event["result"]
                    server_summary = agent_event["summary"]
                else:
                    events.append(agent_event)
            if server_result is None or server_summary is None:
                server_result, server_summary, fallback_events = _build_and_append_agent_execution_result(
                    self.session,
                    execution,
                    success=False,
                    message="Agent 执行未返回结果",
                    executed_params=execution.params,
                    original_params=execution.params,
                )
                events.extend(fallback_events)
            return server_result, server_summary, events

        return await self._execute_server_execution(execution)

    async def _execute_parallel_server_batch(
        self,
        batch: list[PlannedToolExecution],
    ) -> AsyncGenerator[dict[str, Any], None]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

        async def run_one(execution: PlannedToolExecution) -> None:
            try:
                if execution.tool_name == "Agent":
                    result = None
                    summary = None
                    async for agent_event in self._execute_agent_execution(execution):
                        if agent_event["type"] == "_server_execution_result":
                            result = agent_event["result"]
                            summary = agent_event["summary"]
                        else:
                            await queue.put({"type": "event", "event": agent_event})
                    if result is None or summary is None:
                        result, summary, fallback_events = _build_and_append_agent_execution_result(
                            self.session,
                            execution,
                            success=False,
                            message="Agent 执行未返回结果",
                            executed_params=execution.params,
                            original_params=execution.params,
                        )
                        for event in fallback_events:
                            await queue.put({"type": "event", "event": event})
                else:
                    result, summary, events = await self._execute_server_execution(execution)
                    for event in events:
                        await queue.put({"type": "event", "event": event})
                await queue.put({
                    "type": "done",
                    "executionId": execution.execution_id,
                    "result": result,
                    "summary": summary,
                })
            except Exception as exc:
                await queue.put({
                    "type": "error",
                    "executionId": execution.execution_id,
                    "error": exc,
                })

        tasks = [asyncio.create_task(run_one(execution)) for execution in batch]
        pending = len(tasks)
        results_by_execution: dict[str, dict[str, str]] = {}
        summaries_by_execution: dict[str, dict[str, Any]] = {}
        try:
            while pending > 0:
                item = await queue.get()
                item_type = item.get("type")
                if item_type == "event":
                    yield item["event"]
                    continue
                if item_type == "error":
                    for task in tasks:
                        task.cancel()
                    raise item["error"]
                if item_type == "done":
                    execution_id = str(item.get("executionId") or "")
                    results_by_execution[execution_id] = item["result"]
                    summaries_by_execution[execution_id] = item["summary"]
                    pending -= 1
        finally:
            await asyncio.gather(*tasks, return_exceptions=True)

        yield {
            "type": "_parallel_server_batch_result",
            "results": [results_by_execution[execution.execution_id] for execution in batch],
            "summaries": [summaries_by_execution[execution.execution_id] for execution in batch],
        }

    async def stream(self) -> AsyncGenerator[dict[str, Any], None]:
        _record_trace_event(self.session, "session_created")
        yield {"type": "session_created", "sessionId": self.session.session_id}

        try:
            async for preflight_event in self._run_layout_preflight():
                yield preflight_event

            while self.state.round < MAX_REACT_ROUNDS and not self.session.finished:
                self.state.round += 1
                self.state.retries_this_round = 0
                _record_trace_event(self.session, "round_start", round=self.state.round)
                yield {"type": "round_start", "round": self.state.round}

                async for compact_event in self._prepare_context_before_model():
                    yield compact_event
                if self.session.finished:
                    break
                self.state.consecutive_empty_content = 0

                round_content = ""
                round_reasoning = ""
                round_tool_calls: list[dict[str, Any]] = []
                round_finish_reason = ""
                round_token_usage: dict[str, int] = {}
                reactive_attempt = 0
                while True:
                    try:
                        async for event in self._run_model_round(self.session.messages):
                            if event["type"] == "_round_result":
                                round_content = event["content"]
                                round_reasoning = str(event.get("reasoning_content", "") or "")
                                round_tool_calls = event["tool_calls"]
                                round_finish_reason = str(event.get("finish_reason", "") or "")
                                round_token_usage = event.get("token_usage") if isinstance(event.get("token_usage"), dict) else {}
                            else:
                                yield event
                        break
                    except ContextOverflowError as exc:
                        reactive_attempt += 1
                        if reactive_attempt > MAX_CONTEXT_OVERFLOW_RETRIES:
                            message = "模型仍然报告上下文过长，reactive compact 已达到 3 次上限，已停止自动链路。"
                            _record_trace_event(
                                self.session,
                                "compact_failed",
                                round=self.state.round,
                                source="reactive",
                                message=message,
                            )
                            yield {"type": "compact_failed", "source": "reactive", "message": message}
                            yield {"type": "error", "message": message}
                            self.session.finished = True
                            self.state.transition = Transition.FATAL_ERROR
                            break
                        yield self._make_recovery_event(
                            "context_compact",
                            source="reactive",
                            attempt=reactive_attempt,
                            message="模型报告上下文过长，正在立即压缩并重试当前轮。",
                        )
                        yield {
                            "type": "compact_start",
                            "source": "reactive",
                            "preTokens": count_messages_tokens(self.session.messages, model=self._compact_policy().model),
                            "reactive": True,
                        }
                        try:
                            compact_event = await self._compact_session_messages(source="reactive", reactive=True)
                        except Exception as compact_exc:
                            message = f"上下文过长后的压缩失败: {_normalize_ai_api_error_detail(self.session.body, str(compact_exc))}"
                            _record_trace_event(
                                self.session,
                                "compact_failed",
                                round=self.state.round,
                                source="reactive",
                                message=message,
                                cause=str(exc),
                            )
                            yield {"type": "compact_failed", "source": "reactive", "message": message}
                            yield {"type": "error", "message": message}
                            self.session.finished = True
                            self.state.transition = Transition.FATAL_ERROR
                            break
                        yield compact_event
                        yield {
                            "type": "compression",
                            "source": "reactive",
                            "estimated_tokens": compact_event["postTokens"],
                            "preTokens": compact_event["preTokens"],
                            "postTokens": compact_event["postTokens"],
                            "reactive": True,
                        }
                        continue
                if self.session.finished:
                    break

                if round_token_usage:
                    self.state.last_api_usage = round_token_usage
                    self.state.estimated_tokens = round_token_usage.get("inputTokens", self.state.estimated_tokens)
                    _record_trace_event(
                        self.session,
                        "token_usage",
                        round=self.state.round,
                        source="chat_model",
                        **round_token_usage,
                    )

                self.state.last_model_finish_reason = round_finish_reason
                if round_tool_calls or not _is_output_truncated_finish_reason(round_finish_reason):
                    self.state.output_continuation_attempts = 0

                if not round_tool_calls:
                    self.session.messages.append(_build_ai_message(
                        content=round_content,
                        reasoning_content=round_reasoning,
                    ))
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

                    if self.state.pending_agent_follow_up and round_content.strip():
                        self.state.pending_agent_follow_up = False
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
                        if round_decision.reason == "post_write_follow_up":
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
                            pendingTaskCount=round_decision.pending_task_count,
                        )
                        yield {
                            "type": "round_complete",
                            "reason": round_decision.reason,
                            "message": round_decision.client_message,
                            "pendingTaskCount": round_decision.pending_task_count,
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

                self.session.messages.append(_build_ai_message(
                    content=round_content,
                    tool_calls=[
                        {"id": tool_call["id"], "name": tool_call["name"], "args": tool_call["params"], "type": "tool_call"}
                        for tool_call in round_tool_calls
                    ],
                    reasoning_content=round_reasoning,
                ))

                before_gate_signature = _build_gate_progress_signature(self.state, self.session.messages)
                execution_plan = _build_execution_plan(self.state.round, round_tool_calls)
                server_executions, client_executions = _split_execution_plan(execution_plan)
                server_execution_results: list[dict[str, str]] = []
                server_execution_summary: list[dict[str, Any]] = []
                _record_trace_event(
                    self.session,
                    "tool_plan",
                    round=self.state.round,
                    planId=execution_plan.plan_id,
                    executionCount=len(execution_plan.executions),
                    sourceToolCallCount=len(round_tool_calls),
                )
                for server_batch in _build_parallel_execution_batches(server_executions):
                    async for server_batch_event in self._execute_parallel_server_batch(server_batch):
                        if server_batch_event["type"] == "_parallel_server_batch_result":
                            server_execution_results.extend(server_batch_event["results"])
                            server_execution_summary.extend(server_batch_event["summaries"])
                        else:
                            yield server_batch_event

                execution_results = list(server_execution_results)
                execution_summary = list(server_execution_summary)

                for client_execution in client_executions:
                    content = _serialize_tool_result_payload(
                        tool_name=client_execution.tool_name,
                        success=False,
                        message=f"工具 {client_execution.tool_name} 未实现服务端执行器，前端工具执行路径已删除。",
                        executed_params=client_execution.params,
                        original_params=client_execution.params,
                    )
                    payload = _parse_tool_result_payload(content)
                    execution_results.append({
                        "execution_id": client_execution.execution_id,
                        "content": content,
                    })
                    execution_summary.append({
                        "executionId": client_execution.execution_id,
                        "toolName": client_execution.tool_name,
                        "success": False,
                        "message": _truncate_preview(payload.get("message", ""), 120),
                        "mergeStrategy": client_execution.merge_strategy,
                        "sourceToolCallCount": len(client_execution.source_calls),
                    })
                    for source_call in client_execution.source_calls:
                        self.session.messages.append(ToolMessage(
                            content=_decorate_tool_result_content(content, client_execution, source_call),
                            tool_call_id=source_call.id,
                        ))
                        yield {
                            "type": "tool_result",
                            "id": source_call.id,
                            "name": source_call.name,
                            "result": _build_tool_result_event(client_execution, source_call, payload)["result"],
                        }
                _update_completion_gate_state(self.state, execution_results)
                self.state.pending_write_follow_up = _tool_results_started_streaming_write(execution_results)
                self.state.pending_agent_follow_up = _tool_results_completed_subagent(execution_results)
                _record_tool_round_progress(
                    self.state,
                    self.session.messages,
                    round_tool_calls,
                    before_gate_signature,
                )
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

                if round_decision.action == RoundDecisionAction.ERROR:
                    self.session.finished = True
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
                        "error",
                        round=self.state.round,
                        message=round_decision.error_message,
                    )
                    yield {
                        "type": "error",
                        "message": round_decision.error_message,
                    }
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

                # Delta injection: inject context changes after tool results.
                # Workspace docs are backend-owned runtime state, so refresh the
                # manifest here instead of trusting client-sent context.
                context = _with_backend_workspace_docs(self.session.latest_context, query=self.session.body.message)
                self.session.latest_context = context
                previous_workspace_docs = list(self.state.previous_workspace_docs)
                delta_content = build_delta_content(
                    context,
                    self.session.messages,
                    force_full=False,
                    previous_workspace_docs=previous_workspace_docs,
                )
                delta_messages = list(delta_content.content or [])
                _record_content_event(self.session, delta_content.trace)
                for delta_msg in delta_messages:
                    self.session.messages.append(HumanMessage(content=delta_msg))
                current_workspace_docs = context.get("workspaceDocs")
                if isinstance(current_workspace_docs, list):
                    self.state.previous_workspace_docs = list(current_workspace_docs)

                # Task reminder: inject reminder if task tools haven't been used recently
                self.state.rounds_since_last_task_update += 1
                if self.state.rounds_since_last_task_update >= TODO_REMINDER_INTERVAL:
                    current_tasks = _get_latest_tasks(self.session.messages)
                    reminder_content = build_task_reminder_content(self.state.rounds_since_last_task_update, current_tasks)
                    _record_content_event(self.session, reminder_content.trace)
                    self.session.messages.append(HumanMessage(content=str(reminder_content.content or "")))

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
            error_message = f"AI 请求失败: {_normalize_ai_api_error_detail(self.session.body, str(exc))}"
            _record_trace_event(self.session, "error", round=self.state.round, message=error_message)
            yield {"type": "error", "message": error_message}
        finally:
            self.session.trace.final_state = {
                "transition": self.state.transition.value,
                "round": self.state.round,
                "finished": self.session.finished,
                "remainingRounds": max(MAX_REACT_ROUNDS - self.state.round, 0),
                "roundBudgetWarningLevel": self.state.round_budget_warning_level,
                "lastCompactSource": self.state.last_compact_source,
                "lastCompactPreTokens": self.state.last_compact_pre_tokens,
                "lastCompactPostTokens": self.state.last_compact_post_tokens,
                "compactFailureCount": self.state.compact_failure_count,
                "microcompactCount": self.state.microcompact_count,
                "lastApiUsage": dict(self.state.last_api_usage),
                "stagnantBudgetRounds": self.state.stagnant_budget_rounds,
                "budgetStagnationWarningLevel": self.state.budget_stagnation_warning_level,
                "readOnlyStagnantRounds": self.state.read_only_stagnant_rounds,
                "outputContinuationAttempts": self.state.output_continuation_attempts,
                "visionCapabilityBlocked": self.state.vision_capability_blocked,
                "lastModelFinishReason": self.state.last_model_finish_reason,
                "layoutPreflightRequired": self.state.layout_preflight_required,
                "layoutPreflightCompleted": self.state.layout_preflight_completed,
                "contentLockedForLayout": self.state.content_locked_for_layout,
                "completionGate": _snapshot_completion_gate(self.state, self.session.messages),
            }
            _store_completed_trace(self.session)
            _remove_session(self.session.session_id)


async def stream_react_session(session: ReactSession) -> AsyncGenerator[dict[str, Any], None]:
    async for event in QueryCoordinator(session).stream():
        yield event


async def list_models(endpoint: str, api_key: str = "", provider_id: str | None = None) -> list[dict[str, Any]]:
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
        detail = _sanitize_upstream_error_detail(exc.response.text.strip() or str(exc), status_code=exc.response.status_code)
        raise HTTPException(status_code=502, detail=f"获取模型列表失败: {detail}") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"获取模型列表失败: {exc}") from exc

    raw_models = payload.get("data", []) if isinstance(payload, dict) else []
    provider = get_provider(read_config(), provider_id) if provider_id else {"supportsVision": False}
    models: list[dict[str, Any]] = []
    for item in raw_models:
        if not isinstance(item, dict):
            continue
        model_id = str(item.get("id") or "").strip()
        if not model_id:
            continue
        supports_vision = _raw_model_supports_vision(item) or _selected_model_supports_vision(provider, model_id)
        models.append(
            {
                "id": model_id,
                "label": str(item.get("name") or model_id),
                "supportsVision": supports_vision,
            }
        )

    return sorted(models, key=lambda item: item["id"].lower())
