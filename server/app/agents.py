from __future__ import annotations

import json
import re
import threading
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from .config import AGENT_RUNS_DIR, AGENTS_DIR
from .tool_registry import EXECUTOR_SERVER, READ_ONLY_ACCESS, TOOL_METADATA, build_tool_guidance_section


READ_ONLY_AGENT_TOOLS = {
    name
    for name, metadata in TOOL_METADATA.items()
    if metadata.subagent_ok and metadata.access in READ_ONLY_ACCESS
}

BACKGROUND_AGENT_TOOLS = {
    name
    for name, metadata in TOOL_METADATA.items()
    if metadata.subagent_ok
    and metadata.access in READ_ONLY_ACCESS
    and metadata.executor_location == EXECUTOR_SERVER
}

DEFAULT_AGENT_MAX_TURNS = 8
MAX_AGENT_MAX_TURNS = 20


@dataclass(frozen=True)
class AgentDefinition:
    agent_type: str
    description: str
    prompt: str
    tools: list[str] = field(default_factory=lambda: ["*"])
    model: str | None = None
    max_turns: int = DEFAULT_AGENT_MAX_TURNS
    background: bool = False
    source: str = "built-in"

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "agentType": self.agent_type,
            "description": self.description,
            "tools": list(self.tools),
            "model": self.model,
            "maxTurns": self.max_turns,
            "background": self.background,
            "source": self.source,
        }


@dataclass
class AgentRunRecord:
    id: str
    conversation_id: str
    agent_type: str
    description: str
    prompt: str
    status: str = "running"
    run_mode: str = "background"
    result: str = ""
    error: str = ""
    trace: list[dict[str, Any]] = field(default_factory=list)
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["conversationId"] = payload.pop("conversation_id")
        payload["agentType"] = payload.pop("agent_type")
        payload["runMode"] = payload.pop("run_mode")
        payload["createdAt"] = payload.pop("created_at")
        payload["updatedAt"] = payload.pop("updated_at")
        return payload


_RUN_LOCK = threading.RLock()
_ACTIVE_BACKGROUND_TASKS: dict[str, Any] = {}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sanitize_path_component(value: str) -> str:
    sanitized = re.sub(r"[^a-zA-Z0-9_-]", "-", str(value).strip())
    return sanitized or "default"


def _coerce_string_list(value: Any, *, default: list[str] | None = None) -> list[str]:
    if value is None:
        return list(default or [])
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    return list(default or [])


def _normalize_agent_type(value: Any) -> str:
    agent_type = str(value or "").strip()
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}", agent_type):
        raise HTTPException(status_code=400, detail=f"无效 Agent 类型: {agent_type or '<empty>'}")
    return agent_type


def _normalize_max_turns(value: Any) -> int:
    try:
        parsed = int(value)
    except Exception:
        return DEFAULT_AGENT_MAX_TURNS
    return max(1, min(parsed, MAX_AGENT_MAX_TURNS))


def _built_in_agents() -> list[AgentDefinition]:
    return [
        AgentDefinition(
            agent_type="general-purpose",
            description="通用只读调研、拆解和方案分析子代理。",
            prompt=(
                "你是 OpenWPS 的通用只读子代理。你可以读取文档、任务、工作区和网络资料，"
                "但不能修改文档。请围绕父代理交给你的问题给出证据、判断、风险和可执行建议。"
            ),
            tools=["*"],
            max_turns=8,
        ),
        AgentDefinition(
            agent_type="document-research",
            description="读取当前文档、工作区和网页资料，汇总可靠证据。",
            prompt=(
                "你是文档调研子代理。优先读取当前文档结构和相关段落，再按需读取工作区或联网搜索。"
                "输出必须区分：文档内证据、外部资料、推断、仍需父代理确认的问题。"
            ),
            tools=[
                "get_document_info",
                "get_document_outline",
                "get_document_content",
                "get_page_content",
                "get_paragraph",
                "search_text",
                "workspace_search",
                "workspace_read",
                "web_search",
            ],
            max_turns=10,
        ),
        AgentDefinition(
            agent_type="writing-plan",
            description="为写作、改写、扩写任务生成结构化写作计划。",
            prompt=(
                "你是写作规划子代理。你只做只读分析和写作方案，不直接写入文档。"
                "请输出目标受众、结构、段落安排、建议措辞和父代理执行步骤。"
            ),
            tools=["get_document_outline", "get_document_content", "get_paragraph", "search_text", "workspace_search", "workspace_read"],
            max_turns=6,
        ),
        AgentDefinition(
            agent_type="layout-plan",
            description="分析当前文档排版，给出格式与版式修复方案。",
            prompt=(
                "你是排版规划子代理。你只读取文档和页面样式，不修改格式。"
                "请指出标题、正文、列表、页边距、分页、目录、图片/表格附近可能的问题，并给出父代理可执行的格式化步骤。"
            ),
            tools=[
                "get_document_info",
                "get_document_outline",
                "get_page_content",
                "get_page_style_summary",
                "get_paragraph",
                "search_text",
            ],
            max_turns=8,
        ),
        AgentDefinition(
            agent_type="image-analysis",
            description="分析当前文档内图片，选择 OCR、多模态或两者结合，并回传结构化视觉理解结果。",
            prompt=(
                "你是图片分析子代理。你只读取当前文档和图片分析工具结果，不修改文档。"
                "先理解父代理任务、图片所在页/段落、图片前后文本、alt/title 和已有缓存摘要；"
                "再调用 analyze_document_image 选择 auto、ocr、multimodal 或 both。"
                "OCR 只用于扫描件、表格、公式、手写或文本密集图片；照片、无文字图、普通截图整体语义优先多模态。"
                "输出必须包含：图片类型判断、实际分析路径、视觉描述、OCR 文本、图表/截图/照片语义、与上下文关系、可信度和父代理使用建议。"
            ),
            tools=[
                "get_document_info",
                "get_document_outline",
                "get_document_content",
                "get_page_content",
                "get_paragraph",
                "analyze_document_image",
            ],
            max_turns=6,
        ),
        AgentDefinition(
            agent_type="verification",
            description="检查主代理执行后的文档状态，输出 PASS / PARTIAL / FAIL。",
            prompt=(
                "你是结果校验子代理。你只读取当前状态，不做修改。"
                "如果父代理分配了具体页码，你只验收该页：先用 get_document_info 或 get_document_outline 确认页数和页码有效，"
                "再调用 capture_page_screenshot 查看该页真实视觉效果，并按需结合 get_page_content/get_page_style_summary 核对结构化证据。"
                "请用 PASS / PARTIAL / FAIL 开头，标明页码、视觉证据、结构化证据、遗漏和建议的下一步。"
            ),
            tools=["get_document_info", "get_document_outline", "get_document_content", "get_page_content", "capture_page_screenshot", "get_page_style_summary", "get_paragraph", "search_text", "get_comments", "TaskList"],
            max_turns=6,
        ),
    ]


def _parse_custom_agent(path: Path) -> AgentDefinition | None:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Agent 配置读取失败: {path.name}") from exc
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail=f"Agent 配置必须是对象: {path.name}")

    agent_type = _normalize_agent_type(raw.get("agentType") or raw.get("name") or path.stem)
    description = str(raw.get("description") or "").strip()
    prompt = str(raw.get("prompt") or "").strip()
    if not description or not prompt:
        raise HTTPException(status_code=400, detail=f"Agent 配置缺少 description 或 prompt: {path.name}")
    return AgentDefinition(
        agent_type=agent_type,
        description=description,
        prompt=prompt,
        tools=_coerce_string_list(raw.get("tools"), default=["*"]),
        model=str(raw.get("model") or "").strip() or None,
        max_turns=_normalize_max_turns(raw.get("maxTurns") or raw.get("max_turns")),
        background=bool(raw.get("background", False)),
        source="custom",
    )


def list_agent_definitions() -> list[AgentDefinition]:
    by_type = {agent.agent_type: agent for agent in _built_in_agents()}
    for path in sorted(AGENTS_DIR.glob("*.json")):
        agent = _parse_custom_agent(path)
        if agent is not None:
            by_type[agent.agent_type] = agent
    return sorted(by_type.values(), key=lambda item: (item.source != "built-in", item.agent_type))


def get_agent_definition(agent_type: str | None) -> AgentDefinition:
    normalized = str(agent_type or "general-purpose").strip() or "general-purpose"
    for agent in list_agent_definitions():
        if agent.agent_type == normalized:
            return agent
    raise HTTPException(status_code=404, detail=f"Agent 不存在: {normalized}")


def resolve_agent_tool_names(agent: AgentDefinition, available_tool_names: set[str], *, background: bool = False) -> list[str]:
    allowed_pool = BACKGROUND_AGENT_TOOLS if background else READ_ONLY_AGENT_TOOLS
    requested = available_tool_names if "*" in agent.tools else set(agent.tools)
    return sorted(requested & available_tool_names & allowed_pool)


def build_agent_system_prompt(agent: AgentDefinition, tool_names: list[str], *, background: bool = False) -> str:
    mode_note = (
        "你正在后台运行，只能使用服务端工具和父代理提供的上下文快照；不要请求实时编辑器读取。"
        if background
        else "你可以请求只读工具读取当前编辑器状态，但禁止任何文档写入或任务变更。"
    )
    tool_guidance = build_tool_guidance_section(
        "agent",
        tool_names,
        agent_type=agent.agent_type,
        background=background,
    )
    return "\n".join([
        f"你是 OpenWPS 子代理：{agent.agent_type}。",
        agent.prompt,
        "",
        "[权限边界]",
        "- 你是只读子代理，不能直接修改文档、样式、任务或工作区。",
        "- 你只能返回分析、证据、计划、校验结论和建议。",
        "- 如果需要写入或格式化，请明确告诉父代理应调用哪些写入工具以及原因。",
        f"- {mode_note}",
        "",
        "[可用工具]",
        ", ".join(tool_names) if tool_names else "无",
        "",
        tool_guidance,
        "",
        "[输出要求]",
        "用结构化中文输出，结论先行；引用工具结果时说明来源；不要编造未读取到的信息。",
    ]).strip()


def new_agent_run_id() -> str:
    return f"agent_{uuid.uuid4().hex[:12]}"


def _conversation_runs_dir(conversation_id: str) -> Path:
    path = AGENT_RUNS_DIR / _sanitize_path_component(conversation_id)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _run_path(conversation_id: str, agent_id: str) -> Path:
    return _conversation_runs_dir(conversation_id) / f"{_sanitize_path_component(agent_id)}.json"


def _record_from_payload(payload: dict[str, Any]) -> AgentRunRecord:
    return AgentRunRecord(
        id=str(payload.get("id") or ""),
        conversation_id=str(payload.get("conversationId") or payload.get("conversation_id") or ""),
        agent_type=str(payload.get("agentType") or payload.get("agent_type") or ""),
        description=str(payload.get("description") or ""),
        prompt=str(payload.get("prompt") or ""),
        status=str(payload.get("status") or "running"),
        run_mode=str(payload.get("runMode") or payload.get("run_mode") or "background"),
        result=str(payload.get("result") or ""),
        error=str(payload.get("error") or ""),
        trace=list(payload.get("trace") or []),
        created_at=str(payload.get("createdAt") or payload.get("created_at") or _now_iso()),
        updated_at=str(payload.get("updatedAt") or payload.get("updated_at") or _now_iso()),
    )


def save_agent_run(record: AgentRunRecord) -> dict[str, Any]:
    record.updated_at = _now_iso()
    payload = record.to_dict()
    with _RUN_LOCK:
        _run_path(record.conversation_id, record.id).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    return payload


def read_agent_run(conversation_id: str, agent_id: str) -> dict[str, Any]:
    path = _run_path(conversation_id, agent_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Agent 运行不存在")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Agent 运行文件损坏") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=500, detail="Agent 运行文件格式错误")
    return _record_from_payload(payload).to_dict()


def list_agent_runs(conversation_id: str) -> list[dict[str, Any]]:
    runs: list[dict[str, Any]] = []
    with _RUN_LOCK:
        for path in _conversation_runs_dir(conversation_id).glob("*.json"):
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                continue
            if isinstance(payload, dict):
                runs.append(_record_from_payload(payload).to_dict())
    runs.sort(key=lambda item: str(item.get("createdAt", "")), reverse=True)
    return runs


def register_background_task(agent_id: str, task: Any) -> None:
    with _RUN_LOCK:
        _ACTIVE_BACKGROUND_TASKS[agent_id] = task


def unregister_background_task(agent_id: str) -> None:
    with _RUN_LOCK:
        _ACTIVE_BACKGROUND_TASKS.pop(agent_id, None)


def cancel_agent_run(conversation_id: str, agent_id: str) -> dict[str, Any]:
    with _RUN_LOCK:
        task = _ACTIVE_BACKGROUND_TASKS.get(agent_id)
        if task is not None:
            task.cancel()
    record = _record_from_payload(read_agent_run(conversation_id, agent_id))
    if record.status == "running":
        record.status = "cancelled"
        record.error = "用户取消"
        return save_agent_run(record)
    return record.to_dict()
