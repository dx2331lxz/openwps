from __future__ import annotations

import json
import logging
from typing import Any, AsyncGenerator, TypedDict

import httpx
from fastapi import HTTPException
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.runnables import RunnableLambda
from langgraph.graph import END, START, StateGraph
from langchain_openai import ChatOpenAI
from langchain_core.runnables import Runnable

from .config import get_provider, read_config
from .models import ChatMessage, ChatRequest
from .tooling import get_system_prompt, get_tools

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


def _tool_calls_from_ai_message(message: AIMessage) -> list[dict[str, Any]]:
    tool_calls: list[dict[str, Any]] = []
    for call in message.tool_calls:
        tool_calls.append({
            "id": call.get("id"),
            "name": call.get("name", ""),
            "params": call.get("args", {}) or {},
        })
    return tool_calls


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
            arguments = fn.get("arguments", "{}")
            try:
                args = json.loads(arguments) if isinstance(arguments, str) else arguments
            except Exception:
                args = {}
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
            try:
                params = json.loads(item["args_str"]) if item["args_str"] else {}
            except Exception:
                params = {}
            yield {
                "type": "tool_call",
                "id": item["id"],
                "name": item["name"],
                "params": params,
            }


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
