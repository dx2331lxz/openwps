import React, { useEffect, useRef, useState, useCallback } from 'react'
import { EditorState, Plugin } from 'prosemirror-state'
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view'
import { DOMParser as PMDOMParser } from 'prosemirror-model'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap } from 'prosemirror-commands'
import { history, undo, redo } from 'prosemirror-history'
import { schema } from '../editor/schema'
import { paginate, DEFAULT_PAGE_CONFIG, type PageConfig } from '../layout/paginator'
import { Toolbar } from './Toolbar'
import AISidebar from './AISidebar'
import SettingsModal from './SettingsModal'
import { importDocx } from '../docx/importer'
import { exportDocx } from '../docx/exporter'

// ─── Page geometry ───────────────────────────────────────────────────────────
const PAGE_GAP = 32 // px gap between A4 cards

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
.ProseMirror {
  outline: none;
  font-family: SimSun, 完宋体, serif;
  font-size: 12pt;
  line-height: 1.5;
  color: #000;
  white-space: pre-wrap;
  word-break: break-all;  /* 与 Pretext 测量一致，防止数字/英文把前面中文带走 */
  overflow-wrap: break-word;
}
.ProseMirror p { margin: 0; padding: 0; }
.ProseMirror p.list-bullet {
  padding-left: 2em;
  position: relative;
}
.ProseMirror p.list-bullet::before {
  content: "•";
  position: absolute;
  left: 0.5em;
}
.ProseMirror {
  counter-reset: ol-counter;
}
.ProseMirror p:not(.list-ordered) {
  counter-reset: ol-counter;
}
.ProseMirror p.list-ordered {
  counter-increment: ol-counter;
  padding-left: 2.5em;
  position: relative;
}
.ProseMirror p.list-ordered::before {
  content: counter(ol-counter) ".";
  position: absolute;
  left: 0;
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

function snapBreakPosToRenderedLineStart(view: EditorView, pos: number): number {
  const doc = view.state.doc
  const safePos = Math.max(1, Math.min(pos, doc.nodeSize - 2))
  const $pos = doc.resolve(safePos)

  let paragraphDepth = $pos.depth
  while (paragraphDepth > 0 && $pos.node(paragraphDepth).type.name !== 'paragraph') {
    paragraphDepth -= 1
  }
  if (paragraphDepth === 0 || $pos.node(paragraphDepth).type.name !== 'paragraph') return safePos

  const paragraphStart = $pos.start(paragraphDepth)
  const paragraphEnd = $pos.end(paragraphDepth)
  if (safePos <= paragraphStart || safePos >= paragraphEnd) return safePos

  let lastLineStart = paragraphStart
  let lastTop: number | null = null

  for (let cursorPos = paragraphStart; cursorPos <= safePos; cursorPos += 1) {
    try {
      const coords = view.coordsAtPos(cursorPos)
      if (lastTop === null) {
        lastTop = coords.top
        lastLineStart = cursorPos
        continue
      }

      if (Math.abs(coords.top - lastTop) > 1) {
        lastTop = coords.top
        lastLineStart = cursorPos
      }
    } catch {
      return safePos
    }
  }

  return lastLineStart
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
  const [view, setView] = useState<EditorView | null>(null)
  const [editorState, setEditorState] = useState<EditorState | null>(null)
  const [pageConfig, setPageConfig] = useState<PageConfig>(DEFAULT_PAGE_CONFIG)
  const pageConfigRef = useRef<PageConfig>(DEFAULT_PAGE_CONFIG)
  const [pageCount, setPageCount] = useState(1)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { pageConfigRef.current = pageConfig }, [pageConfig])

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
      const { pages, breaks } = paginate(doc, cfg)
      setPageCount(prev => pages.length !== prev ? pages.length : prev)

      const pageBreakDecos = breaks.map((item) => {
          const snappedPos = snapBreakPosToRenderedLineStart(v, item.pos)
          const height = breakWidgetHeight(item.prevPageUsed, cfg)
          console.log(
            `[editor] page break before page ${item.pageIndex + 1}: rawPos=${item.pos}, snappedPos=${snappedPos}, ` +
            `prevUsed=${item.prevPageUsed.toFixed(0)}px, widgetH=${height.toFixed(0)}px`
          )
          return { pos: snappedPos, height }
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
      dispatchTransaction(tx) {
        const next = editorView.state.apply(tx)
        editorView.updateState(next)
        setEditorState(next)
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
  }, [repaginate])

  const handleImportDocx = useCallback(async (file: File) => {
    const editorView = viewRef.current
    if (!editorView) return

    try {
      const parsed = await importDocx(file)
      const docNode = schema.nodeFromJSON(parsed.doc)
      const transaction = editorView.state.tr.replaceWith(
        0,
        editorView.state.doc.nodeSize - 2,
        docNode.content,
      )
      editorView.dispatch(transaction)
      setPageConfig(parsed.pageConfig)
      pageConfigRef.current = parsed.pageConfig
      repaginate()
      window.alert('DOCX 导入成功')
    } catch (error) {
      console.error('[Editor] DOCX import failed', error)
      const message = error instanceof Error ? error.message : String(error)
      window.alert(`DOCX 导入失败：${message}`)
    }
  }, [repaginate])

  const handleExportDocx = useCallback(async () => {
    const editorView = viewRef.current
    if (!editorView) return

    try {
      await exportDocx(editorView.state.doc, pageConfigRef.current)
      window.alert('DOCX 导出成功')
    } catch (error) {
      console.error('[Editor] DOCX export failed', error)
      const message = error instanceof Error ? error.message : String(error)
      window.alert(`DOCX 导出失败：${message}`)
    }
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

          {/* ── Layer 2: ProseMirror editor ── */}
          <div
            ref={mountRef}
            style={{
              position: 'absolute',
              top: cfg.marginTop,
              left: cfg.marginLeft,
              right: cfg.marginRight,
              zIndex: 1,
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
