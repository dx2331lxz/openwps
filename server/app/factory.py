from __future__ import annotations

import json

from fastapi import APIRouter, FastAPI, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import FileResponse

from .ai import (
    analyze_image_with_vision,
    analyze_images_with_ocr,
    cancel_react_gateway_run,
    create_react_gateway_run,
    create_react_session,
    get_conversation_react_gateway_run,
    get_react_gateway_run,
    get_react_session,
    get_react_session_trace,
    list_conversation_react_traces,
    list_models,
    prepare_chat_request,
    run_chat,
    run_completion,
    stream_react_gateway_run_events,
    stream_react_session,
    submit_react_client_event,
    submit_react_tool_results,
    test_vision_model,
)
from .config import DIST_DIR, get_provider, public_config, read_config, write_config
from .conversations import (
    append_messages,
    create_conversation,
    delete_conversation,
    list_conversations,
    read_conversation,
)
from .documents import delete_document, list_documents, read_document_path, save_document
from .documents import get_document_settings, update_document_settings
from .agents import cancel_agent_run, list_agent_definitions, list_agent_runs, read_agent_run
from .models import (
    AppendMessagesRequest,
    ChatRequest,
    ClientEventRequest,
    CompletionRequest,
    DocumentSettingsUpdateRequest,
    ModelDiscoveryRequest,
    SettingsUpdate,
    TaskCreateRequest,
    TaskUpdateRequest,
    TemplateAnalyzeRequest,
    TemplateCreateRequest,
    TemplateUpdateRequest,
    ToolResultsRequest,
    VisionAnalyzeRequest,
    VisionTestRequest,
)
from .models import OCRCommandRequest
from .template_analysis import analyze_template_request
from .templates import create_template, delete_template, list_templates, read_template, update_template
from .tasks import create_task, delete_task, get_task, list_tasks, reset_completed_tasks, update_task
from .workspace import (
    delete_document as ws_delete,
    get_document_content as ws_get_content,
    list_workspace_docs,
    search_workspace,
    upload_document,
)


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
        existing_ocr = dict(current.get("ocrConfig") or {})
        existing_vision = dict(current.get("visionConfig") or {})
        cfg = {
            "version": 2,
            "activeProviderId": body.activeProviderId,
            "imageProcessingMode": body.imageProcessingMode,
            "ocrConfig": {},
            "visionConfig": {},
            "tavilyConfig": {},
            "providers": [],
        }
        for provider in body.providers:
            item = provider.model_dump(exclude_none=True)
            if "apiKey" not in item and item.get("id") in existing_by_id:
                item["apiKey"] = existing_by_id[item["id"]].get("apiKey", "")
            cfg["providers"].append(item)

        ocr_item = body.ocrConfig.model_dump(exclude_none=True)
        ocr_item.pop("hasApiKey", None)
        if "apiKey" not in ocr_item:
            ocr_item["apiKey"] = existing_ocr.get("apiKey", "")
        cfg["ocrConfig"] = ocr_item

        vision_item = body.visionConfig.model_dump(exclude_none=True)
        vision_item.pop("hasApiKey", None)
        if "apiKey" not in vision_item:
            vision_item["apiKey"] = existing_vision.get("apiKey", "")
        cfg["visionConfig"] = vision_item

        existing_tavily = dict(current.get("tavilyConfig") or {})
        tavily_item = body.tavilyConfig.model_dump(exclude_none=True)
        tavily_item.pop("hasApiKey", None)
        if "apiKey" not in tavily_item:
            tavily_item["apiKey"] = existing_tavily.get("apiKey", "")
        cfg["tavilyConfig"] = tavily_item
        write_config(cfg)
        return public_config(cfg)

    @router.get("/ai/models")
    async def get_models(providerId: str | None = None):
        cfg = read_config()
        provider = get_provider(cfg, providerId)
        models = await list_models(provider.get("endpoint", ""), str(provider.get("apiKey", "") or ""), provider.get("id"))
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

        models = await list_models(endpoint, api_key, body.providerId)
        return {"models": models}

    @router.post("/ai/vision/test")
    async def post_vision_test(body: VisionTestRequest):
        return await test_vision_model(body)

    @router.post("/ai/vision/analyze")
    async def post_vision_analyze(body: VisionAnalyzeRequest):
        return await analyze_image_with_vision(body)

    @router.get("/ai/agents")
    def get_agents():
        return {"agents": [agent.to_public_dict() for agent in list_agent_definitions()]}

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

    @router.get("/conversations/{conv_id}/react-traces")
    def get_conversation_react_traces(conv_id: str):
        return {"traces": list_conversation_react_traces(conv_id)}

    @router.get("/conversations/{conv_id}/runs/active")
    def get_conversation_active_run(conv_id: str):
        return {"run": get_conversation_react_gateway_run(conv_id)}

    @router.post("/conversations/{conv_id}/messages")
    def post_messages(conv_id: str, body: AppendMessagesRequest):
        append_messages(
            conv_id,
            [message.model_dump(exclude_none=True) for message in body.messages],
        )
        return {"success": True}

    @router.get("/conversations/{conv_id}/tasks")
    def get_conversation_tasks(conv_id: str):
        return {"tasks": list_tasks(conv_id)}

    @router.get("/conversations/{conv_id}/agents")
    def get_conversation_agents(conv_id: str):
        return {"agents": list_agent_runs(conv_id)}

    @router.get("/conversations/{conv_id}/agents/{agent_id}")
    def get_conversation_agent(conv_id: str, agent_id: str):
        return {"agent": read_agent_run(conv_id, agent_id)}

    @router.post("/conversations/{conv_id}/agents/{agent_id}/cancel")
    def post_cancel_conversation_agent(conv_id: str, agent_id: str):
        return {"agent": cancel_agent_run(conv_id, agent_id)}

    @router.post("/conversations/{conv_id}/tasks")
    def post_conversation_task(conv_id: str, body: TaskCreateRequest):
        return {"task": create_task(conv_id, body.model_dump(exclude_none=True))}

    @router.post("/conversations/{conv_id}/tasks/reset-completed")
    def post_reset_completed_tasks(conv_id: str):
        return reset_completed_tasks(conv_id)

    @router.get("/conversations/{conv_id}/tasks/{task_id}")
    def get_conversation_task(conv_id: str, task_id: str):
        return {"task": get_task(conv_id, task_id)}

    @router.patch("/conversations/{conv_id}/tasks/{task_id}")
    def patch_conversation_task(conv_id: str, task_id: str, body: TaskUpdateRequest):
        return {"task": update_task(conv_id, task_id, body.model_dump(exclude_unset=True))}

    @router.delete("/conversations/{conv_id}/tasks/{task_id}")
    def delete_conversation_task(conv_id: str, task_id: str):
        return delete_task(conv_id, task_id)

    @router.delete("/conversations/{conv_id}")
    def remove_conversation(conv_id: str):
        delete_conversation(conv_id)
        return {"success": True}

    @router.get("/documents")
    def get_documents(source: str | None = None):
        return list_documents(source)

    @router.get("/documents/settings")
    def get_documents_settings():
        return get_document_settings()

    @router.put("/documents/settings")
    def put_documents_settings(body: DocumentSettingsUpdateRequest):
        return update_document_settings(body.model_dump(exclude_unset=True))

    @router.put("/documents/{name:path}")
    async def put_document(name: str, request: Request, source: str | None = None):
        content = await request.body()
        return save_document(name, content, source)

    @router.get("/documents/{name:path}")
    def get_document(name: str, source: str | None = None):
        path = read_document_path(name, source)
        return FileResponse(
            path,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            filename=path.name,
        )

    @router.delete("/documents/{name:path}")
    def remove_document(name: str, source: str | None = None):
        delete_document(name, source)
        return {"success": True}

    @router.get("/templates")
    def get_templates():
        return list_templates()

    @router.post("/templates")
    def post_template(body: TemplateCreateRequest):
        return create_template(body.model_dump(exclude_none=True))

    @router.post("/templates/analyze")
    async def analyze_template(body: TemplateAnalyzeRequest):
        return await analyze_template_request(body.model_dump(exclude_none=True))

    @router.get("/templates/{template_id}")
    def get_template(template_id: str):
        return read_template(template_id)

    @router.patch("/templates/{template_id}")
    def patch_template(template_id: str, body: TemplateUpdateRequest):
        return update_template(template_id, body.model_dump(exclude_none=True))

    @router.delete("/templates/{template_id}")
    def remove_template(template_id: str):
        delete_template(template_id)
        return {"success": True}

    # ── Workspace (知识库) ──

    @router.get("/workspace")
    def get_workspace():
        return list_workspace_docs()

    @router.post("/workspace/upload")
    async def upload_workspace_doc(file: UploadFile):
        content = await file.read()
        result = upload_document(file.filename or "untitled", file.content_type or "", content)
        return result

    @router.delete("/workspace/{doc_id}")
    def delete_workspace_doc(doc_id: str):
        return ws_delete(doc_id)

    @router.get("/workspace/search")
    def search_workspace_docs(q: str, doc_id: str | None = None, context_lines: int = 3):
        return search_workspace(q, doc_id, context_lines)

    @router.get("/workspace/{doc_id}/content")
    def get_workspace_content(doc_id: str, from_line: int | None = None, to_line: int | None = None):
        return ws_get_content(doc_id, from_line, to_line)

    @router.post("/ai/chat")
    async def chat(body: ChatRequest):
        return await run_chat(body)

    @router.post("/ai/complete")
    async def complete(body: CompletionRequest):
        return await run_completion(body)

    @router.post("/ai/ocr")
    async def analyze_ocr(body: OCRCommandRequest):
        return await analyze_images_with_ocr(body)

    @router.post("/ai/react/stream")
    async def react_stream(body: ChatRequest):
        prepared_body = await prepare_chat_request(body)
        session = create_react_session(prepared_body)

        async def generate():
            try:
                async for event in stream_react_session(session):
                    yield sse(str(event["type"]), event)
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

    @router.post("/ai/react/runs")
    async def post_react_run(body: ChatRequest):
        prepared_body = await prepare_chat_request(body)
        run = await create_react_gateway_run(prepared_body)
        return run.snapshot()

    @router.get("/ai/react/runs/{session_id}/events")
    async def get_react_run_events(session_id: str, after: int = 0):
        async def generate():
            try:
                async for event in stream_react_gateway_run_events(session_id, after=after):
                    yield sse(str(event["type"]), event)
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

    @router.post("/ai/react/runs/{session_id}/cancel")
    async def post_cancel_react_run(session_id: str):
        cancel_react_gateway_run(session_id)
        return {"success": True}

    @router.post("/ai/react/{session_id}/client-events")
    async def post_react_client_event(session_id: str, body: ClientEventRequest):
        return await submit_react_client_event(session_id, body)

    @router.post("/ai/react/{session_id}/tool-results")
    async def post_tool_results(session_id: str, body: ToolResultsRequest):
        gateway_run = get_react_gateway_run(session_id)
        session = gateway_run.session if gateway_run else get_react_session(session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found or expired")

        submit_react_tool_results(session, body)
        return {"success": True}

    @router.get("/ai/react/{session_id}/trace")
    async def get_react_trace(session_id: str):
        trace = get_react_session_trace(session_id)
        if not trace:
            raise HTTPException(status_code=404, detail="React trace not found")
        return trace

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
