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

RANGE_SPEC = {
    "type": "object",
    "description": "操作范围",
    "properties": {
        "type": {
            "type": "string",
            "enum": [
                "all",
                "paragraph",
                "paragraphs",
                "selection",
                "contains_text",
                "first_paragraph",
                "last_paragraph",
                "odd_paragraphs",
                "even_paragraphs",
            ],
        },
        "paragraphIndex": {"type": "integer", "description": "段落索引（range.type=paragraph 时使用）"},
        "from": {"type": "integer", "description": "起始段落索引（range.type=paragraphs 时使用）"},
        "to": {"type": "integer", "description": "结束段落索引（range.type=paragraphs 时使用，包含）"},
        "text": {"type": "string", "description": "匹配的文字（range.type=contains_text 时使用）"},
    },
}

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_document_content",
            "description": "读取文档完整内容，返回每个段落的文字内容和当前样式",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_paragraph",
            "description": "读取指定段落的内容和样式",
            "parameters": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer", "description": "段落索引（从 0 开始）"},
                },
                "required": ["index"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_text_style",
            "description": "设置指定范围内文字的样式（字体、字号、颜色、粗体、斜体等）",
            "parameters": {
                "type": "object",
                "properties": {
                    "range": RANGE_SPEC,
                    "fontFamily": {"type": "string", "description": "字体名，如 宋体/黑体/楷体/仿宋/Arial/Times New Roman"},
                    "fontSize": {"type": "number", "description": "字号（磅），如 12/16/22"},
                    "color": {"type": "string", "description": "文字颜色 hex，如 #FF0000"},
                    "backgroundColor": {"type": "string", "description": "文字背景色 hex"},
                    "bold": {"type": "boolean"},
                    "italic": {"type": "boolean"},
                    "underline": {"type": "boolean"},
                    "strikethrough": {"type": "boolean"},
                    "superscript": {"type": "boolean"},
                    "subscript": {"type": "boolean"},
                    "letterSpacing": {"type": "number", "description": "字间距（磅）"},
                },
                "required": ["range"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_paragraph_style",
            "description": "设置指定范围段落的格式（对齐、缩进、行距、间距）",
            "parameters": {
                "type": "object",
                "properties": {
                    "range": RANGE_SPEC,
                    "align": {"type": "string", "enum": ["left", "center", "right", "justify"]},
                    "firstLineIndent": {"type": "number", "description": "首行缩进（字符数，如 2）"},
                    "indent": {"type": "number", "description": "整体左缩进（字符数）"},
                    "lineHeight": {"type": "number", "description": "行距倍数，如 1.0/1.5/2.0"},
                    "spaceBefore": {"type": "number", "description": "段前间距（磅）"},
                    "spaceAfter": {"type": "number", "description": "段后间距（磅）"},
                    "listType": {"type": "string", "enum": ["none", "bullet", "ordered"], "description": "列表类型"},
                },
                "required": ["range"],
            },
        },
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
                    "marginRight": {"type": "number", "description": "右边距 mm"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "insert_page_break",
            "description": "在指定段落后插入分页符",
            "parameters": {
                "type": "object",
                "properties": {
                    "afterParagraph": {"type": "integer", "description": "在该段落后插入分页符"},
                },
                "required": ["afterParagraph"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "insert_horizontal_rule",
            "description": "在指定段落后插入水平分割线",
            "parameters": {
                "type": "object",
                "properties": {
                    "afterParagraph": {"type": "integer", "description": "在该段落后插入分割线"},
                },
                "required": ["afterParagraph"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "insert_table",
            "description": "在指定位置插入表格",
            "parameters": {
                "type": "object",
                "properties": {
                    "afterParagraph": {"type": "integer", "description": "在该段落后插入表格"},
                    "rows": {"type": "integer", "minimum": 1, "maximum": 20},
                    "cols": {"type": "integer", "minimum": 1, "maximum": 10},
                    "headerRow": {"type": "boolean"},
                },
                "required": ["afterParagraph", "rows", "cols"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "insert_text",
            "description": "在指定段落末尾插入文字",
            "parameters": {
                "type": "object",
                "properties": {
                    "paragraphIndex": {"type": "integer"},
                    "text": {"type": "string", "description": "要插入的文字内容"},
                },
                "required": ["paragraphIndex", "text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delete_paragraph",
            "description": "删除指定段落",
            "parameters": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer", "description": "段落索引"},
                },
                "required": ["index"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_document_info",
            "description": "获取文档信息（字数、段落数、页数）",
            "parameters": {"type": "object", "properties": {}},
        },
    },
]

SYSTEM_PROMPT = """你是 openwps 的 AI 排版助手，专门帮助用户对文档进行排版操作。

你的职责：
1. 理解用户的排版需求
2. 先读取文档内容，再做精确修改
3. 调用排版工具函数执行操作
4. 用简短中文回复结果

工具使用原则：
1. 先用 get_document_content 读取文档结构，了解段落数量和内容
2. 用 range 精确指定操作哪些段落，不要用 all，除非用户明确要求全部
3. 例如“把第一段标题改成黑体”→ 先 get_document_content 确认第一段是否是标题，再调用 set_text_style(range={"type":"paragraph","paragraphIndex":0}, fontFamily="黑体")
4. 例如“把所有正文缩进2字符”→ 先 get_document_content 找出正文段落索引，再调用 set_paragraph_style(range={"type":"paragraphs","from":1,"to":N}, firstLineIndent=2)
5. 不要一次性修改整个文档，除非用户明确说“全部”
6. 询问“第几段是什么内容”“某段内容是什么”“文档有哪些段落”时，优先使用 get_document_content 或 get_paragraph
7. 插入类工具必须带位置：insert_page_break / insert_table / insert_horizontal_rule 需要 afterParagraph，insert_text 需要 paragraphIndex

回复要求：
- 如果已经完成操作，就简短说明做了什么
- 如果是读取型问题，就直接根据工具返回内容回答
- 不要编造不存在的段落内容
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
    reactMessages: list[dict] = []

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


@app.post("/api/ai/react/stream")
async def react_stream(body: ChatRequest):
    """Stream a single assistant round; the client executes tools and feeds results back."""

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

        messages: list = [{"role": "system", "content": SYSTEM_PROMPT}]
        if body.reactMessages:
            messages.extend(body.reactMessages)
        else:
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

        round_tool_calls: list = []
        async for event in stream_ai_call(messages, headers, endpoint, model, TOOLS):
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            if event["type"] == "error":
                return
            if event["type"] == "tool_call":
                round_tool_calls.append(event)

        if round_tool_calls:
            yield sse("awaiting_tool_results", {"count": len(round_tool_calls)})
        else:
            yield sse("done", {"reason": "completed"})

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
