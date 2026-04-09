from __future__ import annotations

import json

from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import FileResponse

from .ai import run_chat, stream_react_round
from .config import DIST_DIR, read_config, write_config
from .conversations import (
    append_messages,
    create_conversation,
    delete_conversation,
    list_conversations,
    read_conversation,
)
from .models import AppendMessagesRequest, ChatRequest, SettingsUpdate


def sse(event_type: str, data: dict) -> str:
    payload = {"type": event_type, **data}
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def create_api_router() -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/health")
    def health():
        return {"status": "ok", "service": "openwps-backend"}

    @router.get("/ai/settings")
    def get_settings():
        cfg = read_config()
        return {
            "endpoint": cfg.get("endpoint", ""),
            "model": cfg.get("model", ""),
            "hasApiKey": bool(cfg.get("apiKey", "")),
        }

    @router.put("/ai/settings")
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

    @router.get("/conversations")
    def get_conversations():
        return list_conversations()

    @router.post("/conversations")
    def post_conversation(body: dict | None = None):
        title = str((body or {}).get("title", "新会话"))
        conv = create_conversation(title)
        return {"id": conv["id"]}

    @router.get("/conversations/{conv_id}")
    def get_conversation(conv_id: str):
        return read_conversation(conv_id)

    @router.post("/conversations/{conv_id}/messages")
    def post_messages(conv_id: str, body: AppendMessagesRequest):
        append_messages(
            conv_id,
            [message.model_dump(exclude_none=True) for message in body.messages],
        )
        return {"success": True}

    @router.delete("/conversations/{conv_id}")
    def remove_conversation(conv_id: str):
        delete_conversation(conv_id)
        return {"success": True}

    @router.post("/ai/chat")
    async def chat(body: ChatRequest):
        return await run_chat(body)

    @router.post("/ai/react/stream")
    async def react_stream(body: ChatRequest):
        async def generate():
            try:
                tool_call_count = 0
                async for event in stream_react_round(body):
                    if event["type"] == "tool_call":
                        tool_call_count += 1
                    yield sse(str(event["type"]), event)

                if tool_call_count > 0:
                    yield sse("awaiting_tool_results", {"count": tool_call_count})
                else:
                    yield sse("done", {"reason": "completed"})
            except HTTPException as exc:
                yield sse("error", {"message": exc.detail})
            except Exception as exc:
                yield sse("error", {"message": str(exc)})

        return StreamingResponse(
            generate(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )

    return router


def create_app() -> FastAPI:
    app = FastAPI(title="openwps backend")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(create_api_router())

    if DIST_DIR.exists():
        app.mount("/assets", StaticFiles(directory=DIST_DIR / "assets"), name="assets")

        @app.get("/favicon.svg")
        async def favicon():
            return FileResponse(DIST_DIR / "favicon.svg")

        @app.get("/icons.svg")
        async def icons():
            return FileResponse(DIST_DIR / "icons.svg")

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

    return app
