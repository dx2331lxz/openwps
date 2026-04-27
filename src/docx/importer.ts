import JSZip from 'jszip'
import type { PageConfig } from '../layout/paginator'
import { DEFAULT_EDITOR_FONT_STACK, FONT_STACKS } from '../fonts'

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const TWIP_TO_PX = 96 / 1440
const TWIP_TO_PT = 1 / 20
const EMU_TO_PX = 1 / 9525

type Align = 'left' | 'center' | 'right' | 'justify'

interface ParagraphTabStop {
  align: 'left' | 'center' | 'right'
  position: number
}

interface TextStyleAttrs extends Record<string, unknown> {
  fontFamily: string
  fontSize: number
  color: string
  backgroundColor: string
  bold: boolean
  italic: boolean
  underline: boolean
  strikethrough: boolean
  superscript: boolean
  subscript: boolean
  letterSpacing: number
}

interface ParagraphAttrs extends Record<string, unknown> {
  align: Align
  firstLineIndent: number
  indent: number
  rightIndent: number
  headingLevel: number | null
  lineHeight: number
  spaceBefore: number
  spaceAfter: number
  listType: 'bullet' | 'ordered' | null
  listLevel: number
  pageBreakBefore: boolean
  tabStops: ParagraphTabStop[]
}

interface ParsedParagraphResult {
  node: PMNodeJSON | null
  floatingObjects: PMNodeJSON[]
}

interface ParsedRunResult {
  nodes: PMNodeJSON[]
  floatingObjects: PMNodeJSON[]
}

type PMTextStyleMarkJSON = {
  type: 'textStyle'
  attrs: TextStyleAttrs
}

type PMLinkMarkJSON = {
  type: 'link'
  attrs: {
    href: string
  }
}

type PMCommentMarkJSON = {
  type: 'comment'
  attrs: {
    id: string
    author: string
    date: string
    content: string
  }
}

type PMMarkJSON = PMTextStyleMarkJSON | PMLinkMarkJSON | PMCommentMarkJSON

export type PMNodeJSON = {
  type: string
  attrs?: Record<string, unknown>
  text?: string
  marks?: PMMarkJSON[]
  content?: PMNodeJSON[]
}

export interface DocxImportResult {
  doc: PMNodeJSON
  pageConfig: PageConfig
  docGridLinePitchPt: number | null
  typography: DocxTypographyConfig
}

type StyleAttrs = Partial<TextStyleAttrs & Pick<ParagraphAttrs, 'align' | 'firstLineIndent' | 'indent' | 'rightIndent' | 'headingLevel' | 'lineHeight' | 'spaceBefore' | 'spaceAfter' | 'listType' | 'listLevel' | 'pageBreakBefore' | 'tabStops'>>

interface RawStyle {
  basedOn?: string
  attrs: StyleAttrs
}

type StyleMap = Record<string, StyleAttrs>

type ListType = ParagraphAttrs['listType']

interface NumberingLevelInfo {
  listType: Exclude<ListType, null>
  listLevel: number
}

type NumberingMap = Record<string, Record<number, NumberingLevelInfo>>

interface RelInfo {
  target: string
  zipPath?: string
  type: string
  targetMode?: string
}

type RelMap = Record<string, RelInfo>

interface ThemeFonts {
  majorAscii?: string
  minorAscii?: string
  majorEastAsia?: string
  minorEastAsia?: string
}

interface ParsedStylesResult {
  styleMap: StyleMap
  defaultParagraphStyle: StyleAttrs
}

interface DocumentLayout {
  pageConfig: PageConfig
  docGridLinePitchPt: number | null
}

export interface DocxTypographyConfig {
  punctuationCompression: boolean
  noPunctuationKerning: boolean
  spaceForUnderline: boolean
  balanceSingleByteDoubleByteWidth: boolean
  doNotLeaveBackslashAlone: boolean
  underlineTrailingSpaces: boolean
  doNotExpandShiftReturn: boolean
  adjustLineHeightInTable: boolean
  doNotWrapTextWithPunct: boolean
  doNotUseEastAsianBreakRules: boolean
  useFELayout: boolean
}

const DEFAULT_TEXT_STYLE: TextStyleAttrs = {
  fontFamily: DEFAULT_EDITOR_FONT_STACK,
  fontSize: 12,
  color: '#000000',
  backgroundColor: '',
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  superscript: false,
  subscript: false,
  letterSpacing: 0,
}

const DEFAULT_PARAGRAPH_ATTRS: ParagraphAttrs = {
  align: 'left',
  firstLineIndent: 0,
  indent: 0,
  rightIndent: 0,
  headingLevel: null,
  lineHeight: 1.5,
  spaceBefore: 0,
  spaceAfter: 0,
  listType: null,
  listLevel: 0,
  pageBreakBefore: false,
  tabStops: [],
}

function normalizeFont(name: string): string {
  const trimmed = name.trim()
  const map: Record<string, string> = {
    '宋体': FONT_STACKS.song,
    'SimSun': FONT_STACKS.song,
    'Songti SC': FONT_STACKS.song,
    'STSong': FONT_STACKS.song,
    '黑体': FONT_STACKS.hei,
    'SimHei': FONT_STACKS.hei,
    'Heiti SC': FONT_STACKS.hei,
    'STHeiti': FONT_STACKS.hei,
    '楷体': FONT_STACKS.kai,
    '楷体_GB2312': FONT_STACKS.kai,
    'KaiTi': FONT_STACKS.kai,
    'Kaiti SC': FONT_STACKS.kai,
    'STKaiti': FONT_STACKS.kai,
    '仿宋': FONT_STACKS.fang,
    '仿宋_GB2312': FONT_STACKS.fang,
    'FangSong': FONT_STACKS.fang,
    'STFangsong': FONT_STACKS.fang,
    '微软雅黑': '"Microsoft YaHei", 微软雅黑, "PingFang SC", sans-serif',
    'Microsoft YaHei': '"Microsoft YaHei", 微软雅黑, "PingFang SC", sans-serif',
    '华文行楷': '"STXingkai", "Kaiti SC", serif',
    'STXingkai': '"STXingkai", "Kaiti SC", serif',
    '隶书': '"STLiti", "SimLi", serif',
    'STLiti': '"STLiti", "SimLi", serif',
    'Times New Roman': FONT_STACKS.timesNewRoman,
    'Arial': FONT_STACKS.arial,
    'Calibri': 'Calibri, Arial, sans-serif',
  }

  if (!trimmed || /--/.test(trimmed) || /[A-Z]{2,}\d/.test(trimmed)) {
    return DEFAULT_TEXT_STYLE.fontFamily
  }

  return map[trimmed] ?? trimmed
}

function resolveThemeFont(themeFonts: ThemeFonts, themeKey: string) {
  switch (themeKey) {
    case 'majorEastAsia':
      return themeFonts.majorEastAsia
    case 'minorEastAsia':
      return themeFonts.minorEastAsia
    case 'majorAscii':
    case 'majorHAnsi':
      return themeFonts.majorAscii
    case 'minorAscii':
    case 'minorHAnsi':
      return themeFonts.minorAscii
    default:
      return undefined
  }
}

function clampLineHeight(value: number, fallback = DEFAULT_PARAGRAPH_ATTRS.lineHeight) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(3, Math.max(1, value))
}

function parseWordLineHeight(
  line: number,
  lineRule: string,
  baseFontSize: number,
  docGridLinePitchPt: number | null
) {
  if (line <= 0) return DEFAULT_PARAGRAPH_ATTRS.lineHeight
  if (lineRule === 'auto') return clampLineHeight(line / 240)

  // WPS 文档常把小数值行距和文档网格一起使用。
  // 对于小于 240 的值，优先按半磅解释；若启用了行网格，则至少对齐到网格节距。
  const linePt = line < 240 ? halfPtToPt(line) : twipToPt(line)
  const effectiveLinePt = docGridLinePitchPt != null
    ? Math.max(linePt, docGridLinePitchPt)
    : linePt
  const lineHeight = effectiveLinePt / Math.max(baseFontSize, 1)

  return clampLineHeight(lineHeight)
}

function twipToPx(value: number) {
  return value * TWIP_TO_PX
}

function twipToPt(value: number) {
  return value * TWIP_TO_PT
}

function twipToEm(value: number, fontSizePt: number) {
  return twipToPt(value) / Math.max(fontSizePt, 1)
}

function hundredthCharToEm(value: number) {
  return value / 100
}

function halfPtToPt(value: number) {
  return value / 2
}

function parseXml(xml: string) {
  return new DOMParser().parseFromString(xml, 'text/xml')
}

function elementChildren(node: ParentNode): Element[] {
  return Array.from(node.childNodes).filter((child): child is Element => child.nodeType === Node.ELEMENT_NODE)
}

function getLocalName(element: Element) {
  return element.localName ?? element.nodeName.split(':').pop() ?? element.nodeName
}

function getAttr(element: Element | undefined, name: string) {
  if (!element) return ''
  const direct = element.getAttribute(name)
    ?? element.getAttribute(`w:${name}`)
    ?? element.getAttribute(`r:${name}`)
    ?? element.getAttribute(`a:${name}`)
    ?? element.getAttribute(`wp:${name}`)
  if (direct != null) return direct

  for (const attr of Array.from(element.attributes)) {
    const attrLocalName = attr.localName ?? attr.name.split(':').pop() ?? attr.name
    if (attrLocalName === name) return attr.value
  }

  return ''
}

function directChild(parent: Element | undefined, localName: string) {
  if (!parent) return undefined
  return elementChildren(parent).find((child) => getLocalName(child) === localName)
}

function directChildren(parent: Element | undefined, localName: string) {
  if (!parent) return []
  return elementChildren(parent).filter((child) => getLocalName(child) === localName)
}

function findDescendant(parent: Element | Document | undefined, localName: string) {
  if (!parent) return undefined
  return Array.from(parent.getElementsByTagName('*')).find((child) => getLocalName(child) === localName)
}

function parseNumber(raw: string, fallback = 0) {
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : fallback
}

function truthyElement(element: Element | undefined) {
  if (!element) return false
  const raw = getAttr(element, 'val')
  return raw === '' || !['0', 'false', 'off', 'none'].includes(raw)
}

function normalizeColor(raw: string) {
  return raw && raw !== 'auto' ? `#${raw}` : DEFAULT_TEXT_STYLE.color
}

function normalizeFill(raw: string) {
  return raw && !['auto', 'none', 'nil', 'clear'].includes(raw) ? `#${raw}` : ''
}

function highlightToColor(raw: string) {
  const map: Record<string, string> = {
    yellow: '#ffff00',
    green: '#00ff00',
    cyan: '#00ffff',
    magenta: '#ff00ff',
    blue: '#0000ff',
    red: '#ff0000',
    darkBlue: '#00008b',
    darkCyan: '#008b8b',
    darkGreen: '#006400',
    darkMagenta: '#8b008b',
    darkRed: '#8b0000',
    darkYellow: '#b8860b',
    darkGray: '#a9a9a9',
    lightGray: '#d3d3d3',
    black: '#000000',
    white: '#ffffff',
  }

  return map[raw] ?? ''
}

function normalizePath(path: string) {
  const parts = path.split('/').filter(Boolean)
  const stack: string[] = []
  for (const part of parts) {
    if (part === '.') continue
    if (part === '..') {
      stack.pop()
      continue
    }
    stack.push(part)
  }
  return stack.join('/')
}

function relTargetToZipPath(target: string) {
  return normalizePath(`word/${target}`)
}

function parseListType(raw: string): Exclude<ListType, null> | null {
  if (!raw || raw === 'none') return null
  return raw === 'bullet' ? 'bullet' : 'ordered'
}

function mimeFromPath(path: string) {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  return 'application/octet-stream'
}

function createTextNode(
  text: string,
  attrs: Partial<TextStyleAttrs>,
  extraMarks: PMMarkJSON[] = []
): PMNodeJSON | null {
  if (!text) return null
  return {
    type: 'text',
    text,
    marks: [{
      type: 'textStyle',
      attrs: { ...DEFAULT_TEXT_STYLE, ...attrs },
    }, ...extraMarks],
  }
}

function parseThemeFonts(themeXml: string): ThemeFonts {
  if (!themeXml) return {}

  const dom = parseXml(themeXml)
  const majorFont = findDescendant(dom, 'majorFont')
  const minorFont = findDescendant(dom, 'minorFont')

  const findScriptFont = (parent: Element | undefined, script: string) =>
    elementChildren(parent ?? dom).find((child) =>
      getLocalName(child) === 'font' && getAttr(child, 'script') === script
    )

  return {
    majorAscii: getAttr(directChild(majorFont, 'latin'), 'typeface') || undefined,
    minorAscii: getAttr(directChild(minorFont, 'latin'), 'typeface') || undefined,
    majorEastAsia: getAttr(findScriptFont(majorFont, 'Hans'), 'typeface')
      || getAttr(directChild(majorFont, 'ea'), 'typeface')
      || undefined,
    minorEastAsia: getAttr(findScriptFont(minorFont, 'Hans'), 'typeface')
      || getAttr(directChild(minorFont, 'ea'), 'typeface')
      || undefined,
  }
}

function parseNumbering(numberingXml: string): NumberingMap {
  if (!numberingXml) return {}

  const dom = parseXml(numberingXml)
  const abstractNums: Record<string, Record<number, NumberingLevelInfo>> = {}

  for (const abstractNum of Array.from(dom.getElementsByTagNameNS(W_NS, 'abstractNum'))) {
    const abstractNumId = getAttr(abstractNum, 'abstractNumId')
    if (!abstractNumId) continue

    const levels: Record<number, NumberingLevelInfo> = {}
    for (const lvl of directChildren(abstractNum, 'lvl')) {
      const level = parseNumber(getAttr(lvl, 'ilvl'))
      const numFmt = getAttr(directChild(lvl, 'numFmt'), 'val')
      const listType = parseListType(numFmt)
      if (!listType) continue
      levels[level] = { listType, listLevel: level }
    }

    abstractNums[abstractNumId] = levels
  }

  const numberingMap: NumberingMap = {}
  for (const num of Array.from(dom.getElementsByTagNameNS(W_NS, 'num'))) {
    const numId = getAttr(num, 'numId')
    const abstractNumId = getAttr(directChild(num, 'abstractNumId'), 'val')
    if (!numId || !abstractNumId) continue
    numberingMap[numId] = abstractNums[abstractNumId] ?? {}
  }

  return numberingMap
}

function readParagraphStyle(
  pPr: Element | undefined,
  inherited: StyleAttrs,
  docGridLinePitchPt: number | null,
  numberingMap: NumberingMap = {}
): StyleAttrs {
  if (!pPr) return {}

  const alignMap: Record<string, Align> = {
    left: 'left',
    start: 'left',
    center: 'center',
    right: 'right',
    both: 'justify',
    justify: 'justify',
    distribute: 'center',
  }

  const attrs: StyleAttrs = {}
  const jc = getAttr(directChild(pPr, 'jc'), 'val')
  if (jc) attrs.align = alignMap[jc] ?? 'left'

  const outlineLvl = parseNumber(getAttr(directChild(pPr, 'outlineLvl'), 'val'), -1)
  if (outlineLvl >= 0 && outlineLvl <= 5) attrs.headingLevel = outlineLvl + 1

  const baseFontSize = inherited.fontSize ?? DEFAULT_TEXT_STYLE.fontSize
  const ind = directChild(pPr, 'ind')
  const leftIndent = parseNumber(getAttr(ind, 'left') || getAttr(ind, 'start'))
  const leftChars = parseNumber(getAttr(ind, 'leftChars') || getAttr(ind, 'startChars'))
  const firstLine = parseNumber(getAttr(ind, 'firstLine'))
  const firstLineChars = parseNumber(getAttr(ind, 'firstLineChars'))
  const hanging = parseNumber(getAttr(ind, 'hanging'))
  const hangingChars = parseNumber(getAttr(ind, 'hangingChars'))
  const rightIndent = parseNumber(getAttr(ind, 'right') || getAttr(ind, 'end'))
  const rightChars = parseNumber(getAttr(ind, 'rightChars') || getAttr(ind, 'endChars'))
  const shouldIgnoreWordIndents = jc === 'distribute'
  if (!shouldIgnoreWordIndents) {
    if (leftIndent > 0) attrs.indent = twipToEm(leftIndent, baseFontSize) / 2
    else if (leftChars > 0) attrs.indent = hundredthCharToEm(leftChars) / 2

    if (rightIndent > 0) attrs.rightIndent = twipToEm(rightIndent, baseFontSize) / 2
    else if (rightChars > 0) attrs.rightIndent = hundredthCharToEm(rightChars) / 2

    if (firstLine > 0) attrs.firstLineIndent = twipToEm(firstLine, baseFontSize)
    else if (firstLineChars > 0) attrs.firstLineIndent = hundredthCharToEm(firstLineChars)

    if (hanging > 0) attrs.firstLineIndent = -twipToEm(hanging, baseFontSize)
    else if (hangingChars > 0) attrs.firstLineIndent = -hundredthCharToEm(hangingChars)
  }

  const tabStops = directChildren(directChild(pPr, 'tabs'), 'tab')
    .map((tab): ParagraphTabStop | null => {
      const rawAlign = getAttr(tab, 'val')
      const align = rawAlign === 'center' || rawAlign === 'right' ? rawAlign : 'left'
      const pos = parseNumber(getAttr(tab, 'pos'))
      if (pos <= 0) return null
      return {
        align,
        position: Math.round(twipToPx(pos)),
      }
    })
    .filter((tab): tab is ParagraphTabStop => tab != null)
  if (tabStops.length > 0) attrs.tabStops = tabStops

  const spacing = directChild(pPr, 'spacing')
  const before = parseNumber(getAttr(spacing, 'before'))
  const after = parseNumber(getAttr(spacing, 'after'))
  const line = parseNumber(getAttr(spacing, 'line'))
  const lineRule = getAttr(spacing, 'lineRule') || 'auto'

  if (before > 0) attrs.spaceBefore = twipToPt(before)
  if (after > 0) attrs.spaceAfter = twipToPt(after)
  if (line > 0) {
    attrs.lineHeight = parseWordLineHeight(line, lineRule, baseFontSize, docGridLinePitchPt)
  } else if (docGridLinePitchPt != null) {
    attrs.lineHeight = clampLineHeight(docGridLinePitchPt / Math.max(baseFontSize, 1))
  }

  if (truthyElement(directChild(pPr, 'pageBreakBefore'))) attrs.pageBreakBefore = true

  const numPr = directChild(pPr, 'numPr')
  const numId = getAttr(directChild(numPr, 'numId'), 'val')
  const ilvl = parseNumber(getAttr(directChild(numPr, 'ilvl'), 'val'))
  const numberingLevel = numberingMap[numId]?.[ilvl]
  if (numberingLevel) {
    attrs.listType = numberingLevel.listType
    attrs.listLevel = numberingLevel.listLevel
  }

  return attrs
}

function readRunStyle(rPr: Element | undefined, inherited: StyleAttrs, themeFonts: ThemeFonts): StyleAttrs {
  if (!rPr) return { ...inherited }

  const attrs: StyleAttrs = {}
  const fonts = directChild(rPr, 'rFonts')
  const fontFamily =
    getAttr(fonts, 'eastAsia')
    || getAttr(fonts, 'ascii')
    || getAttr(fonts, 'hAnsi')
    || resolveThemeFont(themeFonts, getAttr(fonts, 'eastAsiaTheme'))
    || resolveThemeFont(themeFonts, getAttr(fonts, 'asciiTheme'))
    || resolveThemeFont(themeFonts, getAttr(fonts, 'hAnsiTheme'))
  if (fontFamily) attrs.fontFamily = normalizeFont(fontFamily)

  const size = parseNumber(getAttr(directChild(rPr, 'sz'), 'val'))
  if (size > 0) attrs.fontSize = halfPtToPt(size)

  const color = getAttr(directChild(rPr, 'color'), 'val')
  if (color) attrs.color = normalizeColor(color)

  const highlight = getAttr(directChild(rPr, 'highlight'), 'val')
  if (highlight) attrs.backgroundColor = highlightToColor(highlight) || attrs.backgroundColor || ''

  const shading = directChild(rPr, 'shd')
  const fill = normalizeFill(getAttr(shading, 'fill'))
  if (fill) attrs.backgroundColor = fill

  const spacing = parseNumber(getAttr(directChild(rPr, 'spacing'), 'val'))
  if (spacing !== 0) attrs.letterSpacing = twipToPt(spacing)

  if (truthyElement(directChild(rPr, 'b'))) attrs.bold = true
  if (truthyElement(directChild(rPr, 'i'))) attrs.italic = true
  if (truthyElement(directChild(rPr, 'u'))) attrs.underline = true
  if (truthyElement(directChild(rPr, 'strike')) || truthyElement(directChild(rPr, 'dstrike'))) attrs.strikethrough = true
  if (truthyElement(directChild(rPr, 'vertAlign'))) {
    const val = getAttr(directChild(rPr, 'vertAlign'), 'val')
    if (val === 'superscript') attrs.superscript = true
    if (val === 'subscript') attrs.subscript = true
  }

  return { ...inherited, ...attrs }
}

function parseStyleDefaults(stylesXml: string, themeFonts: ThemeFonts): StyleAttrs {
  if (!stylesXml) return {}

  const dom = parseXml(stylesXml)
  const docDefaults = findDescendant(dom, 'docDefaults')
  const pPrDefault = directChild(directChild(docDefaults, 'pPrDefault'), 'pPr')
  const rPrDefault = directChild(directChild(docDefaults, 'rPrDefault'), 'rPr')
  const runDefaults = readRunStyle(rPrDefault, {}, themeFonts)
  const paragraphDefaults = readParagraphStyle(pPrDefault, runDefaults, null, {})
  return { ...runDefaults, ...paragraphDefaults }
}

function parseStyles(
  stylesXml: string,
  themeFonts: ThemeFonts,
  docDefaults: StyleAttrs,
  numberingMap: NumberingMap
): ParsedStylesResult {
  if (!stylesXml) {
    return {
      styleMap: {},
      defaultParagraphStyle: { ...docDefaults },
    }
  }

  const dom = parseXml(stylesXml)
  const rawStyles: Record<string, RawStyle> = {}
  let defaultParagraphStyleId: string | undefined

  for (const styleEl of Array.from(dom.getElementsByTagNameNS(W_NS, 'style'))) {
    const styleId = getAttr(styleEl, 'styleId')
    if (!styleId) continue
    if (getAttr(styleEl, 'type') === 'paragraph' && getAttr(styleEl, 'default') === '1') {
      defaultParagraphStyleId = styleId
    }

    const basedOn = getAttr(directChild(styleEl, 'basedOn'), 'val') || undefined
    const styleName = getAttr(directChild(styleEl, 'name'), 'val')
    const pPr = directChild(styleEl, 'pPr')
    const rPr = directChild(styleEl, 'rPr')
    const runAttrs = readRunStyle(rPr, {}, themeFonts)
    const paraAttrs = readParagraphStyle(pPr, runAttrs, null, numberingMap)
    const headingLevel = getAttr(styleEl, 'type') === 'paragraph'
      ? inferHeadingLevelFromStyle(styleId, styleName)
      : null
    if (headingLevel != null) paraAttrs.headingLevel = headingLevel
    rawStyles[styleId] = { basedOn, attrs: { ...runAttrs, ...paraAttrs } }
  }

  const resolved: StyleMap = {}
  const resolving = new Set<string>()

  const resolveStyle = (styleId: string): StyleAttrs => {
    if (resolved[styleId]) return resolved[styleId]
    if (resolving.has(styleId)) return rawStyles[styleId]?.attrs ?? {}
    resolving.add(styleId)

    const raw = rawStyles[styleId]
    if (!raw) {
      resolving.delete(styleId)
      return { ...docDefaults }
    }

    const base = raw.basedOn ? resolveStyle(raw.basedOn) : { ...docDefaults }
    const merged = { ...base, ...raw.attrs }
    resolved[styleId] = merged
    resolving.delete(styleId)
    return merged
  }

  Object.keys(rawStyles).forEach(resolveStyle)
  return {
    styleMap: resolved,
    defaultParagraphStyle: defaultParagraphStyleId
      ? (resolved[defaultParagraphStyleId] ?? { ...docDefaults })
      : { ...docDefaults },
  }
}

function inferHeadingLevelFromStyle(styleId: string, styleName: string): number | null {
  const normalized = `${styleId} ${styleName}`.replace(/\s+/g, '').toLowerCase()
  const match = normalized.match(/(?:heading|标题)([1-6一二三四五六])/)
  if (!match) return null
  const raw = match[1]
  const cjkMap: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }
  const level = cjkMap[raw] ?? Number(raw)
  return level >= 1 && level <= 6 ? level : null
}

interface CommentInfo {
  author: string
  date: string
  text: string
}

type CommentMap = Map<string, CommentInfo>

function parseComments(commentsXml: string): CommentMap {
  const map: CommentMap = new Map()
  if (!commentsXml) return map

  const dom = parseXml(commentsXml)
  for (const commentEl of Array.from(dom.getElementsByTagNameNS(W_NS, 'comment'))) {
    const id = getAttr(commentEl, 'id')
    if (!id) continue
    const author = getAttr(commentEl, 'author')
    const date = getAttr(commentEl, 'date')
    // collect all text content from the comment paragraph(s)
    const text = Array.from(commentEl.getElementsByTagNameNS(W_NS, 't'))
      .map(t => t.textContent ?? '')
      .join('')
    map.set(id, { author, date, text })
  }

  return map
}

function parseRels(relsXml: string): RelMap {
  if (!relsXml) return {}
  const dom = parseXml(relsXml)
  const rels: RelMap = {}

  for (const rel of Array.from(dom.getElementsByTagName('Relationship'))) {
    const id = getAttr(rel, 'Id')
    const target = getAttr(rel, 'Target')
    const type = getAttr(rel, 'Type')
    const targetMode = getAttr(rel, 'TargetMode') || undefined
    if (id && target) {
      rels[id] = {
        target,
        zipPath: targetMode === 'External' ? undefined : relTargetToZipPath(target),
        type,
        targetMode,
      }
    }
  }

  return rels
}

function parseDocumentLayout(documentXml: string): DocumentLayout {
  const dom = parseXml(documentXml)
  const sectPr = findDescendant(dom, 'sectPr')
  const pgSz = directChild(sectPr, 'pgSz')
  const pgMar = directChild(sectPr, 'pgMar')
  const docGrid = directChild(sectPr, 'docGrid')

  const widthTwip = parseNumber(getAttr(pgSz, 'w'), 11906)
  const heightTwip = parseNumber(getAttr(pgSz, 'h'), 16838)
  const orientation = (getAttr(pgSz, 'orient') ?? '').toLowerCase()
  const marginTopTwip = parseNumber(getAttr(pgMar, 'top'), 1440)
  const marginBottomTwip = parseNumber(getAttr(pgMar, 'bottom'), 1440)
  const marginLeftTwip = parseNumber(getAttr(pgMar, 'left'), 1800)
  const marginRightTwip = parseNumber(getAttr(pgMar, 'right'), 1800)
  const linePitchTwip = parseNumber(getAttr(docGrid, 'linePitch'))
  let pageWidth = Math.round(twipToPx(widthTwip))
  let pageHeight = Math.round(twipToPx(heightTwip))

  if (orientation === 'landscape' && pageWidth < pageHeight) {
    [pageWidth, pageHeight] = [pageHeight, pageWidth]
  } else if (orientation === 'portrait' && pageWidth > pageHeight) {
    [pageWidth, pageHeight] = [pageHeight, pageWidth]
  }

  return {
    pageConfig: {
      pageWidth,
      pageHeight,
      marginTop: Math.round(twipToPx(marginTopTwip)),
      marginBottom: Math.round(twipToPx(marginBottomTwip)),
      marginLeft: Math.round(twipToPx(marginLeftTwip)),
      marginRight: Math.round(twipToPx(marginRightTwip)),
    },
    docGridLinePitchPt: linePitchTwip > 0 ? twipToPt(linePitchTwip) : null,
  }
}

function parseTypographySettings(settingsXml: string): DocxTypographyConfig {
  if (!settingsXml) {
    return {
      punctuationCompression: false,
      noPunctuationKerning: false,
      spaceForUnderline: false,
      balanceSingleByteDoubleByteWidth: false,
      doNotLeaveBackslashAlone: false,
      underlineTrailingSpaces: false,
      doNotExpandShiftReturn: false,
      adjustLineHeightInTable: false,
      doNotWrapTextWithPunct: false,
      doNotUseEastAsianBreakRules: false,
      useFELayout: false,
    }
  }

  const dom = parseXml(settingsXml)
  const characterSpacingControl = getAttr(findDescendant(dom, 'characterSpacingControl'), 'val')
  const compat = findDescendant(dom, 'compat')

  return {
    punctuationCompression: characterSpacingControl === 'compressPunctuation',
    noPunctuationKerning: truthyElement(findDescendant(dom, 'noPunctuationKerning')),
    spaceForUnderline: !!directChild(compat, 'spaceForUL'),
    balanceSingleByteDoubleByteWidth: !!directChild(compat, 'balanceSingleByteDoubleByteWidth'),
    doNotLeaveBackslashAlone: !!directChild(compat, 'doNotLeaveBackslashAlone'),
    underlineTrailingSpaces: !!directChild(compat, 'ulTrailSpace'),
    doNotExpandShiftReturn: !!directChild(compat, 'doNotExpandShiftReturn'),
    adjustLineHeightInTable: !!directChild(compat, 'adjustLineHeightInTable'),
    doNotWrapTextWithPunct: !!directChild(compat, 'doNotWrapTextWithPunct'),
    doNotUseEastAsianBreakRules: !!directChild(compat, 'doNotUseEastAsianBreakRules'),
    useFELayout: !!directChild(compat, 'useFELayout'),
  }
}

async function parseImageNode(drawingEl: Element, rels: RelMap, zip: JSZip): Promise<PMNodeJSON | null> {
  const blip = findDescendant(drawingEl, 'blip')
  const relId = getAttr(blip, 'embed')
  const relInfo = relId ? rels[relId] : undefined
  if (!relId || !relInfo?.zipPath) return null

  const target = relInfo.zipPath
  const file = zip.file(target)
  if (!file) return null

  const base64 = await file.async('base64')
  const mime = mimeFromPath(target)
  const extent = findDescendant(drawingEl, 'extent') ?? findDescendant(drawingEl, 'ext')
  const width = parseNumber(getAttr(extent, 'cx'))
  const height = parseNumber(getAttr(extent, 'cy'))
  const docPr = findDescendant(drawingEl, 'docPr')

  return {
    type: 'image',
    attrs: {
      src: `data:${mime};base64,${base64}`,
      alt: getAttr(docPr, 'descr') || getAttr(docPr, 'name') || '',
      title: getAttr(docPr, 'name') || '',
      width: width > 0 ? Math.round(width * EMU_TO_PX) : null,
      height: height > 0 ? Math.round(height * EMU_TO_PX) : null,
    },
  }
}

function parseBooleanAttr(element: Element | undefined, name: string, fallback = false) {
  const raw = getAttr(element, name)
  if (!raw) return fallback
  return !['0', 'false', 'off', 'none'].includes(raw)
}

async function parseFloatingObjectNode(
  drawingEl: Element,
  styleMap: StyleMap,
  defaultParagraphStyle: StyleAttrs,
  themeFonts: ThemeFonts,
  docGridLinePitchPt: number | null,
  numberingMap: NumberingMap,
  rels: RelMap,
  zip: JSZip,
  commentMap: CommentMap = new Map()
): Promise<PMNodeJSON | null> {
  const anchorEl = directChild(drawingEl, 'anchor')
  if (!anchorEl) return null

  const extent = directChild(anchorEl, 'extent') ?? findDescendant(anchorEl, 'ext')
  const width = parseNumber(getAttr(extent, 'cx'))
  const height = parseNumber(getAttr(extent, 'cy'))
  const docPr = directChild(anchorEl, 'docPr') ?? findDescendant(anchorEl, 'docPr')
  const positionH = directChild(anchorEl, 'positionH')
  const positionV = directChild(anchorEl, 'positionV')
  const positionX = parseNumber(directChild(positionH, 'posOffset')?.textContent ?? '0')
  const positionY = parseNumber(directChild(positionV, 'posOffset')?.textContent ?? '0')
  const wrapChild = elementChildren(anchorEl).find((child) => getLocalName(child).startsWith('wrap'))
  const wrap = wrapChild ? getLocalName(wrapChild).replace(/^wrap/, '').toLowerCase() : 'none'
  const txbxContent = findDescendant(anchorEl, 'txbxContent')
  const bodyPr = findDescendant(anchorEl, 'bodyPr')
  const paddingLeft = Math.round(parseNumber(getAttr(bodyPr, 'lIns')) * EMU_TO_PX)
  const paddingTop = Math.round(parseNumber(getAttr(bodyPr, 'tIns')) * EMU_TO_PX)
  const paddingRight = Math.round(parseNumber(getAttr(bodyPr, 'rIns')) * EMU_TO_PX)
  const paddingBottom = Math.round(parseNumber(getAttr(bodyPr, 'bIns')) * EMU_TO_PX)

  if (txbxContent) {
    const paragraphs: PMNodeJSON[] = []
    const paragraphElements = directChildren(txbxContent, 'p')
    for (let index = 0; index < paragraphElements.length; index += 1) {
      const paragraphEl = paragraphElements[index]!
      const parsed = await parseParagraph(
        paragraphEl,
        styleMap,
        defaultParagraphStyle,
        themeFonts,
        docGridLinePitchPt,
        numberingMap,
        rels,
        zip,
        commentMap
      )
      if (!parsed.node) continue

      if (parsed.node.type === 'paragraph' && parsed.node.attrs) {
        const spacing = directChild(directChild(paragraphEl, 'pPr'), 'spacing')
        const hasExplicitLineHeight = parseNumber(getAttr(spacing, 'line')) > 0
        parsed.node.attrs = {
          ...parsed.node.attrs,
          lineHeight: hasExplicitLineHeight
            ? parsed.node.attrs.lineHeight
            : 1,
          spaceBefore: 0,
          spaceAfter: 0,
        }
      }

      const isEmptyParagraph =
        parsed.node.type === 'paragraph' &&
        (!parsed.node.content || parsed.node.content.length === 0)
      const isLastParagraph = index === paragraphElements.length - 1
      if (isEmptyParagraph && isLastParagraph) continue

      paragraphs.push(parsed.node)
    }

    return {
      type: 'floating_object',
      attrs: {
        kind: 'textbox',
        alt: getAttr(docPr, 'descr') || getAttr(docPr, 'name') || '',
        title: getAttr(docPr, 'name') || '',
        width: width > 0 ? Math.round(width * EMU_TO_PX) : null,
        height: height > 0 ? Math.round(height * EMU_TO_PX) : null,
        positionX: Math.round(positionX * EMU_TO_PX),
        positionY: Math.round(positionY * EMU_TO_PX),
        relativeFromX: getAttr(positionH, 'relativeFrom') || 'column',
        relativeFromY: getAttr(positionV, 'relativeFrom') || 'paragraph',
        wrap,
        behindDoc: parseBooleanAttr(anchorEl, 'behindDoc'),
        allowOverlap: parseBooleanAttr(anchorEl, 'allowOverlap', true),
        distT: Math.round(parseNumber(getAttr(anchorEl, 'distT')) * EMU_TO_PX),
        distB: Math.round(parseNumber(getAttr(anchorEl, 'distB')) * EMU_TO_PX),
        distL: Math.round(parseNumber(getAttr(anchorEl, 'distL')) * EMU_TO_PX),
        distR: Math.round(parseNumber(getAttr(anchorEl, 'distR')) * EMU_TO_PX),
        paddingTop,
        paddingRight,
        paddingBottom,
        paddingLeft,
        paragraphs,
      },
    }
  }

  const imageNode = await parseImageNode(anchorEl, rels, zip)
  if (!imageNode) return null

  return {
    type: 'floating_object',
    attrs: {
      kind: 'image',
      src: imageNode.attrs?.src ?? '',
      alt: imageNode.attrs?.alt ?? '',
      title: imageNode.attrs?.title ?? '',
      width: imageNode.attrs?.width ?? null,
      height: imageNode.attrs?.height ?? null,
      positionX: Math.round(positionX * EMU_TO_PX),
      positionY: Math.round(positionY * EMU_TO_PX),
      relativeFromX: getAttr(positionH, 'relativeFrom') || 'column',
      relativeFromY: getAttr(positionV, 'relativeFrom') || 'paragraph',
      wrap,
      behindDoc: parseBooleanAttr(anchorEl, 'behindDoc'),
      allowOverlap: parseBooleanAttr(anchorEl, 'allowOverlap', true),
      distT: Math.round(parseNumber(getAttr(anchorEl, 'distT')) * EMU_TO_PX),
      distB: Math.round(parseNumber(getAttr(anchorEl, 'distB')) * EMU_TO_PX),
      distL: Math.round(parseNumber(getAttr(anchorEl, 'distL')) * EMU_TO_PX),
      distR: Math.round(parseNumber(getAttr(anchorEl, 'distR')) * EMU_TO_PX),
      paddingTop: 0,
      paddingRight: 0,
      paddingBottom: 0,
      paddingLeft: 0,
      paragraphs: [],
    },
  }
}

async function parseRunChildNode(
  child: Element,
  result: ParsedRunResult,
  flushText: () => void,
  styleMap: StyleMap,
  paragraphStyle: StyleAttrs,
  themeFonts: ThemeFonts,
  docGridLinePitchPt: number | null,
  numberingMap: NumberingMap,
  rels: RelMap,
  zip: JSZip,
  commentMap: CommentMap,
  linkHref?: string,
  activeCommentMarks: PMCommentMarkJSON[] = []
): Promise<boolean> {
  const localName = getLocalName(child)

  if (localName === 'drawing') {
    flushText()
    const floatingObject = await parseFloatingObjectNode(
      child,
      styleMap,
      paragraphStyle,
      themeFonts,
      docGridLinePitchPt,
      numberingMap,
      rels,
      zip,
      commentMap
    )
    if (floatingObject) {
      result.floatingObjects.push(floatingObject)
      return true
    }
    const imageNode = await parseImageNode(child, rels, zip)
    if (imageNode) result.nodes.push(imageNode)
    return true
  }

  if (localName === 'AlternateContent') {
    const variants = [
      ...directChildren(child, 'Choice'),
      ...directChildren(child, 'Fallback'),
    ]

    for (const variant of variants) {
      const nestedResult: ParsedRunResult = { nodes: [], floatingObjects: [] }
      for (const nestedChild of elementChildren(variant)) {
        const nestedHandled = await parseRunChildNode(
          nestedChild,
          nestedResult,
          flushText,
          styleMap,
          paragraphStyle,
          themeFonts,
          docGridLinePitchPt,
          numberingMap,
          rels,
          zip,
          commentMap,
          linkHref,
          activeCommentMarks
        )
        if (nestedHandled) continue
        if (getLocalName(nestedChild) !== 'r') continue
        const nestedRun = await parseRunNodes(
          nestedChild,
          styleMap,
          paragraphStyle,
          themeFonts,
          docGridLinePitchPt,
          numberingMap,
          rels,
          zip,
          commentMap,
          linkHref,
          activeCommentMarks
        )
        nestedResult.nodes.push(...nestedRun.nodes)
        nestedResult.floatingObjects.push(...nestedRun.floatingObjects)
      }
      if (nestedResult.nodes.length > 0 || nestedResult.floatingObjects.length > 0) {
        result.nodes.push(...nestedResult.nodes)
        result.floatingObjects.push(...nestedResult.floatingObjects)
        return true
      }
    }
    return true
  }

  return false
}

async function parseRunNodes(
  rEl: Element,
  styleMap: StyleMap,
  paragraphStyle: StyleAttrs,
  themeFonts: ThemeFonts,
  docGridLinePitchPt: number | null,
  numberingMap: NumberingMap,
  rels: RelMap,
  zip: JSZip,
  commentMap: CommentMap = new Map(),
  linkHref?: string,
  activeCommentMarks: PMCommentMarkJSON[] = []
): Promise<ParsedRunResult> {
  const rPr = directChild(rEl, 'rPr')
  const styleId = getAttr(directChild(rPr, 'rStyle'), 'val')
  const effectiveStyle = readRunStyle(
    rPr,
    { ...paragraphStyle, ...(styleId ? styleMap[styleId] : {}) },
    themeFonts
  )
  const extraMarks: PMMarkJSON[] = [
    ...(linkHref ? [{ type: 'link', attrs: { href: linkHref } } satisfies PMLinkMarkJSON] : []),
    ...activeCommentMarks,
  ]

  const result: ParsedRunResult = { nodes: [], floatingObjects: [] }
  let textBuffer = ''

  const flushText = () => {
    const node = createTextNode(textBuffer, effectiveStyle, extraMarks)
    if (node) result.nodes.push(node)
    textBuffer = ''
  }

  for (const child of elementChildren(rEl)) {
    const localName = getLocalName(child)
    if (localName === 'rPr') continue
    if (localName === 't' || localName === 'instrText') {
      textBuffer += child.textContent ?? ''
      continue
    }
    if (localName === 'tab') {
      textBuffer += '\t'
      continue
    }
    if (localName === 'noBreakHyphen') {
      textBuffer += '\u2011'
      continue
    }
    if (localName === 'softHyphen') {
      textBuffer += '\u00ad'
      continue
    }
    if (localName === 'br' || localName === 'cr') {
      if (getAttr(child, 'type') === 'page') {
        flushText()
        result.nodes.push({
          type: 'text',
          text: '\n',
          marks: [{
            type: 'textStyle',
            attrs: { ...DEFAULT_TEXT_STYLE, ...effectiveStyle },
          }, ...extraMarks],
        })
        continue
      }
      textBuffer += '\n'
      continue
    }
    if (localName === 'sym') {
      const charCode = getAttr(child, 'char')
      const parsed = Number.parseInt(charCode, 16)
      if (Number.isFinite(parsed)) textBuffer += String.fromCharCode(parsed)
      continue
    }
    const handled = await parseRunChildNode(
      child,
      result,
      flushText,
      styleMap,
      paragraphStyle,
      themeFonts,
      docGridLinePitchPt,
      numberingMap,
      rels,
      zip,
      commentMap,
      linkHref,
      activeCommentMarks
    )
    if (handled) continue
  }

  flushText()
  return result
}

async function parseParagraph(
  pEl: Element,
  styleMap: StyleMap,
  defaultParagraphStyle: StyleAttrs,
  themeFonts: ThemeFonts,
  docGridLinePitchPt: number | null,
  numberingMap: NumberingMap,
  rels: RelMap,
  zip: JSZip,
  commentMap: CommentMap = new Map()
): Promise<ParsedParagraphResult> {
  const pPr = directChild(pEl, 'pPr')
  const styleId = getAttr(directChild(pPr, 'pStyle'), 'val')
  const baseStyle = styleId
    ? styleMap[styleId] ?? { ...defaultParagraphStyle }
    : { ...defaultParagraphStyle }
  const paragraphStyle = { ...baseStyle, ...readParagraphStyle(pPr, baseStyle, docGridLinePitchPt, numberingMap) }

  const content: PMNodeJSON[] = []
  const floatingObjects: PMNodeJSON[] = []

  // Track which comment ids are currently "open" in this paragraph
  const openCommentIds = new Set<string>()

  for (const child of elementChildren(pEl)) {
    const localName = getLocalName(child)
    if (localName === 'pPr') continue

    if (localName === 'commentRangeStart') {
      const id = getAttr(child, 'id')
      if (id) openCommentIds.add(id)
      continue
    }
    if (localName === 'commentRangeEnd') {
      const id = getAttr(child, 'id')
      if (id) openCommentIds.delete(id)
      continue
    }

    // Build active comment marks for runs inside the open range
    const activeCommentMarks: PMCommentMarkJSON[] = Array.from(openCommentIds)
      .map((id) => {
        const info = commentMap.get(id)
        return {
          type: 'comment' as const,
          attrs: {
            id,
            author: info?.author ?? '',
            date: info?.date ?? '',
            content: info?.text ?? '',
          },
        }
      })

    if (localName === 'r') {
      const parsedRun = await parseRunNodes(
        child,
        styleMap,
        paragraphStyle,
        themeFonts,
        docGridLinePitchPt,
        numberingMap,
        rels,
        zip,
        commentMap,
        undefined,
        activeCommentMarks
      )
      content.push(...parsedRun.nodes)
      floatingObjects.push(...parsedRun.floatingObjects)
      continue
    }
    if (localName === 'hyperlink') {
      const relId = getAttr(child, 'id')
      const anchor = getAttr(child, 'anchor')
      const relTarget = relId ? rels[relId]?.target : ''
      const linkHref = relTarget || (anchor ? `#${anchor}` : '')
      for (const run of directChildren(child, 'r')) {
        const parsedRun = await parseRunNodes(
          run,
          styleMap,
          paragraphStyle,
          themeFonts,
          docGridLinePitchPt,
          numberingMap,
          rels,
          zip,
          commentMap,
          linkHref || undefined,
          activeCommentMarks
        )
        content.push(...parsedRun.nodes)
        floatingObjects.push(...parsedRun.floatingObjects)
      }
    }
  }

  const hasVisibleInlineContent = content.some((node) => {
    if (node.type === 'image') return true
    if (node.type !== 'text') return true
    return Boolean(node.text && node.text.length > 0)
  })
  const nonPropertyChildren = elementChildren(pEl).filter((child) => getLocalName(child) !== 'pPr')
  const hasSectionProps = Boolean(directChild(pPr, 'sectPr'))
  const hasOnlyStructuralChildren =
    nonPropertyChildren.length > 0 &&
    nonPropertyChildren.every((child) => {
      const localName = getLocalName(child)
      return [
        'bookmarkStart',
        'bookmarkEnd',
        'commentRangeStart',
        'commentRangeEnd',
        'proofErr',
        'permStart',
        'permEnd',
      ].includes(localName)
    })
  const isStructuralOnlyParagraph =
    !hasVisibleInlineContent &&
    floatingObjects.length === 0 &&
    (hasOnlyStructuralChildren || hasSectionProps)

  if (isStructuralOnlyParagraph) {
    return {
      node: null,
      floatingObjects,
    }
  }

  const attrs: ParagraphAttrs = {
    ...DEFAULT_PARAGRAPH_ATTRS,
    align: paragraphStyle.align ?? DEFAULT_PARAGRAPH_ATTRS.align,
    firstLineIndent: paragraphStyle.firstLineIndent ?? DEFAULT_PARAGRAPH_ATTRS.firstLineIndent,
    indent: paragraphStyle.indent ?? DEFAULT_PARAGRAPH_ATTRS.indent,
    rightIndent: paragraphStyle.rightIndent ?? DEFAULT_PARAGRAPH_ATTRS.rightIndent,
    headingLevel: paragraphStyle.headingLevel ?? DEFAULT_PARAGRAPH_ATTRS.headingLevel,
    fontSizeHint: paragraphStyle.fontSize ?? null,
    fontFamilyHint: paragraphStyle.fontFamily ?? null,
    lineHeight: clampLineHeight(paragraphStyle.lineHeight ?? DEFAULT_PARAGRAPH_ATTRS.lineHeight),
    spaceBefore: paragraphStyle.spaceBefore ?? DEFAULT_PARAGRAPH_ATTRS.spaceBefore,
    spaceAfter: paragraphStyle.spaceAfter ?? DEFAULT_PARAGRAPH_ATTRS.spaceAfter,
    pageBreakBefore: paragraphStyle.pageBreakBefore ?? DEFAULT_PARAGRAPH_ATTRS.pageBreakBefore,
    tabStops: paragraphStyle.tabStops ?? DEFAULT_PARAGRAPH_ATTRS.tabStops,
  }

  return {
    node: {
      type: 'paragraph',
      attrs,
      content: hasVisibleInlineContent ? content : [],
    },
    floatingObjects,
  }
}

async function parseTableCell(
  tcEl: Element,
  isHeader: boolean,
  styleMap: StyleMap,
  defaultParagraphStyle: StyleAttrs,
  themeFonts: ThemeFonts,
  docGridLinePitchPt: number | null,
  numberingMap: NumberingMap,
  rels: RelMap,
  zip: JSZip,
  commentMap: CommentMap = new Map()
): Promise<{ node?: PMNodeJSON; colspan: number; continueMerge: boolean }> {
  const tcPr = directChild(tcEl, 'tcPr')
  const colspan = Math.max(1, parseNumber(getAttr(directChild(tcPr, 'gridSpan'), 'val'), 1))
  const vMerge = directChild(tcPr, 'vMerge')
  const vMergeVal = getAttr(vMerge, 'val')
  const continueMerge = !!vMerge && vMergeVal !== 'restart'

  if (continueMerge) {
    return { colspan, continueMerge }
  }

  const tcWidth = directChild(tcPr, 'tcW')
  const widthType = getAttr(tcWidth, 'type')
  const rawWidth = parseNumber(getAttr(tcWidth, 'w'))
  const width = widthType === 'dxa' && rawWidth > 0 ? `${Math.round(twipToPx(rawWidth))}px` : null
  const shading = directChild(tcPr, 'shd')
  const backgroundColor = normalizeFill(getAttr(shading, 'fill'))
  const borders = directChild(tcPr, 'tcBorders')
  const firstBorder = directChild(borders, 'top')
    ?? directChild(borders, 'left')
    ?? directChild(borders, 'start')
    ?? directChild(borders, 'bottom')
    ?? directChild(borders, 'right')
    ?? directChild(borders, 'end')
  const borderColor = normalizeFill(getAttr(firstBorder, 'color')) || '#cccccc'
  const rawBorderSize = parseNumber(getAttr(firstBorder, 'sz'), 8)
  const borderWidth = Math.max(0, Math.round((rawBorderSize / 8) * (96 / 72) * 10) / 10)

  const content: PMNodeJSON[] = []
  for (const child of elementChildren(tcEl)) {
    const localName = getLocalName(child)
    if (localName === 'p') {
      const parsed = await parseParagraph(child, styleMap, defaultParagraphStyle, themeFonts, docGridLinePitchPt, numberingMap, rels, zip, commentMap)
      if (parsed.node) content.push(parsed.node)
    }
  }

  return {
    colspan,
    continueMerge: false,
    node: {
      type: 'table_cell',
      attrs: {
        header: isHeader,
        colspan,
        rowspan: 1,
        width,
        backgroundColor,
        borderColor,
        borderWidth,
      },
      content: content.length > 0 ? content : [{ type: 'paragraph', attrs: DEFAULT_PARAGRAPH_ATTRS, content: [] }],
    },
  }
}

async function parseTable(
  tblEl: Element,
  styleMap: StyleMap,
  defaultParagraphStyle: StyleAttrs,
  themeFonts: ThemeFonts,
  docGridLinePitchPt: number | null,
  numberingMap: NumberingMap,
  rels: RelMap,
  zip: JSZip,
  commentMap: CommentMap = new Map()
): Promise<PMNodeJSON> {
  const rows: PMNodeJSON[] = []
  const mergeAnchors = new Map<number, PMNodeJSON>()

  for (const trEl of directChildren(tblEl, 'tr')) {
    const trPr = directChild(trEl, 'trPr')
    const isHeader = !!directChild(trPr, 'tblHeader')
    const rowCells: PMNodeJSON[] = []
    let columnIndex = 0

    for (const tcEl of directChildren(trEl, 'tc')) {
      const parsedCell = await parseTableCell(tcEl, isHeader, styleMap, defaultParagraphStyle, themeFonts, docGridLinePitchPt, numberingMap, rels, zip, commentMap)
      const colspan = parsedCell.colspan

      if (parsedCell.continueMerge) {
        for (let offset = 0; offset < colspan; offset += 1) {
          const anchor = mergeAnchors.get(columnIndex + offset)
          if (anchor) {
            const prev = Number(anchor.attrs?.rowspan ?? 1)
            anchor.attrs = { ...anchor.attrs, rowspan: prev + 1 }
          }
        }
        columnIndex += colspan
        continue
      }

      if (parsedCell.node) {
        rowCells.push(parsedCell.node)
        const hasRestart = !!directChild(directChild(tcEl, 'tcPr'), 'vMerge')
        for (let offset = 0; offset < colspan; offset += 1) {
          if (hasRestart) mergeAnchors.set(columnIndex + offset, parsedCell.node)
          else mergeAnchors.delete(columnIndex + offset)
        }
      }

      columnIndex += colspan
    }

    rows.push({
      type: 'table_row',
      content: rowCells.length > 0 ? rowCells : [{
        type: 'table_cell',
        attrs: { header: isHeader, colspan: 1, rowspan: 1, width: null },
        content: [{ type: 'paragraph', attrs: DEFAULT_PARAGRAPH_ATTRS, content: [] }],
      }],
    })
  }

  return { type: 'table', content: rows }
}

function parseTableOfContents(sdtEl: Element): PMNodeJSON | null {
  const allText = Array.from(sdtEl.getElementsByTagName('*'))
    .filter((element) => getLocalName(element) === 'instrText')
    .map((element) => element.textContent ?? '')
    .join(' ')
  if (!/\bTOC\b/i.test(allText)) return null

  const rangeMatch = allText.match(/\\o\s+"?([1-6])-([1-6])"?/i)
  const minLevel = rangeMatch ? Number(rangeMatch[1]) : 1
  const maxLevel = rangeMatch ? Number(rangeMatch[2]) : 3
  const alias = findDescendant(sdtEl, 'alias')
  const rawTitle = getAttr(alias, 'val')
  const title = rawTitle && rawTitle !== 'Table of Contents' ? rawTitle : '目录'

  return {
    type: 'table_of_contents',
    attrs: {
      title,
      minLevel,
      maxLevel: Math.max(minLevel, maxLevel),
      hyperlink: /\\h\b/i.test(allText),
    },
  }
}

async function parseDocument(
  documentXml: string,
  styleMap: StyleMap,
  defaultParagraphStyle: StyleAttrs,
  themeFonts: ThemeFonts,
  docGridLinePitchPt: number | null,
  numberingMap: NumberingMap,
  rels: RelMap,
  zip: JSZip,
  commentMap: CommentMap = new Map()
): Promise<PMNodeJSON> {
  const dom = parseXml(documentXml)
  const body = dom.getElementsByTagNameNS(W_NS, 'body')[0]
  const content: PMNodeJSON[] = []

  for (const child of elementChildren(body)) {
    const localName = getLocalName(child)
    if (localName === 'p') {
      const parsed = await parseParagraph(child, styleMap, defaultParagraphStyle, themeFonts, docGridLinePitchPt, numberingMap, rels, zip, commentMap)
      const para = parsed.node
      if (!para) {
        if (parsed.floatingObjects.length > 0) content.push(...parsed.floatingObjects)
        continue
      }
      // 跳过开头的连续空段落
      const isEmpty = !para.content || para.content.length === 0 ||
        para.content.every((n: PMNodeJSON) => n.type === 'text' && !n.text?.trim())
      if (isEmpty && content.length === 0) continue
      // 文档第一个有内容的段落去掉 spaceBefore（防止标题段前间距把内容往下推）
      const isFirstContent = content.length === 0 || content.every((n: PMNodeJSON) => {
        if (n.type !== 'paragraph') return false
        return !n.content || n.content.length === 0 ||
          n.content.every((c: PMNodeJSON) => c.type === 'text' && !c.text?.trim())
      })
      if (isFirstContent && !isEmpty && para.attrs) {
        para.attrs = { ...para.attrs, spaceBefore: 0 }
      }
      content.push(para)
      if (parsed.floatingObjects.length > 0) content.push(...parsed.floatingObjects)
      continue
    }
    if (localName === 'tbl') {
      content.push(await parseTable(child, styleMap, defaultParagraphStyle, themeFonts, docGridLinePitchPt, numberingMap, rels, zip, commentMap))
    }
    if (localName === 'sdt') {
      const toc = parseTableOfContents(child)
      if (toc) content.push(toc)
    }
  }

  return {
    type: 'doc',
    content: content.length > 0 ? content : [{ type: 'paragraph', attrs: DEFAULT_PARAGRAPH_ATTRS, content: [] }],
  }
}

export async function importDocx(file: File): Promise<DocxImportResult> {
  const zip = await JSZip.loadAsync(file)
  const documentXml = await zip.file('word/document.xml')?.async('string')
  if (!documentXml) throw new Error('DOCX 缺少 word/document.xml')

  const stylesXml = await zip.file('word/styles.xml')?.async('string') ?? ''
  const settingsXml = await zip.file('word/settings.xml')?.async('string') ?? ''
  const relsXml = await zip.file('word/_rels/document.xml.rels')?.async('string') ?? ''
  const numberingXml = await zip.file('word/numbering.xml')?.async('string') ?? ''
  const themeXml = await zip.file('word/theme/theme1.xml')?.async('string') ?? ''
  const commentsXml = await zip.file('word/comments.xml')?.async('string') ?? ''

  const rels = parseRels(relsXml)
  const numberingMap = parseNumbering(numberingXml)
  const themeFonts = parseThemeFonts(themeXml)
  const commentMap = parseComments(commentsXml)
  const docDefaults = parseStyleDefaults(stylesXml, themeFonts)
  const { styleMap, defaultParagraphStyle } = parseStyles(stylesXml, themeFonts, docDefaults, numberingMap)
  const { pageConfig, docGridLinePitchPt } = parseDocumentLayout(documentXml)
  const typography = parseTypographySettings(settingsXml)
  const doc = await parseDocument(
    documentXml,
    styleMap,
    defaultParagraphStyle,
    themeFonts,
    docGridLinePitchPt,
    numberingMap,
    rels,
    zip,
    commentMap
  )

  return { doc, pageConfig, docGridLinePitchPt, typography }
}
