import React from 'react'
import type { EditorView } from 'prosemirror-view'
import type { EditorState } from 'prosemirror-state'
import { TextSelection } from 'prosemirror-state'
import type { Mark } from 'prosemirror-model'
import { undo, redo } from 'prosemirror-history'
import { schema } from '../editor/schema'

interface ToolbarProps {
  view: EditorView | null
  editorState: EditorState | null
  onToggleSidebar?: () => void
  sidebarOpen?: boolean
  onOpenSettings?: (tab?: 'page' | 'ai') => void
  onImportDocx?: (file: File) => void | Promise<void>
  onExportDocx?: () => void | Promise<void>
}

// ─── Format derivation ────────────────────────────────────────────────────────

const defaultTextFmt = {
  bold: false, italic: false, underline: false, strikethrough: false,
  superscript: false, subscript: false, fontFamily: 'SimSun, 宋体, serif', fontSize: 12,
  color: '#000000', backgroundColor: '',
}

const defaultParaFmt = {
  align: 'left', firstLineIndent: 0, indent: 0, lineHeight: 1.5,
  spaceBefore: 0, spaceAfter: 0, listType: null as string | null, pageBreakBefore: false,
}

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
  state.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (node.type.name === 'paragraph') {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs })
    }
  })
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
        spaceBefore: 0, spaceAfter: 0, listType: null, listLevel: 0, pageBreakBefore: false,
      })
    }
  })
  dispatch(tr)
  view.focus()
}

function toggleList(view: EditorView, listType: 'bullet' | 'ordered') {
  const { state, dispatch } = view
  const { selection, tr } = state
  let allHave = true
  state.doc.nodesBetween(selection.from, selection.to, (node) => {
    if (node.type.name === 'paragraph' && node.attrs.listType !== listType) allHave = false
  })
  const newType = allHave ? null : listType
  state.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (node.type.name === 'paragraph') {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, listType: newType })
    }
  })
  dispatch(tr)
  view.focus()
}

function insertHR(view: EditorView) {
  const { state, dispatch } = view
  const tr = state.tr.replaceSelectionWith(schema.nodes.horizontal_rule.create())
  dispatch(tr)
  view.focus()
}

function insertPageBreak(view: EditorView) {
  const { state, dispatch } = view
  const { selection, tr } = state
  // AllSelection ($from.pos=0, depth=0) means entire doc is selected.
  // Resolve to pos=1 so we land inside the first paragraph.
  const resolvePos = selection.from === 0 ? 1 : selection.from
  const $from = state.doc.resolve(resolvePos)
  for (let d = $from.depth; d >= 0; d--) {
    const n = $from.node(d)
    if (n.type.name === 'paragraph') {
      const pos = $from.before(d)
      tr.setNodeMarkup(pos, undefined, { ...n.attrs, pageBreakBefore: !n.attrs.pageBreakBefore })
      break
    }
  }
  dispatch(tr)
  view.focus()
}

// ─── Color swatch ─────────────────────────────────────────────────────────────

const TEXT_COLORS = ['#000000', '#FF0000', '#E65C00', '#FFB300', '#1B8000', '#0066CC', '#7B00D4', '#FFFFFF']
const HIGHLIGHT_COLORS = ['', '#FFFF00', '#99FF99', '#99CCFF', '#FF9999', '#FFB366', '#E0B3FF', '#CCCCCC']

const ColorSwatch: React.FC<{
  colors: string[]
  current: string
  onChange: (c: string) => void
  onClose: () => void
}> = ({ colors, current, onChange, onClose }) => (
  <div style={{
    display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 4, padding: 6,
    background: 'white', border: '1px solid #ccc', borderRadius: 4,
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
    position: 'absolute', zIndex: 50, top: '100%', left: 0,
  }}>
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

// ─── Toolbar component ────────────────────────────────────────────────────────

export const Toolbar: React.FC<ToolbarProps> = ({
  view,
  editorState,
  onToggleSidebar,
  sidebarOpen,
  onOpenSettings,
  onImportDocx,
  onExportDocx,
}) => {
  const [colorPickerOpen, setColorPickerOpen] = React.useState<'text' | 'bg' | null>(null)
  // Save selection before a <select> opens (it shifts browser focus away from editor)
  const savedRangeRef = React.useRef<{ from: number; to: number } | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const fmt = editorState ? deriveFormats(editorState) : { text: defaultTextFmt, para: defaultParaFmt }

  const btn = (active: boolean) =>
    'px-2 py-1 rounded text-sm font-medium cursor-pointer select-none ' +
    (active ? 'bg-blue-100 text-blue-700' : 'hover:bg-gray-100 text-gray-700')

  const sep = <div style={{ width: 1, height: 24, background: '#e5e7eb', margin: '0 4px' }} />

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

  return (
    <>
      <div
        className="toolbar-row"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          padding: '4px 8px',
          background: 'white',
          borderBottom: '1px solid #e5e7eb',
          flexWrap: 'nowrap',
          overflowX: 'auto',
          overflowY: 'hidden',
          whiteSpace: 'nowrap',
          minHeight: 36,
          scrollbarWidth: 'none',
        }}
      >
        {/* Undo / Redo */}
        <button className={btn(false)} title="撤销 (Ctrl+Z)" onMouseDown={e => { e.preventDefault(); if (view) undo(view.state, view.dispatch) }}>↩</button>
        <button className={btn(false)} title="重做 (Ctrl+Y)" onMouseDown={e => { e.preventDefault(); if (view) redo(view.state, view.dispatch) }}>↪</button>

        {sep}

        {/* Font size (select, placed first so test can find by index 0) */}
        <select
          title="字号"
          value={fmt.text.fontSize}
          style={{ width: 58, fontSize: 13, border: '1px solid #ddd', borderRadius: 4, padding: '2px 4px', cursor: 'pointer' }}
          onMouseDown={saveSelection}
          onChange={e => applyTextStyleWithSaved({ fontSize: Number(e.target.value) })}
        >
          {[8,9,10,11,12,14,16,18,20,22,24,26,28,36,48,72].map(v => (
            <option key={v} value={v}>{v}pt</option>
          ))}
        </select>

        {/* Font family */}
        <select
          title="字体"
          value={fmt.text.fontFamily}
          style={{ fontSize: 13, border: '1px solid #ddd', borderRadius: 4, padding: '2px 4px', cursor: 'pointer' }}
          onMouseDown={saveSelection}
          onChange={e => applyTextStyleWithSaved({ fontFamily: e.target.value })}
        >
          <option value="SimSun, 宋体, serif">宋体</option>
          <option value="SimHei, 黑体, sans-serif">黑体</option>
          <option value="KaiTi, 楷体, serif">楷体</option>
          <option value="FangSong, 仿宋, serif">仿宋</option>
          <option value="Arial, sans-serif">Arial</option>
          <option value="Times New Roman, serif">Times New Roman</option>
        </select>

        {sep}

        {/* B I U S X² X₂ */}
        <button className={btn(fmt.text.bold)} title="加粗 (Ctrl+B)" onMouseDown={e => { e.preventDefault(); if (view) applyTextStyle(view, { bold: !fmt.text.bold }) }}><b>B</b></button>
        <button className={btn(fmt.text.italic)} title="斜体 (Ctrl+I)" onMouseDown={e => { e.preventDefault(); if (view) applyTextStyle(view, { italic: !fmt.text.italic }) }}><i>I</i></button>
        <button className={btn(fmt.text.underline)} title="下划线 (Ctrl+U)" onMouseDown={e => { e.preventDefault(); if (view) applyTextStyle(view, { underline: !fmt.text.underline }) }}><u>U</u></button>
        <button className={btn(fmt.text.strikethrough)} title="删除线" onMouseDown={e => { e.preventDefault(); if (view) applyTextStyle(view, { strikethrough: !fmt.text.strikethrough }) }}><s>S</s></button>
        <button className={btn(fmt.text.superscript)} title="上标" onMouseDown={e => { e.preventDefault(); if (view) applyTextStyle(view, { superscript: !fmt.text.superscript }) }}>X²</button>
        <button className={btn(fmt.text.subscript)} title="下标" onMouseDown={e => { e.preventDefault(); if (view) applyTextStyle(view, { subscript: !fmt.text.subscript }) }}>X₂</button>

        {/* Text color */}
        <div style={{ position: 'relative' }}>
          <button
            title="文字颜色"
            onMouseDown={e => { e.preventDefault(); setColorPickerOpen(colorPickerOpen === 'text' ? null : 'text') }}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '2px 4px', borderRadius: 4, cursor: 'pointer', border: 'none', background: 'transparent' }}
            className={btn(false)}
          >
            <span style={{ fontSize: 13, fontWeight: 600, lineHeight: 1 }}>A</span>
            <span style={{ height: 3, width: 16, background: fmt.text.color, border: '1px solid #ccc', borderRadius: 1 }} />
          </button>
          {colorPickerOpen === 'text' && (
            <ColorSwatch
              colors={TEXT_COLORS}
              current={fmt.text.color}
              onChange={c => { if (view) applyTextStyle(view, { color: c }) }}
              onClose={() => setColorPickerOpen(null)}
            />
          )}
        </div>

        {/* Highlight / background color */}
        <div style={{ position: 'relative' }}>
          <button
            title="文字背景色（高亮）"
            onMouseDown={e => { e.preventDefault(); setColorPickerOpen(colorPickerOpen === 'bg' ? null : 'bg') }}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '2px 4px', borderRadius: 4, cursor: 'pointer', border: 'none', background: 'transparent' }}
            className={btn(false)}
          >
            <span style={{ fontSize: 11 }}>🖍</span>
            <span style={{ height: 3, width: 16, background: fmt.text.backgroundColor || 'transparent', border: '1px solid #ccc', borderRadius: 1 }} />
          </button>
          {colorPickerOpen === 'bg' && (
            <ColorSwatch
              colors={HIGHLIGHT_COLORS}
              current={fmt.text.backgroundColor}
              onChange={c => { if (view) applyTextStyle(view, { backgroundColor: c }) }}
              onClose={() => setColorPickerOpen(null)}
            />
          )}
        </div>

        {/* Clear format */}
        <button className={btn(false)} title="清除格式" onMouseDown={e => { e.preventDefault(); if (view) clearFormatting(view) }}>✕</button>

        {sep}

        {/* Alignment */}
        <button className={btn(fmt.para.align === 'left')} title="左对齐" onMouseDown={e => { e.preventDefault(); if (view) applyParaStyle(view, { align: 'left' }) }}>≡L</button>
        <button className={btn(fmt.para.align === 'center')} title="居中" onMouseDown={e => { e.preventDefault(); if (view) applyParaStyle(view, { align: 'center' }) }}>≡C</button>
        <button className={btn(fmt.para.align === 'right')} title="右对齐" onMouseDown={e => { e.preventDefault(); if (view) applyParaStyle(view, { align: 'right' }) }}>≡R</button>
        <button className={btn(fmt.para.align === 'justify')} title="两端对齐" onMouseDown={e => { e.preventDefault(); if (view) applyParaStyle(view, { align: 'justify' }) }}>≡J</button>

        {sep}

        {/* Lists */}
        <button className={btn(fmt.para.listType === 'bullet')} title="无序列表" onMouseDown={e => { e.preventDefault(); if (view) toggleList(view, 'bullet') }}>• =</button>
        <button className={btn(fmt.para.listType === 'ordered')} title="有序列表" onMouseDown={e => { e.preventDefault(); if (view) toggleList(view, 'ordered') }}>1.</button>

        {sep}

        {/* First-line indent */}
        <button className={btn(false)} title="增加首行缩进 (Tab)" onMouseDown={e => { e.preventDefault(); if (view) applyParaStyle(view, { firstLineIndent: Math.max(0, (fmt.para.firstLineIndent as number) + 2) }) }}>⇥首</button>
        <button className={btn(false)} title="减少首行缩进 (Shift+Tab)" onMouseDown={e => { e.preventDefault(); if (view) applyParaStyle(view, { firstLineIndent: Math.max(0, (fmt.para.firstLineIndent as number) - 2) }) }}>⇤首</button>

        {/* Overall indent */}
        <button className={btn(false)} title="增加缩进" onMouseDown={e => { e.preventDefault(); if (view) applyParaStyle(view, { indent: (fmt.para.indent as number || 0) + 1 }) }}>⇥</button>
        <button className={btn(false)} title="减少缩进" onMouseDown={e => { e.preventDefault(); if (view) applyParaStyle(view, { indent: Math.max(0, (fmt.para.indent as number || 0) - 1) }) }}>⇤</button>

        {sep}

        {/* Line height */}
        <select
          title="行距"
          value={fmt.para.lineHeight}
          style={{ fontSize: 13, border: '1px solid #ddd', borderRadius: 4, padding: '2px 4px', cursor: 'pointer' }}
          onChange={e => { if (view) applyParaStyle(view, { lineHeight: Number(e.target.value) }) }}
        >
          {[1.0, 1.15, 1.5, 2.0, 2.5, 3.0].map(v => <option key={v} value={v}>{v}</option>)}
        </select>

        {/* Space before */}
        <select
          title="段前间距"
          value={fmt.para.spaceBefore}
          style={{ fontSize: 13, border: '1px solid #ddd', borderRadius: 4, padding: '2px 4px', cursor: 'pointer' }}
          onChange={e => { if (view) applyParaStyle(view, { spaceBefore: Number(e.target.value) }) }}
        >
          <option value={0}>段前0</option>
          <option value={0.5}>段前0.5行</option>
          <option value={1}>段前1行</option>
        </select>

        {/* Space after */}
        <select
          title="段后间距"
          value={fmt.para.spaceAfter}
          style={{ fontSize: 13, border: '1px solid #ddd', borderRadius: 4, padding: '2px 4px', cursor: 'pointer' }}
          onChange={e => { if (view) applyParaStyle(view, { spaceAfter: Number(e.target.value) }) }}
        >
          <option value={0}>段后0</option>
          <option value={0.5}>段后0.5行</option>
          <option value={1}>段后1行</option>
        </select>

        {sep}

        {/* Insert HR */}
        <button className={btn(false)} title="插入水平分割线" onMouseDown={e => { e.preventDefault(); if (view) insertHR(view) }}>──</button>

        {/* Insert page break */}
        <button className={btn(false)} title="插入分页符" onMouseDown={e => { e.preventDefault(); if (view) insertPageBreak(view) }}>⊞</button>

        {/* Page settings */}
        <button className={btn(false)} title="页面设置" onMouseDown={e => { e.preventDefault(); onOpenSettings?.('page') }}>⚙</button>

        {sep}

        {/* AI Sidebar toggle */}
        <button
          title="AI 排版助手"
          onMouseDown={e => { e.preventDefault(); onToggleSidebar?.() }}
          style={{
            padding: '3px 12px', fontSize: 13, borderRadius: 4, cursor: 'pointer',
            background: sidebarOpen ? '#2563eb' : '#f3f4f6',
            color: sidebarOpen ? 'white' : '#374151',
            border: '1px solid #d1d5db',
          }}
        >
          🤖 AI
        </button>

        <div className="flex gap-1 ml-auto">
          <button
            className={btn(false)}
            title="导入 .docx"
            onMouseDown={e => {
              e.preventDefault()
              fileInputRef.current?.click()
            }}
          >
            📂 导入
          </button>
          <button
            className={btn(false)}
            title="导出 .docx"
            onMouseDown={e => {
              e.preventDefault()
              void onExportDocx?.()
            }}
          >
            💾 导出
          </button>
        </div>

        <input
          type="file"
          accept=".docx"
          ref={fileInputRef}
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void onImportDocx?.(file)
            event.target.value = ''
          }}
          style={{ display: 'none' }}
        />
      </div>
    </>
  )
}
