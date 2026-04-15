import React, { useEffect, useRef, useState, useCallback } from 'react'
import { EditorState, Plugin, TextSelection } from 'prosemirror-state'
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
} from '../layout/paginator'
import { Toolbar } from './Toolbar'
import AISidebar from './AISidebar'
import FileManagerModal from './FileManagerModal'
import SettingsModal from './SettingsModal'
import { importDocx, type PMNodeJSON } from '../docx/importer'
import { buildDocxBlob, exportDocx, type DocxExportOptions } from '../docx/exporter'
import { DEFAULT_EDITOR_FONT_STACK } from '../fonts'
import { markdownToDocument } from '../markdown/importer'
import { PretextPageRenderer } from './PretextPageRenderer'

// ─── Page geometry ───────────────────────────────────────────────────────────
const PAGE_GAP = 32 // px gap between A4 cards
const DOCX_PUNCTUATION_COMPRESSION_PX = -0.34
const DEFAULT_SERVER_DOCUMENT_NAME = 'document.docx'

interface ServerDocumentSummary {
  name: string
  size: number
  updatedAt: string
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const raw = await response.text()
  const contentType = response.headers.get('content-type') ?? ''

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
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
}
.pretext-driving-editor .ProseMirror * {
  color: transparent !important;
  -webkit-text-fill-color: transparent;
  text-shadow: none !important;
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
.pretext-driving-editor .ProseMirror table * {
  color: #111827 !important;
  -webkit-text-fill-color: #111827 !important;
  caret-color: #111827 !important;
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
  opacity: 1;
  border-top-color: #cbd5e1;
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

function initState(): EditorState {
  const div = document.createElement('div')
  div.innerHTML = '<p>开始输入文字，当内容超过一页高度时将自动出现第二张 A4 白纸...</p>'
  const doc = PMDOMParser.fromSchema(schema).parse(div)
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
        // ── Protect the empty paragraph that sits directly after a table ──────
        // Pressing Backspace at the start of such a paragraph (or Delete when the
        // paragraph is empty) must NOT merge it into the table above.
        'Backspace': (state) => {
          const { $from, empty } = state.selection
          if (!empty) return false
          // Cursor must be at the very start of its paragraph (offset 0)
          if ($from.parentOffset !== 0) return false
          // The parent must be a paragraph that is a direct child of the doc
          if ($from.depth !== 1) return false
          const paraNode = $from.parent
          if (paraNode.type.name !== 'paragraph') return false
          // The paragraph must be empty
          if (paraNode.content.size !== 0) return false
          // The preceding sibling must be a table
          const paraIndex = $from.index(0)
          if (paraIndex === 0) return false
          const prevNode = state.doc.child(paraIndex - 1)
          if (prevNode.type.name !== 'table') return false
          // Block the deletion — swallow the Backspace
          return true
        },
        'Delete': (state) => {
          const { $from, empty } = state.selection
          if (!empty) return false
          if ($from.depth !== 1) return false
          const paraNode = $from.parent
          if (paraNode.type.name !== 'paragraph') return false
          if (paraNode.content.size !== 0) return false
          const paraIndex = $from.index(0)
          if (paraIndex === 0) return false
          const prevNode = state.doc.child(paraIndex - 1)
          if (prevNode.type.name !== 'table') return false
          return true
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
  const [sidebarOpen, setSidebarOpen] = useState(false)
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
  const [editorFocused, setEditorFocused] = useState(false)
  const [docxLetterSpacingPx, setDocxLetterSpacingPx] = useState(0)
  const docxLetterSpacingRef = useRef(0)
  const [serverDocuments, setServerDocuments] = useState<ServerDocumentSummary[]>([])
  const [serverDocumentsLoading, setServerDocumentsLoading] = useState(false)
  const [serverDocumentsError, setServerDocumentsError] = useState<string | null>(null)
  const [currentDocumentName, setCurrentDocumentName] = useState(DEFAULT_SERVER_DOCUMENT_NAME)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { pageConfigRef.current = pageConfig }, [pageConfig])
  useEffect(() => { docxLetterSpacingRef.current = docxLetterSpacingPx }, [docxLetterSpacingPx])

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

  const loadServerDocuments = useCallback(async () => {
    setServerDocumentsLoading(true)
    setServerDocumentsError(null)
    try {
      const response = await fetch('/api/documents')
      const data = await readJsonResponse<ServerDocumentSummary[]>(response)
      setServerDocuments(data)
    } catch (error) {
      console.error('[Editor] load server documents failed', error)
      setServerDocuments([])
      setServerDocumentsError(`读取文件列表失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setServerDocumentsLoading(false)
    }
  }, [])

  const updateLayoutSnapshot = useCallback((doc: EditorState['doc']) => {
    const layout = paginate(doc, pageConfigRef.current)
    setLayoutResult(layout)
    setPageCount(prev => layout.breaks.length + 1 !== prev ? layout.breaks.length + 1 : prev)
    return layout
  }, [])

  const repaginate = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(async () => {
      const v = viewRef.current
      if (!v) return

      // 确保字体加载完成，防止 Pretext Canvas 测量失败
      if (document.fonts?.ready) await document.fonts.ready

      // 先移除已有分页 decorations，再基于浏览器的自然换行结果校准断点。
      // 否则上一次分页插入的 spacer 会反过来影响本次真实行首的判定，造成断点漂移。
      if (pageBreakPlugin.getState(v.state)?.decos !== DecorationSet.empty) {
        const clearTr = v.state.tr
          .setMeta('pageBreakDecos', DecorationSet.empty)
          .setMeta('addToHistory', false)
        v.updateState(v.state.apply(clearTr))
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      }

      const cfg = pageConfigRef.current
      const doc = v.state.doc
      const layout = paginate(doc, cfg)
      const { breaks } = layout
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
    }, 150)
  }, [])

  useEffect(() => {
    if (!mountRef.current) return

    const styleEl = document.createElement('style')
    styleEl.textContent = PM_STYLES
    document.head.appendChild(styleEl)

    const state = initState()
    const editorView = new EditorView(mountRef.current, {
      state,
      nodeViews: {
        image: createImageNodeViewFactory(repaginate),
      },
      handleDOMEvents: {
        focus: () => {
          setEditorFocused(true)
          return false
        },
        blur: () => {
          setEditorFocused(false)
          return false
        },
      },
      dispatchTransaction(tx) {
        const next = editorView.state.apply(tx)
        editorView.updateState(next)
        setEditorState(next)
        if (tx.docChanged && document.fonts?.status === 'loaded') {
          updateLayoutSnapshot(next.doc)
        }
        if (tx.docChanged && !applyingImportedDocxRef.current && transactionHasStyleMutation(tx)) {
          clearImportedDocxCompatibility()
        }
        if (tx.docChanged) repaginate()
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
  }, [clearImportedDocxCompatibility, repaginate, updateLayoutSnapshot])

  useEffect(() => {
    if (viewRef.current) repaginate()
  }, [docxLetterSpacingPx, repaginate])

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

  const handleOpenServerDocument = useCallback(async (name: string) => {
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(name)}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const blob = await response.blob()
      const file = new File([blob], name, {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      })
      await handleImportDocx(file)
      setCurrentDocumentName(name)
      setFileModalMode(null)
      await loadServerDocuments()
      window.alert('服务器文档打开成功')
    } catch (error) {
      console.error('[Editor] open server document failed', error)
      const message = error instanceof Error ? error.message : String(error)
      window.alert(`服务器文档打开失败：${message}`)
    }
  }, [handleImportDocx, loadServerDocuments])

  const handleSaveServerDocument = useCallback(async (name?: string) => {
    const editorView = viewRef.current
    if (!editorView) return
    const targetName = (name ?? currentDocumentName).trim() || DEFAULT_SERVER_DOCUMENT_NAME
    try {
      const blob = await buildDocxBlob(editorView.state.doc, pageConfigRef.current, docxExportOptionsRef.current)
      const response = await fetch(`/api/documents/${encodeURIComponent(targetName)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
        body: blob,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setCurrentDocumentName(targetName.toLowerCase().endsWith('.docx') ? targetName : `${targetName}.docx`)
      setFileModalMode(null)
      await loadServerDocuments()
      window.alert('服务器文档保存成功')
    } catch (error) {
      console.error('[Editor] save server document failed', error)
      const message = error instanceof Error ? error.message : String(error)
      window.alert(`服务器文档保存失败：${message}`)
    }
  }, [currentDocumentName, loadServerDocuments])

  const handleDeleteServerDocument = useCallback(async (name: string) => {
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(name)}`, { method: 'DELETE' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (currentDocumentName === name) {
        setCurrentDocumentName(DEFAULT_SERVER_DOCUMENT_NAME)
      }
      await loadServerDocuments()
    } catch (error) {
      console.error('[Editor] delete server document failed', error)
      const message = error instanceof Error ? error.message : String(error)
      window.alert(`删除服务器文档失败：${message}`)
    }
  }, [currentDocumentName, loadServerDocuments])

  const openServerFileModal = useCallback(async () => {
    setFileModalMode('open')
    await loadServerDocuments()
  }, [loadServerDocuments])

  const openSaveFileModal = useCallback(async () => {
    setFileModalMode('save')
    await loadServerDocuments()
  }, [loadServerDocuments])

  const handleExportDocx = useCallback(async () => {
    const editorView = viewRef.current
    if (!editorView) return

    try {
      await exportDocx(editorView.state.doc, pageConfigRef.current, docxExportOptionsRef.current)
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

  const handleRequestCaretPos = useCallback((pos: number) => {
    const editorView = viewRef.current
    if (!editorView) return

    const clampedPos = Math.max(0, Math.min(pos, editorView.state.doc.content.size))
    const selection = TextSelection.create(editorView.state.doc, clampedPos)
    const tr = editorView.state.tr.setSelection(selection).setMeta('addToHistory', false)
    editorView.dispatch(tr)
    editorView.focus()
  }, [])

  const handleRequestSelectionRange = useCallback((anchor: number, head: number) => {
    const editorView = viewRef.current
    if (!editorView) return

    const maxPos = editorView.state.doc.content.size
    const clampedAnchor = Math.max(0, Math.min(anchor, maxPos))
    const clampedHead = Math.max(0, Math.min(head, maxPos))
    const selection = TextSelection.create(editorView.state.doc, clampedAnchor, clampedHead)
    const tr = editorView.state.tr.setSelection(selection).setMeta('addToHistory', false)
    editorView.dispatch(tr)
    editorView.focus()
  }, [])

  // Canvas height = all A4 cards stacked with gaps
  const cfg = pageConfig  // ← 用 state 而非 ref，确保 React 重渲染时拿到最新值
  const canvasH = pageCount * cfg.pageHeight + (pageCount - 1) * PAGE_GAP

  return (
    <div className="flex flex-col h-screen" style={{ background: '#e8e8e8' }}>
      {/* Toolbar */}
      <div className="sticky top-0 z-10 shadow-sm">
        <Toolbar
          view={view}
          editorState={editorState}
          onToggleSidebar={() => setSidebarOpen(o => !o)}
          sidebarOpen={sidebarOpen}
          onOpenServerFile={openServerFileModal}
          onSaveServerFile={openSaveFileModal}
          onImportDocx={handleImportFile}
          onExportDocx={handleExportDocx}
          onInsertImage={handleInsertImage}
          onToggleFullscreen={() => { void handleToggleFullscreen() }}
          isFullscreen={isFullscreen}
        />
      </div>

      {/* Main content + optional AI sidebar */}
      <div className="flex flex-1 min-h-0">
        {/* Scrollable editor area */}
        <div className="flex-1 overflow-auto" style={{ paddingTop: 32, paddingBottom: 32 }}>
          {/*
          Canvas: explicit height so absolute page cards create scroll space.
          Width = page width, centered.

          Layout layers (bottom → top):
            1. White page cards  (absolute, pointer-events:none, z-index:0)
            2. ProseMirror editor (absolute, z-index:1, top=marginTop, left=marginLeft)
               Inside the editor, transparent widgets push content between cards.
        */}
          <div
            className="relative mx-auto"
            style={{ width: cfg.pageWidth, height: canvasH }}
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
            {layoutResult && (
              <PretextPageRenderer
                pages={layoutResult.renderedPages}
                pageConfig={cfg}
                pageGap={PAGE_GAP}
                caretPos={editorState?.selection.head ?? null}
                selectionFrom={editorState?.selection.from ?? null}
                selectionTo={editorState?.selection.to ?? null}
                showCaret={editorFocused && Boolean(editorState?.selection.empty) && !(editorState && isInTable(editorState))}
                showSelection={editorFocused && Boolean(editorState && !editorState.selection.empty) && !(editorState && isInTable(editorState))}
                onRequestCaretPos={handleRequestCaretPos}
                onRequestSelectionRange={handleRequestSelectionRange}
              />
            )}

            {/* ── Layer 3: ProseMirror editor ── */}
            <div
              ref={mountRef}
              className={layoutResult ? 'pretext-driving-editor' : undefined}
              style={{
                position: 'absolute',
                top: cfg.marginTop,
                left: cfg.marginLeft,
                right: cfg.marginRight,
                ['--docx-letter-spacing' as string]: `${docxLetterSpacingPx}px`,
                zIndex: 2,
              }}
            />
          </div>
          {/* end canvas */}
        </div>
        {/* end scrollable editor area */}

        {/* AI Sidebar */}
        {sidebarOpen && (
          <AISidebar
            view={view}
            editorState={editorState}
            pageConfig={pageConfig}
            onPageConfigChange={(newCfg) => {
              setPageConfig(newCfg)
              pageConfigRef.current = newCfg
              repaginate()
            }}
            onDocumentStyleMutation={clearImportedDocxCompatibility}
            onClose={() => setSidebarOpen(false)}
          />
        )}
      </div>
      {/* end main content row */}

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
          files={serverDocuments}
          loading={serverDocumentsLoading}
          error={serverDocumentsError}
          initialName={currentDocumentName || DEFAULT_SERVER_DOCUMENT_NAME}
          onClose={() => setFileModalMode(null)}
          onOpen={handleOpenServerDocument}
          onSave={handleSaveServerDocument}
          onDelete={handleDeleteServerDocument}
        />
      )}

      {/* Settings modal */}
      {settingsOpen && (
        <SettingsModal
          pageConfig={pageConfig}
          onPageConfigChange={(newCfg) => { setPageConfig(newCfg); pageConfigRef.current = newCfg; repaginate() }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}
