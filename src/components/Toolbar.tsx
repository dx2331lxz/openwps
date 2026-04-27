import React from 'react'
import {
  ALargeSmall,
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  Bold,
  Bot,
  BookOpen,
  Brush,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Cloud,
  Eraser,
  Expand,
  FileInput,
  FileOutput,
  FolderOpen,
  Highlighter,
  Home,
  Image,
  IndentDecrease,
  IndentIncrease,
  Italic,
  List,
  ListChecks,
  ListOrdered,
  Menu,
  MessageSquarePlus,
  PanelLeft,
  Plus,
  Redo2,
  Ruler,
  Save,
  SeparatorHorizontal,
  Share2,
  Shrink,
  SlidersHorizontal,
  Sparkles,
  SquarePlus,
  Star,
  Strikethrough,
  Subscript,
  Superscript,
  Table,
  TextQuote,
  Type,
  Underline,
  Undo2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  mergeCells,
  splitCell,
  isInTable,
} from 'prosemirror-tables'
import type { EditorView } from 'prosemirror-view'
import type { EditorState } from 'prosemirror-state'
import { NodeSelection, TextSelection } from 'prosemirror-state'
import { Fragment, type Mark, type Node as PMNode } from 'prosemirror-model'
import { undo, redo } from 'prosemirror-history'
import { schema } from '../editor/schema'
import { DEFAULT_EDITOR_FONT_STACK, FONT_STACKS } from '../fonts'
import type { PageConfig } from '../layout/paginator'
import PageSettingsPanel, { type PageSettingsSection } from './PageSettingsPanel'

interface ToolbarProps {
  view: EditorView | null
  editorState: EditorState | null
  documentTitle?: string
  onDocumentTitleChange?: (title: string) => void
  pageConfig: PageConfig
  onPageConfigChange: (cfg: PageConfig) => void
  onToggleSidebar?: () => void
  sidebarOpen?: boolean
  aiCopilotEnabled?: boolean
  aiCopilotActivity?: AICopilotActivity
  aiCopilotCandidateCount?: number
  onToggleAICopilot?: () => void
  onAICopilotActivityChange?: (activity: AICopilotActivity) => void
  onAICopilotCandidateCountChange?: (count: number) => void
  onToggleWorkspace?: () => void
  workspaceOpen?: boolean
  onNewDocument?: () => void | Promise<void>
  onOpenServerFile?: () => void | Promise<void>
  onSaveServerFile?: () => void | Promise<void>
  onImportDocx?: (file: File) => void | Promise<void>
  onExportDocx?: () => void | Promise<void>
  onInsertImage?: (file: File) => void | Promise<void>
  onToggleFullscreen?: () => void
  isFullscreen?: boolean
  onAddComment?: () => void
  onOpenTemplates?: () => void | Promise<void>
}

export type AICopilotActivity = 'conservative' | 'standard' | 'active'

// ─── Format derivation ────────────────────────────────────────────────────────

const defaultTextFmt = {
  bold: false, italic: false, underline: false, strikethrough: false,
  superscript: false, subscript: false, fontFamily: DEFAULT_EDITOR_FONT_STACK, fontSize: 12,
  color: '#000000', backgroundColor: '',
}

const defaultParaFmt = {
  align: 'left', firstLineIndent: 0, indent: 0, lineHeight: 1.5,
  spaceBefore: 0, spaceAfter: 0, listType: null as string | null, listChecked: false, pageBreakBefore: false,
  headingLevel: null as number | null, fontSizeHint: null as number | null, fontFamilyHint: null as string | null,
}

interface ParagraphStyleOption {
  id: string
  label: string
  headingLevel: number | null
  fontSizeHint: number | null
  fontFamilyHint: string | null
  lineHeight: number
  spaceBefore: number
  spaceAfter: number
  bold: boolean
  color?: string
  previewSize: number
}

const PARAGRAPH_STYLE_OPTIONS: ParagraphStyleOption[] = [
  {
    id: 'body',
    label: '正文',
    headingLevel: null,
    fontSizeHint: null,
    fontFamilyHint: DEFAULT_EDITOR_FONT_STACK,
    lineHeight: 1.5,
    spaceBefore: 0,
    spaceAfter: 0,
    bold: false,
    previewSize: 18,
  },
  { id: 'heading-1', label: '标题 1', headingLevel: 1, fontSizeHint: 22, fontFamilyHint: FONT_STACKS.hei, lineHeight: 1.3, spaceBefore: 12, spaceAfter: 6, bold: true, previewSize: 30 },
  { id: 'heading-2', label: '标题 2', headingLevel: 2, fontSizeHint: 18, fontFamilyHint: FONT_STACKS.hei, lineHeight: 1.3, spaceBefore: 9, spaceAfter: 4, bold: true, previewSize: 27 },
  { id: 'heading-3', label: '标题 3', headingLevel: 3, fontSizeHint: 16, fontFamilyHint: FONT_STACKS.hei, lineHeight: 1.35, spaceBefore: 6, spaceAfter: 3, bold: true, previewSize: 24 },
  { id: 'heading-4', label: '标题 4', headingLevel: 4, fontSizeHint: 14, fontFamilyHint: FONT_STACKS.hei, lineHeight: 1.35, spaceBefore: 5, spaceAfter: 2, bold: true, previewSize: 21 },
  { id: 'heading-5', label: '标题 5', headingLevel: 5, fontSizeHint: 12, fontFamilyHint: FONT_STACKS.hei, lineHeight: 1.4, spaceBefore: 4, spaceAfter: 2, bold: true, previewSize: 19 },
  { id: 'heading-6', label: '标题 6', headingLevel: 6, fontSizeHint: 10.5, fontFamilyHint: FONT_STACKS.hei, lineHeight: 1.4, spaceBefore: 3, spaceAfter: 2, bold: true, previewSize: 17 },
  { id: 'heading-7', label: '标题 7', headingLevel: 7, fontSizeHint: 10.5, fontFamilyHint: FONT_STACKS.song, lineHeight: 1.4, spaceBefore: 3, spaceAfter: 1, bold: true, previewSize: 16 },
  { id: 'heading-8', label: '标题 8', headingLevel: 8, fontSizeHint: 9, fontFamilyHint: FONT_STACKS.song, lineHeight: 1.4, spaceBefore: 2, spaceAfter: 1, bold: true, previewSize: 15 },
  { id: 'heading-9', label: '标题 9', headingLevel: 9, fontSizeHint: 9, fontFamilyHint: FONT_STACKS.song, lineHeight: 1.4, spaceBefore: 2, spaceAfter: 0, bold: false, previewSize: 14 },
  {
    id: 'comment-text',
    label: '批注文字',
    headingLevel: null,
    fontSizeHint: 10.5,
    fontFamilyHint: DEFAULT_EDITOR_FONT_STACK,
    lineHeight: 1.4,
    spaceBefore: 0,
    spaceAfter: 0,
    bold: false,
    color: '#374151',
    previewSize: 16,
  },
  {
    id: 'default-paragraph-font',
    label: '默认段落字体',
    headingLevel: null,
    fontSizeHint: 12,
    fontFamilyHint: DEFAULT_EDITOR_FONT_STACK,
    lineHeight: 1.5,
    spaceBefore: 0,
    spaceAfter: 0,
    bold: false,
    previewSize: 17,
  },
]

function deriveFormats(state: EditorState) {
  const text = { ...defaultTextFmt }
  const para = { ...defaultParaFmt }

  const { selection, doc } = state
  const { from, empty } = selection

  const marks: readonly Mark[] = empty
    ? (state.storedMarks ?? doc.resolve(from).marks())
    : (() => {
      const found: Mark[] = []
      doc.nodesBetween(selection.from, selection.to, (node) => {
        if (node.isText && node.marks.length) {
          node.marks.forEach(m => found.push(m))
          return false
        }
      })
      return found
    })()

  const tm = marks.find(m => m.type.name === 'textStyle')
  if (tm) Object.assign(text, tm.attrs)

  const $from = state.selection.$from
  for (let d = $from.depth; d >= 0; d--) {
    const n = $from.node(d)
    if (n.type.name === 'paragraph') {
      Object.assign(para, n.attrs)
      break
    }
  }

  return { text, para }
}

// ─── Style helpers ────────────────────────────────────────────────────────────

/** Find the first text-node position inside [from, to] so the native selection
 *  lands inside a <span> (not at a block-element boundary like `{node: p, offset:0}`).
 *  Position N (para open) maps to {node:p, offset:0}; position N+1 maps into text. */
function firstTextPos(doc: Parameters<typeof TextSelection.create>[0], from: number, to: number): number {
  let found = -1
  doc.nodesBetween(from, to, (node, pos) => {
    if (found < 0 && node.isText) {
      found = pos + 1  // pos = text-node start (= before 1st char); +1 = after 1st char = inside text node
      return false
    }
    return undefined
  })
  return found > 0 ? found : from
}

function applyTextStyle(view: EditorView, attrs: Record<string, unknown>) {
  const { state, dispatch } = view
  const { from, to, empty } = state.selection
  if (empty) return
  // AllSelection (from=0) is a doc-level selection; clamp to valid inline positions.
  const resolvedFrom = Math.max(1, from)
  const resolvedTo = Math.min(state.doc.nodeSize - 1, to)
  if (resolvedFrom >= resolvedTo) return
  let existing: Record<string, unknown> = {}
  state.doc.nodesBetween(resolvedFrom, resolvedTo, (node) => {
    if (node.isText) {
      const m = node.marks.find(m => m.type === schema.marks.textStyle)
      if (m) existing = { ...m.attrs }
    }
  })
  const tr = state.tr.addMark(resolvedFrom, resolvedTo, schema.marks.textStyle.create({ ...existing, ...attrs }))
  // Place cursor INSIDE the text (pos > paragraph boundary) so window.getSelection()
  // startContainer is a text node, not {node: p, offset:0}.
  const cursorPos = firstTextPos(tr.doc, resolvedFrom, resolvedTo)
  tr.setSelection(TextSelection.create(tr.doc, cursorPos, resolvedTo))
  dispatch(tr)
  view.focus()
}

function applyParaStyle(view: EditorView, attrs: Record<string, unknown>) {
  const { state, dispatch } = view
  const { selection, tr } = state

  if (selection.empty) {
    // Cursor (no selection): find the paragraph the cursor is inside
    const $from = selection.$from
    for (let d = $from.depth; d >= 0; d--) {
      const node = $from.node(d)
      if (node.type.name === 'paragraph') {
        const pos = $from.before(d)
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs })
        break
      }
    }
  } else {
    // Range selection: apply to all paragraphs in range
    state.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
      if (node.type.name === 'paragraph') {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs })
      }
    })
  }

  dispatch(tr)
  view.focus()
}

function clearFormatting(view: EditorView) {
  const { state, dispatch } = view
  const { from, to, empty } = state.selection
  if (empty) return
  const tr = state.tr.removeMark(from, to, schema.marks.textStyle)
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === 'paragraph') {
      tr.setNodeMarkup(pos, undefined, {
        align: 'left', firstLineIndent: 0, indent: 0, lineHeight: 1.5,
        spaceBefore: 0, spaceAfter: 0, listType: null, listLevel: 0, listChecked: false, pageBreakBefore: false,
      })
    }
  })
  dispatch(tr)
  view.focus()
}

function getTargetParagraphs(state: EditorState) {
  const { selection } = state
  const paragraphs: Array<{ node: PMNode; pos: number }> = []

  if (selection.empty) {
    const { $from } = selection
    for (let depth = $from.depth; depth >= 0; depth -= 1) {
      const node = $from.node(depth)
      if (node.type.name !== 'paragraph') continue
      paragraphs.push({ node, pos: $from.before(depth) })
      break
    }
    return paragraphs
  }

  state.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (node.type.name === 'paragraph') paragraphs.push({ node, pos })
    return true
  })
  return paragraphs
}

function applyParagraphNamedStyle(view: EditorView, option: ParagraphStyleOption) {
  const { state, dispatch } = view
  const paragraphs = getTargetParagraphs(state)
  if (paragraphs.length === 0) return

  const tr = state.tr
  paragraphs.forEach(({ node, pos }) => {
    tr.setNodeMarkup(pos, undefined, {
      ...node.attrs,
      headingLevel: option.headingLevel,
      fontSizeHint: option.fontSizeHint,
      fontFamilyHint: option.fontFamilyHint,
      lineHeight: option.lineHeight,
      spaceBefore: option.spaceBefore,
      spaceAfter: option.spaceAfter,
      listType: null,
      listLevel: 0,
      listChecked: false,
    })

    const from = pos + 1
    const to = pos + node.nodeSize - 1
    if (to <= from) return

    tr.removeMark(from, to, schema.marks.textStyle)
    if (option.fontSizeHint || option.fontFamilyHint || option.bold || option.color) {
      tr.addMark(from, to, schema.marks.textStyle.create({
        fontFamily: option.fontFamilyHint ?? DEFAULT_EDITOR_FONT_STACK,
        fontSize: option.fontSizeHint ?? 12,
        bold: option.bold,
        color: option.color ?? '#000000',
      }))
    }
  })

  dispatch(tr.scrollIntoView())
  view.focus()
}

function getCurrentParagraphStyleId(para: typeof defaultParaFmt) {
  const headingLevel = Number(para.headingLevel ?? 0)
  if (headingLevel >= 1 && headingLevel <= 9) return `heading-${headingLevel}`
  const commentStyle = Number(para.fontSizeHint ?? 0) === 10.5 && String(para.fontFamilyHint ?? '') === DEFAULT_EDITOR_FONT_STACK
  return commentStyle ? 'comment-text' : 'body'
}

function toggleList(view: EditorView, listType: 'bullet' | 'ordered' | 'task') {
  const { state, dispatch } = view
  const { selection, tr } = state
  let allHave = true
  state.doc.nodesBetween(selection.from, selection.to, (node) => {
    if (node.type.name === 'paragraph' && node.attrs.listType !== listType) allHave = false
  })
  const newType = allHave ? null : listType
  state.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (node.type.name === 'paragraph') {
      tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        listType: newType,
        listChecked: newType === 'task' ? Boolean(node.attrs.listChecked) : false,
      })
    }
  })
  dispatch(tr)
  view.focus()
}

function getParagraphRefs(state: EditorState) {
  const paragraphs: Array<{ node: typeof state.doc; pos: number; index: number }> = []
  let paragraphIndex = 0

  state.doc.forEach((node, pos) => {
    if (node.type.name !== 'paragraph') return
    paragraphs.push({ node, pos, index: paragraphIndex })
    paragraphIndex += 1
  })

  return paragraphs
}

function getCurrentParagraphRef(state: EditorState) {
  const resolvePos = state.selection.from === 0 ? 1 : state.selection.from
  const $from = state.doc.resolve(resolvePos)
  const paragraphs = getParagraphRefs(state)

  for (let depth = $from.depth; depth >= 0; depth -= 1) {
    const node = $from.node(depth)
    if (node.type.name !== 'paragraph') continue
    const pos = $from.before(depth)
    return paragraphs.find(paragraph => paragraph.pos === pos) ?? null
  }

  return paragraphs[0] ?? null
}

function getTopLevelBlockIndex(doc: PMNode, blockPos: number) {
  let match: number | null = null
  doc.forEach((_node, pos, index) => {
    if (pos === blockPos) match = index
    return undefined
  })
  return match
}

function createParagraphLike(node: PMNode, content?: Fragment) {
  if (content && content.size > 0) return schema.nodes.paragraph.create(node.attrs, content)
  return schema.nodes.paragraph.create(node.attrs)
}

function insertHR(view: EditorView, attrs?: { lineStyle?: string; lineColor?: string }) {
  const { state, dispatch } = view
  const paragraph = getCurrentParagraphRef(state)
  if (!paragraph) return

  let tr = state.tr
  if (!state.selection.empty) {
    tr = tr.delete(state.selection.from, state.selection.to)
  }

  const mappedSelectionFrom = tr.mapping.map(state.selection.from, -1)
  const mappedParagraphPos = tr.mapping.map(paragraph.pos, -1)
  const currentParagraph = tr.doc.nodeAt(mappedParagraphPos)
  if (!currentParagraph || currentParagraph.type.name !== 'paragraph') return

  const hrNode = schema.nodes.horizontal_rule.create({
    lineStyle: attrs?.lineStyle ?? 'solid',
    lineColor: attrs?.lineColor ?? '#cbd5e1',
  })
  const resolvedPos = tr.doc.resolve(Math.max(mappedParagraphPos + 1, Math.min(mappedSelectionFrom, tr.doc.content.size)))
  const rawOffset = resolvedPos.parent === currentParagraph ? resolvedPos.parentOffset : currentParagraph.content.size
  const offset = Math.max(0, Math.min(rawOffset, currentParagraph.content.size))
  const beforeContent = currentParagraph.content.cut(0, offset)
  const afterContent = currentParagraph.content.cut(offset, currentParagraph.content.size)
  const replacement: PMNode[] = []
  let hrInsertPos = mappedParagraphPos

  if (currentParagraph.content.size === 0) {
    replacement.push(hrNode, schema.nodes.paragraph.create())
  } else if (offset === 0) {
    replacement.push(hrNode, createParagraphLike(currentParagraph, afterContent))
  } else if (offset === currentParagraph.content.size) {
    const currentIndex = getTopLevelBlockIndex(tr.doc, mappedParagraphPos)
    replacement.push(createParagraphLike(currentParagraph, beforeContent), hrNode)
    if (currentIndex === tr.doc.childCount - 1) replacement.push(schema.nodes.paragraph.create())
    hrInsertPos = mappedParagraphPos + replacement[0]!.nodeSize
  } else {
    const beforeParagraph = createParagraphLike(currentParagraph, beforeContent)
    const afterParagraph = createParagraphLike(currentParagraph, afterContent)
    replacement.push(beforeParagraph, hrNode, afterParagraph)
    hrInsertPos = mappedParagraphPos + beforeParagraph.nodeSize
  }

  if (replacement[0] === hrNode) hrInsertPos = mappedParagraphPos

  tr = tr.replaceWith(mappedParagraphPos, mappedParagraphPos + currentParagraph.nodeSize, replacement)
  tr.setSelection(NodeSelection.create(tr.doc, hrInsertPos))

  dispatch(tr)
  view.focus()
}

function insertPageBreak(view: EditorView) {
  const { state, dispatch } = view
  const paragraph = getCurrentParagraphRef(state)
  if (!paragraph) return

  const paragraphs = getParagraphRefs(state)
  const nextParagraph = paragraphs[paragraph.index + 1]
  const tr = state.tr

  if (nextParagraph) {
    tr.setNodeMarkup(nextParagraph.pos, undefined, {
      ...nextParagraph.node.attrs,
      pageBreakBefore: true,
    })
    tr.setSelection(TextSelection.create(tr.doc, nextParagraph.pos + 1))
  } else {
    const insertPos = paragraph.pos + paragraph.node.nodeSize
    const newParagraph = schema.nodes.paragraph.create({ pageBreakBefore: true })
    tr.insert(insertPos, newParagraph)
    tr.setSelection(TextSelection.create(tr.doc, insertPos + 1))
  }

  dispatch(tr)
  view.focus()
}

function runTableCommand(
  view: EditorView,
  command: (state: EditorState, dispatch?: (tr: EditorState['tr']) => void) => boolean,
) {
  const success = command(view.state, view.dispatch)
  if (!success) return
  view.focus()
}

function insertTable(view: EditorView, rows: number, cols: number) {
  const { state, dispatch } = view
  const s = state.schema

  // Build table rows (all regular cells, no special header type needed)
  const allRows = Array.from({ length: rows }, () => {
    const cells = Array.from({ length: cols }, () =>
      s.nodes.table_cell.create(
        { colspan: 1, rowspan: 1 },
        s.nodes.paragraph.create(),
      ),
    )
    return s.nodes.table_row.create(undefined, cells)
  })

  const tableNode = s.nodes.table.create(undefined, allRows)

  // Find a safe insertion point: end of the top-level block containing the cursor
  // (depth 1 = direct child of doc)
  const $from = state.selection.$from
  let insertPos: number
  if ($from.depth >= 1) {
    const topPos = $from.before(1)
    const topBlock = $from.node(1)
    insertPos = topPos + topBlock.nodeSize
  } else {
    insertPos = state.doc.content.size
  }

  // Always insert an empty paragraph after the table so the cursor can be
  // placed below it (table cannot be the last node without a following paragraph)
  const emptyParagraph = s.nodes.paragraph.create()
  const tr = state.tr.insert(insertPos, [tableNode, emptyParagraph])
  // Place cursor in the first cell
  const firstCellPos = insertPos + 2 // table(1) + row(1) + cell(1) + paragraph open = +2 to be inside first cell para
  try {
    tr.setSelection(TextSelection.create(tr.doc, firstCellPos))
  } catch {
    // ignore if position is invalid
  }
  dispatch(tr)
  view.focus()
}

function deleteTableNode(view: EditorView) {
  const { state, dispatch } = view
  const $pos = state.selection.$anchor
  for (let depth = $pos.depth; depth >= 0; depth--) {
    const node = $pos.node(depth)
    if (node.type.name === 'table') {
      const from = $pos.before(depth)
      const to = from + node.nodeSize
      dispatch(state.tr.delete(from, to))
      view.focus()
      return
    }
  }
}

// ─── Table picker (row×col grid selector) ────────────────────────────────────

const TablePicker: React.FC<{
  onSelect: (rows: number, cols: number) => void
  onClose: () => void
  anchorRef: React.RefObject<HTMLElement | null>
}> = ({ onSelect, onClose, anchorRef }) => {
  const [hovered, setHovered] = React.useState({ rows: 0, cols: 0 })
  const [anchorRect, setAnchorRect] = React.useState<DOMRect | null>(null)
  const MAX_ROWS = 8
  const MAX_COLS = 8
  const pickerRef = React.useRef<HTMLDivElement>(null)

  // Close on outside click — delay attaching the listener by one tick so the
  // click that opened the picker doesn't immediately close it.
  React.useEffect(() => {
    let handler: ((e: MouseEvent) => void) | null = null
    const timer = setTimeout(() => {
      handler = (e: MouseEvent) => {
        if (pickerRef.current && pickerRef.current.contains(e.target as Node)) return
        onClose()
      }
      document.addEventListener('mousedown', handler)
    }, 0)
    return () => {
      clearTimeout(timer)
      if (handler) document.removeEventListener('mousedown', handler)
    }
  }, [onClose])

  React.useEffect(() => {
    const updateAnchorRect = () => {
      setAnchorRect(anchorRef.current?.getBoundingClientRect() ?? null)
    }
    updateAnchorRect()
    window.addEventListener('resize', updateAnchorRect)
    window.addEventListener('scroll', updateAnchorRect, true)
    return () => {
      window.removeEventListener('resize', updateAnchorRect)
      window.removeEventListener('scroll', updateAnchorRect, true)
    }
  }, [anchorRef])

  return (
    <div
      ref={pickerRef}
      style={{
        position: 'fixed',
        top: anchorRect ? anchorRect.bottom + 4 : 60,
        left: anchorRect ? anchorRect.left : 0,
        zIndex: 9999,
        background: 'white',
        border: '1px solid #d1d5db',
        borderRadius: 6,
        boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
        padding: 8,
        userSelect: 'none',
      }}
    >
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6, textAlign: 'center' }}>
        {hovered.rows > 0 && hovered.cols > 0
          ? `${hovered.rows} 行 × ${hovered.cols} 列`
          : '选择行列数'}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${MAX_COLS}, 20px)`, gap: 2 }}>
        {Array.from({ length: MAX_ROWS }, (_, ri) =>
          Array.from({ length: MAX_COLS }, (_, ci) => {
            const r = ri + 1
            const c = ci + 1
            const active = r <= hovered.rows && c <= hovered.cols
            return (
              <div
                key={`${r}-${c}`}
                onMouseEnter={() => setHovered({ rows: r, cols: c })}
                onMouseDown={e => {
                  e.preventDefault()
                  e.stopPropagation()
                  onSelect(r, c)
                  onClose()
                }}
                style={{
                  width: 18,
                  height: 18,
                  border: `1px solid ${active ? '#2563eb' : '#d1d5db'}`,
                  borderRadius: 2,
                  background: active ? '#dbeafe' : '#f9fafb',
                  cursor: 'pointer',
                  boxSizing: 'border-box',
                }}
              />
            )
          })
        )}
      </div>
    </div>
  )
}

const TEXT_COLORS = ['#000000', '#FF0000', '#E65C00', '#FFB300', '#1B8000', '#0066CC', '#7B00D4', '#FFFFFF']
const HIGHLIGHT_COLORS = ['', '#FFFF00', '#99FF99', '#99CCFF', '#FF9999', '#FFB366', '#E0B3FF', '#CCCCCC']
const HORIZONTAL_RULE_COLORS = ['#000000', '#4B5563', '#9CA3AF', '#EF4444', '#F59E0B', '#84CC16', '#2563EB', '#7C3AED']
const HORIZONTAL_RULE_STYLE_OPTIONS = [
  { value: 'solid', label: '实线' },
  { value: 'dotted', label: '点线' },
  { value: 'dashed', label: '虚线' },
  { value: 'dash-dot', label: '点划线' },
  { value: 'double', label: '双线' },
] as const

const ColorSwatch: React.FC<{
  colors: string[]
  current: string
  anchorRect: DOMRect
  onChange: (c: string) => void
  onClose: () => void
}> = ({ colors, current, anchorRect, onChange, onClose }) => (
  <div
    onMouseDown={e => e.stopPropagation()}
    style={{
      display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 4, padding: 6,
      background: 'white', border: '1px solid #ccc', borderRadius: 4,
      boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
      position: 'fixed', zIndex: 9999, top: anchorRect.bottom + 4, left: anchorRect.left,
    }}
  >
    {colors.map((c, i) => (
      <button key={i} title={c || '无背景'} data-color={c || 'transparent'}
        onMouseDown={(e) => { e.preventDefault(); onChange(c); onClose() }}
        style={{
          width: 20, height: 20, background: c || 'transparent',
          border: c === current ? '2px solid #333' : '1px solid #aaa',
          borderRadius: 2, cursor: 'pointer', outline: c === '' ? '1px dashed #aaa' : 'none',
        }} />
    ))}
  </div>
)

// ─── Spacing popover ──────────────────────────────────────────────────────────

const SPACE_PRESETS = [0, 3, 6, 12, 18, 24]

const SpacingPopover: React.FC<{
  anchorRect: DOMRect
  value: number
  onChange: (v: number) => void
  onClose: () => void
}> = ({ anchorRect, value, onChange, onClose }) => {
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(String(value))

  const commit = () => {
    const n = parseFloat(draft)
    if (!isNaN(n) && n >= 0) onChange(Math.round(n * 10) / 10)
    onClose()
  }

  return (
    <div
      onMouseDown={e => e.stopPropagation()}
      style={{
        position: 'fixed',
        top: anchorRect.bottom + 2,
        left: anchorRect.left,
        zIndex: 9999,
        background: 'white', border: '1px solid #d1d5db', borderRadius: 6,
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)', overflow: 'hidden', minWidth: 108,
      }}
    >
      {/* Current value row — click to enter custom value */}
      {editing ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '4px 8px', borderBottom: '1px solid #e5e7eb', background: '#f9fafb' }}>
          <input
            type="number" min={0} step={0.5}
            value={draft}
            autoFocus
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') onClose() }}
            onBlur={commit}
            style={{ width: 52, fontSize: 13, border: '1px solid #93c5fd', borderRadius: 3, padding: '1px 4px', outline: 'none' }}
          />
          <span style={{ fontSize: 12, color: '#6b7280' }}>pt</span>
        </div>
      ) : (
        <div
          onMouseDown={e => { e.preventDefault(); setDraft(String(value)); setEditing(true) }}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '4px 8px', borderBottom: '1px solid #e5e7eb', background: '#f9fafb',
            cursor: 'text', fontSize: 13,
          }}
        >
          <span style={{ color: '#374151', fontVariantNumeric: 'tabular-nums' }}>{value}pt</span>
          <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 4 }}>✎</span>
        </div>
      )}

      {/* Preset options */}
      {SPACE_PRESETS.map(p => (
        <div
          key={p}
          onMouseDown={e => { e.preventDefault(); onChange(p); onClose() }}
          style={{
            padding: '4px 12px', fontSize: 13, cursor: 'pointer',
            background: value === p ? '#eff6ff' : 'transparent',
            color: value === p ? '#2563eb' : '#374151',
            fontWeight: value === p ? 500 : 400,
          }}
        >
          {p}pt
        </div>
      ))}
    </div>
  )
}

const PageSettingsPopover: React.FC<{
  anchorRect: DOMRect
  section: PageSettingsSection
  pageConfig: PageConfig
  onPageConfigChange: (cfg: PageConfig) => void
  onClose: () => void
}> = ({ anchorRect, section, pageConfig, onPageConfigChange, onClose }) => {
  return (
    <div
      onMouseDown={e => e.stopPropagation()}
      style={{
        position: 'fixed',
        top: anchorRect.bottom + 10,
        left: Math.max(16, anchorRect.left),
        zIndex: 9999,
      }}
    >
      <PageSettingsPanel
        pageConfig={pageConfig}
        onPageConfigChange={(cfg) => {
          onPageConfigChange(cfg)
          onClose()
        }}
        saveLabel="应用"
        section={section}
        onOpenAllSettings={() => {
          if (section !== 'all') {
            const nextRect = new DOMRect(anchorRect.left, anchorRect.top, anchorRect.width, anchorRect.height)
            requestAnimationFrame(() => {
              const event = new CustomEvent('openwps:page-settings-open-all', {
                detail: { rect: nextRect },
              })
              window.dispatchEvent(event)
            })
          }
        }}
      />
    </div>
  )
}

const ParagraphStyleDropdown: React.FC<{
  anchorRect: DOMRect
  activeId: string
  onSelect: (option: ParagraphStyleOption) => void
  onClose: () => void
}> = ({ anchorRect, activeId, onSelect, onClose }) => (
  <div
    data-openwps-style-dropdown="true"
    onMouseDown={event => event.stopPropagation()}
    style={{
      position: 'fixed',
      top: anchorRect.bottom + 4,
      left: anchorRect.left,
      width: 260,
      maxHeight: 520,
      overflowY: 'auto',
      zIndex: 9999,
      padding: '10px 0',
      border: '1px solid #e5e7eb',
      borderRadius: 10,
      background: '#ffffff',
      boxShadow: '0 18px 40px rgba(15, 23, 42, 0.16)',
    }}
  >
    {PARAGRAPH_STYLE_OPTIONS.map(option => {
      const active = option.id === activeId
      return (
        <button
          key={option.id}
          type="button"
          title={option.label}
          data-openwps-style-option={option.id}
          onMouseDown={event => {
            event.preventDefault()
            event.stopPropagation()
            onSelect(option)
            onClose()
          }}
          style={{
            width: '100%',
            minHeight: 52,
            display: 'grid',
            gridTemplateColumns: '34px 1fr',
            alignItems: 'center',
            gap: 8,
            padding: '8px 18px 8px 12px',
            border: 'none',
            background: active ? '#eff6ff' : 'transparent',
            color: '#111827',
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <span style={{ color: '#2563eb', fontSize: 20, lineHeight: 1 }}>{active ? '✓' : ''}</span>
          <span
            style={{
              fontFamily: option.fontFamilyHint ?? DEFAULT_EDITOR_FONT_STACK,
              fontSize: option.previewSize,
              fontWeight: option.bold ? 700 : 400,
              lineHeight: 1.2,
              color: option.color ?? '#111827',
              whiteSpace: 'nowrap',
            }}
          >
            {option.label}
          </span>
        </button>
      )
    })}
    <div style={{ height: 1, background: '#e5e7eb', margin: '8px 16px' }} />
    <button
      type="button"
      title="样式管理"
      onMouseDown={event => {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
      style={{
        width: '100%',
        height: 48,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '0 18px',
        border: 'none',
        background: 'transparent',
        color: '#111827',
        cursor: 'pointer',
        fontSize: 17,
      }}
    >
      <span style={{ fontSize: 20 }}>A</span>
      样式管理
    </button>
  </div>
)

const toolbarButtonBaseStyle: React.CSSProperties = {
  height: 34,
  minWidth: 34,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: '0 8px',
  border: 'none',
  borderRadius: 8,
  background: 'transparent',
  color: '#1f2937',
  cursor: 'pointer',
  fontSize: 14,
  lineHeight: 1,
  whiteSpace: 'nowrap',
}

const TOOLBAR_LAYER_HEIGHT = 48

function IconButton({
  title,
  icon: Icon,
  label,
  active = false,
  disabled = false,
  children,
  onMouseDown,
  onClick,
  style,
}: {
  title: string
  icon?: LucideIcon
  label?: string
  active?: boolean
  disabled?: boolean
  children?: React.ReactNode
  onMouseDown?: React.MouseEventHandler<HTMLButtonElement>
  onClick?: React.MouseEventHandler<HTMLButtonElement>
  style?: React.CSSProperties
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onMouseDown={onMouseDown}
      onClick={onClick}
      style={{
        ...toolbarButtonBaseStyle,
        background: active ? '#e5e7eb' : 'transparent',
        color: disabled ? '#c4c7cc' : active ? '#111827' : '#1f2937',
        cursor: disabled ? 'default' : 'pointer',
        ...style,
      }}
      onMouseEnter={event => {
        if (!disabled && !active) event.currentTarget.style.background = '#f1f3f5'
      }}
      onMouseLeave={event => {
        if (!active) event.currentTarget.style.background = 'transparent'
      }}
    >
      {Icon && <Icon size={18} strokeWidth={2} />}
      {children}
      {label && <span style={{ fontSize: 14, lineHeight: '18px' }}>{label}</span>}
    </button>
  )
}

function ToolbarSelect({
  title,
  children,
  style,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      title={title}
      style={{
        height: 34,
        minWidth: 66,
        border: 'none',
        borderRadius: 8,
        padding: '0 28px 0 10px',
        background: '#ffffff',
        color: '#111827',
        cursor: 'pointer',
        fontSize: 14,
        outline: 'none',
        appearance: 'auto',
        ...style,
      }}
      {...props}
    >
      {children}
    </select>
  )
}

function ToolbarSeparator() {
  return <div style={{ width: 1, height: 26, background: '#d8dde3', margin: '0 5px', flexShrink: 0 }} />
}

function TopBarAction({
  title,
  icon: Icon,
  label,
  active = false,
  primary = false,
  compact = false,
  onMouseDown,
}: {
  title: string
  icon: LucideIcon
  label: string
  active?: boolean
  primary?: boolean
  compact?: boolean
  onMouseDown?: React.MouseEventHandler<HTMLButtonElement>
}) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={onMouseDown}
      style={{
        height: 34,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: compact ? 0 : 7,
        flexShrink: 0,
        border: primary ? 'none' : '1px solid transparent',
        borderRadius: primary ? 8 : 7,
        padding: compact ? '0 9px' : primary ? '0 14px' : '0 9px',
        minWidth: compact ? 34 : undefined,
        background: primary ? '#2563eb' : active ? '#e8f1ff' : 'transparent',
        color: primary ? '#ffffff' : active ? '#2563eb' : '#1f2937',
        cursor: 'pointer',
        fontSize: 14,
        fontWeight: primary ? 600 : 500,
        whiteSpace: 'nowrap',
      }}
    >
      <Icon size={primary ? 17 : 18} strokeWidth={2} />
      {!compact && <span>{label}</span>}
    </button>
  )
}

function PageToolbarButton({
  label,
  icon,
  active,
  onMouseDown,
}: {
  label: string
  icon: LucideIcon
  active: boolean
  onMouseDown: React.MouseEventHandler<HTMLButtonElement>
}) {
  const Icon = icon
  return (
    <button
      type="button"
      onMouseDown={onMouseDown}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        height: 34,
        padding: '0 11px',
        border: 'none',
        borderRadius: 8,
        background: active ? '#e8f1ff' : 'transparent',
        color: active ? '#2563eb' : '#1f2937',
        cursor: 'pointer',
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      <Icon size={18} strokeWidth={2} />
      <span style={{ fontSize: 13 }}>{label}</span>
      <ChevronDown size={14} strokeWidth={2} />
    </button>
  )
}

function formatDocumentTitle(title?: string) {
  const trimmed = (title || '').trim()
  if (!trimmed) return '未命名文档'
  const fileName = trimmed.split(/[\\/]/).pop() || trimmed
  return fileName.replace(/\.(docx|doc|md|markdown|txt)$/i, '') || fileName
}

// ─── Toolbar component ────────────────────────────────────────────────────────

export const Toolbar: React.FC<ToolbarProps> = ({
  view,
  editorState,
  documentTitle,
  onDocumentTitleChange,
  pageConfig,
  onPageConfigChange,
  onToggleSidebar,
  sidebarOpen,
  aiCopilotEnabled,
  aiCopilotActivity = 'standard',
  aiCopilotCandidateCount = 1,
  onToggleAICopilot,
  onAICopilotActivityChange,
  onAICopilotCandidateCountChange,
  onToggleWorkspace,
  workspaceOpen,
  onNewDocument,
  onOpenServerFile,
  onSaveServerFile,
  onImportDocx,
  onExportDocx,
  onInsertImage,
  onToggleFullscreen,
  isFullscreen,
  onAddComment,
  onOpenTemplates,
}) => {
  const [colorPickerOpen, setColorPickerOpen] = React.useState<'text' | 'bg' | 'hr-selected' | 'hr-insert' | null>(null)
  const [colorPickerAnchor, setColorPickerAnchor] = React.useState<DOMRect | null>(null)
  const [horizontalRuleInsertAttrs, setHorizontalRuleInsertAttrs] = React.useState({
    lineStyle: 'solid',
    lineColor: '#cbd5e1',
  })
  const [spacingPopover, setSpacingPopover] = React.useState<{ which: 'before' | 'after'; rect: DOMRect } | null>(null)
  const [styleDropdown, setStyleDropdown] = React.useState<{ rect: DOMRect } | null>(null)
  const [fileMenu, setFileMenu] = React.useState<{ rect: DOMRect } | null>(null)
  const [aiCopilotMenu, setAiCopilotMenu] = React.useState<{ rect: DOMRect } | null>(null)
  const [activeTab, setActiveTab] = React.useState<'home' | 'insert' | 'page'>('home')
  const [pagePopover, setPagePopover] = React.useState<{ section: PageSettingsSection; rect: DOMRect } | null>(null)
  const [tablePickerOpen, setTablePickerOpen] = React.useState(false)
  const tablePickerBtnRef = React.useRef<HTMLButtonElement | null>(null)
  const [collapsed, setCollapsed] = React.useState(false)
  const topBarRef = React.useRef<HTMLDivElement | null>(null)
  const titleInputRef = React.useRef<HTMLInputElement | null>(null)
  const [topBarWidth, setTopBarWidth] = React.useState(0)
  const [titleEditing, setTitleEditing] = React.useState(false)
  const [titleDraft, setTitleDraft] = React.useState('')
  const scrollContainerRef = React.useRef<HTMLDivElement>(null)
  const [showScrollLeft, setShowScrollLeft] = React.useState(false)
  const [showScrollRight, setShowScrollRight] = React.useState(false)
  // Snapshot of the EditorView state captured when the table-ops select is opened
  // (mousedown). This lets us run commands against the correct selection even
  // after the select element has stolen browser focus from the editor.
  const savedTableViewRef = React.useRef<EditorView | null>(null)
  const topBarCompact = topBarWidth > 0 && topBarWidth < 1360
  const topBarVeryCompact = topBarWidth > 0 && topBarWidth < 760
  const displayDocumentTitle = formatDocumentTitle(documentTitle)

  React.useEffect(() => {
    if (!titleEditing) setTitleDraft(displayDocumentTitle)
  }, [displayDocumentTitle, titleEditing])

  React.useEffect(() => {
    if (titleEditing) titleInputRef.current?.select()
  }, [titleEditing])

  const startTitleEdit = () => {
    setTitleDraft(displayDocumentTitle)
    setTitleEditing(true)
  }

  const cancelTitleEdit = () => {
    setTitleDraft(displayDocumentTitle)
    setTitleEditing(false)
  }

  const commitTitleEdit = () => {
    const nextTitle = titleDraft.trim() || '未命名文档'
    setTitleDraft(nextTitle)
    setTitleEditing(false)
    onDocumentTitleChange?.(nextTitle)
  }

  React.useEffect(() => {
    const element = topBarRef.current
    if (!element) return

    const update = () => setTopBarWidth(element.getBoundingClientRect().width)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Close spacing popover on outside click
  React.useEffect(() => {
    if (!colorPickerOpen) return
    const handler = () => {
      setColorPickerOpen(null)
      setColorPickerAnchor(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [colorPickerOpen])

  React.useEffect(() => {
    if (!spacingPopover) return
    const handler = () => setSpacingPopover(null)
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [spacingPopover])

  React.useEffect(() => {
    if (!styleDropdown) return
    const handler = () => setStyleDropdown(null)
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [styleDropdown])

  React.useEffect(() => {
    if (!fileMenu) return
    const handler = () => setFileMenu(null)
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [fileMenu])

  React.useEffect(() => {
    if (!aiCopilotMenu) return
    const handler = () => setAiCopilotMenu(null)
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [aiCopilotMenu])

  React.useEffect(() => {
    if (!pagePopover) return
    const handler = () => setPagePopover(null)
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [pagePopover])

  React.useEffect(() => {
    const handleOpenAll = (event: Event) => {
      const customEvent = event as CustomEvent<{ rect: DOMRect }>
      if (!customEvent.detail?.rect) return
      setPagePopover({ section: 'all', rect: customEvent.detail.rect })
    }
    window.addEventListener('openwps:page-settings-open-all', handleOpenAll)
    return () => window.removeEventListener('openwps:page-settings-open-all', handleOpenAll)
  }, [])

  const updateScrollButtons = React.useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    setShowScrollLeft(el.scrollLeft > 2)
    setShowScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2)
  }, [])

  const scrollByStep = (direction: 'left' | 'right') => {
    const el = scrollContainerRef.current
    if (!el) return
    const amount = el.clientWidth * 0.8
    el.scrollBy({ left: direction === 'right' ? amount : -amount, behavior: 'smooth' })
  }

  React.useEffect(() => {
    if (collapsed) return
    const el = scrollContainerRef.current
    if (!el) return
    updateScrollButtons()
    el.addEventListener('scroll', updateScrollButtons)
    const ro = new ResizeObserver(updateScrollButtons)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', updateScrollButtons)
      ro.disconnect()
    }
  }, [activeTab, collapsed, updateScrollButtons])

  // Save selection before a <select> opens (it shifts browser focus away from editor)
  const savedRangeRef = React.useRef<{ from: number; to: number } | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const imageInputRef = React.useRef<HTMLInputElement>(null)

  type FileMenuAction = 'open' | 'save' | 'import' | 'export' | 'templates'
  const fileMenuItems: Array<{ title: string; label: string; icon: typeof FolderOpen; action: FileMenuAction }> = [
    { title: '打开文档目录文件', label: '打开', icon: FolderOpen, action: 'open' },
    { title: '保存到文档目录', label: '保存', icon: Save, action: 'save' },
    { title: '导入 .docx / .md', label: '导入', icon: FileInput, action: 'import' },
    { title: '导出 .docx', label: '导出', icon: FileOutput, action: 'export' },
    { title: '打开模板库', label: '模板', icon: BookOpen, action: 'templates' },
  ]

  const handleFileMenuAction = (action: FileMenuAction) => {
    if (action === 'open') {
      void onOpenServerFile?.()
    } else if (action === 'save') {
      void onSaveServerFile?.()
    } else if (action === 'import') {
      fileInputRef.current?.click()
    } else if (action === 'export') {
      void onExportDocx?.()
    } else {
      void onOpenTemplates?.()
    }
  }

  const fmt = editorState ? deriveFormats(editorState) : { text: defaultTextFmt, para: defaultParaFmt }
  const selectionInTable = Boolean(editorState && isInTable(editorState))
  const selectedHorizontalRule = editorState?.selection instanceof NodeSelection && editorState.selection.node.type.name === 'horizontal_rule'
    ? {
      pos: editorState.selection.from,
      attrs: {
        lineStyle: String(editorState.selection.node.attrs.lineStyle ?? 'solid'),
        lineColor: String(editorState.selection.node.attrs.lineColor ?? '#cbd5e1'),
      },
    }
    : null
  const fontSizeOptions = Array.from(new Set([
    8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72,
    Number(fmt.text.fontSize),
  ])).sort((a, b) => a - b)
  const activeParagraphStyleId = getCurrentParagraphStyleId(fmt.para)
  const activeParagraphStyle = PARAGRAPH_STYLE_OPTIONS.find(option => option.id === activeParagraphStyleId) ?? PARAGRAPH_STYLE_OPTIONS[0]!

  const sep = <ToolbarSeparator />

  /** Call before a <select> opens so we can restore the selection on change */
  const saveSelection = () => {
    if (view) {
      const { from, to } = view.state.selection
      savedRangeRef.current = { from, to }
    }
  }

  /** Apply a text style using savedRangeRef (falls back to current selection) */
  const applyTextStyleWithSaved = (attrs: Record<string, unknown>) => {
    if (!view) return
    const saved = savedRangeRef.current
    const state = view.state
    const rawFrom = saved ? saved.from : state.selection.from
    const rawTo = saved ? saved.to : state.selection.to
    if (rawFrom === rawTo) return
    const resolvedFrom = Math.max(1, rawFrom)
    const resolvedTo = Math.min(state.doc.nodeSize - 1, rawTo)
    if (resolvedFrom >= resolvedTo) return
    let existing: Record<string, unknown> = {}
    state.doc.nodesBetween(resolvedFrom, resolvedTo, (node) => {
      if (node.isText) {
        const m = node.marks.find(m => m.type === schema.marks.textStyle)
        if (m) existing = { ...m.attrs }
      }
    })
    const tr = state.tr.addMark(resolvedFrom, resolvedTo, schema.marks.textStyle.create({ ...existing, ...attrs }))
    const cursorPos = firstTextPos(tr.doc, resolvedFrom, resolvedTo)
    tr.setSelection(TextSelection.create(tr.doc, cursorPos, resolvedTo))
    view.dispatch(tr)
    view.focus()
  }

  const applyHorizontalRuleAttrs = (attrs: Record<string, unknown>) => {
    if (!view || !selectedHorizontalRule) return
    const node = view.state.doc.nodeAt(selectedHorizontalRule.pos)
    if (!node || node.type.name !== 'horizontal_rule') return
    const tr = view.state.tr.setNodeMarkup(selectedHorizontalRule.pos, undefined, {
      ...node.attrs,
      ...attrs,
    })
    tr.setSelection(NodeSelection.create(tr.doc, selectedHorizontalRule.pos))
    view.dispatch(tr)
    view.focus()
  }

  return (
    <>
      {/* ── 顶部应用栏：入口 + 标签 + 右侧操作按钮 ── */}
      <div ref={topBarRef} style={{
        display: 'grid',
        gridTemplateColumns: topBarVeryCompact ? 'minmax(132px, 0.8fr) auto minmax(176px, 1fr)' : 'minmax(190px, 1fr) auto minmax(240px, 1fr)',
        alignItems: 'center',
        height: TOOLBAR_LAYER_HEIGHT,
        minHeight: TOOLBAR_LAYER_HEIGHT,
        background: '#f3f4f6',
        borderBottom: '1px solid #dfe3e8',
        padding: '0 10px',
        columnGap: topBarCompact ? 8 : 14,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: topBarVeryCompact ? 4 : 8, minWidth: 0, overflow: 'hidden' }}>
          <IconButton title="主页" icon={Home} style={{ width: 32, height: 32, minWidth: 32, padding: 0 }} />
          {!topBarVeryCompact && (
            <IconButton
              title="新建文档"
              icon={Plus}
              onMouseDown={event => {
                event.preventDefault()
                event.stopPropagation()
                void onNewDocument?.()
              }}
              style={{ width: 32, height: 32, minWidth: 32, padding: 0 }}
            />
          )}
          {!topBarVeryCompact && <ToolbarSeparator />}
          <IconButton
            title="文件菜单"
            icon={Menu}
            active={Boolean(fileMenu)}
            onMouseDown={event => {
              event.preventDefault()
              event.stopPropagation()
              const rect = event.currentTarget.getBoundingClientRect()
              setFileMenu(current => current ? null : { rect })
            }}
            style={{ width: 32, height: 32, minWidth: 32, padding: 0 }}
          />
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: topBarCompact ? 4 : 8,
            minWidth: 0,
            color: '#111827',
            fontSize: 15,
            fontWeight: 600,
          }}>
            {titleEditing ? (
              <input
                ref={titleInputRef}
                value={titleDraft}
                onChange={event => setTitleDraft(event.currentTarget.value)}
                onBlur={commitTitleEdit}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commitTitleEdit()
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    cancelTitleEdit()
                  }
                }}
                onMouseDown={event => event.stopPropagation()}
                aria-label="编辑文章标题"
                style={{
                  width: topBarCompact ? 92 : 180,
                  minWidth: 48,
                  height: 28,
                  border: '1px solid #93c5fd',
                  borderRadius: 6,
                  background: '#ffffff',
                  color: '#111827',
                  font: 'inherit',
                  fontWeight: 600,
                  outline: 'none',
                  padding: '0 6px',
                }}
              />
            ) : (
              <button
                type="button"
                title="点击编辑文章标题"
                onClick={startTitleEdit}
                onMouseDown={event => event.stopPropagation()}
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: topBarCompact ? 92 : 180,
                  minWidth: 0,
                  border: 'none',
                  background: 'transparent',
                  color: 'inherit',
                  cursor: 'text',
                  font: 'inherit',
                  fontWeight: 600,
                  padding: 0,
                  textAlign: 'left',
                }}
              >
                {displayDocumentTitle}
              </button>
            )}
            {!topBarCompact && <Star size={17} strokeWidth={1.8} color="#6b7280" />}
            {!topBarVeryCompact && <ChevronDown size={15} strokeWidth={2} color="#6b7280" />}
          </div>
        </div>

        {/* 标签区 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: topBarCompact ? 14 : 26, minWidth: 126, overflow: 'hidden' }}>
          {(['home', 'insert', 'page'] as const).map(tab => {
            const label = tab === 'home' ? '开始' : tab === 'insert' ? '插入' : '页面'
            const active = activeTab === tab
            return (
              <button
                type="button"
                key={tab}
                onMouseDown={e => { e.preventDefault(); setActiveTab(tab) }}
                style={{
                  height: TOOLBAR_LAYER_HEIGHT,
                  padding: '0 2px',
                  fontSize: 15,
                  fontWeight: active ? 600 : 400,
                  cursor: 'pointer',
                  border: 'none',
                  borderBottom: active ? '3px solid #2563eb' : '3px solid transparent',
                  background: 'transparent',
                  color: active ? '#2563eb' : '#374151',
                  borderRadius: 0,
                  whiteSpace: 'nowrap',
                }}
              >
                {label}
              </button>
            )
          })}
        </div>

        {/* 右侧操作区 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: topBarCompact ? 4 : 6, minWidth: 0, overflow: 'hidden' }}>
          <TopBarAction
            title="工作区"
            icon={FolderOpen}
            label="工作区"
            active={Boolean(workspaceOpen)}
            compact={topBarCompact}
            onMouseDown={e => { e.preventDefault(); onToggleWorkspace?.() }}
          />
          <TopBarAction
            title="AI 助手"
            icon={Bot}
            label="WPS AI"
            active={Boolean(sidebarOpen)}
            compact={topBarCompact}
            onMouseDown={e => { e.preventDefault(); onToggleSidebar?.() }}
          />
          <div style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0, borderRadius: 8, background: aiCopilotEnabled ? '#e8f1ff' : 'transparent' }}>
            <TopBarAction
              title={aiCopilotEnabled ? '关闭 AI 伴写' : '开启 AI 伴写'}
              icon={Sparkles}
              label="伴写"
              active={Boolean(aiCopilotEnabled)}
              compact={topBarVeryCompact}
              onMouseDown={e => { e.preventDefault(); onToggleAICopilot?.() }}
            />
            <button
              type="button"
              title="AI 伴写设置"
              data-openwps-ai-copilot-settings="true"
              onMouseDown={(event) => {
                event.preventDefault()
                event.stopPropagation()
                const rect = event.currentTarget.getBoundingClientRect()
                setAiCopilotMenu(current => current ? null : { rect })
              }}
              style={{
                width: 28,
                height: 34,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: 'none',
                borderLeft: aiCopilotEnabled ? '1px solid #cfe0ff' : '1px solid transparent',
                borderRadius: '0 8px 8px 0',
                background: aiCopilotMenu ? '#dbeafe' : 'transparent',
                color: aiCopilotEnabled || aiCopilotMenu ? '#2563eb' : '#374151',
                cursor: 'pointer',
              }}
            >
              <SlidersHorizontal size={15} strokeWidth={2} />
            </button>
          </div>
          <TopBarAction
            title={isFullscreen ? '退出全屏 (F11)' : '全屏模式 (F11)'}
            icon={isFullscreen ? Shrink : Expand}
            label={isFullscreen ? '退出全屏' : '全屏'}
            compact={topBarCompact}
            onMouseDown={e => { e.preventDefault(); onToggleFullscreen?.() }}
          />
          {!topBarVeryCompact && <IconButton title="云同步状态" icon={Cloud} style={{ width: 32, height: 32, minWidth: 32, padding: 0 }} />}
          {collapsed && (
            <IconButton
              title="展开工具栏"
              icon={ChevronDown}
              label="展开"
              onClick={() => setCollapsed(false)}
              style={{ height: 32 }}
            />
          )}
          <TopBarAction
            title="分享"
            icon={Share2}
            label="分享"
            primary
            onMouseDown={e => e.preventDefault()}
          />
        </div>
      </div>

      {fileMenu && (
        <div
          onMouseDown={event => event.stopPropagation()}
          style={{
            position: 'fixed',
            top: fileMenu.rect.bottom + 6,
            left: fileMenu.rect.left,
            zIndex: 9999,
            width: 188,
            padding: '6px',
            border: '1px solid #e5e7eb',
            borderRadius: 10,
            background: '#ffffff',
            boxShadow: '0 18px 40px rgba(15, 23, 42, 0.16)',
          }}
        >
          {fileMenuItems.map(item => {
            const ItemIcon = item.icon
            return (
              <button
                key={item.label}
                type="button"
                title={item.title}
                onMouseDown={event => {
                  event.preventDefault()
                  handleFileMenuAction(item.action)
                  setFileMenu(null)
                }}
                style={{
                  width: '100%',
                  height: 36,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '0 10px',
                  border: 'none',
                  borderRadius: 7,
                  background: 'transparent',
                  color: '#111827',
                  cursor: 'pointer',
                  fontSize: 14,
                  textAlign: 'left',
                }}
                onMouseEnter={event => { event.currentTarget.style.background = '#f3f4f6' }}
                onMouseLeave={event => { event.currentTarget.style.background = 'transparent' }}
              >
                <ItemIcon size={17} strokeWidth={2} color="#374151" />
                <span>{item.label}</span>
              </button>
            )
          })}
        </div>
      )}

      {aiCopilotMenu && (
        <div
          data-openwps-ai-copilot-menu="true"
          onMouseDown={event => event.stopPropagation()}
          style={{
            position: 'fixed',
            top: aiCopilotMenu.rect.bottom + 6,
            left: Math.max(8, aiCopilotMenu.rect.left - 156),
            zIndex: 9999,
            width: 240,
            padding: 10,
            border: '1px solid #e5e7eb',
            borderRadius: 10,
            background: '#ffffff',
            boxShadow: '0 18px 40px rgba(15, 23, 42, 0.16)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, color: '#111827', fontSize: 14, fontWeight: 600 }}>
            <Sparkles size={16} strokeWidth={2} color="#2563eb" />
            <span>AI 伴写设置</span>
          </div>
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>活跃程度</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
              {([
                ['conservative', '保守'],
                ['standard', '标准'],
                ['active', '积极'],
              ] as const).map(([value, label]) => {
                const active = aiCopilotActivity === value
                return (
                  <button
                    key={value}
                    type="button"
                    data-openwps-ai-activity={value}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      onAICopilotActivityChange?.(value)
                    }}
                    style={{
                      height: 30,
                      border: `1px solid ${active ? '#2563eb' : '#d1d5db'}`,
                      borderRadius: 7,
                      background: active ? '#e8f1ff' : '#ffffff',
                      color: active ? '#2563eb' : '#374151',
                      cursor: 'pointer',
                      fontSize: 13,
                    }}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>候选数量</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
              {[1, 2, 3].map((count) => {
                const active = aiCopilotCandidateCount === count
                return (
                  <button
                    key={count}
                    type="button"
                    data-openwps-ai-candidate-count={count}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      onAICopilotCandidateCountChange?.(count)
                    }}
                    style={{
                      height: 30,
                      border: `1px solid ${active ? '#2563eb' : '#d1d5db'}`,
                      borderRadius: 7,
                      background: active ? '#e8f1ff' : '#ffffff',
                      color: active ? '#2563eb' : '#374151',
                      cursor: 'pointer',
                      fontSize: 13,
                    }}
                  >
                    {count}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── 工具栏行（可折叠） ── */}
      {!collapsed && (
        <div style={{
          display: 'flex',
          alignItems: 'stretch',
          background: '#f3f4f6',
          borderBottom: '1px solid #e5e7eb',
          height: TOOLBAR_LAYER_HEIGHT,
          minHeight: TOOLBAR_LAYER_HEIGHT,
          boxSizing: 'border-box',
          padding: '4px 5px',
        }}>
          <div style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            height: '100%',
            minHeight: 0,
            borderRadius: 10,
            background: '#ffffff',
            boxShadow: '0 1px 2px rgba(15, 23, 42, 0.08)',
            overflow: 'hidden',
          }}>
          {/* 左滚动箭头 */}
          {showScrollLeft && (
            <button
              onClick={() => scrollByStep('left')}
              style={{
                flexShrink: 0, width: 28,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', border: 'none',
                background: 'transparent', color: '#6b7280', fontSize: 16,
                userSelect: 'none',
              }}
              title="向左滚动"
            >
              <ChevronLeft size={18} strokeWidth={2} />
            </button>
          )}

          {/* 可滚动工具区 */}
          <div
            ref={scrollContainerRef}
            className="toolbar-row"
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 3,
              minHeight: 0,
              height: '100%',
              margin: '0 0 0 0',
              padding: '0 10px',
              overflowX: 'auto',
              overflowY: 'hidden',
              scrollbarWidth: 'none',
            }}
          >
            {/* ══ 开始 Tab ══ */}
            {activeTab === 'home' && (
              <>
                {/* 撤销 / 重做 */}
                <IconButton title="撤销 (Ctrl+Z)" icon={Undo2} onMouseDown={e => { e.preventDefault(); if (view) undo(view.state, view.dispatch) }} />
                <IconButton title="重做 (Ctrl+Y)" icon={Redo2} onMouseDown={e => { e.preventDefault(); if (view) redo(view.state, view.dispatch) }} />

                {sep}

                {selectedHorizontalRule ? (
                  <>
                    <span style={{ fontSize: 13, color: '#374151', padding: '0 6px', whiteSpace: 'nowrap' }}>分割线</span>
                    <ToolbarSelect
                      title="分割线样式"
                      value={selectedHorizontalRule.attrs.lineStyle}
                      style={{ minWidth: 84 }}
                      onChange={e => applyHorizontalRuleAttrs({ lineStyle: e.target.value })}
                    >
                      {HORIZONTAL_RULE_STYLE_OPTIONS.map(option => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </ToolbarSelect>

                    <div style={{ position: 'relative' }}>
                      <IconButton
                        title="分割线颜色"
                        onMouseDown={e => {
                          e.preventDefault()
                          e.stopPropagation()
                          if (colorPickerOpen === 'hr-selected') {
                            setColorPickerOpen(null)
                            setColorPickerAnchor(null)
                            return
                          }
                          setColorPickerOpen('hr-selected')
                          setColorPickerAnchor(e.currentTarget.getBoundingClientRect())
                        }}
                      >
                        <SeparatorHorizontal size={18} strokeWidth={2} />
                        <span style={{ height: 3, width: 16, background: selectedHorizontalRule.attrs.lineColor, border: '1px solid #ccc', borderRadius: 1 }} />
                      </IconButton>
                      {colorPickerOpen === 'hr-selected' && colorPickerAnchor && (
                        <ColorSwatch
                          colors={HORIZONTAL_RULE_COLORS}
                          current={selectedHorizontalRule.attrs.lineColor}
                          anchorRect={colorPickerAnchor}
                          onChange={c => { applyHorizontalRuleAttrs({ lineColor: c }) }}
                          onClose={() => {
                            setColorPickerOpen(null)
                            setColorPickerAnchor(null)
                          }}
                        />
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    {/* 段落样式 */}
                    <button
                      type="button"
                      title="段落样式"
                      data-openwps-style-button="true"
                      onMouseDown={event => {
                        event.preventDefault()
                        event.stopPropagation()
                        setStyleDropdown(current => current ? null : { rect: event.currentTarget.getBoundingClientRect() })
                      }}
                      style={{
                        minWidth: 104,
                        height: 34,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        padding: '0 10px',
                        border: 'none',
                        borderRadius: 8,
                        background: '#ffffff',
                        color: '#111827',
                        cursor: 'pointer',
                        fontSize: 14,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <span>{activeParagraphStyle.label}</span>
                      <ChevronDown size={14} color="#6b7280" strokeWidth={2} />
                    </button>

                    {/* 字体 */}
                    <ToolbarSelect
                      title="字体"
                      value={fmt.text.fontFamily}
                      style={{ minWidth: 96 }}
                      onMouseDown={saveSelection}
                      onChange={e => applyTextStyleWithSaved({ fontFamily: e.target.value })}
                    >
                      <option value={FONT_STACKS.song}>宋体</option>
                      <option value={FONT_STACKS.hei}>黑体</option>
                      <option value={FONT_STACKS.kai}>楷体</option>
                      <option value={FONT_STACKS.fang}>仿宋</option>
                      <option value={FONT_STACKS.arial}>Arial</option>
                      <option value={FONT_STACKS.timesNewRoman}>Times New Roman</option>
                    </ToolbarSelect>

                    {/* 字号 */}
                    <ToolbarSelect
                      title="字号"
                      value={String(fmt.text.fontSize)}
                      style={{ minWidth: 72 }}
                      onMouseDown={saveSelection}
                      onChange={e => applyTextStyleWithSaved({ fontSize: Number(e.target.value) })}
                    >
                      {fontSizeOptions.map(v => (
                        <option key={v} value={String(v)}>{v}pt</option>
                      ))}
                    </ToolbarSelect>

                    {sep}

                    {/* B I U S X² X₂ */}
                    <IconButton title="加粗 (Ctrl+B)" icon={Bold} active={fmt.text.bold} onMouseDown={e => { e.preventDefault(); if (view) applyTextStyle(view, { bold: !fmt.text.bold }) }} />
                    <IconButton title="斜体 (Ctrl+I)" icon={Italic} active={fmt.text.italic} onMouseDown={e => { e.preventDefault(); if (view) applyTextStyle(view, { italic: !fmt.text.italic }) }} />
                    <IconButton title="下划线 (Ctrl+U)" icon={Underline} active={fmt.text.underline} onMouseDown={e => { e.preventDefault(); if (view) applyTextStyle(view, { underline: !fmt.text.underline }) }} />
                    <IconButton title="删除线" icon={Strikethrough} active={fmt.text.strikethrough} onMouseDown={e => { e.preventDefault(); if (view) applyTextStyle(view, { strikethrough: !fmt.text.strikethrough }) }} />
                    <IconButton title="上标" icon={Superscript} active={fmt.text.superscript} onMouseDown={e => { e.preventDefault(); if (view) applyTextStyle(view, { superscript: !fmt.text.superscript }) }} />
                    <IconButton title="下标" icon={Subscript} active={fmt.text.subscript} onMouseDown={e => { e.preventDefault(); if (view) applyTextStyle(view, { subscript: !fmt.text.subscript }) }} />

                    {/* 文字颜色 */}
                    <div style={{ position: 'relative' }}>
                      <IconButton
                        title="文字颜色"
                        onMouseDown={e => {
                          e.preventDefault()
                          e.stopPropagation()
                          if (colorPickerOpen === 'text') {
                            setColorPickerOpen(null)
                            setColorPickerAnchor(null)
                            return
                          }
                          setColorPickerOpen('text')
                          setColorPickerAnchor(e.currentTarget.getBoundingClientRect())
                        }}
                      >
                        <Type size={18} strokeWidth={2} />
                        <span style={{ height: 3, width: 16, background: fmt.text.color, border: '1px solid #ccc', borderRadius: 1 }} />
                      </IconButton>
                      {colorPickerOpen === 'text' && colorPickerAnchor && (
                        <ColorSwatch
                          colors={TEXT_COLORS}
                          current={fmt.text.color}
                          anchorRect={colorPickerAnchor}
                          onChange={c => { if (view) applyTextStyle(view, { color: c }) }}
                          onClose={() => {
                            setColorPickerOpen(null)
                            setColorPickerAnchor(null)
                          }}
                        />
                      )}
                    </div>

                    {/* 背景色 */}
                    <div style={{ position: 'relative' }}>
                      <IconButton
                        title="文字背景色（高亮）"
                        onMouseDown={e => {
                          e.preventDefault()
                          e.stopPropagation()
                          if (colorPickerOpen === 'bg') {
                            setColorPickerOpen(null)
                            setColorPickerAnchor(null)
                            return
                          }
                          setColorPickerOpen('bg')
                          setColorPickerAnchor(e.currentTarget.getBoundingClientRect())
                        }}
                      >
                        <Highlighter size={18} strokeWidth={2} />
                        <span style={{ height: 3, width: 16, background: fmt.text.backgroundColor || 'transparent', border: '1px solid #ccc', borderRadius: 1 }} />
                      </IconButton>
                      {colorPickerOpen === 'bg' && colorPickerAnchor && (
                        <ColorSwatch
                          colors={HIGHLIGHT_COLORS}
                          current={fmt.text.backgroundColor}
                          anchorRect={colorPickerAnchor}
                          onChange={c => { if (view) applyTextStyle(view, { backgroundColor: c }) }}
                          onClose={() => {
                            setColorPickerOpen(null)
                            setColorPickerAnchor(null)
                          }}
                        />
                      )}
                    </div>

                    {/* 清除格式 */}
                    <IconButton title="清除格式" icon={Eraser} onMouseDown={e => { e.preventDefault(); if (view) clearFormatting(view) }} />

                    {sep}

                    {/* 对齐 */}
                    <IconButton title="左对齐" icon={AlignLeft} active={fmt.para.align === 'left'} onMouseDown={e => { e.preventDefault(); if (view) applyParaStyle(view, { align: 'left' }) }} />
                    <IconButton title="居中" icon={AlignCenter} active={fmt.para.align === 'center'} onMouseDown={e => { e.preventDefault(); if (view) applyParaStyle(view, { align: 'center' }) }} />
                    <IconButton title="右对齐" icon={AlignRight} active={fmt.para.align === 'right'} onMouseDown={e => { e.preventDefault(); if (view) applyParaStyle(view, { align: 'right' }) }} />
                    <IconButton title="两端对齐" icon={AlignJustify} active={fmt.para.align === 'justify'} onMouseDown={e => { e.preventDefault(); if (view) applyParaStyle(view, { align: 'justify' }) }} />

                    {sep}

                    {/* 列表 */}
                    <IconButton title="无序列表" icon={List} active={fmt.para.listType === 'bullet'} onMouseDown={e => { e.preventDefault(); if (view) toggleList(view, 'bullet') }} />
                    <IconButton title="有序列表" icon={ListOrdered} active={fmt.para.listType === 'ordered'} onMouseDown={e => { e.preventDefault(); if (view) toggleList(view, 'ordered') }} />
                    <IconButton title="任务列表" icon={ListChecks} active={fmt.para.listType === 'task'} onMouseDown={e => { e.preventDefault(); if (view) toggleList(view, 'task') }} />

                    {sep}

                    {/* 首行缩进 */}
                    <IconButton title="增加首行缩进 (Tab)" icon={BetweenHorizontalStart} label="首" onMouseDown={e => { e.preventDefault(); if (view) applyParaStyle(view, { firstLineIndent: Math.max(0, (fmt.para.firstLineIndent as number) + 2) }) }} />
                    <IconButton title="减少首行缩进 (Shift+Tab)" icon={BetweenHorizontalEnd} label="首" onMouseDown={e => { e.preventDefault(); if (view) applyParaStyle(view, { firstLineIndent: Math.max(0, (fmt.para.firstLineIndent as number) - 2) }) }} />
                    {/* 整体缩进 */}
                    <IconButton title="增加缩进" icon={IndentIncrease} onMouseDown={e => { e.preventDefault(); if (view) applyParaStyle(view, { indent: (fmt.para.indent as number || 0) + 1 }) }} />
                    <IconButton title="减少缩进" icon={IndentDecrease} onMouseDown={e => { e.preventDefault(); if (view) applyParaStyle(view, { indent: Math.max(0, (fmt.para.indent as number || 0) - 1) }) }} />

                    {sep}

                    {/* 行距 */}
                    <ToolbarSelect
                      title="行距"
                      value={fmt.para.lineHeight}
                      style={{ minWidth: 72 }}
                      onChange={e => { if (view) applyParaStyle(view, { lineHeight: Number(e.target.value) }) }}
                    >
                      {[1.0, 1.15, 1.5, 2.0, 2.5, 3.0].map(v => <option key={v} value={v}>{v}</option>)}
                    </ToolbarSelect>

                    {/* 段前间距 */}
                    <IconButton
                      title="段前间距"
                      icon={ALargeSmall}
                      label={`段前${(fmt.para.spaceBefore as number) > 0 ? `${fmt.para.spaceBefore}pt` : '0'}`}
                      active={spacingPopover?.which === 'before'}
                      style={{ minWidth: 76 }}
                      onMouseDown={e => {
                        e.preventDefault()
                        e.stopPropagation()
                        if (spacingPopover?.which === 'before') { setSpacingPopover(null); return }
                        setSpacingPopover({ which: 'before', rect: e.currentTarget.getBoundingClientRect() })
                      }}
                    />

                    {/* 段后间距 */}
                    <IconButton
                      title="段后间距"
                      icon={TextQuote}
                      label={`段后${(fmt.para.spaceAfter as number) > 0 ? `${fmt.para.spaceAfter}pt` : '0'}`}
                      active={spacingPopover?.which === 'after'}
                      style={{ minWidth: 76 }}
                      onMouseDown={e => {
                        e.preventDefault()
                        e.stopPropagation()
                        if (spacingPopover?.which === 'after') { setSpacingPopover(null); return }
                        setSpacingPopover({ which: 'after', rect: e.currentTarget.getBoundingClientRect() })
                      }}
                    />
                  </>
                )}
              </>
            )}

            {/* ══ 插入 Tab ══ */}
            {activeTab === 'insert' && (
              <>
                {selectedHorizontalRule && (
                  <>
                    <span style={{ fontSize: 13, color: '#374151', padding: '0 6px', whiteSpace: 'nowrap' }}>分割线</span>
                    <ToolbarSelect
                      title="分割线样式"
                      value={selectedHorizontalRule.attrs.lineStyle}
                      style={{ minWidth: 84 }}
                      onChange={e => applyHorizontalRuleAttrs({ lineStyle: e.target.value })}
                    >
                      {HORIZONTAL_RULE_STYLE_OPTIONS.map(option => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </ToolbarSelect>
                    <div style={{ position: 'relative' }}>
                      <IconButton
                        title="分割线颜色"
                        onMouseDown={e => {
                          e.preventDefault()
                          e.stopPropagation()
                          if (colorPickerOpen === 'hr-selected') {
                            setColorPickerOpen(null)
                            setColorPickerAnchor(null)
                            return
                          }
                          setColorPickerOpen('hr-selected')
                          setColorPickerAnchor(e.currentTarget.getBoundingClientRect())
                        }}
                      >
                        <SeparatorHorizontal size={18} strokeWidth={2} />
                        <span style={{ height: 3, width: 16, background: selectedHorizontalRule.attrs.lineColor, border: '1px solid #ccc', borderRadius: 1 }} />
                      </IconButton>
                      {colorPickerOpen === 'hr-selected' && colorPickerAnchor && (
                        <ColorSwatch
                          colors={HORIZONTAL_RULE_COLORS}
                          current={selectedHorizontalRule.attrs.lineColor}
                          anchorRect={colorPickerAnchor}
                          onChange={c => { applyHorizontalRuleAttrs({ lineColor: c }) }}
                          onClose={() => {
                            setColorPickerOpen(null)
                            setColorPickerAnchor(null)
                          }}
                        />
                      )}
                    </div>
                    {sep}
                  </>
                )}

                {/* 插入内容 */}
                <IconButton title="插入水平分割线" icon={SeparatorHorizontal} label="分割线" onMouseDown={e => { e.preventDefault(); if (view) insertHR(view, horizontalRuleInsertAttrs) }} />
                <ToolbarSelect
                  title="插入分割线样式"
                  value={horizontalRuleInsertAttrs.lineStyle}
                  style={{ minWidth: 84 }}
                  onChange={e => {
                    setHorizontalRuleInsertAttrs(current => ({ ...current, lineStyle: e.target.value }))
                  }}
                >
                  {HORIZONTAL_RULE_STYLE_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </ToolbarSelect>
                <div style={{ position: 'relative' }}>
                  <IconButton
                    title="插入分割线颜色"
                    onMouseDown={e => {
                      e.preventDefault()
                      e.stopPropagation()
                      if (colorPickerOpen === 'hr-insert') {
                        setColorPickerOpen(null)
                        setColorPickerAnchor(null)
                        return
                      }
                      setColorPickerOpen('hr-insert')
                      setColorPickerAnchor(e.currentTarget.getBoundingClientRect())
                    }}
                  >
                    <Brush size={18} strokeWidth={2} />
                    <span style={{ height: 3, width: 16, background: horizontalRuleInsertAttrs.lineColor, border: '1px solid #ccc', borderRadius: 1 }} />
                  </IconButton>
                  {colorPickerOpen === 'hr-insert' && colorPickerAnchor && (
                    <ColorSwatch
                      colors={HORIZONTAL_RULE_COLORS}
                      current={horizontalRuleInsertAttrs.lineColor}
                      anchorRect={colorPickerAnchor}
                      onChange={c => {
                        setHorizontalRuleInsertAttrs(current => ({ ...current, lineColor: c }))
                      }}
                      onClose={() => {
                        setColorPickerOpen(null)
                        setColorPickerAnchor(null)
                      }}
                    />
                  )}
                </div>
                <IconButton title="插入分页符" icon={SquarePlus} label="分页符" onMouseDown={e => { e.preventDefault(); if (view) insertPageBreak(view) }} />
                <IconButton title="插入本地图片" icon={Image} label="图片" onMouseDown={e => { e.preventDefault(); imageInputRef.current?.click() }} />

                {sep}

                {/* 插入表格 */}
                <button
                  type="button"
                  ref={tablePickerBtnRef}
                  title="插入表格（选择行列数）"
                  onClick={() => setTablePickerOpen(v => !v)}
                  style={{
                    ...toolbarButtonBaseStyle,
                    background: tablePickerOpen ? '#e5e7eb' : 'transparent',
                    color: '#1f2937',
                  }}
                >
                  <Table size={18} strokeWidth={2} />
                  <span style={{ fontSize: 14 }}>表格</span>
                </button>
                {tablePickerOpen && (
                  <TablePicker
                    anchorRef={tablePickerBtnRef}
                    onSelect={(rows, cols) => { if (view) insertTable(view, rows, cols) }}
                    onClose={() => setTablePickerOpen(false)}
                  />
                )}

                {sep}

                {/* 插入批注 */}
                <IconButton
                  title="添加批注（先选中文字）"
                  icon={MessageSquarePlus}
                  label="批注"
                  onMouseDown={e => { e.preventDefault(); onAddComment?.() }}
                />

                {/* 表格操作（仅当光标在表格内时显示） */}
                {selectionInTable && (
                  <>
                    {sep}
                    <ToolbarSelect
                      title="表格行列操作"
                      value=""
                      style={{ minWidth: 118 }}
                      onMouseDown={() => {
                        savedTableViewRef.current = view
                      }}
                      onChange={e => {
                        const action = e.target.value
                        e.target.value = ''
                        const v = savedTableViewRef.current ?? view
                        if (!v) return
                        switch (action) {
                          case 'row-before': runTableCommand(v, addRowBefore); break
                          case 'row-after': runTableCommand(v, addRowAfter); break
                          case 'row-delete': runTableCommand(v, deleteRow); break
                          case 'col-before': runTableCommand(v, addColumnBefore); break
                          case 'col-after': runTableCommand(v, addColumnAfter); break
                          case 'col-delete': runTableCommand(v, deleteColumn); break
                          case 'merge': runTableCommand(v, mergeCells); break
                          case 'split': runTableCommand(v, splitCell); break
                          case 'delete-table': deleteTableNode(v); break
                        }
                        savedTableViewRef.current = null
                      }}
                    >
                      <option value="" disabled>表格操作▾</option>
                      <option value="row-before">↑ 在上方插入行</option>
                      <option value="row-after">↓ 在下方插入行</option>
                      <option value="row-delete">✕ 删除当前行</option>
                      <option value="col-before">← 在左侧插入列</option>
                      <option value="col-after">→ 在右侧插入列</option>
                      <option value="col-delete">✕ 删除当前列</option>
                      <option value="merge">⊞ 合并单元格</option>
                      <option value="split">⊟ 拆分单元格</option>
                      <option value="delete-table">🗑 删除整个表格</option>
                    </ToolbarSelect>
                  </>
                )}
              </>
            )}

            {/* ══ 页面 Tab ══ */}
            {activeTab === 'page' && (
              <>
                <PageToolbarButton
                  label="页边距"
                  icon={Ruler}
                  active={pagePopover?.section === 'margins'}
                  onMouseDown={e => {
                    e.preventDefault()
                    e.stopPropagation()
                    const rect = e.currentTarget.getBoundingClientRect()
                    setPagePopover(current => current?.section === 'margins' ? null : { section: 'margins', rect })
                  }}
                />
                {sep}
                <PageToolbarButton
                  label="纸张方向"
                  icon={PanelLeft}
                  active={pagePopover?.section === 'orientation'}
                  onMouseDown={e => {
                    e.preventDefault()
                    e.stopPropagation()
                    const rect = e.currentTarget.getBoundingClientRect()
                    setPagePopover(current => current?.section === 'orientation' ? null : { section: 'orientation', rect })
                  }}
                />
                <PageToolbarButton
                  label="纸张大小"
                  icon={FileOutput}
                  active={pagePopover?.section === 'size'}
                  onMouseDown={e => {
                    e.preventDefault()
                    e.stopPropagation()
                    const rect = e.currentTarget.getBoundingClientRect()
                    setPagePopover(current => current?.section === 'size' ? null : { section: 'size', rect })
                  }}
                />
              </>
            )}
          </div>

          {/* 右滚动箭头 */}
          {showScrollRight && (
            <button
              onClick={() => scrollByStep('right')}
              style={{
                flexShrink: 0, width: 28,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', border: 'none',
                background: 'transparent', color: '#6b7280', fontSize: 16,
                userSelect: 'none',
              }}
              title="向右滚动"
            >
              <ChevronRight size={18} strokeWidth={2} />
            </button>
          )}

          {/* 收起按钮 */}
          <div style={{ display: 'flex', alignItems: 'center', padding: '0 8px 0 6px', borderLeft: '1px solid #d8dde3', flexShrink: 0 }}>
            <IconButton
              title="收起工具栏"
              onClick={() => setCollapsed(true)}
              icon={ChevronUp}
              style={{ width: 30, minWidth: 30, height: 36, padding: 0 }}
            />
          </div>
          </div>
        </div>
      )}

      {/* 隐藏文件 input */}
      <input
        type="file"
        accept=".docx,.md,.markdown,text/markdown"
        ref={fileInputRef}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void onImportDocx?.(file)
          event.target.value = ''
        }}
        style={{ display: 'none' }}
      />
      {/* 隐藏图片 input */}
      <input
        type="file"
        accept="image/*"
        ref={imageInputRef}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void onInsertImage?.(file)
          event.target.value = ''
        }}
        style={{ display: 'none' }}
      />

      {/* Spacing popovers — rendered at root to escape toolbar overflow */}
      {spacingPopover?.which === 'before' && (
        <SpacingPopover
          anchorRect={spacingPopover.rect}
          value={fmt.para.spaceBefore as number}
          onChange={v => { if (view) applyParaStyle(view, { spaceBefore: v }) }}
          onClose={() => setSpacingPopover(null)}
        />
      )}
      {spacingPopover?.which === 'after' && (
        <SpacingPopover
          anchorRect={spacingPopover.rect}
          value={fmt.para.spaceAfter as number}
          onChange={v => { if (view) applyParaStyle(view, { spaceAfter: v }) }}
          onClose={() => setSpacingPopover(null)}
        />
      )}

      {styleDropdown && (
        <ParagraphStyleDropdown
          anchorRect={styleDropdown.rect}
          activeId={activeParagraphStyleId}
          onSelect={option => { if (view) applyParagraphNamedStyle(view, option) }}
          onClose={() => setStyleDropdown(null)}
        />
      )}

      {pagePopover && (
        <PageSettingsPopover
          anchorRect={pagePopover.rect}
          section={pagePopover.section}
          pageConfig={pageConfig}
          onPageConfigChange={onPageConfigChange}
          onClose={() => setPagePopover(null)}
        />
      )}
    </>
  )
}
