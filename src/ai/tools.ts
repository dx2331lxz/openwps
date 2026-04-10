import { SUPPORTED_AI_FONT_NAMES } from '../fonts'

const rangeProperties = {
  type: {
    type: 'string',
    enum: [
      'all',
      'paragraph',
      'paragraphs',
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
  text: { type: 'string', description: '要匹配的文字（range.type=contains_text 时使用）' },
  selectionFrom: { type: 'integer', description: '选区起始文档位置（range.type=selection 时使用）' },
  selectionTo: { type: 'integer', description: '选区结束文档位置（range.type=selection 时使用）' },
} as const

const commonTools = [
  {
    name: 'get_document_info',
    description: '获取文档信息（字数、段落数、页数）',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_document_content',
    description: '读取文档完整内容，返回每个段落的文字内容、段落样式，以及 textRuns 形式的分段文字样式',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_paragraph',
    description: '读取指定段落的内容、段落样式，以及 textRuns 形式的分段文字样式',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: '段落索引（从 0 开始）' },
      },
      required: ['index'],
    },
  },
]

export const layoutTools = [
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
        fontFamily: { type: 'string', enum: [...SUPPORTED_AI_FONT_NAMES], description: '字体名，仅支持 宋体/黑体/楷体/仿宋' },
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
    description: '设置指定范围段落的格式（对齐、缩进、行距、间距）',
    parameters: {
      type: 'object',
      properties: {
        range: { type: 'object', description: '操作范围', properties: rangeProperties },
        align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
        firstLineIndent: { type: 'number', description: '首行缩进（字符数，如 2 表示缩进2字）' },
        indent: { type: 'number', description: '整体左缩进（字符数）' },
        lineHeight: { type: 'number', description: '行距倍数，如 1.0/1.5/2.0' },
        spaceBefore: { type: 'number', description: '段前间距（磅）' },
        spaceAfter: { type: 'number', description: '段后间距（磅）' },
        listType: { type: 'string', enum: ['none', 'bullet', 'ordered'], description: '列表类型' },
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
    name: 'insert_table',
    description: '在指定位置插入表格',
    parameters: {
      type: 'object',
      properties: {
        afterParagraph: { type: 'integer', description: '在该段落后插入表格' },
        rows: { type: 'integer', minimum: 1, maximum: 20 },
        cols: { type: 'integer', minimum: 1, maximum: 10 },
        headerRow: { type: 'boolean', description: '是否有表头行' },
      },
      required: ['afterParagraph', 'rows', 'cols'],
    },
  },
  {
    name: 'get_document_info',
    description: '获取文档信息（字数、段落数、页数）',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_document_content',
    description: '读取文档完整内容，返回每个段落的文字内容、段落样式，以及 textRuns 形式的分段文字样式',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_paragraph',
    description: '读取指定段落的内容、段落样式，以及 textRuns 形式的分段文字样式',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: '段落索引（从 0 开始）' },
      },
      required: ['index'],
    },
  },
]

export const editTools = [
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
    description: '删除指定段落',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: '段落索引' },
      },
      required: ['index'],
    },
  },
  ...commonTools,
]
