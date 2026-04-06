import React, { useEffect, useRef, useState, useCallback } from 'react'
import { EditorState, Plugin } from 'prosemirror-state'
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view'
import { DOMParser as PMDOMParser } from 'prosemirror-model'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap } from 'prosemirror-commands'
import { history, undo, redo } from 'prosemirror-history'
import { schema } from '../editor/schema'
import { paginate, DEFAULT_PAGE_CONFIG } from '../layout/paginator'
import { Toolbar } from './Toolbar'

// ─── Page geometry ───────────────────────────────────────────────────────────
const CFG = DEFAULT_PAGE_CONFIG
const PAGE_GAP = 32 // px gap between A4 cards
const CONTENT_H = CFG.pageHeight - CFG.marginTop - CFG.marginBottom // 931px
// Standard break constant: bottom margin + gap + top margin
const BREAK_BASE = CFG.marginBottom + PAGE_GAP + CFG.marginTop // 224px

// Widget height for a break after a page that used `usedH` px of content:
//   = (remaining space on that page) + BREAK_BASE
//   = (CONTENT_H - usedH) + BREAK_BASE
// This ensures content after the widget lands exactly at the next card's content top.
function breakWidgetHeight(usedH: number): number {
  return Math.max(CONTENT_H - usedH, 0) + BREAK_BASE
}

// ─── ProseMirror styles ───────────────────────────────────────────────────────
const PM_STYLES = `
.ProseMirror {
  outline: none;
  font-family: SimSun, serif;
  font-size: 12pt;
  line-height: 1.5;
  color: #000;
  white-space: pre-wrap;
  word-break: break-word;
}
.ProseMirror p { margin: 0; padding: 0; }
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

// Factory: creates a transparent spacer widget of the given height
function makeWidget(height: number): () => HTMLElement {
  return () => {
    const div = document.createElement('div')
    div.style.cssText = `display:block;height:${height}px;pointer-events:none;background:transparent;`
    return div
  }
}

function buildDecos(
  doc: EditorState['doc'],
  breaks: { pos: number; height: number }[]
): DecorationSet {
  if (!breaks.length) return DecorationSet.empty
  return DecorationSet.create(
    doc,
    breaks.map(({ pos, height }) =>
      Decoration.widget(pos, makeWidget(height), { side: -1, key: `pb-${pos}` })
    )
  )
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
      }),
      keymap(baseKeymap),
      pageBreakPlugin,
    ],
  })
}

// ─── Editor component ─────────────────────────────────────────────────────────
export const Editor: React.FC = () => {
  const mountRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [view, setView] = useState<EditorView | null>(null)
  const [pageCount, setPageCount] = useState(1)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const repaginate = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      const v = viewRef.current
      if (!v) return

      const doc = v.state.doc
      const pages = paginate(doc, CFG)
      setPageCount(pages.length)

      // Build break list: one entry per page boundary (after page 1, 2, ...)
      const breaks: { pos: number; height: number }[] = []

      // Map paragraphIndex → starting paragraph for each page (page 2 onwards)
      const breakParaIndices = new Map<number, number>() // paraIdx → page index
      for (let pi = 1; pi < pages.length; pi++) {
        const first = pages[pi].lines[0]
        if (first) breakParaIndices.set(first.paragraphIndex, pi)
      }

      let paraIdx = 0
      doc.forEach((node, offset) => {
        if (node.type.name !== 'paragraph') { paraIdx++; return }
        const pageIdx = breakParaIndices.get(paraIdx)
        if (pageIdx !== undefined) {
          // Absolute doc position before this paragraph's opening token = offset + 1
          // (Fragment.forEach gives content-relative offset; +1 for doc's own opening token)
          const pos = offset + 1
          const prevPageUsed = pages[pageIdx - 1].totalHeight
          const wh = breakWidgetHeight(prevPageUsed)
          breaks.push({ pos, height: wh })
          console.log(
            `[editor] page break before para ${paraIdx}: doc pos=${pos}, ` +
            `prevUsed=${prevPageUsed.toFixed(0)}px, widgetH=${wh.toFixed(0)}px`
          )
        }
        paraIdx++
      })

      const decos = buildDecos(doc, breaks)
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
        if (tx.docChanged) repaginate()
      },
    })

    viewRef.current = editorView
    setView(editorView)
    repaginate()

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      editorView.destroy()
      document.head.removeChild(styleEl)
    }
  }, [repaginate])

  // Canvas height = all A4 cards stacked with gaps
  const canvasH = pageCount * CFG.pageHeight + (pageCount - 1) * PAGE_GAP

  return (
    <div className="flex flex-col h-screen" style={{ background: '#e8e8e8' }}>
      {/* Toolbar */}
      <div className="sticky top-0 z-10 shadow-sm">
        <Toolbar view={view} />
      </div>

      {/* Scrollable area */}
      <div className="flex-1 overflow-auto" style={{ paddingTop: 32, paddingBottom: 32 }}>
        {/*
          Canvas: explicit height so absolute page cards create scroll space.
          Width = A4 (794px), centered.

          Layout layers (bottom → top):
            1. White A4 cards  (absolute, pointer-events:none, z-index:0)
            2. ProseMirror editor (absolute, z-index:1, top=marginTop, left=marginLeft)
               Inside the editor, transparent widgets push content between cards.
        */}
        <div
          className="relative mx-auto"
          style={{ width: CFG.pageWidth, height: canvasH }}
        >
          {/* ── Layer 1: A4 page cards ── */}
          {Array.from({ length: pageCount }).map((_, i) => (
            <div
              key={i}
              style={{
                position: 'absolute',
                top: i * (CFG.pageHeight + PAGE_GAP),
                left: 0,
                width: CFG.pageWidth,
                height: CFG.pageHeight,
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
          {/*
            Positioned so its top edge aligns with page-1 content top:
              canvas y = marginTop (96px)
            Left/right insets = page margins (113px each) → content width 568px.

            Transparent break widgets inside the editor push paragraphs to the
            correct y-offset so they land on the matching page card.
          */}
          <div
            ref={mountRef}
            style={{
              position: 'absolute',
              top: CFG.marginTop,
              left: CFG.marginLeft,
              right: CFG.marginRight,
              zIndex: 1,
            }}
          />
        </div>
      </div>
    </div>
  )
}
