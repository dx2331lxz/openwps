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

const CFG = DEFAULT_PAGE_CONFIG
const PAGE_GAP = 32 // visual gap between page cards
// The page-break decoration must fill: bottom-margin + gap + top-margin
const BREAK_WIDGET_HEIGHT = CFG.marginBottom + PAGE_GAP + CFG.marginTop // 224px

const PM_STYLES = `
.ProseMirror { outline: none; font-family: SimSun, serif; font-size: 12pt;
  line-height: 1.5; color: #000; white-space: pre-wrap; word-break: break-word; }
.ProseMirror p { margin: 0; padding: 0; }
.pm-page-break { display: block; pointer-events: none; }
`

// ---- Page break plugin ----
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

function makeBreakWidget(): HTMLElement {
  const div = document.createElement('div')
  div.className = 'pm-page-break'
  div.style.cssText = `
    height: ${BREAK_WIDGET_HEIGHT}px;
    width: calc(100% + ${CFG.marginLeft + CFG.marginRight}px);
    margin-left: -${CFG.marginLeft}px;
    background: #e8e8e8;
    border-top: 1px solid #ccc;
    border-bottom: 1px solid #ccc;
    box-shadow: inset 0 4px 12px rgba(0,0,0,0.08), inset 0 -4px 12px rgba(0,0,0,0.08);
  `
  return div
}

function buildDecos(doc: EditorState['doc'], breakDocPositions: number[]): DecorationSet {
  if (!breakDocPositions.length) return DecorationSet.empty
  const widgets = breakDocPositions.map((pos) =>
    Decoration.widget(pos, makeBreakWidget, { side: -1, key: `pb-${pos}` })
  )
  return DecorationSet.create(doc, widgets)
}

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
      if (mark) { if (mark.attrs[attr]) isActive = true; existing = { ...mark.attrs } }
    }
  })
  dispatch(tr.addMark(from, to, schema.marks.textStyle.create({ ...existing, [attr]: !isActive })))
  return true
}

function initState(): EditorState {
  const div = document.createElement('div')
  div.innerHTML = '<p>开始输入文字，当内容超过一页时将自动出现分页效果...</p>'
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

export const Editor: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null) // PM editor mount point
  const viewRef = useRef<EditorView | null>(null)
  const [view, setView] = useState<EditorView | null>(null)
  const [pageCount, setPageCount] = useState(1)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const repaginate = useCallback((pmDoc: EditorState['doc']) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      const v = viewRef.current
      if (!v) return

      const pages = paginate(pmDoc, CFG)
      setPageCount(pages.length)

      // Find doc positions of paragraphs that start a new page (page 2, 3, ...)
      const breakParaIndices = new Set<number>()
      for (let pi = 1; pi < pages.length; pi++) {
        const firstLine = pages[pi].lines[0]
        if (firstLine) breakParaIndices.add(firstLine.paragraphIndex)
      }

      const breakDocPositions: number[] = []
      let paraIdx = 0
      pmDoc.forEach((node, offset) => {
        if (node.type.name === 'paragraph') {
          if (breakParaIndices.has(paraIdx)) breakDocPositions.push(offset)
          paraIdx++
        }
      })

      console.log('[editor] pages:', pages.length, 'breaks at paragraphs:', [...breakParaIndices])

      const decos = buildDecos(v.state.doc, breakDocPositions)
      const tr = v.state.tr.setMeta('pageBreakDecos', decos).setMeta('addToHistory', false)
      v.updateState(v.state.apply(tr))
    }, 150)
  }, [])

  useEffect(() => {
    if (!containerRef.current) return

    const styleEl = document.createElement('style')
    styleEl.textContent = PM_STYLES
    document.head.appendChild(styleEl)

    const state = initState()
    const editorView = new EditorView(containerRef.current, {
      state,
      dispatchTransaction(tx) {
        const next = editorView.state.apply(tx)
        editorView.updateState(next)
        if (tx.docChanged) repaginate(next.doc)
      },
    })

    viewRef.current = editorView
    setView(editorView)
    repaginate(state.doc)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      editorView.destroy()
      document.head.removeChild(styleEl)
    }
  }, [repaginate])

  // Total height of all page cards stacked
  const totalBgHeight = pageCount * CFG.pageHeight + (pageCount - 1) * PAGE_GAP

  return (
    <div className="flex flex-col h-screen" style={{ background: '#e8e8e8' }}>
      <div className="sticky top-0 z-10 shadow">
        <Toolbar view={view} />
      </div>

      <div className="flex-1 overflow-auto py-8">
        {/* Outer container centers the content at A4 width */}
        <div className="relative mx-auto" style={{ width: CFG.pageWidth }}>

          {/* Background: page cards stacked */}
          <div className="absolute top-0 left-0 w-full pointer-events-none" style={{ height: totalBgHeight }}>
            {Array.from({ length: pageCount }).map((_, i) => (
              <div
                key={i}
                className="absolute bg-white"
                style={{
                  top: i * (CFG.pageHeight + PAGE_GAP),
                  left: 0,
                  width: CFG.pageWidth,
                  height: CFG.pageHeight,
                  boxShadow: '0 2px 12px rgba(0,0,0,0.18)',
                }}
              >
                {/* Page number */}
                <div className="absolute bottom-3 w-full text-center text-xs text-gray-400 select-none">
                  第 {i + 1} 页 / 共 {pageCount} 页
                </div>
              </div>
            ))}
          </div>

          {/* ProseMirror editor — absolutely positioned starting at page 1 content top */}
          {/* The editor overlays all page cards; page-break decorations create visual gaps */}
          <div
            ref={containerRef}
            className="relative"
            style={{
              marginTop: CFG.marginTop,
              marginLeft: CFG.marginLeft,
              marginRight: CFG.marginRight,
              // enough bottom space for last page
              paddingBottom: CFG.marginBottom,
              minHeight: CFG.pageHeight - CFG.marginTop - CFG.marginBottom,
              zIndex: 1,
            }}
          />
        </div>
      </div>
    </div>
  )
}
