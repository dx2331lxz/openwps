import { fontFamilyMap } from './presets'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolCall {
  name: string
  params: Record<string, unknown>
}

export interface DocumentContext {
  wordCount: number
  pageCount: number
  paragraphCount: number
}

export interface AIAgent {
  process(userMessage: string, context: DocumentContext): Promise<ToolCall[]>
}

// ─── CJK font size names ──────────────────────────────────────────────────────

const CJK_SIZE_MAP: Record<string, number> = {
  初号: 42,
  小初: 36,
  一号: 26,
  小一: 24,
  二号: 22,
  小二: 18,
  三号: 16,
  小三: 15,
  四号: 14,
  小四: 12,
  五号: 10.5,
  小五: 9,
  六号: 7.5,
  七号: 5.5,
  八号: 5,
}

const COLOR_NAMES: Record<string, string> = {
  红色: '#FF0000',
  蓝色: '#0066CC',
  绿色: '#1B8000',
  黄色: '#FFB300',
  橙色: '#E65C00',
  紫色: '#7B00D4',
  黑色: '#000000',
  白色: '#FFFFFF',
  灰色: '#808080',
}

// ─── Local keyword parser ─────────────────────────────────────────────────────

function parseCommand(message: string): ToolCall[] {
  const msg = message.trim()
  if (!msg) return []

  // ── Preset styles ──
  const presetMatch = msg.match(/(公文|论文|合同|报告|信函)/)
  if (presetMatch) {
    return [{ name: 'apply_preset_style', params: { preset: presetMatch[1] } }]
  }

  // ── Table insertion ──
  const tableMatch = msg.match(
    /插入.*?(\d+)\s*行.*?(\d+)\s*列|(\d+)\s*行.*?(\d+)\s*列.*?表格|插入.*?(\d+)[×xX*](\d+)/
  )
  if (tableMatch || msg.includes('表格')) {
    const rows = parseInt(tableMatch?.[1] ?? tableMatch?.[3] ?? tableMatch?.[5] ?? '3')
    const cols = parseInt(tableMatch?.[2] ?? tableMatch?.[4] ?? tableMatch?.[6] ?? '3')
    return [{ name: 'insert_table', params: { rows: rows || 3, cols: cols || 3 } }]
  }

  // ── Insert page break ──
  if (msg.includes('分页符') || (msg.includes('插入') && msg.includes('分页'))) {
    return [{ name: 'insert_page_break', params: {} }]
  }

  // ── Insert horizontal rule ──
  if (msg.includes('水平线') || msg.includes('分割线') || msg.includes('横线')) {
    return [{ name: 'insert_horizontal_rule', params: {} }]
  }

  // ── Page config ──
  if (msg.includes('纸张') || msg.includes('页边距') || msg.includes('横向') || msg.includes('纵向') ||
      /[AB]\d纸|Letter纸/i.test(msg)) {
    const pageParams: Record<string, unknown> = {}
    if (msg.includes('A4')) pageParams.paperSize = 'A4'
    else if (msg.includes('A3')) pageParams.paperSize = 'A3'
    else if (/letter/i.test(msg)) pageParams.paperSize = 'Letter'
    else if (msg.includes('B5')) pageParams.paperSize = 'B5'

    if (msg.includes('横向')) pageParams.orientation = 'landscape'
    else if (msg.includes('纵向')) pageParams.orientation = 'portrait'

    const marginMatch = msg.match(/上边距\s*(\d+)/)
    if (marginMatch) pageParams.marginTop = parseInt(marginMatch[1])

    if (Object.keys(pageParams).length > 0) {
      return [{ name: 'set_page_config', params: pageParams }]
    }
  }

  // ── Heading level ──
  const headingMatch = msg.match(/[标题](\d)级?|(\d)级[标题]|设为标题(\d)|heading\s*(\d)/i)
  if (headingMatch) {
    const level = parseInt(headingMatch[1] ?? headingMatch[2] ?? headingMatch[3] ?? headingMatch[4])
    if (level >= 1 && level <= 4) {
      return [{ name: 'set_heading', params: { level } }]
    }
  }

  // ── List ──
  if (msg.includes('无序列表') || msg.includes('项目符号') || msg.includes('圆点列表')) {
    return [{ name: 'set_list', params: { type: 'bullet' } }]
  }
  if (msg.includes('有序列表') || msg.includes('编号列表') || msg.includes('数字列表')) {
    return [{ name: 'set_list', params: { type: 'ordered' } }]
  }
  if (msg.includes('取消列表') || msg.includes('删除列表') || msg.includes('普通段落')) {
    return [{ name: 'set_list', params: { type: 'none' } }]
  }

  // ── Compound text + paragraph style ──
  const calls: ToolCall[] = []
  const textAttrs: Record<string, unknown> = {}
  const paraAttrs: Record<string, unknown> = {}

  // Determine target scope
  let target = 'selection'
  if (msg.includes('全文') || msg.includes('所有段落') ||
      msg.includes('正文') || msg.includes('全部')) {
    target = 'all'
  }

  // Bold
  if (msg.includes('取消加粗') || msg.includes('不加粗') || msg.includes('去掉加粗')) {
    textAttrs.bold = false
  } else if (msg.includes('加粗') || msg.includes('粗体') || msg.includes('bold')) {
    textAttrs.bold = true
  }

  // Italic
  if (msg.includes('取消斜体') || msg.includes('不斜体')) {
    textAttrs.italic = false
  } else if (msg.includes('斜体') || msg.includes('倾斜')) {
    textAttrs.italic = true
  }

  // Underline
  if (msg.includes('取消下划线')) {
    textAttrs.underline = false
  } else if (msg.includes('下划线')) {
    textAttrs.underline = true
  }

  // Strikethrough
  if (msg.includes('删除线')) {
    textAttrs.strikethrough = true
  }

  // Font family (longest-match first to avoid partial matches)
  const fontCandidates = Object.keys(fontFamilyMap).sort((a, b) => b.length - a.length)
  for (const name of fontCandidates) {
    if (msg.includes(name)) {
      textAttrs.fontFamily = fontFamilyMap[name]
      break
    }
  }

  // Font size: CJK names first
  for (const [name, pt] of Object.entries(CJK_SIZE_MAP)) {
    if (msg.includes(name)) {
      textAttrs.fontSize = pt
      break
    }
  }
  // Numeric with unit after: "16pt" / "16号" / "16磅"
  if (textAttrs.fontSize == null) {
    const sizeMatch = msg.match(/(\d+(?:\.\d+)?)\s*(?:pt|磅|号)/)
    if (sizeMatch) {
      textAttrs.fontSize = parseFloat(sizeMatch[1])
    }
  }
  // Numeric with "字号" prefix: "字号18" / "字号 16"
  if (textAttrs.fontSize == null) {
    const ziHaoMatch = msg.match(/字号\s*(\d+(?:\.\d+)?)/)
    if (ziHaoMatch) {
      textAttrs.fontSize = parseFloat(ziHaoMatch[1])
    }
  }

  // Color
  const hexMatch = msg.match(/#[0-9a-fA-F]{3,6}/)
  if (hexMatch) {
    textAttrs.color = hexMatch[0]
  } else {
    for (const [name, hex] of Object.entries(COLOR_NAMES)) {
      if (msg.includes(name)) {
        textAttrs.color = hex
        break
      }
    }
  }

  // Letter spacing
  const spacingMatch = msg.match(/字间距\s*(\d+(?:\.\d+)?)/)
  if (spacingMatch) {
    textAttrs.letterSpacing = parseFloat(spacingMatch[1])
  }

  // Alignment
  if (msg.includes('居中') || msg.includes('中对齐')) paraAttrs.align = 'center'
  else if (msg.includes('右对齐') || msg.includes('居右')) paraAttrs.align = 'right'
  else if (msg.includes('左对齐') || msg.includes('居左')) paraAttrs.align = 'left'
  else if (msg.includes('两端对齐') || msg.includes('分散对齐') || msg.includes('justify')) {
    paraAttrs.align = 'justify'
  }

  // First-line indent: "首行缩进2字符" / "首行缩进2个字"
  const indentMatch = msg.match(/首行缩进\s*(\d+(?:\.\d+)?)\s*(?:字符|个字|字|em)?/)
  if (indentMatch) paraAttrs.firstLineIndent = parseFloat(indentMatch[1])

  // Overall indent
  const overallIndentMatch = msg.match(/(?:整体|段落)缩进\s*(\d+(?:\.\d+)?)/)
  if (overallIndentMatch) paraAttrs.indent = parseFloat(overallIndentMatch[1])

  // Line height
  const lineHMatch = msg.match(/(\d+(?:\.\d+)?)\s*倍行距|行距\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*倍/)
  if (lineHMatch) {
    paraAttrs.lineHeight = parseFloat(lineHMatch[1] ?? lineHMatch[2] ?? lineHMatch[3])
  }

  // Space before / after
  const spaceBeforeMatch = msg.match(/段前\s*(\d+(?:\.\d+)?)/)
  if (spaceBeforeMatch) paraAttrs.spaceBefore = parseFloat(spaceBeforeMatch[1])

  const spaceAfterMatch = msg.match(/段后\s*(\d+(?:\.\d+)?)/)
  if (spaceAfterMatch) paraAttrs.spaceAfter = parseFloat(spaceAfterMatch[1])

  // Emit tool calls
  if (Object.keys(textAttrs).length > 0) {
    calls.push({ name: 'set_text_style', params: { ...textAttrs, target } })
  }
  if (Object.keys(paraAttrs).length > 0) {
    calls.push({ name: 'set_paragraph_style', params: { ...paraAttrs, target } })
  }

  if (calls.length === 0) {
    // Unrecognized command
    return [{ name: '__unknown__', params: { originalMessage: msg } }]
  }

  return calls
}

// ─── Agents ───────────────────────────────────────────────────────────────────

/** Local rule-based agent — no network required */
export class LocalAgent implements AIAgent {
  async process(userMessage: string, _context: DocumentContext): Promise<ToolCall[]> {
    return parseCommand(userMessage)
  }
}

/** Placeholder for Claude API integration */
export class ClaudeAgent implements AIAgent {
  private apiKey: string
  constructor(apiKey: string) { this.apiKey = apiKey }

  async process(_userMessage: string, _context: DocumentContext): Promise<ToolCall[]> {
    void this.apiKey
    throw new Error('Claude API 未配置，请先设置 API Key')
  }
}

/** Placeholder for OpenAI GPT integration */
export class GPTAgent implements AIAgent {
  private apiKey: string
  constructor(apiKey: string) { this.apiKey = apiKey }

  async process(_userMessage: string, _context: DocumentContext): Promise<ToolCall[]> {
    void this.apiKey
    throw new Error('OpenAI API 未配置，请先设置 API Key')
  }
}

/** Default agent used by the toolbar */
export const defaultAgent: AIAgent = new LocalAgent()
