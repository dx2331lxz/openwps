from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Literal


ToolAccess = Literal["read", "search", "web", "ocr", "write", "style", "delete", "task_read", "task_write", "agent", "system"]
ExecutorLocation = Literal["client", "server"]


@dataclass(frozen=True)
class ToolMetadata:
    category: str
    access: ToolAccess
    use_when: str
    avoid_when: str = ""
    result: str = ""
    batch_hint: str = ""
    search_hint: str = ""
    subagent_ok: bool = False
    executor_location: ExecutorLocation = "client"
    parallel_safe: bool = False
    should_defer: bool = False
    always_load: bool = False
    available_in_modes: frozenset[str] = frozenset({"layout", "edit", "agent"})


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    base_schema: dict[str, Any]
    metadata: ToolMetadata

    @property
    def input_schema(self) -> dict[str, Any]:
        function = self.base_schema.get("function") if isinstance(self.base_schema.get("function"), dict) else {}
        parameters = function.get("parameters") if isinstance(function.get("parameters"), dict) else {}
        return deepcopy(parameters)

    def prompt(self, *, agent_type: str | None = None) -> str:
        function = self.base_schema.get("function") if isinstance(self.base_schema.get("function"), dict) else {}
        description = str(function.get("description") or "").strip()
        hints = [f"使用时机：{self.metadata.use_when}"]
        if self.metadata.avoid_when:
            hints.append(f"避免：{self.metadata.avoid_when}")
        if self.metadata.result:
            hints.append(f"结果语义：{self.metadata.result}")
        if agent_type and not self.is_read_only():
            hints.append("子代理边界：此工具会修改状态，子代理不应调用。")
        elif agent_type and self.metadata.subagent_ok:
            hints.append("子代理边界：只读可用。")
        return " ".join([description, *hints]).strip()

    def is_read_only(self) -> bool:
        return self.metadata.access in {"read", "search", "web", "ocr", "task_read", "system"}

    def is_parallel_safe(self) -> bool:
        return self.metadata.parallel_safe

    def should_defer(self) -> bool:
        return self.metadata.should_defer and not self.metadata.always_load

    def to_openai_tool(self, *, agent_type: str | None = None) -> dict[str, Any]:
        schema = deepcopy(self.base_schema)
        function = schema.get("function") if isinstance(schema.get("function"), dict) else None
        if function is None:
            return schema
        function["description"] = self.prompt(agent_type=agent_type)
        return schema

    def to_deferred_summary(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "category": self.metadata.category,
            "searchHint": self.metadata.search_hint or self.metadata.use_when,
            "description": self.metadata.use_when,
        }


READ_ONLY_ACCESS = {"read", "search", "task_read", "ocr", "web", "system"}
WRITE_ACCESS = {"write", "style", "delete", "task_write"}
EXECUTOR_SERVER = "server"
EXECUTOR_CLIENT = "client"
TOOL_SEARCH_NAME = "ToolSearch"


MODE_LAYOUT = frozenset({"layout"})
MODE_EDIT = frozenset({"edit"})
MODE_AGENT = frozenset({"agent"})
MODE_ALL = frozenset({"layout", "edit", "agent"})
MODE_EDIT_AGENT = frozenset({"edit", "agent"})
MODE_LAYOUT_AGENT = frozenset({"layout", "agent"})


TOOL_METADATA: dict[str, ToolMetadata] = {
    "TaskCreate": ToolMetadata("task", "task_write", "复杂多步任务开始前创建内部执行计划。", "不要用于用户要求写入正文任务列表/checklist。", available_in_modes=MODE_AGENT),
    "TaskGet": ToolMetadata("task", "task_read", "更新任务前读取最新任务状态，避免 stale update。", subagent_ok=True, available_in_modes=MODE_AGENT),
    "TaskList": ToolMetadata("task", "task_read", "查看当前内部任务列表和剩余工作；复杂任务完成前用它确认状态。", subagent_ok=True, parallel_safe=True, available_in_modes=MODE_AGENT),
    "TaskUpdate": ToolMetadata("task", "task_write", "任务开始、完成或状态变化时更新内部任务。", "不要把未完成、失败或未验证的任务标记 completed。", available_in_modes=MODE_AGENT),
    "Agent": ToolMetadata("agent", "agent", "启动只读子代理做调研、规划、排版分析或验收。", "简单定位、少量读取或主流程下一步能直接完成时不要调用。", executor_location=EXECUTOR_SERVER, available_in_modes=MODE_AGENT),
    "get_document_info": ToolMetadata("read", "read", "快速了解文档统计、页数和整体状态。", subagent_ok=True, parallel_safe=True, available_in_modes=MODE_ALL),
    "get_document_outline": ToolMetadata("read", "read", "长文档或结构不确定时先用它导航页码和段落范围。", "不要一开始就读取全文。", subagent_ok=True, parallel_safe=True, available_in_modes=MODE_ALL),
    "get_document_content": ToolMetadata("read", "read", "按段落范围读取正文和结构；需要验证写入内容时使用。", "长文档优先先用 get_document_outline 缩小范围。", subagent_ok=True, parallel_safe=True, available_in_modes=MODE_ALL),
    "get_page_content": ToolMetadata("read", "read", "按页检查正文、表格、图片附近内容和版面快照。", subagent_ok=True, parallel_safe=True, available_in_modes=MODE_ALL),
    "get_page_style_summary": ToolMetadata("read", "read", "怀疑标题/正文样式、分页或页级排版异常时抽查。", "普通内容核对不要用 format 级读取。", subagent_ok=True, parallel_safe=True, available_in_modes=MODE_ALL),
    "get_paragraph": ToolMetadata("read", "read", "精确读取单段文字或样式，适合局部校验。", subagent_ok=True, parallel_safe=True, available_in_modes=MODE_ALL),
    "search_text": ToolMetadata("search", "search", "按文字定位段落和锁定范围；修改某个词/短语前先用它精确定位。", subagent_ok=True, parallel_safe=True, available_in_modes=MODE_ALL),
    "get_comments": ToolMetadata("read", "read", "需要处理批注、审阅意见或验收是否遗漏批注时使用。", subagent_ok=True, parallel_safe=True, available_in_modes=MODE_ALL),
    "analyze_image_with_ocr": ToolMetadata("read", "ocr", "图片涉及表格、扫描件、手写、公式或明确 OCR 任务时使用。", "普通图片复现优先直接多模态理解。", search_hint="OCR 图片 表格 扫描件 手写 公式", subagent_ok=True, parallel_safe=True, should_defer=True, available_in_modes=MODE_AGENT),
    "set_text_style": ToolMetadata("style", "style", "只改文字片段的字体、颜色、粗体等内联样式。", "不要用它设置段落对齐、缩进、标题级别。", "返回受影响快照。", available_in_modes=MODE_LAYOUT_AGENT),
    "set_paragraph_style": ToolMetadata("style", "style", "设置段落对齐、缩进、行距、标题级别、列表或段前分页。", "只改某个词本身时用 set_text_style。", "返回受影响快照。", available_in_modes=MODE_LAYOUT_AGENT),
    "insert_table_of_contents": ToolMetadata("write", "write", "插入真正 DOCX 自动目录字段。", "不要用正文手写点线和页码模拟目录。", search_hint="目录 自动目录 headingLevel", should_defer=True, available_in_modes=MODE_LAYOUT_AGENT),
    "clear_formatting": ToolMetadata("style", "style", "清除文字或段落格式。", "只清除具体文字时先用 search_text 锁定范围。", "返回受影响快照。", should_defer=True, available_in_modes=MODE_LAYOUT_AGENT),
    "set_page_config": ToolMetadata("style", "style", "修改纸张、方向、页边距等页面设置。", search_hint="页面设置 页边距 纸张 横向", should_defer=True, available_in_modes=MODE_LAYOUT_AGENT),
    "insert_page_break": ToolMetadata("write", "write", "在指定段落后插入分页符。", "大章节段前分页也可用 set_paragraph_style(pageBreakBefore=true)。", search_hint="分页符 换页", should_defer=True, available_in_modes=MODE_LAYOUT_AGENT),
    "insert_horizontal_rule": ToolMetadata("write", "write", "插入水平分割线。", "不要用 Markdown --- 模拟分页。", should_defer=True, available_in_modes=MODE_LAYOUT_AGENT),
    "insert_table": ToolMetadata("write", "write", "插入表格；有完整数据时优先一次传 data 二维数组。", "不要先插空表再逐格补内容。", search_hint="表格 插入表格 data", should_defer=True, available_in_modes=MODE_LAYOUT_AGENT),
    "begin_streaming_write": ToolMetadata("write", "write", "长段、多段、表格 Markdown 或整体改写时先声明位置，再立刻输出正文。", "没有准备好直接写正文时不要调用。", "写完后需要用读取工具验证内容。", available_in_modes=MODE_EDIT_AGENT),
    "insert_text": ToolMetadata("write", "write", "在段落末尾追加短文本。", "新增多段正文用 begin_streaming_write 或 insert_paragraph_after。", available_in_modes=MODE_EDIT_AGENT),
    "insert_paragraph_after": ToolMetadata("write", "write", "在指定段落后插入一个短段落。", "长内容或多段用 begin_streaming_write。", available_in_modes=MODE_EDIT_AGENT),
    "replace_paragraph_text": ToolMetadata("write", "write", "整体替换一个段落的文字。", "只替换选区时用 replace_selection_text。", available_in_modes=MODE_EDIT_AGENT),
    "replace_selection_text": ToolMetadata("write", "write", "替换当前选区文字；range 必须来自 context.selection。", "无选区时不要猜测 selection 范围。", available_in_modes=MODE_EDIT_AGENT),
    "delete_selection_text": ToolMetadata("delete", "delete", "删除当前选区文字。", "无选区时不要调用。", available_in_modes=MODE_EDIT_AGENT),
    "delete_paragraph": ToolMetadata("delete", "delete", "删除一个或多个整段；多段优先一次传 indices。", "删除前确认段落索引，避免索引漂移。", available_in_modes=MODE_EDIT_AGENT),
    "apply_style_batch": ToolMetadata("style", "style", "全文排版、多范围样式、按角色设置标题/正文时优先使用。", "不要用多次单段样式工具替代可批量完成的操作。", "返回受影响快照。", batch_hint="推荐批量", available_in_modes=MODE_LAYOUT_AGENT),
    "insert_image": ToolMetadata("write", "write", "插入已有 URL 或 data URL 图片。", "流程图/思维导图等应使用 insert_mermaid。", search_hint="图片 插入图片 URL data URL", should_defer=True, available_in_modes=MODE_EDIT_AGENT),
    "insert_mermaid": ToolMetadata("write", "write", "插入流程图、时序图、类图、甘特图、思维导图等 Mermaid 图表。", "不要用文字/表格模拟图表。", search_hint="Mermaid 流程图 时序图 思维导图", should_defer=True, available_in_modes=MODE_EDIT_AGENT),
    "workspace_search": ToolMetadata("search", "search", "在工作区参考文档中先定位关键词、条款、数据或范文。", "工作区文档能回答时不要先联网。", search_hint="工作区 参考文档 搜索", subagent_ok=True, parallel_safe=True, should_defer=True, available_in_modes=MODE_AGENT),
    "workspace_read": ToolMetadata("read", "read", "按 doc_id 读取工作区文档全文或行范围。", "先用 workspace_search 定位后再读取更稳。", search_hint="读取工作区文档 doc_id", subagent_ok=True, parallel_safe=True, should_defer=True, available_in_modes=MODE_AGENT),
    "web_search": ToolMetadata("search", "web", "任务依赖最新信息、公开网页或工作区外事实时使用。", "当前文档或工作区资料足够时不要联网。", search_hint="联网 搜索 网页 最新 新闻", subagent_ok=True, executor_location=EXECUTOR_SERVER, should_defer=True, available_in_modes=MODE_AGENT),
}


TOOL_SEARCH_SCHEMA: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": TOOL_SEARCH_NAME,
        "description": (
            "按名称或关键词加载延迟工具的完整 schema。"
            "当你需要调用某个当前只在工具列表摘要中出现的工具时，先调用本工具。"
            "支持 query='select:tool_a,tool_b' 精确加载。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "工具名称、类别、关键词；或 select:tool_name 精确选择。",
                },
            },
            "required": ["query"],
        },
    },
}


TOOL_SEARCH_DEFINITION = ToolDefinition(
    name=TOOL_SEARCH_NAME,
    base_schema=TOOL_SEARCH_SCHEMA,
    metadata=ToolMetadata(
        "system",
        "system",
        "需要加载延迟工具的完整 schema 时使用。",
        executor_location=EXECUTOR_SERVER,
        parallel_safe=False,
        always_load=True,
        available_in_modes=MODE_ALL,
    ),
)


def build_tool_definitions(base_tools: list[dict[str, Any]]) -> dict[str, ToolDefinition]:
    definitions: dict[str, ToolDefinition] = {}
    for tool in base_tools:
        function = tool.get("function") if isinstance(tool.get("function"), dict) else {}
        name = str(function.get("name") or "")
        metadata = TOOL_METADATA.get(name)
        if not name or metadata is None:
            continue
        definitions[name] = ToolDefinition(name=name, base_schema=tool, metadata=metadata)
    return definitions


def mode_name(mode: str | None) -> str:
    return mode if mode in {"layout", "edit", "agent"} else "layout"


def definition_available_in_mode(definition: ToolDefinition, mode: str | None) -> bool:
    return mode_name(mode) in definition.metadata.available_in_modes


def is_tool_read_only(tool_name: str) -> bool:
    if tool_name == TOOL_SEARCH_NAME:
        return True
    definition = TOOL_METADATA.get(tool_name)
    return bool(definition and definition.access in READ_ONLY_ACCESS)


def is_tool_parallel_safe(tool_name: str) -> bool:
    definition = TOOL_METADATA.get(tool_name)
    return bool(definition and definition.parallel_safe)


def get_tool_executor_location(tool_name: str) -> ExecutorLocation:
    if tool_name == TOOL_SEARCH_NAME:
        return EXECUTOR_SERVER
    definition = TOOL_METADATA.get(tool_name)
    return definition.executor_location if definition else EXECUTOR_CLIENT


def build_tool_guidance_section(
    mode: str | None,
    tool_names: list[str] | set[str] | tuple[str, ...],
    *,
    agent_type: str | None = None,
    background: bool = False,
) -> str:
    ordered = sorted({str(name) for name in tool_names if str(name).strip()})
    enabled = set(ordered)
    if not enabled:
        return ""

    lines: list[str] = ["## 工具使用原则"]
    if agent_type:
        lines.append("- 你是只读子代理；只能使用当前列出的只读工具获取证据、计划或校验结论，不能修改文档、样式、任务或工作区。")
        if background:
            lines.append("- 后台子代理只能基于父代理提供的上下文快照和服务端工具分析，不要请求实时编辑器读取。")
        else:
            lines.append("- 同步子代理可请求前端只读工具读取当前编辑器状态；如果需要写入，只能把建议返回给父代理执行。")
        if agent_type == "verification":
            lines.append("- 验收顺序：先理解父代理委托和原始目标，再用 TaskList/outline/页面或段落读取核对结果，结论必须以 PASS / PARTIAL / FAIL 开头。")
            lines.append("- verification 不做修复；发现问题时说明证据、遗漏和建议父代理调用的下一步工具。")
        elif agent_type == "document-research":
            lines.append("- 调研优先级：当前文档 → 工作区资料 → 必要时 web_search；输出要区分文档内证据、外部资料和推断。")
        elif agent_type == "writing-plan":
            lines.append("- 写作规划只产出结构、段落安排、措辞建议和父代理执行步骤，不直接写入正文。")
        elif agent_type == "layout-plan":
            lines.append("- 排版规划只分析页面、段落、标题、目录、图片和表格附近问题，并给出父代理可执行的格式化步骤。")
        else:
            lines.append("- 开放式调研要先用读取/搜索工具缩小范围，再给出证据、风险和可执行建议。")
    else:
        lines.append("- 优先使用已绑定的专用工具；不要请求当前模式不可用的工具。")
        if enabled & {"get_document_outline", "get_document_content", "get_page_content", "get_paragraph", "search_text"}:
            lines.append("- 读取阶梯：结构不确定先 get_document_outline；按页判断用 get_page_content；按段落范围用 get_document_content；局部核对用 get_paragraph；改具体文字前用 search_text 锁定范围。")
        if enabled & {"begin_streaming_write", "insert_text", "insert_paragraph_after", "replace_paragraph_text", "replace_selection_text", "delete_selection_text", "delete_paragraph"}:
            lines.append("- 写入阶梯：长文/多段/整体重写用 begin_streaming_write 并立刻输出 Markdown；短插入用 insert_text/insert_paragraph_after；局部替换用 replace_paragraph_text 或 replace_selection_text；删除前确认范围。")
        if enabled & {"apply_style_batch", "set_text_style", "set_paragraph_style", "clear_formatting", "set_page_config", "insert_table_of_contents"}:
            lines.append("- 排版阶梯：全文或多范围样式优先 apply_style_batch；只改文字片段用 set_text_style；改对齐/缩进/标题级别用 set_paragraph_style；目录必须 insert_table_of_contents。")
        if enabled & {"workspace_search", "workspace_read", "web_search"}:
            lines.append("- 资料检索：工作区资料优先 workspace_search 再 workspace_read；只有实时信息、公开网页或工作区外事实才用 web_search。")
        if "Agent" in enabled:
            lines.append("- 子代理调度：简单定位直接用读取/搜索工具；多源证据用 document-research，写作规划用 writing-plan，排版分析用 layout-plan，复杂验收用 verification。")
        if enabled & {"TaskCreate", "TaskGet", "TaskList", "TaskUpdate"}:
            lines.append("- 任务工具只用于 AI 内部多步计划；用户说任务列表/checklist 时默认是文档正文需求，不要误用内部任务工具。")
        if TOOL_SEARCH_NAME in enabled:
            lines.append("- 如果需要的工具只在延迟工具摘要中出现，先用 ToolSearch 加载完整 schema，再在下一轮调用该工具。")

    read_only = [name for name in ordered if is_tool_read_only(name)]
    mutating = [name for name in ordered if TOOL_METADATA.get(name) and TOOL_METADATA[name].access in WRITE_ACCESS]
    if read_only:
        lines.append(f"- 只读工具：{', '.join(read_only)}。")
    if mutating and not agent_type:
        lines.append(f"- 会修改文档或任务的工具：{', '.join(mutating)}；按依赖顺序执行，避免并发写入造成范围漂移。")
    return "\n".join(lines)


def build_tool_prompt_trace(
    mode: str | None,
    tool_names: list[str] | set[str] | tuple[str, ...],
    guidance: str,
    *,
    agent_type: str | None = None,
    background: bool = False,
    deferred_tool_count: int = 0,
    loaded_deferred_tool_count: int = 0,
) -> dict[str, Any]:
    ordered = sorted({str(name) for name in tool_names if str(name).strip()})
    raw = json.dumps(ordered, ensure_ascii=False, sort_keys=True)
    return {
        "mode": mode or "agent",
        "agentType": agent_type or "",
        "background": background,
        "toolCount": len(ordered),
        "toolNamesHash": hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16],
        "guidanceChars": len(guidance),
        "deferredToolCount": deferred_tool_count,
        "loadedDeferredToolCount": loaded_deferred_tool_count,
    }
