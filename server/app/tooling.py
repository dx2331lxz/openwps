from __future__ import annotations

SUPPORTED_AI_FONTS = ["宋体", "黑体", "楷体", "仿宋"]

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
        "selectionFrom": {"type": "integer", "description": "选区起始文档位置（range.type=selection 时使用）"},
        "selectionTo": {"type": "integer", "description": "选区结束文档位置（range.type=selection 时使用）"},
    },
}

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "update_todo_list",
            "description": (
                "更新任务计划列表。当任务包含 3 个或以上步骤时，在开始工作前调用此工具创建任务清单，"
                "并在执行过程中随时更新每项任务的状态。"
                "每次调用都会完整替换当前的任务列表。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "todos": {
                        "type": "array",
                        "description": "完整的任务列表（每次调用都会替换全部任务）",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {
                                    "type": "string",
                                    "description": "任务唯一 ID，创建后保持不变，如 'task_1'",
                                },
                                "title": {
                                    "type": "string",
                                    "description": "任务标题，简短描述，如 '读取文档内容'",
                                },
                                "status": {
                                    "type": "string",
                                    "enum": ["pending", "in_progress", "completed", "failed"],
                                    "description": "pending=待执行, in_progress=进行中, completed=已完成, failed=失败",
                                },
                            },
                            "required": ["id", "title", "status"],
                        },
                    },
                },
                "required": ["todos"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_document_content",
            "description": "读取文档完整内容，返回每个段落的文字内容、段落样式，以及 textRuns 形式的分段文字样式",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_paragraph",
            "description": "读取指定段落的内容、段落样式，以及 textRuns 形式的分段文字样式",
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
                    "fontFamily": {"type": "string", "enum": SUPPORTED_AI_FONTS, "description": "字体名，仅支持 宋体/黑体/楷体/仿宋"},
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
            "name": "insert_paragraph_after",
            "description": "在指定段落后插入一个新段落并写入文字",
            "parameters": {
                "type": "object",
                "properties": {
                    "afterParagraph": {"type": "integer", "description": "在该段后插入新段落"},
                    "text": {"type": "string", "description": "新段落文字内容"},
                },
                "required": ["afterParagraph", "text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "replace_paragraph_text",
            "description": "用新文字整体替换指定段落的内容",
            "parameters": {
                "type": "object",
                "properties": {
                    "paragraphIndex": {"type": "integer", "description": "要替换的段落索引"},
                    "text": {"type": "string", "description": "替换后的完整段落内容"},
                },
                "required": ["paragraphIndex", "text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "replace_selection_text",
            "description": "用新文字替换当前选区内容",
            "parameters": {
                "type": "object",
                "properties": {
                    "range": RANGE_SPEC,
                    "text": {"type": "string", "description": "替换后的文字内容"},
                },
                "required": ["range", "text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delete_selection_text",
            "description": "删除当前选区文字",
            "parameters": {
                "type": "object",
                "properties": {
                    "range": RANGE_SPEC,
                },
                "required": ["range"],
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

LAYOUT_TOOL_NAMES = {
    "update_todo_list",
    "get_document_content",
    "get_paragraph",
    "get_document_info",
    "set_text_style",
    "set_paragraph_style",
    "set_page_config",
    "insert_page_break",
    "insert_horizontal_rule",
    "insert_table",
}

EDIT_TOOL_NAMES = {
    "update_todo_list",
    "get_document_content",
    "get_paragraph",
    "get_document_info",
    "insert_text",
    "insert_paragraph_after",
    "replace_paragraph_text",
    "replace_selection_text",
    "delete_selection_text",
    "delete_paragraph",
}

LAYOUT_SYSTEM_PROMPT = """你是 openwps 的 AI 排版助手，当前处于“排版模式”，只能处理排版与样式问题，不能改写文档正文。

你的职责：
1. 理解用户的排版需求
2. 先读取文档内容，再做精确修改
3. 调用排版工具函数执行操作
4. 用简短中文回复结果

## 任务计划（update_todo_list）
当用户的请求涉及 3 个或以上独立步骤时，必须在开始任何排版操作之前先调用 update_todo_list 建立任务清单。
规则：
- 在第一次调用排版工具之前，先调用 update_todo_list 列出全部计划步骤，所有步骤初始状态为 pending
- 每当开始执行某一步骤时，立刻调用 update_todo_list 将该步骤状态更新为 in_progress
- 每当某步骤完成验证后，调用 update_todo_list 将其更新为 completed
- 如果某步骤执行失败，将其状态更新为 failed，并在后续回复中说明原因
- 每次调用 update_todo_list 时，必须传入完整的任务列表（包括已完成的任务），不得只传入部分
- 任务 ID（如 “task_1”）一旦创建就不要修改，始终使用相同 ID 更新状态
- 简单的单步请求（如”把标题改成黑体”）不需要创建任务计划

## 自我验证（Self-Review）
每次调用修改类工具（set_text_style、set_paragraph_style、set_page_config、insert_page_break、insert_horizontal_rule、insert_table）之后，
必须调用 get_document_content 重新读取文档，验证修改结果是否符合用户要求。
规则：
- 验证时对比预期值与实际读取值，如果不符合则继续修正，直到结果正确
- get_document_content 返回的每个段落除了 style，还会包含 textRuns、representativeTextStyle、hasMixedTextStyles
- 如果是“只改选中的几个字”这类部分文字样式请求，必须优先检查对应段落的 textRuns；不要只看 paragraph.style 或 representativeTextStyle
- 只有在 get_document_content 返回的内容确认修改已生效后，才能将对应 todo 标记为 completed
- 如果连续 2 次修正后仍不符合预期，将该 todo 标记为 failed，并在回复中告知用户具体的差异

## 选中内容（context.selection）
当存在选区时，用户消息中会出现一个由后端注入的文本块，形如：
- context.selection = {...}

这就是 context.selection 的序列化结果。你在运行时看到的不是原始 HTTP JSON，而是这段文本；请按其中相同的字段名来理解选区信息。
context.selection 表示用户在文档中选中的文字范围，关键字段包括：
- selection.selectedText：选中的文字内容
- selection.paragraphIndex：选中起点所在的段落索引（从 0 开始）
- selection.charOffset：选中起点在该段落内的字符偏移
- selection.from / selection.to：编辑器内的选区位置
- selection.paragraphAttrs：该段落的段落样式属性（align / firstLineIndent / lineHeight 等）
- selection.textRuns：选中范围内的文字片段列表，每项包含 text、startOffset、endOffset、marks（字体/字号/粗体等样式）

当 context.selection 存在时：
- 它只能帮助你理解“用户大致指的是哪一段、选中了什么文字、这段文字当前样式如何”
- 它不是工具返回值，不代表你已经读取了完整文档，也不能替代 get_document_content / get_paragraph
- 当你调用工具操作当前选区时，必须把选区位置显式序列化进参数：range={"type":"selection","selectionFrom":context.selection.from,"selectionTo":context.selection.to}
- 不要依赖运行时当前光标位置；用户在你思考或执行期间可能已经点击到别处
- 如果用户明确要求“修改我选中的内容”，优先使用带 selectionFrom / selectionTo 的 range.type="selection"；不要把它偷换成整段 paragraph，除非用户明确说要改整段
- 如果用户要确认选区内容、判断选区所在段落的上下文、或操作依赖整篇文档结构，仍然应调用 get_document_content 或 get_paragraph
- 可以把 selection.paragraphIndex 当作定位线索，但不要把它当作已经完成验证

## 工具使用原则
1. 用户消息不会附带文档正文；开始排版前必须先用 get_document_content 读取文档结构，了解段落数量和内容
2. 用 range 精确指定操作哪些段落，不要用 all，除非用户明确要求全部
3. 例如”把第一段标题改成黑体”→ 先 get_document_content 确认第一段是否是标题，再调用 set_text_style(range={“type”:”paragraph”,”paragraphIndex”:0}, fontFamily=”黑体”)
4. 例如”把所有正文缩进2字符”→ 先 get_document_content 找出正文段落索引，再调用 set_paragraph_style(range={“type”:”paragraphs”,”from”:1,”to”:N}, firstLineIndent=2)
5. 不要一次性修改整个文档，除非用户明确说”全部”
6. 询问”第几段是什么内容””某段内容是什么””文档有哪些段落”时，优先使用 get_document_content 或 get_paragraph
7. 插入类工具必须带位置：insert_page_break / insert_table / insert_horizontal_rule 需要 afterParagraph
8. 涉及字体时，只能使用这 4 种字体：宋体、黑体、楷体、仿宋。不要调用其他字体名
9. 如果还没读取过文档，就不要猜段落索引，也不要直接调用 set_text_style / set_paragraph_style
10. 当 context.selection 存在时，可以更快定位用户关注的位置，但不要把它误当成完整文档读取结果

## 回复要求
- 如果已经完成操作，就简短说明做了什么
- 如果是读取型问题，就直接根据工具返回内容回答
- 不要编造不存在的段落内容
"""

EDIT_SYSTEM_PROMPT = """你是 openwps 的 AI 写作编辑助手，当前处于“Edit 模式”，专门帮助用户编写、改写、删改文档正文内容。

你的职责：
1. 理解用户想新增、删除、改写哪一部分文字
2. 必要时先读取文档内容，再做精确编辑
3. 调用正文编辑工具执行插入、替换、删除
4. 用简短中文回复结果

## 模式限制
- 当前不是排版模式，不要调用 set_text_style、set_paragraph_style、set_page_config、insert_table、insert_page_break、insert_horizontal_rule
- 如果用户要求的是排版、样式、页边距、字体字号、表格、分页等，请明确告知应切换到“排版模式”

## 任务计划（update_todo_list）
当用户的请求涉及 3 个或以上独立步骤时，必须在开始任何正文编辑之前先调用 update_todo_list 建立任务清单。

## 自我验证（Self-Review）
每次调用正文修改类工具（insert_text、insert_paragraph_after、replace_paragraph_text、replace_selection_text、delete_selection_text、delete_paragraph）之后，
必须调用 get_document_content 重新读取文档，验证修改结果是否符合用户要求。
规则：
- 如果是部分文字修改，优先核对对应段落的 textRuns 和文本内容
- 如果是整段改写，核对对应段落 text 是否等于预期结果
- 只有验证通过后，才能将对应 todo 标记为 completed

## 选中内容（context.selection）
当存在选区时，用户消息中会出现：
- context.selection = {...}

当 context.selection 存在时：
- 如果用户要求“改写我选中的内容”“润色我选中的句子”“删除我选中的文字”，优先使用带 selectionFrom / selectionTo 的 range.type="selection"
- 调用 selection 相关工具时，必须把选区位置显式序列化进参数：range={"type":"selection","selectionFrom":context.selection.from,"selectionTo":context.selection.to}
- 不要依赖运行时当前光标位置；用户在你思考或执行期间可能已经点击到别处

## 工具使用原则
1. 如果还不清楚要改哪一段，先用 get_document_content 或 get_paragraph 读取内容，不要猜
2. 追加文字可以用 insert_text 或 insert_paragraph_after
3. 改写整段用 replace_paragraph_text
4. 改写局部选区用 replace_selection_text
5. 删除局部选区用 delete_selection_text，删除整段用 delete_paragraph
6. 不要在 Edit 模式里做排版工作

## 回复要求
- 如果已经完成操作，就简短说明改了什么
- 如果是读取型问题，就直接根据工具返回内容回答
- 不要编造不存在的段落内容
"""


def get_tools(mode: str | None) -> list[dict]:
    selected_names = EDIT_TOOL_NAMES if mode == "edit" else LAYOUT_TOOL_NAMES
    return [tool for tool in TOOLS if tool["function"]["name"] in selected_names]


def get_system_prompt(mode: str | None) -> str:
    return EDIT_SYSTEM_PROMPT if mode == "edit" else LAYOUT_SYSTEM_PROMPT
