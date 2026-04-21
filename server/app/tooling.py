from __future__ import annotations

SUPPORTED_AI_FONTS = ["宋体", "黑体", "楷体", "仿宋", "Arial", "Times New Roman"]

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
                "paragraph_indexes",
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
        "paragraphIndexes": {
            "type": "array",
            "description": "非连续段落索引列表（range.type=paragraph_indexes 时使用）",
            "items": {"type": "integer"},
        },
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
                "确保始终至少有一个任务处于 in_progress 状态。"
                "为每个任务同时提供 title（命令式，如'读取文档'）和 activeForm（进行时，如'正在读取文档'）。"
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
                                    "description": "任务标题，命令式描述，如 '读取文档内容'",
                                },
                                "activeForm": {
                                    "type": "string",
                                    "description": "任务的进行时描述，如 '正在读取文档内容'",
                                },
                                "status": {
                                    "type": "string",
                                    "enum": ["pending", "in_progress", "completed"],
                                    "description": "pending=待执行, in_progress=进行中, completed=已完成",
                                },
                            },
                            "required": ["id", "title", "activeForm", "status"],
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
            "name": "get_todo_list",
            "description": "读取当前任务计划列表和各步骤状态，适合在继续执行前、收尾前或怀疑状态不同步时确认 todo 进度。",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_document_info",
            "description": "获取文档统计信息、分页信息和常见样式概览，适合先快速了解整篇文档结构",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_document_outline",
            "description": "获取文档概览，返回每页涉及的段落范围、页面文字预览、常见样式签名。长文档时优先用它做导航，不要一开始就读取全文。",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_document_content",
            "description": "读取文档内容，可按段落范围分块返回；默认返回段落内容、段落样式、textRuns，以及该范围内的块级元素快照（含表格/分割线）。",
            "parameters": {
                "type": "object",
                "properties": {
                    "fromParagraph": {"type": "integer", "description": "起始段落索引（包含），不传则从 0 开始"},
                    "toParagraph": {"type": "integer", "description": "结束段落索引（包含），不传则到最后一段"},
                    "includeTextRuns": {"type": "boolean", "description": "是否返回 textRuns，默认 true"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_page_content",
            "description": "读取指定页面的排版快照，返回该页涉及的段落、块级元素和逐行预览；表格会附带单元格文本快照。长文档或需要按页判断版式时优先使用。",
            "parameters": {
                "type": "object",
                "properties": {
                    "page": {"type": "integer", "description": "页码，从 1 开始"},
                    "includeTextRuns": {"type": "boolean", "description": "是否返回该页相关段落的 textRuns，默认 false"},
                },
                "required": ["page"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_page_style_summary",
            "description": "读取指定页面的样式摘要，返回该页每个段落的文字预览、样式签名、标题候选和常见样式统计。长文档排版时优先用它按页判断标题/正文是否混淆。",
            "parameters": {
                "type": "object",
                "properties": {
                    "page": {"type": "integer", "description": "页码，从 1 开始"},
                },
                "required": ["page"],
            },
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
            "name": "get_comments",
            "description": "获取文档中所有批注，返回批注内容、作者、日期以及被批注文字所在的段落索引和具体文字",
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "analyze_image_with_ocr",
            "description": (
                "对当前轮上传的图片执行 OCR 专项识别。适合表格、图表、手写、公式、扫描件文字提取等任务；"
                "返回结构化结果，供 agent 再决定后续写作、插表或总结。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "taskType": {
                        "type": "string",
                        "enum": ["general_parse", "document_text", "table", "chart", "handwriting", "formula"],
                        "description": "OCR 任务类型。表格识别用 table，图表解析用 chart，手写识别用 handwriting，公式识别用 formula。",
                    },
                    "imageIndices": {
                        "type": "array",
                        "description": "要识别的图片索引列表，从 1 开始；不传则处理当前轮所有图片。",
                        "items": {"type": "integer"},
                    },
                    "instruction": {
                        "type": "string",
                        "description": "附加说明，例如“只提取表格内容，不要解释图片背景”。",
                    },
                },
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
                    "fontFamily": {"type": "string", "enum": SUPPORTED_AI_FONTS, "description": "字体名，支持宋体/黑体/楷体/仿宋/Arial/Times New Roman"},
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
                    "pageBreakBefore": {"type": "boolean", "description": "是否在该段前分页，对应工具栏里的分页符开关"},
                },
                "required": ["range"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "clear_formatting",
            "description": "清除指定范围内的排版格式，对应工具栏“清除格式”。默认同时清除文字样式和段落格式。",
            "parameters": {
                "type": "object",
                "properties": {
                    "range": RANGE_SPEC,
                    "clearTextStyles": {"type": "boolean", "description": "是否清除字体、字号、颜色、粗斜体等文字样式，默认 true"},
                    "clearParagraphStyles": {"type": "boolean", "description": "是否清除对齐、缩进、行距、段前段后、列表、分页等段落格式，默认 true"},
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
            "description": "在指定位置插入表格；可直接用 data 二维数组一次写入表头和单元格内容，避免先插空表再逐格补内容。",
            "parameters": {
                "type": "object",
                "properties": {
                    "afterParagraph": {"type": "integer", "description": "在该段落后插入表格"},
                    "rows": {"type": "integer", "minimum": 1, "maximum": 20},
                    "cols": {"type": "integer", "minimum": 1, "maximum": 10},
                    "headerRow": {"type": "boolean"},
                    "data": {
                        "type": "array",
                        "description": "表格二维文本数据。若提供，将优先按 data 的尺寸创建并填充表格。",
                        "items": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                    },
                },
                "required": ["afterParagraph"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "begin_streaming_write",
            "description": "开始一次流式正文写入。先声明写入位置，然后把真正要写入文档的 Markdown 正文作为后续 assistant 文本直接输出，前端会实时解析并写入文档。适合新增长段落、表格、分割线或整体改写整段。",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["insert_after_paragraph", "replace_paragraph"],
                        "description": "insert_after_paragraph=在指定段落后新增正文；replace_paragraph=整体改写指定段落",
                    },
                    "afterParagraph": {"type": "integer", "description": "action=insert_after_paragraph 时，在该段后开始流式写入"},
                    "paragraphIndex": {"type": "integer", "description": "action=replace_paragraph 时，整体改写该段"},
                },
                "required": ["action"],
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
            "description": "删除一个或多个整段。删除多段时优先一次传 indices，避免逐段重复调用。",
            "parameters": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer", "description": "段落索引"},
                    "indices": {
                        "type": "array",
                        "description": "要删除的多个段落索引。会按从大到小一次删除，避免索引漂移。",
                        "items": {"type": "integer"},
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "apply_style_batch",
            "description": (
                "批量应用样式规则。一次调用可同时设置多个段落范围的文字样式和段落格式，"
                "适合全文排版、按角色（标题/正文/副标题）分别设置样式。"
                "每条规则可同时包含 textStyle 和 paragraphStyle，也可只包含其一。"
                "返回值包含受影响段落的快照，无需额外调用 get_document_content 验证。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "rules": {
                        "type": "array",
                        "description": "样式规则列表，按顺序执行",
                        "items": {
                            "type": "object",
                            "properties": {
                                "range": RANGE_SPEC,
                                "textStyle": {
                                    "type": "object",
                                    "description": "文字样式",
                                    "properties": {
                                        "fontFamily": {"type": "string", "enum": SUPPORTED_AI_FONTS},
                                        "fontSize": {"type": "number"},
                                        "color": {"type": "string"},
                                        "backgroundColor": {"type": "string"},
                                        "bold": {"type": "boolean"},
                                        "italic": {"type": "boolean"},
                                        "underline": {"type": "boolean"},
                                        "strikethrough": {"type": "boolean"},
                                        "superscript": {"type": "boolean"},
                                        "subscript": {"type": "boolean"},
                                        "letterSpacing": {"type": "number"},
                                    },
                                },
                                "paragraphStyle": {
                                    "type": "object",
                                    "description": "段落格式",
                                    "properties": {
                                        "align": {"type": "string", "enum": ["left", "center", "right", "justify"]},
                                        "firstLineIndent": {"type": "number"},
                                        "indent": {"type": "number"},
                                        "lineHeight": {"type": "number"},
                                        "spaceBefore": {"type": "number"},
                                        "spaceAfter": {"type": "number"},
                                        "listType": {"type": "string", "enum": ["none", "bullet", "ordered"]},
                                        "pageBreakBefore": {"type": "boolean"},
                                    },
                                },
                            },
                            "required": ["range"],
                        },
                    },
                },
                "required": ["rules"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "apply_document_preset",
            "description": (
                "应用文档预设模板（公文/论文/合同/报告/信函），一次性设置页面配置和全文样式。"
                "会自动识别标题段落（短文本+居中/加粗/大字号）和正文段落，分别应用对应样式。"
                "返回值包含受影响段落的快照，无需额外验证。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "preset": {
                        "type": "string",
                        "enum": ["公文", "论文", "合同", "报告", "信函"],
                        "description": "预设名称",
                    },
                    "applyPageConfig": {
                        "type": "boolean",
                        "description": "是否同时应用页面配置（纸张/边距），默认 true",
                    },
                },
                "required": ["preset"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "insert_image",
            "description": (
                "将一张图片（通过 src URL 或 data URL）插入到正文中。"
                "src 必须是有效的 URL 或 data:image/... 格式的 data URL。"
                "注意：此工具只能插入已有 URL 的图片，不能用于生成图表。"
                "要插入流程图/时序图/思维导图等图表，请使用 insert_mermaid 工具。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "src": {
                        "type": "string",
                        "description": "图片 URL 或 data URL（如 data:image/svg+xml;base64,...）",
                    },
                    "alt": {
                        "type": "string",
                        "description": "图片描述文字，可选",
                    },
                    "afterParagraph": {
                        "type": "integer",
                        "description": "在该段落后插入图片；不传或传 -1 则追加到文档末尾",
                    },
                },
                "required": ["src"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "insert_mermaid",
            "description": (
                "将 Mermaid 图表代码渲染为图片并插入到正文中。"
                "当需要插入流程图、时序图、类图、甘特图、思维导图、关系图等图表时，"
                "使用此工具而非 insert_image。前端会自动将 Mermaid 代码渲染为 SVG 图片并插入文档。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "Mermaid 图表代码，如 'graph TD; A-->B' 或 'sequenceDiagram; participant A'",
                    },
                    "alt": {
                        "type": "string",
                        "description": "图表描述文字，可选，如 'Transformer 架构思维导图'",
                    },
                    "afterParagraph": {
                        "type": "integer",
                        "description": "在该段落后插入图表；不传或传 -1 则追加到文档末尾",
                    },
                },
                "required": ["code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "workspace_search",
            "description": (
                "在用户上传的工作区参考文档中搜索关键词。返回所有文档中包含该关键词的片段及上下文。"
                "多个关键词用空格分隔，采用AND逻辑（所有关键词都需匹配）。"
                "用于在写文档时查找参考资料、数据、法规条款等。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "搜索关键词，多个词用空格分隔（AND逻辑）",
                    },
                    "doc_id": {
                        "type": "string",
                        "description": "可选，限定在指定文档中搜索。不提供则搜索所有工作区文档",
                    },
                    "context_lines": {
                        "type": "integer",
                        "description": "搜索结果上下文行数，默认3",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": (
                "使用 Tavily 执行联网搜索，获取最新网页、新闻和外部资料。"
                "当问题依赖实时信息、公开网页或工作区外部知识时使用；"
                "如果当前工作区文档已经足够回答，就优先使用 workspace_search / workspace_read。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "搜索关键词或问题，尽量具体，适合直接在网页上检索。",
                    },
                    "topic": {
                        "type": "string",
                        "enum": ["general", "news", "finance"],
                        "description": "搜索主题，默认 general；新闻可选 news。",
                    },
                    "searchDepth": {
                        "type": "string",
                        "enum": ["basic", "advanced"],
                        "description": "搜索深度，basic 更快更省，advanced 更重更详细。",
                    },
                    "maxResults": {
                        "type": "integer",
                        "description": "返回结果数量，建议 1-10，默认 5。",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "workspace_read",
            "description": (
                "读取工作区中某个参考文档的完整内容或指定行范围的内容。"
                "用于详细查看某篇参考文档的内容。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "doc_id": {
                        "type": "string",
                        "description": "文档ID（从workspace_search结果或工作区文档列表中获取）",
                    },
                    "from_line": {
                        "type": "integer",
                        "description": "起始行号（从0开始），不提供则从0开始",
                    },
                    "to_line": {
                        "type": "integer",
                        "description": "结束行号（包含），不提供则读到末尾",
                    },
                },
                "required": ["doc_id"],
            },
        },
    },
]

LAYOUT_TOOL_NAMES = {
    "update_todo_list",
    "get_todo_list",
    "get_document_info",
    "get_document_outline",
    "get_document_content",
    "get_page_content",
    "get_page_style_summary",
    "get_paragraph",
    "get_comments",
    "set_text_style",
    "set_paragraph_style",
    "clear_formatting",
    "set_page_config",
    "insert_page_break",
    "insert_horizontal_rule",
    "insert_table",
    "apply_style_batch",
    "apply_document_preset",
}

EDIT_TOOL_NAMES = {
    "update_todo_list",
    "get_todo_list",
    "get_document_info",
    "get_document_outline",
    "get_document_content",
    "get_page_content",
    "get_page_style_summary",
    "get_paragraph",
    "get_comments",
    "begin_streaming_write",
    "insert_text",
    "insert_paragraph_after",
    "replace_paragraph_text",
    "replace_selection_text",
    "delete_selection_text",
    "delete_paragraph",
    "insert_image",
    "insert_mermaid",
}

AGENT_TOOL_NAMES = LAYOUT_TOOL_NAMES | EDIT_TOOL_NAMES | {"analyze_image_with_ocr", "workspace_search", "workspace_read", "web_search"}

def get_tools(mode: str | None) -> list[dict]:
    if mode == "edit":
        selected_names = EDIT_TOOL_NAMES
    elif mode == "agent":
        selected_names = AGENT_TOOL_NAMES
    else:
        selected_names = LAYOUT_TOOL_NAMES
    return [tool for tool in TOOLS if tool["function"]["name"] in selected_names]
