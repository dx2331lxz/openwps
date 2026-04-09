import React, { useEffect, useRef, useState, useCallback } from 'react'
import { EditorState, Plugin, TextSelection } from 'prosemirror-state'
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view'
import { DOMParser as PMDOMParser } from 'prosemirror-model'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap } from 'prosemirror-commands'
import { history, undo, redo } from 'prosemirror-history'
import { schema } from '../editor/schema'
import {
  paginate,
  DEFAULT_PAGE_CONFIG,
  type PageConfig,
  type PaginateResult,
} from '../layout/paginator'
import { Toolbar } from './Toolbar'
import AISidebar from './AISidebar'
import SettingsModal from './SettingsModal'
import { importDocx } from '../docx/importer'
import { exportDocx, type DocxExportOptions } from '../docx/exporter'
import { DEFAULT_EDITOR_FONT_STACK } from '../fonts'
import { PretextPageRenderer } from './PretextPageRenderer'

// ─── Page geometry ───────────────────────────────────────────────────────────
const PAGE_GAP = 32 // px gap between A4 cards
const DOCX_PUNCTUATION_COMPRESSION_PX = -0.34

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
.ProseMirror img {
  display: inline-block;
  max-width: 100%;
  vertical-align: bottom;
}
.ProseMirror p.page-break-before {
  border-top: 2px dashed #0066cc;
  padding-top: 4px;
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
.pretext-driving-editor .ProseMirror img,
.pretext-driving-editor .ProseMirror hr,
.pretext-driving-editor .ProseMirror table {
  opacity: 0;
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
        'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo,
        'Mod-b': (s, d) => toggleMarkAttr(s, d, 'bold'),
        'Mod-i': (s, d) => toggleMarkAttr(s, d, 'italic'),
        'Mod-u': (s, d) => toggleMarkAttr(s, d, 'underline'),
        'Tab': (state, dispatch) => {
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
      mixedScriptSpacingPlugin,
      pageBreakPlugin,
    ],
  })
}

// ─── Editor component ─────────────────────────────────────────────────────────
export const Editor: React.FC = () => {
  const mountRef = useRef<HTMLDivElement>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<0 | 1>(0)
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
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { pageConfigRef.current = pageConfig }, [pageConfig])

  const clearImportedDocxCompatibility = useCallback(() => {
    if (docxLetterSpacingPx === 0 && Object.keys(docxExportOptionsRef.current).length === 0) return
    docxExportOptionsRef.current = {}
    setDocxLetterSpacingPx(0)
    console.log('[docx] imported compatibility metadata cleared after style mutation')
  }, [docxLetterSpacingPx])

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
      const docNode = schema.nodeFromJSON(parsed.doc)
      applyingImportedDocxRef.current = true
      const transaction = editorView.state.tr.replaceWith(
        0,
        editorView.state.doc.nodeSize - 2,
        docNode.content,
      )
      editorView.dispatch(transaction)
      setPageConfig(parsed.pageConfig)
      pageConfigRef.current = parsed.pageConfig
      docxExportOptionsRef.current = {
        docGridLinePitchPt: parsed.docGridLinePitchPt,
        typography: parsed.typography,
      }
      setDocxLetterSpacingPx(parsed.typography.punctuationCompression ? DOCX_PUNCTUATION_COMPRESSION_PX : 0)
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
  }, [repaginate])

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

  const handleRequestCaretPos = useCallback((pos: number) => {
    const editorView = viewRef.current
    if (!editorView) return

    const clampedPos = Math.max(0, Math.min(pos, editorView.state.doc.content.size))
    const selection = TextSelection.create(editorView.state.doc, clampedPos)
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
          onOpenSettings={(tab = 'page') => { setSettingsTab(tab === 'ai' ? 1 : 0); setSettingsOpen(true) }}
          onImportDocx={handleImportDocx}
          onExportDocx={handleExportDocx}
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
              showCaret={editorFocused && Boolean(editorState?.selection.empty)}
              onRequestCaretPos={handleRequestCaretPos}
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
        title="设置"
      >
        ⚙️
      </button>

      {/* Settings modal */}
      {settingsOpen && (
        <SettingsModal
          defaultTab={settingsTab}
          pageConfig={pageConfig}
          onPageConfigChange={(newCfg) => { setPageConfig(newCfg); pageConfigRef.current = newCfg; repaginate() }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}
