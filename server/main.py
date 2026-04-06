#!/usr/bin/env python3
"""
openwps 后端服务 - Python FastAPI
端口：5174
"""
import json
import os
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
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

class SettingsUpdate(BaseModel):
    endpoint: Optional[str] = None
    apiKey: Optional[str] = None
    model: Optional[str] = None

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

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=5174, log_level="info")
