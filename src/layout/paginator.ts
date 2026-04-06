import { prepareWithSegments, layoutWithLines } from '@chenglou/pretext'
import type { Node as PMNode } from 'prosemirror-model'

export interface PageConfig {
  pageWidth: number    // px
  pageHeight: number   // px
  marginTop: number    // px
  marginBottom: number // px
  marginLeft: number   // px
  marginRight: number  // px
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
  spaceBefore?: number  // only for first line of paragraph
  spaceAfter?: number   // only for last line of paragraph
}

export interface PageLayout {
  lines: LineInfo[]
  totalHeight: number
}

// Extracts dominant text style from a paragraph node for font measurement
function getParagraphFont(paraNode: PMNode): { fontFamily: string; fontSize: number } {
  let fontFamily = 'SimSun, serif'
  let fontSize = 12

  paraNode.forEach((child) => {
    if (child.isText && child.marks.length > 0) {
      const textMark = child.marks.find((m) => m.type.name === 'textStyle')
      if (textMark) {
        fontFamily = textMark.attrs.fontFamily || fontFamily
        fontSize = textMark.attrs.fontSize || fontSize
      }
    }
  })
  return { fontFamily, fontSize }
}

// Convert pt to px (96dpi)
function ptToPx(pt: number): number {
  return (pt * 96) / 72
}

export function paginate(doc: PMNode, config: PageConfig = DEFAULT_PAGE_CONFIG): PageLayout[] {
  const contentWidth = config.pageWidth - config.marginLeft - config.marginRight
  const contentHeight = config.pageHeight - config.marginTop - config.marginBottom

  const pages: PageLayout[] = []
  let currentPage: PageLayout = { lines: [], totalHeight: 0 }
  pages.push(currentPage)

  let paragraphIndex = 0

  doc.forEach((paraNode) => {
    if (paraNode.type.name !== 'paragraph') {
      paragraphIndex++
      return
    }

    const text = paraNode.textContent
    const { fontFamily, fontSize } = getParagraphFont(paraNode)
    const lineHeightMultiplier = paraNode.attrs.lineHeight as number ?? 1.5
    const spaceBefore = ptToPx(paraNode.attrs.spaceBefore as number ?? 0)
    const spaceAfter = ptToPx(paraNode.attrs.spaceAfter as number ?? 0)

    // px font size from pt
    const fontSizePx = ptToPx(fontSize)
    const lineHeight = fontSizePx * lineHeightMultiplier
    const fontStr = `${fontSizePx}px ${fontFamily}`

    let paraLines: { text: string }[]

    if (!text.trim()) {
      // Empty paragraph still occupies one line height
      paraLines = [{ text: '' }]
    } else {
      try {
        const prepared = prepareWithSegments(text, fontStr)
        const result = layoutWithLines(prepared, contentWidth, lineHeight)
        paraLines = result.lines
      } catch (err) {
        console.warn('[paginator] prepareWithSegments failed, fallback:', err)
        paraLines = [{ text }]
      }
    }

    console.log(`[paginator] paragraph ${paragraphIndex}: "${text.slice(0, 30)}..." → ${paraLines.length} lines @ ${lineHeight.toFixed(1)}px`)

    for (let li = 0; li < paraLines.length; li++) {
      const isFirst = li === 0
      const isLast = li === paraLines.length - 1

      const extraBefore = isFirst ? spaceBefore : 0
      const extraAfter = isLast ? spaceAfter : 0
      const totalLineHeight = lineHeight + extraBefore + extraAfter

      // If adding this line would overflow the page, start a new page
      if (currentPage.totalHeight + totalLineHeight > contentHeight && currentPage.lines.length > 0) {
        currentPage = { lines: [], totalHeight: 0 }
        pages.push(currentPage)
      }

      currentPage.lines.push({
        text: paraLines[li].text,
        paragraphIndex,
        lineIndex: li,
        lineHeight,
        spaceBefore: isFirst ? spaceBefore : 0,
        spaceAfter: isLast ? spaceAfter : 0,
      })
      currentPage.totalHeight += totalLineHeight
    }

    paragraphIndex++
  })

  console.log(`[paginator] total pages: ${pages.length}`)
  return pages
}
