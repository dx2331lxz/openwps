#!/usr/bin/env python3
"""
openwps 后端服务 - Python FastAPI
端口：5174
"""
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, AsyncGenerator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import FileResponse
from pydantic import BaseModel
import httpx
import uvicorn

app = FastAPI(title="openwps backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

CONFIG_PATH = Path(__file__).parent / "config" / "ai.json"
CONFIG_PATH.parent.mkdir(exist_ok=True)

CONVERSATIONS_DIR = Path(__file__).parent / "data" / "conversations"
CONVERSATIONS_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_CONFIG = {
    "endpoint": "https://api.siliconflow.cn/v1",
    "apiKey": "",
    "model": "Qwen/Qwen2.5-72B-Instruct",
    "provider": "openai"
}

# ── 排版工具 schema（传给 AI）──────────────────────────────────

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "set_text_style",
            "description": "设置文字样式（字体/字号/颜色/加粗/斜体/下划线/删除线）",
            "parameters": {
                "type": "object",
                "properties": {
                    "fontFamily": {"type": "string", "description": "字体名，如 宋体/黑体/楷体/仿宋/Arial"},
                    "fontSize": {"type": "number", "description": "字号（pt），如 12/16/18/22"},
                    "color": {"type": "string", "description": "颜色，如 #000000"},
                    "bold": {"type": "boolean"},
                    "italic": {"type": "boolean"},
                    "underline": {"type": "boolean"},
                    "strikethrough": {"type": "boolean"},
                    "target": {"type": "string", "enum": ["selection", "all", "body"], "description": "应用范围"}
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "set_paragraph_style",
            "description": "设置段落格式（对齐/首行缩进/行距/段间距）",
            "parameters": {
                "type": "object",
                "properties": {
                    "align": {"type": "string", "enum": ["left", "center", "right", "justify"]},
                    "firstLineIndent": {"type": "number", "description": "首行缩进 em，如 2"},
                    "lineHeight": {"type": "number", "description": "行距倍数，如 1.5"},
                    "spaceBefore": {"type": "number", "description": "段前间距 pt"},
                    "spaceAfter": {"type": "number", "description": "段后间距 pt"},
                    "target": {"type": "string", "enum": ["selection", "all", "body"]}
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "apply_preset_style",
            "description": "应用预设样式到整个文档",
            "parameters": {
                "type": "object",
                "properties": {
                    "preset": {"type": "string", "enum": ["公文", "论文", "合同", "报告", "信函"]}
                },
                "required": ["preset"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "set_page_config",
            "description": "设置页面配置（纸张大小/页边距/方向）",
            "parameters": {
                "type": "object",
                "properties": {
                    "paperSize": {"type": "string", "enum": ["A4", "A3", "Letter", "B5"]},
                    "orientation": {"type": "string", "enum": ["portrait", "landscape"]},
                    "marginTop": {"type": "number", "description": "上边距 mm"},
                    "marginBottom": {"type": "number", "description": "下边距 mm"},
                    "marginLeft": {"type": "number", "description": "左边距 mm"},
                    "marginRight": {"type": "number", "description": "右边距 mm"}
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "insert_table",
            "description": "插入表格",
            "parameters": {
                "type": "object",
                "properties": {
                    "rows": {"type": "integer", "minimum": 1, "maximum": 20},
                    "cols": {"type": "integer", "minimum": 1, "maximum": 10},
                    "headerRow": {"type": "boolean"}
                },
                "required": ["rows", "cols"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "insert_page_break",
            "description": "插入分页符",
            "parameters": {"type": "object", "properties": {}}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "set_list",
            "description": "设置列表格式",
            "parameters": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": ["none", "bullet", "ordered"]}
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_document_info",
            "description": "获取文档信息（字数、段落数、页数）",
            "parameters": {"type": "object", "properties": {}}
        }
    }
]

SYSTEM_PROMPT = """你是 openwps 的 AI 排版助手，专门帮助用户对文档进行排版操作。

你的职责：
1. 理解用户的排版需求（如"排成公文格式"、"正文仿宋16号"等）
2. 调用排版工具函数执行操作
3. 用简短的中文回复告诉用户做了什么

排版知识：
- 公文格式：仿宋16号，首行缩进2字符，行距1.5，标题黑体22号居中
- 论文格式：宋体12号，首行缩进2字符，行距1.5
- 合同格式：宋体12号，首行缩进2字符，行距1.5
- 标准行距：1.5倍
- 标准首行缩进：2字符（2em）

注意：
- 每次对话调用必要的工具完成用户请求
- 回复要简洁，说明做了什么操作
- 如果用户说"居中"，调用 set_paragraph_style with align=center
- 如果用户说"仿宋16号"，调用 set_text_style with fontFamily=仿宋 and fontSize=16
"""

# ── 配置管理 ──────────────────────────────────────────────────

def read_config() -> dict:
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text())
        except Exception:
            pass
    return DEFAULT_CONFIG.copy()

def write_config(cfg: dict):
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2))

# ── Models ────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = []
    context: dict = {}
    conversationId: Optional[str] = None

class SettingsUpdate(BaseModel):
    endpoint: Optional[str] = None
    apiKey: Optional[str] = None
    model: Optional[str] = None

class AppendMessagesRequest(BaseModel):
    messages: list[ChatMessage]

# ── Conversation helpers ───────────────────────────────────────

def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")

def conv_path(conv_id: str) -> Path:
    return CONVERSATIONS_DIR / f"{conv_id}.json"

def read_conversation(conv_id: str) -> dict:
    p = conv_path(conv_id)
    if not p.exists():
        raise HTTPException(status_code=404, detail="会话不存在")
    return json.loads(p.read_text(encoding="utf-8"))

def write_conversation(conv: dict) -> None:
    conv["updatedAt"] = now_iso()
    conv_path(conv["id"]).write_text(
        json.dumps(conv, ensure_ascii=False, indent=2), encoding="utf-8"
    )

def list_conversations() -> list[dict]:
    convs = []
    for p in CONVERSATIONS_DIR.glob("*.json"):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            convs.append({
                "id": data["id"],
                "title": data.get("title", ""),
                "createdAt": data.get("createdAt", ""),
                "updatedAt": data.get("updatedAt", ""),
            })
        except Exception:
            pass
    convs.sort(key=lambda c: c.get("updatedAt", ""), reverse=True)
    return convs

# ── Routes ────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    return {"status": "ok", "service": "openwps-backend"}

@app.get("/api/ai/settings")
def get_settings():
    cfg = read_config()
    return {
        "endpoint": cfg.get("endpoint", ""),
        "model": cfg.get("model", ""),
        "hasApiKey": bool(cfg.get("apiKey", "")),
    }

@app.put("/api/ai/settings")
def update_settings(body: SettingsUpdate):
    cfg = read_config()
    if body.endpoint is not None:
        cfg["endpoint"] = body.endpoint
    if body.apiKey is not None:
        cfg["apiKey"] = body.apiKey
    if body.model is not None:
        cfg["model"] = body.model
    write_config(cfg)
    return {"success": True}

# ── Conversation routes ────────────────────────────────────────

@app.get("/api/conversations")
def get_conversations():
    return list_conversations()

@app.post("/api/conversations")
def create_conversation(body: dict = {}):
    conv_id = str(uuid.uuid4())
    title = str(body.get("title", "新会话"))[:30]
    ts = now_iso()
    conv = {"id": conv_id, "title": title, "createdAt": ts, "updatedAt": ts, "messages": []}
    write_conversation(conv)
    return {"id": conv_id}

@app.get("/api/conversations/{conv_id}")
def get_conversation(conv_id: str):
    return read_conversation(conv_id)

@app.post("/api/conversations/{conv_id}/messages")
def append_messages(conv_id: str, body: AppendMessagesRequest):
    conv = read_conversation(conv_id)
    for msg in body.messages:
        conv["messages"].append({"role": msg.role, "content": msg.content})
    write_conversation(conv)
    return {"success": True}

@app.delete("/api/conversations/{conv_id}")
def delete_conversation(conv_id: str):
    p = conv_path(conv_id)
    if not p.exists():
        raise HTTPException(status_code=404, detail="会话不存在")
    p.unlink()
    return {"success": True}

@app.post("/api/ai/chat")
async def chat(body: ChatRequest):
    cfg = read_config()
    api_key = cfg.get("apiKey", "")
    endpoint = cfg.get("endpoint", "https://api.siliconflow.cn/v1")
    model = cfg.get("model", "Qwen/Qwen2.5-72B-Instruct")

    if not api_key:
        raise HTTPException(status_code=400, detail="API Key 未配置，请在设置中填写")

    # 构建消息列表
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    # 加入历史记录
    for msg in body.history[-10:]:  # 只保留最近10条
        messages.append({"role": msg.role, "content": msg.content})

    # 加入当前消息（带文档上下文）
    user_content = body.message
    if body.context:
        ctx = body.context
        ctx_info = f"（当前文档：{ctx.get('paragraphCount', 0)} 段，约 {ctx.get('wordCount', 0)} 字）"
        user_content = f"{body.message} {ctx_info}"
    messages.append({"role": "user", "content": user_content})

    # 调用 AI API
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": model,
        "messages": messages,
        "tools": TOOLS,
        "tool_choice": "auto",
        "max_tokens": 1024,
        "temperature": 0.3,
    }

    async with httpx.AsyncClient(timeout=30) as client:
        try:
            resp = await client.post(
                f"{endpoint.rstrip('/')}/chat/completions",
                headers=headers,
                json=payload
            )
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=502, detail=f"AI API 错误: {e.response.text[:200]}")
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"AI API 请求失败: {str(e)}")

    data = resp.json()
    choice = data["choices"][0]
    msg = choice["message"]

    # 解析工具调用
    tool_calls = []
    reply_text = msg.get("content") or ""

    if msg.get("tool_calls"):
        for tc in msg["tool_calls"]:
            fn = tc["function"]
            try:
                params = json.loads(fn["arguments"])
            except Exception:
                params = {}
            tool_calls.append({
                "name": fn["name"],
                "params": params
            })
        if not reply_text:
            # 生成友好的回复文本
            names = [tc["name"] for tc in tool_calls]
            reply_text = f"好的，我来帮你执行：{', '.join(names)}"

    return {
        "reply": reply_text,
        "toolCalls": tool_calls,
        "model": model,
    }


# ── SSE helper ────────────────────────────────────────────────

def sse(event_type: str, data: dict) -> str:
    payload = {"type": event_type, **data}
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def stream_ai_call(
    messages: list,
    headers: dict,
    endpoint: str,
    model: str,
    tools: list,
) -> AsyncGenerator[dict, None]:
    """Stream one AI API call, accumulating tool call deltas, yielding events."""
    payload = {
        "model": model,
        "messages": messages,
        "tools": tools,
        "tool_choice": "auto",
        "max_tokens": 2048,
        "temperature": 0.3,
        "stream": True,
    }

    # index → {id, name, args_str}
    tc_acc: dict[int, dict] = {}

    async with httpx.AsyncClient(timeout=90) as client:
        async with client.stream(
            "POST",
            f"{endpoint}/chat/completions",
            headers=headers,
            json=payload,
        ) as resp:
            if resp.status_code != 200:
                body = await resp.aread()
                yield {"type": "error", "message": f"API {resp.status_code}: {body.decode()[:300]}"}
                return

            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data_str = line[6:]
                if data_str.strip() == "[DONE]":
                    break
                try:
                    chunk = json.loads(data_str)
                except Exception:
                    continue

                choices = chunk.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}

                # thinking / reasoning_content (DeepSeek, Qwen3, etc.)
                rc = delta.get("reasoning_content") or delta.get("thinking")
                if rc:
                    yield {"type": "thinking", "content": rc}

                # normal content
                c = delta.get("content")
                if c:
                    yield {"type": "content", "content": c}

                # tool call deltas (accumulate by index)
                for tc_delta in delta.get("tool_calls") or []:
                    idx = tc_delta.get("index", 0)
                    if idx not in tc_acc:
                        tc_acc[idx] = {"id": "", "name": "", "args_str": ""}
                    if tc_delta.get("id"):
                        tc_acc[idx]["id"] = tc_delta["id"]
                    fn = tc_delta.get("function") or {}
                    if fn.get("name"):
                        tc_acc[idx]["name"] = fn["name"]
                    if fn.get("arguments"):
                        tc_acc[idx]["args_str"] += fn["arguments"]

    # Emit completed tool calls after stream ends
    for idx in sorted(tc_acc.keys()):
        tc = tc_acc[idx]
        try:
            params = json.loads(tc["args_str"]) if tc["args_str"] else {}
        except Exception:
            params = {}
        yield {
            "type": "tool_call",
            "id": tc["id"],
            "name": tc["name"],
            "params": params,
        }


# ── ReAct streaming endpoint ──────────────────────────────────

MAX_REACT_ROUNDS = 50


@app.post("/api/ai/react/stream")
async def react_stream(body: ChatRequest):
    """ReAct: multi-round tool-calling loop streamed via SSE."""

    async def generate():
        cfg = read_config()
        api_key = cfg.get("apiKey", "")
        endpoint = cfg.get("endpoint", "").rstrip("/")
        model = cfg.get("model", "")

        if not api_key:
            yield sse("error", {"message": "API Key 未配置，请在 ⚙️ 设置 中填写"})
            return

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        # Build initial messages
        messages: list = [{"role": "system", "content": SYSTEM_PROMPT}]
        for msg in body.history[-10:]:
            messages.append({"role": msg.role, "content": msg.content})

        user_content = body.message
        if body.context:
            ctx = body.context
            user_content += (
                f" （文档：{ctx.get('paragraphCount', 0)} 段，"
                f"{ctx.get('wordCount', 0)} 字）"
            )
        messages.append({"role": "user", "content": user_content})

        # Persist user message to conversation if provided
        if body.conversationId:
            try:
                p = conv_path(body.conversationId)
                if p.exists():
                    conv = json.loads(p.read_text(encoding="utf-8"))
                    conv["messages"].append({"role": "user", "content": body.message})
                    write_conversation(conv)
            except Exception:
                pass

        final_assistant_content = ""

        for round_num in range(1, MAX_REACT_ROUNDS + 1):
            yield sse("round", {"round": round_num, "maxRounds": MAX_REACT_ROUNDS})

            round_tool_calls: list = []
            assistant_content = ""
            assistant_thinking = ""

            async for event in stream_ai_call(messages, headers, endpoint, model, TOOLS):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                if event["type"] == "error":
                    return
                elif event["type"] == "content":
                    assistant_content += event["content"]
                    final_assistant_content += event["content"]
                elif event["type"] == "thinking":
                    assistant_thinking += event["content"]
                elif event["type"] == "tool_call":
                    round_tool_calls.append(event)

            if not round_tool_calls:
                # No more tool calls → task done
                if body.conversationId and final_assistant_content:
                    try:
                        p = conv_path(body.conversationId)
                        if p.exists():
                            conv = json.loads(p.read_text(encoding="utf-8"))
                            conv["messages"].append({"role": "assistant", "content": final_assistant_content})
                            write_conversation(conv)
                    except Exception:
                        pass
                yield sse("done", {"reason": "completed", "rounds": round_num})
                return

            # Add assistant turn + tool results to history
            messages.append({
                "role": "assistant",
                "content": assistant_content or None,
                "tool_calls": [
                    {
                        "id": tc["id"] or tc["name"],
                        "type": "function",
                        "function": {
                            "name": tc["name"],
                            "arguments": json.dumps(tc["params"], ensure_ascii=False),
                        },
                    }
                    for tc in round_tool_calls
                ],
            })
            for tc in round_tool_calls:
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"] or tc["name"],
                    "content": f"✅ {tc['name']} 执行成功",
                })

            if round_num >= MAX_REACT_ROUNDS:
                yield sse(
                    "ask_continue",
                    {
                        "message": f"已执行 {round_num} 轮操作，是否继续？",
                        "rounds": round_num,
                    },
                )
                return

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ── 静态文件托管（生产模式：前后端合并单端口）────────────────────────────────

DIST_DIR = Path(__file__).parent.parent / "dist"

if DIST_DIR.exists():
    # 挂载静态资源（/assets /icons.svg 等）
    app.mount("/assets", StaticFiles(directory=DIST_DIR / "assets"), name="assets")

    @app.get("/favicon.svg")
    async def favicon():
        return FileResponse(DIST_DIR / "favicon.svg")

    @app.get("/icons.svg")
    async def icons():
        return FileResponse(DIST_DIR / "icons.svg")

    # SPA fallback：所有非 API 请求返回 index.html
    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str):
        index = DIST_DIR / "index.html"
        if index.exists():
            return FileResponse(index)
        return {"error": "dist 目录不存在，请先执行 npm run build"}
else:
    @app.get("/")
    async def no_dist():
        return {"message": "dist 目录不存在，请执行 npm run build"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=5174, log_level="info")
