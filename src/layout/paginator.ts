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
}

export interface PageLayout {
  lines: LineInfo[]
  /** Actual content height used on this page (≤ contentHeight) */
  totalHeight: number
}

function ptToPx(pt: number): number {
  return (pt * 96) / 72
}

function getParagraphTextStyle(paraNode: PMNode) {
  let fontFamily = 'SimSun, serif'
  let fontSize = 12

  paraNode.forEach((child) => {
    if ((child.isText || child.type.name === 'image') && child.marks.length > 0) {
      const m = child.marks.find((m) => m.type.name === 'textStyle')
      if (m) {
        fontFamily = m.attrs.fontFamily || fontFamily
        fontSize = m.attrs.fontSize || fontSize
      }
    }
  })

  return { fontFamily, fontSize }
}

function estimateImageHeight(node: PMNode): number {
  if (node.type.name !== 'image') return 0
  return typeof node.attrs.height === 'number' && node.attrs.height > 0 ? node.attrs.height : 160
}

function measureParagraph(
  paraNode: PMNode,
  contentWidth: number
): { lines: LineInfo[]; totalHeight: number } {
  const { fontFamily, fontSize } = getParagraphTextStyle(paraNode)

  const lineHeightMult = (paraNode.attrs.lineHeight as number) ?? 1.5
  const spaceBefore = ptToPx((paraNode.attrs.spaceBefore as number) ?? 0)
  const spaceAfter = ptToPx((paraNode.attrs.spaceAfter as number) ?? 0)

  const fontSizePx = ptToPx(fontSize)
  // 浏览器 CSS line-height: 1.5 实际占高 = fontSize * lineHeightMult
  // 但字体有内置 leading，实际渲染行高略高于理论值。
  // 加入 1.08 修正系数补偿字体 leading 差异，确保分页不提前。
  const LEADING_CORRECTION = 1.08
  let lineHeight = fontSizePx * lineHeightMult * LEADING_CORRECTION
  const fontStr = `${fontSizePx}px ${fontFamily}`
  const text = paraNode.textContent
  let maxInlineHeight = lineHeight

  paraNode.forEach((child) => {
    maxInlineHeight = Math.max(maxInlineHeight, estimateImageHeight(child))
  })
  lineHeight = maxInlineHeight

  let rawLines: { text: string }[]
  if (!text.trim()) {
    rawLines = [{ text: '' }]
  } else {
    try {
      const prepared = prepareWithSegments(text, fontStr)
      rawLines = layoutWithLines(prepared, contentWidth, lineHeight).lines
    } catch (err) {
      console.warn('[paginator] Pretext error, fallback:', err)
      rawLines = [{ text }]
    }
  }

  const lines: LineInfo[] = rawLines.map((l, li) => ({
    text: l.text,
    blockIndex: 0,
    lineIndex: li,
    lineHeight,
  }))

  const totalHeight = lineHeight * rawLines.length + spaceBefore + spaceAfter

  return { lines, totalHeight }
}

function measureTableCell(cellNode: PMNode, cellWidth: number): number {
  let totalHeight = 0
  cellNode.forEach((child) => {
    if (child.type.name === 'paragraph') {
      totalHeight += measureParagraph(child, Math.max(cellWidth - 16, 40)).totalHeight
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

function measureTable(tableNode: PMNode, contentWidth: number): { lines: LineInfo[]; totalHeight: number } {
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
    lines: [{ text: '', blockIndex: 0, lineIndex: 0, lineHeight: totalHeight }],
    totalHeight,
  }
}

function measureBlock(node: PMNode, contentWidth: number): { lines: LineInfo[]; totalHeight: number } {
  switch (node.type.name) {
    case 'paragraph':
      return measureParagraph(node, contentWidth)
    case 'table':
      return measureTable(node, contentWidth)
    case 'horizontal_rule':
      return {
        lines: [{ text: '', blockIndex: 0, lineIndex: 0, lineHeight: 20 }],
        totalHeight: 20,
      }
    default:
      return {
        lines: [{ text: '', blockIndex: 0, lineIndex: 0, lineHeight: 24 }],
        totalHeight: 24,
      }
  }
}

/**
 * Paginates the document at paragraph granularity.
 * No paragraph is split across pages, so widget decorations can be placed
 * cleanly at paragraph boundaries.
 *
 * Returns PageLayout[] where each entry's totalHeight is the actual content
 * height used on that page. The caller uses this to compute the correct
 * transparent break-widget height.
 */
export function paginate(doc: PMNode, config: PageConfig = DEFAULT_PAGE_CONFIG): PageLayout[] {
  const contentWidth = config.pageWidth - config.marginLeft - config.marginRight
  const contentHeight = config.pageHeight - config.marginTop - config.marginBottom

  const pages: PageLayout[] = [{ lines: [], totalHeight: 0 }]
  let cur = pages[0]
  let blockIdx = 0

  doc.forEach((node) => {
    const { lines, totalHeight } = measureBlock(node, contentWidth)
    lines.forEach((line) => { line.blockIndex = blockIdx })

    // Force page break if paragraph has pageBreakBefore attr
    if (node.attrs.pageBreakBefore && cur.lines.length > 0) {
      cur = { lines: [], totalHeight: 0 }
      pages.push(cur)
    }

    // If this paragraph doesn't fit on the current page and the page has content,
    // push it to a new page. If the page is empty, add it anyway (very long paragraph).
    if (cur.totalHeight + totalHeight > contentHeight && cur.lines.length > 0) {
      cur = { lines: [], totalHeight: 0 }
      pages.push(cur)
    }

    cur.lines.push(...lines)
    cur.totalHeight += totalHeight
    blockIdx++
  })

  console.log(
    `[paginator] ${pages.length} page(s), contentHeight=${contentHeight}px, ` +
      pages.map((p, i) => `p${i + 1}=${p.totalHeight.toFixed(0)}px`).join(' ')
  )
  return pages
}
