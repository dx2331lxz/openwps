from __future__ import annotations

import json

from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import FileResponse

from .ai import list_models, run_chat, stream_react_round
from .config import DIST_DIR, get_provider, public_config, read_config, write_config
from .conversations import (
    append_messages,
    create_conversation,
    delete_conversation,
    list_conversations,
    read_conversation,
)
from .documents import delete_document, list_documents, read_document_path, save_document
from .models import AppendMessagesRequest, ChatRequest, ModelDiscoveryRequest, SettingsUpdate


def sse(event_type: str, data: dict) -> str:
    payload = {"type": event_type, **data}
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def apply_no_store_headers(response):
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    for header_name in ("ETag", "Last-Modified"):
        if header_name in response.headers:
            del response.headers[header_name]
    return response


class AppStaticFiles(StaticFiles):
    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        path = ""
        if len(args) >= 3 and isinstance(args[2], dict):
            path = str(args[2].get("path", "") or "")

        if path.endswith(".js") or path.endswith(".css"):
            return apply_no_store_headers(response)
        else:
            response.headers["Cache-Control"] = "public, max-age=86400"

        return response


def create_api_router() -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/health")
    def health():
        return {"status": "ok", "service": "openwps-backend"}

    @router.get("/ai/settings")
    def get_settings():
        return public_config()

    @router.put("/ai/settings")
    def update_settings(body: SettingsUpdate):
        current = read_config()
        existing_by_id = {
            str(provider.get("id")): provider
            for provider in current.get("providers", [])
            if isinstance(provider, dict)
        }
        cfg = {
            "version": 2,
            "activeProviderId": body.activeProviderId,
            "providers": [],
        }
        for provider in body.providers:
            item = provider.model_dump(exclude_none=True)
            if "apiKey" not in item and item.get("id") in existing_by_id:
                item["apiKey"] = existing_by_id[item["id"]].get("apiKey", "")
            cfg["providers"].append(item)
        write_config(cfg)
        return public_config(cfg)

    @router.get("/ai/models")
    async def get_models(providerId: str | None = None):
        cfg = read_config()
        provider = get_provider(cfg, providerId)
        models = await list_models(provider.get("endpoint", ""), str(provider.get("apiKey", "") or ""))
        return {
            "providerId": provider["id"],
            "models": models,
            "defaultModel": provider.get("defaultModel", ""),
        }

    @router.post("/ai/models/discover")
    async def discover_models(body: ModelDiscoveryRequest):
        if body.providerId:
            provider = get_provider(read_config(), body.providerId)
            endpoint = body.endpoint or provider.get("endpoint", "")
            api_key = body.apiKey if body.apiKey is not None else str(provider.get("apiKey", "") or "")
        else:
            endpoint = body.endpoint or ""
            api_key = body.apiKey or ""

        models = await list_models(endpoint, api_key)
        return {"models": models}

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

    @router.get("/documents")
    def get_documents():
        return list_documents()

    @router.put("/documents/{name:path}")
    async def put_document(name: str, request: Request):
        content = await request.body()
        return save_document(name, content)

    @router.get("/documents/{name:path}")
    def get_document(name: str):
        path = read_document_path(name)
        return FileResponse(
            path,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            filename=path.name,
        )

    @router.delete("/documents/{name:path}")
    def remove_document(name: str):
        delete_document(name)
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

    @app.middleware("http")
    async def prevent_stale_frontend_assets(request: Request, call_next):
        response = await call_next(request)
        path = request.url.path
        if (
            path == "/"
            or path.endswith(".html")
            or path.endswith(".js")
            or path.endswith(".css")
        ):
            apply_no_store_headers(response)
        return response

    app.include_router(create_api_router())

    if DIST_DIR.exists():
        app.mount("/assets", AppStaticFiles(directory=DIST_DIR / "assets"), name="assets")

        @app.get("/favicon.svg")
        async def favicon():
            return FileResponse(DIST_DIR / "favicon.svg", headers={"Cache-Control": "public, max-age=86400"})

        @app.get("/icons.svg")
        async def icons():
            return FileResponse(DIST_DIR / "icons.svg", headers={"Cache-Control": "public, max-age=86400"})

        @app.get("/{full_path:path}")
        async def spa_fallback(full_path: str):
            index = DIST_DIR / "index.html"
            if index.exists():
                return Response(index.read_bytes(), media_type="text/html; charset=utf-8")
            return {"error": "dist 目录不存在，请先执行 npm run build"}

    else:
        @app.get("/")
        async def no_dist():
            return {"message": "dist 目录不存在，请执行 npm run build"}

    return app
