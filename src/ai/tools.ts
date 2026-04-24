import { SUPPORTED_AI_FONT_NAMES } from '../fonts'

const detailParam = {
  type: 'string',
  enum: ['content', 'format'],
  description: "读取视图：content=只返回正文和粗略结构（标题层级启发、列表类型、任务勾选、图片占位、表格行列文字、超链接），不包含字体/字号/颜色/缩进/行距/textRuns/commonStyles；format=带完整格式详情，仅在排版阶段需要字号/对齐/缩进/行距/列表样式判断时使用。默认 content。",
} as const

const rangeProperties = {
  type: {
    type: 'string',
    enum: [
      'all',
      'paragraph',
      'paragraphs',
      'paragraph_indexes',
      'selection',
      'contains_text',
      'first_paragraph',
      'last_paragraph',
      'odd_paragraphs',
      'even_paragraphs',
    ],
  },
  paragraphIndex: { type: 'integer', description: '段落索引（range.type=paragraph 时使用）' },
  from: { type: 'integer', description: '起始段落索引（range.type=paragraphs 时使用）' },
  to: { type: 'integer', description: '结束段落索引（range.type=paragraphs 时使用，包含）' },
  paragraphIndexes: {
    type: 'array',
    description: '非连续段落索引列表（range.type=paragraph_indexes 时使用）',
    items: { type: 'integer' },
  },
  text: { type: 'string', description: '要匹配的文字（range.type=contains_text 时使用）' },
  selectionFrom: { type: 'integer', description: '选区起始文档位置（range.type=selection 时使用）' },
  selectionTo: { type: 'integer', description: '选区结束文档位置（range.type=selection 时使用）' },
} as const

const commonTools = [
  {
    name: 'get_document_info',
    description: '获取文档统计信息、分页信息和常见样式概览，适合先快速了解整篇文档结构',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_document_outline',
    description: '获取文档概览，返回每页涉及的段落范围、页面文字预览、常见样式签名。长文档时优先用它做导航，不要一开始就读取全文。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_document_content',
    description: '读取文档内容，可按段落范围分块返回；默认返回段落内容、段落样式、textRuns，以及该范围内的块级元素快照（含表格/分割线）。',
    parameters: {
      type: 'object',
      properties: {
        fromParagraph: { type: 'integer', description: '起始段落索引（包含），不传则从 0 开始' },
        toParagraph: { type: 'integer', description: '结束段落索引（包含），不传则到最后一段' },
        includeTextRuns: { type: 'boolean', description: '是否返回 textRuns，默认 true' },
      },
    },
  },
  {
    name: 'get_page_content',
    description: '读取指定页面的排版快照，返回该页涉及的段落、块级元素和逐行预览；表格会附带单元格文本快照。长文档或需要按页判断版式时优先使用。',
    parameters: {
      type: 'object',
      properties: {
        page: { type: 'integer', description: '页码，从 1 开始' },
        includeTextRuns: { type: 'boolean', description: '是否返回该页相关段落的 textRuns，默认 false' },
      },
      required: ['page'],
    },
  },
  {
    name: 'get_page_style_summary',
    description: '读取指定页面的样式摘要，返回该页每个段落的文字预览、样式签名、标题候选和常见样式统计。长文档排版时优先用它按页判断标题/正文是否混淆。',
    parameters: {
      type: 'object',
      properties: {
        page: { type: 'integer', description: '页码，从 1 开始' },
      },
      required: ['page'],
    },
  },
  {
    name: 'get_paragraph',
    description: '读取指定段落。默认 detail=content：只返回文字与粗略结构（role/headingLevel/list/inlineImages/links）；detail=format 时返回段落样式、代表文字样式、textRuns 等格式信息。',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: '段落索引（从 0 开始）' },
        detail: detailParam,
      },
      required: ['index'],
    },
  },
  {
    name: 'get_comments',
    description: '获取文档中所有批注，返回批注内容、作者、日期以及被批注文字所在的段落索引和具体文字',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
]

const taskTools = [
  {
    name: 'TaskCreate',
    description: '创建 AI 内部执行任务。仅用于复杂多步任务的内部追踪，不会向文档正文写入任务列表。',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: '任务标题，命令式短语，如“读取文档结构”' },
        description: { type: 'string', description: '任务详细说明，描述需要完成什么' },
        activeForm: { type: 'string', description: '任务进行中的描述，如“正在读取文档结构”' },
        metadata: { type: 'object', description: '附加元数据，可选' },
      },
      required: ['subject', 'description'],
    },
  },
  {
    name: 'TaskGet',
    description: '按任务 ID 读取 AI 内部任务详情，用于更新前先获取最新状态，避免 stale update。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务 ID' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'TaskList',
    description: '读取当前会话的全部 AI 内部任务摘要和状态。复杂任务中，完成一个任务后优先用它查看剩余任务。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'TaskUpdate',
    description: '更新 AI 内部任务。可修改状态、标题、描述、进行中描述、owner、依赖关系和 metadata。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务 ID' },
        subject: { type: 'string', description: '新的任务标题' },
        description: { type: 'string', description: '新的任务说明' },
        activeForm: { type: 'string', description: '新的进行中描述' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: '任务状态' },
        owner: { type: 'string', description: '任务 owner，可选' },
        addBlocks: {
          type: 'array',
          description: '当前任务完成后会解锁的任务 ID 列表',
          items: { type: 'string' },
        },
        addBlockedBy: {
          type: 'array',
          description: '会阻塞当前任务的任务 ID 列表',
          items: { type: 'string' },
        },
        metadata: { type: 'object', description: '要合并的元数据；键值设为 null 表示删除' },
      },
      required: ['taskId'],
    },
  },
] as const

export const layoutTools = [
  ...commonTools,
  {
    name: 'set_page_config',
    description: '设置页面配置（纸张大小、页边距、方向）',
    parameters: {
      type: 'object',
      properties: {
        paperSize: { type: 'string', enum: ['A4', 'A3', 'Letter', 'B5'], description: '纸张大小' },
        orientation: { type: 'string', enum: ['portrait', 'landscape'], description: '纵向或横向' },
        marginTop: { type: 'number', description: '上边距 mm' },
        marginBottom: { type: 'number', description: '下边距 mm' },
        marginLeft: { type: 'number', description: '左边距 mm' },
        marginRight: { type: 'number', description: '右边距 mm' },
      },
    },
  },
  {
    name: 'set_text_style',
    description: '设置指定范围内文字的样式（字体、字号、颜色、粗体、斜体等）',
    parameters: {
      type: 'object',
      properties: {
        range: { type: 'object', description: '操作范围', properties: rangeProperties },
        fontFamily: { type: 'string', enum: [...SUPPORTED_AI_FONT_NAMES], description: '字体名，支持宋体/黑体/楷体/仿宋/Arial/Times New Roman' },
        fontSize: { type: 'number', description: '字号（磅），如 12/16/22' },
        color: { type: 'string', description: '文字颜色 hex，如 #FF0000' },
        backgroundColor: { type: 'string', description: '文字背景色 hex' },
        bold: { type: 'boolean', description: '加粗' },
        italic: { type: 'boolean', description: '斜体' },
        underline: { type: 'boolean', description: '下划线' },
        strikethrough: { type: 'boolean', description: '删除线' },
        superscript: { type: 'boolean', description: '上标' },
        subscript: { type: 'boolean', description: '下标' },
        letterSpacing: { type: 'number', description: '字间距（磅）' },
      },
      required: ['range'],
    },
  },
  {
    name: 'set_paragraph_style',
    description: '设置指定范围段落的格式（对齐、缩进、行距、间距、列表/任务列表）',
    parameters: {
      type: 'object',
      properties: {
        range: { type: 'object', description: '操作范围', properties: rangeProperties },
        align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
        firstLineIndent: { type: 'number', description: '首行缩进（字符数，如 2 表示缩进2字）' },
        indent: { type: 'number', description: '整体左缩进（字符数）' },
        headingLevel: { type: 'integer', enum: [0, 1, 2, 3, 4, 5, 6], description: '真实 Word 标题级别。1-6 对应 Heading 1-6；0 表示普通正文。生成目录前必须给章节标题设置 headingLevel。' },
        lineHeight: { type: 'number', description: '行距倍数，如 1.0/1.5/2.0' },
        spaceBefore: { type: 'number', description: '段前间距（磅）' },
        spaceAfter: { type: 'number', description: '段后间距（磅）' },
        listType: { type: 'string', enum: ['none', 'bullet', 'ordered', 'task'], description: '列表类型，task 表示任务列表/待办列表' },
        listChecked: { type: 'boolean', description: '仅任务列表有效，true 为已勾选，false 为未勾选' },
        pageBreakBefore: { type: 'boolean', description: '是否在该段前分页，对应工具栏里的分页符开关' },
      },
      required: ['range'],
    },
  },
  {
    name: 'clear_formatting',
    description: '清除指定范围内的排版格式，对应工具栏“清除格式”。默认同时清除文字样式和段落格式。',
    parameters: {
      type: 'object',
      properties: {
        range: { type: 'object', description: '操作范围', properties: rangeProperties },
        clearTextStyles: { type: 'boolean', description: '是否清除字体、字号、颜色、粗斜体等文字样式，默认 true' },
        clearParagraphStyles: { type: 'boolean', description: '是否清除对齐、缩进、行距、段前段后、列表、分页等段落格式，默认 true' },
      },
      required: ['range'],
    },
  },
  {
    name: 'insert_page_break',
    description: '在指定段落后插入分页符',
    parameters: {
      type: 'object',
      properties: {
        afterParagraph: { type: 'integer', description: '在该段落后插入分页符' },
      },
      required: ['afterParagraph'],
    },
  },
  {
    name: 'insert_horizontal_rule',
    description: '在指定段落后插入水平分割线',
    parameters: {
      type: 'object',
      properties: {
        afterParagraph: { type: 'integer', description: '在该段落后插入分割线' },
      },
      required: ['afterParagraph'],
    },
  },
  {
    name: 'insert_table_of_contents',
    description: '插入真正的 Word/DOCX 自动目录字段，而不是用正文模拟点线和页码。使用前应先把章节标题段落设置 headingLevel；导出 DOCX 后可在 Word/WPS 中更新域得到真实页码。',
    parameters: {
      type: 'object',
      properties: {
        afterParagraph: { type: 'integer', description: '在该段落后插入目录；-1 表示插到文档开头' },
        title: { type: 'string', description: '目录标题，默认“目录”' },
        minLevel: { type: 'integer', minimum: 1, maximum: 6, description: '包含的最小标题级别，默认 1' },
        maxLevel: { type: 'integer', minimum: 1, maximum: 6, description: '包含的最大标题级别，默认 3' },
        hyperlink: { type: 'boolean', description: '是否生成可点击超链接，默认 true' },
      },
    },
  },
  {
    name: 'insert_table',
    description: '在指定位置插入表格；可直接用 data 二维数组一次写入表头和单元格内容，避免先插空表再逐格补内容。',
    parameters: {
      type: 'object',
      properties: {
        afterParagraph: { type: 'integer', description: '在该段落后插入表格' },
        rows: { type: 'integer', minimum: 1, maximum: 20 },
        cols: { type: 'integer', minimum: 1, maximum: 10 },
        headerRow: { type: 'boolean', description: '是否有表头行' },
        data: {
          type: 'array',
          description: '表格二维文本数据。若提供，将优先按 data 的尺寸创建并填充表格。',
          items: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
      required: ['afterParagraph'],
    },
  },
  {
    name: 'insert_table_row_before',
    description: '在当前光标所在表格单元格的上方插入一行。要求当前光标在表格中。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'insert_table_row_after',
    description: '在当前光标所在表格单元格的下方插入一行。要求当前光标在表格中。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'delete_table_row',
    description: '删除当前光标所在表格单元格对应的整行。要求当前光标在表格中。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'insert_table_column_before',
    description: '在当前光标所在表格单元格的左侧插入一列。要求当前光标在表格中。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'insert_table_column_after',
    description: '在当前光标所在表格单元格的右侧插入一列。要求当前光标在表格中。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'delete_table_column',
    description: '删除当前光标所在表格单元格对应的整列。要求当前光标在表格中。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'apply_style_batch',
    description: '批量应用样式规则。一次调用可同时设置多个段落范围的文字样式和段落格式，适合全文排版、按角色（标题/正文/副标题/待办项）分别设置样式。返回值包含受影响段落的快照，无需额外调用 get_document_content 验证。',
    parameters: {
      type: 'object',
      properties: {
        rules: {
          type: 'array',
          description: '样式规则列表，按顺序执行',
          items: {
            type: 'object',
            properties: {
              range: { type: 'object', description: '操作范围', properties: rangeProperties },
              textStyle: {
                type: 'object',
                description: '文字样式',
                properties: {
                  fontFamily: { type: 'string', enum: [...SUPPORTED_AI_FONT_NAMES] },
                  fontSize: { type: 'number' },
                  color: { type: 'string' },
                  backgroundColor: { type: 'string' },
                  bold: { type: 'boolean' },
                  italic: { type: 'boolean' },
                  underline: { type: 'boolean' },
                  strikethrough: { type: 'boolean' },
                  superscript: { type: 'boolean' },
                  subscript: { type: 'boolean' },
                  letterSpacing: { type: 'number' },
                },
              },
              paragraphStyle: {
                type: 'object',
                description: '段落格式',
                properties: {
                  align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
                  firstLineIndent: { type: 'number' },
                  indent: { type: 'number' },
                  headingLevel: { type: 'integer', enum: [0, 1, 2, 3, 4, 5, 6], description: '真实 Word 标题级别；生成自动目录时用 1-6，正文用 0' },
                  lineHeight: { type: 'number' },
                  spaceBefore: { type: 'number' },
                  spaceAfter: { type: 'number' },
                  listType: { type: 'string', enum: ['none', 'bullet', 'ordered', 'task'] },
                  listChecked: { type: 'boolean' },
                  pageBreakBefore: { type: 'boolean' },
                },
              },
            },
            required: ['range'],
          },
        },
      },
      required: ['rules'],
    },
  },
]

export const editTools = [
  {
    name: 'insert_image',
    description: '将一张已有图片（通过 src URL / data URL）插入到正文中。注意：此工具只能插入已有 URL 的图片，不能用于生成图表。要插入流程图/时序图/思维导图等图表，请使用 insert_mermaid。',
    parameters: {
      type: 'object',
      properties: {
        src: { type: 'string', description: '图片 URL 或 data URL（data:image/svg+xml;base64,...）' },
        alt: { type: 'string', description: '图片描述文字，可选' },
        afterParagraph: { type: 'integer', description: '在该段后插入图片；不传则追加到文档末尾' },
      },
      required: ['src'],
    },
  },
  {
    name: 'insert_mermaid',
    description: '将 Mermaid 图表代码渲染为 SVG 图片并插入到正文中。当需要插入流程图、时序图、类图、甘特图、思维导图、关系图等图表时，使用此工具而非 insert_image。前端会自动将 Mermaid 代码渲染为 SVG 图片并插入文档。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Mermaid 图表代码，如 "graph TD; A-->B" 或 "sequenceDiagram; participant A"' },
        alt: { type: 'string', description: '图表描述文字，可选，如 "Transformer 架构思维导图"' },
        afterParagraph: { type: 'integer', description: '在该段后插入图表；不传则追加到文档末尾' },
      },
      required: ['code'],
    },
  },
  {
    name: 'begin_streaming_write',
    description: '开始一次流式正文写入。先声明写入位置，然后把真正要写入文档的 Markdown 正文作为后续 assistant 文本直接输出，前端会实时解析并写入文档。适合新增长段落、表格、分割线或整体改写整段。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['insert_after_paragraph', 'replace_paragraph'],
          description: 'insert_after_paragraph=在指定段落后新增正文；replace_paragraph=整体改写指定段落',
        },
        afterParagraph: { type: 'integer', description: 'action=insert_after_paragraph 时，在该段后开始流式写入' },
        paragraphIndex: { type: 'integer', description: 'action=replace_paragraph 时，整体改写该段' },
      },
      required: ['action'],
    },
  },
  {
    name: 'insert_text',
    description: '在指定段落末尾插入文字',
    parameters: {
      type: 'object',
      properties: {
        paragraphIndex: { type: 'integer' },
        text: { type: 'string', description: '要插入的文字内容' },
      },
      required: ['paragraphIndex', 'text'],
    },
  },
  {
    name: 'insert_paragraph_after',
    description: '在指定段落后插入一个新段落并写入文字',
    parameters: {
      type: 'object',
      properties: {
        afterParagraph: { type: 'integer', description: '在该段后插入新段落' },
        text: { type: 'string', description: '新段落文字内容' },
      },
      required: ['afterParagraph', 'text'],
    },
  },
  {
    name: 'replace_paragraph_text',
    description: '用新文字整体替换指定段落的内容',
    parameters: {
      type: 'object',
      properties: {
        paragraphIndex: { type: 'integer', description: '要替换的段落索引' },
        text: { type: 'string', description: '替换后的完整段落内容' },
      },
      required: ['paragraphIndex', 'text'],
    },
  },
  {
    name: 'replace_selection_text',
    description: '用新文字替换当前选区内容',
    parameters: {
      type: 'object',
      properties: {
        range: { type: 'object', description: '必须为 selection 范围', properties: rangeProperties },
        text: { type: 'string', description: '替换后的文字内容' },
      },
      required: ['range', 'text'],
    },
  },
  {
    name: 'delete_selection_text',
    description: '删除当前选区文字',
    parameters: {
      type: 'object',
      properties: {
        range: { type: 'object', description: '必须为 selection 范围', properties: rangeProperties },
      },
      required: ['range'],
    },
  },
  {
    name: 'delete_paragraph',
    description: '删除一个或多个整段。删除多段时优先一次传 indices，避免逐段重复调用。',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: '段落索引' },
        indices: {
          type: 'array',
          description: '要删除的多个段落索引，会按从大到小一次删除',
          items: { type: 'integer' },
        },
      },
    },
  },
  ...commonTools,
]

const ocrTool = {
  name: 'analyze_image_with_ocr',
  description: '对当前轮上传的图片执行 OCR 专项识别。适合表格、图表、手写、公式、扫描件文字提取等任务；返回结构化结果，供 agent 再决定写作、插表或总结。',
  parameters: {
    type: 'object',
    properties: {
      taskType: {
        type: 'string',
        enum: ['general_parse', 'document_text', 'table', 'chart', 'handwriting', 'formula'],
        description: 'OCR 任务类型。表格识别用 table，图表解析用 chart，手写识别用 handwriting，公式识别用 formula。',
      },
      imageIndices: {
        type: 'array',
        description: '要识别的图片索引列表，从 1 开始；不传则处理当前轮所有图片。',
        items: { type: 'integer' },
      },
      instruction: {
        type: 'string',
        description: '附加说明，例如“只提取表格内容，不要解释图片背景”。',
      },
    },
  },
} as const

const workspaceSearchTool = {
  name: 'workspace_search',
  description: '在用户上传的工作区参考文档中搜索关键词。返回所有文档中包含该关键词的片段及上下文。多个关键词用空格分隔，采用AND逻辑。用于在写文档时查找参考资料、数据、法规条款等。',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索关键词，多个词用空格分隔（AND逻辑）',
      },
      doc_id: {
        type: 'string',
        description: '可选，限定在指定文档中搜索。不提供则搜索所有工作区文档',
      },
      context_lines: {
        type: 'integer',
        description: '搜索结果上下文行数，默认3',
      },
    },
  },
} as const

const workspaceReadTool = {
  name: 'workspace_read',
  description: '读取工作区中某个参考文档的完整内容或指定行范围的内容。用于详细查看某篇参考文档的内容。',
  parameters: {
    type: 'object',
    properties: {
      doc_id: {
        type: 'string',
        description: '文档ID（从workspace_search结果或工作区文档列表中获取）',
      },
      from_line: {
        type: 'integer',
        description: '起始行号（从0开始），不提供则从0开始',
      },
      to_line: {
        type: 'integer',
        description: '结束行号（包含），不提供则读到末尾',
      },
    },
  },
} as const

export const agentTools = [...taskTools, ...layoutTools, ...editTools, ocrTool, workspaceSearchTool, workspaceReadTool].filter(
  (tool, index, list) => list.findIndex(item => item.name === tool.name) === index,
)
