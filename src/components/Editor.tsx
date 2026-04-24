import React, { useEffect, useRef, useState, useCallback } from 'react'
import { EditorState, NodeSelection, Plugin, TextSelection } from 'prosemirror-state'
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view'
import { DOMParser as PMDOMParser } from 'prosemirror-model'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap } from 'prosemirror-commands'
import { history, undo, redo } from 'prosemirror-history'
import { goToNextCell, isInTable, tableEditing } from 'prosemirror-tables'
import { schema } from '../editor/schema'
import { createImageNodeViewFactory } from '../editor/imageNodeView'
import {
  paginate,
  DEFAULT_PAGE_CONFIG,
  type PageConfig,
  type PaginateResult,
  type DomBlockMetric,
} from '../layout/paginator'
import { Toolbar } from './Toolbar'
import AISidebar from './AISidebar'
import WorkspacePanel from './WorkspacePanel'
import FileManagerModal from './FileManagerModal'
import type { DocumentFileSummary, DocumentSettings, DocumentSource } from './FileManagerModal'
import SettingsModal from './SettingsModal'
import { importDocx, type PMNodeJSON } from '../docx/importer'
import { buildDocxBlob, exportDocx, type DocxExportOptions } from '../docx/exporter'
import { DEFAULT_EDITOR_FONT_STACK } from '../fonts'
import { markdownToDocument } from '../markdown/importer'
import { PretextPageRenderer } from './PretextPageRenderer'
import type { CommentData } from './CommentPopover'
import { CommentSidebar, type SidebarCommentData } from './CommentSidebar'
import { AddCommentDialog } from './AddCommentDialog'
import TemplateManagerModal from './TemplateManagerModal'
import { buildTemplateAnalysisPayload } from '../templates/analyzer'
import type { TemplateAnalyzeResult, TemplateRecord, TemplateSummary } from '../templates/types'

// ─── Page geometry ───────────────────────────────────────────────────────────
const PAGE_GAP = 32 // px gap between A4 cards
const DOCX_PUNCTUATION_COMPRESSION_PX = -0.34
const DEFAULT_SERVER_DOCUMENT_NAME = 'document.docx'

declare global {
  interface Window {
    __OPENWPS_TEST_EXPORT_DOCX__?: () => Promise<Blob>
  }
}

interface TemplateUpdatePayload {
  name: string
  note: string
  templateText: string
}

interface PendingCommentTarget {
  from: number
  to: number
  anchorRect: DOMRect
}

interface AISettingsSnapshot {
  activeProviderId?: string
  model?: string
}

const DEFAULT_DOCUMENT_SETTINGS: DocumentSettings = {
  activeSource: 'internal',
  wpsDirectory: '',
  available: true,
  errorMessage: null,
  activeDirectory: '',
  internalDirectory: '',
}

type TemplateExtractionStatus = 'idle' | 'preparing' | 'analyzing' | 'saving' | 'success' | 'error'

interface TemplateExtractionState {
  status: TemplateExtractionStatus
  fileName: string
  providerId: string
  model: string
  message: string
  errorMessage: string
  startedAt: string
  finishedAt: string
  resultTemplateId?: string
}

interface TemplateNotice {
  kind: 'success' | 'error'
  title: string
  message: string
}

const IDLE_TEMPLATE_EXTRACTION_STATE: TemplateExtractionState = {
  status: 'idle',
  fileName: '',
  providerId: '',
  model: '',
  message: '',
  errorMessage: '',
  startedAt: '',
  finishedAt: '',
}

function collectVisibleComments(
  canvasElement: HTMLDivElement | null,
  editorElement: HTMLDivElement | null,
): SidebarCommentData[] {
  if (!canvasElement || !editorElement) return []

  const canvasRect = canvasElement.getBoundingClientRect()
  const commentNodes = Array.from(editorElement.querySelectorAll<HTMLElement>('.pm-comment[data-comment-id]'))
  if (commentNodes.length === 0) return []

  const commentMap = new Map<string, {
    id: string
    author: string
    date: string
    content: string
    selectionText: string[]
    rects: DOMRect[]
  }>()

  commentNodes.forEach((node) => {
    const id = node.getAttribute('data-comment-id') ?? ''
    if (!id) return

    const group = commentMap.get(id) ?? {
      id,
      author: node.getAttribute('data-comment-author') ?? '',
      date: node.getAttribute('data-comment-date') ?? '',
      content: node.getAttribute('data-comment-content') ?? '',
      selectionText: [],
      rects: [],
    }

    const text = node.textContent?.trim()
    if (text) group.selectionText.push(text)

    const rects = Array.from(node.getClientRects())
    if (rects.length === 0) {
      const rect = node.getBoundingClientRect()
      if (rect.width > 0 || rect.height > 0) group.rects.push(rect)
    } else {
      rects.forEach((rect) => {
        if (rect.width > 0 || rect.height > 0) group.rects.push(rect)
      })
    }

    commentMap.set(id, group)
  })

  return Array.from(commentMap.values())
    .filter((comment) => comment.rects.length > 0)
    .map((comment) => {
      const left = Math.min(...comment.rects.map((rect) => rect.left)) - canvasRect.left
      const top = Math.min(...comment.rects.map((rect) => rect.top)) - canvasRect.top
      const right = Math.max(...comment.rects.map((rect) => rect.right)) - canvasRect.left
      const bottom = Math.max(...comment.rects.map((rect) => rect.bottom)) - canvasRect.top

      return {
        id: comment.id,
        author: comment.author,
        date: comment.date,
        content: comment.content,
        selectionText: Array.from(new Set(comment.selectionText)).join(''),
        anchorRect: new DOMRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top)),
      }
    })
    .sort((first, second) => first.anchorRect.top - second.anchorRect.top)
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const raw = await response.text()
  const contentType = response.headers.get('content-type') ?? ''

  if (!response.ok) {
    let detail = ''
    if (contentType.includes('application/json')) {
      try {
        const parsed = JSON.parse(raw) as { detail?: unknown, message?: unknown }
        detail = typeof parsed.detail === 'string'
          ? parsed.detail
          : typeof parsed.message === 'string'
            ? parsed.message
            : ''
      } catch {
        detail = ''
      }
    }
    if (!detail) {
      detail = raw.slice(0, 200).replace(/\s+/g, ' ').trim()
    }
    throw new Error(detail || `HTTP ${response.status}`)
  }

  if (!contentType.includes('application/json')) {
    const preview = raw.slice(0, 80).replace(/\s+/g, ' ').trim()
    throw new Error(`接口返回了非 JSON 内容，可能后端还没重启或路由未生效：${preview}`)
  }

  try {
    return JSON.parse(raw) as T
  } catch (error) {
    throw new Error(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function buildImportedDocumentName(filename: string) {
  const trimmed = filename.trim()
  if (!trimmed) return DEFAULT_SERVER_DOCUMENT_NAME
  return trimmed.replace(/\.(md|markdown)$/i, '.docx')
}

// Widget height for a break after a page that used `usedH` px of content:
//   = (remaining space on that page) + BREAK_BASE
//   = (CONTENT_H - usedH) + BREAK_BASE
// This ensures content after the widget lands exactly at the next card's content top.
function breakWidgetHeight(usedH: number, cfg: PageConfig): number {
  const contentH = cfg.pageHeight - cfg.marginTop - cfg.marginBottom
  const breakBase = cfg.marginBottom + PAGE_GAP + cfg.marginTop
  return Math.max(contentH - usedH, 0) + breakBase
}

// ─── ProseMirror styles ───────────────────────────────────────────────────────
const PM_STYLES = `
@font-face {
  font-family: "OpenWPSSong";
  src: local("SimSun"), local("宋体"), local("Songti SC"), local("STSong"), local("Noto Serif CJK SC");
}
@font-face {
  font-family: "OpenWPSSong";
  src: local("SimHei"), local("黑体"), local("Heiti SC"), local("STHeiti"), local("Microsoft YaHei");
  unicode-range: U+2018-2019, U+201C-201D;
}
@font-face {
  font-family: "OpenWPSHei";
  src: local("SimHei"), local("黑体"), local("Heiti SC"), local("STHeiti"), local("Microsoft YaHei"), local("PingFang SC");
}
@font-face {
  font-family: "OpenWPSKai";
  src: local("KaiTi"), local("楷体"), local("Kaiti SC"), local("STKaiti");
}
@font-face {
  font-family: "OpenWPSKai";
  src: local("SimHei"), local("黑体"), local("Heiti SC"), local("STHeiti"), local("Microsoft YaHei");
  unicode-range: U+2018-2019, U+201C-201D;
}
@font-face {
  font-family: "OpenWPSFang";
  src: local("FangSong"), local("仿宋"), local("STFangsong");
}
.ProseMirror {
  outline: none;
  font-family: ${DEFAULT_EDITOR_FONT_STACK};
  font-size: 12pt;
  line-height: 1.5;
  color: #000;
  white-space: pre-wrap;
  word-break: normal;
  line-break: strict;
  overflow-wrap: anywhere;
  font-variant-east-asian: proportional-width;
  font-kerning: normal;
}
.ProseMirror p { margin: 0; padding: 0; }
.ProseMirror p { letter-spacing: var(--docx-letter-spacing, 0px); }
.ProseMirror .pm-script-gap {
  padding-right: 0.25em;
}
.ProseMirror p.list-bullet {
  padding-left: calc(2em + var(--list-level, 0) * 2em);
  position: relative;
}
.ProseMirror p.list-bullet::before {
  content: "•";
  position: absolute;
  left: calc(var(--list-level, 0) * 2em + 0.5em);
}
.ProseMirror p.list-task {
  padding-left: calc(2em + var(--list-level, 0) * 2em);
  position: relative;
}
.ProseMirror p.list-task::before {
  content: "☐";
  position: absolute;
  left: calc(var(--list-level, 0) * 2em);
  color: #4b5563;
}
.ProseMirror p.list-task.list-task-checked::before {
  content: "☑";
}
.ProseMirror {
  counter-reset: ol-counter;
}
.ProseMirror p:not(.list-ordered) {
  counter-reset: ol-counter;
}
.ProseMirror p.list-ordered {
  counter-increment: ol-counter;
  padding-left: calc(2.5em + var(--list-level, 0) * 2em);
  position: relative;
}
.ProseMirror p.list-ordered::before {
  content: counter(ol-counter) ".";
  position: absolute;
  left: calc(var(--list-level, 0) * 2em);
}
.ProseMirror a {
  color: #0b57d0;
  text-decoration: underline;
}
.ProseMirror hr {
  border: none;
  border-top: 1px solid #ccc;
  margin: 8px 0;
}
.ProseMirror td,
.ProseMirror th {
  position: relative;
}
.ProseMirror .selectedCell::after {
  content: "";
  position: absolute;
  inset: 0;
  background: rgba(59, 130, 246, 0.14);
  pointer-events: none;
}
.ProseMirror img {
  display: inline-block;
  max-width: 100%;
  vertical-align: bottom;
}
.ProseMirror p.page-break-before {
}
.pretext-driving-editor .ProseMirror {
  color: transparent;
  -webkit-text-fill-color: transparent;
  caret-color: transparent;
  text-rendering: geometricPrecision;
  pointer-events: none;
}
.pretext-driving-editor {
  pointer-events: none;
}
.pretext-driving-editor .ProseMirror * {
  color: transparent !important;
  -webkit-text-fill-color: transparent;
  text-shadow: none !important;
  text-decoration: none !important;
  text-decoration-color: transparent !important;
  text-emphasis-color: transparent !important;
  box-shadow: none !important;
}
.pretext-driving-editor .ProseMirror ::selection,
.pretext-driving-editor .ProseMirror *::selection {
  background: transparent !important;
  color: transparent !important;
  -webkit-text-fill-color: transparent !important;
}
.pretext-driving-editor .ProseMirror table {
  opacity: 0;
}
.pretext-driving-editor .ProseMirror table {
  opacity: 1;
}
.pretext-driving-editor .ProseMirror table,
.pretext-driving-editor .ProseMirror img,
.pretext-driving-editor .ProseMirror [data-pm-image-wrapper],
.pretext-driving-editor .ProseMirror table * {
  color: #111827 !important;
  -webkit-text-fill-color: #111827 !important;
  text-decoration-color: currentColor !important;
  text-emphasis-color: currentColor !important;
  pointer-events: auto;
}
.pretext-driving-editor .ProseMirror table,
.pretext-driving-editor .ProseMirror table * {
  caret-color: #111827 !important;
}
.ProseMirror [data-pm-image-wrapper],
.ProseMirror [data-pm-image-wrapper] * {
  caret-color: transparent !important;
}
.pretext-driving-editor .ProseMirror table p,
.pretext-driving-editor .ProseMirror table span {
  text-shadow: none !important;
}
.pretext-driving-editor .ProseMirror table ::selection,
.pretext-driving-editor .ProseMirror table *::selection {
  background: rgba(24, 119, 242, 0.24) !important;
  color: inherit !important;
  -webkit-text-fill-color: currentColor !important;
}
.pretext-driving-editor .ProseMirror hr {
  opacity: 0;
  border-top-color: transparent;
  pointer-events: none;
}
.pretext-driving-editor .ProseMirror .pm-comment,
.pretext-driving-editor .ProseMirror .pm-comment:hover {
  background-color: transparent !important;
  border-bottom-color: transparent !important;
}
.ProseMirror .pm-comment {
  background-color: rgba(253, 224, 71, 0.35);
  border-bottom: 2px solid #f59e0b;
  cursor: pointer;
}
.ProseMirror .pm-comment:hover {
  background-color: rgba(253, 224, 71, 0.6);
}
@keyframes openwps-caret-blink {
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0; }
}
`

// ─── Page-break decoration plugin ────────────────────────────────────────────
// Widget decorations are transparent (no background).
// They only add vertical space so the NEXT paragraph starts at the correct
// y-offset on the following A4 card. The visual white/gray comes from the
// absolutely-positioned page card divs rendered beneath the editor.

const pageBreakPlugin = new Plugin<{ decos: DecorationSet }>({
  state: {
    init: () => ({ decos: DecorationSet.empty }),
    apply(tr, prev) {
      const meta = tr.getMeta('pageBreakDecos') as DecorationSet | undefined
      if (meta !== undefined) return { decos: meta }
      if (tr.docChanged) return { decos: prev.decos.map(tr.mapping, tr.doc) }
      return prev
    },
  },
  props: {
    decorations(state) {
      return this.getState(state)?.decos ?? DecorationSet.empty
    },
  },
})

const HAN_CHAR_RE = /\p{Script=Han}/u
const LATIN_ALPHA_RE = /[A-Za-z]/

function isHanChar(char: string) {
  return HAN_CHAR_RE.test(char)
}

function isLatinAlphaChar(char: string) {
  return LATIN_ALPHA_RE.test(char)
}

function shouldInsertMixedScriptGap(prevChar: string, nextChar: string) {
  return (
    (isLatinAlphaChar(prevChar) && isHanChar(nextChar)) ||
    (isHanChar(prevChar) && isLatinAlphaChar(nextChar))
  )
}

function buildMixedScriptSpacingDecos(doc: EditorState['doc']): DecorationSet {
  const decos: Decoration[] = []

  doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return
    const paragraphStart = pos + 1
    const chars: Array<{ char: string; from: number; to: number }> = []

    node.forEach((child, offset) => {
      if (!child.isText) return
      const text = child.text ?? ''
      const childStart = paragraphStart + offset
      for (let index = 0; index < text.length; index += 1) {
        chars.push({
          char: text[index] ?? '',
          from: childStart + index,
          to: childStart + index + 1,
        })
      }
    })

    for (let index = 0; index < chars.length - 1; index += 1) {
      const current = chars[index]
      const next = chars[index + 1]
      if (!current || !next) continue
      if (shouldInsertMixedScriptGap(current.char, next.char)) {
        decos.push(Decoration.inline(current.from, current.to, { class: 'pm-script-gap' }))
      }
    }
  })

  return DecorationSet.create(doc, decos)
}

const mixedScriptSpacingPlugin = new Plugin<{ decos: DecorationSet }>({
  state: {
    init: (_, state) => ({ decos: buildMixedScriptSpacingDecos(state.doc) }),
    apply(tr, prev, _oldState, newState) {
      if (!tr.docChanged) return prev
      return { decos: buildMixedScriptSpacingDecos(newState.doc) }
    },
  },
  props: {
    decorations(state) {
      return this.getState(state)?.decos ?? DecorationSet.empty
    },
  },
})

// Factory: creates a transparent spacer widget of the given height.
// Use a block-level span so the same widget can be inserted both at block
// boundaries and in the middle of a paragraph.
function makePageBreakWidget(height: number): () => HTMLElement {
  return () => {
    const span = document.createElement('span')
    span.style.cssText = [
      'display:block',
      `height:${height}px`,
      'pointer-events:none',
      'background:transparent',
      'line-height:0',
      'font-size:0',
    ].join(';')
    return span
  }
}

function buildDecos(
  doc: EditorState['doc'],
  pageBreaks: { pos: number; height: number }[]
): DecorationSet {
  if (!pageBreaks.length) return DecorationSet.empty
  return DecorationSet.create(
    doc,
    pageBreaks.map(({ pos, height }) =>
      Decoration.widget(pos, makePageBreakWidget(height), { side: -1, key: `pb-${pos}` })
    )
  )
}

function waitForAnimationFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

function parseCssPx(value: string) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function collectDomBlockMetrics(view: EditorView): DomBlockMetric[] {
  const metrics: DomBlockMetric[] = []

  view.state.doc.forEach((node, offset, blockIndex) => {
    if (node.type.name !== 'table') return
    const dom = view.nodeDOM(offset)
    const element = dom instanceof HTMLElement ? dom : null
    if (!element) return

    const rect = element.getBoundingClientRect()
    const style = window.getComputedStyle(element)
    metrics.push({
      pos: offset,
      blockIndex,
      blockType: node.type.name,
      height: rect.height,
      marginTop: parseCssPx(style.marginTop),
      marginBottom: parseCssPx(style.marginBottom),
    })
  })

  return metrics
}

function transactionHasStyleMutation(tx: EditorState['tr']) {
  return tx.steps.some((step) => {
    const stepType = step.toJSON().stepType
    return stepType === 'addMark' || stepType === 'removeMark' || stepType === 'replaceAround'
  })
}

// ─── Editor state helpers ─────────────────────────────────────────────────────
function toggleMarkAttr(
  state: EditorState,
  dispatch: ((tr: EditorState['tr']) => void) | undefined,
  attr: 'bold' | 'italic' | 'underline'
): boolean {
  if (state.selection.empty || !dispatch) return false
  const { from, to } = state.selection
  const { tr, doc } = state
  let isActive = false
  let existing: Record<string, unknown> = {}
  doc.nodesBetween(from, to, (node) => {
    if (node.isText) {
      const mark = node.marks.find((m) => m.type === schema.marks.textStyle)
      if (mark) {
        if (mark.attrs[attr]) isActive = true
        existing = { ...mark.attrs }
      }
    }
  })
  dispatch(tr.addMark(from, to, schema.marks.textStyle.create({ ...existing, [attr]: !isActive })))
  return true
}

function isCaretAtStartOfParagraphAfterTable(state: EditorState) {
  const { $from, empty } = state.selection
  if (!empty) return false
  if ($from.depth !== 1) return false
  if ($from.parent.type.name !== 'paragraph') return false
  if ($from.parentOffset !== 0) return false

  const paragraphIndex = $from.index(0)
  if (paragraphIndex === 0) return false

  const previousNode = state.doc.child(paragraphIndex - 1)
  return previousNode.type.name === 'table'
}

function getParagraphAtPos(state: EditorState, pos: number) {
  const candidatePositions = Array.from(new Set([
    Math.max(0, Math.min(pos, state.doc.content.size)),
    Math.max(0, Math.min(pos + 1, state.doc.content.size)),
    Math.max(0, Math.min(pos - 1, state.doc.content.size)),
  ]))

  for (const candidatePos of candidatePositions) {
    const $pos = state.doc.resolve(candidatePos)
    for (let depth = $pos.depth; depth >= 0; depth -= 1) {
      const node = $pos.node(depth)
      if (node.type.name !== 'paragraph') continue
      return {
        node,
        pos: depth > 0 ? $pos.before(depth) : 0,
      }
    }
  }

  return null
}

function clearTaskItemMarker(state: EditorState, dispatch?: (tr: import('prosemirror-state').Transaction) => void) {
  const { $from, empty } = state.selection
  if (!empty) return false
  if ($from.parent.type.name !== 'paragraph') return false
  if ($from.parent.attrs.listType !== 'task') return false
  if ($from.parentOffset !== 0) return false

  if (dispatch) {
    const paragraphPos = $from.before($from.depth)
    const tr = state.tr.setNodeMarkup(paragraphPos, undefined, {
      ...$from.parent.attrs,
      listType: null,
      listLevel: 0,
      listChecked: false,
    })
    dispatch(tr.scrollIntoView())
  }

  return true
}

function insertTaskItemAfter(state: EditorState, dispatch?: (tr: import('prosemirror-state').Transaction) => void) {
  const { $from, empty } = state.selection
  if (!empty) return false
  if ($from.parent.type.name !== 'paragraph') return false
  if ($from.parent.attrs.listType !== 'task') return false
  if ($from.parentOffset !== $from.parent.content.size) return false

  if (dispatch) {
    const paragraphPos = $from.before($from.depth)
    const insertPos = paragraphPos + $from.parent.nodeSize
    const newParagraph = schema.nodes.paragraph.create({
      ...$from.parent.attrs,
      listType: 'task',
      listChecked: false,
    })
    const tr = state.tr.insert(insertPos, newParagraph)
    tr.setSelection(TextSelection.create(tr.doc, Math.min(insertPos + 1, tr.doc.content.size)))
    dispatch(tr.scrollIntoView())
  }

  return true
}

function toggleTaskItemCheckedFromPoint(
  view: EditorView,
  pos: number,
  clientX?: number,
) {
  if (typeof clientX !== 'number') return false

  const paragraph = getParagraphAtPos(view.state, pos)
  if (!paragraph || paragraph.node.attrs.listType !== 'task') return false

  const textStartPos = Math.min(paragraph.pos + 1, view.state.doc.content.size)
  const coords = view.coordsAtPos(textStartPos)
  const checkboxLeft = coords.left - 24
  const checkboxRight = coords.left + 4

  if (clientX < checkboxLeft || clientX > checkboxRight) return false

  const nextSelectionPos = Math.max(0, Math.min(pos, view.state.doc.content.size))
  const tr = view.state.tr.setNodeMarkup(paragraph.pos, undefined, {
    ...paragraph.node.attrs,
    listChecked: !Boolean(paragraph.node.attrs.listChecked),
  })
  tr.setSelection(TextSelection.create(tr.doc, Math.min(nextSelectionPos, tr.doc.content.size)))

  view.dispatch(tr.scrollIntoView())
  view.focus()
  return true
}

// 在图片相邻位置按 Backspace：仅删除"一个单位"，不要触发 joinBackward 把上一段并入本段。
//   - 光标右邻是图片  → 删除该图片节点
//   - 光标左邻是图片且本段尚未开始（parentOffset === 0）→ 在上一段末尾删除一个字符
//     · 上一段为空段落 → 直接删除该空段
//     · 上一段是 table 等非 textblock → 不处理（交给后续守卫）
function deleteAroundImageBackward(state: EditorState, dispatch?: (tr: import('prosemirror-state').Transaction) => void) {
  const { $from, empty } = state.selection
  if (!empty) return false
  const imageType = schema.nodes.image

  const before = $from.nodeBefore
  if (before && before.type === imageType) {
    if (dispatch) {
      const tr = state.tr.delete($from.pos - before.nodeSize, $from.pos)
      dispatch(tr.scrollIntoView())
    }
    return true
  }

  const after = $from.nodeAfter
  if (after && after.type === imageType && $from.parentOffset === 0 && $from.depth >= 1) {
    const paragraphIndex = $from.index($from.depth - 1)
    if (paragraphIndex === 0) return false
    const parent = $from.node($from.depth - 1)
    const prev = parent.maybeChild(paragraphIndex - 1)
    if (!prev) return false
    if (!prev.isTextblock) return false

    // 当前段落开始 token 的位置（= 上一兄弟节点的结束位置）
    const paragraphBefore = $from.before($from.depth)
    // 上一段落 content 末尾位置（关闭 token 之前）
    const prevContentEnd = paragraphBefore - 1

    if (dispatch) {
      let tr
      if (prev.content.size === 0) {
        // 删除整个空段
        tr = state.tr.delete(paragraphBefore - prev.nodeSize, paragraphBefore)
      } else {
        // 仅删除上一段末尾一个位置（一个字符或一个 inline atom）
        tr = state.tr.delete(prevContentEnd - 1, prevContentEnd)
      }
      dispatch(tr.scrollIntoView())
    }
    return true
  }

  return false
}

function deleteAroundImageForward(state: EditorState, dispatch?: (tr: import('prosemirror-state').Transaction) => void) {
  const { $from, empty } = state.selection
  if (!empty) return false
  const imageType = schema.nodes.image
  const after = $from.nodeAfter
  if (after && after.type === imageType) {
    if (dispatch) {
      const tr = state.tr.delete($from.pos, $from.pos + after.nodeSize)
      dispatch(tr.scrollIntoView())
    }
    return true
  }
  return false
}

function initState(): EditorState {
  const div = document.createElement('div')
  div.innerHTML = '<p>开始输入文字，当内容超过一页高度时将自动出现第二张 A4 白纸...</p>'
  const doc = PMDOMParser.fromSchema(schema).parse(div)

  const isCaretAtStartOfParagraphAfterTable = (state: EditorState) => {
    const { $from, empty } = state.selection
    if (!empty) return false
    if ($from.depth !== 1) return false
    if ($from.parent.type.name !== 'paragraph') return false
    if ($from.parentOffset !== 0) return false

    const paragraphIndex = $from.index(0)
    if (paragraphIndex === 0) return false

    const previousNode = state.doc.child(paragraphIndex - 1)
    return previousNode.type.name === 'table'
  }


  return EditorState.create({
    doc,
    plugins: [
      history(),
      keymap({
        'Tab': goToNextCell(1),
        'Shift-Tab': goToNextCell(-1),
      }),
      keymap({
        'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo,
        'Mod-b': (s, d) => toggleMarkAttr(s, d, 'bold'),
        'Mod-i': (s, d) => toggleMarkAttr(s, d, 'italic'),
        'Mod-u': (s, d) => toggleMarkAttr(s, d, 'underline'),
        // ── Protect the paragraph that sits directly after a table ────────────
        // On macOS, the physical Delete key maps to Backspace. At the start of
        // the paragraph after a table, deleting backward must never pull the
        // following line into the table above.
        // 同时：在图片相邻位置只删除"一个单位"，不要把上一段并入本段。
        'Backspace': (state, dispatch) => {
          if (isCaretAtStartOfParagraphAfterTable(state)) return true
          if (clearTaskItemMarker(state, dispatch)) return true
          if (deleteAroundImageBackward(state, dispatch)) return true
          return false
        },
        'Delete': (state, dispatch) => {
          if (isCaretAtStartOfParagraphAfterTable(state)) return true
          if (clearTaskItemMarker(state, dispatch)) return true
          if (deleteAroundImageForward(state, dispatch)) return true
          return false
        },
        'Enter': (state, dispatch) => {
          if (insertTaskItemAfter(state, dispatch)) return true
          return false
        },
        'Tab': (state, dispatch) => {
          if (isInTable(state)) return false
          if (!dispatch) return false
          const { selection, tr } = state
          let changed = false
          state.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
            if (node.type.name === 'paragraph') {
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, firstLineIndent: (node.attrs.firstLineIndent || 0) + 2 })
              changed = true
            }
          })
          if (changed) { dispatch(tr); return true }
          return false
        },
        'Shift-Tab': (state, dispatch) => {
          if (isInTable(state)) return false
          if (!dispatch) return false
          const { selection, tr } = state
          let changed = false
          state.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
            if (node.type.name === 'paragraph') {
              const newIndent = Math.max(0, (node.attrs.firstLineIndent || 0) - 2)
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, firstLineIndent: newIndent })
              changed = true
            }
          })
          if (changed) { dispatch(tr); return true }
          return false
        },
      }),
      keymap(baseKeymap),
      tableEditing(),
      mixedScriptSpacingPlugin,
      pageBreakPlugin,
    ],
  })
}

// ─── Editor component ─────────────────────────────────────────────────────────
export const Editor: React.FC = () => {
  const mountRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [fileModalMode, setFileModalMode] = useState<'open' | 'save' | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const applyingImportedDocxRef = useRef(false)
  const [view, setView] = useState<EditorView | null>(null)
  const [editorState, setEditorState] = useState<EditorState | null>(null)
  const [pageConfig, setPageConfig] = useState<PageConfig>(DEFAULT_PAGE_CONFIG)
  const pageConfigRef = useRef<PageConfig>(DEFAULT_PAGE_CONFIG)
  const docxExportOptionsRef = useRef<DocxExportOptions>({})
  const [pageCount, setPageCount] = useState(1)
  const [layoutResult, setLayoutResult] = useState<PaginateResult | null>(null)
  const layoutResultRef = useRef<PaginateResult | null>(null)
  const [layoutSettling, setLayoutSettling] = useState(false)
  const [editorFocused, setEditorFocused] = useState(false)
  const [editorComposing, setEditorComposing] = useState(false)
  const [docxLetterSpacingPx, setDocxLetterSpacingPx] = useState(0)
  const docxLetterSpacingRef = useRef(0)
  const [documentFiles, setDocumentFiles] = useState<DocumentFileSummary[]>([])
  const [documentFilesLoading, setDocumentFilesLoading] = useState(false)
  const [documentFilesError, setDocumentFilesError] = useState<string | null>(null)
  const [documentSettings, setDocumentSettings] = useState<DocumentSettings>(DEFAULT_DOCUMENT_SETTINGS)
  const [documentSettingsSaving, setDocumentSettingsSaving] = useState(false)
  const [currentDocumentName, setCurrentDocumentName] = useState(DEFAULT_SERVER_DOCUMENT_NAME)
  const [templates, setTemplates] = useState<TemplateSummary[]>([])
  const [templateManagerOpen, setTemplateManagerOpen] = useState(false)
  const [activeTemplate, setActiveTemplate] = useState<TemplateRecord | null>(null)
  const [currentAIProviderId, setCurrentAIProviderId] = useState<string | null>(null)
  const [currentAIModel, setCurrentAIModel] = useState<string | null>(null)
  const [templateExtractionState, setTemplateExtractionState] = useState<TemplateExtractionState>(IDLE_TEMPLATE_EXTRACTION_STATE)
  const [templateNotice, setTemplateNotice] = useState<TemplateNotice | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const templateManagerOpenRef = useRef(false)

  // ── Comment state ───────────────────────────────────────────────────────────
  const [activeComment, setActiveComment] = useState<CommentData | null>(null)
  const [addCommentAnchor, setAddCommentAnchor] = useState<DOMRect | null>(null)
  const [pendingCommentTarget, setPendingCommentTarget] = useState<PendingCommentTarget | null>(null)
  const [visibleComments, setVisibleComments] = useState<SidebarCommentData[]>([])
  const paginationRunRef = useRef(0)

  useEffect(() => { pageConfigRef.current = pageConfig }, [pageConfig])
  useEffect(() => { docxLetterSpacingRef.current = docxLetterSpacingPx }, [docxLetterSpacingPx])
  useEffect(() => { templateManagerOpenRef.current = templateManagerOpen }, [templateManagerOpen])

  const isTemplateExtractionRunning = ['preparing', 'analyzing', 'saving'].includes(templateExtractionState.status)

  const closeAddCommentDialog = useCallback(() => {
    setPendingCommentTarget(null)
    setAddCommentAnchor(null)
  }, [])

  const refreshVisibleComments = useCallback(() => {
    setVisibleComments(collectVisibleComments(canvasRef.current, mountRef.current))
  }, [])

  // ── Fullscreen ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [])

  const handleToggleFullscreen = useCallback(async () => {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen()
    } else {
      await document.exitFullscreen()
    }
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'F11') {
        e.preventDefault()
        void handleToggleFullscreen()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleToggleFullscreen])

  const clearImportedDocxCompatibility = useCallback(() => {
    if (docxLetterSpacingRef.current === 0 && Object.keys(docxExportOptionsRef.current).length === 0) return
    docxExportOptionsRef.current = {}
    docxLetterSpacingRef.current = 0
    setDocxLetterSpacingPx(0)
    console.log('[docx] imported compatibility metadata cleared after style mutation')
  }, [])

  const applyDocumentState = useCallback((
    docJson: PMNodeJSON,
    nextPageConfig: PageConfig,
    nextDocxExportOptions: DocxExportOptions = {},
    nextDocxLetterSpacingPx = 0,
  ) => {
    const editorView = viewRef.current
    if (!editorView) return

    const docNode = schema.nodeFromJSON(docJson)
    const transaction = editorView.state.tr.replaceWith(
      0,
      editorView.state.doc.nodeSize - 2,
      docNode.content,
    )
    editorView.dispatch(transaction)
    setPageConfig(nextPageConfig)
    pageConfigRef.current = nextPageConfig
    docxExportOptionsRef.current = nextDocxExportOptions
    docxLetterSpacingRef.current = nextDocxLetterSpacingPx
    setDocxLetterSpacingPx(nextDocxLetterSpacingPx)
  }, [])

  const loadDocumentSettings = useCallback(async () => {
    const response = await fetch('/api/documents/settings')
    const data = await readJsonResponse<DocumentSettings>(response)
    setDocumentSettings(data)
    return data
  }, [])

  const loadDocumentFiles = useCallback(async (source?: DocumentSource) => {
    setDocumentFilesLoading(true)
    setDocumentFilesError(null)
    try {
      const searchParams = new URLSearchParams()
      if (source) searchParams.set('source', source)
      const response = await fetch(`/api/documents${searchParams.toString() ? `?${searchParams.toString()}` : ''}`)
      const data = await readJsonResponse<DocumentFileSummary[]>(response)
      setDocumentFiles(data)
      return data
    } catch (error) {
      console.error('[Editor] load document files failed', error)
      setDocumentFiles([])
      setDocumentFilesError(`读取文件列表失败：${error instanceof Error ? error.message : String(error)}`)
      return []
    } finally {
      setDocumentFilesLoading(false)
    }
  }, [])

  const loadTemplates = useCallback(async () => {
    try {
      const response = await fetch('/api/templates')
      const data = await readJsonResponse<TemplateSummary[]>(response)
      setTemplates(data)
    } catch (error) {
      console.error('[Editor] load templates failed', error)
      window.alert(`读取模板列表失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [])

  const activateTemplate = useCallback(async (templateId: string) => {
    const response = await fetch(`/api/templates/${templateId}`)
    const data = await readJsonResponse<TemplateRecord>(response)
    setActiveTemplate(data)
  }, [])

  const loadTemplateDetail = useCallback(async (templateId: string) => {
    const response = await fetch(`/api/templates/${templateId}`)
    return await readJsonResponse<TemplateRecord>(response)
  }, [])

  const handleUploadTemplate = useCallback(async (file: File) => {
    if (['preparing', 'analyzing', 'saving'].includes(templateExtractionState.status)) return

    const startedAt = new Date().toISOString()
    setTemplateNotice(null)
    setTemplateExtractionState({
      status: 'preparing',
      fileName: file.name,
      providerId: currentAIProviderId ?? '',
      model: currentAIModel ?? '',
      message: '正在准备模板证据',
      errorMessage: '',
      startedAt,
      finishedAt: '',
    })

    try {
      let providerId = currentAIProviderId
      let model = currentAIModel
      if (!providerId || !model) {
        try {
          const response = await fetch('/api/ai/settings')
          const settings = await readJsonResponse<AISettingsSnapshot>(response)
          providerId = providerId || settings.activeProviderId || null
          model = model || settings.model || null
        } catch (settingsError) {
          console.warn('[Editor] load ai settings for template analyze failed', settingsError)
        }
      }

      if (!providerId || !model) {
        throw new Error('当前用户 AI 未配置完成，请先在 AI 侧边栏选择可用的服务商和模型。')
      }

      setTemplateExtractionState((current) => ({
        ...current,
        status: 'preparing',
        providerId: providerId ?? '',
        model: model ?? '',
        message: `已开始提取模板信息，准备调用 ${providerId} / ${model}`,
      }))

      const analyzePayload = await buildTemplateAnalysisPayload(file, { providerId, model })
      setTemplateExtractionState((current) => ({
        ...current,
        status: 'analyzing',
        providerId: providerId ?? '',
        model: model ?? '',
        message: `正在调用 ${providerId} / ${model} 提取模板信息`,
      }))
      const analyzeResponse = await fetch('/api/templates/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(analyzePayload),
      })
      const analyzed = await readJsonResponse<TemplateAnalyzeResult>(analyzeResponse)

      setTemplateExtractionState((current) => ({
        ...current,
        status: 'saving',
        message: '模板信息提取完成，正在保存模板',
      }))
      const createPayload = {
        name: analyzePayload.name,
        summary: analyzed.summary,
        sourceFilename: analyzePayload.sourceFilename,
        sourceContentBase64: analyzePayload.sourceContentBase64,
        templateText: analyzed.templateText,
      }
      const response = await fetch('/api/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createPayload),
      })
      const created = await readJsonResponse<TemplateRecord>(response)
      setActiveTemplate(created)
      await loadTemplates()
      setTemplateExtractionState((current) => ({
        ...current,
        status: 'success',
        message: `模板“${created.name}”已提取完成并保存`,
        errorMessage: '',
        finishedAt: new Date().toISOString(),
        resultTemplateId: created.id,
      }))
      if (!templateManagerOpenRef.current) {
        setTemplateNotice({
          kind: 'success',
          title: '模板信息提取完成',
          message: `模板“${created.name}”已保存，可打开模板库查看。`,
        })
      }
    } catch (error) {
      console.error('[Editor] upload template failed', error)
      const message = error instanceof Error ? error.message : String(error)
      setTemplateExtractionState((current) => ({
        ...current,
        status: 'error',
        message: '模板提取失败',
        errorMessage: message,
        finishedAt: new Date().toISOString(),
      }))
      if (!templateManagerOpenRef.current) {
        setTemplateNotice({
          kind: 'error',
          title: '模板提取失败',
          message,
        })
      }
    }
  }, [currentAIModel, currentAIProviderId, loadTemplates, templateExtractionState.status])

  const handleRenameTemplate = useCallback(async (templateId: string, payload: TemplateUpdatePayload) => {
    try {
      const response = await fetch(`/api/templates/${templateId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const updated = await readJsonResponse<TemplateRecord>(response)
      setTemplates((current) => current.map((item) => (
        item.id === updated.id
          ? {
            id: updated.id,
            name: updated.name,
            note: updated.note,
            summary: updated.summary,
            createdAt: updated.createdAt,
            updatedAt: updated.updatedAt,
            sourceFilename: updated.sourceFilename,
            sourceSize: updated.sourceSize,
          }
          : item
      )))
      setActiveTemplate((current) => (current?.id === updated.id ? updated : current))
      return updated
    } catch (error) {
      console.error('[Editor] rename template failed', error)
      window.alert(`更新模板失败：${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }, [])

  const handleDeleteTemplate = useCallback(async (templateId: string) => {
    try {
      const response = await fetch(`/api/templates/${templateId}`, { method: 'DELETE' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setTemplates((current) => current.filter((item) => item.id !== templateId))
      setActiveTemplate((current) => (current?.id === templateId ? null : current))
    } catch (error) {
      console.error('[Editor] delete template failed', error)
      window.alert(`删除模板失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [])

  const performRepagination = useCallback(async () => {
    const runId = ++paginationRunRef.current
    const v = viewRef.current
    if (!v) return null

    // 确保字体加载完成，防止 Pretext Canvas 和 DOM 表格度量口径不同步。
    if (document.fonts?.ready) await document.fonts.ready
    if (runId !== paginationRunRef.current) return null

    // 先移除已有分页 decorations，再等待浏览器完成自然布局。
    // 表格属于 DOM-owned block，必须读取未被 spacer 污染的真实盒模型。
    if (pageBreakPlugin.getState(v.state)?.decos !== DecorationSet.empty) {
      const clearTr = v.state.tr
        .setMeta('pageBreakDecos', DecorationSet.empty)
        .setMeta('addToHistory', false)
      v.updateState(v.state.apply(clearTr))
    }

    await waitForAnimationFrame()
    if (runId !== paginationRunRef.current) return null

    const cfg = pageConfigRef.current
    const doc = v.state.doc
    const domBlockMetrics = collectDomBlockMetrics(v)
    const layout = paginate(doc, cfg, { domBlockMetrics })
    const { breaks } = layout
    layoutResultRef.current = layout
    setLayoutResult(layout)
    setPageCount(prev => breaks.length + 1 !== prev ? breaks.length + 1 : prev)

    const pageBreakDecos = breaks.map((item, index) => {
      const height = breakWidgetHeight(item.prevPageUsed, cfg)
      console.log(
        `[editor] page break before page ${index + 2}: pos=${item.pos}, renderedUsed=${item.prevPageUsed.toFixed(0)}px, widgetH=${height.toFixed(0)}px`
      )
      return { pos: item.pos, height }
    })
    const decos = buildDecos(doc, pageBreakDecos)
    const tr = v.state.tr.setMeta('pageBreakDecos', decos).setMeta('addToHistory', false)
    v.updateState(v.state.apply(tr))
    setLayoutSettling(false)
    return layout
  }, [])

  const repaginate = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      void performRepagination()
    }, 150)
  }, [performRepagination])

  useEffect(() => {
    if (!mountRef.current) return

    const styleEl = document.createElement('style')
    styleEl.textContent = PM_STYLES
    document.head.appendChild(styleEl)

    const state = initState()
    const editorView = new EditorView(mountRef.current, {
      state,
      nodeViews: {
        image: createImageNodeViewFactory(
          () => {
            const cfg = pageConfigRef.current
            return {
              maxWidth: Math.max(20, cfg.pageWidth - cfg.marginLeft - cfg.marginRight),
              maxHeight: Math.max(20, cfg.pageHeight - cfg.marginTop - cfg.marginBottom),
            }
          },
          repaginate,
        ),
      },
      handleDOMEvents: {
        keydown: (view, event) => {
          if ((event.key === 'Backspace' || event.key === 'Delete') && isCaretAtStartOfParagraphAfterTable(view.state)) {
            event.preventDefault()
            return true
          }
          return false
        },
        focus: () => {
          setEditorFocused(true)
          return false
        },
        blur: () => {
          setEditorFocused(false)
          setEditorComposing(false)
          return false
        },
        compositionstart: () => {
          setEditorComposing(true)
          return false
        },
        compositionend: () => {
          setEditorComposing(false)
          return false
        },
        click: (_view, event) => {
          // Detect click on a comment-marked span in the ProseMirror DOM
          let el = event.target as HTMLElement | null
          while (el && el !== _view.dom) {
            if (el.classList?.contains('pm-comment')) {
              const id = el.getAttribute('data-comment-id') ?? ''
              const author = el.getAttribute('data-comment-author') ?? ''
              const date = el.getAttribute('data-comment-date') ?? ''
              const content = el.getAttribute('data-comment-content') ?? ''
              setActiveComment({
                id, author, date, content,
                anchorRect: new DOMRect(event.clientX, event.clientY, 0, 0),
              })
              return false  // don't prevent default so caret still moves
            }
            el = el.parentElement
          }
          // Clicked outside any comment mark — close popover
          setActiveComment(null)
          return false
        },
      },
      dispatchTransaction(tx) {
        const next = editorView.state.apply(tx)
        editorView.updateState(next)
        setEditorState(next)
        if (tx.docChanged && !applyingImportedDocxRef.current && transactionHasStyleMutation(tx)) {
          clearImportedDocxCompatibility()
        }
        if (tx.docChanged) {
          setLayoutSettling(true)
          repaginate()
        }
      },
    })

    viewRef.current = editorView
    setView(editorView)
    setEditorState(state)
    repaginate()

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      editorView.destroy()
      document.head.removeChild(styleEl)
    }
  }, [clearImportedDocxCompatibility, repaginate])

  useEffect(() => {
    if (viewRef.current) repaginate()
  }, [docxLetterSpacingPx, repaginate])

  const buildCurrentDocxBlob = useCallback(async () => {
    const editorView = viewRef.current
    if (!editorView) throw new Error('EditorView is not ready')
    if (timerRef.current) clearTimeout(timerRef.current)
    const layout = await performRepagination()
    return buildDocxBlob(
      editorView.state.doc,
      pageConfigRef.current,
      docxExportOptionsRef.current,
      layout ?? layoutResultRef.current ?? undefined,
    )
  }, [performRepagination])

  useEffect(() => {
    if (!['127.0.0.1', 'localhost'].includes(window.location.hostname)) return undefined
    window.__OPENWPS_TEST_EXPORT_DOCX__ = buildCurrentDocxBlob
    return () => {
      delete window.__OPENWPS_TEST_EXPORT_DOCX__
    }
  }, [buildCurrentDocxBlob])

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      refreshVisibleComments()
    })
    return () => window.cancelAnimationFrame(frameId)
  }, [editorState, layoutResult, pageConfig, refreshVisibleComments])

  useEffect(() => {
    window.addEventListener('resize', refreshVisibleComments)
    return () => window.removeEventListener('resize', refreshVisibleComments)
  }, [refreshVisibleComments])

  useEffect(() => {
    void loadTemplates()
  }, [loadTemplates])

  const handleImportDocx = useCallback(async (file: File) => {
    const editorView = viewRef.current
    if (!editorView) return

    try {
      const parsed = await importDocx(file)
      applyingImportedDocxRef.current = true
      applyDocumentState(parsed.doc, parsed.pageConfig, {
        docGridLinePitchPt: parsed.docGridLinePitchPt,
        typography: parsed.typography,
      }, parsed.typography.punctuationCompression ? DOCX_PUNCTUATION_COMPRESSION_PX : 0)
      setCurrentDocumentName(file.name || DEFAULT_SERVER_DOCUMENT_NAME)
      console.log(
        `[docx] typography: compressPunctuation=${parsed.typography.punctuationCompression} ` +
        `doNotWrapTextWithPunct=${parsed.typography.doNotWrapTextWithPunct} ` +
        `doNotUseEastAsianBreakRules=${parsed.typography.doNotUseEastAsianBreakRules}`
      )
      repaginate()
      window.alert('DOCX 导入成功')
    } catch (error) {
      console.error('[Editor] DOCX import failed', error)
      const message = error instanceof Error ? error.message : String(error)
      window.alert(`DOCX 导入失败：${message}`)
    } finally {
      applyingImportedDocxRef.current = false
    }
  }, [applyDocumentState, repaginate])

  const handleImportMarkdown = useCallback(async (file: File) => {
    try {
      const markdown = await file.text()
      const doc = markdownToDocument(markdown)
      applyDocumentState(doc.toJSON() as PMNodeJSON, DEFAULT_PAGE_CONFIG)
      setCurrentDocumentName(buildImportedDocumentName(file.name || DEFAULT_SERVER_DOCUMENT_NAME))
      repaginate()
      window.alert('Markdown 导入成功')
    } catch (error) {
      console.error('[Editor] Markdown import failed', error)
      const message = error instanceof Error ? error.message : String(error)
      window.alert(`Markdown 导入失败：${message}`)
    }
  }, [applyDocumentState, repaginate])

  const handleImportFile = useCallback(async (file: File) => {
    const name = file.name.toLowerCase()
    if (name.endsWith('.md') || name.endsWith('.markdown') || file.type === 'text/markdown') {
      await handleImportMarkdown(file)
      return
    }
    await handleImportDocx(file)
  }, [handleImportDocx, handleImportMarkdown])

  const handleOpenDocument = useCallback(async (name: string) => {
    try {
      const searchParams = new URLSearchParams({ source: documentSettings.activeSource })
      const response = await fetch(`/api/documents/${encodeURIComponent(name)}?${searchParams.toString()}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const blob = await response.blob()
      const file = new File([blob], name, {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      })
      await handleImportDocx(file)
      setCurrentDocumentName(name)
      setFileModalMode(null)
      await loadDocumentFiles(documentSettings.activeSource)
      window.alert(`${documentSettings.activeSource === 'wps_directory' ? 'WPS 目录' : '服务器文档'}打开成功`)
    } catch (error) {
      console.error('[Editor] open document failed', error)
      const message = error instanceof Error ? error.message : String(error)
      window.alert(`打开文档失败：${message}`)
    }
  }, [documentSettings.activeSource, handleImportDocx, loadDocumentFiles])

  const handleSaveDocument = useCallback(async (name?: string) => {
    const editorView = viewRef.current
    if (!editorView) return
    const targetName = (name ?? currentDocumentName).trim() || DEFAULT_SERVER_DOCUMENT_NAME
    try {
      const blob = await buildCurrentDocxBlob()
      const searchParams = new URLSearchParams({ source: documentSettings.activeSource })
      const response = await fetch(`/api/documents/${encodeURIComponent(targetName)}?${searchParams.toString()}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
        body: blob,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setCurrentDocumentName(targetName.toLowerCase().endsWith('.docx') ? targetName : `${targetName}.docx`)
      setFileModalMode(null)
      await loadDocumentFiles(documentSettings.activeSource)
      window.alert(`${documentSettings.activeSource === 'wps_directory' ? 'WPS 目录' : '服务器文档'}保存成功`)
    } catch (error) {
      console.error('[Editor] save document failed', error)
      const message = error instanceof Error ? error.message : String(error)
      window.alert(`保存文档失败：${message}`)
    }
  }, [buildCurrentDocxBlob, currentDocumentName, documentSettings.activeSource, loadDocumentFiles])

  const handleDeleteDocument = useCallback(async (name: string) => {
    try {
      const searchParams = new URLSearchParams({ source: documentSettings.activeSource })
      const response = await fetch(`/api/documents/${encodeURIComponent(name)}?${searchParams.toString()}`, { method: 'DELETE' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (currentDocumentName === name) {
        setCurrentDocumentName(DEFAULT_SERVER_DOCUMENT_NAME)
      }
      await loadDocumentFiles(documentSettings.activeSource)
    } catch (error) {
      console.error('[Editor] delete document failed', error)
      const message = error instanceof Error ? error.message : String(error)
      window.alert(`删除文档失败：${message}`)
    }
  }, [currentDocumentName, documentSettings.activeSource, loadDocumentFiles])

  const handleChangeDocumentSource = useCallback(async (source: DocumentSource) => {
    setDocumentSettingsSaving(true)
    try {
      const response = await fetch('/api/documents/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeSource: source }),
      })
      const data = await readJsonResponse<DocumentSettings>(response)
      setDocumentSettings(data)
      await loadDocumentFiles(data.activeSource)
    } catch (error) {
      console.error('[Editor] change document source failed', error)
      window.alert(`切换文档来源失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setDocumentSettingsSaving(false)
    }
  }, [loadDocumentFiles])

  const handleUpdateWpsDirectory = useCallback(async (path: string) => {
    setDocumentSettingsSaving(true)
    try {
      const response = await fetch('/api/documents/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wpsDirectory: path }),
      })
      const data = await readJsonResponse<DocumentSettings>(response)
      setDocumentSettings(data)
      if (data.activeSource === 'wps_directory') {
        await loadDocumentFiles('wps_directory')
      }
      window.alert('WPS 目录配置已更新')
    } catch (error) {
      console.error('[Editor] update wps directory failed', error)
      window.alert(`更新 WPS 目录失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setDocumentSettingsSaving(false)
    }
  }, [loadDocumentFiles])

  const openServerFileModal = useCallback(async () => {
    setFileModalMode('open')
    try {
      const settings = await loadDocumentSettings()
      await loadDocumentFiles(settings.activeSource)
    } catch (error) {
      console.error('[Editor] open file modal failed', error)
      setDocumentFiles([])
      setDocumentFilesError(`读取文档设置失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [loadDocumentFiles, loadDocumentSettings])

  const openSaveFileModal = useCallback(async () => {
    setFileModalMode('save')
    try {
      const settings = await loadDocumentSettings()
      await loadDocumentFiles(settings.activeSource)
    } catch (error) {
      console.error('[Editor] open save modal failed', error)
      setDocumentFiles([])
      setDocumentFilesError(`读取文档设置失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [loadDocumentFiles, loadDocumentSettings])

  const handleExportDocx = useCallback(async () => {
    const editorView = viewRef.current
    if (!editorView) return

    try {
      const blob = await buildCurrentDocxBlob()
      await exportDocx(blob)
      window.alert('DOCX 导出成功')
    } catch (error) {
      console.error('[Editor] DOCX export failed', error)
      const message = error instanceof Error ? error.message : String(error)
      window.alert(`DOCX 导出失败：${message}`)
    }
  }, [])

  const handleInsertImage = useCallback((file: File) => {
    const editorView = viewRef.current
    if (!editorView) return
    const reader = new FileReader()
    reader.onload = (e) => {
      const src = e.target?.result
      if (typeof src !== 'string') return
      const { state, dispatch } = editorView
      const imageNode = schema.nodes.image.create({ src, alt: file.name, width: null, height: null })
      const paragraphNode = schema.nodes.paragraph.create(undefined, imageNode)
      const insertPos = state.selection.to
      dispatch(state.tr.insert(insertPos, paragraphNode))
      editorView.focus()
    }
    reader.readAsDataURL(file)
  }, [])

  // ── Comment handlers ────────────────────────────────────────────────────────

  /** Called from Toolbar "批注" button: open the AddCommentDialog anchored to selection */
  const handleStartAddComment = useCallback(() => {
    const editorView = viewRef.current
    if (!editorView) return
    const { from, to, empty } = editorView.state.selection
    if (empty) {
      window.alert('请先选中要批注的文字')
      return
    }

    // Try to get the real visible rect from the browser selection first
    let rect: DOMRect | null = null
    const nativeSel = window.getSelection()
    if (nativeSel && nativeSel.rangeCount > 0) {
      const range = nativeSel.getRangeAt(0)
      const r = range.getBoundingClientRect()
      if (r.width > 0 || r.height > 0) rect = r
    }

    // Fallback: use ProseMirror coordsAtPos
    if (!rect) {
      const fromCoords = editorView.coordsAtPos(from)
      const toCoords = editorView.coordsAtPos(to)
      rect = new DOMRect(
        fromCoords.left,
        fromCoords.top,
        toCoords.right - fromCoords.left,
        toCoords.bottom - fromCoords.top,
      )
    }

    setPendingCommentTarget({ from, to, anchorRect: rect })
    setAddCommentAnchor(rect)
  }, [])

  /** Confirm adding a comment: apply the comment mark to the current selection */
  const handleConfirmAddComment = useCallback((content: string) => {
    const editorView = viewRef.current
    if (!editorView) return
    if (!pendingCommentTarget) {
      closeAddCommentDialog()
      window.alert('批注目标已失效，请重新选择文字')
      return
    }

    const maxPos = editorView.state.doc.content.size
    const { from, to } = pendingCommentTarget
    if (from < 0 || to > maxPos || from >= to) {
      closeAddCommentDialog()
      window.alert('批注目标已失效，请重新选择文字')
      return
    }

    const id = String(Date.now())
    const author = '我'
    const date = new Date().toISOString()
    const mark = schema.marks.comment.create({ id, author, date, content })
    const selection = TextSelection.create(editorView.state.doc, from, to)
    const tr = editorView.state.tr.setSelection(selection).addMark(from, to, mark)
    editorView.dispatch(tr)
    setActiveComment({ id, author, date, content, anchorRect: pendingCommentTarget.anchorRect })
    closeAddCommentDialog()
    editorView.focus()
  }, [closeAddCommentDialog, pendingCommentTarget])

  /** Delete a comment: remove the comment mark with matching id from the whole doc */
  const handleDeleteComment = useCallback((id: string) => {
    const editorView = viewRef.current
    if (!editorView) return
    const { state, dispatch } = editorView
    const { doc, tr } = state
    const commentMark = schema.marks.comment
    doc.descendants((node, pos) => {
      if (!node.isText) return true
      const mark = node.marks.find(m => m.type === commentMark && m.attrs.id === id)
      if (mark) {
        tr.removeMark(pos, pos + node.nodeSize, mark)
      }
      return true
    })
    dispatch(tr)
    setActiveComment(null)
    editorView.focus()
  }, [])

  /** Resolve a comment: remove the mark (mark it as done) */
  const handleResolveComment = useCallback((id: string) => {
    handleDeleteComment(id)
  }, [handleDeleteComment])

  const handleRequestCaretPos = useCallback((pos: number, clientX?: number, clientY?: number) => {
    const editorView = viewRef.current
    if (!editorView) return

    const clampedPos = Math.max(0, Math.min(pos, editorView.state.doc.content.size))
    editorView.focus()

    if (toggleTaskItemCheckedFromPoint(editorView, clampedPos, clientX)) {
      setActiveComment(null)
      return
    }

    // Check if there's a comment mark at this position — if so, show the popover
    // (This path is hit when PretextPageRenderer handles the click, not ProseMirror DOM)
    const $pos = editorView.state.doc.resolve(clampedPos)
    const commentMark = $pos.marks().find(m => m.type === schema.marks.comment)
    if (commentMark) {
      setActiveComment({
        id: String(commentMark.attrs.id ?? ''),
        author: String(commentMark.attrs.author ?? ''),
        date: String(commentMark.attrs.date ?? ''),
        content: String(commentMark.attrs.content ?? ''),
        anchorRect: new DOMRect(clientX ?? 0, clientY ?? 0, 0, 0),
      })
    } else {
      setActiveComment(null)
    }

    const selection = TextSelection.create(editorView.state.doc, clampedPos)
    const tr = editorView.state.tr.setSelection(selection).setMeta('addToHistory', false)
    editorView.dispatch(tr)
  }, [])

  const handleRequestSelectionRange = useCallback((anchor: number, head: number) => {
    const editorView = viewRef.current
    if (!editorView) return

    const maxPos = editorView.state.doc.content.size
    const clampedAnchor = Math.max(0, Math.min(anchor, maxPos))
    const clampedHead = Math.max(0, Math.min(head, maxPos))
    editorView.focus()
    const selection = TextSelection.create(editorView.state.doc, clampedAnchor, clampedHead)
    const tr = editorView.state.tr.setSelection(selection).setMeta('addToHistory', false)
    editorView.dispatch(tr)
  }, [])

  const handleRequestNodeSelection = useCallback((pos: number) => {
    const editorView = viewRef.current
    if (!editorView) return

    const maxPos = editorView.state.doc.content.size
    const clampedPos = Math.max(0, Math.min(pos, maxPos))
    editorView.focus()
    setActiveComment(null)
    const selection = NodeSelection.create(editorView.state.doc, clampedPos)
    const tr = editorView.state.tr.setSelection(selection).setMeta('addToHistory', false)
    editorView.dispatch(tr)
  }, [])

  // Canvas height = all A4 cards stacked with gaps
  const cfg = pageConfig  // ← 用 state 而非 ref，确保 React 重渲染时拿到最新值
  const canvasH = pageCount * cfg.pageHeight + (pageCount - 1) * PAGE_GAP
  const selectedNodePos = React.useMemo(() => {
    if (!(editorState?.selection instanceof NodeSelection)) return null
    return editorState.selection.node.type.name === 'horizontal_rule'
      || editorState.selection.node.type.name === 'table_of_contents'
      ? editorState.selection.from
      : null
  }, [editorState])
  const editorInTable = Boolean(editorState && isInTable(editorState))
  const pretextVisualActive = Boolean(layoutResult && !layoutSettling && !editorComposing && !editorInTable)
  const visualCaretRect = React.useMemo(() => {
    if (!layoutResult || !editorState?.selection.empty) return null

    const editorView = viewRef.current
    const canvas = canvasRef.current
    if (!editorView || !canvas) return null

    try {
      const { $head } = editorState.selection
      const imageType = schema.nodes.image
      let imagePos: number | null = null
      let imageEdge: 'left' | 'right' | null = null

      if ($head.nodeAfter?.type === imageType) {
        imagePos = $head.pos
        imageEdge = 'left'
      } else if ($head.nodeBefore?.type === imageType) {
        imagePos = $head.pos - $head.nodeBefore.nodeSize
        imageEdge = 'right'
      }

      const canvasRect = canvas.getBoundingClientRect()

      if (imagePos != null && imageEdge) {
        const imageDom = editorView.nodeDOM(imagePos)
        if (imageDom instanceof HTMLElement) {
          const imageRect = imageDom.getBoundingClientRect()
          return {
            left: (imageEdge === 'left' ? imageRect.left : imageRect.right) - canvasRect.left,
            top: imageRect.top - canvasRect.top,
            height: Math.max(1, imageRect.height),
          }
        }
      }

      return null
    } catch {
      return null
    }
  }, [editorState, layoutResult])

  return (
    <div className="flex h-screen" style={{ background: '#e8e8e8' }}>
      {/* Workspace Panel — left side */}
      {workspaceOpen && (
        <WorkspacePanel onClose={() => setWorkspaceOpen(false)} />
      )}

      <div className="flex flex-col flex-1 min-w-0">
        {/* Toolbar */}
        <div className="sticky top-0 z-10 shadow-sm">
          <Toolbar
            view={view}
            editorState={editorState}
            pageConfig={pageConfig}
            onPageConfigChange={(newCfg) => {
              setPageConfig(newCfg)
              pageConfigRef.current = newCfg
              repaginate()
            }}
            onToggleSidebar={() => setSidebarOpen(o => !o)}
            sidebarOpen={sidebarOpen}
            onToggleWorkspace={() => setWorkspaceOpen(o => !o)}
            workspaceOpen={workspaceOpen}
            onOpenServerFile={openServerFileModal}
            onSaveServerFile={openSaveFileModal}
            onImportDocx={handleImportFile}
            onExportDocx={handleExportDocx}
            onInsertImage={handleInsertImage}
            onToggleFullscreen={() => { void handleToggleFullscreen() }}
            isFullscreen={isFullscreen}
            onAddComment={handleStartAddComment}
            onOpenTemplates={() => setTemplateManagerOpen(true)}
          />
        </div>

        {/* Add comment dialog */}
        {addCommentAnchor && (
          <AddCommentDialog
            anchorRect={addCommentAnchor}
            onConfirm={handleConfirmAddComment}
            onCancel={closeAddCommentDialog}
          />
        )}

        {/* Main content */}
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-visible" style={{ paddingTop: 32, paddingBottom: 32 }}>
          {/*
        Canvas: explicit height so absolute page cards create scroll space.
        Width = page width, centered.

        Layout layers (bottom → top):
          1. White page cards  (absolute, pointer-events:none, z-index:0)
          2. ProseMirror editor (absolute, z-index:1, top=marginTop, left=marginLeft)
             Inside the editor, transparent widgets push content between cards.
      */}
          <div
            ref={canvasRef}
            className="relative mx-auto"
            style={{ width: cfg.pageWidth, height: canvasH, overflow: 'visible' }}
          >
            {/* ── Layer 1: page cards ── */}
            {Array.from({ length: pageCount }).map((_, i) => (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  top: i * (cfg.pageHeight + PAGE_GAP),
                  left: 0,
                  width: cfg.pageWidth,
                  height: cfg.pageHeight,
                  background: 'white',
                  boxShadow: '0 2px 12px rgba(0,0,0,0.18)',
                  pointerEvents: 'none',
                  zIndex: 0,
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    bottom: 12,
                    width: '100%',
                    textAlign: 'center',
                    fontSize: 12,
                    color: '#aaa',
                    userSelect: 'none',
                  }}
                >
                  {i + 1} / {pageCount}
                </div>
              </div>
            ))}

            {/* ── Layer 2: Pretext page renderer ── */}
            {pretextVisualActive && layoutResult && (
              <PretextPageRenderer
                pages={layoutResult.renderedPages}
                pageConfig={cfg}
                pageGap={PAGE_GAP}
                caretPos={editorState?.selection.head ?? null}
                selectionFrom={editorState?.selection.from ?? null}
                selectionTo={editorState?.selection.to ?? null}
                selectedNodePos={selectedNodePos}
                showCaret={!visualCaretRect && editorFocused && Boolean(editorState?.selection.empty)}
                showSelection={editorFocused && Boolean(editorState && !editorState.selection.empty)}
                onRequestCaretPos={handleRequestCaretPos}
                onRequestSelectionRange={handleRequestSelectionRange}
                onRequestNodeSelection={handleRequestNodeSelection}
              />
            )}

            {/* ── Layer 3: ProseMirror editor ── */}
            <div
              ref={mountRef}
              className={pretextVisualActive ? 'pretext-driving-editor' : undefined}
              style={{
                position: 'absolute',
                top: cfg.marginTop,
                left: cfg.marginLeft,
                right: cfg.marginRight,
                ['--docx-letter-spacing' as string]: `${docxLetterSpacingPx}px`,
                zIndex: 2,
              }}
            />

            {pretextVisualActive && visualCaretRect && editorFocused && editorState?.selection.empty && (
              <div
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  left: visualCaretRect.left,
                  top: visualCaretRect.top,
                  width: 1.5,
                  height: visualCaretRect.height,
                  background: '#111',
                  borderRadius: 1,
                  zIndex: 4,
                  pointerEvents: 'none',
                  animation: 'openwps-caret-blink 1.05s steps(1) infinite',
                }}
              />
            )}

            <CommentSidebar
              comments={visibleComments}
              pageWidth={cfg.pageWidth}
              canvasHeight={canvasH}
              activeCommentId={activeComment?.id ?? null}
              onActivate={(id) => {
                const matchedComment = visibleComments.find((comment) => comment.id === id)
                if (matchedComment) {
                  setActiveComment(matchedComment)
                }
              }}
              onDelete={handleDeleteComment}
              onResolve={handleResolveComment}
            />
          </div>
          {/* end canvas */}
        </div>
        {/* end main content */}
      </div>
      {/* end left column */}

      {/* AI Sidebar — outside left column, full height */}
      {sidebarOpen && (
        <AISidebar
          view={view}
          editorState={editorState}
          pageConfig={pageConfig}
          templates={templates}
          activeTemplate={activeTemplate}
          onModelContextChange={(next) => {
            setCurrentAIProviderId(next.providerId)
            setCurrentAIModel(next.model)
          }}
          onActivateTemplate={activateTemplate}
          onOpenTemplateManager={() => setTemplateManagerOpen(true)}
          onPageConfigChange={(newCfg) => {
            setPageConfig(newCfg)
            pageConfigRef.current = newCfg
            repaginate()
          }}
          onDocumentStyleMutation={clearImportedDocxCompatibility}
          onClose={() => setSidebarOpen(false)}
        />
      )}

      {/* Settings gear button (bottom-left) */}
      <button
        onClick={() => setSettingsOpen(true)}
        className="fixed bottom-4 left-4 z-20 w-9 h-9 flex items-center justify-center bg-white border border-gray-300 rounded-full shadow hover:bg-gray-50 text-lg"
        title={`设置${currentDocumentName ? ` · 当前文件：${currentDocumentName}` : ''}`}
      >
        ⚙️
      </button>

      {fileModalMode && (
        <FileManagerModal
          mode={fileModalMode}
          files={documentFiles}
          loading={documentFilesLoading}
          error={documentFilesError}
          settings={documentSettings}
          settingsSaving={documentSettingsSaving}
          initialName={currentDocumentName || DEFAULT_SERVER_DOCUMENT_NAME}
          onClose={() => setFileModalMode(null)}
          onOpen={handleOpenDocument}
          onSave={handleSaveDocument}
          onDelete={handleDeleteDocument}
          onRefresh={async () => { await loadDocumentFiles(documentSettings.activeSource) }}
          onChangeSource={handleChangeDocumentSource}
          onUpdateWpsDirectory={handleUpdateWpsDirectory}
        />
      )}

      {templateManagerOpen && (
        <TemplateManagerModal
          templates={templates}
          activeTemplateId={activeTemplate?.id ?? null}
          activeTemplate={activeTemplate}
          extractionState={templateExtractionState}
          isExtracting={isTemplateExtractionRunning}
          onClose={() => setTemplateManagerOpen(false)}
          onUpload={handleUploadTemplate}
          onLoadDetail={loadTemplateDetail}
          onActivate={activateTemplate}
          onDelete={handleDeleteTemplate}
          onRename={handleRenameTemplate}
        />
      )}

      {templateNotice && (
        <div className="fixed top-4 right-4 z-[60] w-[360px] max-w-[calc(100vw-2rem)] rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 shadow-2xl backdrop-blur">
          <div className="flex items-start gap-3">
            <div className={`mt-0.5 h-2.5 w-2.5 rounded-full ${templateNotice.kind === 'success' ? 'bg-emerald-500' : 'bg-red-500'}`} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-slate-800">{templateNotice.title}</div>
              <div className="mt-1 text-xs leading-5 text-slate-600">{templateNotice.message}</div>
              <button
                type="button"
                onClick={() => {
                  setTemplateNotice(null)
                  setTemplateManagerOpen(true)
                }}
                className="mt-2 text-xs font-medium text-blue-600 hover:text-blue-700"
              >
                打开模板库
              </button>
            </div>
            <button
              type="button"
              onClick={() => setTemplateNotice(null)}
              className="text-slate-400 hover:text-slate-600"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {/* Settings modal */}
      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}
