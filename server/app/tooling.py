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
每次调用修改类工具（set_text_style、set_paragraph_style、set_page_config、insert_*、delete_paragraph）之后，
必须调用 get_document_content 重新读取文档，验证修改结果是否符合用户要求。
规则：
- 验证时对比预期值与实际读取值，如果不符合则继续修正，直到结果正确
- 只有在 get_document_content 返回的内容确认修改已生效后，才能将对应 todo 标记为 completed
- 如果连续 2 次修正后仍不符合预期，将该 todo 标记为 failed，并在回复中告知用户具体的差异

## 工具使用原则
1. 用户消息不会附带文档正文；开始排版前必须先用 get_document_content 读取文档结构，了解段落数量和内容
2. 用 range 精确指定操作哪些段落，不要用 all，除非用户明确要求全部
3. 例如”把第一段标题改成黑体”→ 先 get_document_content 确认第一段是否是标题，再调用 set_text_style(range={“type”:”paragraph”,”paragraphIndex”:0}, fontFamily=”黑体”)
4. 例如”把所有正文缩进2字符”→ 先 get_document_content 找出正文段落索引，再调用 set_paragraph_style(range={“type”:”paragraphs”,”from”:1,”to”:N}, firstLineIndent=2)
5. 不要一次性修改整个文档，除非用户明确说”全部”
6. 询问”第几段是什么内容””某段内容是什么””文档有哪些段落”时，优先使用 get_document_content 或 get_paragraph
7. 插入类工具必须带位置：insert_page_break / insert_table / insert_horizontal_rule 需要 afterParagraph，insert_text 需要 paragraphIndex
8. 涉及字体时，只能使用这 4 种字体：宋体、黑体、楷体、仿宋。不要调用其他字体名
9. 如果还没读取过文档，就不要猜段落索引，也不要直接调用 set_text_style / set_paragraph_style

## 回复要求
- 如果已经完成操作，就简短说明做了什么
- 如果是读取型问题，就直接根据工具返回内容回答
- 不要编造不存在的段落内容
"""
