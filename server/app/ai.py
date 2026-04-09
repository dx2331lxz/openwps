from __future__ import annotations

import json
import logging
from typing import Any, AsyncGenerator, TypedDict

from fastapi import HTTPException
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.runnables import RunnableLambda
from langgraph.graph import END, START, StateGraph
from langchain_openai import ChatOpenAI

from .config import read_config
from .models import ChatMessage, ChatRequest
from .tooling import SYSTEM_PROMPT, TOOLS

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
        "[openwps.ai] final user prompt conversationId=%s\n%s",
        body.conversationId or "-",
        _stringify_content(last_user.content),
    )


def build_messages(body: ChatRequest) -> list[BaseMessage]:
    messages: list[BaseMessage] = [SystemMessage(content=SYSTEM_PROMPT)]
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
                if context_block and not _already_has_context_block(original):
                    messages.append(HumanMessage(content=context_block + "\n\n" + original))
                else:
                    messages.append(HumanMessage(content=original))
            else:
                messages.append(_to_langchain_message(item))
        _log_final_user_message(body, messages)
        return messages

    for item in body.history[-10:]:
        messages.append(_to_langchain_message(item))

    user_text = body.message
    if context_block and not _already_has_context_block(user_text):
        user_text = context_block + "\n\n" + user_text
    messages.append(HumanMessage(content=user_text))
    _log_final_user_message(body, messages)
    return messages


def build_llm(streaming: bool) -> ChatOpenAI:
    cfg = read_config()
    api_key = cfg.get("apiKey", "")
    if not api_key:
        raise HTTPException(status_code=400, detail="API Key 未配置，请在设置中填写")

    endpoint = str(cfg.get("endpoint", "https://api.siliconflow.cn/v1")).rstrip("/")
    model = str(cfg.get("model", "Qwen/Qwen2.5-72B-Instruct"))

    return ChatOpenAI(
        model=model,
        api_key=api_key,
        base_url=endpoint,
        temperature=0.3,
        max_tokens=2048 if streaming else 1024,
        streaming=streaming,
    ).bind_tools(TOOLS)


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
        llm = build_llm(streaming=False)
        graph = build_graph(llm)
        result = await graph.ainvoke({"messages": build_messages(body)})
        response: AIMessage = result["response"]
        reply = _stringify_content(response.content)
        tool_calls = _tool_calls_from_ai_message(response)

        if tool_calls and not reply:
            reply = f"好的，我来帮你执行：{', '.join(call['name'] for call in tool_calls)}"

        cfg = read_config()
        return {
            "reply": reply,
            "toolCalls": tool_calls,
            "model": cfg.get("model", ""),
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"AI API 请求失败: {exc}") from exc


async def stream_react_round(body: ChatRequest) -> AsyncGenerator[dict[str, Any], None]:
    llm = build_llm(streaming=True)
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
