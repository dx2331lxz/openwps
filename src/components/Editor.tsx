import React, { useEffect, useRef, useState, useCallback } from 'react'
import { Check, X } from 'lucide-react'
import { EditorState, NodeSelection, Plugin, Selection, TextSelection } from 'prosemirror-state'
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view'
import { DOMParser as PMDOMParser, type Node as PMNode } from 'prosemirror-model'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap } from 'prosemirror-commands'
import { history, undo, redo } from 'prosemirror-history'
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  goToNextCell,
  isInTable,
  tableEditing,
} from 'prosemirror-tables'
import { schema } from '../editor/schema'
import { createImageNodeViewFactory } from '../editor/imageNodeView'
import {
  paginate,
  DEFAULT_PAGE_CONFIG,
  type PageConfig,
  type PaginateResult,
  type DomBlockMetric,
} from '../layout/paginator'
import { Toolbar, type AICopilotActivity } from './Toolbar'
import AISidebar from './AISidebar'
import WorkspacePanel from './WorkspacePanel'
import FileManagerModal from './FileManagerModal'
import type { DocumentFileSummary, DocumentSettings, DocumentSource } from './FileManagerModal'
import SettingsModal from './SettingsModal'
import { importDocx, type PMNodeJSON } from '../docx/importer'
import { buildDocxBlob, exportDocx, type DocxExportOptions } from '../docx/exporter'
import { DEFAULT_EDITOR_FONT_STACK, FONT_STACKS } from '../fonts'
import { markdownToDocument } from '../markdown/importer'
import { PretextPageRenderer } from './PretextPageRenderer'
import { BlockControls, type BlockDescriptor, type BlockKind, type BlockTableCommand } from './BlockControls'
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
const EDITOR_DRAFT_STORAGE_KEY = 'openwps.editor.draft.v1'
const EDITOR_DRAFT_VERSION = 1
const EDITOR_DRAFT_SAVE_DELAY_MS = 500
const SERVER_DOCUMENT_SYNC_DELAY_MS = 800

function createDocumentClientId() {
  const randomId = globalThis.crypto?.randomUUID?.()
  return `editor_${randomId ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`
}

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

interface EditorDraftSnapshot {
  version: 1
  savedAt: string
  currentDocumentName: string
  activeSource: DocumentSource
  pageConfig: PageConfig
  docxExportOptions: DocxExportOptions
  docxLetterSpacingPx: number
  doc: PMNodeJSON
  selection?: {
    from: number
    to: number
  }
}

interface BlockAIPopoverState {
  blockPos: number
  rect: {
    left: number
    top: number
    width: number
    height: number
  }
  instruction: string
  loading: boolean
  error: string | null
}

interface AICopilotContext {
  anchor: number
  cursorPos: number
  prefixText: string
  suffixText: string
  paragraphText: string
  previousParagraphText: string
  nextParagraphText: string
  wordCount: number
  pageCount: number
  paragraphCount: number
  maxChars: number
  doc: PMNode
  docTextFingerprint: string
}

interface AICopilotPreview {
  anchor: number
  completions: string[]
  activeIndex: number
  doc: PMNode
  docTextFingerprint: string
}

type AICopilotState =
  | { status: 'idle' }
  | { status: 'loading'; anchor: number }
  | { status: 'preview'; preview: AICopilotPreview }
  | { status: 'error'; message: string }

interface AICopilotCompletionResponse {
  completion?: string
  completions?: string[]
  model?: string
}

type WpsParagraphStyleLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

const AI_COPILOT_STORAGE_KEY = 'openwps.aiCopilot.enabled'
const AI_COPILOT_ACTIVITY_STORAGE_KEY = 'openwps.aiCopilot.activity'
const AI_COPILOT_CANDIDATE_COUNT_STORAGE_KEY = 'openwps.aiCopilot.candidateCount'
const AI_COPILOT_DEBOUNCE_MS = 800
const AI_COPILOT_MAX_CHARS = 80

const WPS_PARAGRAPH_STYLES: Record<WpsParagraphStyleLevel, {
  headingLevel: WpsParagraphStyleLevel
  fontSizeHint: number | null
  fontFamilyHint: string | null
  lineHeight: number
  spaceBefore: number
  spaceAfter: number
  bold: boolean
}> = {
  0: {
    headingLevel: 0,
    fontSizeHint: null,
    fontFamilyHint: DEFAULT_EDITOR_FONT_STACK,
    lineHeight: 1.5,
    spaceBefore: 0,
    spaceAfter: 0,
    bold: false,
  },
  1: {
    headingLevel: 1,
    fontSizeHint: 22,
    fontFamilyHint: FONT_STACKS.hei,
    lineHeight: 1.3,
    spaceBefore: 12,
    spaceAfter: 6,
    bold: true,
  },
  2: {
    headingLevel: 2,
    fontSizeHint: 18,
    fontFamilyHint: FONT_STACKS.hei,
    lineHeight: 1.3,
    spaceBefore: 9,
    spaceAfter: 4,
    bold: true,
  },
  3: {
    headingLevel: 3,
    fontSizeHint: 16,
    fontFamilyHint: FONT_STACKS.hei,
    lineHeight: 1.35,
    spaceBefore: 6,
    spaceAfter: 3,
    bold: true,
  },
  4: {
    headingLevel: 4,
    fontSizeHint: 14,
    fontFamilyHint: FONT_STACKS.hei,
    lineHeight: 1.35,
    spaceBefore: 5,
    spaceAfter: 2,
    bold: true,
  },
  5: {
    headingLevel: 5,
    fontSizeHint: 12,
    fontFamilyHint: FONT_STACKS.hei,
    lineHeight: 1.4,
    spaceBefore: 4,
    spaceAfter: 2,
    bold: true,
  },
  6: {
    headingLevel: 6,
    fontSizeHint: 10.5,
    fontFamilyHint: FONT_STACKS.hei,
    lineHeight: 1.4,
    spaceBefore: 3,
    spaceAfter: 2,
    bold: true,
  },
  7: {
    headingLevel: 7,
    fontSizeHint: 10.5,
    fontFamilyHint: FONT_STACKS.song,
    lineHeight: 1.4,
    spaceBefore: 3,
    spaceAfter: 1,
    bold: true,
  },
  8: {
    headingLevel: 8,
    fontSizeHint: 9,
    fontFamilyHint: FONT_STACKS.song,
    lineHeight: 1.4,
    spaceBefore: 2,
    spaceAfter: 1,
    bold: true,
  },
  9: {
    headingLevel: 9,
    fontSizeHint: 9,
    fontFamilyHint: FONT_STACKS.song,
    lineHeight: 1.4,
    spaceBefore: 2,
    spaceAfter: 0,
    bold: false,
  },
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

function buildDocumentNameFromTitle(title: string, currentName: string) {
  const trimmed = title.trim()
  if (!trimmed) return currentName || DEFAULT_SERVER_DOCUMENT_NAME
  const fileName = trimmed.split(/[\\/]/).pop() || trimmed
  if (/\.(docx|doc|md|markdown|txt)$/i.test(fileName)) return fileName
  const extension = currentName.match(/\.(docx|doc|md|markdown|txt)$/i)?.[0] ?? '.docx'
  return `${fileName}${extension}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeDocumentSource(value: unknown): DocumentSource {
  return value === 'wps_directory' ? 'wps_directory' : 'internal'
}

function normalizePageConfig(value: unknown): PageConfig {
  if (!isRecord(value)) return DEFAULT_PAGE_CONFIG
  return {
    pageWidth: typeof value.pageWidth === 'number' ? value.pageWidth : DEFAULT_PAGE_CONFIG.pageWidth,
    pageHeight: typeof value.pageHeight === 'number' ? value.pageHeight : DEFAULT_PAGE_CONFIG.pageHeight,
    marginTop: typeof value.marginTop === 'number' ? value.marginTop : DEFAULT_PAGE_CONFIG.marginTop,
    marginBottom: typeof value.marginBottom === 'number' ? value.marginBottom : DEFAULT_PAGE_CONFIG.marginBottom,
    marginLeft: typeof value.marginLeft === 'number' ? value.marginLeft : DEFAULT_PAGE_CONFIG.marginLeft,
    marginRight: typeof value.marginRight === 'number' ? value.marginRight : DEFAULT_PAGE_CONFIG.marginRight,
  }
}

function createDefaultEditorDoc() {
  const div = document.createElement('div')
  div.innerHTML = '<p>开始输入文字，当内容超过一页高度时将自动出现第二张 A4 白纸...</p>'
  return PMDOMParser.fromSchema(schema).parse(div)
}

function createBlankEditorDoc() {
  return schema.nodes.doc.create(null, schema.nodes.paragraph.create())
}

function buildUntitledDocumentName(existingNames: string[]) {
  const existing = new Set(existingNames.map(name => name.trim().toLowerCase()))
  const base = '新建文档'
  const first = `${base}.docx`
  if (!existing.has(first.toLowerCase())) return first

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base} ${index}.docx`
    if (!existing.has(candidate.toLowerCase())) return candidate
  }

  const timestamp = new Date()
    .toISOString()
    .replace(/[:T]/g, '-')
    .replace(/\..+$/, '')
  return `${base} ${timestamp}.docx`
}

function readEditorDraftSnapshot(): EditorDraftSnapshot | null {
  if (typeof window === 'undefined') return null
  const raw = window.localStorage.getItem(EDITOR_DRAFT_STORAGE_KEY)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed) || parsed.version !== EDITOR_DRAFT_VERSION) throw new Error('unsupported draft version')
    if (!isRecord(parsed.doc) || typeof parsed.doc.type !== 'string') throw new Error('invalid draft doc')
    schema.nodeFromJSON(parsed.doc)

    const selection = isRecord(parsed.selection)
      && typeof parsed.selection.from === 'number'
      && typeof parsed.selection.to === 'number'
      ? { from: parsed.selection.from, to: parsed.selection.to }
      : undefined

    return {
      version: 1,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date().toISOString(),
      currentDocumentName: typeof parsed.currentDocumentName === 'string' && parsed.currentDocumentName.trim()
        ? parsed.currentDocumentName
        : DEFAULT_SERVER_DOCUMENT_NAME,
      activeSource: normalizeDocumentSource(parsed.activeSource),
      pageConfig: normalizePageConfig(parsed.pageConfig),
      docxExportOptions: isRecord(parsed.docxExportOptions) ? parsed.docxExportOptions as DocxExportOptions : {},
      docxLetterSpacingPx: typeof parsed.docxLetterSpacingPx === 'number' ? parsed.docxLetterSpacingPx : 0,
      doc: parsed.doc as PMNodeJSON,
      selection,
    }
  } catch (error) {
    console.warn('[Editor] failed to restore editor draft, clearing snapshot', error)
    window.localStorage.removeItem(EDITOR_DRAFT_STORAGE_KEY)
    return null
  }
}

function writeEditorDraftSnapshot(snapshot: EditorDraftSnapshot) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(EDITOR_DRAFT_STORAGE_KEY, JSON.stringify(snapshot))
  } catch (error) {
    console.warn('[Editor] failed to save editor draft', error)
  }
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
.pretext-driving-editor .ProseMirror > p span {
  background-color: transparent !important;
}
.pretext-driving-editor .ProseMirror ::selection,
.pretext-driving-editor .ProseMirror *::selection {
  background: transparent !important;
  color: transparent !important;
  -webkit-text-fill-color: transparent !important;
}
.pretext-driving-editor .ProseMirror table {
  visibility: hidden;
  pointer-events: none;
}
.pretext-driving-editor .ProseMirror img,
.pretext-driving-editor .ProseMirror [data-pm-image-wrapper] {
  color: #111827 !important;
  -webkit-text-fill-color: #111827 !important;
  text-decoration-color: currentColor !important;
  text-emphasis-color: currentColor !important;
  pointer-events: auto;
}
.ProseMirror [data-pm-image-wrapper],
.ProseMirror [data-pm-image-wrapper] * {
  caret-color: transparent !important;
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
    const rows = Array.from(element.querySelectorAll(':scope > tbody > tr, :scope > tr'))
    metrics.push({
      pos: offset,
      blockIndex,
      blockType: node.type.name,
      height: rect.height,
      marginTop: parseCssPx(style.marginTop),
      marginBottom: parseCssPx(style.marginBottom),
      table: {
        width: rect.width,
        rows: rows.map((row) => {
          const rowRect = row.getBoundingClientRect()
          const cells = Array.from(row.children).filter((cell): cell is HTMLElement => (
            cell instanceof HTMLElement && (cell.tagName === 'TD' || cell.tagName === 'TH')
          ))
          return {
            height: rowRect.height,
            cells: cells.map((cell) => {
              const cellRect = cell.getBoundingClientRect()
              return {
                width: cellRect.width,
                height: cellRect.height,
              }
            }),
          }
        }),
      },
    })
  })

  return metrics
}

function isPureImageParagraph(node: PMNode) {
  if (node.type.name !== 'paragraph') return false
  let imageCount = 0
  let hasOtherVisibleContent = false

  node.forEach((child) => {
    if (child.type.name === 'image') {
      imageCount += 1
      return
    }
    if (child.isText && !(child.text ?? '').trim()) return
    hasOtherVisibleContent = true
  })

  return imageCount === 1 && !hasOtherVisibleContent
}

function getBlockKind(node: PMNode): BlockKind {
  if (isPureImageParagraph(node)) return 'image'
  if (node.type.name === 'paragraph') return 'text'
  if (node.type.name === 'table') return 'table'
  if (node.type.name === 'table_of_contents') return 'table_of_contents'
  if (node.type.name === 'horizontal_rule') return 'horizontal_rule'
  return 'floating_object'
}

function getBlockTitle(kind: BlockKind) {
  switch (kind) {
    case 'image':
      return '图片块'
    case 'table':
      return '表格块'
    case 'table_of_contents':
      return '目录块'
    case 'horizontal_rule':
      return '分割线块'
    case 'floating_object':
      return '浮动对象块'
    default:
      return '文本块'
  }
}

function getTableStyleSummary(tableNode: PMNode): BlockDescriptor['tableStyle'] {
  let result: BlockDescriptor['tableStyle'] | undefined

  tableNode.descendants((node) => {
    if (result || node.type.name !== 'table_cell') return true
    result = {
      backgroundColor: String(node.attrs.backgroundColor ?? ''),
      borderColor: String(node.attrs.borderColor ?? '#cccccc') || '#cccccc',
      borderWidth: Number(node.attrs.borderWidth ?? 1),
    }
    return false
  })

  return result ?? {
    backgroundColor: '',
    borderColor: '#cccccc',
    borderWidth: 1,
  }
}

function mergeBlockRect(
  map: Map<string, { pos: number; pageIndex: number; left: number; top: number; right: number; bottom: number }>,
  pos: number,
  pageIndex: number,
  rect: { left: number; top: number; width: number; height: number },
) {
  const key = `${pos}:${pageIndex}`
  const existing = map.get(key)
  const right = rect.left + rect.width
  const bottom = rect.top + rect.height

  if (!existing) {
    map.set(key, {
      pos,
      pageIndex,
      left: rect.left,
      top: rect.top,
      right,
      bottom,
    })
    return
  }

  existing.left = Math.min(existing.left, rect.left)
  existing.top = Math.min(existing.top, rect.top)
  existing.right = Math.max(existing.right, right)
  existing.bottom = Math.max(existing.bottom, bottom)
}

function buildBlockRectMap(layout: PaginateResult, pageConfig: PageConfig) {
  const rectMap = new Map<string, { pos: number; pageIndex: number; left: number; top: number; right: number; bottom: number }>()
  const contentWidth = pageConfig.pageWidth - pageConfig.marginLeft - pageConfig.marginRight

  layout.renderedPages.forEach((page, pageIndex) => {
    const pageTop = pageIndex * (pageConfig.pageHeight + PAGE_GAP)

    page.lines.forEach((line) => {
      mergeBlockRect(rectMap, line.blockPos, pageIndex, {
        left: pageConfig.marginLeft,
        top: pageTop + pageConfig.marginTop + line.top,
        width: contentWidth,
        height: Math.max(1, line.lineHeight),
      })
    })

    page.floatingObjects.forEach((object) => {
      mergeBlockRect(rectMap, object.blockPos, pageIndex, {
        left: object.left,
        top: pageTop + object.top,
        width: Math.max(1, object.width),
        height: Math.max(1, object.height),
      })
    })
  })

  const grouped = new Map<number, BlockDescriptor['rects']>()
  rectMap.forEach((rect) => {
    const rects = grouped.get(rect.pos) ?? []
    rects.push({
      pageIndex: rect.pageIndex,
      left: rect.left,
      top: rect.top,
      width: Math.max(1, rect.right - rect.left),
      height: Math.max(1, rect.bottom - rect.top),
    })
    grouped.set(rect.pos, rects)
  })

  grouped.forEach((rects) => {
    rects.sort((first, second) => first.pageIndex - second.pageIndex || first.top - second.top)
  })

  return grouped
}

function buildBlockDescriptors(
  state: EditorState | null,
  layout: PaginateResult | null,
  pageConfig: PageConfig,
): BlockDescriptor[] {
  if (!state || !layout) return []

  const rectMap = buildBlockRectMap(layout, pageConfig)
  const blocks: BlockDescriptor[] = []
  let paragraphIndex = 0

  state.doc.forEach((node, pos, blockIndex) => {
    const kind = getBlockKind(node)
    const currentParagraphIndex = node.type.name === 'paragraph' ? paragraphIndex : null
    if (node.type.name === 'paragraph') paragraphIndex += 1
    const rects = rectMap.get(pos) ?? []
    if (rects.length === 0) return

    blocks.push({
      blockIndex,
      pos,
      nodeSize: node.nodeSize,
      type: kind,
      nodeType: node.type.name,
      paragraphIndex: currentParagraphIndex,
      title: getBlockTitle(kind),
      rects,
      tableStyle: kind === 'table' ? getTableStyleSummary(node) : undefined,
      paragraphStyle: node.type.name === 'paragraph'
        ? {
          headingLevel: typeof node.attrs.headingLevel === 'number' ? node.attrs.headingLevel : null,
          align: node.attrs.align === 'center' || node.attrs.align === 'right' || node.attrs.align === 'justify' ? node.attrs.align : 'left',
          listType: node.attrs.listType === 'bullet' || node.attrs.listType === 'ordered' || node.attrs.listType === 'task' ? node.attrs.listType : 'none',
        }
        : undefined,
    })
  })

  return blocks
}

function serializeBlockText(node: PMNode) {
  if (node.type.name !== 'table') return node.textContent

  return node.content.content.map((rowNode) => (
    rowNode.content.content.map((cellNode) => cellNode.textContent.replace(/\s+/g, ' ').trim()).join('\t')
  )).join('\n')
}

function getFirstParagraphTextPosInBlock(blockNode: PMNode, blockPos: number) {
  let found: number | null = null
  blockNode.descendants((node, relativePos) => {
    if (found != null || node.type.name !== 'paragraph') return true
    found = blockPos + 1 + relativePos + 1
    return false
  })
  return found
}

function getTopLevelSelectionBlockPos(state: EditorState) {
  if (state.selection instanceof NodeSelection) return state.selection.from
  const { $from } = state.selection
  return $from.depth >= 1 ? $from.before(1) : null
}

function getBlockByPos(blocks: BlockDescriptor[], pos: number | null) {
  return pos == null ? null : blocks.find((block) => block.pos === pos) ?? null
}

function getBlockAIAnchorRect(block: BlockDescriptor) {
  if (block.rects.length === 0) return null
  const first = block.rects[0]!
  const last = block.rects[block.rects.length - 1]!
  return {
    left: first.left,
    top: last.top + last.height + 8,
    width: Math.max(320, first.width),
    height: 0,
  }
}

function stripAIReply(text: string) {
  return text
    .replace(/^```(?:\w+)?\s*/u, '')
    .replace(/\s*```$/u, '')
    .trim()
}

function getInitialAICopilotEnabled() {
  try {
    return window.localStorage.getItem(AI_COPILOT_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function getInitialAICopilotActivity(): AICopilotActivity {
  try {
    const value = window.localStorage.getItem(AI_COPILOT_ACTIVITY_STORAGE_KEY)
    return value === 'conservative' || value === 'active' ? value : 'standard'
  } catch {
    return 'standard'
  }
}

function getInitialAICopilotCandidateCount() {
  try {
    const value = Number(window.localStorage.getItem(AI_COPILOT_CANDIDATE_COUNT_STORAGE_KEY) || 1)
    return Math.max(1, Math.min(Number.isFinite(value) ? Math.round(value) : 1, 3))
  } catch {
    return 1
  }
}

function getActiveAICopilotCompletion(preview: AICopilotPreview) {
  return preview.completions[preview.activeIndex] ?? preview.completions[0] ?? ''
}

function sanitizeAICopilotCompletion(text: string, context: AICopilotContext) {
  let cleaned = text
    .replace(/^```(?:\w+)?\s*/u, '')
    .replace(/\s*```$/u, '')
    .replace(/^(?:补全|续写|建议|输出|回答)[:：]\s*/u, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const prefixTail = context.prefixText.trim().slice(-80)
  if (prefixTail && cleaned.startsWith(prefixTail)) {
    cleaned = cleaned.slice(prefixTail.length).trimStart()
  }

  const suffixHead = context.suffixText.trim().slice(0, 80)
  if (suffixHead && cleaned.endsWith(suffixHead)) {
    cleaned = cleaned.slice(0, -suffixHead.length).trimEnd()
  }

  const sentenceMatch = cleaned.match(new RegExp(`^[\\s\\S]{1,${AI_COPILOT_MAX_CHARS}}?[。！？!?；;]`, 'u'))
  if (sentenceMatch) cleaned = sentenceMatch[0]
  else if (cleaned.length > AI_COPILOT_MAX_CHARS) cleaned = cleaned.slice(0, AI_COPILOT_MAX_CHARS).trimEnd()

  return cleaned
}

function getPlainTextBetween(doc: PMNode, from: number, to: number) {
  if (to <= from) return ''
  return doc.textBetween(from, to, '\n', '\n')
}

function getAICopilotDocTextFingerprint(doc: PMNode) {
  return doc.textBetween(0, doc.content.size, '\n', '\n')
}

function buildAICopilotContext(state: EditorState, pageCount: number): AICopilotContext | null {
  if (!state.selection.empty) return null
  if (isInTable(state)) return null

  const { $from } = state.selection
  if ($from.depth !== 1 || $from.parent.type.name !== 'paragraph') return null
  if ($from.nodeBefore?.type.name === 'image' || $from.nodeAfter?.type.name === 'image') return null

  const paragraphPos = $from.before(1)
  const paragraph = $from.parent
  let hasInlineAtom = false
  paragraph.forEach((child) => {
    if (!child.isText && child.type.name !== 'hard_break') hasInlineAtom = true
  })
  if (hasInlineAtom) return null

  const paragraphStart = paragraphPos + 1
  const paragraphEnd = paragraphPos + paragraph.nodeSize - 1
  const prefixText = getPlainTextBetween(state.doc, paragraphStart, state.selection.from)
  const suffixText = getPlainTextBetween(state.doc, state.selection.from, paragraphEnd)
  const paragraphText = paragraph.textContent

  let currentParagraphIndex = -1
  let paragraphCount = 0
  const paragraphs: string[] = []
  state.doc.forEach((node, pos) => {
    if (node.type.name !== 'paragraph') return
    if (pos === paragraphPos) currentParagraphIndex = paragraphCount
    paragraphs.push(node.textContent)
    paragraphCount += 1
  })

  const previousParagraphText = currentParagraphIndex > 0 ? paragraphs[currentParagraphIndex - 1] ?? '' : ''
  const nextParagraphText = currentParagraphIndex >= 0 ? paragraphs[currentParagraphIndex + 1] ?? '' : ''
  const wordCount = state.doc.textContent.replace(/\s+/g, '').length

  if (!prefixText.trim() && !previousParagraphText.trim() && !paragraphText.trim()) return null

  return {
    anchor: state.selection.from,
    cursorPos: state.selection.from,
    prefixText,
    suffixText,
    paragraphText,
    previousParagraphText,
    nextParagraphText,
    wordCount,
    pageCount,
    paragraphCount,
    maxChars: AI_COPILOT_MAX_CHARS,
    doc: state.doc,
    docTextFingerprint: getAICopilotDocTextFingerprint(state.doc),
  }
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
  const resolvedFrom = Math.max(1, from)
  const resolvedTo = Math.min(state.doc.nodeSize - 1, to)
  if (resolvedFrom >= resolvedTo) return false
  const { tr, doc } = state
  let isActive = false
  let existing: Record<string, unknown> = {}
  doc.nodesBetween(resolvedFrom, resolvedTo, (node) => {
    if (node.isText) {
      const mark = node.marks.find((m) => m.type === schema.marks.textStyle)
      if (mark) {
        if (mark.attrs[attr]) isActive = true
        existing = { ...mark.attrs }
      }
    }
  })
  dispatch(tr.addMark(resolvedFrom, resolvedTo, schema.marks.textStyle.create({ ...existing, [attr]: !isActive })))
  return true
}

function BlockAIPopover({
  state,
  onChange,
  onClose,
  onSubmit,
}: {
  state: BlockAIPopoverState
  onChange: (instruction: string) => void
  onClose: () => void
  onSubmit: () => void
}) {
  return (
    <div
      data-openwps-block-ai-popover="true"
      onMouseDown={(event) => {
        event.stopPropagation()
      }}
      style={{
        position: 'absolute',
        left: Math.max(8, state.rect.left),
        top: state.rect.top,
        width: Math.min(420, Math.max(320, state.rect.width)),
        padding: 10,
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        background: 'rgba(255,255,255,0.98)',
        boxShadow: '0 18px 38px rgba(15, 23, 42, 0.18)',
        zIndex: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>WPS AI</span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          aria-label="关闭块 AI"
          onClick={onClose}
          style={{
            width: 24,
            height: 24,
            border: '1px solid transparent',
            borderRadius: 6,
            background: 'transparent',
            cursor: 'pointer',
            fontSize: 16,
            lineHeight: '20px',
          }}
        >
          ×
        </button>
      </div>
      <textarea
        autoFocus
        data-openwps-block-ai-input="true"
        value={state.instruction}
        onChange={(event) => onChange(event.target.value)}
        placeholder="润色、扩写、缩短或改成更正式的语气"
        disabled={state.loading}
        style={{
          width: '100%',
          minHeight: 76,
          marginTop: 8,
          padding: '8px 10px',
          border: '1px solid #d1d5db',
          borderRadius: 7,
          resize: 'vertical',
          fontSize: 13,
          lineHeight: 1.5,
          boxSizing: 'border-box',
          outline: 'none',
        }}
      />
      {state.error && (
        <div style={{ marginTop: 6, color: '#dc2626', fontSize: 12 }}>{state.error}</div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
        <button
          type="button"
          onClick={() => onChange('润色这段文字，保持原意。')}
          disabled={state.loading}
          style={blockAISecondaryButtonStyle}
        >
          润色
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={state.loading}
          style={blockAIPrimaryButtonStyle}
        >
          {state.loading ? '生成中' : '替换块'}
        </button>
      </div>
    </div>
  )
}

const blockAISecondaryButtonStyle: React.CSSProperties = {
  height: 30,
  padding: '0 10px',
  border: '1px solid #d1d5db',
  borderRadius: 6,
  background: '#ffffff',
  color: '#374151',
  fontSize: 13,
  cursor: 'pointer',
}

const blockAIPrimaryButtonStyle: React.CSSProperties = {
  height: 30,
  padding: '0 12px',
  border: '1px solid #2563eb',
  borderRadius: 6,
  background: '#2563eb',
  color: '#ffffff',
  fontSize: 13,
  fontWeight: 700,
  cursor: 'pointer',
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
    listChecked: !paragraph.node.attrs.listChecked,
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

function initState(initial?: { doc?: PMNodeJSON; selection?: { from: number; to: number } }): EditorState {
  let doc = createDefaultEditorDoc()
  if (initial?.doc) {
    try {
      doc = schema.nodeFromJSON(initial.doc)
    } catch (error) {
      console.warn('[Editor] failed to create editor state from draft doc', error)
      window.localStorage.removeItem(EDITOR_DRAFT_STORAGE_KEY)
    }
  }
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

  const state = EditorState.create({
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

  if (!initial?.selection) return state

  try {
    const maxPos = state.doc.content.size
    const from = Math.max(0, Math.min(initial.selection.from, maxPos))
    const to = Math.max(from, Math.min(initial.selection.to, maxPos))
    const nextSelection = from === to
      ? Selection.near(state.doc.resolve(from))
      : TextSelection.create(state.doc, from, to)
    return state.apply(state.tr.setSelection(nextSelection))
  } catch {
    return state
  }
}

// ─── Editor component ─────────────────────────────────────────────────────────
export const Editor: React.FC = () => {
  const [initialDraft] = useState<EditorDraftSnapshot | null>(() => readEditorDraftSnapshot())
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
  const [pageConfig, setPageConfig] = useState<PageConfig>(initialDraft?.pageConfig ?? DEFAULT_PAGE_CONFIG)
  const pageConfigRef = useRef<PageConfig>(initialDraft?.pageConfig ?? DEFAULT_PAGE_CONFIG)
  const docxExportOptionsRef = useRef<DocxExportOptions>(initialDraft?.docxExportOptions ?? {})
  const [pageCount, setPageCount] = useState(1)
  const [layoutResult, setLayoutResult] = useState<PaginateResult | null>(null)
  const layoutResultRef = useRef<PaginateResult | null>(null)
  const [selectedBlockPos, setSelectedBlockPos] = useState<number | null>(null)
  const [blockAIPopover, setBlockAIPopover] = useState<BlockAIPopoverState | null>(null)
  const [layoutSettling, setLayoutSettling] = useState(false)
  const [editorFocused, setEditorFocused] = useState(false)
  const editorFocusedRef = useRef(false)
  const [editorComposing, setEditorComposing] = useState(false)
  const [docxLetterSpacingPx, setDocxLetterSpacingPx] = useState(initialDraft?.docxLetterSpacingPx ?? 0)
  const docxLetterSpacingRef = useRef(initialDraft?.docxLetterSpacingPx ?? 0)
  const [documentFiles, setDocumentFiles] = useState<DocumentFileSummary[]>([])
  const [documentFilesLoading, setDocumentFilesLoading] = useState(false)
  const [documentFilesError, setDocumentFilesError] = useState<string | null>(null)
  const [documentSettings, setDocumentSettings] = useState<DocumentSettings>({
    ...DEFAULT_DOCUMENT_SETTINGS,
    activeSource: initialDraft?.activeSource ?? DEFAULT_DOCUMENT_SETTINGS.activeSource,
  })
  const [documentSettingsSaving, setDocumentSettingsSaving] = useState(false)
  const [currentDocumentName, setCurrentDocumentName] = useState(initialDraft?.currentDocumentName ?? DEFAULT_SERVER_DOCUMENT_NAME)
  const [templates, setTemplates] = useState<TemplateSummary[]>([])
  const [templateManagerOpen, setTemplateManagerOpen] = useState(false)
  const [activeTemplate, setActiveTemplate] = useState<TemplateRecord | null>(null)
  const [currentAIProviderId, setCurrentAIProviderId] = useState<string | null>(null)
  const [currentAIModel, setCurrentAIModel] = useState<string | null>(null)
  const [aiCopilotEnabled, setAiCopilotEnabled] = useState(getInitialAICopilotEnabled)
  const [aiCopilotActivity, setAiCopilotActivity] = useState<AICopilotActivity>(getInitialAICopilotActivity)
  const [aiCopilotCandidateCount, setAiCopilotCandidateCount] = useState(getInitialAICopilotCandidateCount)
  const [aiCopilotState, setAICopilotState] = useState<AICopilotState>({ status: 'idle' })
  const [templateExtractionState, setTemplateExtractionState] = useState<TemplateExtractionState>(IDLE_TEMPLATE_EXTRACTION_STATE)
  const [templateNotice, setTemplateNotice] = useState<TemplateNotice | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const templateManagerOpenRef = useRef(false)
  const aiCopilotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const aiCopilotAbortRef = useRef<AbortController | null>(null)
  const aiCopilotRequestIdRef = useRef(0)
  const aiCopilotPreviewRef = useRef<AICopilotPreview | null>(null)
  const aiCopilotEnabledRef = useRef(aiCopilotEnabled)
  const editorStateRef = useRef<EditorState | null>(null)
  const documentClientIdRef = useRef(createDocumentClientId())
  const documentSessionRef = useRef<{ id: string; version: number } | null>(null)
  const [documentSessionInfo, setDocumentSessionInfo] = useState<{ id: string; version: number } | null>(null)

  // ── Comment state ───────────────────────────────────────────────────────────
  const [activeComment, setActiveComment] = useState<CommentData | null>(null)
  const [addCommentAnchor, setAddCommentAnchor] = useState<DOMRect | null>(null)
  const [pendingCommentTarget, setPendingCommentTarget] = useState<PendingCommentTarget | null>(null)
  const [visibleComments, setVisibleComments] = useState<SidebarCommentData[]>([])
  const paginationRunRef = useRef(0)

  useEffect(() => { pageConfigRef.current = pageConfig }, [pageConfig])
  useEffect(() => { docxLetterSpacingRef.current = docxLetterSpacingPx }, [docxLetterSpacingPx])
  useEffect(() => { templateManagerOpenRef.current = templateManagerOpen }, [templateManagerOpen])
  useEffect(() => { aiCopilotEnabledRef.current = aiCopilotEnabled }, [aiCopilotEnabled])
  useEffect(() => { editorStateRef.current = editorState }, [editorState])
  useEffect(() => { editorFocusedRef.current = editorFocused }, [editorFocused])
  useEffect(() => {
    aiCopilotPreviewRef.current = aiCopilotState.status === 'preview' ? aiCopilotState.preview : null
  }, [aiCopilotState])

  const buildEditorDraftSnapshot = useCallback((): EditorDraftSnapshot | null => {
    const state = editorStateRef.current
    if (!state) return null
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      currentDocumentName,
      activeSource: documentSettings.activeSource,
      pageConfig,
      docxExportOptions: docxExportOptionsRef.current,
      docxLetterSpacingPx,
      doc: state.doc.toJSON() as PMNodeJSON,
      selection: {
        from: state.selection.from,
        to: state.selection.to,
      },
    }
  }, [currentDocumentName, documentSettings.activeSource, docxLetterSpacingPx, pageConfig])

  useEffect(() => {
    if (!editorState) return undefined
    const timer = window.setTimeout(() => {
      const snapshot = buildEditorDraftSnapshot()
      if (snapshot) writeEditorDraftSnapshot(snapshot)
    }, EDITOR_DRAFT_SAVE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [buildEditorDraftSnapshot, currentDocumentName, documentSettings.activeSource, docxLetterSpacingPx, editorState, pageConfig])

  useEffect(() => {
    const flushDraft = () => {
      const snapshot = buildEditorDraftSnapshot()
      if (snapshot) writeEditorDraftSnapshot(snapshot)
    }
    window.addEventListener('beforeunload', flushDraft)
    return () => window.removeEventListener('beforeunload', flushDraft)
  }, [buildEditorDraftSnapshot])

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

  const rememberDocumentSession = useCallback((next: { id: string; version: number } | null) => {
    documentSessionRef.current = next
    setDocumentSessionInfo(prev => {
      if (!next && !prev) return prev
      if (next && prev && prev.id === next.id && prev.version === next.version) return prev
      return next
    })
  }, [])

  const registerActiveDocumentSession = useCallback(async (sessionId: string) => {
    try {
      await fetch(`/api/doc-sessions/${sessionId}/active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: documentClientIdRef.current,
          currentDocumentName: currentDocumentName || undefined,
        }),
      })
    } catch (error) {
      console.warn('登记当前文档会话失败', error)
    }
  }, [currentDocumentName])

  const syncDocumentSession = useCallback(async () => {
    const currentState = editorStateRef.current
    if (!currentState) return
    const payload = {
      docJson: currentState.doc.toJSON() as PMNodeJSON,
      pageConfig: pageConfigRef.current,
      clientId: documentClientIdRef.current,
      currentDocumentName: currentDocumentName || undefined,
    }
    const createDocumentSession = async () => {
      const response = await fetch('/api/doc-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await readJsonResponse<{ documentSessionId?: string; version?: number }>(response)
      const id = String(data.documentSessionId || '')
      if (!id) throw new Error('后端未返回 documentSessionId')
      rememberDocumentSession({ id, version: Number(data.version ?? 1) || 1 })
      await registerActiveDocumentSession(id)
    }
    const current = documentSessionRef.current
    if (!current) {
      await createDocumentSession()
      return
    }

    const response = await fetch(`/api/doc-sessions/${current.id}/client-patches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, baseVersion: current.version }),
    })
    if (response.status === 404) {
      rememberDocumentSession(null)
      await createDocumentSession()
      return
    }
    if (response.status === 409) {
      const latest = await readJsonResponse<{ documentSessionId?: string; version?: number }>(
        await fetch(`/api/doc-sessions/${current.id}`),
      )
      rememberDocumentSession({
        id: current.id,
        version: Number(latest.version ?? current.version) || current.version,
      })
      return
    }
    const data = await readJsonResponse<{ version?: number }>(response)
    rememberDocumentSession({ id: current.id, version: Number(data.version ?? current.version + 1) || current.version + 1 })
    await registerActiveDocumentSession(current.id)
  }, [currentDocumentName, registerActiveDocumentSession, rememberDocumentSession])

  useEffect(() => {
    if (!editorState) return undefined
    const timer = window.setTimeout(() => {
      void syncDocumentSession().catch(error => {
        console.warn('同步当前文档会话失败', error)
      })
    }, SERVER_DOCUMENT_SYNC_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [currentDocumentName, editorState, pageConfig, syncDocumentSession])

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
    const sessionId = documentSessionInfo?.id
    if (!sessionId) return undefined
    const source = new EventSource(`/api/doc-sessions/${sessionId}/events`)
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as Record<string, unknown>
        if (data.type === 'snapshot') {
          const version = Number(data.version ?? documentSessionRef.current?.version ?? 1) || 1
          rememberDocumentSession({ id: sessionId, version })
          return
        }
        const eventVersion = typeof data.version === 'number' ? data.version : undefined
        if (eventVersion !== undefined && eventVersion <= (documentSessionRef.current?.version ?? 0)) return
        if (data.source === 'client_patch' && data.originClientId === documentClientIdRef.current) {
          if (eventVersion !== undefined) rememberDocumentSession({ id: sessionId, version: eventVersion })
          return
        }
        const nextDocJson = data.type === 'document_replace'
          && data.docJson
          && typeof data.docJson === 'object'
          && !Array.isArray(data.docJson)
          ? data.docJson as PMNodeJSON
          : null
        const nextPageConfig = data.type === 'page_config_changed'
          && data.pageConfig
          && typeof data.pageConfig === 'object'
          && !Array.isArray(data.pageConfig)
          ? data.pageConfig as PageConfig
          : null
        if (nextDocJson) {
          applyDocumentState(nextDocJson, nextPageConfig ?? pageConfigRef.current)
          clearImportedDocxCompatibility()
        } else if (nextPageConfig) {
          setPageConfig(nextPageConfig)
          pageConfigRef.current = nextPageConfig
          repaginate()
        }
        if (eventVersion !== undefined) rememberDocumentSession({ id: sessionId, version: eventVersion })
      } catch (error) {
        console.warn('解析当前文档会话事件失败', error)
      }
    }
    source.onerror = () => {
      console.warn('当前文档会话事件连接异常')
    }
    return () => source.close()
  }, [applyDocumentState, clearImportedDocxCompatibility, documentSessionInfo?.id, rememberDocumentSession, repaginate])

  const cancelAICopilot = useCallback(() => {
    if (aiCopilotTimerRef.current) {
      clearTimeout(aiCopilotTimerRef.current)
      aiCopilotTimerRef.current = null
    }
    aiCopilotAbortRef.current?.abort()
    aiCopilotAbortRef.current = null
    aiCopilotPreviewRef.current = null
    setAICopilotState({ status: 'idle' })
  }, [])

  const clearAICopilotTimer = useCallback(() => {
    if (aiCopilotTimerRef.current) {
      clearTimeout(aiCopilotTimerRef.current)
      aiCopilotTimerRef.current = null
    }
  }, [])

  const clearAICopilotPreview = useCallback(() => {
    aiCopilotPreviewRef.current = null
    setAICopilotState((current) => current.status === 'preview' ? { status: 'idle' } : current)
  }, [])

  const acceptAICopilot = useCallback((candidateIndex?: number) => {
    const editorView = viewRef.current
    const preview = aiCopilotPreviewRef.current
    const completion = preview
      ? typeof candidateIndex === 'number'
        ? preview.completions[candidateIndex] ?? ''
        : getActiveAICopilotCompletion(preview)
      : ''
    if (!editorView || !preview || !completion) return false

    const { state } = editorView
    if (!state.selection.empty || state.selection.from !== preview.anchor) return false
    if (getAICopilotDocTextFingerprint(state.doc) !== preview.docTextFingerprint) return false

    const tr = state.tr.insertText(completion, preview.anchor, preview.anchor)
    tr.setSelection(TextSelection.create(tr.doc, preview.anchor + completion.length))
    tr.setMeta('openwpsAiCopilot', true)
    editorView.dispatch(tr.scrollIntoView())
    editorView.focus()
    cancelAICopilot()
    return true
  }, [cancelAICopilot])

  const requestAICopilotCompletion = useCallback(async (context: AICopilotContext) => {
    aiCopilotAbortRef.current?.abort()
    const requestId = ++aiCopilotRequestIdRef.current
    const controller = new AbortController()
    aiCopilotAbortRef.current = controller
    setAICopilotState({ status: 'loading', anchor: context.anchor })

    try {
      let providerId = currentAIProviderId
      let model = currentAIModel
      if (!providerId || !model) {
        const settingsResponse = await fetch('/api/ai/settings', { signal: controller.signal })
        const settings = await readJsonResponse<AISettingsSnapshot>(settingsResponse)
        providerId = providerId || settings.activeProviderId || null
        model = model || settings.model || null
      }
      if (!providerId || !model) {
        throw new Error('当前 AI 未配置完成，请先在右侧 AI 面板选择服务商和模型。')
      }

      const response = await fetch('/api/ai/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          providerId,
          model,
          activity: aiCopilotActivity,
          candidateCount: aiCopilotCandidateCount,
          cursorPos: context.cursorPos,
          prefixText: context.prefixText,
          suffixText: context.suffixText,
          paragraphText: context.paragraphText,
          previousParagraphText: context.previousParagraphText,
          nextParagraphText: context.nextParagraphText,
          wordCount: context.wordCount,
          pageCount: context.pageCount,
          paragraphCount: context.paragraphCount,
          maxChars: context.maxChars,
        }),
      })
      const data = await readJsonResponse<AICopilotCompletionResponse>(response)
      if (requestId !== aiCopilotRequestIdRef.current || controller.signal.aborted) return

      const rawCompletions = Array.isArray(data.completions) && data.completions.length > 0
        ? data.completions
        : [data.completion ?? '']
      const seenCompletions = new Set<string>()
      const completions = rawCompletions
        .map((item) => sanitizeAICopilotCompletion(String(item ?? ''), context))
        .filter((item) => {
          if (!item || seenCompletions.has(item)) return false
          seenCompletions.add(item)
          return true
        })
      const currentView = viewRef.current
      if (
        completions.length === 0 ||
        !currentView ||
        getAICopilotDocTextFingerprint(currentView.state.doc) !== context.docTextFingerprint ||
        currentView.state.selection.from !== context.anchor ||
        !currentView.state.selection.empty
      ) {
        setAICopilotState({ status: 'idle' })
        return
      }

      const preview = {
        anchor: context.anchor,
        completions,
        activeIndex: 0,
        doc: context.doc,
        docTextFingerprint: context.docTextFingerprint,
      }
      aiCopilotPreviewRef.current = preview
      setAICopilotState({ status: 'preview', preview })
    } catch (error) {
      if (controller.signal.aborted) return
      setAICopilotState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      if (aiCopilotAbortRef.current === controller) aiCopilotAbortRef.current = null
    }
  }, [aiCopilotActivity, aiCopilotCandidateCount, currentAIModel, currentAIProviderId])

  useEffect(() => {
    if (!mountRef.current) return

    const styleEl = document.createElement('style')
    styleEl.textContent = PM_STYLES
    document.head.appendChild(styleEl)

    const state = initState(initialDraft ? {
      doc: initialDraft.doc,
      selection: initialDraft.selection,
    } : undefined)
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
          if (event.key === 'Tab' && acceptAICopilot()) {
            event.preventDefault()
            return true
          }
          if (event.key === 'Escape') {
            cancelAICopilot()
            return false
          }
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
          clearAICopilotTimer()
          return false
        },
        compositionstart: () => {
          setEditorComposing(true)
          clearAICopilotTimer()
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
        const previousTextFingerprint = getAICopilotDocTextFingerprint(editorView.state.doc)
        const next = editorView.state.apply(tx)
        editorView.updateState(next)
        setEditorState(next)
        if (tx.selectionSet && !tx.getMeta('openwpsBlockSelection')) {
          setSelectedBlockPos(null)
        }
        const textChanged = tx.docChanged && previousTextFingerprint !== getAICopilotDocTextFingerprint(next.doc)
        if (textChanged) {
          cancelAICopilot()
        }
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
  }, [acceptAICopilot, cancelAICopilot, clearAICopilotTimer, clearImportedDocxCompatibility, initialDraft, repaginate])

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

  const handleDocumentTitleChange = useCallback((title: string) => {
    setCurrentDocumentName(current => buildDocumentNameFromTitle(title, current))
  }, [])

  const handleNewDocument = useCallback(() => {
    const blankDoc = createBlankEditorDoc()
    applyDocumentState(blankDoc.toJSON() as PMNodeJSON, DEFAULT_PAGE_CONFIG)
    setCurrentDocumentName(buildUntitledDocumentName(documentFiles.map(file => file.name)))
    setSelectedBlockPos(null)
    setBlockAIPopover(null)
    setActiveComment(null)
    setAddCommentAnchor(null)
    setPendingCommentTarget(null)
    setVisibleComments([])
    setAICopilotState({ status: 'idle' })
    setTemplateNotice(null)
    window.setTimeout(() => {
      const editorView = viewRef.current
      if (!editorView) return
      const selection = TextSelection.create(editorView.state.doc, 1)
      editorView.dispatch(editorView.state.tr.setSelection(selection).scrollIntoView())
      editorView.focus()
    }, 0)
  }, [applyDocumentState, documentFiles])

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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
      event.preventDefault()
      if (event.repeat || fileModalMode) return
      const targetName = currentDocumentName.trim()
      if (targetName) {
        void handleSaveDocument(targetName)
      } else {
        void openSaveFileModal()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [currentDocumentName, fileModalMode, handleSaveDocument, openSaveFileModal])

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
  }, [buildCurrentDocxBlob])

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
      const insertPos = state.selection.$to.depth >= 1
        ? state.selection.$to.after(1)
        : state.selection.to
      const tr = state.tr.insert(insertPos, paragraphNode)
      tr.setSelection(TextSelection.create(tr.doc, insertPos + 1))
      tr.setMeta('openwpsBlockSelection', true)
      dispatch(tr.scrollIntoView())
      editorView.focus()
      setSelectedBlockPos(null)
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
    setSelectedBlockPos(null)

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
    setSelectedBlockPos(null)
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
    setSelectedBlockPos(clampedPos)
    setActiveComment(null)
    const selection = NodeSelection.create(editorView.state.doc, clampedPos)
    const tr = editorView.state.tr
      .setSelection(selection)
      .setMeta('addToHistory', false)
      .setMeta('openwpsBlockSelection', true)
    editorView.dispatch(tr)
  }, [])

  const handleSelectBlock = useCallback((block: BlockDescriptor) => {
    const editorView = viewRef.current
    if (!editorView) return

    const { state } = editorView
    const node = state.doc.nodeAt(block.pos)
    if (!node) return

    try {
      let selection: Selection
      if (node.type.name === 'paragraph') {
        const from = Math.min(block.pos + 1, state.doc.content.size)
        const to = Math.min(block.pos + node.nodeSize - 1, state.doc.content.size)
        selection = to > from
          ? TextSelection.create(state.doc, from, to)
          : TextSelection.create(state.doc, from)
      } else {
        selection = NodeSelection.create(state.doc, block.pos)
      }

      const tr = state.tr
        .setSelection(selection)
        .setMeta('addToHistory', false)
        .setMeta('openwpsBlockSelection', true)
      editorView.dispatch(tr)
      editorView.focus()
      setActiveComment(null)
      setSelectedBlockPos(block.pos)
    } catch {
      setSelectedBlockPos(block.pos)
    }
  }, [])

  const handleCopyBlock = useCallback((block: BlockDescriptor) => {
    const editorView = viewRef.current
    const node = editorView?.state.doc.nodeAt(block.pos)
    if (!node) return
    void navigator.clipboard?.writeText(serializeBlockText(node)).catch(() => undefined)
    handleSelectBlock(block)
  }, [handleSelectBlock])

  const handleDeleteBlock = useCallback((block: BlockDescriptor) => {
    const editorView = viewRef.current
    if (!editorView) return

    const { state } = editorView
    const node = state.doc.nodeAt(block.pos)
    if (!node) return

    let tr = state.tr.delete(block.pos, block.pos + node.nodeSize)
    if (tr.doc.childCount === 0) {
      tr = tr.insert(0, schema.nodes.paragraph.create())
    }

    const selectionPos = Math.max(0, Math.min(block.pos, tr.doc.content.size))
    tr.setSelection(Selection.near(tr.doc.resolve(selectionPos), 1))
    tr.setMeta('openwpsBlockSelection', true)
    editorView.dispatch(tr.scrollIntoView())
    editorView.focus()
    setSelectedBlockPos(null)
  }, [])

  const handleCutBlock = useCallback((block: BlockDescriptor) => {
    handleCopyBlock(block)
    handleDeleteBlock(block)
  }, [handleCopyBlock, handleDeleteBlock])

  const handleDuplicateBlock = useCallback((block: BlockDescriptor) => {
    const editorView = viewRef.current
    if (!editorView) return

    const { state } = editorView
    const node = state.doc.nodeAt(block.pos)
    if (!node) return

    const insertPos = block.pos + node.nodeSize
    const tr = state.tr.insert(insertPos, node.copy(node.content))
    const duplicatedPos = insertPos
    try {
      const selection = node.type.name === 'paragraph'
        ? TextSelection.create(tr.doc, Math.min(duplicatedPos + 1, tr.doc.content.size), Math.min(duplicatedPos + node.nodeSize - 1, tr.doc.content.size))
        : NodeSelection.create(tr.doc, duplicatedPos)
      tr.setSelection(selection)
    } catch {
      tr.setSelection(Selection.near(tr.doc.resolve(Math.min(duplicatedPos, tr.doc.content.size)), 1))
    }
    tr.setMeta('openwpsBlockSelection', true)
    editorView.dispatch(tr.scrollIntoView())
    editorView.focus()
    setSelectedBlockPos(duplicatedPos)
  }, [])

  const updateParagraphBlock = useCallback((
    block: BlockDescriptor,
    updater: (node: PMNode) => Record<string, unknown>,
  ) => {
    const editorView = viewRef.current
    if (!editorView) return
    const node = editorView.state.doc.nodeAt(block.pos)
    if (!node || node.type.name !== 'paragraph') return

    const tr = editorView.state.tr.setNodeMarkup(block.pos, undefined, updater(node))
    tr.setMeta('openwpsBlockSelection', true)
    editorView.dispatch(tr.scrollIntoView())
    editorView.focus()
    setSelectedBlockPos(block.pos)
  }, [])

  const handleSetParagraphRole = useCallback((block: BlockDescriptor, headingLevel: 0 | 1 | 2 | 3) => {
    const editorView = viewRef.current
    if (!editorView) return
    const node = editorView.state.doc.nodeAt(block.pos)
    if (!node || node.type.name !== 'paragraph') return

    const style = WPS_PARAGRAPH_STYLES[headingLevel]
    const from = block.pos + 1
    const to = block.pos + node.nodeSize - 1
    const tr = editorView.state.tr.setNodeMarkup(block.pos, undefined, {
      ...node.attrs,
      headingLevel: style.headingLevel === 0 ? null : style.headingLevel,
      fontSizeHint: style.fontSizeHint,
      fontFamilyHint: style.fontFamilyHint,
      lineHeight: style.lineHeight,
      spaceBefore: style.spaceBefore,
      spaceAfter: style.spaceAfter,
      listType: null,
      listLevel: 0,
      listChecked: false,
    })

    if (to > from) {
      tr.removeMark(from, to, schema.marks.textStyle)
      if (style.fontSizeHint || style.fontFamilyHint || style.bold) {
        tr.addMark(from, to, schema.marks.textStyle.create({
          fontFamily: style.fontFamilyHint ?? DEFAULT_EDITOR_FONT_STACK,
          fontSize: style.fontSizeHint ?? 12,
          bold: style.bold,
        }))
      }
    }

    tr.setSelection(to > from ? TextSelection.create(tr.doc, from, to) : TextSelection.create(tr.doc, from))
    tr.setMeta('openwpsBlockSelection', true)
    editorView.dispatch(tr.scrollIntoView())
    editorView.focus()
    setSelectedBlockPos(block.pos)
  }, [])

  const handleSetParagraphAlign = useCallback((
    block: BlockDescriptor,
    align: 'left' | 'center' | 'right' | 'justify',
  ) => {
    updateParagraphBlock(block, (node) => ({ ...node.attrs, align }))
  }, [updateParagraphBlock])

  const handleToggleParagraphList = useCallback((
    block: BlockDescriptor,
    listType: 'bullet' | 'ordered' | 'task',
  ) => {
    updateParagraphBlock(block, (node) => {
      const nextType = node.attrs.listType === listType ? null : listType
      return {
        ...node.attrs,
        listType: nextType,
        listChecked: nextType === 'task' ? Boolean(node.attrs.listChecked) : false,
      }
    })
  }, [updateParagraphBlock])

  const handleClearBlockFormatting = useCallback((block: BlockDescriptor) => {
    const editorView = viewRef.current
    if (!editorView) return
    const node = editorView.state.doc.nodeAt(block.pos)
    if (!node || node.type.name !== 'paragraph') return

    const from = block.pos + 1
    const to = block.pos + node.nodeSize - 1
    const tr = editorView.state.tr.removeMark(from, to, schema.marks.textStyle)
    tr.setNodeMarkup(block.pos, undefined, {
      ...node.attrs,
      align: 'left',
      firstLineIndent: 0,
      indent: 0,
      rightIndent: 0,
      headingLevel: null,
      fontSizeHint: null,
      fontFamilyHint: null,
      lineHeight: 1.5,
      spaceBefore: 0,
      spaceAfter: 0,
      listType: null,
      listLevel: 0,
      listChecked: false,
      pageBreakBefore: false,
    })
    tr.setMeta('openwpsBlockSelection', true)
    editorView.dispatch(tr.scrollIntoView())
    editorView.focus()
    setSelectedBlockPos(block.pos)
  }, [])

  const handleReplaceImageBlock = useCallback((block: BlockDescriptor, file: File) => {
    const editorView = viewRef.current
    if (!editorView) return

    const reader = new FileReader()
    reader.onload = (event) => {
      const src = event.target?.result
      if (typeof src !== 'string') return

      const { state } = editorView
      const paragraphNode = state.doc.nodeAt(block.pos)
      if (!paragraphNode || !isPureImageParagraph(paragraphNode)) return

      let imagePos: number | null = null
      paragraphNode.forEach((child, offset) => {
        if (imagePos == null && child.type.name === 'image') {
          imagePos = block.pos + 1 + offset
        }
      })
      if (imagePos == null) return

      const imageNode = state.doc.nodeAt(imagePos)
      if (!imageNode || imageNode.type.name !== 'image') return

      const tr = state.tr.setNodeMarkup(imagePos, undefined, {
        ...imageNode.attrs,
        src,
        alt: file.name,
        title: file.name,
        width: null,
        height: null,
      })
      tr.setMeta('openwpsBlockSelection', true)
      editorView.dispatch(tr.scrollIntoView())
      editorView.focus()
      setSelectedBlockPos(block.pos)
    }
    reader.readAsDataURL(file)
  }, [])

  const handleRunTableCommand = useCallback((block: BlockDescriptor, command: BlockTableCommand) => {
    const editorView = viewRef.current
    if (!editorView) return
    const tableNode = editorView.state.doc.nodeAt(block.pos)
    if (!tableNode || tableNode.type.name !== 'table') return

    const commandMap = {
      'row-before': addRowBefore,
      'row-after': addRowAfter,
      'row-delete': deleteRow,
      'col-before': addColumnBefore,
      'col-after': addColumnAfter,
      'col-delete': deleteColumn,
    } satisfies Record<BlockTableCommand, (state: EditorState, dispatch?: (tr: EditorState['tr']) => void) => boolean>

    const currentTopBlockPos = getTopLevelSelectionBlockPos(editorView.state)
    if (!isInTable(editorView.state) || currentTopBlockPos !== block.pos) {
      const firstCellTextPos = getFirstParagraphTextPosInBlock(tableNode, block.pos)
      if (firstCellTextPos != null) {
        const selectionTr = editorView.state.tr
          .setSelection(TextSelection.create(editorView.state.doc, firstCellTextPos))
          .setMeta('addToHistory', false)
          .setMeta('openwpsBlockSelection', true)
        editorView.dispatch(selectionTr)
      }
    }

    const success = commandMap[command](editorView.state, editorView.dispatch)
    if (success) {
      editorView.focus()
      setSelectedBlockPos(block.pos)
    }
  }, [])

  const handleSetTableStyle = useCallback((
    block: BlockDescriptor,
    attrs: { backgroundColor?: string; borderColor?: string; borderWidth?: number },
  ) => {
    const editorView = viewRef.current
    if (!editorView) return
    const tableNode = editorView.state.doc.nodeAt(block.pos)
    if (!tableNode || tableNode.type.name !== 'table') return

    const tr = editorView.state.tr
    tableNode.descendants((node, relativePos) => {
      if (node.type.name !== 'table_cell') return true
      tr.setNodeMarkup(block.pos + 1 + relativePos, undefined, {
        ...node.attrs,
        ...attrs,
      })
      return true
    })
    tr.setMeta('openwpsBlockSelection', true)
    editorView.dispatch(tr.scrollIntoView())
    editorView.focus()
    setSelectedBlockPos(block.pos)
  }, [])

  const handleAskAIForBlock = useCallback((block: BlockDescriptor) => {
    const anchorRect = getBlockAIAnchorRect(block)
    if (!anchorRect) return
    handleSelectBlock(block)
    setBlockAIPopover({
      blockPos: block.pos,
      rect: anchorRect,
      instruction: '',
      loading: false,
      error: null,
    })
  }, [handleSelectBlock])

  const handleSubmitBlockAI = useCallback(async (instruction: string) => {
    const editorView = viewRef.current
    const popover = blockAIPopover
    if (!editorView || !popover) return

    const node = editorView.state.doc.nodeAt(popover.blockPos)
    if (!node || node.type.name !== 'paragraph' || isPureImageParagraph(node)) {
      setBlockAIPopover((current) => current ? { ...current, error: '首版块 AI 只处理文本块。' } : current)
      return
    }
    const blockText = node.textContent
    if (!blockText.trim()) {
      setBlockAIPopover((current) => current ? { ...current, error: '这个文本块没有可修改的文字。' } : current)
      return
    }

    setBlockAIPopover((current) => current ? { ...current, instruction, loading: true, error: null } : current)
    try {
      let providerId = currentAIProviderId
      let model = currentAIModel
      if (!providerId || !model) {
        const settingsResponse = await fetch('/api/ai/settings')
        const settings = await readJsonResponse<AISettingsSnapshot>(settingsResponse)
        providerId = providerId || settings.activeProviderId || null
        model = model || settings.model || null
      }
      if (!providerId || !model) {
        throw new Error('当前 AI 未配置完成，请先在右侧 AI 面板选择服务商和模型。')
      }

      const response = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'chat',
          providerId,
          model,
          history: [],
          context: {
            scope: 'single_block',
            blockType: 'text',
          },
          message: [
            '你是 openwps 的块级文本改写助手。',
            '你只能查看下面这个文本块，不能引用、推断或要求访问文档其他内容。',
            '根据用户要求直接输出修改后的块文字，不要解释，不要 Markdown 代码围栏。',
            '',
            `文本块内容：\n${blockText}`,
            '',
            `用户要求：${instruction.trim() || '润色这段文字，保持原意。'}`,
          ].join('\n'),
        }),
      })
      const data = await readJsonResponse<{ reply?: string }>(response)
      const nextText = stripAIReply(data.reply ?? '')
      if (!nextText) throw new Error('AI 没有返回可写入的文本。')

      const currentNode = editorView.state.doc.nodeAt(popover.blockPos)
      if (!currentNode || currentNode.type.name !== 'paragraph') return
      const from = popover.blockPos + 1
      const to = popover.blockPos + currentNode.nodeSize - 1
      let tr = editorView.state.tr.replaceWith(from, to, schema.text(nextText))
      const rawHeadingLevel = Number(currentNode.attrs.headingLevel ?? 0)
      const headingLevel = (rawHeadingLevel >= 0 && rawHeadingLevel <= 9 ? rawHeadingLevel : 0) as WpsParagraphStyleLevel
      const style = WPS_PARAGRAPH_STYLES[headingLevel] ?? WPS_PARAGRAPH_STYLES[0]
      if (style.fontSizeHint || style.fontFamilyHint || style.bold) {
        tr = tr.addMark(from, from + nextText.length, schema.marks.textStyle.create({
          fontFamily: style.fontFamilyHint ?? DEFAULT_EDITOR_FONT_STACK,
          fontSize: style.fontSizeHint ?? 12,
          bold: style.bold,
        }))
      }
      tr.setSelection(TextSelection.create(tr.doc, from, from + nextText.length))
      tr.setMeta('openwpsBlockSelection', true)
      editorView.dispatch(tr.scrollIntoView())
      editorView.focus()
      setSelectedBlockPos(popover.blockPos)
      setBlockAIPopover(null)
    } catch (error) {
      setBlockAIPopover((current) => current ? {
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      } : current)
    }
  }, [blockAIPopover, currentAIModel, currentAIProviderId])

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
  const selectionBlockPos = React.useMemo(
    () => (editorState ? getTopLevelSelectionBlockPos(editorState) : null),
    [editorState],
  )
  const editorInTable = Boolean(editorState && isInTable(editorState))
  const pretextVisualActive = Boolean(layoutResult && !layoutSettling && !editorComposing && !editorInTable)
  const aiCopilotDocTextFingerprint = React.useMemo(
    () => (editorState ? getAICopilotDocTextFingerprint(editorState.doc) : ''),
    [editorState],
  )
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
  const blockDescriptors = React.useMemo(
    () => buildBlockDescriptors(editorState, layoutResult, cfg),
    [cfg, editorState, layoutResult],
  )
  const expandedBlockPos = selectedBlockPos ?? selectedNodePos
  const activeBlockPos = expandedBlockPos ?? (editorFocused ? selectionBlockPos : null)
  const activeBlock = React.useMemo(
    () => getBlockByPos(blockDescriptors, activeBlockPos),
    [activeBlockPos, blockDescriptors],
  )
  const visibleBlockControls = activeBlock ? [activeBlock] : []
  const ghostCompletion = React.useMemo(() => {
    if (aiCopilotState.status !== 'preview') return null
    if (!editorState || getAICopilotDocTextFingerprint(editorState.doc) !== aiCopilotState.preview.docTextFingerprint) return null
    if (!layoutResult || layoutSettling) return null

    try {
      const preview = aiCopilotState.preview
      const completion = getActiveAICopilotCompletion(preview)
      if (!completion) return null
      const selection = TextSelection.create(editorState.doc, preview.anchor)
      const tr = editorState.tr.setSelection(selection).insertText(completion)
      const domBlockMetrics = viewRef.current ? collectDomBlockMetrics(viewRef.current) : []
      const layout = paginate(tr.doc, cfg, { domBlockMetrics })
      const from = preview.anchor
      const to = preview.anchor + completion.length
      let popupLeft = cfg.marginLeft
      let popupTop = cfg.marginTop + 28
      let firstGhostTop: number | null = null
      let firstGhostPageContentTop: number | null = null
      let lastGhostBottom: number | null = null
      for (let pageIndex = 0; pageIndex < layout.renderedPages.length; pageIndex += 1) {
        const page = layout.renderedPages[pageIndex]
        for (const line of page.lines) {
          const remainingWidth = Math.max(0, line.availableWidth - line.renderedWidth)
          const justifyEnabled = line.align === 'justify' && !line.isLastLineOfParagraph && line.units.length > 1
          const justifyExtra = justifyEnabled ? remainingWidth / Math.max(1, line.units.length - 1) : 0
          const lineLeft = cfg.marginLeft + line.xOffset + (
            line.align === 'center'
              ? remainingWidth / 2
              : line.align === 'right'
                ? remainingWidth
                : 0
          )
          let cursorX = 0
          let firstGhostOffset: number | null = null
          for (let unitIndex = 0; unitIndex < line.units.length; unitIndex += 1) {
            const unit = line.units[unitIndex]
            const isLastUnit = unitIndex === line.units.length - 1
            const boxWidth = unit.renderWidth + (justifyEnabled && !isLastUnit ? justifyExtra : 0)
            const unitOffset = typeof unit.offsetX === 'number' ? unit.offsetX : cursorX
            if (
              typeof unit.startPos === 'number' &&
              typeof unit.endPos === 'number' &&
              unit.endPos > from &&
              unit.startPos < to &&
              firstGhostOffset == null
            ) {
              firstGhostOffset = unitOffset
            }
            cursorX += boxWidth
          }
          if (firstGhostOffset == null) continue

          const pageTop = pageIndex * (cfg.pageHeight + PAGE_GAP)
          const lineTop = pageTop + cfg.marginTop + line.top
          if (firstGhostTop == null) {
            popupLeft = lineLeft + firstGhostOffset
            firstGhostTop = lineTop
            firstGhostPageContentTop = pageTop + cfg.marginTop
          }
          lastGhostBottom = lineTop + line.lineHeight
        }
      }

      if (firstGhostTop != null) {
        const popupHeight = 30
        const popupGap = 8
        const aboveTop = firstGhostTop - popupHeight - popupGap
        popupTop = aboveTop >= (firstGhostPageContentTop ?? cfg.marginTop)
          ? aboveTop
          : (lastGhostBottom ?? firstGhostTop) + popupGap
      }
      return {
        pages: layout.renderedPages,
        from,
        to,
        popupLeft,
        popupTop,
      }
    } catch {
      return null
    }
  }, [aiCopilotState, cfg, editorState, layoutResult, layoutSettling])

  const handleToggleAICopilot = useCallback(() => {
    setAiCopilotEnabled((current) => {
      const next = !current
      try {
        window.localStorage.setItem(AI_COPILOT_STORAGE_KEY, next ? 'true' : 'false')
      } catch {
        // ignore storage failures
      }
      if (!next) cancelAICopilot()
      return next
    })
  }, [cancelAICopilot])

  const handleAICopilotActivityChange = useCallback((activity: AICopilotActivity) => {
    setAiCopilotActivity(activity)
    try {
      window.localStorage.setItem(AI_COPILOT_ACTIVITY_STORAGE_KEY, activity)
    } catch {
      // ignore storage failures
    }
    cancelAICopilot()
  }, [cancelAICopilot])

  const handleAICopilotCandidateCountChange = useCallback((count: number) => {
    const nextCount = Math.max(1, Math.min(Math.round(count), 3))
    setAiCopilotCandidateCount(nextCount)
    try {
      window.localStorage.setItem(AI_COPILOT_CANDIDATE_COUNT_STORAGE_KEY, String(nextCount))
    } catch {
      // ignore storage failures
    }
    cancelAICopilot()
  }, [cancelAICopilot])

  const handleAICopilotCandidateSelect = useCallback((candidateIndex: number) => {
    setAICopilotState((current) => {
      if (current.status !== 'preview') return current
      const total = current.preview.completions.length
      const activeIndex = Math.max(0, Math.min(candidateIndex, total - 1))
      return { status: 'preview', preview: { ...current.preview, activeIndex } }
    })
  }, [])

  useEffect(() => {
    if (!aiCopilotEnabled) {
      cancelAICopilot()
      return undefined
    }

    const currentEditorState = editorStateRef.current
    if (!currentEditorState || !editorFocusedRef.current || editorComposing || blockAIPopover) {
      cancelAICopilot()
      return undefined
    }

    if (layoutSettling || !pretextVisualActive) {
      clearAICopilotTimer()
      return undefined
    }

    const context = buildAICopilotContext(currentEditorState, pageCount)
    if (!context) {
      cancelAICopilot()
      return undefined
    }

    const currentPreview = aiCopilotPreviewRef.current
    if (currentPreview?.anchor === context.anchor && currentPreview.docTextFingerprint === context.docTextFingerprint) {
      return undefined
    }

    if (aiCopilotTimerRef.current) clearTimeout(aiCopilotTimerRef.current)
    aiCopilotTimerRef.current = setTimeout(() => {
      void requestAICopilotCompletion(context)
    }, AI_COPILOT_DEBOUNCE_MS)

    return () => {
      if (aiCopilotTimerRef.current) {
        clearTimeout(aiCopilotTimerRef.current)
        aiCopilotTimerRef.current = null
      }
    }
  }, [
    aiCopilotEnabled,
    aiCopilotDocTextFingerprint,
    blockAIPopover,
    cancelAICopilot,
    clearAICopilotTimer,
    editorComposing,
    layoutSettling,
    pageCount,
    pretextVisualActive,
    requestAICopilotCompletion,
  ])

  useEffect(() => {
    cancelAICopilot()
  }, [aiCopilotActivity, aiCopilotCandidateCount, cancelAICopilot, currentAIModel, currentAIProviderId])

  return (
    <div className="flex h-screen flex-col" style={{ background: '#e8e8e8' }}>
      {/* Toolbar */}
      <div data-openwps-toolbar-shell="true" className="sticky top-0 z-10 flex-shrink-0 shadow-sm">
        <Toolbar
          view={view}
          editorState={editorState}
          documentTitle={currentDocumentName}
          onDocumentTitleChange={handleDocumentTitleChange}
          pageConfig={pageConfig}
          onPageConfigChange={(newCfg) => {
            setPageConfig(newCfg)
            pageConfigRef.current = newCfg
            repaginate()
          }}
          onToggleSidebar={() => setSidebarOpen(o => !o)}
          sidebarOpen={sidebarOpen}
          aiCopilotEnabled={aiCopilotEnabled}
          aiCopilotActivity={aiCopilotActivity}
          aiCopilotCandidateCount={aiCopilotCandidateCount}
          onToggleAICopilot={handleToggleAICopilot}
          onAICopilotActivityChange={handleAICopilotActivityChange}
          onAICopilotCandidateCountChange={handleAICopilotCandidateCountChange}
          onToggleWorkspace={() => setWorkspaceOpen(o => !o)}
          workspaceOpen={workspaceOpen}
          onNewDocument={handleNewDocument}
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

      <div className="flex min-h-0 flex-1">
        {/* Workspace Panel — content-level library */}
        {workspaceOpen && (
          <WorkspacePanel onClose={() => setWorkspaceOpen(false)} />
        )}

        <div className="flex min-w-0 flex-1 flex-col">

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
                ghostCompletion={ghostCompletion}
              />
            )}

            {aiCopilotState.status === 'preview' && ghostCompletion && (
              aiCopilotState.preview.completions.length > 1 ? (
                <div
                  data-openwps-ai-candidates="true"
                  onMouseDown={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                  style={{
                    position: 'absolute',
                    left: Math.min(
                      Math.max(ghostCompletion.popupLeft, 8),
                      Math.max(8, cfg.pageWidth - Math.min(420, Math.max(280, cfg.pageWidth - 16)) - 8),
                    ),
                    top: ghostCompletion.popupTop,
                    zIndex: 6,
                    width: Math.min(420, Math.max(280, cfg.pageWidth - 16)),
                    maxHeight: 184,
                    padding: 6,
                    border: '1px solid #dbe4f0',
                    borderRadius: 8,
                    background: '#ffffff',
                    boxShadow: '0 10px 28px rgba(15, 23, 42, 0.16)',
                    color: '#334155',
                    fontSize: 12,
                    userSelect: 'none',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, height: 24, padding: '0 2px 4px 4px', color: '#64748b', fontSize: 12 }}>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>{aiCopilotState.preview.activeIndex + 1}/{aiCopilotState.preview.completions.length}</span>
                    <button
                      type="button"
                      title="关闭伴写候选"
                      data-openwps-ai-candidate-close="true"
                      onMouseDown={(event) => {
                        event.preventDefault()
                        clearAICopilotPreview()
                      }}
                      style={{ width: 22, height: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 'none', borderRadius: 6, background: 'transparent', color: '#64748b', cursor: 'pointer' }}
                    >
                      <X size={14} strokeWidth={2} />
                    </button>
                  </div>
                  <div style={{ display: 'grid', gap: 4 }}>
                    {aiCopilotState.preview.completions.map((completion, index) => {
                      const active = index === aiCopilotState.preview.activeIndex
                      return (
                        <div
                          key={`${index}-${completion}`}
                          data-openwps-ai-candidate-item={index + 1}
                          onMouseEnter={() => handleAICopilotCandidateSelect(index)}
                          onMouseDown={(event) => {
                            event.preventDefault()
                            handleAICopilotCandidateSelect(index)
                          }}
                          style={{
                            display: 'grid',
                            gridTemplateColumns: '24px minmax(0, 1fr) 28px',
                            alignItems: 'center',
                            gap: 8,
                            minHeight: 44,
                            padding: '6px 6px 6px 4px',
                            border: `1px solid ${active ? '#bfdbfe' : '#e5e7eb'}`,
                            borderLeft: `3px solid ${active ? '#2563eb' : 'transparent'}`,
                            borderRadius: 7,
                            background: active ? '#eff6ff' : '#ffffff',
                            cursor: 'pointer',
                          }}
                        >
                          <span style={{ color: active ? '#2563eb' : '#64748b', textAlign: 'center', fontVariantNumeric: 'tabular-nums', fontWeight: active ? 600 : 500 }}>
                            {index + 1}
                          </span>
                          <span
                            title={completion}
                            style={{
                              minWidth: 0,
                              color: '#1f2937',
                              lineHeight: '18px',
                              overflow: 'hidden',
                              display: '-webkit-box',
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: 'vertical',
                            }}
                          >
                            {completion}
                          </span>
                          <button
                            type="button"
                            title={`接受第 ${index + 1} 条伴写候选`}
                            data-openwps-ai-candidate-accept={index + 1}
                            onMouseDown={(event) => {
                              event.preventDefault()
                              event.stopPropagation()
                              acceptAICopilot(index)
                            }}
                            style={{ width: 26, height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 'none', borderRadius: 6, background: active ? '#dbeafe' : '#f1f5f9', color: '#2563eb', cursor: 'pointer' }}
                          >
                            <Check size={14} strokeWidth={2.3} />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ) : (
                <div
                  data-openwps-ai-candidates="true"
                  onMouseDown={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                  style={{
                    position: 'absolute',
                    left: Math.min(Math.max(ghostCompletion.popupLeft, 8), Math.max(8, cfg.pageWidth - 98)),
                    top: ghostCompletion.popupTop,
                    zIndex: 6,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    height: 30,
                    padding: '3px 5px',
                    border: '1px solid #dbe4f0',
                    borderRadius: 8,
                    background: '#ffffff',
                    boxShadow: '0 8px 22px rgba(15, 23, 42, 0.14)',
                    color: '#334155',
                    fontSize: 12,
                    userSelect: 'none',
                  }}
                >
                  <button
                    type="button"
                    title="接受当前伴写候选"
                    data-openwps-ai-candidate-accept="true"
                    onMouseDown={(event) => {
                      event.preventDefault()
                      acceptAICopilot()
                    }}
                    style={{ width: 24, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 'none', borderRadius: 6, background: '#e8f1ff', color: '#2563eb', cursor: 'pointer' }}
                  >
                    <Check size={15} strokeWidth={2.3} />
                  </button>
                  <button
                    type="button"
                    title="关闭伴写候选"
                    data-openwps-ai-candidate-close="true"
                    onMouseDown={(event) => {
                      event.preventDefault()
                      clearAICopilotPreview()
                    }}
                    style={{ width: 24, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 'none', borderRadius: 6, background: 'transparent', color: '#64748b', cursor: 'pointer' }}
                  >
                    <X size={15} strokeWidth={2} />
                  </button>
                </div>
              )
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

            {layoutResult && !layoutSettling && visibleBlockControls.length > 0 && (
              <BlockControls
                blocks={visibleBlockControls}
                selectedBlockPos={expandedBlockPos}
                onSelectBlock={handleSelectBlock}
                onCopyBlock={handleCopyBlock}
                onCutBlock={handleCutBlock}
                onDuplicateBlock={handleDuplicateBlock}
                onDeleteBlock={handleDeleteBlock}
                onSetParagraphRole={handleSetParagraphRole}
                onSetParagraphAlign={handleSetParagraphAlign}
                onToggleParagraphList={handleToggleParagraphList}
                onClearBlockFormatting={handleClearBlockFormatting}
                onReplaceImage={handleReplaceImageBlock}
                onRunTableCommand={handleRunTableCommand}
                onSetTableStyle={handleSetTableStyle}
                onAskAI={handleAskAIForBlock}
              />
            )}

            {blockAIPopover && (
              <BlockAIPopover
                state={blockAIPopover}
                onChange={(instruction) => setBlockAIPopover((current) => current ? { ...current, instruction } : current)}
                onClose={() => setBlockAIPopover(null)}
                onSubmit={() => { void handleSubmitBlockAI(blockAIPopover.instruction) }}
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
        {/* end editor column */}

        {/* AI Sidebar — content-level right panel */}
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
            onApplyServerDocumentState={(docJson, nextPageConfig) => {
              applyDocumentState(docJson as PMNodeJSON, nextPageConfig)
              pageConfigRef.current = nextPageConfig
              repaginate()
            }}
            onDocumentStyleMutation={clearImportedDocxCompatibility}
            onClose={() => setSidebarOpen(false)}
          />
        )}
      </div>
      {/* end content row */}

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
