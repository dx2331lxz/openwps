import { prepareWithSegments, layoutWithLines } from '@chenglou/pretext'
import type { Node as PMNode } from 'prosemirror-model'

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
  lineIndex: number
  lineHeight: number
  startPos: number | null
}

export interface PageLayout {
  lines: LineInfo[]
  totalHeight: number
}

export interface PageBreakInfo {
  pos: number
  pageIndex: number
  prevPageUsed: number
}

export interface PaginateResult {
  pages: PageLayout[]
  breaks: PageBreakInfo[]
  lineBreaks: number[]
}

const PRETEXT_LAYOUT_SAFETY_PX = 2

interface MeasuredBlock {
  lines: LineInfo[]
  totalHeight: number
  canSplit: boolean
  spaceBefore: number
  spaceAfter: number
}

function ptToPx(pt: number): number {
  return (pt * 96) / 72
}

function getParagraphTextStyle(paraNode: PMNode) {
  let fontFamily = 'SimSun, 宋体, "Songti SC", STSong, "Noto Serif CJK SC", serif'
  let fontSize = 12

  paraNode.forEach((child) => {
    if ((child.isText || child.type.name === 'image') && child.marks.length > 0) {
      const mark = child.marks.find((item) => item.type.name === 'textStyle')
      if (mark) {
        fontFamily = mark.attrs.fontFamily || fontFamily
        fontSize = mark.attrs.fontSize || fontSize
      }
    }
  })

  return { fontFamily, fontSize }
}

function estimateImageHeight(node: PMNode): number {
  if (node.type.name !== 'image') return 0
  return typeof node.attrs.height === 'number' && node.attrs.height > 0 ? node.attrs.height : 160
}

function paragraphHasOnlyTextInlines(paraNode: PMNode): boolean {
  let ok = true
  paraNode.forEach((child) => {
    if (!child.isText) ok = false
  })
  return ok
}

function buildParagraphCharPositions(paraNode: PMNode, paraPos: number, textLength: number): number[] {
  const positions = new Array<number>(textLength + 1)
  const contentStart = paraPos + 1
  let charOffset = 0
  positions[0] = contentStart

  paraNode.forEach((child, offset) => {
    if (!child.isText) return
    const childStart = contentStart + offset
    const text = child.text ?? ''
    for (let index = 0; index < text.length; index += 1) {
      charOffset += 1
      positions[charOffset] = childStart + index + 1
    }
  })

  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index] == null) positions[index] = positions[index - 1]!
  }

  return positions
}

function measureParagraph(
  paraNode: PMNode,
  paraPos: number,
  blockIndex: number,
  contentWidth: number
): MeasuredBlock {
  const { fontFamily, fontSize } = getParagraphTextStyle(paraNode)
  const lineHeightMult = (paraNode.attrs.lineHeight as number) ?? 1.5
  const spaceBefore = ptToPx((paraNode.attrs.spaceBefore as number) ?? 0)
  const spaceAfter = ptToPx((paraNode.attrs.spaceAfter as number) ?? 0)

  const fontSizePx = ptToPx(fontSize)
  let lineHeight = fontSizePx * lineHeightMult
  const fontStr = `${fontSizePx}px ${fontFamily}`
  const layoutWidth = Math.max(1, contentWidth - PRETEXT_LAYOUT_SAFETY_PX)
  const text = paraNode.textContent
  let maxInlineHeight = lineHeight

  paraNode.forEach((child) => {
    maxInlineHeight = Math.max(maxInlineHeight, estimateImageHeight(child))
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
        lineIndex: 0,
        lineHeight,
        startPos: paraPos + 1,
      }],
      totalHeight: lineHeight + spaceBefore + spaceAfter,
    }
  }

  let rawLines: { text: string }[]
  try {
    // 与编辑器的 word-break: break-all 保持一致，避免长数字/英文串把前面的中文带走。
    const breakableText = text.split('').join('\u200b')
    const prepared = prepareWithSegments(breakableText, fontStr, { whiteSpace: 'pre-wrap' })
    // DOM 与 canvas/font fallback 在边界处仍可能有细微偏差，保守收窄一点版心，
    // 优先避免“Pretext 认为一行能放下，但浏览器实际又折成两行”的中途裂行。
    rawLines = layoutWithLines(prepared, layoutWidth, lineHeight).lines
  } catch (error) {
    console.warn('[paginator] Pretext error, fallback:', error)
    const charsPerLine = Math.max(1, Math.floor(layoutWidth / (fontSizePx * 0.6)))
    const estimatedLines = Math.ceil(text.length / charsPerLine)
    rawLines = Array.from({ length: estimatedLines }, (_, index) => ({
      text: text.slice(index * charsPerLine, (index + 1) * charsPerLine),
    }))
  }

  const charPositions = paragraphHasOnlyTextInlines(paraNode)
    ? buildParagraphCharPositions(paraNode, paraPos, text.length)
    : null

  let consumedChars = 0
  const lines: LineInfo[] = rawLines.map((line, lineIndex) => {
    const charCount = line.text.replace(/\u200b/g, '').length
    const startPos = charPositions ? charPositions[consumedChars] ?? paraPos + 1 : null
    consumedChars += charCount
    return {
      text: line.text,
      blockIndex,
      lineIndex,
      lineHeight,
      startPos,
    }
  })

  return {
    lines,
    totalHeight: lineHeight * rawLines.length + spaceBefore + spaceAfter,
    canSplit: Boolean(charPositions) && rawLines.length > 1,
    spaceBefore,
    spaceAfter,
  }
}

function measureTableCell(cellNode: PMNode, cellWidth: number): number {
  let totalHeight = 0
  cellNode.forEach((child) => {
    if (child.type.name === 'paragraph') {
      totalHeight += measureParagraph(child, 0, 0, Math.max(cellWidth - 16, 40)).totalHeight
    } else if (child.type.name === 'table') {
      totalHeight += measureTable(child, Math.max(cellWidth - 16, 40)).totalHeight
    } else {
      totalHeight += 24
    }
  })
  return Math.max(totalHeight, 28)
}

function countRowColumns(rowNode: PMNode): number {
  let count = 0
  rowNode.forEach((cellNode) => {
    count += Math.max(1, Number(cellNode.attrs.colspan) || 1)
  })
  return Math.max(count, 1)
}

function measureTable(tableNode: PMNode, contentWidth: number): MeasuredBlock {
  let maxColumns = 1
  tableNode.forEach((rowNode) => {
    maxColumns = Math.max(maxColumns, countRowColumns(rowNode))
  })

  const cellWidth = Math.max(Math.floor(contentWidth / maxColumns), 48)
  let totalHeight = 16

  tableNode.forEach((rowNode) => {
    let rowHeight = 28
    rowNode.forEach((cellNode) => {
      rowHeight = Math.max(rowHeight, measureTableCell(cellNode, cellWidth))
    })
    totalHeight += rowHeight
  })

  return {
    canSplit: false,
    spaceBefore: 0,
    spaceAfter: 0,
    lines: [{ text: '', blockIndex: 0, lineIndex: 0, lineHeight: totalHeight, startPos: null }],
    totalHeight,
  }
}

function measureBlock(
  node: PMNode,
  nodePos: number,
  blockIndex: number,
  contentWidth: number
): MeasuredBlock {
  switch (node.type.name) {
    case 'paragraph':
      return measureParagraph(node, nodePos, blockIndex, contentWidth)
    case 'table': {
      const measured = measureTable(node, contentWidth)
      measured.lines[0] = { ...measured.lines[0]!, blockIndex }
      return measured
    }
    case 'horizontal_rule':
      return {
        canSplit: false,
        spaceBefore: 0,
        spaceAfter: 0,
        lines: [{ text: '', blockIndex, lineIndex: 0, lineHeight: 20, startPos: nodePos + 1 }],
        totalHeight: 20,
      }
    default:
      return {
        canSplit: false,
        spaceBefore: 0,
        spaceAfter: 0,
        lines: [{ text: '', blockIndex, lineIndex: 0, lineHeight: 24, startPos: nodePos + 1 }],
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

export function paginate(doc: PMNode, config: PageConfig = DEFAULT_PAGE_CONFIG): PaginateResult {
  const contentWidth = config.pageWidth - config.marginLeft - config.marginRight
  const contentHeight = config.pageHeight - config.marginTop - config.marginBottom

  const pages: PageLayout[] = [{ lines: [], totalHeight: 0 }]
  const breaks: PageBreakInfo[] = []
  const lineBreakSet = new Set<number>()
  let currentPage = pages[0]!
  let blockIndex = 0

  doc.forEach((node, offset) => {
    const nodePos = offset + 1
    const measured = measureBlock(node, nodePos, blockIndex, contentWidth)

    if (measured.canSplit) {
      for (let lineIndex = 1; lineIndex < measured.lines.length; lineIndex += 1) {
        const pos = measured.lines[lineIndex]!.startPos
        if (typeof pos === 'number' && pos > 0) lineBreakSet.add(pos)
      }
    }

    if (node.attrs.pageBreakBefore && currentPage.lines.length > 0) {
      currentPage = pushPageBreak(breaks, pages, currentPage, nodePos)
    }

    if (!measured.canSplit) {
      if (currentPage.totalHeight + measured.totalHeight > contentHeight && currentPage.lines.length > 0) {
        currentPage = pushPageBreak(breaks, pages, currentPage, nodePos)
      }
      currentPage.lines.push(...measured.lines)
      currentPage.totalHeight += measured.totalHeight
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
          continue
        }
        fitCount = 1
        heightSum = lineNeededHeight(measured, startLineIndex, lastLineIndex)
      }

      const remainingAfterFit = measured.lines.length - (startLineIndex + fitCount)

      for (let lineIndex = startLineIndex; lineIndex < startLineIndex + fitCount; lineIndex += 1) {
        currentPage.lines.push(measured.lines[lineIndex]!)
      }
      currentPage.totalHeight += heightSum
      startLineIndex += fitCount

      if (remainingAfterFit > 0) {
        currentPage = pushPageBreak(
          breaks,
          pages,
          currentPage,
          measured.lines[startLineIndex]!.startPos ?? nodePos
        )
      }
    }

    blockIndex += 1
  })

  console.log(
    `[paginator] ${pages.length} page(s), contentHeight=${contentHeight}px, ` +
      pages.map((page, index) => `p${index + 1}=${page.totalHeight.toFixed(0)}px`).join(' ')
  )

  return { pages, breaks, lineBreaks: Array.from(lineBreakSet).sort((a, b) => a - b) }
}
