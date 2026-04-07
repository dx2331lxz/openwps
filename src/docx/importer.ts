import JSZip from 'jszip'
import type { PageConfig } from '../layout/paginator'

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const TWIP_TO_PX = 96 / 1440
const TWIP_TO_PT = 1 / 20
const EMU_TO_PX = 1 / 9525

type Align = 'left' | 'center' | 'right' | 'justify'

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
  lineHeight: number
  spaceBefore: number
  spaceAfter: number
  listType: null
  listLevel: number
  pageBreakBefore: boolean
}

type PMMarkJSON = {
  type: 'textStyle'
  attrs: TextStyleAttrs
}

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
}

type StyleAttrs = Partial<TextStyleAttrs & Pick<ParagraphAttrs, 'align' | 'firstLineIndent' | 'lineHeight' | 'spaceBefore' | 'spaceAfter' | 'pageBreakBefore'>>

interface RawStyle {
  basedOn?: string
  attrs: StyleAttrs
}

type StyleMap = Record<string, StyleAttrs>
type RelMap = Record<string, string>

const DEFAULT_TEXT_STYLE: TextStyleAttrs = {
  fontFamily: 'SimSun, 宋体, serif',
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
  lineHeight: 1.5,
  spaceBefore: 0,
  spaceAfter: 0,
  listType: null,
  listLevel: 0,
  pageBreakBefore: false,
}

function normalizeFont(name: string): string {
  const trimmed = name.trim()
  const map: Record<string, string> = {
    '宋体': 'SimSun, 宋体, serif',
    'SimSun': 'SimSun, 宋体, serif',
    '黑体': 'SimHei, 黑体, sans-serif',
    'SimHei': 'SimHei, 黑体, sans-serif',
    '楷体': 'KaiTi, 楷体, cursive',
    '楷体_GB2312': 'KaiTi, 楷体, cursive',
    '仿宋': 'FangSong, 仿宋, serif',
    '仿宋_GB2312': 'FangSong, 仿宋, serif',
    '微软雅黑': 'Microsoft YaHei, 微软雅黑, sans-serif',
    'Microsoft YaHei': 'Microsoft YaHei, 微软雅黑, sans-serif',
    'Times New Roman': 'Times New Roman, serif',
    'Arial': 'Arial, sans-serif',
    'Calibri': 'Calibri, Arial, sans-serif',
  }

  if (!trimmed || /--/.test(trimmed) || /[A-Z]{2,}\d/.test(trimmed)) {
    return DEFAULT_TEXT_STYLE.fontFamily
  }

  return map[trimmed] ?? trimmed
}

function clampLineHeight(value: number, fallback = DEFAULT_PARAGRAPH_ATTRS.lineHeight) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(3, Math.max(1, value))
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

function mimeFromPath(path: string) {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  return 'application/octet-stream'
}

function createTextNode(text: string, attrs: Partial<TextStyleAttrs>): PMNodeJSON | null {
  if (!text) return null
  return {
    type: 'text',
    text,
    marks: [{
      type: 'textStyle',
      attrs: { ...DEFAULT_TEXT_STYLE, ...attrs },
    }],
  }
}

function readParagraphStyle(pPr: Element | undefined, inherited: StyleAttrs): StyleAttrs {
  if (!pPr) return {}

  const alignMap: Record<string, Align> = {
    left: 'left',
    start: 'left',
    center: 'center',
    right: 'right',
    both: 'justify',
    justify: 'justify',
  }

  const attrs: StyleAttrs = {}
  const jc = getAttr(directChild(pPr, 'jc'), 'val')
  if (jc) attrs.align = alignMap[jc] ?? 'left'

  const baseFontSize = inherited.fontSize ?? DEFAULT_TEXT_STYLE.fontSize
  const ind = directChild(pPr, 'ind')
  const firstLine = parseNumber(getAttr(ind, 'firstLine'))
  if (firstLine > 0) attrs.firstLineIndent = twipToEm(firstLine, baseFontSize)

  const spacing = directChild(pPr, 'spacing')
  const before = parseNumber(getAttr(spacing, 'before'))
  const after = parseNumber(getAttr(spacing, 'after'))
  const line = parseNumber(getAttr(spacing, 'line'))
  const lineRule = getAttr(spacing, 'lineRule') || 'auto'

  if (before > 0) attrs.spaceBefore = twipToPt(before)
  if (after > 0) attrs.spaceAfter = twipToPt(after)
  if (line > 0) {
    if (lineRule === 'auto') attrs.lineHeight = line / 240
    else attrs.lineHeight = twipToPt(line) / baseFontSize
  }

  if (truthyElement(directChild(pPr, 'pageBreakBefore'))) attrs.pageBreakBefore = true

  return attrs
}

function readRunStyle(rPr: Element | undefined, inherited: StyleAttrs): StyleAttrs {
  if (!rPr) return {}

  const attrs: StyleAttrs = {}
  const fonts = directChild(rPr, 'rFonts')
  const fontFamily = getAttr(fonts, 'eastAsia') || getAttr(fonts, 'ascii') || getAttr(fonts, 'hAnsi')
  if (fontFamily) attrs.fontFamily = normalizeFont(fontFamily)

  const size = parseNumber(getAttr(directChild(rPr, 'sz'), 'val'))
  if (size > 0) attrs.fontSize = halfPtToPt(size)

  const color = getAttr(directChild(rPr, 'color'), 'val')
  if (color) attrs.color = normalizeColor(color)

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

function parseStyles(stylesXml: string): StyleMap {
  if (!stylesXml) return {}

  const dom = parseXml(stylesXml)
  const rawStyles: Record<string, RawStyle> = {}

  for (const styleEl of Array.from(dom.getElementsByTagNameNS(W_NS, 'style'))) {
    const styleId = getAttr(styleEl, 'styleId')
    if (!styleId) continue

    const basedOn = getAttr(directChild(styleEl, 'basedOn'), 'val') || undefined
    const pPr = directChild(styleEl, 'pPr')
    const rPr = directChild(styleEl, 'rPr')
    const runAttrs = readRunStyle(rPr, {})
    const paraAttrs = readParagraphStyle(pPr, runAttrs)
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
      return {}
    }

    const base = raw.basedOn ? resolveStyle(raw.basedOn) : {}
    const merged = { ...base, ...raw.attrs }
    resolved[styleId] = merged
    resolving.delete(styleId)
    return merged
  }

  Object.keys(rawStyles).forEach(resolveStyle)
  return resolved
}

function parseRels(relsXml: string): RelMap {
  if (!relsXml) return {}
  const dom = parseXml(relsXml)
  const rels: RelMap = {}

  for (const rel of Array.from(dom.getElementsByTagName('Relationship'))) {
    const id = getAttr(rel, 'Id')
    const target = getAttr(rel, 'Target')
    if (id && target) rels[id] = relTargetToZipPath(target)
  }

  return rels
}

function parsePageConfig(documentXml: string): PageConfig {
  const dom = parseXml(documentXml)
  const sectPr = findDescendant(dom, 'sectPr')
  const pgSz = directChild(sectPr, 'pgSz')
  const pgMar = directChild(sectPr, 'pgMar')

  const widthTwip = parseNumber(getAttr(pgSz, 'w'), 11906)
  const heightTwip = parseNumber(getAttr(pgSz, 'h'), 16838)
  const marginTopTwip = parseNumber(getAttr(pgMar, 'top'), 1440)
  const marginBottomTwip = parseNumber(getAttr(pgMar, 'bottom'), 1440)
  const marginLeftTwip = parseNumber(getAttr(pgMar, 'left'), 1800)
  const marginRightTwip = parseNumber(getAttr(pgMar, 'right'), 1800)

  return {
    pageWidth: Math.round(twipToPx(widthTwip)),
    pageHeight: Math.round(twipToPx(heightTwip)),
    marginTop: Math.round(twipToPx(marginTopTwip)),
    marginBottom: Math.round(twipToPx(marginBottomTwip)),
    marginLeft: Math.round(twipToPx(marginLeftTwip)),
    marginRight: Math.round(twipToPx(marginRightTwip)),
  }
}

async function parseImageNode(drawingEl: Element, rels: RelMap, zip: JSZip): Promise<PMNodeJSON | null> {
  const blip = findDescendant(drawingEl, 'blip')
  const relId = getAttr(blip, 'embed')
  if (!relId || !rels[relId]) return null

  const target = rels[relId]
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

async function parseRunNodes(rEl: Element, styleMap: StyleMap, paragraphStyle: StyleAttrs, rels: RelMap, zip: JSZip): Promise<PMNodeJSON[]> {
  const rPr = directChild(rEl, 'rPr')
  const styleId = getAttr(directChild(rPr, 'rStyle'), 'val')
  const effectiveStyle = readRunStyle(rPr, { ...paragraphStyle, ...(styleId ? styleMap[styleId] : {}) })

  const nodes: PMNodeJSON[] = []
  let textBuffer = ''

  const flushText = () => {
    const node = createTextNode(textBuffer, effectiveStyle)
    if (node) nodes.push(node)
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
    if (localName === 'br' || localName === 'cr') {
      textBuffer += '\n'
      continue
    }
    if (localName === 'drawing') {
      flushText()
      const imageNode = await parseImageNode(child, rels, zip)
      if (imageNode) nodes.push(imageNode)
    }
  }

  flushText()
  return nodes
}

async function parseParagraph(pEl: Element, styleMap: StyleMap, rels: RelMap, zip: JSZip): Promise<PMNodeJSON> {
  const pPr = directChild(pEl, 'pPr')
  const styleId = getAttr(directChild(pPr, 'pStyle'), 'val')
  const baseStyle = styleId ? styleMap[styleId] ?? {} : {}
  const paragraphStyle = { ...baseStyle, ...readParagraphStyle(pPr, baseStyle) }

  const content: PMNodeJSON[] = []

  for (const child of elementChildren(pEl)) {
    const localName = getLocalName(child)
    if (localName === 'pPr') continue
    if (localName === 'r') {
      content.push(...await parseRunNodes(child, styleMap, paragraphStyle, rels, zip))
      continue
    }
    if (localName === 'hyperlink') {
      for (const run of directChildren(child, 'r')) {
        content.push(...await parseRunNodes(run, styleMap, paragraphStyle, rels, zip))
      }
    }
  }

  const isTrulyEmpty = content.length === 0

  const attrs: ParagraphAttrs = {
    ...DEFAULT_PARAGRAPH_ATTRS,
    align: paragraphStyle.align ?? DEFAULT_PARAGRAPH_ATTRS.align,
    firstLineIndent: paragraphStyle.firstLineIndent ?? DEFAULT_PARAGRAPH_ATTRS.firstLineIndent,
    lineHeight: isTrulyEmpty
      ? clampLineHeight(paragraphStyle.lineHeight ?? DEFAULT_PARAGRAPH_ATTRS.lineHeight)
      : (paragraphStyle.lineHeight ?? DEFAULT_PARAGRAPH_ATTRS.lineHeight),
    spaceBefore: paragraphStyle.spaceBefore ?? DEFAULT_PARAGRAPH_ATTRS.spaceBefore,
    spaceAfter: paragraphStyle.spaceAfter ?? DEFAULT_PARAGRAPH_ATTRS.spaceAfter,
    pageBreakBefore: paragraphStyle.pageBreakBefore ?? DEFAULT_PARAGRAPH_ATTRS.pageBreakBefore,
  }

  return {
    type: 'paragraph',
    attrs,
    content: isTrulyEmpty ? [createTextNode('', paragraphStyle) ?? { type: 'text', text: '' }] : content,
  }
}

async function parseTableCell(tcEl: Element, isHeader: boolean, styleMap: StyleMap, rels: RelMap, zip: JSZip): Promise<{ node?: PMNodeJSON; colspan: number; continueMerge: boolean }> {
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

  const content: PMNodeJSON[] = []
  for (const child of elementChildren(tcEl)) {
    const localName = getLocalName(child)
    if (localName === 'p') {
      content.push(await parseParagraph(child, styleMap, rels, zip))
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
      },
      content: content.length > 0 ? content : [{ type: 'paragraph', attrs: DEFAULT_PARAGRAPH_ATTRS, content: [] }],
    },
  }
}

async function parseTable(tblEl: Element, styleMap: StyleMap, rels: RelMap, zip: JSZip): Promise<PMNodeJSON> {
  const rows: PMNodeJSON[] = []
  const mergeAnchors = new Map<number, PMNodeJSON>()

  for (const trEl of directChildren(tblEl, 'tr')) {
    const trPr = directChild(trEl, 'trPr')
    const isHeader = !!directChild(trPr, 'tblHeader')
    const rowCells: PMNodeJSON[] = []
    let columnIndex = 0

    for (const tcEl of directChildren(trEl, 'tc')) {
      const parsedCell = await parseTableCell(tcEl, isHeader, styleMap, rels, zip)
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

async function parseDocument(documentXml: string, styleMap: StyleMap, rels: RelMap, zip: JSZip): Promise<PMNodeJSON> {
  const dom = parseXml(documentXml)
  const body = dom.getElementsByTagNameNS(W_NS, 'body')[0]
  const content: PMNodeJSON[] = []

  for (const child of elementChildren(body)) {
    const localName = getLocalName(child)
    if (localName === 'p') {
      content.push(await parseParagraph(child, styleMap, rels, zip))
      continue
    }
    if (localName === 'tbl') {
      content.push(await parseTable(child, styleMap, rels, zip))
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
  const relsXml = await zip.file('word/_rels/document.xml.rels')?.async('string') ?? ''

  const rels = parseRels(relsXml)
  const styleMap = parseStyles(stylesXml)
  const pageConfig = parsePageConfig(documentXml)
  const doc = await parseDocument(documentXml, styleMap, rels, zip)

  return { doc, pageConfig }
}
