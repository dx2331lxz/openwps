import {
  AlignmentType,
  Document,
  ImageRun,
  ExternalHyperlink,
  LevelFormat,
  LineRuleType,
  Packer,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType,
  type ParagraphChild,
} from 'docx'
import { saveAs } from 'file-saver'
import type { Node as PMNode } from 'prosemirror-model'
import type { PageConfig } from '../layout/paginator'

const PX_TO_TWIP = 1440 / 96

type ImageKind = 'png' | 'jpg' | 'gif' | 'bmp'

function pxToTwip(value: number) {
  return Math.round(value * PX_TO_TWIP)
}

function dataUrlToBytes(dataUrl: string) {
  const [header, payload] = dataUrl.split(',', 2)
  if (!payload) throw new Error('无效的数据图片')
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return { mime: header, bytes }
}

function inferImageType(src: string): ImageKind {
  const lower = src.toLowerCase()
  if (lower.includes('image/png') || lower.endsWith('.png')) return 'png'
  if (lower.includes('image/gif') || lower.endsWith('.gif')) return 'gif'
  if (lower.includes('image/bmp') || lower.endsWith('.bmp')) return 'bmp'
  return 'jpg'
}

async function imageSourceToBytes(src: string) {
  if (src.startsWith('data:')) return dataUrlToBytes(src)
  const response = await fetch(src)
  if (!response.ok) throw new Error(`图片读取失败：HTTP ${response.status}`)
  const buffer = await response.arrayBuffer()
  return { mime: response.headers.get('content-type') ?? '', bytes: new Uint8Array(buffer) }
}

function paragraphAlignment(align: string | undefined) {
  const alignMap = {
    left: AlignmentType.LEFT,
    center: AlignmentType.CENTER,
    right: AlignmentType.RIGHT,
    justify: AlignmentType.BOTH,
  }
  return alignMap[align as keyof typeof alignMap] ?? AlignmentType.LEFT
}

function getTextStyleAttrs(node: PMNode) {
  const mark = node.marks.find((item) => item.type.name === 'textStyle')
  return (mark?.attrs ?? {}) as Record<string, unknown>
}

function getLinkAttrs(node: PMNode) {
  const mark = node.marks.find((item) => item.type.name === 'link')
  return (mark?.attrs ?? {}) as Record<string, unknown>
}

async function convertImageNode(node: PMNode): Promise<ImageRun> {
  const src = String(node.attrs.src ?? '')
  const { bytes } = await imageSourceToBytes(src)
  const width = typeof node.attrs.width === 'number' && node.attrs.width > 0 ? node.attrs.width : 160
  const height = typeof node.attrs.height === 'number' && node.attrs.height > 0 ? node.attrs.height : 120

  return new ImageRun({
    type: inferImageType(src),
    data: bytes,
    transformation: { width, height },
    altText: {
      title: String(node.attrs.title ?? ''),
      description: String(node.attrs.alt ?? ''),
      name: String(node.attrs.alt ?? node.attrs.title ?? 'image'),
    },
  })
}

function convertTextRun(node: PMNode): TextRun {
  const attrs = getTextStyleAttrs(node)
  const fontFamily = String(attrs.fontFamily ?? 'SimSun, 宋体, serif').split(',')[0]?.trim() || 'SimSun'
  const fontSize = Number(attrs.fontSize ?? 12)
  const color = String(attrs.color ?? '#000000').replace('#', '')
  const backgroundColor = String(attrs.backgroundColor ?? '').replace('#', '')
  const letterSpacing = Number(attrs.letterSpacing ?? 0)

  return new TextRun({
    text: node.text ?? '',
    font: fontFamily,
    size: Math.round(fontSize * 2),
    color,
    bold: Boolean(attrs.bold),
    italics: Boolean(attrs.italic),
    underline: attrs.underline ? { type: UnderlineType.SINGLE } : undefined,
    strike: Boolean(attrs.strikethrough),
    superScript: Boolean(attrs.superscript),
    subScript: Boolean(attrs.subscript),
    characterSpacing: letterSpacing ? Math.round(letterSpacing * 20) : undefined,
    shading: backgroundColor ? { type: ShadingType.CLEAR, fill: backgroundColor, color: 'auto' } : undefined,
  })
}

async function convertInlineNode(node: PMNode): Promise<ParagraphChild> {
  const child = node.type.name === 'image' ? await convertImageNode(node) : convertTextRun(node)
  const href = String(getLinkAttrs(node).href ?? '')
  if (href && /^https?:\/\//i.test(href)) {
    return new ExternalHyperlink({ link: href, children: [child] })
  }
  return child
}

async function convertParagraph(node: PMNode): Promise<Paragraph> {
  const children: ParagraphChild[] = []
  for (let index = 0; index < node.childCount; index += 1) {
    children.push(await convertInlineNode(node.child(index)))
  }

  const lineHeight = Number(node.attrs.lineHeight ?? 1.5)
  const firstLineIndent = Number(node.attrs.firstLineIndent ?? 0)
  const indent = Number(node.attrs.indent ?? 0)
  const listType = String(node.attrs.listType ?? '')
  const listLevel = Math.max(0, Number(node.attrs.listLevel ?? 0))

  // 计算段落内实际字号（取最大字号作为基准）
  let baseFontSizePt = 12
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child.type.name === 'text') {
      const mark = child.marks.find(m => m.type.name === 'textStyle')
      const sz = Number(mark?.attrs?.fontSize ?? 0)
      if (sz > baseFontSizePt) baseFontSizePt = sz
    }
  }

  // Word 的 1.5倍行距 = 字号pt × 1.5 × 20 twip
  // 不能直接用 lineHeight × 240（那是基于12pt的）
  const lineSpacingTwip = Math.round(baseFontSizePt * lineHeight * 20)

  // 首行缩进：用字符单位（em）转 twip，1em = 1个字符宽 = 字号pt
  const firstLineTwip = firstLineIndent > 0
    ? Math.round(firstLineIndent * baseFontSizePt * 20)
    : undefined
  const hangingTwip = firstLineIndent < 0
    ? Math.round(Math.abs(firstLineIndent) * baseFontSizePt * 20)
    : undefined
  const leftTwip = indent > 0
    ? Math.round(indent * 2 * baseFontSizePt * 20)
    : undefined

  return new Paragraph({
    alignment: paragraphAlignment(node.attrs.align as string | undefined),
    pageBreakBefore: Boolean(node.attrs.pageBreakBefore),
    indent: firstLineTwip || hangingTwip || leftTwip
      ? {
          firstLine: firstLineTwip,
          hanging: hangingTwip,
          left: leftTwip,
        }
      : undefined,
    numbering: listType
      ? {
          reference: listType === 'bullet' ? 'pm-bullet' : 'pm-ordered',
          level: listLevel,
        }
      : undefined,
    spacing: {
      line: lineSpacingTwip,
      lineRule: LineRuleType.AUTO,
      before: Math.round(Number(node.attrs.spaceBefore ?? 0) * 20),
      after: Math.round(Number(node.attrs.spaceAfter ?? 0) * 20),
    },
    thematicBreak: node.type.name === 'horizontal_rule',
    children,
  })
}

async function convertTableCell(node: PMNode): Promise<TableCell> {
  const children: (Paragraph | Table)[] = []
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index)
    children.push(child.type.name === 'table' ? await convertTable(child) : await convertParagraph(child))
  }

  return new TableCell({
    children: children.length > 0 ? children : [new Paragraph('')],
    columnSpan: Math.max(1, Number(node.attrs.colspan) || 1),
    rowSpan: Math.max(1, Number(node.attrs.rowspan) || 1),
    width: node.attrs.width
      ? { size: pxToTwip(Number.parseInt(String(node.attrs.width), 10) || 0), type: WidthType.DXA }
      : undefined,
  })
}

async function convertTable(node: PMNode): Promise<Table> {
  const rows: TableRow[] = []

  for (let rowIndex = 0; rowIndex < node.childCount; rowIndex += 1) {
    const rowNode = node.child(rowIndex)
    const cells: TableCell[] = []

    for (let cellIndex = 0; cellIndex < rowNode.childCount; cellIndex += 1) {
      cells.push(await convertTableCell(rowNode.child(cellIndex)))
    }

    rows.push(new TableRow({ children: cells }))
  }

  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
  })
}

async function convertNode(node: PMNode): Promise<Paragraph | Table> {
  if (node.type.name === 'table') return convertTable(node)
  return convertParagraph(node)
}

export async function exportDocx(pmDoc: PMNode, pageConfig: PageConfig) {
  const children: (Paragraph | Table)[] = []
  for (let index = 0; index < pmDoc.childCount; index += 1) {
    children.push(await convertNode(pmDoc.child(index)))
  }

  const sections = [{
    properties: {
      page: {
        size: {
          width: pxToTwip(pageConfig.pageWidth),
          height: pxToTwip(pageConfig.pageHeight),
          orientation: pageConfig.pageWidth > pageConfig.pageHeight ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
        },
        margin: {
          top: pxToTwip(pageConfig.marginTop),
          bottom: pxToTwip(pageConfig.marginBottom),
          left: pxToTwip(pageConfig.marginLeft),
          right: pxToTwip(pageConfig.marginRight),
        },
      },
    },
    children,
  }]

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: 'pm-bullet',
          levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            format: LevelFormat.BULLET,
            text: '•',
          })),
        },
        {
          reference: 'pm-ordered',
          levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
          })),
        },
      ],
    },
    sections,
  })
  const blob = await Packer.toBlob(doc)
  saveAs(blob, 'document.docx')
}
