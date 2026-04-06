import React from 'react'
import type { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'

interface ToolbarProps {
  view: EditorView | null
}

function applyTextStyle(view: EditorView, attrs: Record<string, unknown>) {
  const { state, dispatch } = view
  const { selection, doc, tr } = state
  const { from, to, empty } = selection

  if (empty) return

  // Get existing mark if any
  let existingAttrs: Record<string, unknown> = {}
  doc.nodesBetween(from, to, (node) => {
    if (node.isText) {
      const mark = node.marks.find((m) => m.type === schema.marks.textStyle)
      if (mark) existingAttrs = { ...mark.attrs }
    }
  })

  const newAttrs = { ...existingAttrs, ...attrs }
  const markType = schema.marks.textStyle
  tr.addMark(from, to, markType.create(newAttrs))
  dispatch(tr)
  view.focus()
}

function toggleBold(view: EditorView) {
  const { state } = view
  const { selection, doc } = state
  const { from, to, empty } = selection
  if (empty) return

  let isBold = false
  doc.nodesBetween(from, to, (node) => {
    if (node.isText) {
      const mark = node.marks.find((m) => m.type === schema.marks.textStyle)
      if (mark?.attrs.bold) isBold = true
    }
  })
  applyTextStyle(view, { bold: !isBold })
}

function toggleItalic(view: EditorView) {
  const { state } = view
  const { selection, doc } = state
  const { from, to, empty } = selection
  if (empty) return

  let isItalic = false
  doc.nodesBetween(from, to, (node) => {
    if (node.isText) {
      const mark = node.marks.find((m) => m.type === schema.marks.textStyle)
      if (mark?.attrs.italic) isItalic = true
    }
  })
  applyTextStyle(view, { italic: !isItalic })
}

function toggleUnderline(view: EditorView) {
  const { state } = view
  const { selection, doc } = state
  const { from, to, empty } = selection
  if (empty) return

  let isUnderline = false
  doc.nodesBetween(from, to, (node) => {
    if (node.isText) {
      const mark = node.marks.find((m) => m.type === schema.marks.textStyle)
      if (mark?.attrs.underline) isUnderline = true
    }
  })
  applyTextStyle(view, { underline: !isUnderline })
}

function setAlign(view: EditorView, align: string) {
  const { state, dispatch } = view
  const { selection, tr } = state
  state.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (node.type.name === 'paragraph') {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, align })
    }
  })
  dispatch(tr)
  view.focus()
}

function adjustFirstLineIndent(view: EditorView, delta: number) {
  const { state, dispatch } = view
  const { selection, tr } = state
  state.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (node.type.name === 'paragraph') {
      const newIndent = Math.max(0, (node.attrs.firstLineIndent as number) + delta)
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, firstLineIndent: newIndent })
    }
  })
  dispatch(tr)
  view.focus()
}

const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 48, 72]

export const Toolbar: React.FC<ToolbarProps> = ({ view }) => {
  const btnClass = 'px-2 py-1 rounded hover:bg-gray-200 text-sm font-medium disabled:opacity-40 cursor-pointer'
  const sepClass = 'w-px h-6 bg-gray-300 mx-1'

  return (
    <div className="flex items-center gap-1 px-3 py-2 bg-white border-b border-gray-200 flex-wrap">
      {/* Bold / Italic / Underline */}
      <button
        className={btnClass + ' font-bold'}
        title="加粗 (Ctrl+B)"
        onMouseDown={(e) => { e.preventDefault(); if (view) toggleBold(view) }}
      >B</button>
      <button
        className={btnClass + ' italic'}
        title="斜体 (Ctrl+I)"
        onMouseDown={(e) => { e.preventDefault(); if (view) toggleItalic(view) }}
      >I</button>
      <button
        className={btnClass + ' underline'}
        title="下划线 (Ctrl+U)"
        onMouseDown={(e) => { e.preventDefault(); if (view) toggleUnderline(view) }}
      >U</button>

      <div className={sepClass} />

      {/* Font Family */}
      <select
        className="text-sm border border-gray-300 rounded px-1 py-1 cursor-pointer"
        title="字体"
        onChange={(e) => { if (view) applyTextStyle(view, { fontFamily: e.target.value }) }}
        defaultValue="SimSun, serif"
      >
        <option value="SimSun, serif">宋体</option>
        <option value="SimHei, sans-serif">黑体</option>
        <option value="KaiTi, serif">楷体</option>
        <option value="Arial, sans-serif">Arial</option>
        <option value="Times New Roman, serif">Times New Roman</option>
      </select>

      {/* Font Size */}
      <select
        className="text-sm border border-gray-300 rounded px-1 py-1 w-16 cursor-pointer"
        title="字号"
        onChange={(e) => { if (view) applyTextStyle(view, { fontSize: Number(e.target.value) }) }}
        defaultValue="12"
      >
        {FONT_SIZES.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>

      <div className={sepClass} />

      {/* Alignment */}
      <button className={btnClass} title="左对齐" onMouseDown={(e) => { e.preventDefault(); if (view) setAlign(view, 'left') }}>≡</button>
      <button className={btnClass} title="居中" onMouseDown={(e) => { e.preventDefault(); if (view) setAlign(view, 'center') }}>≡</button>
      <button className={btnClass} title="右对齐" onMouseDown={(e) => { e.preventDefault(); if (view) setAlign(view, 'right') }}>≡</button>
      <button className={btnClass} title="两端对齐" onMouseDown={(e) => { e.preventDefault(); if (view) setAlign(view, 'justify') }}>≡</button>

      <div className={sepClass} />

      {/* First Line Indent */}
      <button className={btnClass} title="增加首行缩进" onMouseDown={(e) => { e.preventDefault(); if (view) adjustFirstLineIndent(view, 2) }}>⇥</button>
      <button className={btnClass} title="减少首行缩进" onMouseDown={(e) => { e.preventDefault(); if (view) adjustFirstLineIndent(view, -2) }}>⇤</button>
    </div>
  )
}
