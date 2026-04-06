export const layoutTools = [
  // === 页面设置 ===
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

  // === 文字格式 ===
  {
    name: 'set_text_style',
    description: '设置选中文字或指定段落的文字样式',
    parameters: {
      type: 'object',
      properties: {
        fontFamily: { type: 'string', description: '字体，如 宋体/黑体/楷体/Arial' },
        fontSize: { type: 'number', description: '字号 pt' },
        color: { type: 'string', description: '文字颜色，如 #FF0000 或 red' },
        backgroundColor: { type: 'string', description: '背景色' },
        bold: { type: 'boolean', description: '加粗' },
        italic: { type: 'boolean', description: '斜体' },
        underline: { type: 'boolean', description: '下划线' },
        strikethrough: { type: 'boolean', description: '删除线' },
        superscript: { type: 'boolean', description: '上标' },
        subscript: { type: 'boolean', description: '下标' },
        letterSpacing: { type: 'number', description: '字间距 pt' },
        target: {
          type: 'string',
          enum: ['selection', 'all', 'heading1', 'heading2', 'body'],
          description: '应用目标',
        },
      },
    },
  },

  // === 段落格式 ===
  {
    name: 'set_paragraph_style',
    description: '设置段落格式（对齐、缩进、行距、间距）',
    parameters: {
      type: 'object',
      properties: {
        align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
        firstLineIndent: { type: 'number', description: '首行缩进 em' },
        indent: { type: 'number', description: '整体缩进 em' },
        lineHeight: { type: 'number', description: '行距倍数，如 1.5' },
        spaceBefore: { type: 'number', description: '段前间距 pt' },
        spaceAfter: { type: 'number', description: '段后间距 pt' },
        target: { type: 'string', enum: ['selection', 'all', 'heading1', 'heading2', 'body'] },
      },
    },
  },

  // === 标题 ===
  {
    name: 'set_heading',
    description: '将选中段落设为标题（1-4级）',
    parameters: {
      type: 'object',
      properties: {
        level: { type: 'integer', minimum: 1, maximum: 4, description: '标题级别' },
      },
      required: ['level'],
    },
  },

  // === 列表 ===
  {
    name: 'set_list',
    description: '设置列表格式',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['none', 'bullet', 'ordered'], description: '无/无序/有序' },
      },
    },
  },

  // === 插入 ===
  {
    name: 'insert_page_break',
    description: '在当前位置插入分页符',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'insert_horizontal_rule',
    description: '插入水平分割线',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'insert_table',
    description: '插入表格',
    parameters: {
      type: 'object',
      properties: {
        rows: { type: 'integer', minimum: 1, maximum: 20 },
        cols: { type: 'integer', minimum: 1, maximum: 10 },
        headerRow: { type: 'boolean', description: '是否有表头行' },
      },
      required: ['rows', 'cols'],
    },
  },

  // === 批量操作 ===
  {
    name: 'apply_preset_style',
    description: '应用预设样式到整个文档',
    parameters: {
      type: 'object',
      properties: {
        preset: {
          type: 'string',
          enum: ['公文', '论文', '合同', '报告', '信函'],
          description: '预设样式名',
        },
      },
      required: ['preset'],
    },
  },

  // === 查询 ===
  {
    name: 'get_document_info',
    description: '获取文档信息（段落数、字数、页数）',
    parameters: { type: 'object', properties: {} },
  },
]
