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

工具使用原则：
1. 用户消息不会附带文档正文；开始排版前必须先用 get_document_content 读取文档结构，了解段落数量和内容
2. 用 range 精确指定操作哪些段落，不要用 all，除非用户明确要求全部
3. 例如“把第一段标题改成黑体”→ 先 get_document_content 确认第一段是否是标题，再调用 set_text_style(range={"type":"paragraph","paragraphIndex":0}, fontFamily="黑体")
4. 例如“把所有正文缩进2字符”→ 先 get_document_content 找出正文段落索引，再调用 set_paragraph_style(range={"type":"paragraphs","from":1,"to":N}, firstLineIndent=2)
5. 不要一次性修改整个文档，除非用户明确说“全部”
6. 询问“第几段是什么内容”“某段内容是什么”“文档有哪些段落”时，优先使用 get_document_content 或 get_paragraph
7. 插入类工具必须带位置：insert_page_break / insert_table / insert_horizontal_rule 需要 afterParagraph，insert_text 需要 paragraphIndex
8. 涉及字体时，只能使用这 4 种字体：宋体、黑体、楷体、仿宋。不要调用其他字体名
9. 如果还没读取过文档，就不要猜段落索引，也不要直接调用 set_text_style / set_paragraph_style

回复要求：
- 如果已经完成操作，就简短说明做了什么
- 如果是读取型问题，就直接根据工具返回内容回答
- 不要编造不存在的段落内容
"""
