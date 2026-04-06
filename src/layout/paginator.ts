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
  paragraphIndex: number
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

function measureParagraph(
  paraNode: PMNode,
  contentWidth: number
): { lines: LineInfo[]; totalHeight: number } {
  let fontFamily = 'SimSun, serif'
  let fontSize = 12 // pt

  paraNode.forEach((child) => {
    if (child.isText && child.marks.length > 0) {
      const m = child.marks.find((m) => m.type.name === 'textStyle')
      if (m) {
        fontFamily = m.attrs.fontFamily || fontFamily
        fontSize = m.attrs.fontSize || fontSize
      }
    }
  })

  const lineHeightMult = (paraNode.attrs.lineHeight as number) ?? 1.5
  const spaceBefore = ptToPx((paraNode.attrs.spaceBefore as number) ?? 0)
  const spaceAfter = ptToPx((paraNode.attrs.spaceAfter as number) ?? 0)

  const fontSizePx = ptToPx(fontSize)
  const lineHeight = fontSizePx * lineHeightMult
  const fontStr = `${fontSizePx}px ${fontFamily}`
  const text = paraNode.textContent

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
    paragraphIndex: 0, // caller sets this
    lineIndex: li,
    lineHeight,
  }))

  const totalHeight = lineHeight * rawLines.length + spaceBefore + spaceAfter

  return { lines, totalHeight }
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
  let paraIdx = 0

  doc.forEach((node) => {
    if (node.type.name !== 'paragraph') {
      paraIdx++
      return
    }

    const { lines, totalHeight } = measureParagraph(node, contentWidth)
    lines.forEach((l) => (l.paragraphIndex = paraIdx))

    // If this paragraph doesn't fit on the current page and the page has content,
    // push it to a new page. If the page is empty, add it anyway (very long paragraph).
    if (cur.totalHeight + totalHeight > contentHeight && cur.lines.length > 0) {
      cur = { lines: [], totalHeight: 0 }
      pages.push(cur)
    }

    cur.lines.push(...lines)
    cur.totalHeight += totalHeight
    paraIdx++
  })

  console.log(
    `[paginator] ${pages.length} page(s), contentHeight=${contentHeight}px, ` +
      pages.map((p, i) => `p${i + 1}=${p.totalHeight.toFixed(0)}px`).join(' ')
  )
  return pages
}
