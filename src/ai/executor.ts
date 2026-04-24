import { Fragment, type Node as PMNode } from 'prosemirror-model'
import type { EditorState, Transaction } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  findTable,
  isInTable,
} from 'prosemirror-tables'
import mermaid from 'mermaid'
import { schema } from '../editor/schema'
import { paginate, type PageConfig } from '../layout/paginator'
import { mapFontFamily } from './presets'
import { fontNameFromFamily } from '../fonts'
import { markdownToFragment } from '../markdown/importer'

mermaid.initialize({ startOnLoad: false, theme: 'default' })

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
    charOffset?: number
    selectedText?: string
    prefixText?: string
    suffixText?: string
    paragraphText?: string
  } | null
}

export interface StreamingWriteSession {
  id: string
  action: 'insert_after_paragraph' | 'replace_paragraph'
  from: number
  to: number
  text: string
  format: 'markdown'
  paragraphAttrs?: Record<string, unknown>
  rollbackFragment: Fragment
}

interface BeginStreamingWriteResult extends ExecuteResult {
  session?: StreamingWriteSession
}

type RangeType =
  | 'all'
  | 'paragraph'
  | 'paragraphs'
  | 'paragraph_indexes'
  | 'selection'
  | 'contains_text'
  | 'text_ranges'
  | 'first_paragraph'
  | 'last_paragraph'
  | 'odd_paragraphs'
  | 'even_paragraphs'

type TextMatchMode = 'contains' | 'exact'

interface TextRangeSpec {
  paragraphIndex?: number
  startOffset?: number
  endOffset?: number
  text?: string
}

interface NormalizedTextRange {
  paragraphIndex: number
  startOffset: number
  endOffset: number
  text?: string
}

interface RangeSpec {
  type?: RangeType
  paragraphIndex?: number
  from?: number
  to?: number
  paragraphIndexes?: number[]
  text?: string
  textOccurrence?: 'all' | 'first'
  caseSensitive?: boolean
  matchMode?: TextMatchMode
  occurrenceIndexes?: number[]
  textRanges?: TextRangeSpec[]
  selectionFrom?: number
  selectionTo?: number
}

interface ParagraphRef {
  node: PMNode
  pos: number
  index: number
}

interface TextMatchRef {
  paragraph: ParagraphRef
  from: number
  to: number
  matchText: string
  startOffset: number
  endOffset: number
  matchIndex: number
}

interface BlockRef {
  node: PMNode
  pos: number
  blockIndex: number
  paragraphIndex: number | null
  afterParagraphIndex: number | null
}

const DEFAULT_PARAGRAPH_ATTRS = {
  align: 'left',
  firstLineIndent: 0,
  indent: 0,
  headingLevel: null,
  lineHeight: 1.5,
  spaceBefore: 0,
  spaceAfter: 0,
  listType: null,
  listChecked: false,
  listLevel: 0,
  pageBreakBefore: false,
} as const

function describeRange(range?: RangeSpec) {
  if (!range?.type) return '整个文档'
  switch (range.type) {
    case 'paragraph':
      return typeof range.paragraphIndex === 'number' ? `第 ${range.paragraphIndex + 1} 段` : '单段范围'
    case 'paragraphs':
      return `第 ${(range.from ?? 0) + 1} 到第 ${(range.to ?? range.from ?? 0) + 1} 段`
    case 'paragraph_indexes':
      return Array.isArray(range.paragraphIndexes) && range.paragraphIndexes.length > 0
        ? `第 ${range.paragraphIndexes.map(index => index + 1).join('、')} 段`
        : '多段范围'
    case 'selection':
      return '当前选区'
    case 'contains_text':
      return `文字“${range.text ?? ''}”`
    case 'text_ranges':
      return Array.isArray(range.textRanges) && range.textRanges.length > 0
        ? `${range.textRanges.length} 个锁定文字范围`
        : '锁定文字范围'
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

function getRangeSpecificity(range?: RangeSpec): number {
  switch (range?.type) {
    case 'all':
      return 0
    case 'odd_paragraphs':
    case 'even_paragraphs':
      return 1
    case 'paragraphs':
      return 2
    case 'paragraph_indexes':
      return 3
    case 'contains_text':
      return 4
    case 'first_paragraph':
    case 'last_paragraph':
    case 'paragraph':
    case 'selection':
      return 5
    default:
      return 2
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

function normalizeParagraphIndexes(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const indexes = value
    .map(item => Number(item))
    .filter(index => Number.isInteger(index) && index >= 0)
  return [...new Set(indexes)].sort((a, b) => a - b)
}

function normalizeOccurrenceIndexes(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const indexes = value
    .map(item => Number(item))
    .filter(index => Number.isInteger(index) && index >= 0)
  return [...new Set(indexes)].sort((a, b) => a - b)
}

function normalizeTextRanges(value: unknown): NormalizedTextRange[] {
  if (!Array.isArray(value)) return []
  const ranges: NormalizedTextRange[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const paragraphIndex = Number(record.paragraphIndex)
    const startOffset = Number(record.startOffset)
    const endOffset = Number(record.endOffset)
    if (
      !Number.isInteger(paragraphIndex) ||
      !Number.isInteger(startOffset) ||
      !Number.isInteger(endOffset) ||
      paragraphIndex < 0 ||
      startOffset < 0 ||
      endOffset <= startOffset
    ) {
      continue
    }
    const text = typeof record.text === 'string' ? record.text : undefined
    ranges.push(text == null ? { paragraphIndex, startOffset, endOffset } : { paragraphIndex, startOffset, endOffset, text })
  }
  return ranges
}

function getParagraphAtIndex(state: EditorState, index: number): ParagraphRef | undefined {
  if (!Number.isInteger(index) || index < 0) return undefined
  return getParagraphs(state).find(paragraph => paragraph.index === index)
}

function getBlocks(state: EditorState): BlockRef[] {
  const blocks: BlockRef[] = []
  let blockIndex = 0
  let paragraphIndex = 0
  let lastParagraphIndex: number | null = null

  state.doc.forEach((node, pos) => {
    const currentParagraphIndex = node.type.name === 'paragraph' ? paragraphIndex++ : null
    if (currentParagraphIndex != null) lastParagraphIndex = currentParagraphIndex
    blocks.push({
      node,
      pos,
      blockIndex: blockIndex++,
      paragraphIndex: currentParagraphIndex,
      afterParagraphIndex: currentParagraphIndex ?? lastParagraphIndex,
    })
  })

  return blocks
}

function resolveRange(
  state: EditorState,
  range?: RangeSpec,
  selectionContext?: ExecuteOptions['selectionContext'],
): ParagraphRef[] {
  const results: ParagraphRef[] = []
  const paragraphs = getParagraphs(state)
  const selectionBounds = getSelectionBounds(state, range, selectionContext)
  const textRangeParagraphIndexes = range?.type === 'text_ranges'
    ? new Set(normalizeTextRanges(range.textRanges).map(item => item.paragraphIndex))
    : null
  const containsTextParagraphIndexes = range?.type === 'contains_text'
    ? new Set(resolveContainsTextMatches(state, range).map(match => match.paragraph.index))
    : null

  for (const paragraph of paragraphs) {
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
      case 'paragraph_indexes':
        if (normalizeParagraphIndexes(range.paragraphIndexes).includes(paragraph.index)) results.push(paragraph)
        break
      case 'first_paragraph':
        if (paragraph.index === 0) results.push(paragraph)
        break
      case 'last_paragraph':
        break
      case 'contains_text':
        if (containsTextParagraphIndexes?.has(paragraph.index)) results.push(paragraph)
        break
      case 'text_ranges':
        if (textRangeParagraphIndexes?.has(paragraph.index)) results.push(paragraph)
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

function paragraphOffsetToDocPos(paragraph: ParagraphRef, offset: number) {
  const normalizedOffset = Math.max(0, offset)
  let consumed = 0
  let resolvedPos = paragraph.pos + 1
  let found = false

  paragraph.node.forEach((child, childOffset) => {
    if (found) return
    if (!child.isText) return
    const text = child.text ?? ''
    const nextConsumed = consumed + text.length
    if (normalizedOffset >= consumed && normalizedOffset <= nextConsumed) {
      resolvedPos = paragraph.pos + 1 + childOffset + (normalizedOffset - consumed)
      consumed = nextConsumed
      found = true
      return
    }
    consumed = nextConsumed
  })

  return Math.min(paragraph.pos + paragraph.node.nodeSize - 1, resolvedPos)
}

function isTextSearchBoundary(char: string | undefined) {
  return !char || !/[\p{L}\p{N}_]/u.test(char)
}

function textMatchesExpected(actual: string, expected: string, caseSensitive: boolean) {
  return caseSensitive
    ? actual === expected
    : actual.toLocaleLowerCase() === expected.toLocaleLowerCase()
}

function isParagraphInTextSearchScope(paragraph: ParagraphRef, range: RangeSpec) {
  if (Number.isInteger(range.paragraphIndex) && paragraph.index !== range.paragraphIndex) return false
  const paragraphIndexes = normalizeParagraphIndexes(range.paragraphIndexes)
  if (paragraphIndexes.length > 0 && !paragraphIndexes.includes(paragraph.index)) return false
  if (Number.isInteger(range.from) && paragraph.index < Number(range.from)) return false
  if (Number.isInteger(range.to) && paragraph.index > Number(range.to)) return false
  return true
}

function resolveContainsTextMatches(state: EditorState, range: RangeSpec): TextMatchRef[] {
  const needle = String(range.text ?? '')
  if (!needle) return []
  const caseSensitive = range.caseSensitive === true
  const matchMode: TextMatchMode = range.matchMode === 'exact' ? 'exact' : 'contains'
  const occurrence = range.textOccurrence === 'first' ? 'first' : 'all'
  const requestedOccurrences = normalizeOccurrenceIndexes(range.occurrenceIndexes)
  const requestedOccurrenceSet = new Set(requestedOccurrences)
  const normalizedNeedle = caseSensitive ? needle : needle.toLocaleLowerCase()
  const matches: TextMatchRef[] = []
  let matchIndex = 0

  for (const paragraph of getParagraphs(state)) {
    if (!isParagraphInTextSearchScope(paragraph, range)) continue
    const sourceText = paragraph.node.textContent
    const haystack = caseSensitive ? sourceText : sourceText.toLocaleLowerCase()
    let searchFrom = 0
    while (searchFrom <= haystack.length) {
      const found = haystack.indexOf(normalizedNeedle, searchFrom)
      if (found === -1) break
      const endOffset = found + needle.length
      const isAccepted = matchMode === 'contains'
        || (isTextSearchBoundary(sourceText[found - 1]) && isTextSearchBoundary(sourceText[endOffset]))
      if (isAccepted) {
        const currentMatchIndex = matchIndex++
        if (requestedOccurrences.length === 0 || requestedOccurrenceSet.has(currentMatchIndex)) {
          matches.push({
            paragraph,
            from: paragraphOffsetToDocPos(paragraph, found),
            to: paragraphOffsetToDocPos(paragraph, endOffset),
            matchText: sourceText.slice(found, endOffset),
            startOffset: found,
            endOffset,
            matchIndex: currentMatchIndex,
          })
          if (occurrence === 'first') return matches
        }
      }
      searchFrom = found + Math.max(needle.length, 1)
    }
  }

  return matches
}

function resolveLockedTextRanges(state: EditorState, range: RangeSpec): TextMatchRef[] {
  const caseSensitive = range.caseSensitive === true
  const matches: TextMatchRef[] = []

  for (const [index, textRange] of normalizeTextRanges(range.textRanges).entries()) {
    const paragraph = getParagraphAtIndex(state, textRange.paragraphIndex)
    if (!paragraph) continue
    const sourceText = paragraph.node.textContent
    if (textRange.endOffset > sourceText.length) continue
    const matchText = sourceText.slice(textRange.startOffset, textRange.endOffset)
    if (textRange.text != null && !textMatchesExpected(matchText, textRange.text, caseSensitive)) continue
    matches.push({
      paragraph,
      from: paragraphOffsetToDocPos(paragraph, textRange.startOffset),
      to: paragraphOffsetToDocPos(paragraph, textRange.endOffset),
      matchText,
      startOffset: textRange.startOffset,
      endOffset: textRange.endOffset,
      matchIndex: index,
    })
  }

  return matches
}

function resolveTextMatches(
  state: EditorState,
  range?: RangeSpec,
  selectionContext?: ExecuteOptions['selectionContext'],
): TextMatchRef[] {
  if (range?.type === 'selection') {
    const bounds = getSelectionBounds(state, range, selectionContext)
    if (!bounds) return []
    const paragraph = resolveRange(state, range, selectionContext)[0]
    return [{
      paragraph: paragraph ?? { node: state.doc, pos: 0, index: -1 },
      from: bounds.from,
      to: bounds.to,
      matchText: state.doc.textBetween(bounds.from, bounds.to, '\n'),
      startOffset: 0,
      endOffset: Math.max(0, bounds.to - bounds.from),
      matchIndex: 0,
    }]
  }

  if (range?.type === 'text_ranges') {
    return resolveLockedTextRanges(state, range)
  }

  if (range?.type !== 'contains_text') {
    return resolveRange(state, range, selectionContext).map((paragraph, index) => {
      const bounds = paragraphTextBounds(paragraph)
      return {
        paragraph,
        from: bounds.from,
        to: bounds.to,
        matchText: paragraph.node.textContent,
        startOffset: 0,
        endOffset: paragraph.node.textContent.length,
        matchIndex: index,
      }
    })
  }

  return resolveContainsTextMatches(state, range)
}

function tryResolveSelectionInParagraph(
  paragraph: ParagraphRef,
  selectionContext?: ExecuteOptions['selectionContext'],
) {
  const selectedText = selectionContext?.selectedText ?? ''
  if (!selectedText) return null

  const paragraphText = paragraph.node.textContent
  const prefixText = selectionContext?.prefixText ?? ''
  const suffixText = selectionContext?.suffixText ?? ''
  const preferredOffsets: number[] = []

  if (Number.isFinite(selectionContext?.charOffset)) preferredOffsets.push(Number(selectionContext?.charOffset))

  let matchOffset = -1
  for (const preferredOffset of preferredOffsets) {
    if (paragraphText.slice(preferredOffset, preferredOffset + selectedText.length) === selectedText) {
      matchOffset = preferredOffset
      break
    }
  }

  if (matchOffset === -1) {
    let searchFrom = 0
    while (searchFrom <= paragraphText.length) {
      const found = paragraphText.indexOf(selectedText, searchFrom)
      if (found === -1) break
      const prefixMatches = !prefixText || paragraphText.slice(Math.max(0, found - prefixText.length), found) === prefixText
      const suffixMatches = !suffixText || paragraphText.slice(found + selectedText.length, found + selectedText.length + suffixText.length) === suffixText
      if (prefixMatches || suffixMatches) {
        matchOffset = found
        break
      }
      searchFrom = found + 1
    }
  }

  if (matchOffset === -1) return null

  return {
    from: paragraphOffsetToDocPos(paragraph, matchOffset),
    to: paragraphOffsetToDocPos(paragraph, matchOffset + selectedText.length),
  }
}

function resolveSelectionByAnchor(state: EditorState, selectionContext?: ExecuteOptions['selectionContext']) {
  if (!selectionContext?.selectedText) return null

  if (Number.isFinite(selectionContext.paragraphIndex)) {
    const paragraph = getParagraphAtIndex(state, Number(selectionContext.paragraphIndex))
    if (paragraph) {
      const match = tryResolveSelectionInParagraph(paragraph, selectionContext)
      if (match) return match
    }
  }

  for (const paragraph of getParagraphs(state)) {
    const match = tryResolveSelectionInParagraph(paragraph, selectionContext)
    if (match) return match
  }

  return null
}

function getSelectionBounds(
  state: EditorState,
  range?: RangeSpec,
  selectionContext?: ExecuteOptions['selectionContext'],
) {
  const candidateFrom = range?.selectionFrom ?? selectionContext?.from
  const candidateTo = range?.selectionTo ?? selectionContext?.to
  const hasExplicitBounds = Number.isFinite(candidateFrom) && Number.isFinite(candidateTo)
  const rawFrom = hasExplicitBounds ? Number(candidateFrom) : state.selection.from
  const rawTo = hasExplicitBounds ? Number(candidateTo) : state.selection.to
  const from = Math.max(1, Math.min(rawFrom, rawTo))
  const to = Math.min(state.doc.nodeSize - 1, Math.max(rawFrom, rawTo))
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    return resolveSelectionByAnchor(state, selectionContext)
  }
  if (selectionContext?.selectedText) {
    const currentText = state.doc.textBetween(from, to, '\n')
    if (currentText !== selectionContext.selectedText) {
      return resolveSelectionByAnchor(state, selectionContext)
    }
  }
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
  for (const match of resolveTextMatches(state, range, selectionContext)) {
    tr = addTextMark(tr, state, match.from, match.to, attrs)
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

function clearFormatting(
  state: EditorState,
  tr: Transaction,
  range: RangeSpec | undefined,
  selectionContext?: ExecuteOptions['selectionContext'],
  clearTextStyles = true,
  clearParagraphStyles = true,
) {
  if (clearTextStyles) {
    if (range?.type === 'selection' || range?.type === 'contains_text') {
      for (const match of resolveTextMatches(state, range, selectionContext)) {
        tr = tr.removeMark(match.from, match.to, schema.marks.textStyle)
      }
    } else {
      for (const paragraph of resolveRange(state, range, selectionContext)) {
        const { from, to } = paragraphTextBounds(paragraph)
        tr = tr.removeMark(from, to, schema.marks.textStyle)
      }
    }
  }

  if (clearParagraphStyles) {
    for (const paragraph of resolveRange(state, range, selectionContext)) {
      tr.setNodeMarkup(paragraph.pos, undefined, { ...paragraph.node.attrs, ...DEFAULT_PARAGRAPH_ATTRS })
    }
  }

  return tr
}

function getInsertPosAfterParagraph(state: EditorState, index: number): number | null {
  if (index === -1) return 0
  const paragraph = getParagraphAtIndex(state, index)
  if (!paragraph) return null
  return paragraph.pos + paragraph.node.nodeSize
}

function insertBlockAfterParagraph(state: EditorState, paragraphIndex: number, node: PMNode): ExecuteResult & { tr?: Transaction } {
  const insertPos = getInsertPosAfterParagraph(state, paragraphIndex)
  if (insertPos == null) {
    return { success: false, message: `未找到第 ${paragraphIndex + 1} 段` }
  }

  const shouldAppendTrailingParagraph = insertPos >= state.doc.content.size && node.type !== schema.nodes.paragraph
  const fragment = shouldAppendTrailingParagraph
    ? Fragment.fromArray([node, schema.nodes.paragraph.create()])
    : Fragment.from(node)

  return {
    success: true,
    message: '已插入内容',
    tr: state.tr.insert(insertPos, fragment),
  }
}

function buildParagraphNode(text: string, attrs?: Record<string, unknown>) {
  const content = text ? schema.text(text) : undefined
  return schema.nodes.paragraph.create(attrs, content)
}

function normalizeToolText(raw: string) {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
}

function buildParagraphNodeFromText(paragraph: ParagraphRef | null, text: string) {
  return buildParagraphNode(normalizeToolText(text), (paragraph?.node.attrs as Record<string, unknown> | undefined) ?? undefined)
}

function buildParagraphNodesFromText(text: string, paragraphAttrs?: Record<string, unknown>) {
  const normalized = normalizeToolText(text)
  const parts = normalized === '' ? [''] : normalized.split('\n')
  return parts.map(part => buildParagraphNode(part, paragraphAttrs))
}

function isFullParagraphSelection(range: { from: number; to: number }, paragraph: ParagraphRef) {
  const bounds = paragraphTextBounds(paragraph)
  return range.from <= bounds.from && range.to >= bounds.to
}

function describeFontFamily(fontFamily: string | undefined) {
  return fontNameFromFamily(fontFamily) ?? fontFamily ?? '宋体'
}

// ─── Compact snapshot for tool return values ────────────────────────────────

function buildCompactParagraphSnapshot(state: EditorState, paragraphIndexes: number[]) {
  const paragraphs = getParagraphs(state)
  return paragraphIndexes
    .map(index => paragraphs.find(p => p.index === index))
    .filter((p): p is ParagraphRef => Boolean(p))
    .map(p => {
      const textStyle = getRepresentativeTextStyle(p.node)
      const normalized = normalizeTextStyle(textStyle)
      const paraStyle = p.node.attrs as Record<string, unknown>
      return {
        index: p.index,
        text: p.node.textContent.length > 60 ? `${p.node.textContent.slice(0, 60)}...` : p.node.textContent,
        style: {
          fontFamily: normalized.fontFamily,
          fontSize: normalized.fontSize,
          bold: normalized.bold,
          italic: normalized.italic,
          color: normalized.color,
          align: String(paraStyle.align ?? 'left'),
          firstLineIndent: Number(paraStyle.firstLineIndent ?? 0),
          lineHeight: Number(paraStyle.lineHeight ?? 1.5),
          spaceBefore: Number(paraStyle.spaceBefore ?? 0),
          spaceAfter: Number(paraStyle.spaceAfter ?? 0),
          listType: String(paraStyle.listType ?? 'none'),
          listChecked: Boolean(paraStyle.listChecked ?? false),
          headingLevel: paraStyle.headingLevel == null ? null : Number(paraStyle.headingLevel),
        },
      }
    })
}

// ─── Range validation helper ────────────────────────────────────────────────

const VALID_RANGE_TYPES = new Set<string>([
  'all', 'paragraph', 'paragraphs', 'paragraph_indexes', 'selection',
  'contains_text', 'text_ranges', 'first_paragraph', 'last_paragraph', 'odd_paragraphs', 'even_paragraphs',
])

function validateRange(toolName: string, range: unknown): { valid: true } | { valid: false; error: string } {
  if (!range || typeof range !== 'object' || Array.isArray(range)) {
    return { valid: false, error: `${toolName} 缺少 range 参数，必须提供有效的操作范围` }
  }
  const rangeObj = range as Record<string, unknown>
  if (!rangeObj.type && Object.keys(rangeObj).length === 0) {
    return { valid: false, error: `${toolName} 的 range 为空对象 {}，必须指定 range.type` }
  }
  if (rangeObj.type && !VALID_RANGE_TYPES.has(String(rangeObj.type))) {
    return { valid: false, error: `${toolName} 的 range.type="${rangeObj.type}" 无效，支持的类型: ${[...VALID_RANGE_TYPES].join(', ')}` }
  }
  if (rangeObj.type === 'contains_text' && !String(rangeObj.text ?? '').trim()) {
    return { valid: false, error: `${toolName} 的 range.type=contains_text 时必须提供非空 text` }
  }
  if (rangeObj.type === 'text_ranges' && normalizeTextRanges(rangeObj.textRanges).length === 0) {
    return { valid: false, error: `${toolName} 的 range.type=text_ranges 时必须提供非空 textRanges，包含 paragraphIndex/startOffset/endOffset` }
  }
  return { valid: true }
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

function buildParagraphNodeSnapshot(node: PMNode, index: number | null, includeTextRuns = true) {
  const textStyle = getRepresentativeTextStyle(node)
  const paragraphStyle = {
    align: String(node.attrs.align ?? 'left'),
    firstLineIndent: Number(node.attrs.firstLineIndent ?? 0),
    indent: Number(node.attrs.indent ?? 0),
    headingLevel: node.attrs.headingLevel == null ? null : Number(node.attrs.headingLevel),
    lineHeight: Number(node.attrs.lineHeight ?? 1.5),
    spaceBefore: Number(node.attrs.spaceBefore ?? 0),
    spaceAfter: Number(node.attrs.spaceAfter ?? 0),
    listType: node.attrs.listType ?? 'none',
    listChecked: Boolean(node.attrs.listChecked ?? false),
    pageBreakBefore: Boolean(node.attrs.pageBreakBefore ?? false),
  }
  const representativeTextStyle = normalizeTextStyle(textStyle)
  const textRuns = includeTextRuns ? buildParagraphTextRuns(node) : []

  return {
    index,
    text: node.textContent,
    charCount: node.textContent.length,
    style: {
      ...representativeTextStyle,
      ...paragraphStyle,
    },
    paragraphStyle,
    representativeTextStyle,
    hasMixedTextStyles: includeTextRuns ? hasMixedTextStyles(textRuns) : false,
    textRuns: includeTextRuns ? textRuns : undefined,
  }
}

function buildParagraphSnapshot(paragraph: ParagraphRef, includeTextRuns = true) {
  return buildParagraphNodeSnapshot(paragraph.node, paragraph.index, includeTextRuns)
}

// ─── Content-only snapshots ────────────────────────────────────────────────
// 这些快照只暴露正文 + 粗略结构（标题层级启发、列表类型、任务勾选、图片占位、
// 超链接、表格行列文本），不含字体/字号/颜色/缩进/行距/textRuns/commonStyles
// 等格式细节。供编辑阶段读取使用，避免大段样式信息干扰模型。

type DetailMode = 'content' | 'format'

function resolveDetailMode(value: unknown): DetailMode {
  return value === 'format' ? 'format' : 'content'
}

const SRC_PREVIEW_MAX = 64

function summarizeImageSrc(rawSrc: unknown): { srcKind: 'data' | 'url'; srcPreview: string } {
  const src = String(rawSrc ?? '')
  if (src.startsWith('data:')) {
    const head = src.slice(0, src.indexOf(',') + 1)
    return { srcKind: 'data', srcPreview: head ? `${head}...` : 'data:...' }
  }
  if (src.length > SRC_PREVIEW_MAX) {
    return { srcKind: 'url', srcPreview: `${src.slice(0, SRC_PREVIEW_MAX)}...` }
  }
  return { srcKind: 'url', srcPreview: src }
}

interface ParagraphContentSnapshot {
  index: number | null
  text: string
  charCount: number
  role: 'empty' | 'image-only' | 'task-item' | 'list-item' | 'heading' | 'paragraph'
  headingLevel?: 1 | 2 | 3
  list?: { type: 'bullet' | 'ordered' | 'task'; level: number; checked?: boolean }
  inlineImages?: Array<{ alt: string; srcKind: 'data' | 'url'; srcPreview: string }>
  links?: Array<{ text: string; href: string }>
}

function inferHeadingLevel(node: PMNode, text: string): 1 | 2 | 3 | null {
  if (!text || text.length > 60) return null
  const explicitLevel = Number(node.attrs.headingLevel ?? 0)
  if (explicitLevel >= 1 && explicitLevel <= 3) return explicitLevel as 1 | 2 | 3
  const textStyle = normalizeTextStyle(getRepresentativeTextStyle(node))
  const align = String(node.attrs.align ?? 'left')
  if (textStyle.fontSize >= 18) return 1
  if (textStyle.fontSize >= 16) return 2
  if (textStyle.fontSize >= 14) return 3
  if (textStyle.bold && align === 'center') return 3
  return null
}

function buildParagraphContentSnapshot(node: PMNode, index: number | null): ParagraphContentSnapshot {
  // 自定义遍历：文字直接拼接，遇到 image 节点插入 [image:alt] 占位符
  const textParts: string[] = []
  const inlineImages: Array<{ alt: string; srcKind: 'data' | 'url'; srcPreview: string }> = []
  const linkMap = new Map<string, { text: string; href: string }>()
  let nonImageInlineCount = 0

  node.forEach((child) => {
    if (child.type.name === 'image') {
      const alt = String(child.attrs.alt ?? '')
      textParts.push(alt ? `[image:${alt}]` : '[image]')
      inlineImages.push({ alt, ...summarizeImageSrc(child.attrs.src) })
      return
    }
    if (child.isText) {
      const text = child.text ?? ''
      textParts.push(text)
      if (text.trim().length > 0) nonImageInlineCount += 1
      const linkMark = child.marks.find(mark => mark.type.name === 'link')
      if (linkMark) {
        const href = String(linkMark.attrs.href ?? '')
        if (href) {
          const key = `${href}\u0000${text}`
          if (!linkMap.has(key)) linkMap.set(key, { text, href })
        }
      }
      return
    }
    // 其他 inline 节点（极少）按 textContent 兜底
    const fallback = child.textContent
    if (fallback) {
      textParts.push(fallback)
      nonImageInlineCount += 1
    }
  })

  const text = textParts.join('')
  const charCount = text.length

  const listTypeRaw = node.attrs.listType
  const listType = listTypeRaw === 'bullet' || listTypeRaw === 'ordered' || listTypeRaw === 'task'
    ? listTypeRaw
    : null
  const listLevel = Number(node.attrs.listLevel ?? 0)

  let role: ParagraphContentSnapshot['role']
  let headingLevel: 1 | 2 | 3 | null = null
  if (charCount === 0 && inlineImages.length === 0) {
    role = 'empty'
  } else if (inlineImages.length > 0 && nonImageInlineCount === 0) {
    role = 'image-only'
  } else if (listType === 'task') {
    role = 'task-item'
  } else if (listType === 'bullet' || listType === 'ordered') {
    role = 'list-item'
  } else {
    headingLevel = inferHeadingLevel(node, text)
    role = headingLevel != null ? 'heading' : 'paragraph'
  }

  const snapshot: ParagraphContentSnapshot = { index, text, charCount, role }
  if (headingLevel != null) snapshot.headingLevel = headingLevel
  if (listType) {
    const list: NonNullable<ParagraphContentSnapshot['list']> = { type: listType, level: listLevel }
    if (listType === 'task') list.checked = Boolean(node.attrs.listChecked ?? false)
    snapshot.list = list
  }
  if (inlineImages.length > 0) snapshot.inlineImages = inlineImages
  if (linkMap.size > 0) snapshot.links = [...linkMap.values()]
  return snapshot
}

function buildTableContentSnapshot(tableNode: PMNode) {
  const rows = tableNode.content.content.map((rowNode, rowIndex) => {
    const cells = rowNode.content.content.map((cellNode) => {
      const cellText = cellNode.content.content
        .filter(child => child.type.name === 'paragraph')
        .map(child => buildParagraphContentSnapshot(child, null).text)
        .join('\n')
      return {
        header: Boolean(cellNode.attrs.header ?? false),
        colspan: Number(cellNode.attrs.colspan ?? 1),
        rowspan: Number(cellNode.attrs.rowspan ?? 1),
        text: cellText,
      }
    })
    return { rowIndex, cells }
  })

  return {
    rowCount: rows.length,
    colCount: rows.reduce((max, row) => Math.max(max, row.cells.length), 0),
    headerRow: rows[0]?.cells.some(cell => cell.header) ?? false,
    rows,
  }
}

function buildBlockContentSnapshot(block: BlockRef) {
  switch (block.node.type.name) {
    case 'paragraph':
      return {
        blockIndex: block.blockIndex,
        type: 'paragraph' as const,
        paragraphIndex: block.paragraphIndex,
        afterParagraphIndex: block.afterParagraphIndex,
        ...buildParagraphContentSnapshot(block.node, block.paragraphIndex),
      }
    case 'table':
      return {
        blockIndex: block.blockIndex,
        type: 'table' as const,
        paragraphIndex: block.paragraphIndex,
        afterParagraphIndex: block.afterParagraphIndex,
        ...buildTableContentSnapshot(block.node),
      }
    case 'horizontal_rule':
      return {
        blockIndex: block.blockIndex,
        type: 'horizontal_rule' as const,
        paragraphIndex: block.paragraphIndex,
        afterParagraphIndex: block.afterParagraphIndex,
        text: '---',
      }
    case 'table_of_contents':
      return {
        blockIndex: block.blockIndex,
        type: 'table_of_contents' as const,
        paragraphIndex: block.paragraphIndex,
        afterParagraphIndex: block.afterParagraphIndex,
        title: String(block.node.attrs.title ?? '目录'),
        minLevel: Number(block.node.attrs.minLevel ?? 1),
        maxLevel: Number(block.node.attrs.maxLevel ?? 3),
        text: '[Word 自动目录]',
      }
    case 'floating_object': {
      const attrs = block.node.attrs as Record<string, unknown>
      const kind = String(attrs.kind ?? 'textbox')
      const alt = String(attrs.alt ?? '')
      const { srcKind, srcPreview } = summarizeImageSrc(attrs.src)
      const embeddedParagraphsRaw = Array.isArray(attrs.paragraphs) ? attrs.paragraphs : []
      // floating_object.paragraphs 是序列化后的段落数据，结构与 ProseMirror 节点不同，
      // 这里只透出可见文字，避免引入额外样式字段。
      const paragraphs = embeddedParagraphsRaw
        .map((para: unknown) => {
          if (!para || typeof para !== 'object') return ''
          const text = (para as { text?: unknown }).text
          return typeof text === 'string' ? text : ''
        })
        .filter(text => text.length > 0)
      return {
        blockIndex: block.blockIndex,
        type: 'floating_object' as const,
        paragraphIndex: block.paragraphIndex,
        afterParagraphIndex: block.afterParagraphIndex,
        kind,
        alt,
        srcKind: attrs.src ? srcKind : undefined,
        srcPreview: attrs.src ? srcPreview : undefined,
        paragraphs,
      }
    }
    default:
      return {
        blockIndex: block.blockIndex,
        type: block.node.type.name,
        paragraphIndex: block.paragraphIndex,
        afterParagraphIndex: block.afterParagraphIndex,
        text: block.node.textContent,
      }
  }
}

function buildTableSnapshot(tableNode: PMNode, includeTextRuns = true) {
  const rows = tableNode.content.content.map((rowNode, rowIndex) => {
    const cells = rowNode.content.content.map((cellNode) => {
      const paragraphs = cellNode.content.content
        .filter(child => child.type.name === 'paragraph')
        .map(child => buildParagraphNodeSnapshot(child, null, includeTextRuns))
      const text = paragraphs.map(paragraph => paragraph.text).join('\n')
      return {
        header: Boolean(cellNode.attrs.header ?? false),
        colspan: Number(cellNode.attrs.colspan ?? 1),
        rowspan: Number(cellNode.attrs.rowspan ?? 1),
        width: cellNode.attrs.width ?? null,
        text,
        paragraphs,
      }
    })
    return { rowIndex, cells }
  })

  return {
    rowCount: rows.length,
    colCount: rows.reduce((max, row) => Math.max(max, row.cells.length), 0),
    headerRow: rows[0]?.cells.some(cell => cell.header) ?? false,
    text: rows
      .flatMap(row => row.cells.map(cell => cell.text))
      .filter(Boolean)
      .join(' | '),
    rows,
  }
}

function getSelectedTable(state: EditorState) {
  return findTable(state.selection.$from) ?? findTable(state.selection.$anchor)
}

function executeTableCommand(
  view: EditorView,
  command: (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean,
  successMessage: string,
): ExecuteResult {
  const { state } = view

  if (!isInTable(state)) {
    return { success: false, message: '当前光标不在表格中，无法执行行列编辑' }
  }

  const success = command(state, view.dispatch)
  if (!success) {
    return { success: false, message: '当前表格无法执行该操作，请确认光标位于可编辑单元格中' }
  }

  view.focus()
  const selectedTable = getSelectedTable(view.state)

  return {
    success: true,
    message: successMessage,
    data: selectedTable
      ? {
        table: buildTableSnapshot(selectedTable.node),
      }
      : undefined,
  }
}

function buildBlockSnapshot(block: BlockRef, includeTextRuns = true) {
  switch (block.node.type.name) {
    case 'paragraph':
      return {
        blockIndex: block.blockIndex,
        type: 'paragraph',
        paragraphIndex: block.paragraphIndex,
        afterParagraphIndex: block.afterParagraphIndex,
        ...buildParagraphNodeSnapshot(block.node, block.paragraphIndex, includeTextRuns),
      }
    case 'table':
      return {
        blockIndex: block.blockIndex,
        type: 'table',
        paragraphIndex: block.paragraphIndex,
        afterParagraphIndex: block.afterParagraphIndex,
        ...buildTableSnapshot(block.node, includeTextRuns),
      }
    case 'horizontal_rule':
      return {
        blockIndex: block.blockIndex,
        type: 'horizontal_rule',
        paragraphIndex: block.paragraphIndex,
        afterParagraphIndex: block.afterParagraphIndex,
        text: '',
      }
    case 'table_of_contents':
      return {
        blockIndex: block.blockIndex,
        type: 'table_of_contents',
        paragraphIndex: block.paragraphIndex,
        afterParagraphIndex: block.afterParagraphIndex,
        title: String(block.node.attrs.title ?? '目录'),
        minLevel: Number(block.node.attrs.minLevel ?? 1),
        maxLevel: Number(block.node.attrs.maxLevel ?? 3),
        hyperlink: block.node.attrs.hyperlink !== false,
        text: '[Word 自动目录]',
      }
    default:
      return {
        blockIndex: block.blockIndex,
        type: block.node.type.name,
        paragraphIndex: block.paragraphIndex,
        afterParagraphIndex: block.afterParagraphIndex,
        text: block.node.textContent,
      }
  }
}

function buildStyleSignature(paragraph: ReturnType<typeof buildParagraphSnapshot>) {
  const style = paragraph.style
  return [
    `${style.fontFamily}/${style.fontSize}`,
    style.bold ? 'bold' : 'regular',
    style.align,
    `line:${style.lineHeight}`,
    `first:${style.firstLineIndent}`,
    `indent:${style.indent}`,
    `list:${style.listType ?? 'none'}`,
    style.listType === 'task' ? (style.listChecked ? 'checked' : 'unchecked') : 'list-n/a',
    style.pageBreakBefore ? 'page-break' : 'flow',
  ].join(' | ')
}

function buildCommonStyleSummary(paragraphs: ReturnType<typeof buildParagraphSnapshot>[]) {
  const counter = new Map<string, { count: number; sampleParagraphs: number[] }>()

  for (const paragraph of paragraphs) {
    const key = buildStyleSignature(paragraph)
    const current = counter.get(key) ?? { count: 0, sampleParagraphs: [] }
    current.count += 1
    if (current.sampleParagraphs.length < 3 && typeof paragraph.index === 'number') current.sampleParagraphs.push(paragraph.index)
    counter.set(key, current)
  }

  return [...counter.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 8)
    .map(([signature, value]) => ({
      signature,
      count: value.count,
      sampleParagraphs: value.sampleParagraphs,
    }))
}

function buildPageTextPreview(lines: Array<{ text: string }>) {
  const text = lines
    .map(line => line.text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')

  return text.length > 180 ? `${text.slice(0, 180)}...` : text
}

function buildPaginationSummary(state: EditorState, pageConfig?: PageConfig) {
  return paginate(state.doc, pageConfig)
}

function getDocumentInfo(state: EditorState, params: Record<string, unknown>, options?: ExecuteOptions): ExecuteResult {
  const detail = resolveDetailMode(params.detail)
  const paragraphs = getParagraphs(state)
  const wordCount = state.doc.textContent.length
  const pagination = buildPaginationSummary(state, options?.pageConfig)
  const blocks = getBlocks(state)
  const blockCounts = blocks.reduce<Record<string, number>>((counts, block) => {
    counts[block.node.type.name] = (counts[block.node.type.name] ?? 0) + 1
    return counts
  }, {})

  const data: Record<string, unknown> = {
    paragraphCount: paragraphs.length,
    wordCount,
    pageCount: pagination.renderedPages.length,
    pageBreakCount: pagination.breaks.length,
    blockCounts,
  }
  if (detail === 'format') {
    const paragraphSnapshots = paragraphs.map(paragraph => buildParagraphSnapshot(paragraph, false))
    data.commonStyles = buildCommonStyleSummary(paragraphSnapshots)
  }

  return {
    success: true,
    message: `文档共 ${paragraphs.length} 个段落，约 ${wordCount} 字`,
    data,
  }
}

function getDocumentOutline(state: EditorState, params: Record<string, unknown>, options?: ExecuteOptions): ExecuteResult {
  const detail = resolveDetailMode(params.detail)
  const paragraphs = getParagraphs(state)
  const blocks = getBlocks(state)
  const pagination = buildPaginationSummary(state, options?.pageConfig)

  const pages = pagination.renderedPages.map((page, pageIndex) => {
    const pageBlocks = [...new Set(page.lines.map(line => line.blockIndex))]
      .map(index => blocks[index])
      .filter((block): block is BlockRef => Boolean(block))
    const paragraphIndexes = [...new Set(pageBlocks.flatMap(block => (block.paragraphIndex == null ? [] : [block.paragraphIndex])))]

    return {
      page: pageIndex + 1,
      blockCount: pageBlocks.length,
      paragraphIndexes,
      paragraphRange: paragraphIndexes.length > 0
        ? { from: Math.min(...paragraphIndexes), to: Math.max(...paragraphIndexes) }
        : null,
      previewText: buildPageTextPreview(page.lines),
      containsTable: pageBlocks.some(block => block.node.type.name === 'table'),
      containsHorizontalRule: pageBlocks.some(block => block.node.type.name === 'horizontal_rule'),
      containsImage: pageBlocks.some(block => (
        block.node.type.name === 'paragraph' && block.node.content.content.some(child => child.type.name === 'image')
      )),
    }
  })

  const totalChars = paragraphs.reduce((sum, paragraph) => sum + paragraph.node.textContent.length, 0)
  const data: Record<string, unknown> = {
    paragraphCount: paragraphs.length,
    totalChars,
    pageCount: pages.length,
    pages,
  }
  if (detail === 'format') {
    const paragraphSnapshots = paragraphs.map(paragraph => buildParagraphSnapshot(paragraph, false))
    data.commonStyles = buildCommonStyleSummary(paragraphSnapshots)
  }

  return {
    success: true,
    message: `已生成 ${pages.length} 页文档概览`,
    data,
  }
}

function getDocumentContent(state: EditorState, params: Record<string, unknown>, options?: ExecuteOptions): ExecuteResult {
  const detail = resolveDetailMode(params.detail)
  const fromParagraph = Number.isInteger(params.fromParagraph) ? Number(params.fromParagraph) : 0
  const allParagraphs = getParagraphs(state)
  const maxIndex = Math.max(0, allParagraphs.length - 1)
  const toParagraph = Number.isInteger(params.toParagraph) ? Number(params.toParagraph) : maxIndex
  const includeTextRuns = detail === 'format' ? params.includeTextRuns !== false : false
  const paragraphRefs = allParagraphs.filter(paragraph => (
    paragraph.index >= fromParagraph && paragraph.index <= toParagraph
  ))

  if (paragraphRefs.length === 0) {
    return {
      success: false,
      message: `未找到第 ${fromParagraph + 1} 到第 ${toParagraph + 1} 段`,
    }
  }

  const firstParagraphIndex = paragraphRefs[0]!.index
  const lastParagraphIndex = paragraphRefs.at(-1)!.index
  const pagination = buildPaginationSummary(state, options?.pageConfig)
  const blocks = getBlocks(state)
  const blocksInRange = blocks.filter(block => (
    (block.paragraphIndex != null && block.paragraphIndex >= firstParagraphIndex && block.paragraphIndex <= lastParagraphIndex)
    || (block.afterParagraphIndex != null && block.afterParagraphIndex >= firstParagraphIndex && block.afterParagraphIndex <= lastParagraphIndex)
  ))
  const pageRanges = pagination.renderedPages.map((page, pageIndex) => {
    const pageParagraphIndexes = [...new Set(
      page.lines
        .map(line => blocks[line.blockIndex]?.paragraphIndex)
        .filter((value): value is number => typeof value === 'number')
    )]

    return {
      page: pageIndex + 1,
      paragraphRange: pageParagraphIndexes.length > 0
        ? { from: Math.min(...pageParagraphIndexes), to: Math.max(...pageParagraphIndexes) }
        : null,
    }
  })

  if (detail === 'format') {
    const paragraphs = paragraphRefs.map(paragraph => buildParagraphSnapshot(paragraph, includeTextRuns))
    const totalChars = paragraphs.reduce((sum, paragraph) => sum + paragraph.charCount, 0)
    return {
      success: true,
      message: `已读取第 ${firstParagraphIndex + 1} 到第 ${lastParagraphIndex + 1} 段（format）`,
      data: {
        detail,
        fromParagraph: firstParagraphIndex,
        toParagraph: lastParagraphIndex,
        paragraphCount: paragraphs.length,
        totalChars,
        paragraphs,
        blocks: blocksInRange.map(block => buildBlockSnapshot(block, includeTextRuns)),
        pageRanges,
      },
    }
  }

  const paragraphs = paragraphRefs.map(paragraph => buildParagraphContentSnapshot(paragraph.node, paragraph.index))
  const totalChars = paragraphs.reduce((sum, paragraph) => sum + paragraph.charCount, 0)
  return {
    success: true,
    message: `已读取第 ${firstParagraphIndex + 1} 到第 ${lastParagraphIndex + 1} 段`,
    data: {
      detail,
      fromParagraph: firstParagraphIndex,
      toParagraph: lastParagraphIndex,
      paragraphCount: paragraphs.length,
      totalChars,
      paragraphs,
      blocks: blocksInRange.map(block => buildBlockContentSnapshot(block)),
      pageRanges,
    },
  }
}

function getPageContent(state: EditorState, params: Record<string, unknown>, options?: ExecuteOptions): ExecuteResult {
  const pageNumber = Number(params.page)
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    return { success: false, message: 'page 必须是从 1 开始的整数' }
  }
  const detail = resolveDetailMode(params.detail)
  const includeTextRuns = detail === 'format' ? params.includeTextRuns === true : false

  const blocks = getBlocks(state)
  const paragraphs = getParagraphs(state)
  const pagination = buildPaginationSummary(state, options?.pageConfig)
  const page = pagination.renderedPages[pageNumber - 1]

  if (!page) {
    return { success: false, message: `未找到第 ${pageNumber} 页` }
  }

  const blockIndexes = [...new Set(page.lines.map(line => line.blockIndex))]
  const pageBlocks = blockIndexes
    .map(index => blocks[index])
    .filter((block): block is BlockRef => Boolean(block))
  const paragraphIndexes = [...new Set(pageBlocks.flatMap(block => (block.paragraphIndex == null ? [] : [block.paragraphIndex])))]
  const paragraphRefs = paragraphIndexes
    .map(index => paragraphs[index])
    .filter((paragraph): paragraph is ParagraphRef => Boolean(paragraph))

  if (detail === 'format') {
    return {
      success: true,
      message: `已读取第 ${pageNumber} 页（format）`,
      data: {
        detail,
        page: pageNumber,
        pageCount: pagination.renderedPages.length,
        paragraphIndexes,
        paragraphRange: paragraphIndexes.length > 0
          ? { from: Math.min(...paragraphIndexes), to: Math.max(...paragraphIndexes) }
          : null,
        previewText: buildPageTextPreview(page.lines),
        blocks: pageBlocks.map(block => buildBlockSnapshot(block, includeTextRuns)),
        lines: page.lines.map(line => ({
          blockIndex: line.blockIndex,
          lineIndex: line.lineIndex,
          text: line.text,
          top: Math.round(line.top),
          startPos: line.startPos,
        })),
        paragraphs: paragraphRefs.map(paragraph => buildParagraphSnapshot(paragraph, includeTextRuns)),
      },
    }
  }

  return {
    success: true,
    message: `已读取第 ${pageNumber} 页`,
    data: {
      detail,
      page: pageNumber,
      pageCount: pagination.renderedPages.length,
      paragraphIndexes,
      paragraphRange: paragraphIndexes.length > 0
        ? { from: Math.min(...paragraphIndexes), to: Math.max(...paragraphIndexes) }
        : null,
      previewText: buildPageTextPreview(page.lines),
      blocks: pageBlocks.map(block => buildBlockContentSnapshot(block)),
      lines: page.lines.map(line => ({
        blockIndex: line.blockIndex,
        lineIndex: line.lineIndex,
        text: line.text,
      })),
      paragraphs: paragraphRefs.map(paragraph => buildParagraphContentSnapshot(paragraph.node, paragraph.index)),
    },
  }
}

function getPageStyleSummary(state: EditorState, pageNumber: number, options?: ExecuteOptions): ExecuteResult {
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    return { success: false, message: 'page 必须是从 1 开始的整数' }
  }

  const blocks = getBlocks(state)
  const paragraphs = getParagraphs(state)
  const pagination = buildPaginationSummary(state, options?.pageConfig)
  const page = pagination.renderedPages[pageNumber - 1]

  if (!page) {
    return { success: false, message: `未找到第 ${pageNumber} 页` }
  }

  const blockIndexes = [...new Set(page.lines.map(line => line.blockIndex))]
  const pageBlocks = blockIndexes
    .map(index => blocks[index])
    .filter((block): block is BlockRef => Boolean(block))
  const paragraphIndexes = [...new Set(pageBlocks.flatMap(block => (block.paragraphIndex == null ? [] : [block.paragraphIndex])))]
  const pageParagraphs = paragraphIndexes
    .map(index => paragraphs[index])
    .filter((paragraph): paragraph is ParagraphRef => Boolean(paragraph))
    .map(paragraph => buildParagraphSnapshot(paragraph, true))

  const paragraphStyles = pageParagraphs.map(paragraph => ({
    index: paragraph.index,
    textPreview: paragraph.text.length > 60 ? `${paragraph.text.slice(0, 60)}...` : paragraph.text,
    styleSignature: buildStyleSignature(paragraph),
    paragraphStyle: paragraph.paragraphStyle,
    representativeTextStyle: paragraph.representativeTextStyle,
    hasMixedTextStyles: paragraph.hasMixedTextStyles,
    likelyHeading:
      paragraph.text.length > 0
      && paragraph.text.length <= 40
      && (
        paragraph.representativeTextStyle.bold
        || paragraph.representativeTextStyle.fontSize >= 14
        || paragraph.paragraphStyle.align === 'center'
      ),
  }))

  return {
    success: true,
    message: `已读取第 ${pageNumber} 页样式摘要`,
    data: {
      page: pageNumber,
      pageCount: pagination.renderedPages.length,
      paragraphIndexes,
      paragraphRange: paragraphIndexes.length > 0
        ? { from: Math.min(...paragraphIndexes), to: Math.max(...paragraphIndexes) }
        : null,
      previewText: buildPageTextPreview(page.lines),
      commonStyles: buildCommonStyleSummary(pageParagraphs),
      paragraphs: paragraphStyles,
    },
  }
}

function getParagraph(state: EditorState, index: number, detail: DetailMode): ExecuteResult {
  const paragraph = getParagraphAtIndex(state, index)
  if (!paragraph) {
    return { success: false, message: `未找到第 ${index + 1} 段` }
  }

  return {
    success: true,
    message: detail === 'format' ? `已读取第 ${index + 1} 段（format）` : `已读取第 ${index + 1} 段`,
    data: detail === 'format'
      ? { detail, ...buildParagraphSnapshot(paragraph) }
      : { detail, ...buildParagraphContentSnapshot(paragraph.node, paragraph.index) },
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
    ; ({ pageWidth, pageHeight } = PAPER_SIZES[paperSize])
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

export function beginStreamingWrite(
  view: EditorView,
  params: Record<string, unknown>,
): BeginStreamingWriteResult {
  const { state, dispatch } = view
  const action = String(params.action ?? '')

  if (action === 'insert_after_paragraph') {
    const afterParagraph = Number(params.afterParagraph)
    const paragraph = afterParagraph >= 0 ? getParagraphAtIndex(state, afterParagraph) : getParagraphAtIndex(state, 0)
    if (afterParagraph < -1 || !paragraph) return { success: false, message: `未找到第 ${afterParagraph + 1} 段` }

    const inserted = insertBlockAfterParagraph(state, afterParagraph, buildParagraphNodeFromText(paragraph, ''))
    if (!inserted.success || !inserted.tr) return inserted

    dispatch(inserted.tr)
    view.focus()

    const targetParagraph = getParagraphAtIndex(view.state, afterParagraph + 1)
    if (!targetParagraph) {
      return { success: false, message: '已创建流式写入占位段落，但无法定位写入位置' }
    }

    return {
      success: true,
      message: `已开始在第 ${afterParagraph + 1} 段后流式写入正文`,
      session: {
        id: `stream-${Date.now()}`,
        action: 'insert_after_paragraph',
        from: targetParagraph.pos,
        to: targetParagraph.pos + targetParagraph.node.nodeSize,
        text: '',
        format: 'markdown',
        paragraphAttrs: { ...(paragraph.node.attrs as Record<string, unknown>) },
        rollbackFragment: Fragment.empty,
      },
    }
  }

  if (action === 'replace_paragraph') {
    const paragraphIndex = Number(params.paragraphIndex)
    const paragraph = getParagraphAtIndex(state, paragraphIndex)
    if (!paragraph) return { success: false, message: `未找到第 ${paragraphIndex + 1} 段` }

    dispatch(
      state.tr.replaceWith(
        paragraph.pos,
        paragraph.pos + paragraph.node.nodeSize,
        buildParagraphNodeFromText(paragraph, ''),
      ),
    )
    view.focus()

    const targetParagraph = getParagraphAtIndex(view.state, paragraphIndex)
    if (!targetParagraph) {
      return { success: false, message: '已创建流式写入占位段落，但无法定位写入位置' }
    }

    return {
      success: true,
      message: `已开始流式改写第 ${paragraphIndex + 1} 段`,
      session: {
        id: `stream-${Date.now()}`,
        action: 'replace_paragraph',
        from: targetParagraph.pos,
        to: targetParagraph.pos + targetParagraph.node.nodeSize,
        text: '',
        format: 'markdown',
        paragraphAttrs: { ...(paragraph.node.attrs as Record<string, unknown>) },
        rollbackFragment: Fragment.from(paragraph.node),
      },
    }
  }

  return { success: false, message: `begin_streaming_write 的 action 无效：${action || '空值'}` }
}

export function appendStreamingWrite(
  view: EditorView,
  session: StreamingWriteSession,
  chunk: string,
  options?: { final?: boolean },
): ExecuteResult {
  if (!chunk) return { success: true, message: '本次未追加正文内容' }

  const nextText = session.text + chunk
  const fragment = markdownToFragment(nextText, { baseParagraphAttrs: session.paragraphAttrs })

  const tr = view.state.tr.replaceWith(session.from, session.to, fragment)
  if (!options?.final) tr.setMeta('addToHistory', false)
  view.dispatch(tr)

  session.text = nextText
  session.to = session.from + fragment.size

  return { success: true, message: '正文流式写入中' }
}

export function abortStreamingWrite(
  view: EditorView,
  session: StreamingWriteSession,
): ExecuteResult {
  if (session.text.trim()) {
    return { success: true, message: '流式写入已有正文，无需回滚' }
  }

  view.dispatch(view.state.tr.replaceWith(session.from, session.to, session.rollbackFragment).setMeta('addToHistory', false))
  return { success: true, message: '已回滚空的流式写入占位内容' }
}

export async function executeTool(
  view: EditorView,
  toolName: string,
  params: Record<string, unknown>,
  options?: ExecuteOptions
): Promise<ExecuteResult> {
  const { state, dispatch } = view
  let tr = state.tr

  try {
    switch (toolName) {
      case 'search_text': {
        const text = String(params.text ?? '')
        if (!text) return { success: false, message: 'search_text 需要提供非空 text' }
        const maxResults = Math.max(1, Math.min(200, Number(params.maxResults ?? 80) || 80))
        const searchRange: RangeSpec = {
          type: 'contains_text',
          text,
          caseSensitive: params.caseSensitive === true,
          matchMode: params.matchMode === 'exact' ? 'exact' : 'contains',
          textOccurrence: 'all',
          paragraphIndex: Number.isInteger(params.paragraphIndex) ? Number(params.paragraphIndex) : undefined,
          from: Number.isInteger(params.fromParagraph) ? Number(params.fromParagraph) : undefined,
          to: Number.isInteger(params.toParagraph) ? Number(params.toParagraph) : undefined,
          paragraphIndexes: normalizeParagraphIndexes(params.paragraphIndexes),
        }
        const matches = resolveTextMatches(state, searchRange, options?.selectionContext)
        const returnedMatches = matches.slice(0, maxResults).map((match) => {
          const paragraphText = match.paragraph.node.textContent
          const before = paragraphText.slice(Math.max(0, match.startOffset - 24), match.startOffset)
          const after = paragraphText.slice(match.endOffset, Math.min(paragraphText.length, match.endOffset + 24))
          const textRange = {
            paragraphIndex: match.paragraph.index,
            startOffset: match.startOffset,
            endOffset: match.endOffset,
            text: match.matchText,
          }
          return {
            matchIndex: match.matchIndex,
            paragraphIndex: match.paragraph.index,
            startOffset: match.startOffset,
            endOffset: match.endOffset,
            text: match.matchText,
            before,
            after,
            range: {
              type: 'text_ranges',
              caseSensitive: true,
              textRanges: [textRange],
            },
          }
        })
        return {
          success: true,
          message: matches.length > 0 ? `找到 ${matches.length} 处匹配文字` : `未找到文字“${text}”`,
          data: {
            query: text,
            matchCount: matches.length,
            returnedCount: returnedMatches.length,
            caseSensitive: searchRange.caseSensitive,
            matchMode: searchRange.matchMode,
            matches: returnedMatches,
            lockedRange: {
              type: 'text_ranges',
              caseSensitive: true,
              textRanges: returnedMatches.map(match => ({
                paragraphIndex: match.paragraphIndex,
                startOffset: match.startOffset,
                endOffset: match.endOffset,
                text: match.text,
              })),
            },
          },
        }
      }

      case 'set_text_style': {
        const range = params.range as RangeSpec | undefined
        const rangeCheck = validateRange('set_text_style', range)
        if (!rangeCheck.valid) return { success: false, message: rangeCheck.error }
        const textMatches = resolveTextMatches(state, range, options?.selectionContext)
        if (textMatches.length === 0) {
          return {
            success: false,
            message: range!.type === 'selection'
              ? '当前没有可用的选区，无法按 selection 修改文字样式'
              : `未找到可设置文字样式的范围：${describeRange(range)}`,
          }
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
        const affectedIndexes = [...new Set(textMatches.map(match => match.paragraph.index).filter(index => index >= 0))]
        return {
          success: true,
          message: `文字样式已更新（${describeRange(range)}）`,
          data: {
            matchedTextCount: textMatches.length,
            affectedParagraphs: buildCompactParagraphSnapshot(view.state, affectedIndexes),
          },
        }
      }

      case 'set_paragraph_style': {
        const range = params.range as RangeSpec | undefined
        const rangeCheck = validateRange('set_paragraph_style', range)
        if (!rangeCheck.valid) return { success: false, message: rangeCheck.error }
        if (range!.type === 'selection' && !getSelectionBounds(state, range, options?.selectionContext)) {
          return { success: false, message: '当前没有可用的选区，无法按 selection 修改段落格式' }
        }
        const resolved = resolveRange(state, range, options?.selectionContext)
        if (resolved.length === 0) {
          return { success: false, message: `未找到可设置段落格式的范围：${describeRange(range)}` }
        }
        const { range: _range, ...rawParaAttrs } = params
        const paraAttrs = Object.fromEntries(
          Object.entries(rawParaAttrs).filter(([, value]) => value !== undefined)
        )
        if (paraAttrs.listType === 'none') paraAttrs.listType = null
        if (paraAttrs.headingLevel === 0 || paraAttrs.headingLevel === 'none') paraAttrs.headingLevel = null
        tr = applyParagraphStyle(state, tr, range, paraAttrs, options?.selectionContext)
        dispatch(tr)
        options?.onDocumentStyleMutation?.()
        view.focus()
        const affectedIndexes = resolved.map(p => p.index)
        return {
          success: true,
          message: `段落格式已更新（${describeRange(range)}）`,
          data: { affectedParagraphs: buildCompactParagraphSnapshot(view.state, affectedIndexes) },
        }
      }

      case 'clear_formatting': {
        const range = params.range as RangeSpec | undefined
        const rangeCheck = validateRange('clear_formatting', range)
        if (!rangeCheck.valid) return { success: false, message: rangeCheck.error }
        if (range!.type === 'selection' && !getSelectionBounds(state, range, options?.selectionContext)) {
          return { success: false, message: '当前没有可用的选区，无法清除 selection 范围的格式' }
        }
        const resolved = resolveRange(state, range, options?.selectionContext)
        if (range!.type !== 'selection' && resolved.length === 0) {
          return { success: false, message: `未找到可清除格式的范围：${describeRange(range)}` }
        }
        const clearTextStyles = params.clearTextStyles !== false
        const clearParagraphStyles = params.clearParagraphStyles !== false
        tr = clearFormatting(state, tr, range, options?.selectionContext, clearTextStyles, clearParagraphStyles)
        dispatch(tr)
        options?.onDocumentStyleMutation?.()
        view.focus()
        const affectedIndexes = resolved.map(p => p.index)
        return {
          success: true,
          message: `已清除指定范围的格式（${describeRange(range)}）`,
          data: { affectedParagraphs: buildCompactParagraphSnapshot(view.state, affectedIndexes) },
        }
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

      case 'insert_table_of_contents': {
        const afterParagraph = Number(params.afterParagraph ?? -1)
        const minLevel = Math.min(6, Math.max(1, Number(params.minLevel ?? 1)))
        const maxLevel = Math.min(6, Math.max(minLevel, Number(params.maxLevel ?? 3)))
        const tocNode = schema.nodes.table_of_contents.create({
          title: String(params.title ?? '目录') || '目录',
          minLevel,
          maxLevel,
          hyperlink: params.hyperlink !== false,
        })
        const inserted = insertBlockAfterParagraph(state, afterParagraph, tocNode)
        if (!inserted.success || !inserted.tr) return inserted
        dispatch(inserted.tr)
        view.focus()
        return {
          success: true,
          message: `已插入 Word 自动目录（标题级别 ${minLevel}-${maxLevel}）`,
          data: {
            tableOfContents: {
              title: tocNode.attrs.title,
              minLevel,
              maxLevel,
              hyperlink: tocNode.attrs.hyperlink !== false,
            },
          },
        }
      }

      case 'insert_table': {
        const tableData = Array.isArray(params.data)
          ? params.data.map(row => (
            Array.isArray(row)
              ? row.map(cell => normalizeToolText(String(cell ?? '')))
              : []
          ))
          : []
        const dataRows = tableData.length
        const dataCols = tableData.reduce((max, row) => Math.max(max, row.length), 0)
        const rows = Math.min(20, Math.max(1, dataRows || Number(params.rows) || 1))
        const cols = Math.min(10, Math.max(1, dataCols || Number(params.cols) || 1))
        const headerRow = Boolean(params.headerRow ?? (dataRows > 0))
        const afterParagraph = Number(params.afterParagraph)

        const tableNode = schema.nodes.table.create(
          null,
          Array.from({ length: rows }, (_, rowIndex) =>
            schema.nodes.table_row.create(
              null,
              Array.from({ length: cols }, (_, colIndex) =>
                schema.nodes.table_cell.create(
                  { header: headerRow && rowIndex === 0 },
                  buildParagraphNodesFromText(tableData[rowIndex]?.[colIndex] ?? '')
                )
              )
            )
          )
        )

        const inserted = insertBlockAfterParagraph(state, afterParagraph, tableNode)
        if (!inserted.success || !inserted.tr) return inserted
        dispatch(inserted.tr)
        view.focus()
        return {
          success: true,
          message: `已插入 ${rows} 行 ${cols} 列表格${dataRows > 0 ? '，并填充内容' : ''}`,
          data: { table: buildTableSnapshot(tableNode) },
        }
      }

      case 'insert_table_row_before':
        return executeTableCommand(view, addRowBefore, '已在当前行上方插入一行')

      case 'insert_table_row_after':
        return executeTableCommand(view, addRowAfter, '已在当前行下方插入一行')

      case 'delete_table_row':
        return executeTableCommand(view, deleteRow, '已删除当前行')

      case 'insert_table_column_before':
        return executeTableCommand(view, addColumnBefore, '已在当前列左侧插入一列')

      case 'insert_table_column_after':
        return executeTableCommand(view, addColumnAfter, '已在当前列右侧插入一列')

      case 'delete_table_column':
        return executeTableCommand(view, deleteColumn, '已删除当前列')

      case 'insert_text': {
        const paragraphIndex = Number(params.paragraphIndex)
        const text = normalizeToolText(String(params.text ?? ''))
        const paragraph = getParagraphAtIndex(state, paragraphIndex)
        if (!paragraph) return { success: false, message: `未找到第 ${paragraphIndex + 1} 段` }
        const insertPos = paragraph.pos + paragraph.node.nodeSize - 1
        tr.insertText(text, insertPos)
        dispatch(tr)
        view.focus()
        return { success: true, message: `已在第 ${paragraphIndex + 1} 段末尾插入文字` }
      }

      case 'begin_streaming_write': {
        const result = beginStreamingWrite(view, params)
        return { success: result.success, message: result.message }
      }

      case 'insert_image': {
        const src = String(params.src ?? '')
        if (!src) return { success: false, message: 'insert_image 需要 src 参数' }
        const alt = String(params.alt ?? '')
        const afterParagraph = params.afterParagraph !== undefined ? Number(params.afterParagraph) : -2
        const imageNode = schema.nodes.image.create({ src, alt, width: null, height: null })
        const paragraphNode = schema.nodes.paragraph.create(undefined, imageNode)

        if (afterParagraph === -2) {
          // 未指定位置 → 插入到文档末尾
          const insertPos = state.doc.content.size
          dispatch(state.tr.insert(insertPos, paragraphNode))
        } else {
          const inserted = insertBlockAfterParagraph(state, afterParagraph, paragraphNode)
          if (!inserted.success || !inserted.tr) return inserted
          dispatch(inserted.tr)
        }
        view.focus()
        return { success: true, message: `已插入图片${alt ? `（${alt}）` : ''}` }
      }

      case 'insert_mermaid': {
        const mermaidCode = String(params.code ?? '')
        if (!mermaidCode) return { success: false, message: 'insert_mermaid 需要 code 参数' }
        const mermaidAlt = String(params.alt ?? '') || 'Mermaid 图表'

        try {
          const renderId = `mermaid-tool-${Date.now()}`
          const { svg } = await mermaid.render(renderId, mermaidCode)
          const bytes = new TextEncoder().encode(svg)
          let binary = ''
          bytes.forEach(b => { binary += String.fromCharCode(b) })
          const b64 = btoa(binary)
          const svgDataUrl = `data:image/svg+xml;base64,${b64}`

          const imageNode = schema.nodes.image.create({ src: svgDataUrl, alt: mermaidAlt, width: null, height: null })
          const paragraphNode = schema.nodes.paragraph.create(undefined, imageNode)

          const afterParagraph = params.afterParagraph !== undefined ? Number(params.afterParagraph) : -2
          // Re-read state since mermaid.render is async
          const latestState = view.state
          if (afterParagraph === -2) {
            const insertPos = latestState.doc.content.size
            view.dispatch(latestState.tr.insert(insertPos, paragraphNode))
          } else {
            const paragraph = afterParagraph >= 0 ? getParagraphAtIndex(latestState, afterParagraph) : getParagraphAtIndex(latestState, 0)
            if (afterParagraph < -1 || !paragraph) {
              return { success: false, message: `未找到第 ${afterParagraph + 1} 段` }
            }
            const insertPos = getInsertPosAfterParagraph(latestState, afterParagraph)
            if (insertPos == null) {
              return { success: false, message: `未找到第 ${afterParagraph + 1} 段` }
            }
            const shouldAppendTrailingParagraph = insertPos >= latestState.doc.content.size && paragraphNode.type !== schema.nodes.paragraph
            const fragment = shouldAppendTrailingParagraph
              ? Fragment.fromArray([paragraphNode, schema.nodes.paragraph.create()])
              : Fragment.from(paragraphNode)
            view.dispatch(latestState.tr.insert(insertPos, fragment))
          }
          view.focus()
          return { success: true, message: `已插入 Mermaid 图表（${mermaidAlt}）` }
        } catch (err) {
          return { success: false, message: `Mermaid 渲染失败: ${err instanceof Error ? err.message : String(err)}` }
        }
      }

      case 'insert_paragraph_after': {
        const afterParagraph = Number(params.afterParagraph)
        const text = normalizeToolText(String(params.text ?? ''))
        const paragraph = afterParagraph >= 0 ? getParagraphAtIndex(state, afterParagraph) : getParagraphAtIndex(state, 0)
        if (!paragraph) return { success: false, message: `未找到第 ${afterParagraph + 1} 段` }
        const insertPos = getInsertPosAfterParagraph(state, afterParagraph)
        if (insertPos == null) return { success: false, message: `未找到第 ${afterParagraph + 1} 段` }
        const fragment = Fragment.fromArray(
          buildParagraphNodesFromText(text, paragraph.node.attrs as Record<string, unknown> | undefined),
        )
        dispatch(state.tr.insert(insertPos, fragment))
        view.focus()
        return { success: true, message: `已在第 ${afterParagraph + 1} 段后插入新段落` }
      }

      case 'replace_paragraph_text': {
        const paragraphIndex = Number(params.paragraphIndex)
        const text = normalizeToolText(String(params.text ?? ''))
        const paragraph = getParagraphAtIndex(state, paragraphIndex)
        if (!paragraph) return { success: false, message: `未找到第 ${paragraphIndex + 1} 段` }
        tr.replaceWith(
          paragraph.pos,
          paragraph.pos + paragraph.node.nodeSize,
          Fragment.fromArray(buildParagraphNodesFromText(text, paragraph.node.attrs as Record<string, unknown> | undefined)),
        )
        dispatch(tr)
        view.focus()
        return { success: true, message: `已替换第 ${paragraphIndex + 1} 段文字` }
      }

      case 'replace_selection_text': {
        const range = params.range as RangeSpec | undefined
        const text = normalizeToolText(String(params.text ?? ''))
        const bounds = getSelectionBounds(state, range, options?.selectionContext)
        if (!range || range.type !== 'selection' || !bounds) {
          return { success: false, message: 'replace_selection_text 需要有效的 selection 范围' }
        }
        if (text.includes('\n')) {
          const selectedParagraphs = resolveRange(state, range, options?.selectionContext)
          if (selectedParagraphs.length === 1 && isFullParagraphSelection(bounds, selectedParagraphs[0]!)) {
            const paragraph = selectedParagraphs[0]!
            tr.replaceWith(
              paragraph.pos,
              paragraph.pos + paragraph.node.nodeSize,
              Fragment.fromArray(buildParagraphNodesFromText(text, paragraph.node.attrs as Record<string, unknown> | undefined)),
            )
            dispatch(tr)
            view.focus()
            return { success: true, message: '已按多行内容替换当前段落' }
          }
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
        const indices = normalizeParagraphIndexes(params.indices)
        const targetIndexes = indices.length > 0
          ? [...indices].sort((a, b) => b - a)
          : (Number.isInteger(params.index) ? [Number(params.index)] : [])
        if (targetIndexes.length === 0) return { success: false, message: 'delete_paragraph 需要 index 或 indices 参数' }

        const paragraphs = getParagraphs(state)
        for (const index of targetIndexes) {
          const paragraph = paragraphs.find(item => item.index === index)
          if (!paragraph) return { success: false, message: `未找到第 ${index + 1} 段` }

          if (state.doc.childCount === 1 && targetIndexes.length === 1) {
            tr.replaceWith(paragraph.pos, paragraph.pos + paragraph.node.nodeSize, schema.nodes.paragraph.create())
          } else {
            tr.delete(paragraph.pos, paragraph.pos + paragraph.node.nodeSize)
          }
        }

        dispatch(tr)
        view.focus()
        return {
          success: true,
          message: targetIndexes.length === 1
            ? `已删除第 ${targetIndexes[0]! + 1} 段`
            : `已批量删除 ${targetIndexes.length} 个段落`,
        }
      }

      case 'get_document_info':
        return getDocumentInfo(state, params, options)

      case 'get_document_outline':
        return getDocumentOutline(state, params, options)

      case 'get_document_content':
        return getDocumentContent(state, params, options)

      case 'get_page_content':
        return getPageContent(state, params, options)

      case 'get_page_style_summary':
        return getPageStyleSummary(state, Number(params.page), options)

      case 'get_paragraph':
        return getParagraph(state, Number(params.index), resolveDetailMode(params.detail))

      case 'get_comments': {
        interface CommentEntry {
          id: string
          author: string
          date: string
          content: string
          paragraphIndex: number
          markedText: string
        }
        const comments: CommentEntry[] = []
        const commentType = schema.marks.comment
        if (!commentType) {
          return { success: true, message: '当前文档不支持批注功能', data: { comments: [] } }
        }

        let paraIdx = 0
        state.doc.forEach((node) => {
          if (node.type.name === 'paragraph') {
            node.forEach((inline) => {
              const commentMark = commentType.isInSet(inline.marks)
              if (commentMark && inline.isText) {
                comments.push({
                  id: String(commentMark.attrs.id ?? ''),
                  author: String(commentMark.attrs.author ?? ''),
                  date: String(commentMark.attrs.date ?? ''),
                  content: String(commentMark.attrs.content ?? ''),
                  paragraphIndex: paraIdx,
                  markedText: inline.text ?? '',
                })
              }
            })
            paraIdx++
          }
        })

        return {
          success: true,
          message: comments.length > 0 ? `共找到 ${comments.length} 条批注` : '文档中没有批注',
          data: { comments },
        }
      }

      case 'apply_style_batch': {
        const rules = Array.isArray(params.rules) ? params.rules : []
        if (rules.length === 0) return { success: false, message: 'apply_style_batch 需要至少一条规则' }

        const orderedRules = rules
          .map((rule, index) => ({ rule, index }))
          .sort((a, b) => {
            const specificityDiff = getRangeSpecificity((a.rule as Record<string, unknown>).range as RangeSpec | undefined)
              - getRangeSpecificity((b.rule as Record<string, unknown>).range as RangeSpec | undefined)
            return specificityDiff !== 0 ? specificityDiff : a.index - b.index
          })

        const allAffectedIndexes = new Set<number>()
        let currentTr = state.tr

        for (let i = 0; i < orderedRules.length; i++) {
          const rule = orderedRules[i]!.rule as Record<string, unknown>
          const range = rule.range as RangeSpec | undefined
          const rangeCheck = validateRange(`apply_style_batch.rules[${orderedRules[i]!.index}]`, range)
          if (!rangeCheck.valid) return { success: false, message: rangeCheck.error }

          const resolved = resolveRange(state, range, options?.selectionContext)
          for (const p of resolved) allAffectedIndexes.add(p.index)

          const textStyle = rule.textStyle as Record<string, unknown> | undefined
          if (textStyle && typeof textStyle === 'object') {
            const textMatches = resolveTextMatches(state, range, options?.selectionContext)
            for (const match of textMatches) {
              if (match.paragraph.index >= 0) allAffectedIndexes.add(match.paragraph.index)
            }
            const styleAttrs = Object.fromEntries(
              Object.entries(textStyle).filter(([, v]) => v !== undefined)
            )
            if (typeof styleAttrs.fontFamily === 'string') {
              styleAttrs.fontFamily = mapFontFamily(styleAttrs.fontFamily)
            }
            currentTr = applyTextStyle(state, currentTr, range, styleAttrs, options?.selectionContext)
          }

          const paragraphStyle = rule.paragraphStyle as Record<string, unknown> | undefined
          if (paragraphStyle && typeof paragraphStyle === 'object') {
            const paraAttrs = Object.fromEntries(
              Object.entries(paragraphStyle).filter(([, v]) => v !== undefined)
            )
            if (paraAttrs.listType === 'none') paraAttrs.listType = null
            if (paraAttrs.headingLevel === 0 || paraAttrs.headingLevel === 'none') paraAttrs.headingLevel = null
            currentTr = applyParagraphStyle(state, currentTr, range, paraAttrs, options?.selectionContext)
          }
        }

        dispatch(currentTr)
        options?.onDocumentStyleMutation?.()
        view.focus()

        const affectedArr = [...allAffectedIndexes].sort((a, b) => a - b)
        return {
          success: true,
          message: `已批量应用 ${rules.length} 条样式规则，影响 ${affectedArr.length} 个段落`,
          data: { affectedParagraphs: buildCompactParagraphSnapshot(view.state, affectedArr) },
        }
      }

      case 'workspace_search': {
        const query = String(params.query || '')
        if (!query) return { success: false, message: '请提供搜索关键词' }
        const searchParams = new URLSearchParams({ q: query })
        if (params.doc_id) searchParams.set('doc_id', String(params.doc_id))
        if (params.context_lines) searchParams.set('context_lines', String(params.context_lines))
        try {
          const res = await fetch(`/api/workspace/search?${searchParams.toString()}`)
          const data = await res.json()
          if (!res.ok) return { success: false, message: data.detail || '搜索失败' }
          if (!data.results || data.results.length === 0) return { success: true, message: `未在工作区找到包含"${query}"的内容`, data }
          const totalMatches = data.results.reduce((s: number, r: { matchCount: number }) => s + r.matchCount, 0)
          return { success: true, message: `在工作区 ${data.matchedDocs} 篇文档中找到 ${totalMatches} 处匹配"${query}"的内容`, data }
        } catch (e) {
          return { success: false, message: `搜索请求失败: ${e instanceof Error ? e.message : String(e)}` }
        }
      }

      case 'workspace_read': {
        const docId = String(params.doc_id || '')
        if (!docId) return { success: false, message: '请提供文档ID' }
        const readParams = new URLSearchParams()
        if (params.from_line !== undefined) readParams.set('from_line', String(params.from_line))
        if (params.to_line !== undefined) readParams.set('to_line', String(params.to_line))
        const qs = readParams.toString()
        try {
          const res = await fetch(`/api/workspace/${docId}/content${qs ? '?' + qs : ''}`)
          const data = await res.json()
          if (!res.ok) return { success: false, message: data.detail || '读取文档失败' }
          const totalLines = data.totalLines ?? 0
          const fromLine = data.fromLine ?? 0
          const toLine = data.toLine ?? totalLines
          return { success: true, message: `文档"${data.name}" 第${fromLine}-${toLine}行（共${totalLines}行）`, data }
        } catch (e) {
          return { success: false, message: `读取文档失败: ${e instanceof Error ? e.message : String(e)}` }
        }
      }

      default:
        return { success: false, message: `未知工具: ${toolName}` }
    }
  } catch (error) {
    console.error('[executor] Error executing tool', toolName, params, error)
    return { success: false, message: error instanceof Error ? error.message : String(error) }
  }
}
