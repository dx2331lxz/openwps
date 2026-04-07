import {
  AlignmentType,
  Document,
  ImageRun,
  LineRuleType,
  Packer,
  PageOrientation,
  Paragraph,
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
  })
}

async function convertInlineNode(node: PMNode): Promise<ParagraphChild> {
  if (node.type.name === 'image') return convertImageNode(node)
  return convertTextRun(node)
}

async function convertParagraph(node: PMNode): Promise<Paragraph> {
  const children: ParagraphChild[] = []
  for (let index = 0; index < node.childCount; index += 1) {
    children.push(await convertInlineNode(node.child(index)))
  }

  return new Paragraph({
    alignment: paragraphAlignment(node.attrs.align as string | undefined),
    pageBreakBefore: Boolean(node.attrs.pageBreakBefore),
    indent: Number(node.attrs.firstLineIndent) > 0
      ? { firstLine: Math.round(Number(node.attrs.firstLineIndent) * 12 * 20) }
      : undefined,
    spacing: {
      line: Math.round(Number(node.attrs.lineHeight ?? 1.5) * 240),
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

  const doc = new Document({ sections })
  const blob = await Packer.toBlob(doc)
  saveAs(blob, 'document.docx')
}
