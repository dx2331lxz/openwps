from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from typing import Any

from .agents import AgentDefinition, build_agent_system_prompt
from .config import DEFAULT_IMAGE_PROCESSING_MODE
from .delta_injection import build_initial_context_attachment, compute_all_deltas
from .prompts import get_static_sections, get_system_prompt
from .tool_registry import build_tool_guidance_section, build_tool_prompt_trace


MAX_TEXT_ATTACHMENT_CHARS = 24000
PROMPT_CACHE_MODE_OPENAI = "openai_auto"
PROMPT_CACHE_RETENTION_IN_MEMORY = "in_memory"


@dataclass(frozen=True)
class ContentBuildResult:
    content: Any
    trace: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class SystemContent:
    prompt: str
    static_prompt_hash: str
    tool_schema_hash: str
    prompt_cache: dict[str, Any]
    trace: dict[str, Any]


def _stringify_content(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, dict):
                if item.get("type") == "text":
                    parts.append(str(item.get("text") or ""))
                elif "text" in item:
                    parts.append(str(item.get("text") or ""))
            else:
                parts.append(str(item))
        return "\n".join(part for part in parts if part)
    return str(value)


def _stable_hash(value: Any, length: int = 16) -> str:
    if isinstance(value, str):
        raw = value
    else:
        raw = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:length]


def _normalize_cache_key_part(value: Any) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9_-]+", "-", str(value or "").strip())
    return normalized.strip("-") or "default"


def build_tool_schema_hash(tools: list[dict[str, Any]] | None) -> str:
    tool_summaries: list[dict[str, Any]] = []
    for tool in tools or []:
        if not isinstance(tool, dict):
            continue
        function = tool.get("function") if isinstance(tool.get("function"), dict) else {}
        tool_summaries.append({
            "name": function.get("name"),
            "description": function.get("description"),
            "parameters": function.get("parameters"),
        })
    return _stable_hash(tool_summaries)


def build_prompt_cache_config(
    provider: dict[str, Any],
    *,
    mode: str | None,
    static_prompt_hash: str,
    tool_schema_hash: str,
) -> dict[str, Any]:
    cache_mode = str(provider.get("promptCacheMode") or "off").strip()
    retention = str(provider.get("promptCacheRetention") or PROMPT_CACHE_RETENTION_IN_MEMORY).strip()
    normalized_retention = retention if retention in {"in_memory", "24h"} else PROMPT_CACHE_RETENTION_IN_MEMORY
    enabled = cache_mode == PROMPT_CACHE_MODE_OPENAI
    provider_id = _normalize_cache_key_part(provider.get("id"))
    mode_part = _normalize_cache_key_part(mode or "agent")
    cache_key = f"openwps:{provider_id}:{mode_part}:{static_prompt_hash}:{tool_schema_hash}"
    cache_key_hash = _stable_hash(cache_key)
    model_kwargs = (
        {
            "prompt_cache_key": cache_key,
            "prompt_cache_retention": normalized_retention,
        }
        if enabled
        else {}
    )
    return {
        "enabled": enabled,
        "mode": cache_mode if cache_mode in {"off", PROMPT_CACHE_MODE_OPENAI} else "off",
        "retention": normalized_retention,
        "key": cache_key if enabled else "",
        "keyHash": cache_key_hash if enabled else "",
        "modelKwargs": model_kwargs,
    }


def build_system_content(
    mode: str | None,
    provider: dict[str, Any] | None = None,
    tools: list[dict[str, Any]] | None = None,
    *,
    deferred_tool_count: int = 0,
    loaded_deferred_tool_count: int = 0,
) -> SystemContent:
    base_prompt = get_system_prompt(mode)
    tool_names = [
        str(tool.get("function", {}).get("name", ""))
        for tool in tools or []
        if isinstance(tool, dict) and isinstance(tool.get("function"), dict)
    ]
    tool_guidance = build_tool_guidance_section(mode, tool_names)
    prompt = "\n\n".join(part for part in [base_prompt, tool_guidance] if part)
    sections = get_static_sections(mode)
    static_prompt_hash = _stable_hash(prompt)
    tool_schema_hash = build_tool_schema_hash(tools)
    prompt_cache = build_prompt_cache_config(
        provider or {},
        mode=mode,
        static_prompt_hash=static_prompt_hash,
        tool_schema_hash=tool_schema_hash,
    )
    trace = {
        "type": "system_prompt",
        "mode": mode or "agent",
        "sectionCount": len(sections),
        "promptChars": len(prompt),
        "staticPromptHash": static_prompt_hash,
        "toolSchemaHash": tool_schema_hash,
        "toolPrompt": build_tool_prompt_trace(
            mode,
            tool_names,
            tool_guidance,
            deferred_tool_count=deferred_tool_count,
            loaded_deferred_tool_count=loaded_deferred_tool_count,
        ),
        "promptCacheMode": prompt_cache["mode"],
        "promptCacheEnabled": prompt_cache["enabled"],
        "promptCacheRetention": prompt_cache["retention"],
        "promptCacheKeyHash": prompt_cache["keyHash"],
    }
    return SystemContent(
        prompt=prompt,
        static_prompt_hash=static_prompt_hash,
        tool_schema_hash=tool_schema_hash,
        prompt_cache=prompt_cache,
        trace=trace,
    )


def build_initial_context_content(context: dict[str, Any]) -> ContentBuildResult:
    content = build_initial_context_attachment(context or {})
    return ContentBuildResult(
        content=content,
        trace={
            "type": "initial_context",
            "hasContent": bool(content),
            "contentChars": len(content),
            "contextKeys": sorted(str(key) for key in (context or {}).keys()),
        },
    )


def build_delta_content(
    context: dict[str, Any],
    messages: list[Any],
    *,
    force_full: bool = False,
) -> ContentBuildResult:
    deltas = compute_all_deltas(context or {}, messages, force_full=force_full)
    return ContentBuildResult(
        content=deltas,
        trace={
            "type": "context_delta",
            "deltaCount": len(deltas),
            "forceFull": force_full,
            "contentChars": sum(len(delta) for delta in deltas),
            "contextKeys": sorted(str(key) for key in (context or {}).keys()),
        },
    )


def format_text_attachments_for_model(attachments: list[dict[str, Any]] | None) -> ContentBuildResult:
    if not attachments:
        return ContentBuildResult(content="", trace={
            "attachmentCount": 0,
            "textAttachmentCount": 0,
            "includedChars": 0,
            "clippedChars": 0,
        })

    parts = ["[文件附件]"]
    total_chars = 0
    clipped_chars = 0
    text_attachment_count = 0
    for index, attachment in enumerate(attachments, start=1):
        if not isinstance(attachment, dict):
            continue
        text_content = _stringify_content(attachment.get("textContent")).strip()
        if not text_content:
            continue
        text_attachment_count += 1
        name = str(attachment.get("name") or f"attachment-{index}").strip() or f"attachment-{index}"
        text_format = str(attachment.get("textFormat") or "text").strip() or "text"
        remaining = MAX_TEXT_ATTACHMENT_CHARS - total_chars
        if remaining <= 0:
            clipped_chars += len(text_content)
            parts.append("其余附件内容因长度限制已省略。")
            break
        clipped = text_content[:remaining]
        total_chars += len(clipped)
        clipped_chars += max(len(text_content) - len(clipped), 0)
        suffix = "\n[后续内容已截断]" if len(clipped) < len(text_content) else ""
        parts.append(f"附件 {index}: {name} ({text_format})\n{clipped}{suffix}")

    content = "\n\n".join(parts) if len(parts) > 1 else ""
    return ContentBuildResult(content=content, trace={
        "attachmentCount": len(attachments),
        "textAttachmentCount": text_attachment_count,
        "includedChars": total_chars,
        "clippedChars": clipped_chars,
    })


def _already_has_context_block(content: str) -> bool:
    return "[当前文档上下文]" in content and "[用户请求]" in content


def _normalize_user_text(message: str, context_block: str) -> str:
    user_text = message
    if context_block and not _already_has_context_block(user_text):
        user_text = context_block + "\n\n" + user_text
    return user_text


def build_user_content(
    message: str,
    context_block: str = "",
    images: list[dict[str, Any]] | None = None,
    attachments: list[dict[str, Any]] | None = None,
    ocr_results: list[dict[str, Any]] | None = None,
    image_processing_mode: str = DEFAULT_IMAGE_PROCESSING_MODE,
    *,
    source: str = "current_user",
) -> ContentBuildResult:
    del ocr_results
    user_text = _normalize_user_text(message, context_block)
    attachment_result = format_text_attachments_for_model(attachments)
    attachment_block = str(attachment_result.content or "")
    if attachment_block:
        user_text = f"{user_text}\n\n{attachment_block}" if user_text else attachment_block
    image_count = len(images or [])
    if not images:
        return ContentBuildResult(
            content=user_text,
            trace={
                "type": "user_content",
                "source": source,
                "textChars": len(user_text),
                "imageCount": 0,
                **attachment_result.trace,
            },
        )

    content: list[dict[str, Any]] = [{"type": "text", "text": user_text}]
    for image in images:
        url = image.get("dataUrl") if isinstance(image, dict) else None
        if not isinstance(url, str) or not url:
            continue
        content.append({"type": "image_url", "image_url": {"url": url}})
    return ContentBuildResult(
        content=content,
        trace={
            "type": "user_content",
            "source": source,
            "textChars": len(user_text),
            "imageCount": image_count,
            **attachment_result.trace,
        },
    )


def build_task_reminder_content(rounds_since_last_task_update: int, current_tasks: list[dict[str, str]]) -> ContentBuildResult:
    task_summary = ""
    if current_tasks:
        lines = []
        for task in current_tasks:
            status_icon = {"completed": "✅", "in_progress": "🔄", "pending": "⬜"}.get(task.get("status", "pending"), "⬜")
            lines.append(f"{status_icon} {task.get('subject', '?')}")
        task_summary = "\n当前任务列表：\n" + "\n".join(lines)
    content = (
        f"<system-reminder>\n"
        f"TaskCreate / TaskUpdate 已经 {rounds_since_last_task_update} 轮未使用。"
        f"如果你正在处理多步骤任务，可自行决定是否使用 TaskCreate 建立内部任务，并用 TaskUpdate 跟踪进度。"
        f"不要因为用户提到任务列表而使用它；用户提示中的任务列表默认指文档正文任务列表。\n"
        f"开始执行前把当前任务标记为 in_progress，完成后立即标记为 completed。"
        f"每完成一个任务后优先调用 TaskList 查看剩余任务。{task_summary}\n"
        f"</system-reminder>"
    )
    return ContentBuildResult(
        content=content,
        trace={
            "type": "task_reminder",
            "roundsSinceLastTaskUpdate": rounds_since_last_task_update,
            "taskCount": len(current_tasks),
            "contentChars": len(content),
        },
    )


def build_subagent_content(
    *,
    agent: AgentDefinition,
    tool_names: list[str],
    description: str,
    prompt: str,
    context: dict[str, Any],
    background: bool = False,
) -> ContentBuildResult:
    system_prompt = build_agent_system_prompt(agent, tool_names, background=background)
    tool_guidance = build_tool_guidance_section(
        "agent",
        tool_names,
        agent_type=agent.agent_type,
        background=background,
    )
    context_attachment = build_initial_context_attachment(context or {})
    user_parts = [
        f"[父代理委托]\n{prompt.strip()}",
        f"[任务标题]\n{description.strip()}",
    ]
    if context_attachment:
        user_parts.append(context_attachment)
    if background:
        user_parts.append("[运行模式]\n后台快照模式：只能基于以上上下文和服务端工具完成分析。")
    user_prompt = "\n\n".join(user_parts)
    return ContentBuildResult(
        content={
            "systemPrompt": system_prompt,
            "userPrompt": user_prompt,
        },
        trace={
            "type": "subagent_content",
            "agentType": agent.agent_type,
            "runMode": "background" if background else "sync",
            "toolCount": len(tool_names),
            "systemPromptHash": _stable_hash(system_prompt),
            "systemPromptChars": len(system_prompt),
            "toolPrompt": build_tool_prompt_trace(
                "agent",
                tool_names,
                tool_guidance,
                agent_type=agent.agent_type,
                background=background,
            ),
            "delegationChars": len(prompt.strip()),
            "descriptionChars": len(description.strip()),
            "contextAttachmentChars": len(context_attachment),
            "userPromptChars": len(user_prompt),
        },
    )
