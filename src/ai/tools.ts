import { SUPPORTED_AI_FONT_NAMES } from '../fonts'

const detailParam = {
  type: 'string',
  enum: ['content', 'format'],
  description: "读取视图：content=只返回正文和粗略结构（标题层级启发、列表类型、任务勾选、图片占位、表格行列文字、超链接），不包含字体/字号/颜色/缩进/行距/textRuns/commonStyles；format=仅用于单段局部排查。需要页级样式详情时使用 get_page_style_summary(page=N)。默认 content。",
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
      'text_ranges',
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
  text: {
    type: 'string',
    description: '要匹配的文字（range.type=contains_text 时使用）。set_text_style 会只作用于匹配到的文字片段；set_paragraph_style 才会作用于包含该文字的整段。',
  },
  textOccurrence: {
    type: 'string',
    enum: ['all', 'first'],
    description: '匹配次数（range.type=contains_text 时使用）：all=全部匹配，first=只匹配第一个。默认 all。',
  },
  occurrenceIndexes: {
    type: 'array',
    description: '按 search_text 返回的 matchIndex 精确选择匹配项（range.type=contains_text 时使用）。例如 [0,2] 只修改第 1 和第 3 处。',
    items: { type: 'integer' },
  },
  caseSensitive: {
    type: 'boolean',
    description: '匹配文字时是否区分大小写，默认 false；false 表示包容大小写差异。',
  },
  matchMode: {
    type: 'string',
    enum: ['contains', 'exact'],
    description: '匹配模式：contains=子串匹配；exact=精确词/短语匹配，要求匹配项两侧不是字母、数字、下划线或中文字符。默认 contains。',
  },
  textRanges: {
    type: 'array',
    description: '精确锁定文字范围（range.type=text_ranges 时使用），通常直接使用 search_text 返回的 range/lockedRange，避免偏移漂移。',
    items: {
      type: 'object',
      properties: {
        paragraphIndex: { type: 'integer', description: '段落索引' },
        startOffset: { type: 'integer', description: '段内起始字符偏移，包含' },
        endOffset: { type: 'integer', description: '段内结束字符偏移，不包含' },
        text: { type: 'string', description: '该范围当前应匹配的文字；提供后会校验，防止坐标过期误改' },
      },
      required: ['paragraphIndex', 'startOffset', 'endOffset'],
    },
  },
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
    description: '按段落范围读取文档正文和粗略结构。',
    parameters: {
      type: 'object',
      properties: {
        fromParagraph: { type: 'integer', description: '起始段落索引（包含），不传则从 0 开始' },
        toParagraph: { type: 'integer', description: '结束段落索引（包含），不传则到最后一段' },
      },
    },
  },
  {
    name: 'get_page_content',
    description: '读取指定页面的紧凑文字结构，只返回页内段落/表格/图片占位等文章结构和具体文字内容，不返回逐行布局、样式明细、textRuns 或图片 dataUrl。需要检查字号/对齐/缩进等格式时改用 get_page_style_summary。',
    parameters: {
      type: 'object',
      properties: {
        page: { type: 'integer', description: '页码，从 1 开始' },
      },
      required: ['page'],
    },
  },
  {
    name: 'capture_page_screenshot',
    description: '截取指定正文页的当前可见页面截图，并把截图作为多模态图片交给模型查看。适合校验分页、图文混排、遮挡、重叠、表格/图片附近视觉效果。',
    parameters: {
      type: 'object',
      properties: {
        page: { type: 'integer', description: '页码，从 1 开始' },
        instruction: { type: 'string', description: '本页截图需要重点检查的问题，可选' },
      },
      required: ['page'],
    },
  },
  {
    name: 'get_page_style_summary',
    description: '读取指定单页的样式摘要，返回该页段落文字预览、代表字体/字号/对齐/缩进/行距、标题候选和常见样式统计。该工具是唯一可返回详细样式的读取工具；一次只能读取一页。多页排版分析请让 layout-plan/verification 子代理并行按页分析，不要由主 Agent 连续调用多页。',
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
    name: 'search_text',
    description: '在当前文档正文中搜索文字，返回可直接用于 set_text_style/clear_formatting 的精确锁定 range。支持大小写包容、区分大小写、子串匹配和精确词/短语匹配。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要搜索的文字' },
        caseSensitive: { type: 'boolean', description: '是否区分大小写，默认 false；false 表示包容大小写差异' },
        matchMode: {
          type: 'string',
          enum: ['contains', 'exact'],
          description: 'contains=子串匹配；exact=精确词/短语匹配，要求匹配项两侧不是字母、数字、下划线或中文字符。默认 contains。',
        },
        paragraphIndex: { type: 'integer', description: '只搜索指定段落，可选' },
        fromParagraph: { type: 'integer', description: '搜索起始段落索引（包含），可选' },
        toParagraph: { type: 'integer', description: '搜索结束段落索引（包含），可选' },
        paragraphIndexes: {
          type: 'array',
          description: '只搜索这些段落索引，可选',
          items: { type: 'integer' },
        },
        maxResults: { type: 'integer', description: '最多返回多少条匹配详情，默认 80，最大 200' },
      },
      required: ['text'],
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
    description: '设置指定范围内文字的样式（字体、字号、颜色、粗体、斜体等）。当 range.type=contains_text 时，只修改匹配到的文字本身，不修改整段。',
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
    description: '在指定表格的指定行上方插入一行。tableIndex/rowIndex 来自读取工具返回的表格结构。',
    parameters: { type: 'object', properties: { tableIndex: { type: 'integer' }, rowIndex: { type: 'integer' } }, required: ['tableIndex', 'rowIndex'] },
  },
  {
    name: 'insert_table_row_after',
    description: '在指定表格的指定行下方插入一行。tableIndex/rowIndex 来自读取工具返回的表格结构。',
    parameters: { type: 'object', properties: { tableIndex: { type: 'integer' }, rowIndex: { type: 'integer' } }, required: ['tableIndex', 'rowIndex'] },
  },
  {
    name: 'delete_table_row',
    description: '删除指定表格的指定整行。tableIndex/rowIndex 来自读取工具返回的表格结构。',
    parameters: { type: 'object', properties: { tableIndex: { type: 'integer' }, rowIndex: { type: 'integer' } }, required: ['tableIndex', 'rowIndex'] },
  },
  {
    name: 'insert_table_column_before',
    description: '在指定表格的指定列左侧插入一列。tableIndex/columnIndex 来自读取工具返回的表格结构。',
    parameters: { type: 'object', properties: { tableIndex: { type: 'integer' }, columnIndex: { type: 'integer' } }, required: ['tableIndex', 'columnIndex'] },
  },
  {
    name: 'insert_table_column_after',
    description: '在指定表格的指定列右侧插入一列。tableIndex/columnIndex 来自读取工具返回的表格结构。',
    parameters: { type: 'object', properties: { tableIndex: { type: 'integer' }, columnIndex: { type: 'integer' } }, required: ['tableIndex', 'columnIndex'] },
  },
  {
    name: 'delete_table_column',
    description: '删除指定表格的指定整列。tableIndex/columnIndex 来自读取工具返回的表格结构。',
    parameters: { type: 'object', properties: { tableIndex: { type: 'integer' }, columnIndex: { type: 'integer' } }, required: ['tableIndex', 'columnIndex'] },
  },
  {
    name: 'delete_table',
    description: '删除指定的整个表格。先用读取工具确认 tableIndex，再传入 tableIndex。',
    parameters: {
      type: 'object',
      properties: {
        tableIndex: { type: 'integer', description: '要删除的表格索引，从 0 开始' },
      },
      required: ['tableIndex'],
    },
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
    description: '一次性写入后端权威 Markdown 正文。必须把完整正文放在 markdown 参数中；不要先声明位置后再把侧边栏回复当正文输出。适合新增长段落、表格、分割线或整体改写整段。',
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
        markdown: { type: 'string', description: '必填。要写入文档的完整 Markdown 正文。' },
      },
      required: ['action', 'markdown'],
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

const documentImageAnalysisTool = {
  name: 'analyze_document_image',
  description: '分析当前文档内的图片。可按 imageId 或 paragraphIndex+imageIndex 定位；auto 会根据图片和上下文选择多模态、OCR 或两者结合。',
  parameters: {
    type: 'object',
    properties: {
      imageId: { type: 'string', description: '文档读取工具返回的稳定图片 ID。' },
      paragraphIndex: { type: 'integer', description: '图片所在段落索引；未提供 imageId 时使用。' },
      imageIndex: { type: 'integer', description: '段内图片序号，从 0 开始；未提供 imageId 时使用。' },
      analysisMode: {
        type: 'string',
        enum: ['auto', 'multimodal', 'ocr', 'both'],
        description: '分析路径，默认 auto。',
      },
      taskType: {
        type: 'string',
        enum: ['general_parse', 'document_text', 'table', 'chart', 'handwriting', 'formula'],
        description: 'OCR 任务类型，analysisMode 为 ocr/both 或 auto 选择 OCR 时使用。',
      },
      instruction: {
        type: 'string',
        description: '附加分析说明。',
      },
    },
  },
} as const

const workspaceSearchTool = {
  name: 'workspace_search',
  description: '在用户上传的工作区参考文档中搜索关键词。返回所有文档中包含该关键词的片段及上下文。多个关键词用空格分隔，采用AND逻辑。仅在用户要求引用/处理工作区资料，或当前任务确实缺少外部参考时使用；不要因工作区列表存在而主动搜索。',
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
  description: '读取工作区中某个参考文档的完整内容或指定行范围的内容。仅在用户要求引用/处理该资料，或当前任务确实需要全文证据时使用；不要读取未使用的参考文件来凑进度。',
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

export const agentTools = [...taskTools, ...layoutTools, ...editTools, documentImageAnalysisTool, ocrTool, workspaceSearchTool, workspaceReadTool].filter(
  (tool, index, list) => list.findIndex(item => item.name === tool.name) === index,
)
