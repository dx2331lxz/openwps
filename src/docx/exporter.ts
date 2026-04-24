import {
  AlignmentType,
  Document,
  DocumentGridType,
  ImageRun,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  LineRuleType,
  Packer,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType,
  type ParagraphChild,
} from 'docx'
import { saveAs } from 'file-saver'
import JSZip from 'jszip'
import type { Node as PMNode } from 'prosemirror-model'
import { DEFAULT_PAGE_CONFIG, paginate, type PageConfig, type PaginateResult } from '../layout/paginator'
import type { DocxTypographyConfig } from './importer'
import { toDocxFontName } from '../fonts'

const PX_TO_TWIP = 1440 / 96

type ImageKind = 'png' | 'jpg' | 'gif' | 'bmp'

export interface DocxExportOptions {
  docGridLinePitchPt?: number | null
  typography?: DocxTypographyConfig | null
}

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
  const fontFamily = toDocxFontName(String(attrs.fontFamily ?? ''))
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

async function convertParagraph(node: PMNode, exportOptions: DocxExportOptions): Promise<Paragraph> {
  const children: ParagraphChild[] = []
  const listType = String(node.attrs.listType ?? '')
  const listChecked = Boolean(node.attrs.listChecked)
  if (listType === 'task') {
    children.push(new TextRun({ text: `${listChecked ? '☑' : '☐'} ` }))
  }
  for (let index = 0; index < node.childCount; index += 1) {
    children.push(await convertInlineNode(node.child(index)))
  }

  const lineHeight = Number(node.attrs.lineHeight ?? 1.5)
  const firstLineIndent = Number(node.attrs.firstLineIndent ?? 0)
  const indent = Number(node.attrs.indent ?? 0)
  const listLevel = Math.max(0, Number(node.attrs.listLevel ?? 0))
  const headingLevel = Math.min(6, Math.max(0, Number(node.attrs.headingLevel ?? 0)))
  const heading = headingLevel === 1
    ? HeadingLevel.HEADING_1
    : headingLevel === 2
      ? HeadingLevel.HEADING_2
      : headingLevel === 3
        ? HeadingLevel.HEADING_3
        : headingLevel === 4
          ? HeadingLevel.HEADING_4
          : headingLevel === 5
            ? HeadingLevel.HEADING_5
            : headingLevel === 6
              ? HeadingLevel.HEADING_6
              : undefined

  // 计算段落内实际字号（取最大字号作为基准）
  let baseFontSizePt = 0
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child.type.name === 'text') {
      const mark = child.marks.find(m => m.type.name === 'textStyle')
      const sz = Number(mark?.attrs?.fontSize ?? 0)
      if (sz > baseFontSizePt) baseFontSizePt = sz
    }
  }
  if (baseFontSizePt <= 0) baseFontSizePt = 12

  const docGridLinePitchTwip = exportOptions.docGridLinePitchPt != null
    ? Math.round(exportOptions.docGridLinePitchPt * 20)
    : null
  const exactLineSpacingTwip = Math.round(baseFontSizePt * lineHeight * 20)
  const exportedLineSpacing = docGridLinePitchTwip != null
    ? Math.max(exactLineSpacingTwip, docGridLinePitchTwip)
    : exactLineSpacingTwip

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
    heading,
    alignment: paragraphAlignment(node.attrs.align as string | undefined),
    pageBreakBefore: Boolean(node.attrs.pageBreakBefore),
    indent: firstLineTwip || hangingTwip || leftTwip
      ? {
        firstLine: firstLineTwip,
        hanging: hangingTwip,
        left: leftTwip,
      }
      : undefined,
    numbering: listType && listType !== 'task'
      ? {
        reference: listType === 'bullet' ? 'pm-bullet' : 'pm-ordered',
        level: listLevel,
      }
      : undefined,
    spacing: {
      line: exportedLineSpacing,
      lineRule: LineRuleType.AT_LEAST,
      before: Math.round(Number(node.attrs.spaceBefore ?? 0) * 20),
      after: Math.round(Number(node.attrs.spaceAfter ?? 0) * 20),
    },
    thematicBreak: node.type.name === 'horizontal_rule',
    children,
  })
}

async function convertTableCell(node: PMNode, exportOptions: DocxExportOptions): Promise<TableCell> {
  const children: (Paragraph | Table)[] = []
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index)
    children.push(child.type.name === 'table' ? await convertTable(child, exportOptions) : await convertParagraph(child, exportOptions))
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

async function convertTable(node: PMNode, exportOptions: DocxExportOptions): Promise<Table> {
  const rows: TableRow[] = []

  for (let rowIndex = 0; rowIndex < node.childCount; rowIndex += 1) {
    const rowNode = node.child(rowIndex)
    const cells: TableCell[] = []

    for (let cellIndex = 0; cellIndex < rowNode.childCount; cellIndex += 1) {
      cells.push(await convertTableCell(rowNode.child(cellIndex), exportOptions))
    }

    rows.push(new TableRow({ children: cells }))
  }

  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
  })
}

interface TableOfContentsCachedEntry {
  title: string
  level: number
  page?: number
}

function normalizeHeadingLevel(rawLevel: unknown) {
  const level = Number(rawLevel ?? 0)
  return Number.isInteger(level) && level >= 1 && level <= 6 ? level : null
}

function getTableOfContentsLevelRange(node: PMNode) {
  const minLevel = Math.min(6, Math.max(1, Number(node.attrs.minLevel ?? 1)))
  const maxLevel = Math.min(6, Math.max(minLevel, Number(node.attrs.maxLevel ?? 3)))
  return { minLevel, maxLevel }
}

function collectTableOfContentsEntries(
  pmDoc: PMNode,
  pageConfig: PageConfig,
  minLevel: number,
  maxLevel: number,
  pagination?: PaginateResult | null,
): TableOfContentsCachedEntry[] {
  const resolvedPagination = pagination ?? paginate(pmDoc, pageConfig)
  const blockPageMap = new Map<number, number>()
  resolvedPagination.renderedPages.forEach((page, pageIndex) => {
    page.lines.forEach((line) => {
      if (!blockPageMap.has(line.blockIndex)) blockPageMap.set(line.blockIndex, pageIndex + 1)
    })
  })

  const entries: TableOfContentsCachedEntry[] = []
  let blockIndex = 0
  pmDoc.forEach((child) => {
    if (child.type.name === 'paragraph') {
      const level = normalizeHeadingLevel(child.attrs.headingLevel)
      const title = child.textContent.trim()
      if (level != null && level >= minLevel && level <= maxLevel && title) {
        entries.push({
          title,
          level,
          page: blockPageMap.get(blockIndex),
        })
      }
    }
    blockIndex += 1
  })

  return entries
}

function convertTableOfContents(
  node: PMNode,
  pmDoc: PMNode,
  pageConfig: PageConfig,
  pagination?: PaginateResult | null,
): TableOfContents {
  const { minLevel, maxLevel } = getTableOfContentsLevelRange(node)
  const cachedEntries = collectTableOfContentsEntries(pmDoc, pageConfig, minLevel, maxLevel, pagination)
  return new TableOfContents(String(node.attrs.title ?? '目录') || '目录', {
    headingStyleRange: `${minLevel}-${maxLevel}`,
    hyperlink: node.attrs.hyperlink !== false,
    cachedEntries,
  })
}

async function convertNode(
  node: PMNode,
  exportOptions: DocxExportOptions,
  pmDoc: PMNode,
  pageConfig: PageConfig,
  pagination?: PaginateResult | null,
): Promise<Paragraph | Table | TableOfContents> {
  if (node.type.name === 'table_of_contents') return convertTableOfContents(node, pmDoc, pageConfig, pagination)
  if (node.type.name === 'table') return convertTable(node, exportOptions)
  return convertParagraph(node, exportOptions)
}

function insertIntoSettingsXml(settingsXml: string, snippet: string, beforeTag = '<w:compat>') {
  if (settingsXml.includes(snippet)) return settingsXml
  if (settingsXml.includes(beforeTag)) return settingsXml.replace(beforeTag, `${snippet}${beforeTag}`)
  return settingsXml.replace('</w:settings>', `${snippet}</w:settings>`)
}

// ─── Comment helpers ──────────────────────────────────────────────────────────

interface CollectedComment {
  id: string
  author: string
  date: string
  content: string
}

/** Walk the PMNode tree and collect unique comments (deduped by id). */
function collectComments(pmDoc: PMNode): CollectedComment[] {
  const seen = new Map<string, CollectedComment>()

  pmDoc.descendants((node) => {
    for (const mark of node.marks) {
      if (mark.type.name === 'comment') {
        const id = String(mark.attrs.id ?? '')
        if (id && !seen.has(id)) {
          seen.set(id, {
            id,
            author: String(mark.attrs.author ?? ''),
            date: String(mark.attrs.date ?? ''),
            content: String(mark.attrs.content ?? ''),
          })
        }
      }
    }
    return true
  })

  return Array.from(seen.values())
}

/** Build word/comments.xml string. */
function buildCommentsXml(comments: CollectedComment[]): string {
  const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
  const commentEls = comments.map((c) => {
    const text = c.content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return `  <w:comment w:id="${c.id}" w:author="${c.author.replace(/"/g, '&quot;')}" w:date="${c.date}" w:initials=""><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:comment>`
  })

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments xmlns:w="${W_NS}">\n${commentEls.join('\n')}\n</w:comments>`
}

/**
 * Patch word/document.xml: for each run that has comment marks, wrap the run
 * with commentRangeStart / commentRangeEnd and append a commentReference run.
 *
 * Strategy: use a simple regex/string approach to find runs in the serialised
 * XML and inject the markers. We track which comment ids we've already emitted
 * start/end markers for (a comment may span multiple runs in the same paragraph
 * — we emit start before the first, end after the last).
 *
 * Because the docx package generates deterministic XML we can rely on the
 * `<w:t>` content to match the text from the ProseMirror tree.
 */
function patchDocumentXmlWithComments(documentXml: string, pmDoc: PMNode): string {
  // Build a list of (text, commentIds[]) for all comment-marked inline runs
  interface MarkedRun {
    text: string
    commentIds: string[]
  }
  const markedRuns: MarkedRun[] = []

  pmDoc.descendants((node) => {
    if (node.type.name !== 'text' || !node.text) return true
    const commentIds = node.marks
      .filter(m => m.type.name === 'comment')
      .map(m => String(m.attrs.id ?? ''))
      .filter(Boolean)
    if (commentIds.length > 0) {
      markedRuns.push({ text: node.text, commentIds })
    }
    return true
  })

  if (markedRuns.length === 0) return documentXml

  // For each marked run, inject markers around the <w:r>...</w:r> that contains matching <w:t>
  // We process each run once; comment start/end are emitted around each run individually
  // (simpler than tracking span boundaries — Word/WPS accept per-run comment markers)
  let result = documentXml

  for (const { text, commentIds } of markedRuns) {
    // Escape text for regex matching in XML (the docx package may encode special chars)
    const escapedText = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')

    // Match the run containing exactly this text in a <w:t> element
    // We use a non-greedy match to find the first <w:r>...</w:r> with this text
    const runPattern = new RegExp(
      `(<w:r(?:\\s[^>]*)?>(?:(?!<w:r(?:\\s|>)).)*?<w:t(?:[^>]*)?>)(${escapedText.replace(/[$()*+.[\]?\\^{}|]/g, '\\$&')})(</w:t>(?:(?!<w:r(?:\\s|>)).)*?</w:r>)`,
      's'
    )

    const starts = commentIds.map(id => `<w:commentRangeStart w:id="${id}"/>`).join('')
    const ends = commentIds.map(id => `<w:commentRangeEnd w:id="${id}"/>`).join('')
    const refs = commentIds.map(id =>
      `<w:r><w:commentReference w:id="${id}"/></w:r>`
    ).join('')

    result = result.replace(runPattern, (_, pre, t, post) => {
      return `${starts}${pre}${t}${post}${ends}${refs}`
    })
  }

  return result
}

/** Ensure word/_rels/document.xml.rels includes the comments relationship. */
function patchRelsXmlForComments(relsXml: string): string {
  const commentType = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments'
  if (relsXml.includes(commentType)) return relsXml

  const newRel = `<Relationship Id="rIdComments" Type="${commentType}" Target="comments.xml"/>`
  return relsXml.replace('</Relationships>', `${newRel}</Relationships>`)
}

/** Ensure [Content_Types].xml has the comments.xml override. */
function patchContentTypesForComments(contentTypesXml: string): string {
  if (contentTypesXml.includes('word/comments.xml')) return contentTypesXml

  const override = '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>'
  return contentTypesXml.replace('</Types>', `${override}</Types>`)
}

async function patchDocxComments(blob: Blob, pmDoc: PMNode): Promise<Blob> {
  const comments = collectComments(pmDoc)
  if (comments.length === 0) return blob

  const zip = await JSZip.loadAsync(await blob.arrayBuffer())

  // 1. Generate and write word/comments.xml
  zip.file('word/comments.xml', buildCommentsXml(comments))

  // 2. Patch word/document.xml with comment range markers
  const documentFile = zip.file('word/document.xml')
  if (documentFile) {
    const documentXml = await documentFile.async('string')
    zip.file('word/document.xml', patchDocumentXmlWithComments(documentXml, pmDoc))
  }

  // 3. Patch relationships
  const relsFile = zip.file('word/_rels/document.xml.rels')
  if (relsFile) {
    const relsXml = await relsFile.async('string')
    zip.file('word/_rels/document.xml.rels', patchRelsXmlForComments(relsXml))
  }

  // 4. Patch Content_Types
  const ctFile = zip.file('[Content_Types].xml')
  if (ctFile) {
    const ctXml = await ctFile.async('string')
    zip.file('[Content_Types].xml', patchContentTypesForComments(ctXml))
  }

  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    compression: 'DEFLATE',
  })
}

async function patchDocxSettings(
  blob: Blob,
  exportOptions: DocxExportOptions
) {
  const typography = exportOptions.typography
  if (!typography) return blob

  const zip = await JSZip.loadAsync(await blob.arrayBuffer())
  const settingsFile = zip.file('word/settings.xml')
  if (!settingsFile) return blob

  let settingsXml = await settingsFile.async('string')

  if (typography.noPunctuationKerning) {
    settingsXml = insertIntoSettingsXml(settingsXml, '<w:noPunctuationKerning w:val="1"/>')
  }

  if (typography.punctuationCompression) {
    settingsXml = insertIntoSettingsXml(settingsXml, '<w:characterSpacingControl w:val="compressPunctuation"/>')
  }

  zip.file('word/settings.xml', settingsXml)

  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    compression: 'DEFLATE',
  })
}

export async function buildDocxBlob(
  pmDoc: PMNode,
  pageConfig: PageConfig,
  exportOptions: DocxExportOptions = {},
  pagination?: PaginateResult | null,
) {
  const children: (Paragraph | Table | TableOfContents)[] = []
  for (let index = 0; index < pmDoc.childCount; index += 1) {
    const child = pmDoc.child(index)
    if (child.type.name === 'floating_object') continue
    children.push(await convertNode(child, exportOptions, pmDoc, pageConfig, pagination))
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
      grid: exportOptions.docGridLinePitchPt != null
        ? {
          type: DocumentGridType.LINES,
          linePitch: Math.round(exportOptions.docGridLinePitchPt * 20),
          charSpace: 0,
        }
        : undefined,
    },
    children,
  }]

  const doc = new Document({
    compatibility: exportOptions.typography
      ? {
        version: 14,
        spaceForUnderline: exportOptions.typography.spaceForUnderline,
        balanceSingleByteDoubleByteWidth: exportOptions.typography.balanceSingleByteDoubleByteWidth,
        doNotLeaveBackslashAlone: exportOptions.typography.doNotLeaveBackslashAlone,
        underlineTrailingSpaces: exportOptions.typography.underlineTrailingSpaces,
        doNotExpandShiftReturn: exportOptions.typography.doNotExpandShiftReturn,
        adjustLineHeightInTable: exportOptions.typography.adjustLineHeightInTable,
        doNotWrapTextWithPunctuation: exportOptions.typography.doNotWrapTextWithPunct,
        doNotUseEastAsianBreakRules: exportOptions.typography.doNotUseEastAsianBreakRules,
        useFELayout: exportOptions.typography.useFELayout,
      }
      : undefined,
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
  const settingsPatched = await patchDocxSettings(blob, exportOptions)
  return patchDocxComments(settingsPatched, pmDoc)
}

export async function exportDocx(
  blobOrDoc: Blob | PMNode,
  pageConfig?: PageConfig,
  exportOptions: DocxExportOptions = {},
  pagination?: PaginateResult | null,
) {
  const blob = blobOrDoc instanceof Blob
    ? blobOrDoc
    : await buildDocxBlob(blobOrDoc, pageConfig ?? DEFAULT_PAGE_CONFIG, exportOptions, pagination)
  saveAs(blob, 'document.docx')
}
