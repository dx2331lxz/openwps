import { Fragment, type Node as PMNode } from 'prosemirror-model'
import type { EditorState, Transaction } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
import type { PageConfig } from '../layout/paginator'
import { mapFontFamily } from './presets'
import { fontNameFromFamily } from '../fonts'

const PAPER_SIZES: Record<string, { pageWidth: number; pageHeight: number }> = {
  A4: { pageWidth: 794, pageHeight: 1123 },
  A3: { pageWidth: 1123, pageHeight: 1587 },
  Letter: { pageWidth: 816, pageHeight: 1056 },
  B5: { pageWidth: 665, pageHeight: 942 },
}

function mmToPx(mm: number): number {
  return Math.round(mm * 3.7795)
}

export interface ExecuteResult {
  success: boolean
  message: string
  data?: unknown
}

export interface ExecuteOptions {
  pageConfig?: PageConfig
  onPageConfigChange?: (cfg: PageConfig) => void
  onDocumentStyleMutation?: () => void
  selectionContext?: {
    from: number
    to: number
    paragraphIndex?: number
  } | null
}

type RangeType =
  | 'all'
  | 'paragraph'
  | 'paragraphs'
  | 'selection'
  | 'contains_text'
  | 'first_paragraph'
  | 'last_paragraph'
  | 'odd_paragraphs'
  | 'even_paragraphs'

interface RangeSpec {
  type?: RangeType
  paragraphIndex?: number
  from?: number
  to?: number
  text?: string
  selectionFrom?: number
  selectionTo?: number
}

interface ParagraphRef {
  node: PMNode
  pos: number
  index: number
}

function describeRange(range?: RangeSpec) {
  if (!range?.type) return '整个文档'
  switch (range.type) {
    case 'paragraph':
      return typeof range.paragraphIndex === 'number' ? `第 ${range.paragraphIndex + 1} 段` : '单段范围'
    case 'paragraphs':
      return `第 ${(range.from ?? 0) + 1} 到第 ${(range.to ?? range.from ?? 0) + 1} 段`
    case 'selection':
      return '当前选区'
    case 'contains_text':
      return `包含“${range.text ?? ''}”的段落`
    case 'first_paragraph':
      return '第一段'
    case 'last_paragraph':
      return '最后一段'
    case 'odd_paragraphs':
      return '奇数段'
    case 'even_paragraphs':
      return '偶数段'
    case 'all':
      return '整个文档'
    default:
      return '指定范围'
  }
}

function getParagraphs(state: EditorState): ParagraphRef[] {
  const paragraphs: ParagraphRef[] = []
  let paraIndex = 0

  state.doc.forEach((node, pos) => {
    if (node.type.name !== 'paragraph') return
    paragraphs.push({ node, pos, index: paraIndex++ })
  })

  return paragraphs
}

function getParagraphAtIndex(state: EditorState, index: number): ParagraphRef | undefined {
  return getParagraphs(state).find(paragraph => paragraph.index === index)
}

function resolveRange(
  state: EditorState,
  range?: RangeSpec,
  selectionContext?: ExecuteOptions['selectionContext'],
): ParagraphRef[] {
  const results: ParagraphRef[] = []
  const paragraphs = getParagraphs(state)
  const selectionBounds = getSelectionBounds(state, range, selectionContext)

  for (const paragraph of paragraphs) {
    const text = paragraph.node.textContent

    switch (range?.type) {
      case 'all':
        results.push(paragraph)
        break
      case 'paragraph':
        if (paragraph.index === range.paragraphIndex) results.push(paragraph)
        break
      case 'paragraphs':
        if (paragraph.index >= (range.from ?? 0) && paragraph.index <= (range.to ?? Number.POSITIVE_INFINITY)) {
          results.push(paragraph)
        }
        break
      case 'first_paragraph':
        if (paragraph.index === 0) results.push(paragraph)
        break
      case 'last_paragraph':
        break
      case 'contains_text':
        if (text.includes(range.text ?? '')) results.push(paragraph)
        break
      case 'odd_paragraphs':
        if (paragraph.index % 2 === 0) results.push(paragraph)
        break
      case 'even_paragraphs':
        if (paragraph.index % 2 === 1) results.push(paragraph)
        break
      case 'selection':
        if (selectionBounds) {
          const { from, to } = paragraphTextBounds(paragraph)
          const overlaps = from < selectionBounds.to && to > selectionBounds.from
          if (overlaps) results.push(paragraph)
        }
        break
      default:
        results.push(paragraph)
        break
    }
  }

  if (range?.type === 'last_paragraph' && results.length === 0) {
    const last = paragraphs.at(-1)
    if (last) results.push(last)
  }

  return results
}

function paragraphTextBounds(paragraph: ParagraphRef) {
  return {
    from: paragraph.pos + 1,
    to: paragraph.pos + paragraph.node.nodeSize - 1,
  }
}

function getSelectionBounds(
  state: EditorState,
  range?: RangeSpec,
  selectionContext?: ExecuteOptions['selectionContext'],
) {
  const candidateFrom = range?.selectionFrom ?? selectionContext?.from
  const candidateTo = range?.selectionTo ?? selectionContext?.to
  const rawFrom = Number.isFinite(candidateFrom) ? Number(candidateFrom) : state.selection.from
  const rawTo = Number.isFinite(candidateTo) ? Number(candidateTo) : state.selection.to
  const from = Math.max(1, Math.min(rawFrom, rawTo))
  const to = Math.min(state.doc.nodeSize - 1, Math.max(rawFrom, rawTo))
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return null
  return { from, to }
}

function addTextMark(
  tr: Transaction,
  state: EditorState,
  from: number,
  to: number,
  attrs: Record<string, unknown>
): Transaction {
  if (from >= to) return tr

  let existing: Record<string, unknown> = {}
  state.doc.nodesBetween(from, to, node => {
    if (!node.isText) return
    const mark = node.marks.find(item => item.type === schema.marks.textStyle)
    if (mark) existing = { ...mark.attrs }
  })

  return tr.addMark(from, to, schema.marks.textStyle.create({ ...existing, ...attrs }))
}

function applyTextStyle(
  state: EditorState,
  tr: Transaction,
  range: RangeSpec | undefined,
  attrs: Record<string, unknown>,
  selectionContext?: ExecuteOptions['selectionContext'],
) {
  if (range?.type === 'selection') {
    const bounds = getSelectionBounds(state, range, selectionContext)
    if (!bounds) return tr
    return addTextMark(tr, state, bounds.from, bounds.to, attrs)
  }

  for (const paragraph of resolveRange(state, range)) {
    const { from, to } = paragraphTextBounds(paragraph)
    tr = addTextMark(tr, state, from, to, attrs)
  }

  return tr
}

function applyParagraphStyle(
  state: EditorState,
  tr: Transaction,
  range: RangeSpec | undefined,
  attrs: Record<string, unknown>,
  selectionContext?: ExecuteOptions['selectionContext'],
) {
  for (const paragraph of resolveRange(state, range, selectionContext)) {
    tr.setNodeMarkup(paragraph.pos, undefined, { ...paragraph.node.attrs, ...attrs })
  }
  return tr
}

function getInsertPosAfterParagraph(state: EditorState, index: number): number | null {
  const paragraph = getParagraphAtIndex(state, index)
  if (!paragraph) return null
  return paragraph.pos + paragraph.node.nodeSize
}

function insertBlockAfterParagraph(state: EditorState, paragraphIndex: number, node: PMNode): ExecuteResult & { tr?: Transaction } {
  const insertPos = getInsertPosAfterParagraph(state, paragraphIndex)
  if (insertPos == null) {
    return { success: false, message: `未找到第 ${paragraphIndex + 1} 段` }
  }

  return {
    success: true,
    message: '已插入内容',
    tr: state.tr.insert(insertPos, Fragment.from(node)),
  }
}

function buildParagraphNodeFromText(paragraph: ParagraphRef | null, text: string) {
  const attrs = paragraph?.node.attrs ?? undefined
  const content = text ? schema.text(text) : undefined
  return schema.nodes.paragraph.create(attrs, content)
}

function describeFontFamily(fontFamily: string | undefined) {
  return fontNameFromFamily(fontFamily) ?? fontFamily ?? '宋体'
}

function getRepresentativeTextStyle(node: PMNode) {
  let attrs: Record<string, unknown> = {}

  node.forEach(child => {
    if (Object.keys(attrs).length > 0) return
    if (!child.isText) return
    const mark = child.marks.find(item => item.type.name === 'textStyle')
    if (mark) attrs = mark.attrs
  })

  return attrs
}

function normalizeTextStyle(markAttrs: Record<string, unknown> = {}) {
  return {
    fontFamily: describeFontFamily(String(markAttrs.fontFamily ?? '宋体')),
    fontSize: Number(markAttrs.fontSize ?? 12),
    color: String(markAttrs.color ?? '#000000'),
    backgroundColor: String(markAttrs.backgroundColor ?? ''),
    bold: Boolean(markAttrs.bold ?? false),
    italic: Boolean(markAttrs.italic ?? false),
    underline: Boolean(markAttrs.underline ?? false),
    strikethrough: Boolean(markAttrs.strikethrough ?? false),
    superscript: Boolean(markAttrs.superscript ?? false),
    subscript: Boolean(markAttrs.subscript ?? false),
    letterSpacing: Number(markAttrs.letterSpacing ?? 0),
  }
}

function buildParagraphTextRuns(node: PMNode) {
  const textRuns: Array<{
    text: string
    startOffset: number
    endOffset: number
    style: ReturnType<typeof normalizeTextStyle>
  }> = []
  let offset = 0

  node.forEach(child => {
    if (!child.isText) {
      offset += child.nodeSize
      return
    }

    const text = child.text ?? ''
    const startOffset = offset
    const endOffset = offset + text.length
    offset = endOffset

    const mark = child.marks.find(item => item.type.name === 'textStyle')
    textRuns.push({
      text,
      startOffset,
      endOffset,
      style: normalizeTextStyle((mark?.attrs as Record<string, unknown> | undefined) ?? {}),
    })
  })

  return textRuns
}

function hasMixedTextStyles(textRuns: ReturnType<typeof buildParagraphTextRuns>) {
  if (textRuns.length <= 1) return false
  const first = JSON.stringify(textRuns[0]?.style ?? {})
  return textRuns.some(run => JSON.stringify(run.style) !== first)
}

function buildParagraphSnapshot(paragraph: ParagraphRef) {
  const textStyle = getRepresentativeTextStyle(paragraph.node)
  const paragraphStyle = {
    align: String(paragraph.node.attrs.align ?? 'left'),
    firstLineIndent: Number(paragraph.node.attrs.firstLineIndent ?? 0),
    indent: Number(paragraph.node.attrs.indent ?? 0),
    lineHeight: Number(paragraph.node.attrs.lineHeight ?? 1.5),
    spaceBefore: Number(paragraph.node.attrs.spaceBefore ?? 0),
    spaceAfter: Number(paragraph.node.attrs.spaceAfter ?? 0),
    listType: paragraph.node.attrs.listType ?? 'none',
  }
  const representativeTextStyle = normalizeTextStyle(textStyle)
  const textRuns = buildParagraphTextRuns(paragraph.node)

  return {
    index: paragraph.index,
    text: paragraph.node.textContent,
    charCount: paragraph.node.textContent.length,
    style: {
      ...representativeTextStyle,
      ...paragraphStyle,
    },
    paragraphStyle,
    representativeTextStyle,
    hasMixedTextStyles: hasMixedTextStyles(textRuns),
    textRuns,
  }
}

function getDocumentInfo(state: EditorState): ExecuteResult {
  const paragraphs = getParagraphs(state)
  const wordCount = paragraphs.reduce((sum, paragraph) => sum + paragraph.node.textContent.length, 0)

  return {
    success: true,
    message: `文档共 ${paragraphs.length} 个段落，约 ${wordCount} 字`,
    data: { paragraphCount: paragraphs.length, wordCount, pageCount: 1 },
  }
}

function getDocumentContent(state: EditorState): ExecuteResult {
  const paragraphs = getParagraphs(state).map(buildParagraphSnapshot)
  const totalChars = paragraphs.reduce((sum, paragraph) => sum + paragraph.charCount, 0)

  return {
    success: true,
    message: `文档共 ${paragraphs.length} 个段落`,
    data: { paragraphs, totalChars },
  }
}

function getParagraph(state: EditorState, index: number): ExecuteResult {
  const paragraph = getParagraphAtIndex(state, index)
  if (!paragraph) {
    return { success: false, message: `未找到第 ${index + 1} 段` }
  }

  return {
    success: true,
    message: `已读取第 ${index + 1} 段`,
    data: buildParagraphSnapshot(paragraph),
  }
}

function applyPageConfig(params: Record<string, unknown>, options?: ExecuteOptions): ExecuteResult {
  if (!options?.pageConfig || !options.onPageConfigChange) {
    return { success: false, message: '无法修改页面配置：未提供页面配置回调' }
  }

  const base = options.pageConfig
  const paperSize = typeof params.paperSize === 'string' ? params.paperSize : undefined
  const orientation = typeof params.orientation === 'string' ? params.orientation : undefined

  let { pageWidth, pageHeight } = base
  if (paperSize && PAPER_SIZES[paperSize]) {
    ;({ pageWidth, pageHeight } = PAPER_SIZES[paperSize])
  }
  if (orientation === 'landscape' && pageWidth < pageHeight) {
    ;[pageWidth, pageHeight] = [pageHeight, pageWidth]
  } else if (orientation === 'portrait' && pageWidth > pageHeight) {
    ;[pageWidth, pageHeight] = [pageHeight, pageWidth]
  }

  options.onPageConfigChange({
    pageWidth,
    pageHeight,
    marginTop: params.marginTop != null ? mmToPx(Number(params.marginTop)) : base.marginTop,
    marginBottom: params.marginBottom != null ? mmToPx(Number(params.marginBottom)) : base.marginBottom,
    marginLeft: params.marginLeft != null ? mmToPx(Number(params.marginLeft)) : base.marginLeft,
    marginRight: params.marginRight != null ? mmToPx(Number(params.marginRight)) : base.marginRight,
  })

  return { success: true, message: '页面配置已更新' }
}

export function executeTool(
  view: EditorView,
  toolName: string,
  params: Record<string, unknown>,
  options?: ExecuteOptions
): ExecuteResult {
  const { state, dispatch } = view
  let tr = state.tr

  try {
    switch (toolName) {
      case 'set_text_style': {
        const range = params.range as RangeSpec | undefined
        if (!range) return { success: false, message: 'set_text_style 缺少 range 参数' }
        if (range.type === 'selection' && !getSelectionBounds(state, range, options?.selectionContext)) {
          return { success: false, message: '当前没有可用的选区，无法按 selection 修改文字样式' }
        }
        if (range.type !== 'selection' && resolveRange(state, range, options?.selectionContext).length === 0) {
          return { success: false, message: `未找到可设置文字样式的范围：${describeRange(range)}` }
        }
        const { range: _range, ...rawStyleAttrs } = params
        const styleAttrs = Object.fromEntries(
          Object.entries(rawStyleAttrs).filter(([, value]) => value !== undefined)
        )
        if (typeof styleAttrs.fontFamily === 'string') {
          styleAttrs.fontFamily = mapFontFamily(styleAttrs.fontFamily)
        }
        tr = applyTextStyle(state, tr, range, styleAttrs, options?.selectionContext)
        dispatch(tr)
        options?.onDocumentStyleMutation?.()
        view.focus()
        return { success: true, message: '文字样式已更新' }
      }

      case 'set_paragraph_style': {
        const range = params.range as RangeSpec | undefined
        if (!range) return { success: false, message: 'set_paragraph_style 缺少 range 参数' }
        if (range.type === 'selection' && !getSelectionBounds(state, range, options?.selectionContext)) {
          return { success: false, message: '当前没有可用的选区，无法按 selection 修改段落格式' }
        }
        if (resolveRange(state, range, options?.selectionContext).length === 0) {
          return { success: false, message: `未找到可设置段落格式的范围：${describeRange(range)}` }
        }
        const { range: _range, ...rawParaAttrs } = params
        const paraAttrs = Object.fromEntries(
          Object.entries(rawParaAttrs).filter(([, value]) => value !== undefined)
        )
        if (paraAttrs.listType === 'none') paraAttrs.listType = null
        tr = applyParagraphStyle(state, tr, range, paraAttrs, options?.selectionContext)
        dispatch(tr)
        options?.onDocumentStyleMutation?.()
        view.focus()
        return { success: true, message: '段落格式已更新' }
      }

      case 'set_page_config':
        return applyPageConfig(params, options)

      case 'insert_page_break': {
        const afterParagraph = Number(params.afterParagraph)
        const paragraphs = getParagraphs(state)
        if (!Number.isInteger(afterParagraph) || afterParagraph < 0 || afterParagraph >= paragraphs.length) {
          return { success: false, message: 'afterParagraph 无效' }
        }

        const nextParagraph = getParagraphAtIndex(state, afterParagraph + 1)
        if (nextParagraph) {
          tr.setNodeMarkup(nextParagraph.pos, undefined, {
            ...nextParagraph.node.attrs,
            pageBreakBefore: true,
          })
        } else {
          const paragraphNode = schema.nodes.paragraph.create({ pageBreakBefore: true })
          const inserted = insertBlockAfterParagraph(state, afterParagraph, paragraphNode)
          if (!inserted.success || !inserted.tr) return inserted
          tr = inserted.tr
        }

        dispatch(tr)
        view.focus()
        return { success: true, message: `已在第 ${afterParagraph + 1} 段后插入分页符` }
      }

      case 'insert_horizontal_rule': {
        const afterParagraph = Number(params.afterParagraph)
        const inserted = insertBlockAfterParagraph(state, afterParagraph, schema.nodes.horizontal_rule.create())
        if (!inserted.success || !inserted.tr) return inserted
        dispatch(inserted.tr)
        view.focus()
        return { success: true, message: '已插入分割线' }
      }

      case 'insert_table': {
        const rows = Math.min(20, Math.max(1, Number(params.rows) || 1))
        const cols = Math.min(10, Math.max(1, Number(params.cols) || 1))
        const headerRow = Boolean(params.headerRow)
        const afterParagraph = Number(params.afterParagraph)

        const tableNode = schema.nodes.table.create(
          null,
          Array.from({ length: rows }, (_, rowIndex) =>
            schema.nodes.table_row.create(
              null,
              Array.from({ length: cols }, () =>
                schema.nodes.table_cell.create(
                  { header: headerRow && rowIndex === 0 },
                  schema.nodes.paragraph.create()
                )
              )
            )
          )
        )

        const inserted = insertBlockAfterParagraph(state, afterParagraph, tableNode)
        if (!inserted.success || !inserted.tr) return inserted
        dispatch(inserted.tr)
        view.focus()
        return { success: true, message: `已插入 ${rows} 行 ${cols} 列表格` }
      }

      case 'insert_text': {
        const paragraphIndex = Number(params.paragraphIndex)
        const text = String(params.text ?? '')
        const paragraph = getParagraphAtIndex(state, paragraphIndex)
        if (!paragraph) return { success: false, message: `未找到第 ${paragraphIndex + 1} 段` }
        const insertPos = paragraph.pos + paragraph.node.nodeSize - 1
        tr.insertText(text, insertPos)
        dispatch(tr)
        view.focus()
        return { success: true, message: `已在第 ${paragraphIndex + 1} 段末尾插入文字` }
      }

      case 'insert_paragraph_after': {
        const afterParagraph = Number(params.afterParagraph)
        const text = String(params.text ?? '')
        const paragraph = getParagraphAtIndex(state, afterParagraph)
        if (!paragraph) return { success: false, message: `未找到第 ${afterParagraph + 1} 段` }
        const inserted = insertBlockAfterParagraph(state, afterParagraph, buildParagraphNodeFromText(paragraph, text))
        if (!inserted.success || !inserted.tr) return inserted
        dispatch(inserted.tr)
        view.focus()
        return { success: true, message: `已在第 ${afterParagraph + 1} 段后插入新段落` }
      }

      case 'replace_paragraph_text': {
        const paragraphIndex = Number(params.paragraphIndex)
        const text = String(params.text ?? '')
        const paragraph = getParagraphAtIndex(state, paragraphIndex)
        if (!paragraph) return { success: false, message: `未找到第 ${paragraphIndex + 1} 段` }
        tr.replaceWith(
          paragraph.pos,
          paragraph.pos + paragraph.node.nodeSize,
          buildParagraphNodeFromText(paragraph, text),
        )
        dispatch(tr)
        view.focus()
        return { success: true, message: `已替换第 ${paragraphIndex + 1} 段文字` }
      }

      case 'replace_selection_text': {
        const range = params.range as RangeSpec | undefined
        const text = String(params.text ?? '')
        const bounds = getSelectionBounds(state, range, options?.selectionContext)
        if (!range || range.type !== 'selection' || !bounds) {
          return { success: false, message: 'replace_selection_text 需要有效的 selection 范围' }
        }
        tr.insertText(text, bounds.from, bounds.to)
        dispatch(tr)
        view.focus()
        return { success: true, message: '已替换选区文字' }
      }

      case 'delete_selection_text': {
        const range = params.range as RangeSpec | undefined
        const bounds = getSelectionBounds(state, range, options?.selectionContext)
        if (!range || range.type !== 'selection' || !bounds) {
          return { success: false, message: 'delete_selection_text 需要有效的 selection 范围' }
        }
        tr.delete(bounds.from, bounds.to)
        dispatch(tr)
        view.focus()
        return { success: true, message: '已删除选区文字' }
      }

      case 'delete_paragraph': {
        const index = Number(params.index)
        const paragraph = getParagraphAtIndex(state, index)
        if (!paragraph) return { success: false, message: `未找到第 ${index + 1} 段` }

        if (state.doc.childCount === 1) {
          tr.replaceWith(paragraph.pos, paragraph.pos + paragraph.node.nodeSize, schema.nodes.paragraph.create())
        } else {
          tr.delete(paragraph.pos, paragraph.pos + paragraph.node.nodeSize)
        }

        dispatch(tr)
        view.focus()
        return { success: true, message: `已删除第 ${index + 1} 段` }
      }

      case 'get_document_info':
        return getDocumentInfo(state)

      case 'get_document_content':
        return getDocumentContent(state)

      case 'get_paragraph':
        return getParagraph(state, Number(params.index))

      default:
        return { success: false, message: `未知工具: ${toolName}` }
    }
  } catch (error) {
    console.error('[executor] Error executing tool', toolName, params, error)
    return { success: false, message: error instanceof Error ? error.message : String(error) }
  }
}
