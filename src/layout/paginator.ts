import { prepareWithSegments } from '@chenglou/pretext'
import type { Node as PMNode } from 'prosemirror-model'
import { DEFAULT_EDITOR_FONT_STACK, FONT_STACKS } from '../fonts'

export interface PageConfig {
  pageWidth: number
  pageHeight: number
  marginTop: number
  marginBottom: number
  marginLeft: number
  marginRight: number
}

export const DEFAULT_PAGE_CONFIG: PageConfig = {
  pageWidth: 794,
  pageHeight: 1123,
  marginTop: 96,
  marginBottom: 96,
  marginLeft: 113,
  marginRight: 113,
}

export interface LineInfo {
  text: string
  blockIndex: number
  blockPos: number
  blockType: string
  lineIndex: number
  lineHeight: number
  startPos: number | null
}

export interface RenderTextStyle {
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

export interface RenderUnit {
  text: string
  startPos: number | null
  endPos: number | null
  style: RenderTextStyle
  hasComment: boolean
  hasLink: boolean
  width: number
  renderWidth: number
  glyphWidth: number
  anchor: 'start' | 'end'
  offsetX?: number
}

export interface RenderedLine extends LineInfo {
  units: RenderUnit[]
  align: 'left' | 'center' | 'right' | 'justify'
  availableWidth: number
  xOffset: number
  usedWidth: number
  renderedWidth: number
  isLastLineOfParagraph: boolean
  listType?: 'task' | 'bullet' | 'ordered' | null
  listChecked?: boolean
  listIndex?: number
  lineStyle?: string
  lineColor?: string
  tocTitle?: string
  tocLevelRange?: string
  tocHyperlink?: boolean
  tocEntries?: RenderedTableOfContentsEntry[]
  table?: RenderedTable
}

export interface RenderedTableOfContentsEntry {
  title: string
  level: number
  page: number | null
  blockIndex: number
}

export interface RenderedTableCell {
  text: string
  paragraphs: string[]
  firstTextPos: number | null
  colspan: number
  rowspan: number
  header: boolean
  backgroundColor: string
  borderColor: string
  borderWidth: number
  width: number
  height: number
}

export interface RenderedTableRow {
  height: number
  cells: RenderedTableCell[]
}

export interface RenderedTable {
  rows: RenderedTableRow[]
  width: number
  height: number
}

export interface FloatingTextRun {
  text: string
  style: RenderTextStyle
  hasComment: boolean
  hasLink: boolean
}

export interface FloatingParagraph {
  align: 'left' | 'center' | 'right' | 'justify'
  lineHeight: number
  runs: FloatingTextRun[]
}

export interface RenderedFloatingObject {
  blockIndex: number
  blockPos: number
  kind: 'image' | 'textbox'
  left: number
  top: number
  width: number
  height: number
  paddingTop: number
  paddingRight: number
  paddingBottom: number
  paddingLeft: number
  wrap: string
  behindDoc: boolean
  src?: string
  alt?: string
  title?: string
  paragraphs: FloatingParagraph[]
}

export interface PageLayout {
  lines: LineInfo[]
  totalHeight: number
}

export interface RenderedPage {
  lines: Array<RenderedLine & { top: number }>
  totalHeight: number
  floatingObjects: RenderedFloatingObject[]
}

export interface PageBreakInfo {
  pos: number
  pageIndex: number
  prevPageUsed: number
}

export interface PaginateResult {
  pages: PageLayout[]
  renderedPages: RenderedPage[]
  breaks: PageBreakInfo[]
  lineBreaks: number[]
}

export interface DomBlockMetric {
  pos: number
  blockIndex: number
  blockType: string
  height: number
  marginTop: number
  marginBottom: number
  table?: {
    width: number
    rows: Array<{
      height: number
      cells: Array<{
        width: number
        height: number
      }>
    }>
  }
}

export interface PaginateOptions {
  domBlockMetrics?: readonly DomBlockMetric[]
}

const PRETEXT_LAYOUT_SAFETY_PX = 2
const IMAGE_NODE_VERTICAL_CHROME_PX = 4
const COMPRESSIBLE_PUNCT_RE = /^[，。、；：！？,.!?:;、（）()〈〉《》「」『』【】〔〕〖〗〘〙〚〛‘’“”…]+$/
const TABLE_BLOCK_MARGIN_PX = 8
const TABLE_CELL_HORIZONTAL_PADDING_PX = 16
const TABLE_CELL_VERTICAL_CHROME_PX = 10
const TABLE_MIN_ROW_HEIGHT_PX = 34

interface MeasuredBlock {
  lines: RenderedLine[]
  totalHeight: number
  canSplit: boolean
  spaceBefore: number
  spaceAfter: number
}

interface DocumentHeading {
  title: string
  level: number
  blockIndex: number
}

interface MeasureUnit {
  displayText: string
  measuredText: string
  style: RenderTextStyle
  hasComment: boolean
  hasLink: boolean
  fontStr: string
  width: number
  compressedWidth: number
  compressionCapacity: number
  sourceCharCount: number
  startPos: number | null
  endPos: number | null
}

interface FittedLine {
  text: string
  sourceCharCount: number
  units: RenderUnit[]
  usedWidth: number
  renderedWidth: number
  availableWidth: number
}

interface FittedGroup {
  lines: FittedLine[]
}

const HAN_CHAR_RE = /\p{Script=Han}/u
const LATIN_ALPHA_RE = /[A-Za-z]/
const OPENING_PUNCT_RE = /^[（(〈《「『【〔〖〘〚“‘]$/
const END_ANCHORED_PUNCT_RE = /^[，。、；：！？,.!?:;、）)〉》」』】〕〗〙〛”’…]$/
const TEXT_COMPRESSION_TRIGGER_RATIO = 0.42
const TEXT_COMPRESSION_MAX_RATIO = 0.65

const DEFAULT_TEXT_STYLE: RenderTextStyle = {
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

function ptToPx(pt: number): number {
  return (pt * 96) / 72
}

function resolveTextStyle(node: PMNode, baseStyle: Partial<RenderTextStyle> = {}): RenderTextStyle {
  const fallback = { ...DEFAULT_TEXT_STYLE, ...baseStyle }
  const mark = node.marks.find((item) => item.type.name === 'textStyle')
  if (!mark) return fallback

  return {
    fontFamily: mark.attrs.fontFamily || fallback.fontFamily,
    fontSize: mark.attrs.fontSize || fallback.fontSize,
    color: mark.attrs.color || fallback.color,
    backgroundColor: mark.attrs.backgroundColor || fallback.backgroundColor,
    bold: mark.attrs.bold == null ? Boolean(fallback.bold) : Boolean(mark.attrs.bold),
    italic: mark.attrs.italic == null ? Boolean(fallback.italic) : Boolean(mark.attrs.italic),
    underline: mark.attrs.underline == null ? Boolean(fallback.underline) : Boolean(mark.attrs.underline),
    strikethrough: mark.attrs.strikethrough == null ? Boolean(fallback.strikethrough) : Boolean(mark.attrs.strikethrough),
    superscript: mark.attrs.superscript == null ? Boolean(fallback.superscript) : Boolean(mark.attrs.superscript),
    subscript: mark.attrs.subscript == null ? Boolean(fallback.subscript) : Boolean(mark.attrs.subscript),
    letterSpacing: Number(mark.attrs.letterSpacing) || 0,
  }
}

function getParagraphTextStyle(paraNode: PMNode) {
  let fontFamily = String(paraNode.attrs.fontFamilyHint ?? DEFAULT_TEXT_STYLE.fontFamily)
  let fontSize = Number(paraNode.attrs.fontSizeHint ?? DEFAULT_TEXT_STYLE.fontSize)
  const headingLevel = Number(paraNode.attrs.headingLevel ?? 0)
  const bold = headingLevel >= 1 && headingLevel <= 3

  paraNode.forEach((child) => {
    if ((child.isText || child.type.name === 'image') && child.marks.length > 0) {
      const style = resolveTextStyle(child)
      fontFamily = style.fontFamily || fontFamily
      fontSize = style.fontSize || fontSize
    }
  })

  return { fontFamily, fontSize, bold }
}

function getParagraphBaseTextStyle(paraNode: PMNode): RenderTextStyle {
  const headingLevel = Number(paraNode.attrs.headingLevel ?? 0)
  const headingSizes: Record<number, number> = {
    1: 22,
    2: 18,
    3: 16,
    4: 14,
    5: 12,
    6: 10.5,
    7: 10.5,
    8: 9,
    9: 9,
  }
  return {
    ...DEFAULT_TEXT_STYLE,
    fontFamily: String(paraNode.attrs.fontFamilyHint ?? (headingLevel >= 1 && headingLevel <= 6 ? FONT_STACKS.hei : DEFAULT_TEXT_STYLE.fontFamily)),
    fontSize: Number(paraNode.attrs.fontSizeHint ?? headingSizes[headingLevel] ?? DEFAULT_TEXT_STYLE.fontSize),
    bold: headingLevel >= 1 && headingLevel <= 8,
  }
}

function textStyleToFontStr(style: RenderTextStyle) {
  const normalizedStyle = { ...DEFAULT_TEXT_STYLE, ...(style ?? {}) }
  const fontSizePx = ptToPx(normalizedStyle.fontSize)
  const fontStyle = normalizedStyle.italic ? 'italic ' : ''
  const fontWeight = normalizedStyle.bold ? '700 ' : ''
  return `${fontStyle}${fontWeight}${fontSizePx}px ${normalizedStyle.fontFamily}`
}

function isHanChar(char: string) {
  return HAN_CHAR_RE.test(char)
}

function isLatinAlphaChar(char: string) {
  return LATIN_ALPHA_RE.test(char)
}

function shouldInsertMixedScriptGap(prevChar: string, nextChar: string) {
  return (
    (isLatinAlphaChar(prevChar) && isHanChar(nextChar)) ||
    (isHanChar(prevChar) && isLatinAlphaChar(nextChar))
  )
}

let measureCanvasContext: CanvasRenderingContext2D | null = null

function getMeasureCanvasContext() {
  if (measureCanvasContext) return measureCanvasContext
  const canvas = document.createElement('canvas')
  measureCanvasContext = canvas.getContext('2d')
  return measureCanvasContext
}

function measureAdvanceWidth(text: string, fontStr: string) {
  const ctx = getMeasureCanvasContext()
  if (!ctx) return 0
  ctx.font = fontStr
  return ctx.measureText(text).width
}

function measureCompressedLineEndWidth(text: string, fontStr: string) {
  const ctx = getMeasureCanvasContext()
  if (!ctx) return measureAdvanceWidth(text, fontStr)
  ctx.font = fontStr

  let totalWidth = 0
  for (const char of Array.from(text)) {
    const metrics = ctx.measureText(char)
    const inkWidth = Math.max(
      0,
      (metrics.actualBoundingBoxLeft ?? 0) + (metrics.actualBoundingBoxRight ?? 0)
    )
    totalWidth += inkWidth > 0 ? Math.min(metrics.width, inkWidth) : metrics.width
  }

  return totalWidth
}

function normalizeMeasuredChar(char: string) {
  return char
}

function isCompressiblePunctuation(char: string) {
  return COMPRESSIBLE_PUNCT_RE.test(char)
}

function isOpeningPunctuation(char: string) {
  return OPENING_PUNCT_RE.test(char)
}

function isEndAnchoredPunctuation(char: string) {
  return END_ANCHORED_PUNCT_RE.test(char)
}

function getPunctuationAnchor(char: string): 'start' | 'end' {
  if (isOpeningPunctuation(char)) return 'end'
  if (isEndAnchoredPunctuation(char)) return 'start'
  return 'start'
}

interface SourceChar {
  char: string
  style: RenderTextStyle
  hasComment: boolean
  hasLink: boolean
  startPos: number | null
  endPos: number | null
}

function extractParagraphSourceChars(paraNode: PMNode, paraPos: number): SourceChar[] | null {
  if (!paragraphHasOnlyTextInlines(paraNode)) return null

  const chars: SourceChar[] = []
  const contentStart = paraPos + 1
  const paragraphBaseStyle = getParagraphBaseTextStyle(paraNode)
  paraNode.forEach((child, offset) => {
    if (!child.isText) return
    const text = child.text ?? ''
    const childStart = contentStart + offset
    const style = resolveTextStyle(child, paragraphBaseStyle)

    for (let index = 0; index < text.length; index += 1) {
      chars.push({
        char: text[index] ?? '',
        style,
        hasComment: child.marks.some((mark) => mark.type.name === 'comment'),
        hasLink: child.marks.some((mark) => mark.type.name === 'link'),
        startPos: childStart + index,
        endPos: childStart + index + 1,
      })
    }
  })

  return chars
}

function splitSourceCharsByNewline(chars: SourceChar[]): SourceChar[][] {
  const groups: SourceChar[][] = [[]]

  chars.forEach((char) => {
    if (char.char === '\n') {
      groups.push([])
      return
    }
    groups[groups.length - 1]!.push(char)
  })

  return groups
}

function parseParagraphTabStops(rawTabStops: unknown) {
  if (!Array.isArray(rawTabStops)) return []

  return rawTabStops
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item): { align: 'left' | 'center' | 'right'; position: number } => {
      const rawAlign = String(item.align ?? 'left')
      return {
        align: rawAlign === 'center' || rawAlign === 'right' ? rawAlign : 'left',
        position: Math.max(0, Number(item.position) || 0),
      }
    })
    .filter((item) => item.position > 0)
    .sort((a, b) => a.position - b.position)
}

function assignMeasuredWidths(units: MeasureUnit[]) {
  if (!units.length) return

  let startIndex = 0
  while (startIndex < units.length) {
    const fontStr = units[startIndex]!.fontStr
    let endIndex = startIndex + 1
    while (endIndex < units.length && units[endIndex]!.fontStr === fontStr) {
      endIndex += 1
    }

    const group = units.slice(startIndex, endIndex)
    let measuredWidths: number[] | null = null

    try {
      const breakableText = group.map((unit) => unit.measuredText).join('\u200b')
      const prepared = prepareWithSegments(breakableText, fontStr, { whiteSpace: 'pre-wrap' })
      const widths = prepared.segments.flatMap((segment, index) => (
        segment === '\u200b' ? [] : [prepared.widths[index] ?? 0]
      ))
      if (widths.length === group.length) measuredWidths = widths
    } catch (error) {
      console.warn('[paginator] Pretext prepare error, fallback to canvas widths:', error)
    }

    for (let index = 0; index < group.length; index += 1) {
      const unit = group[index]!
      const width = measuredWidths?.[index] ?? measureAdvanceWidth(unit.measuredText, fontStr)
      const compressedWidth = isCompressiblePunctuation(unit.displayText)
        ? measureCompressedLineEndWidth(unit.measuredText, fontStr)
        : width
      unit.width = width
      unit.compressedWidth = compressedWidth
      unit.compressionCapacity = Math.max(0, width - compressedWidth)
    }

    startIndex = endIndex
  }
}

function buildMeasureUnits(chars: SourceChar[]): MeasureUnit[] {
  if (!chars.length) return []

  const units: MeasureUnit[] = []
  for (let index = 0; index < chars.length; index += 1) {
    const sourceChar = chars[index]!
    const next = chars[index + 1]?.char ?? ''
    const style = { ...DEFAULT_TEXT_STYLE, ...(sourceChar.style ?? {}) }
    let measuredText = normalizeMeasuredChar(sourceChar.char)
    if (shouldInsertMixedScriptGap(sourceChar.char, next)) {
      // 混排空隙始终跟随前一个字符，避免被拆到下一行开头。
      measuredText += '\u2005'
    }
    units.push({
      displayText: sourceChar.char,
      measuredText,
      style,
      hasComment: sourceChar.hasComment,
      hasLink: sourceChar.hasLink,
      fontStr: textStyleToFontStr(style),
      width: 0,
      compressedWidth: 0,
      compressionCapacity: 0,
      sourceCharCount: 1,
      startPos: sourceChar.startPos,
      endPos: sourceChar.endPos,
    })
  }

  assignMeasuredWidths(units)
  return units
}

function buildTabbedLine(
  chars: SourceChar[],
  tabStops: Array<{ align: 'left' | 'center' | 'right'; position: number }>,
  availableWidth: number
): FittedLine {
  const segments: SourceChar[][] = [[]]

  chars.forEach((char) => {
    if (char.char === '\t') {
      segments.push([])
      return
    }
    segments[segments.length - 1]!.push(char)
  })

  const segmentUnits = segments.map((segment) => buildMeasureUnits(segment))
  const segmentWidths = segmentUnits.map((units) => units.reduce((sum, unit) => sum + unit.width, 0))

  const renderedUnits: RenderUnit[] = []
  let cursorX = 0

  segmentUnits.forEach((units, segmentIndex) => {
    if (segmentIndex > 0) {
      const tabStop = tabStops[Math.min(segmentIndex - 1, tabStops.length - 1)]
      if (tabStop) {
        const nextWidth = segmentWidths[segmentIndex] ?? 0
        const alignedX = tabStop.align === 'center'
          ? tabStop.position - (nextWidth / 2)
          : tabStop.align === 'right'
            ? tabStop.position - nextWidth
            : tabStop.position
        cursorX = Math.max(cursorX, alignedX)
      }
    }

    units.forEach((unit) => {
      renderedUnits.push({
        text: unit.displayText,
        startPos: unit.startPos,
        endPos: unit.endPos,
        style: unit.style,
        hasComment: unit.hasComment,
        hasLink: unit.hasLink,
        width: unit.width,
        renderWidth: unit.width,
        glyphWidth: unit.compressedWidth,
        anchor: getPunctuationAnchor(unit.displayText),
        offsetX: cursorX,
      })
      cursorX += unit.width
    })
  })

  return {
    text: renderedUnits.map((unit) => unit.text).join(''),
    sourceCharCount: renderedUnits.length,
    units: renderedUnits,
    usedWidth: cursorX,
    renderedWidth: cursorX,
    availableWidth: Math.max(1, availableWidth),
  }
}

function fitUnitsToLines(
  units: MeasureUnit[],
  layoutWidth: number,
  firstLineWidth = layoutWidth
): FittedLine[] {
  if (units.length === 0) {
    return [{
      text: '',
      sourceCharCount: 0,
      units: [],
      usedWidth: 0,
      renderedWidth: 0,
      availableWidth: Math.max(1, firstLineWidth),
    }]
  }

  const lines: FittedLine[] = []
  let currentUnits: MeasureUnit[] = []
  let currentWidth = 0
  let currentCompressionCapacity = 0
  let currentSourceCharCount = 0
  let currentLineWidth = Math.max(1, firstLineWidth)

  const appendUnit = (unit: MeasureUnit) => {
    currentUnits.push(unit)
    currentWidth += unit.width
    currentCompressionCapacity += unit.compressionCapacity
    currentSourceCharCount += unit.sourceCharCount
  }

  const canFitWithCompression = (extraUnits: MeasureUnit[]) => {
    const extraWidth = extraUnits.reduce((sum, unit) => sum + unit.width, 0)
    const extraCapacity = extraUnits.reduce((sum, unit) => sum + unit.compressionCapacity, 0)
    return currentWidth + extraWidth - (currentCompressionCapacity + extraCapacity) <= currentLineWidth + 0.5
  }

  const shouldPullTextUnit = (unit: MeasureUnit) => {
    const remainingSpace = Math.max(0, currentLineWidth - currentWidth)
    const requiredCompression = currentWidth + unit.width - currentLineWidth
    const triggerGap = unit.width * TEXT_COMPRESSION_TRIGGER_RATIO
    const maxCompression = unit.width * TEXT_COMPRESSION_MAX_RATIO

    return (
      remainingSpace > triggerGap &&
      requiredCompression > 0 &&
      requiredCompression <= maxCompression + 0.5 &&
      canFitWithCompression([unit])
    )
  }

  const collectTailPunctuationUnits = (startIndex: number) => {
    const collected: MeasureUnit[] = []

    for (let index = startIndex; index < units.length; index += 1) {
      const unit = units[index]!
      if (!isEndAnchoredPunctuation(unit.displayText)) break
      const nextCollected = [...collected, unit]
      if (!canFitWithCompression(nextCollected)) break
      collected.push(unit)
    }

    return collected
  }

  const shouldMoveOpeningPunctuationToNextLine = (index: number) => {
    const unit = units[index]
    if (!unit || !isOpeningPunctuation(unit.displayText) || currentUnits.length === 0) return false

    const nextUnit = units[index + 1]
    if (!nextUnit) return false

    const pairFitsNormally = currentWidth + unit.width + nextUnit.width <= currentLineWidth + 0.5
    const pairFitsWithCompression = canFitWithCompression([unit, nextUnit])

    return !pairFitsNormally && !pairFitsWithCompression
  }

  const buildRenderedUnits = (lineUnits: MeasureUnit[], overflow: number): RenderUnit[] => {
    if (overflow <= 0) {
      return lineUnits.map((unit) => ({
        text: unit.displayText,
        startPos: unit.startPos,
        endPos: unit.endPos,
        style: unit.style,
        hasComment: unit.hasComment,
        hasLink: unit.hasLink,
        width: unit.width,
        renderWidth: unit.width,
        glyphWidth: unit.compressedWidth,
        anchor: getPunctuationAnchor(unit.displayText),
      }))
    }

    let remaining = overflow
    const capacitySum = lineUnits.reduce((sum, unit) => sum + unit.compressionCapacity, 0)

    return lineUnits.map((unit, index) => {
      if (unit.compressionCapacity <= 0 || capacitySum <= 0) {
        return {
          text: unit.displayText,
          startPos: unit.startPos,
          endPos: unit.endPos,
          style: unit.style,
          hasComment: unit.hasComment,
          hasLink: unit.hasLink,
          width: unit.width,
          renderWidth: unit.width,
          glyphWidth: unit.compressedWidth,
          anchor: getPunctuationAnchor(unit.displayText),
        }
      }

      const rawShare = index === lineUnits.length - 1
        ? remaining
        : overflow * (unit.compressionCapacity / capacitySum)
      const applied = Math.min(unit.compressionCapacity, Math.max(0, rawShare), remaining)
      remaining -= applied

      return {
        text: unit.displayText,
        startPos: unit.startPos,
        endPos: unit.endPos,
        style: unit.style,
        hasComment: unit.hasComment,
        hasLink: unit.hasLink,
        width: unit.width,
        renderWidth: Math.max(unit.compressedWidth, unit.width - applied),
        glyphWidth: unit.compressedWidth,
        anchor: getPunctuationAnchor(unit.displayText),
      }
    })
  }

  const pushCurrentLine = () => {
    const overflow = Math.max(0, currentWidth - currentLineWidth)
    const renderedUnits = buildRenderedUnits(currentUnits, overflow)
    const renderedWidth = renderedUnits.reduce((sum, unit) => sum + unit.renderWidth, 0)
    lines.push({
      text: currentUnits.map((unit) => unit.displayText).join(''),
      sourceCharCount: currentSourceCharCount,
      units: renderedUnits,
      usedWidth: currentWidth,
      renderedWidth,
      availableWidth: currentLineWidth,
    })
    currentUnits = []
    currentWidth = 0
    currentCompressionCapacity = 0
    currentSourceCharCount = 0
    currentLineWidth = Math.max(1, layoutWidth)
  }

  for (let index = 0; index < units.length;) {
    const unit = units[index]!

    if (shouldMoveOpeningPunctuationToNextLine(index)) {
      pushCurrentLine()
      continue
    }

    const candidateWidth = currentWidth + unit.width
    const candidateCompressionCapacity = currentCompressionCapacity + unit.compressionCapacity
    const fitsNormally = candidateWidth <= currentLineWidth + 0.5
    const fitsWithCompression = candidateWidth - candidateCompressionCapacity <= currentLineWidth + 0.5

    if (fitsNormally) {
      appendUnit(unit)
      index += 1
      continue
    }

    if (currentUnits.length === 0) {
      appendUnit(unit)
      index += 1
      continue
    }

    if (isEndAnchoredPunctuation(unit.displayText)) {
      const tailPunctuationUnits = collectTailPunctuationUnits(index)
      if (tailPunctuationUnits.length > 0) {
        tailPunctuationUnits.forEach(appendUnit)
        index += tailPunctuationUnits.length
        pushCurrentLine()
        continue
      }
    } else if (fitsWithCompression && shouldPullTextUnit(unit)) {
      appendUnit(unit)
      index += 1

      const tailPunctuationUnits = collectTailPunctuationUnits(index)
      if (tailPunctuationUnits.length > 0) {
        tailPunctuationUnits.forEach(appendUnit)
        index += tailPunctuationUnits.length
      }

      pushCurrentLine()
      continue
    }

    pushCurrentLine()
  }

  if (currentUnits.length > 0) pushCurrentLine()
  return lines
}

function estimateImageHeight(node: PMNode): number {
  if (node.type.name !== 'image') return 0
  const contentHeight = typeof node.attrs.height === 'number' && node.attrs.height > 0
    ? node.attrs.height
    : 160
  return contentHeight + IMAGE_NODE_VERTICAL_CHROME_PX
}

function estimateFloatingObjectHeight(node: PMNode): number {
  if (node.type.name !== 'floating_object') return 0
  return typeof node.attrs.height === 'number' && node.attrs.height > 0 ? node.attrs.height : 0
}

function paragraphHasOnlyTextInlines(paraNode: PMNode): boolean {
  let ok = true
  paraNode.forEach((child) => {
    if (!child.isText) ok = false
  })
  return ok
}

function measureParagraph(
  paraNode: PMNode,
  paraPos: number,
  blockIndex: number,
  contentWidth: number,
  orderedListIndex = 0
): MeasuredBlock {
  const { fontSize } = getParagraphTextStyle(paraNode)
  const align = ((paraNode.attrs.align as string) ?? 'left') as RenderedLine['align']
  const lineHeightMult = (paraNode.attrs.lineHeight as number) ?? 1.5
  const spaceBefore = ptToPx((paraNode.attrs.spaceBefore as number) ?? 0)
  const spaceAfter = ptToPx((paraNode.attrs.spaceAfter as number) ?? 0)
  const paragraphIndentPx = Math.max(0, ptToPx(fontSize * (((paraNode.attrs.indent as number) ?? 0) * 2)))
  const paragraphRightIndentPx = Math.max(0, ptToPx(fontSize * (((paraNode.attrs.rightIndent as number) ?? 0) * 2)))
  const firstLineIndentPx = Math.max(0, ptToPx(fontSize * ((paraNode.attrs.firstLineIndent as number) ?? 0)))
  const rawListType = (paraNode.attrs.listType as string | null) ?? null
  const listType: RenderedLine['listType'] =
    rawListType === 'task' || rawListType === 'bullet' || rawListType === 'ordered' ? rawListType : null
  const listChecked = Boolean(paraNode.attrs.listChecked)
  const listLevel = Math.max(0, Number(paraNode.attrs.listLevel ?? 0))
  const listIndentPx = listType ? ptToPx(fontSize * (2 + listLevel * 2)) : 0
  const tabStops = parseParagraphTabStops(paraNode.attrs.tabStops)

  const fontSizePx = ptToPx(fontSize)
  let lineHeight = fontSizePx * lineHeightMult
  const layoutWidth = Math.max(1, contentWidth - paragraphIndentPx - paragraphRightIndentPx - listIndentPx - PRETEXT_LAYOUT_SAFETY_PX)
  const firstLineWidth = Math.max(1, layoutWidth - firstLineIndentPx)
  const text = paraNode.textContent
  const sourceChars = extractParagraphSourceChars(paraNode, paraPos)
  let maxInlineHeight = lineHeight

  paraNode.forEach((child) => {
    maxInlineHeight = Math.max(maxInlineHeight, estimateImageHeight(child))
    maxInlineHeight = Math.max(maxInlineHeight, estimateFloatingObjectHeight(child))
    if (child.isText) {
      const childStyle = resolveTextStyle(child, getParagraphBaseTextStyle(paraNode))
      maxInlineHeight = Math.max(maxInlineHeight, ptToPx(childStyle.fontSize) * lineHeightMult)
    }
  })
  lineHeight = maxInlineHeight

  if (!text.trim()) {
    return {
      canSplit: false,
      spaceBefore,
      spaceAfter,
      lines: [{
        text: '',
        blockIndex,
        blockPos: paraPos,
        blockType: 'paragraph',
        lineIndex: 0,
        lineHeight,
        startPos: paraPos + 1,
        units: [],
        align,
        availableWidth: firstLineWidth,
        xOffset: paragraphIndentPx + listIndentPx + firstLineIndentPx,
        usedWidth: 0,
        renderedWidth: 0,
        isLastLineOfParagraph: true,
        listType,
        listChecked,
        listIndex: listType === 'ordered' ? Math.max(1, orderedListIndex) : undefined,
      }],
      totalHeight: lineHeight + spaceBefore + spaceAfter,
    }
  }

  let fittedGroups: FittedGroup[]
  try {
    const groups = sourceChars ? splitSourceCharsByNewline(sourceChars) : []
    fittedGroups = (groups.length ? groups : [[]]).map((groupChars, groupIndex) => {
      if (groupChars.some((char) => char.char === '\t') && tabStops.length > 0) {
        return {
          lines: [buildTabbedLine(
            groupChars,
            tabStops,
            groupIndex === 0 ? firstLineWidth : layoutWidth
          )],
        }
      }
      const units = buildMeasureUnits(groupChars)
      return { lines: fitUnitsToLines(units, layoutWidth, groupIndex === 0 ? firstLineWidth : layoutWidth) }
    })
  } catch (error) {
    console.warn('[paginator] Dynamic punctuation layout error, fallback:', error)
    const charsPerLine = Math.max(1, Math.floor(layoutWidth / (fontSizePx * 0.6)))
    const estimatedLines = Math.max(1, Math.ceil(text.length / charsPerLine))
    fittedGroups = [{
      lines: Array.from({ length: estimatedLines }, (_, index) => {
        const slice = text.slice(index * charsPerLine, (index + 1) * charsPerLine)
        return {
          text: slice,
          sourceCharCount: slice.length,
          units: Array.from(slice).map((char) => ({
            text: char,
            startPos: null,
            endPos: null,
            style: { ...DEFAULT_TEXT_STYLE, fontSize },
            hasComment: false,
            hasLink: false,
            width: fontSizePx,
            renderWidth: fontSizePx,
            glyphWidth: fontSizePx,
            anchor: getPunctuationAnchor(char),
          })),
          usedWidth: slice.length * fontSizePx,
          renderedWidth: slice.length * fontSizePx,
          availableWidth: index === 0 ? firstLineWidth : layoutWidth,
        }
      }),
    }]
  }

  const fittedLines = fittedGroups.flatMap((group) => group.lines)
  const canSplit = Boolean(sourceChars) && fittedLines.length > 1
  const lines: RenderedLine[] = []
  let lineIndex = 0

  fittedGroups.forEach((group) => {
    group.lines.forEach((line) => {
      const startPos = line.units[0]?.startPos ?? paraPos + 1
      const isFirstLine = lineIndex === 0
      lines.push({
        text: line.text,
        blockIndex,
        blockPos: paraPos,
        blockType: 'paragraph',
        lineIndex,
        lineHeight,
        startPos,
        units: line.units,
        align,
        availableWidth: line.availableWidth,
        xOffset: paragraphIndentPx + listIndentPx + (isFirstLine ? firstLineIndentPx : 0),
        usedWidth: line.usedWidth,
        renderedWidth: line.renderedWidth,
        isLastLineOfParagraph: false,
        listType,
        listChecked,
        listIndex: listType === 'ordered' ? Math.max(1, orderedListIndex) : undefined,
      })
      lineIndex += 1
    })
  })

  if (lines.length > 0) {
    lines[lines.length - 1] = { ...lines[lines.length - 1]!, isLastLineOfParagraph: true }
  }

  return {
    lines,
    totalHeight: lineHeight * fittedLines.length + spaceBefore + spaceAfter,
    canSplit,
    spaceBefore,
    spaceAfter,
  }
}

function resolveFloatingLeft(node: PMNode, config: PageConfig, contentWidth: number) {
  const relativeFromX = String(node.attrs.relativeFromX ?? 'column')
  const positionX = Number(node.attrs.positionX ?? 0)

  switch (relativeFromX) {
    case 'page':
      return positionX
    case 'margin':
    case 'leftMargin':
      return config.marginLeft + positionX
    case 'rightMargin':
      return config.pageWidth - config.marginRight + positionX
    case 'column':
    default:
      return config.marginLeft + Math.min(contentWidth, Math.max(-contentWidth, positionX))
  }
}

function resolveFloatingTop(node: PMNode, anchorTop: number, config: PageConfig) {
  const relativeFromY = String(node.attrs.relativeFromY ?? 'paragraph')
  const positionY = Number(node.attrs.positionY ?? 0)

  switch (relativeFromY) {
    case 'page':
      return positionY
    case 'margin':
    case 'topMargin':
      return config.marginTop + positionY
    case 'paragraph':
    case 'line':
    default:
      return config.marginTop + anchorTop + positionY
  }
}

function buildFloatingParagraphs(node: PMNode): FloatingParagraph[] {
  const paragraphs = Array.isArray(node.attrs.paragraphs) ? node.attrs.paragraphs : []

  return paragraphs
    .filter((paragraph): paragraph is Record<string, unknown> => Boolean(paragraph) && typeof paragraph === 'object')
    .map((paragraph) => {
      const attrs = (paragraph.attrs as Record<string, unknown> | undefined) ?? {}
      const rawContent = Array.isArray(paragraph.content) ? paragraph.content : []
      let maxFontSize = DEFAULT_TEXT_STYLE.fontSize
      const runs = rawContent
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map((item) => {
          const marks = Array.isArray(item.marks) ? item.marks : []
          const textStyleMark = marks.find((mark) => (
            Boolean(mark) &&
            typeof mark === 'object' &&
            (mark as { type?: string }).type === 'textStyle'
          )) as { attrs?: Partial<RenderTextStyle> } | undefined
          const commentMark = marks.find((mark) => (
            Boolean(mark) &&
            typeof mark === 'object' &&
            (mark as { type?: string }).type === 'comment'
          ))
          const linkMark = marks.find((mark) => (
            Boolean(mark) &&
            typeof mark === 'object' &&
            (mark as { type?: string }).type === 'link'
          ))
          const style = { ...DEFAULT_TEXT_STYLE, ...(textStyleMark?.attrs ?? {}) }
          maxFontSize = Math.max(maxFontSize, Number(style.fontSize) || DEFAULT_TEXT_STYLE.fontSize)
          return {
            text: String(item.text ?? ''),
            style,
            hasComment: Boolean(commentMark),
            hasLink: Boolean(linkMark),
          }
        })
        .filter((run) => run.text.length > 0)

      return {
        align: ((attrs.align as FloatingParagraph['align']) ?? 'left'),
        lineHeight: ptToPx(maxFontSize * (Number(attrs.lineHeight ?? 1.5) || 1.5)),
        runs,
      }
    })
}

function buildRenderedFloatingObject(
  node: PMNode,
  blockIndex: number,
  blockPos: number,
  anchorTop: number,
  config: PageConfig,
  contentWidth: number
): RenderedFloatingObject {
  const kind = String(node.attrs.kind ?? 'textbox') === 'image' ? 'image' : 'textbox'
  const width = typeof node.attrs.width === 'number' && node.attrs.width > 0 ? node.attrs.width : contentWidth
  const height = typeof node.attrs.height === 'number' && node.attrs.height > 0 ? node.attrs.height : 0

  return {
    blockIndex,
    blockPos,
    kind,
    left: resolveFloatingLeft(node, config, contentWidth),
    top: resolveFloatingTop(node, anchorTop, config),
    width,
    height,
    paddingTop: Math.max(0, Number(node.attrs.paddingTop ?? 0)),
    paddingRight: Math.max(0, Number(node.attrs.paddingRight ?? 0)),
    paddingBottom: Math.max(0, Number(node.attrs.paddingBottom ?? 0)),
    paddingLeft: Math.max(0, Number(node.attrs.paddingLeft ?? 0)),
    wrap: String(node.attrs.wrap ?? 'none'),
    behindDoc: Boolean(node.attrs.behindDoc),
    src: String(node.attrs.src ?? ''),
    alt: String(node.attrs.alt ?? ''),
    title: String(node.attrs.title ?? ''),
    paragraphs: buildFloatingParagraphs(node),
  }
}

function getFloatingFlowFloor(page: RenderedPage, config: PageConfig) {
  return page.floatingObjects.reduce((maxBottom, object) => {
    if (object.behindDoc || object.wrap !== 'none') return maxBottom
    const objectTopWithinContent = object.top - config.marginTop
    const objectBottom = objectTopWithinContent + Math.max(object.height, 0)
    return Math.max(maxBottom, objectBottom)
  }, 0)
}

function getDomBlockMetric(
  metrics: readonly DomBlockMetric[],
  nodePos: number,
  blockIndex: number,
  blockType: string,
) {
  return metrics.find((metric) => (
    metric.blockType === blockType
    && (metric.pos === nodePos || metric.blockIndex === blockIndex)
  ))
}

function measureTableCell(cellNode: PMNode, cellContentWidth: number): number {
  let totalHeight = 0
  cellNode.forEach((child) => {
    if (child.type.name === 'paragraph') {
      totalHeight += measureParagraph(child, 0, 0, Math.max(cellContentWidth, 40)).totalHeight
    } else if (child.type.name === 'table') {
      totalHeight += measureTable(child, 0, Math.max(cellContentWidth, 40)).totalHeight
    } else {
      totalHeight += 24
    }
  })
  return Math.max(totalHeight, 24)
}

function countRowColumns(rowNode: PMNode): number {
  let count = 0
  rowNode.forEach((cellNode) => {
    count += Math.max(1, Number(cellNode.attrs.colspan) || 1)
  })
  return Math.max(count, 1)
}

function buildTablePreviewText(tableNode: PMNode) {
  const text = tableNode.textContent.replace(/\s+/g, ' ').trim()
  if (!text) return '[表格]'
  return text.length > 180 ? `${text.slice(0, 180)}...` : text
}

function getFirstParagraphTextPos(cellNode: PMNode, cellPos: number) {
  let found: number | null = null
  cellNode.descendants((node, relativePos) => {
    if (found != null || node.type.name !== 'paragraph') return true
    found = cellPos + 1 + relativePos + 1
    return false
  })
  return found
}

function buildRenderedTable(tableNode: PMNode, tablePos: number, contentWidth: number, contentHeight: number, domMetric?: DomBlockMetric): RenderedTable {
  const fallbackColumnCount = (() => {
    let count = 1
    tableNode.forEach((rowNode) => {
      count = Math.max(count, countRowColumns(rowNode))
    })
    return count
  })()
  const fallbackCellWidth = Math.max(contentWidth / fallbackColumnCount, 48)
  const fallbackRowCount = Math.max(tableNode.childCount, 1)
  const fallbackRowHeight = Math.max(contentHeight / fallbackRowCount, TABLE_MIN_ROW_HEIGHT_PX)
  const rows: RenderedTableRow[] = []

  tableNode.forEach((rowNode, rowOffset, rowIndex) => {
    const rowMetric = domMetric?.table?.rows[rowIndex]
    const cells: RenderedTableCell[] = []
    rowNode.forEach((cellNode, cellOffset, cellIndex) => {
      const paragraphs: string[] = []
      cellNode.forEach((child) => {
        if (child.type.name === 'paragraph') paragraphs.push(child.textContent)
      })
      const cellPos = tablePos + 1 + rowOffset + 1 + cellOffset
      const cellMetric = rowMetric?.cells[cellIndex]
      cells.push({
        text: cellNode.textContent,
        paragraphs: paragraphs.length ? paragraphs : [cellNode.textContent],
        firstTextPos: getFirstParagraphTextPos(cellNode, cellPos),
        colspan: Math.max(1, Number(cellNode.attrs.colspan) || 1),
        rowspan: Math.max(1, Number(cellNode.attrs.rowspan) || 1),
        header: Boolean(cellNode.attrs.header),
        backgroundColor: String(cellNode.attrs.backgroundColor ?? ''),
        borderColor: String(cellNode.attrs.borderColor ?? '#cccccc') || '#cccccc',
        borderWidth: Math.max(0, Number(cellNode.attrs.borderWidth ?? 1) || 0),
        width: Math.max(cellMetric?.width ?? fallbackCellWidth, 1),
        height: Math.max(cellMetric?.height ?? rowMetric?.height ?? fallbackRowHeight, 1),
      })
    })
    rows.push({
      height: Math.max(rowMetric?.height ?? fallbackRowHeight, 1),
      cells,
    })
  })

  return {
    rows,
    width: Math.max(domMetric?.table?.width ?? contentWidth, 1),
    height: Math.max(contentHeight, 1),
  }
}

function measureTable(tableNode: PMNode, tablePos: number, contentWidth: number, domMetric?: DomBlockMetric): MeasuredBlock {
  if (domMetric) {
    const contentHeight = Math.max(0, domMetric.height)
    const spaceBefore = Math.max(0, domMetric.marginTop)
    const spaceAfter = Math.max(0, domMetric.marginBottom)
    return {
      canSplit: false,
      spaceBefore,
      spaceAfter,
      lines: [{
        text: buildTablePreviewText(tableNode),
        blockIndex: 0,
        blockPos: 0,
        blockType: 'table',
        lineIndex: 0,
        lineHeight: contentHeight,
        startPos: null,
        units: [],
        align: 'left',
        availableWidth: contentWidth,
        xOffset: 0,
        usedWidth: 0,
        renderedWidth: 0,
        isLastLineOfParagraph: true,
        table: buildRenderedTable(tableNode, tablePos, contentWidth, contentHeight, domMetric),
      }],
      totalHeight: spaceBefore + contentHeight + spaceAfter,
    }
  }

  let maxColumns = 1
  tableNode.forEach((rowNode) => {
    maxColumns = Math.max(maxColumns, countRowColumns(rowNode))
  })

  const cellWidth = Math.max(Math.floor(contentWidth / maxColumns), 48)
  const cellContentWidth = Math.max(
    cellWidth - TABLE_CELL_HORIZONTAL_PADDING_PX - 2,
    40,
  )
  let contentHeight = 0

  tableNode.forEach((rowNode) => {
    let rowHeight = TABLE_MIN_ROW_HEIGHT_PX
    rowNode.forEach((cellNode) => {
      rowHeight = Math.max(
        rowHeight,
        measureTableCell(cellNode, cellContentWidth) + TABLE_CELL_VERTICAL_CHROME_PX,
      )
    })
    contentHeight += rowHeight
  })

  return {
    canSplit: false,
    spaceBefore: TABLE_BLOCK_MARGIN_PX,
    spaceAfter: TABLE_BLOCK_MARGIN_PX,
    lines: [{
      text: buildTablePreviewText(tableNode),
      blockIndex: 0,
      blockPos: 0,
      blockType: 'table',
      lineIndex: 0,
      lineHeight: contentHeight,
      startPos: null,
      units: [],
      align: 'left',
      availableWidth: contentWidth,
      xOffset: 0,
      usedWidth: 0,
        renderedWidth: 0,
        isLastLineOfParagraph: true,
        table: buildRenderedTable(tableNode, tablePos, contentWidth, contentHeight),
      }],
      totalHeight: contentHeight + TABLE_BLOCK_MARGIN_PX * 2,
    }
}

function normalizeHeadingLevel(rawLevel: unknown) {
  const level = Number(rawLevel ?? 0)
  return Number.isInteger(level) && level >= 1 && level <= 6 ? level : null
}

function collectDocumentHeadings(doc: PMNode): DocumentHeading[] {
  const headings: DocumentHeading[] = []
  let blockIndex = 0

  doc.forEach((node) => {
    if (node.type.name === 'paragraph') {
      const level = normalizeHeadingLevel(node.attrs.headingLevel)
      const title = node.textContent.trim()
      if (level != null && title) headings.push({ title, level, blockIndex })
    }
    blockIndex += 1
  })

  return headings
}

function getTableOfContentsLevelRange(node: PMNode) {
  const minLevel = Math.min(6, Math.max(1, Number(node.attrs.minLevel ?? 1)))
  const maxLevel = Math.min(6, Math.max(minLevel, Number(node.attrs.maxLevel ?? 3)))
  return { minLevel, maxLevel }
}

function getTableOfContentsEntries(node: PMNode, headings: DocumentHeading[]): RenderedTableOfContentsEntry[] {
  const { minLevel, maxLevel } = getTableOfContentsLevelRange(node)
  return headings
    .filter((heading) => heading.level >= minLevel && heading.level <= maxLevel)
    .map((heading) => ({ ...heading, page: null }))
}

function measureBlock(
  node: PMNode,
  nodePos: number,
  blockIndex: number,
  contentWidth: number,
  headings: DocumentHeading[] = [],
  domBlockMetrics: readonly DomBlockMetric[] = [],
  orderedListIndex = 0,
): MeasuredBlock {
  switch (node.type.name) {
    case 'paragraph':
      return measureParagraph(node, nodePos, blockIndex, contentWidth, orderedListIndex)
    case 'table': {
      const measured = measureTable(
        node,
        nodePos,
        contentWidth,
        getDomBlockMetric(domBlockMetrics, nodePos, blockIndex, 'table'),
      )
      measured.lines[0] = { ...measured.lines[0]!, blockIndex, blockPos: nodePos, startPos: nodePos + 1 }
      return measured
    }
    case 'horizontal_rule':
      return {
        canSplit: false,
        spaceBefore: 0,
        spaceAfter: 0,
        lines: [{
          text: '',
          blockIndex,
          blockPos: nodePos,
          blockType: 'horizontal_rule',
          lineIndex: 0,
          lineHeight: 20,
          startPos: nodePos + 1,
          units: [],
          align: 'left',
          availableWidth: contentWidth,
          xOffset: 0,
          usedWidth: 0,
          renderedWidth: 0,
          isLastLineOfParagraph: true,
          lineStyle: String(node.attrs.lineStyle ?? 'solid'),
          lineColor: String(node.attrs.lineColor ?? '#cbd5e1'),
        }],
        totalHeight: 20,
      }
    case 'table_of_contents': {
      const { minLevel, maxLevel } = getTableOfContentsLevelRange(node)
      const tocEntries = getTableOfContentsEntries(node, headings)
      const entryHeight = tocEntries.length > 0 ? tocEntries.length * 24 : 28
      const tocHeight = Math.max(92, 46 + entryHeight)
      return {
        canSplit: false,
        spaceBefore: 8,
        spaceAfter: 8,
        lines: [{
          text: String(node.attrs.title ?? '目录') || '目录',
          blockIndex,
          blockPos: nodePos,
          blockType: 'table_of_contents',
          lineIndex: 0,
          lineHeight: tocHeight,
          startPos: nodePos + 1,
          units: [],
          align: 'left',
          availableWidth: contentWidth,
          xOffset: 0,
          usedWidth: 0,
          renderedWidth: contentWidth,
          isLastLineOfParagraph: true,
          tocTitle: String(node.attrs.title ?? '目录') || '目录',
          tocLevelRange: `${minLevel}-${maxLevel}`,
          tocHyperlink: node.attrs.hyperlink !== false,
          tocEntries,
        }],
        totalHeight: tocHeight + 16,
      }
    }
    default:
      return {
        canSplit: false,
        spaceBefore: 0,
        spaceAfter: 0,
        lines: [{
          text: '',
          blockIndex,
          blockPos: nodePos,
          blockType: node.type.name,
          lineIndex: 0,
          lineHeight: 24,
          startPos: nodePos + 1,
          units: [],
          align: 'left',
          availableWidth: contentWidth,
          xOffset: 0,
          usedWidth: 0,
          renderedWidth: 0,
          isLastLineOfParagraph: true,
        }],
        totalHeight: 24,
      }
  }
}

function pushPageBreak(
  breaks: PageBreakInfo[],
  pages: PageLayout[],
  currentPage: PageLayout,
  breakPos: number
): PageLayout {
  breaks.push({
    pos: breakPos,
    pageIndex: pages.length,
    prevPageUsed: currentPage.totalHeight,
  })
  const nextPage: PageLayout = { lines: [], totalHeight: 0 }
  pages.push(nextPage)
  return nextPage
}

function pushRenderedLines(
  renderedPage: RenderedPage,
  measured: MeasuredBlock,
  startLineIndex: number,
  endLineIndex: number,
  lastLineIndex: number
) {
  let cursor = renderedPage.totalHeight

  for (let lineIndex = startLineIndex; lineIndex < endLineIndex; lineIndex += 1) {
    const line = measured.lines[lineIndex]!
    const extraBefore = lineIndex === 0 ? measured.spaceBefore : 0
    const extraAfter = lineIndex === lastLineIndex ? measured.spaceAfter : 0
    const top = cursor + extraBefore

    renderedPage.lines.push({
      ...line,
      top,
    })

    cursor += extraBefore + line.lineHeight + extraAfter
  }

  renderedPage.totalHeight = cursor
}

function lineNeededHeight(
  measured: MeasuredBlock,
  lineIndex: number,
  lastLineIndex: number
): number {
  const line = measured.lines[lineIndex]!
  const extraBefore = lineIndex === 0 ? measured.spaceBefore : 0
  const extraAfter = lineIndex === lastLineIndex ? measured.spaceAfter : 0
  return extraBefore + line.lineHeight + extraAfter
}

export function paginate(
  doc: PMNode,
  config: PageConfig = DEFAULT_PAGE_CONFIG,
  options: PaginateOptions = {},
): PaginateResult {
  const contentWidth = config.pageWidth - config.marginLeft - config.marginRight
  const contentHeight = config.pageHeight - config.marginTop - config.marginBottom
  const documentHeadings = collectDocumentHeadings(doc)
  const domBlockMetrics = options.domBlockMetrics ?? []

  const pages: PageLayout[] = [{ lines: [], totalHeight: 0 }]
  const renderedPages: RenderedPage[] = [{ lines: [], totalHeight: 0, floatingObjects: [] }]
  const breaks: PageBreakInfo[] = []
  const lineBreakSet = new Set<number>()
  let currentPage = pages[0]!
  let currentRenderedPage = renderedPages[0]!
  let blockIndex = 0
  let lastAnchorTop = 0
  let orderedListIndex = 0

  doc.forEach((node, offset) => {
    const nodePos = offset
    if (node.type.name === 'floating_object') {
      currentRenderedPage.floatingObjects.push(
        buildRenderedFloatingObject(node, blockIndex, nodePos, lastAnchorTop, config, contentWidth)
      )
      blockIndex += 1
      return
    }

    const isOrderedParagraph = node.type.name === 'paragraph' && node.attrs.listType === 'ordered'
    orderedListIndex = isOrderedParagraph ? orderedListIndex + 1 : 0
    const measured = measureBlock(
      node,
      nodePos,
      blockIndex,
      contentWidth,
      documentHeadings,
      domBlockMetrics,
      orderedListIndex,
    )
    const floatingFlowFloor = getFloatingFlowFloor(currentRenderedPage, config)
    if (currentPage.totalHeight < floatingFlowFloor) {
      const gap = floatingFlowFloor - currentPage.totalHeight
      currentPage.totalHeight += gap
      currentRenderedPage.totalHeight += gap
    }

    if (measured.canSplit) {
      for (let lineIndex = 1; lineIndex < measured.lines.length; lineIndex += 1) {
        const pos = measured.lines[lineIndex]!.startPos
        if (typeof pos === 'number' && pos > 0) lineBreakSet.add(pos)
      }
    }

    if (node.attrs.pageBreakBefore && currentPage.lines.length > 0) {
      currentPage = pushPageBreak(breaks, pages, currentPage, nodePos)
      currentRenderedPage = { lines: [], totalHeight: 0, floatingObjects: [] }
      renderedPages.push(currentRenderedPage)
      lastAnchorTop = 0
    }

    if (!measured.canSplit) {
      if (currentPage.totalHeight + measured.totalHeight > contentHeight && currentPage.lines.length > 0) {
        currentPage = pushPageBreak(breaks, pages, currentPage, nodePos)
        currentRenderedPage = { lines: [], totalHeight: 0, floatingObjects: [] }
        renderedPages.push(currentRenderedPage)
        lastAnchorTop = 0
      }
      lastAnchorTop = currentRenderedPage.totalHeight + measured.spaceBefore
      currentPage.lines.push(...measured.lines)
      currentPage.totalHeight += measured.totalHeight
      pushRenderedLines(currentRenderedPage, measured, 0, measured.lines.length, measured.lines.length - 1)
      blockIndex += 1
      return
    }

    const lastLineIndex = measured.lines.length - 1
    let startLineIndex = 0

    while (startLineIndex < measured.lines.length) {
      let fitCount = 0
      let heightSum = 0

      for (let lineIndex = startLineIndex; lineIndex < measured.lines.length; lineIndex += 1) {
        const neededHeight = lineNeededHeight(measured, lineIndex, lastLineIndex)
        if (currentPage.totalHeight + heightSum + neededHeight > contentHeight) break
        fitCount += 1
        heightSum += neededHeight
      }

      if (fitCount === 0) {
        if (currentPage.lines.length > 0) {
          currentPage = pushPageBreak(
            breaks,
            pages,
            currentPage,
            measured.lines[startLineIndex]!.startPos ?? nodePos
          )
          currentRenderedPage = { lines: [], totalHeight: 0, floatingObjects: [] }
          renderedPages.push(currentRenderedPage)
          lastAnchorTop = 0
          continue
        }
        fitCount = 1
        heightSum = lineNeededHeight(measured, startLineIndex, lastLineIndex)
      }

      const remainingAfterFit = measured.lines.length - (startLineIndex + fitCount)

      for (let lineIndex = startLineIndex; lineIndex < startLineIndex + fitCount; lineIndex += 1) {
        currentPage.lines.push(measured.lines[lineIndex]!)
      }
      if (fitCount > 0) {
        lastAnchorTop = currentRenderedPage.totalHeight + (startLineIndex === 0 ? measured.spaceBefore : 0)
      }
      currentPage.totalHeight += heightSum
      pushRenderedLines(
        currentRenderedPage,
        measured,
        startLineIndex,
        startLineIndex + fitCount,
        lastLineIndex
      )
      startLineIndex += fitCount

      if (remainingAfterFit > 0) {
        currentPage = pushPageBreak(
          breaks,
          pages,
          currentPage,
          measured.lines[startLineIndex]!.startPos ?? nodePos
        )
        currentRenderedPage = { lines: [], totalHeight: 0, floatingObjects: [] }
        renderedPages.push(currentRenderedPage)
        lastAnchorTop = 0
      }
    }

    blockIndex += 1
  })

  console.log(
    `[paginator] ${pages.length} page(s), contentHeight=${contentHeight}px, ` +
    pages.map((page, index) => `p${index + 1}=${page.totalHeight.toFixed(0)}px`).join(' ')
  )

  const blockPageMap = new Map<number, number>()
  renderedPages.forEach((page, pageIndex) => {
    page.lines.forEach((line) => {
      if (!blockPageMap.has(line.blockIndex)) blockPageMap.set(line.blockIndex, pageIndex + 1)
    })
  })
  renderedPages.forEach((page) => {
    page.lines.forEach((line) => {
      if (!line.tocEntries) return
      line.tocEntries = line.tocEntries.map((entry) => ({
        ...entry,
        page: blockPageMap.get(entry.blockIndex) ?? null,
      }))
    })
  })

  return {
    pages,
    renderedPages,
    breaks,
    lineBreaks: Array.from(lineBreakSet).sort((a, b) => a - b),
  }
}
