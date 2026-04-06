import type { EditorView } from 'prosemirror-view'
import type { EditorState, Transaction } from 'prosemirror-state'
import { schema } from '../editor/schema'
import type { PageConfig } from '../layout/paginator'
import { presetStyles, mapFontFamily } from './presets'

// ─── Paper size lookup ────────────────────────────────────────────────────────

const PAPER_SIZES: Record<string, { pageWidth: number; pageHeight: number }> = {
  A4: { pageWidth: 794, pageHeight: 1123 },
  A3: { pageWidth: 1123, pageHeight: 1587 },
  Letter: { pageWidth: 816, pageHeight: 1056 },
  B5: { pageWidth: 665, pageHeight: 942 },
}

function mmToPx(mm: number): number {
  return Math.round(mm * 3.7795)
}

// ─── Result type ──────────────────────────────────────────────────────────────

export interface ExecuteResult {
  success: boolean
  message: string
  data?: unknown
}

// ─── Execute options ──────────────────────────────────────────────────────────

export interface ExecuteOptions {
  pageConfig?: PageConfig
  onPageConfigChange?: (cfg: PageConfig) => void
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Apply text mark attrs to a range, merging with existing mark attrs */
function addTextMark(
  tr: Transaction,
  state: EditorState,
  from: number,
  to: number,
  attrs: Record<string, unknown>
): Transaction {
  if (from >= to) return tr
  let existing: Record<string, unknown> = {}
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isText) {
      const m = node.marks.find((m) => m.type === schema.marks.textStyle)
      if (m) existing = { ...m.attrs }
    }
  })
  return tr.addMark(from, to, schema.marks.textStyle.create({ ...existing, ...attrs }))
}

/** Apply text style to the appropriate target */
function applyTextStyleWithTarget(
  state: EditorState,
  tr: Transaction,
  attrs: Record<string, unknown>,
  target: string | undefined
): Transaction {
  if (target === 'all') {
    // Apply mark to every paragraph's full text range
    state.doc.nodesBetween(0, state.doc.content.size, (node, pos) => {
      if (node.type.name === 'paragraph' && node.content.size > 0) {
        const from = pos + 1                       // after paragraph's opening token
        const to = pos + 1 + node.content.size    // before paragraph's closing token
        tr = addTextMark(tr, state, from, to, attrs)
      }
    })
    return tr
  }

  const { from, to, empty } = state.selection
  if (!empty) {
    const resolvedFrom = Math.max(1, from)
    const resolvedTo = Math.min(state.doc.nodeSize - 2, to)
    if (resolvedFrom < resolvedTo) {
      tr = addTextMark(tr, state, resolvedFrom, resolvedTo, attrs)
    }
    return tr
  }

  // Empty selection — apply to the full text of the current paragraph
  const safeFrom = Math.max(0, from)
  const safeTo = Math.min(from + 1, state.doc.content.size)
  state.doc.nodesBetween(safeFrom, safeTo, (node, pos) => {
    if (node.type.name === 'paragraph' && node.content.size > 0) {
      const pFrom = pos + 1
      const pTo = pos + 1 + node.content.size
      tr = addTextMark(tr, state, pFrom, pTo, attrs)
    }
  })
  return tr
}

/** Apply paragraph attrs to the appropriate target */
function applyParagraphStyleWithTarget(
  state: EditorState,
  tr: Transaction,
  attrs: Record<string, unknown>,
  target: string | undefined
): Transaction {
  if (target === 'all') {
    state.doc.nodesBetween(0, state.doc.content.size, (node, pos) => {
      if (node.type.name === 'paragraph') {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs })
      }
    })
    return tr
  }

  const { from, to } = state.selection
  // When selection is collapsed, expand the search range by +1 so nodesBetween
  // finds the paragraph containing the cursor (mirrors Toolbar's applyParaStyle).
  const effectiveTo = from === to
    ? Math.min(from + 1, state.doc.content.size)
    : to
  state.doc.nodesBetween(from, effectiveTo, (node, pos) => {
    if (node.type.name === 'paragraph') {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs })
    }
  })
  return tr
}

/** Simulate heading styles (schema has no heading node; use text+para style) */
const HEADING_STYLES: Record<number, { fontFamily: string; fontSize: number; bold: boolean; align: string; spaceBefore: number; spaceAfter: number }> = {
  1: { fontFamily: 'SimHei, 黑体, sans-serif', fontSize: 22, bold: true, align: 'center', spaceBefore: 12, spaceAfter: 12 },
  2: { fontFamily: 'SimHei, 黑体, sans-serif', fontSize: 18, bold: true, align: 'left', spaceBefore: 10, spaceAfter: 6 },
  3: { fontFamily: 'SimHei, 黑体, sans-serif', fontSize: 16, bold: true, align: 'left', spaceBefore: 6, spaceAfter: 4 },
  4: { fontFamily: 'SimHei, 黑体, sans-serif', fontSize: 14, bold: true, align: 'left', spaceBefore: 4, spaceAfter: 2 },
}

// ─── Main executor ────────────────────────────────────────────────────────────

export function executeTool(
  view: EditorView,
  toolName: string,
  params: Record<string, unknown>,
  options?: ExecuteOptions
): ExecuteResult {
  const { state, dispatch } = view
  let tr = state.tr

  try {
    switch (toolName) {
      case 'set_text_style': {
        const { target, ...styleAttrs } = params
        // Map fontFamily name to CSS font stack if needed
        if (typeof styleAttrs.fontFamily === 'string') {
          styleAttrs.fontFamily = mapFontFamily(styleAttrs.fontFamily)
        }
        tr = applyTextStyleWithTarget(state, tr, styleAttrs, target as string | undefined)
        break
      }

      case 'set_paragraph_style': {
        const { target, ...paraAttrs } = params
        tr = applyParagraphStyleWithTarget(state, tr, paraAttrs, target as string | undefined)
        break
      }

      case 'set_heading': {
        const level = Math.min(4, Math.max(1, Number(params.level) || 1))
        const hs = HEADING_STYLES[level]
        const { align, spaceBefore, spaceAfter, ...textStyle } = hs
        tr = applyTextStyleWithTarget(state, tr, textStyle, 'selection')
        tr = applyParagraphStyleWithTarget(state, tr, { align, spaceBefore, spaceAfter }, 'selection')
        break
      }

      case 'set_list': {
        const listType = params.type as string
        const newType = listType === 'none' ? null : listType
        const { from, to } = state.selection
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (node.type.name === 'paragraph') {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, listType: newType })
          }
        })
        break
      }

      case 'insert_page_break': {
        const { selection } = state
        const resolvePos = selection.from === 0 ? 1 : selection.from
        const $from = state.doc.resolve(resolvePos)
        for (let d = $from.depth; d >= 0; d--) {
          const n = $from.node(d)
          if (n.type.name === 'paragraph') {
            tr.setNodeMarkup($from.before(d), undefined, {
              ...n.attrs,
              pageBreakBefore: !n.attrs.pageBreakBefore,
            })
            break
          }
        }
        break
      }

      case 'insert_horizontal_rule': {
        tr = state.tr.replaceSelectionWith(schema.nodes.horizontal_rule.create())
        break
      }

      case 'insert_table': {
        const rows = Math.min(20, Math.max(1, Number(params.rows) || 3))
        const cols = Math.min(10, Math.max(1, Number(params.cols) || 3))
        const headerRow = Boolean(params.headerRow)

        const makeRow = (isHeader: boolean) =>
          schema.nodes.table_row.create(
            null,
            Array.from({ length: cols }, () =>
              schema.nodes.table_cell.create(
                { header: isHeader },
                schema.nodes.paragraph.create()
              )
            )
          )

        const tableNode = schema.nodes.table.create(
          null,
          Array.from({ length: rows }, (_, i) => makeRow(headerRow && i === 0))
        )
        tr = state.tr.replaceSelectionWith(tableNode)
        break
      }

      case 'apply_preset_style': {
        return applyPreset(view, String(params.preset ?? ''), options)
      }

      case 'get_document_info': {
        return getDocumentInfo(state)
      }

      case 'set_page_config': {
        return applyPageConfig(params, options)
      }

      default:
        return { success: false, message: `未知工具: ${toolName}` }
    }

    dispatch(tr)
    view.focus()
    return { success: true, message: `已执行 ${toolName}` }
  } catch (err) {
    console.error('[executor] Error executing', toolName, err)
    return { success: false, message: String(err) }
  }
}

// ─── apply_preset_style ───────────────────────────────────────────────────────

function applyPreset(
  view: EditorView,
  preset: string,
  options?: ExecuteOptions
): ExecuteResult {
  const style = presetStyles[preset]
  if (!style) {
    return { success: false, message: `未找到预设样式: ${preset}` }
  }

  const { state, dispatch } = view
  let tr = state.tr

  // 1. Page config
  if (style.page && options?.pageConfig && options?.onPageConfigChange) {
    const pg = style.page
    const paperDims = PAPER_SIZES[pg.paperSize] ?? PAPER_SIZES['A4']
    let { pageWidth, pageHeight } = paperDims
    if (pg.orientation === 'landscape') {
      ;[pageWidth, pageHeight] = [pageHeight, pageWidth]
    }
    const newCfg: PageConfig = {
      ...options.pageConfig,
      pageWidth,
      pageHeight,
      marginTop: mmToPx(pg.marginTop ?? 25),
      marginBottom: mmToPx(pg.marginBottom ?? 25),
      marginLeft: mmToPx(pg.marginLeft ?? 25),
      marginRight: mmToPx(pg.marginRight ?? 25),
    }
    options.onPageConfigChange(newCfg)
  }

  // 2. Body text + paragraph style
  if (style.body) {
    const { fontFamily, fontSize, firstLineIndent, lineHeight, spaceBefore, spaceAfter, align } = style.body

    const textAttrs: Record<string, unknown> = {}
    if (fontFamily) textAttrs.fontFamily = mapFontFamily(fontFamily)
    if (fontSize != null) textAttrs.fontSize = fontSize

    const paraAttrs: Record<string, unknown> = {}
    if (firstLineIndent != null) paraAttrs.firstLineIndent = firstLineIndent
    if (lineHeight != null) paraAttrs.lineHeight = lineHeight
    if (spaceBefore != null) paraAttrs.spaceBefore = spaceBefore
    if (spaceAfter != null) paraAttrs.spaceAfter = spaceAfter
    if (align) paraAttrs.align = align

    state.doc.nodesBetween(0, state.doc.content.size, (node, pos) => {
      if (node.type.name !== 'paragraph') return

      // Apply text style to all text in the paragraph
      if (Object.keys(textAttrs).length > 0 && node.content.size > 0) {
        const from = pos + 1
        const to = pos + 1 + node.content.size
        tr = addTextMark(tr, state, from, to, textAttrs)
      }

      // Apply paragraph style
      if (Object.keys(paraAttrs).length > 0) {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...paraAttrs })
      }
    })
  }

  dispatch(tr)
  view.focus()
  return { success: true, message: `已应用「${preset}」样式` }
}

// ─── set_page_config ──────────────────────────────────────────────────────────

function applyPageConfig(
  params: Record<string, unknown>,
  options?: ExecuteOptions
): ExecuteResult {
  if (!options?.pageConfig || !options?.onPageConfigChange) {
    return { success: false, message: '无法修改页面配置：未提供配置回调' }
  }

  const base = options.pageConfig
  const paperSize = params.paperSize as string | undefined
  const orientation = params.orientation as string | undefined

  let { pageWidth, pageHeight } = base
  if (paperSize && PAPER_SIZES[paperSize]) {
    ;({ pageWidth, pageHeight } = PAPER_SIZES[paperSize])
  }
  if (orientation === 'landscape' && pageWidth < pageHeight) {
    ;[pageWidth, pageHeight] = [pageHeight, pageWidth]
  } else if (orientation === 'portrait' && pageWidth > pageHeight) {
    ;[pageWidth, pageHeight] = [pageHeight, pageWidth]
  }

  const newCfg: PageConfig = {
    pageWidth,
    pageHeight,
    marginTop: params.marginTop != null ? mmToPx(params.marginTop as number) : base.marginTop,
    marginBottom: params.marginBottom != null ? mmToPx(params.marginBottom as number) : base.marginBottom,
    marginLeft: params.marginLeft != null ? mmToPx(params.marginLeft as number) : base.marginLeft,
    marginRight: params.marginRight != null ? mmToPx(params.marginRight as number) : base.marginRight,
  }

  options.onPageConfigChange(newCfg)
  return { success: true, message: '页面配置已更新' }
}

// ─── get_document_info ────────────────────────────────────────────────────────

function getDocumentInfo(state: EditorState): ExecuteResult {
  let wordCount = 0
  let paragraphCount = 0

  state.doc.forEach((node) => {
    if (node.type.name === 'paragraph') {
      paragraphCount++
      wordCount += node.textContent.length
    }
  })

  return {
    success: true,
    message: `文档信息：${paragraphCount} 个段落，约 ${wordCount} 字`,
    data: { paragraphCount, wordCount },
  }
}
