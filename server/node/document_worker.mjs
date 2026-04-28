#!/usr/bin/env node
import { Schema, Fragment } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'

const DEFAULT_PAGE_CONFIG = {
  pageWidth: 794,
  pageHeight: 1123,
  marginTop: 96,
  marginBottom: 96,
  marginLeft: 113,
  marginRight: 113,
}

const schema = new Schema({
  nodes: {
    doc: { content: '(paragraph|table_of_contents|horizontal_rule|table|floating_object)+' },
    paragraph: {
      attrs: {
        align: { default: 'left' },
        firstLineIndent: { default: 0 },
        indent: { default: 0 },
        rightIndent: { default: 0 },
        headingLevel: { default: null },
        fontSizeHint: { default: null },
        fontFamilyHint: { default: null },
        lineHeight: { default: 1.5 },
        spaceBefore: { default: 0 },
        spaceAfter: { default: 0 },
        listType: { default: null },
        listLevel: { default: 0 },
        listChecked: { default: false },
        pageBreakBefore: { default: false },
        tabStops: { default: [] },
      },
      content: 'inline*',
      group: 'block',
      toDOM() { return ['p', 0] },
    },
    table_of_contents: {
      group: 'block',
      atom: true,
      selectable: true,
      attrs: {
        title: { default: '目录' },
        minLevel: { default: 1 },
        maxLevel: { default: 3 },
        hyperlink: { default: true },
      },
      toDOM() { return ['div', 0] },
    },
    table: { content: 'table_row+', group: 'block', tableRole: 'table', toDOM() { return ['table', ['tbody', 0]] } },
    table_row: { content: 'table_cell+', tableRole: 'row', toDOM() { return ['tr', 0] } },
    table_cell: {
      content: 'paragraph+',
      tableRole: 'cell',
      isolating: true,
      attrs: {
        header: { default: false },
        colspan: { default: 1 },
        rowspan: { default: 1 },
        width: { default: null },
        backgroundColor: { default: '' },
        borderColor: { default: '#cccccc' },
        borderWidth: { default: 1 },
      },
      toDOM() { return ['td', 0] },
    },
    horizontal_rule: {
      group: 'block',
      atom: true,
      selectable: true,
      attrs: {
        lineStyle: { default: 'solid' },
        lineColor: { default: '#cbd5e1' },
      },
      toDOM() { return ['hr'] },
    },
    floating_object: {
      group: 'block',
      atom: true,
      attrs: {
        kind: { default: 'textbox' },
        src: { default: '' },
        alt: { default: '' },
        title: { default: '' },
        width: { default: null },
        height: { default: null },
        positionX: { default: 0 },
        positionY: { default: 0 },
        relativeFromX: { default: 'column' },
        relativeFromY: { default: 'paragraph' },
        wrap: { default: 'none' },
        behindDoc: { default: false },
        allowOverlap: { default: true },
        distT: { default: 0 },
        distB: { default: 0 },
        distL: { default: 0 },
        distR: { default: 0 },
        paddingTop: { default: 0 },
        paddingRight: { default: 0 },
        paddingBottom: { default: 0 },
        paddingLeft: { default: 0 },
        paragraphs: { default: [] },
      },
      toDOM() { return ['div'] },
    },
    image: {
      inline: true,
      group: 'inline',
      draggable: true,
      attrs: {
        src: {},
        alt: { default: '' },
        title: { default: '' },
        width: { default: null },
        height: { default: null },
      },
      toDOM(node) { return ['img', node.attrs] },
    },
    text: { group: 'inline' },
  },
  marks: {
    textStyle: {
      attrs: {
        fontFamily: { default: 'SimSun, Songti SC, serif' },
        fontSize: { default: 12 },
        color: { default: '#000000' },
        backgroundColor: { default: '' },
        bold: { default: false },
        italic: { default: false },
        underline: { default: false },
        strikethrough: { default: false },
        superscript: { default: false },
        subscript: { default: false },
        letterSpacing: { default: 0 },
      },
      toDOM() { return ['span', 0] },
    },
    link: {
      attrs: { href: {} },
      inclusive: false,
      toDOM(mark) { return ['a', { href: mark.attrs.href }, 0] },
    },
    comment: {
      attrs: {
        id: { default: '' },
        author: { default: '' },
        date: { default: '' },
        content: { default: '' },
      },
      inclusive: false,
      spanning: true,
      toDOM() { return ['span', 0] },
    },
  },
})

const FONT_MAP = {
  宋体: 'SimSun, "Songti SC", serif',
  黑体: 'SimHei, "Heiti SC", sans-serif',
  楷体: 'KaiTi, "Kaiti SC", serif',
  仿宋: 'FangSong, STFangsong, serif',
  Arial: 'Arial, sans-serif',
  'Times New Roman': '"Times New Roman", Times, serif',
}

const HEADLESS_PAGE_GAP = 32

const DEFAULT_PARAGRAPH_ATTRS = {
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
  tabStops: [],
}

function ok(message, data = undefined, extra = {}) {
  return { success: true, message, data, ...extra }
}

function fail(message, data = undefined) {
  return { success: false, message, data }
}

function normalizeText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
}

function getParagraphs(doc) {
  const paragraphs = []
  let index = 0
  doc.forEach((node, pos) => {
    if (node.type.name === 'paragraph') paragraphs.push({ node, pos, index: index++ })
  })
  return paragraphs
}

function paragraphBounds(paragraph) {
  return { from: paragraph.pos + 1, to: paragraph.pos + paragraph.node.nodeSize - 1 }
}

function paragraphAt(doc, index) {
  return getParagraphs(doc).find(p => p.index === index)
}

function normalizeIndexes(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(Number).filter(v => Number.isInteger(v) && v >= 0))].sort((a, b) => a - b)
}

function paragraphOffsetToDocPos(paragraph, offset) {
  let consumed = 0
  let resolved = paragraph.pos + 1
  let found = false
  paragraph.node.forEach((child, childOffset) => {
    if (found || !child.isText) return
    const text = child.text ?? ''
    const next = consumed + text.length
    if (offset >= consumed && offset <= next) {
      resolved = paragraph.pos + 1 + childOffset + (offset - consumed)
      found = true
    }
    consumed = next
  })
  return Math.min(paragraph.pos + paragraph.node.nodeSize - 1, resolved)
}

function isBoundary(ch) {
  return !ch || !/[\p{L}\p{N}_]/u.test(ch)
}

function resolveContainsText(doc, range) {
  const needle = String(range?.text ?? '')
  if (!needle) return []
  const caseSensitive = range?.caseSensitive === true
  const matchMode = range?.matchMode === 'exact' ? 'exact' : 'contains'
  const requested = new Set(normalizeIndexes(range?.occurrenceIndexes))
  const occurrence = range?.textOccurrence === 'first' ? 'first' : 'all'
  const normalizedNeedle = caseSensitive ? needle : needle.toLocaleLowerCase()
  const matches = []
  let matchIndex = 0
  for (const paragraph of getParagraphs(doc)) {
    if (Number.isInteger(range?.paragraphIndex) && paragraph.index !== Number(range.paragraphIndex)) continue
    if (Number.isInteger(range?.from) && paragraph.index < Number(range.from)) continue
    if (Number.isInteger(range?.to) && paragraph.index > Number(range.to)) continue
    const scopedIndexes = normalizeIndexes(range?.paragraphIndexes)
    if (scopedIndexes.length > 0 && !scopedIndexes.includes(paragraph.index)) continue
    const sourceText = paragraph.node.textContent
    const haystack = caseSensitive ? sourceText : sourceText.toLocaleLowerCase()
    let searchFrom = 0
    while (searchFrom <= haystack.length) {
      const found = haystack.indexOf(normalizedNeedle, searchFrom)
      if (found === -1) break
      const endOffset = found + needle.length
      const accepted = matchMode === 'contains' || (isBoundary(sourceText[found - 1]) && isBoundary(sourceText[endOffset]))
      if (accepted) {
        const current = matchIndex++
        if (requested.size === 0 || requested.has(current)) {
          matches.push({
            paragraph,
            from: paragraphOffsetToDocPos(paragraph, found),
            to: paragraphOffsetToDocPos(paragraph, endOffset),
            startOffset: found,
            endOffset,
            matchText: sourceText.slice(found, endOffset),
            matchIndex: current,
          })
          if (occurrence === 'first') return matches
        }
      }
      searchFrom = found + Math.max(needle.length, 1)
    }
  }
  return matches
}

function resolveTextRanges(doc, range) {
  if (!Array.isArray(range?.textRanges)) return []
  const matches = []
  range.textRanges.forEach((item, index) => {
    const paragraphIndex = Number(item?.paragraphIndex)
    const startOffset = Number(item?.startOffset)
    const endOffset = Number(item?.endOffset)
    if (!Number.isInteger(paragraphIndex) || !Number.isInteger(startOffset) || !Number.isInteger(endOffset) || endOffset <= startOffset) return
    const paragraph = paragraphAt(doc, paragraphIndex)
    if (!paragraph) return
    const actual = paragraph.node.textContent.slice(startOffset, endOffset)
    if (typeof item.text === 'string') {
      const expected = item.text
      const caseSensitive = range?.caseSensitive === true
      if ((caseSensitive && actual !== expected) || (!caseSensitive && actual.toLocaleLowerCase() !== expected.toLocaleLowerCase())) return
    }
    matches.push({
      paragraph,
      from: paragraphOffsetToDocPos(paragraph, startOffset),
      to: paragraphOffsetToDocPos(paragraph, endOffset),
      startOffset,
      endOffset,
      matchText: actual,
      matchIndex: index,
    })
  })
  return matches
}

function resolveSelection(doc, range, selectionContext) {
  const from = Number(range?.selectionFrom ?? selectionContext?.from)
  const to = Number(range?.selectionTo ?? selectionContext?.to)
  if (Number.isFinite(from) && Number.isFinite(to) && Math.min(from, to) < Math.max(from, to)) {
    return [{ from: Math.max(1, Math.min(from, to)), to: Math.min(doc.nodeSize - 1, Math.max(from, to)), paragraph: { node: doc, pos: 0, index: -1 } }]
  }
  return []
}

function resolveParagraphRange(doc, range, selectionContext) {
  const paragraphs = getParagraphs(doc)
  if (!range?.type || range.type === 'all') return paragraphs
  if (range.type === 'paragraph') return paragraphs.filter(p => p.index === Number(range.paragraphIndex))
  if (range.type === 'paragraphs') return paragraphs.filter(p => p.index >= Number(range.from ?? 0) && p.index <= Number(range.to ?? Number.POSITIVE_INFINITY))
  if (range.type === 'paragraph_indexes') {
    const indexes = normalizeIndexes(range.paragraphIndexes)
    return paragraphs.filter(p => indexes.includes(p.index))
  }
  if (range.type === 'first_paragraph') return paragraphs.slice(0, 1)
  if (range.type === 'last_paragraph') return paragraphs.slice(-1)
  if (range.type === 'odd_paragraphs') return paragraphs.filter(p => p.index % 2 === 0)
  if (range.type === 'even_paragraphs') return paragraphs.filter(p => p.index % 2 === 1)
  if (range.type === 'contains_text') return [...new Map(resolveContainsText(doc, range).map(m => [m.paragraph.index, m.paragraph])).values()]
  if (range.type === 'text_ranges') return [...new Map(resolveTextRanges(doc, range).map(m => [m.paragraph.index, m.paragraph])).values()]
  if (range.type === 'selection') {
    const bounds = resolveSelection(doc, range, selectionContext)[0]
    if (!bounds) return []
    return paragraphs.filter(p => {
      const b = paragraphBounds(p)
      return b.from < bounds.to && b.to > bounds.from
    })
  }
  return []
}

function resolveTextMatches(doc, range, selectionContext) {
  if (range?.type === 'contains_text') return resolveContainsText(doc, range)
  if (range?.type === 'text_ranges') return resolveTextRanges(doc, range)
  if (range?.type === 'selection') return resolveSelection(doc, range, selectionContext)
  return resolveParagraphRange(doc, range, selectionContext).map((paragraph, index) => ({
    paragraph,
    ...paragraphBounds(paragraph),
    startOffset: 0,
    endOffset: paragraph.node.textContent.length,
    matchText: paragraph.node.textContent,
    matchIndex: index,
  }))
}

function validateRange(name, range) {
  if (!range || typeof range !== 'object' || Array.isArray(range)) return `${name} 缺少 range 参数`
  if (range.type === 'contains_text' && !String(range.text ?? '').trim()) return `${name} 的 contains_text range 缺少 text`
  if (range.type === 'text_ranges' && !Array.isArray(range.textRanges)) return `${name} 的 text_ranges range 缺少 textRanges`
  return null
}

function addTextMark(tr, state, from, to, attrs) {
  if (from >= to) return tr
  let existing = {}
  state.doc.nodesBetween(from, to, node => {
    if (!node.isText) return
    const mark = node.marks.find(item => item.type === schema.marks.textStyle)
    if (mark) existing = { ...mark.attrs }
  })
  return tr.addMark(from, to, schema.marks.textStyle.create({ ...existing, ...attrs }))
}

function buildParagraphNode(text, attrs = undefined) {
  return schema.nodes.paragraph.create(attrs, text ? schema.text(text) : undefined)
}

function inheritedParagraphAttrs(attrs = undefined, options = {}) {
  return {
    ...(attrs ?? {}),
    pageBreakBefore: options.preservePageBreakBefore ? Boolean(attrs?.pageBreakBefore) : false,
  }
}

function buildParagraphNodesFromText(text, attrs = undefined, options = {}) {
  const parts = normalizeText(text) === '' ? [''] : normalizeText(text).split('\n')
  return parts.map((part, index) => buildParagraphNode(part, inheritedParagraphAttrs(attrs, {
    preservePageBreakBefore: options.preserveFirstPageBreakBefore && index === 0,
  })))
}

function getInsertPosAfterParagraph(doc, index) {
  if (index === -1) return 0
  const paragraph = paragraphAt(doc, index)
  return paragraph ? paragraph.pos + paragraph.node.nodeSize : null
}

function insertBlockAfterParagraph(state, paragraphIndex, node) {
  const insertPos = getInsertPosAfterParagraph(state.doc, paragraphIndex)
  if (insertPos == null) return null
  const fragment = insertPos >= state.doc.content.size && node.type !== schema.nodes.paragraph
    ? Fragment.fromArray([node, schema.nodes.paragraph.create()])
    : Fragment.from(node)
  return state.tr.insert(insertPos, fragment)
}

function representativeTextStyle(node) {
  let attrs = {}
  node.forEach(child => {
    if (Object.keys(attrs).length > 0 || !child.isText) return
    const mark = child.marks.find(item => item.type.name === 'textStyle')
    if (mark) attrs = mark.attrs
  })
  return {
    fontFamily: String(attrs.fontFamily ?? '宋体'),
    fontSize: Number(attrs.fontSize ?? 12),
    color: String(attrs.color ?? '#000000'),
    backgroundColor: String(attrs.backgroundColor ?? ''),
    bold: Boolean(attrs.bold ?? false),
    italic: Boolean(attrs.italic ?? false),
    underline: Boolean(attrs.underline ?? false),
    strikethrough: Boolean(attrs.strikethrough ?? false),
    superscript: Boolean(attrs.superscript ?? false),
    subscript: Boolean(attrs.subscript ?? false),
    letterSpacing: Number(attrs.letterSpacing ?? 0),
  }
}

function paragraphSnapshot(paragraph) {
  const para = paragraph.node.attrs
  return {
    index: paragraph.index,
    text: paragraph.node.textContent,
    charCount: paragraph.node.textContent.length,
    style: {
      ...representativeTextStyle(paragraph.node),
      align: String(para.align ?? 'left'),
      firstLineIndent: Number(para.firstLineIndent ?? 0),
      indent: Number(para.indent ?? 0),
      headingLevel: para.headingLevel == null ? null : Number(para.headingLevel),
      lineHeight: Number(para.lineHeight ?? 1.5),
      spaceBefore: Number(para.spaceBefore ?? 0),
      spaceAfter: Number(para.spaceAfter ?? 0),
      listType: para.listType ?? 'none',
      listChecked: Boolean(para.listChecked ?? false),
      pageBreakBefore: Boolean(para.pageBreakBefore ?? false),
    },
  }
}

function paragraphRole(node) {
  const attrs = node.attrs ?? {}
  if (attrs.headingLevel != null) return 'heading'
  if (attrs.listType) return 'list_item'
  return 'paragraph'
}

function paragraphContentSnapshot(node, paragraphIndex) {
  const attrs = node.attrs ?? {}
  const inlineImages = []
  let imageIndex = 0
  node.forEach(child => {
    if (child.type.name !== 'image') return
    inlineImages.push({
      imageIndex,
      alt: String(child.attrs.alt ?? ''),
      title: String(child.attrs.title ?? ''),
      width: child.attrs.width == null ? null : Number(child.attrs.width),
      height: child.attrs.height == null ? null : Number(child.attrs.height),
      srcKind: String(child.attrs.src ?? '').startsWith('data:') ? 'data' : 'url',
    })
    imageIndex += 1
  })
  return {
    type: 'paragraph',
    paragraphIndex,
    role: paragraphRole(node),
    headingLevel: attrs.headingLevel == null ? null : Number(attrs.headingLevel),
    listType: attrs.listType ?? null,
    listLevel: Number(attrs.listLevel ?? 0),
    text: node.textContent,
    inlineImages,
  }
}

function compactSnapshots(doc, indexes) {
  const paragraphs = getParagraphs(doc)
  const set = new Set(indexes)
  return paragraphs.filter(p => set.has(p.index)).map(paragraphSnapshot)
}

function tableSnapshot(node) {
  const rows = node.content.content.map((rowNode, rowIndex) => ({
    rowIndex,
    cells: rowNode.content.content.map(cellNode => ({
      header: Boolean(cellNode.attrs.header ?? false),
      text: cellNode.textContent,
      colspan: Number(cellNode.attrs.colspan ?? 1),
      rowspan: Number(cellNode.attrs.rowspan ?? 1),
    })),
  }))
  return { rowCount: rows.length, colCount: rows.reduce((max, row) => Math.max(max, row.cells.length), 0), rows }
}

function tableContentSnapshot(node, tableIndex) {
  const rows = node.content.content.map((rowNode, rowIndex) => ({
    rowIndex,
    cells: rowNode.content.content.map((cellNode, columnIndex) => ({
      columnIndex,
      text: cellNode.textContent,
    })),
  }))
  return {
    type: 'table',
    tableIndex,
    rowCount: rows.length,
    colCount: rows.reduce((max, row) => Math.max(max, row.cells.length), 0),
    rows,
  }
}

function documentBlockRefs(doc) {
  const blocks = []
  let paragraphIndex = 0
  let tableIndex = 0
  let tocIndex = 0
  doc.forEach((node, pos, blockIndex) => {
    const block = { node, pos, blockIndex }
    if (node.type.name === 'paragraph') {
      blocks.push({ ...block, paragraphIndex })
      paragraphIndex += 1
      return
    }
    if (node.type.name === 'table') {
      blocks.push({ ...block, tableIndex })
      tableIndex += 1
      return
    }
    if (node.type.name === 'table_of_contents') {
      blocks.push({ ...block, tocIndex })
      tocIndex += 1
      return
    }
    blocks.push(block)
  })
  return blocks
}

function blockContentSnapshot(block) {
  const { node } = block
  if (node.type.name === 'paragraph') {
    return { blockIndex: block.blockIndex, ...paragraphContentSnapshot(node, block.paragraphIndex) }
  }
  if (node.type.name === 'table') {
    return { blockIndex: block.blockIndex, ...tableContentSnapshot(node, block.tableIndex) }
  }
  if (node.type.name === 'table_of_contents') {
    return {
      blockIndex: block.blockIndex,
      type: 'table_of_contents',
      tocIndex: block.tocIndex,
      title: String(node.attrs.title ?? '目录'),
      text: node.textContent,
    }
  }
  if (node.type.name === 'horizontal_rule') {
    return { blockIndex: block.blockIndex, type: 'horizontal_rule', text: '' }
  }
  if (node.type.name === 'floating_object') {
    return {
      blockIndex: block.blockIndex,
      type: 'floating_object',
      kind: String(node.attrs.kind ?? ''),
      text: Array.isArray(node.attrs.paragraphs) ? node.attrs.paragraphs.join('\n') : '',
    }
  }
  return { blockIndex: block.blockIndex, type: node.type.name, text: node.textContent }
}

function blockText(block) {
  const snapshot = blockContentSnapshot(block)
  if (snapshot.type === 'table') {
    return snapshot.rows.map(row => row.cells.map(cell => cell.text).join(' | ')).join('\n')
  }
  return String(snapshot.text ?? '')
}

function documentContentSnapshot(doc, from, to) {
  const blocks = documentBlockRefs(doc)
  const selectedBlocks = blocks.filter(block => (
    block.paragraphIndex == null || (block.paragraphIndex >= from && block.paragraphIndex <= to)
  ))
  const paragraphIndexes = selectedBlocks
    .map(block => block.paragraphIndex)
    .filter(index => Number.isInteger(index))
  const snapshots = selectedBlocks.map(blockContentSnapshot)
  return {
    fromParagraph: from,
    toParagraph: to,
    paragraphCount: paragraphIndexes.length,
    totalChars: snapshots.reduce((sum, block) => sum + String(block.text ?? '').length, 0),
    paragraphs: snapshots.filter(block => block.type === 'paragraph'),
    blocks: snapshots,
  }
}

function hashString(value) {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function collectTables(doc) {
  const tables = []
  let tableIndex = 0
  doc.forEach((node, pos) => {
    if (node.type.name === 'table') {
      tables.push({ node, pos, index: tableIndex++ })
    }
  })
  return tables
}

function hasMergedCells(tableNode) {
  return tableNode.content.content.some(row => row.content.content.some(cell => (
    Number(cell.attrs.colspan ?? 1) !== 1 || Number(cell.attrs.rowspan ?? 1) !== 1
  )))
}

function tableDimensions(tableNode) {
  const rows = tableNode.content.content
  return {
    rows: rows.length,
    cols: rows.reduce((max, row) => Math.max(max, row.childCount), 0),
  }
}

function findTableCellBySelection(table, selectionContext) {
  const from = Number(selectionContext?.from)
  if (!Number.isFinite(from)) return null
  let rowStart = table.pos + 1
  for (let rowIndex = 0; rowIndex < table.node.childCount; rowIndex += 1) {
    const row = table.node.child(rowIndex)
    const rowEnd = rowStart + row.nodeSize
    if (from >= rowStart && from <= rowEnd) {
      let cellStart = rowStart + 1
      for (let columnIndex = 0; columnIndex < row.childCount; columnIndex += 1) {
        const cell = row.child(columnIndex)
        const cellEnd = cellStart + cell.nodeSize
        if (from >= cellStart && from <= cellEnd) return { rowIndex, columnIndex }
        cellStart = cellEnd
      }
    }
    rowStart = rowEnd
  }
  return null
}

function resolveTableTarget(doc, params, selectionContext) {
  const tables = collectTables(doc)
  if (tables.length === 0) return { error: '文档中没有表格' }
  let tableIndex = Number(params.tableIndex ?? params.table)
  if (!Number.isInteger(tableIndex)) tableIndex = 0
  let table = tables.find(item => item.index === tableIndex)
  let selectedCell = null
  if (!table && Number.isFinite(Number(selectionContext?.from))) {
    table = tables.find(item => {
      const from = Number(selectionContext.from)
      return from >= item.pos && from <= item.pos + item.node.nodeSize
    })
  }
  if (!table) return { error: `未找到第 ${tableIndex + 1} 个表格` }
  selectedCell = findTableCellBySelection(table, selectionContext)
  const rowIndex = Number.isInteger(Number(params.rowIndex)) ? Number(params.rowIndex) : selectedCell?.rowIndex
  const columnIndex = Number.isInteger(Number(params.columnIndex)) ? Number(params.columnIndex) : selectedCell?.columnIndex
  return { table, rowIndex, columnIndex }
}

function emptyCellFrom(referenceCell) {
  const attrs = referenceCell ? { ...referenceCell.attrs } : {}
  return schema.nodes.table_cell.create(attrs, schema.nodes.paragraph.create())
}

function executeTableStructureTool(state, tr, toolName, params, selectionContext) {
  const target = resolveTableTarget(state.doc, params, selectionContext)
  if (target.error) return fail(target.error)
  const { table, rowIndex, columnIndex } = target
  if (hasMergedCells(table.node)) return fail('当前后端版本暂不支持对含合并单元格的表格增删行列')
  const dims = tableDimensions(table.node)
  const rows = table.node.content.content

  if (toolName.includes('row')) {
    if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= dims.rows) return fail('表格行工具需要有效 rowIndex，或当前 selection 位于表格单元格内')
    if (toolName === 'delete_table_row' && dims.rows <= 1) return fail('不能删除表格中的最后一行')
    let nextRows
    if (toolName === 'delete_table_row') {
      nextRows = rows.filter((_, index) => index !== rowIndex)
    } else {
      const referenceRow = rows[rowIndex]
      const newRow = schema.nodes.table_row.create(null, Array.from({ length: dims.cols }, (_, col) => emptyCellFrom(referenceRow?.child(col))))
      const insertAt = toolName === 'insert_table_row_before' ? rowIndex : rowIndex + 1
      nextRows = [...rows.slice(0, insertAt), newRow, ...rows.slice(insertAt)]
    }
    const nextTable = schema.nodes.table.create(table.node.attrs, nextRows)
    tr.replaceWith(table.pos, table.pos + table.node.nodeSize, nextTable)
    return ok(toolName === 'delete_table_row' ? '已删除表格行' : '已插入表格行', { table: tableSnapshot(nextTable) }, { docJson: tr.doc.toJSON() })
  }

  if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= dims.cols) return fail('表格列工具需要有效 columnIndex，或当前 selection 位于表格单元格内')
  if (toolName === 'delete_table_column' && dims.cols <= 1) return fail('不能删除表格中的最后一列')
  const nextRows = rows.map(row => {
    const cells = row.content.content
    let nextCells
    if (toolName === 'delete_table_column') {
      nextCells = cells.filter((_, index) => index !== columnIndex)
    } else {
      const referenceCell = cells[columnIndex]
      const insertAt = toolName === 'insert_table_column_before' ? columnIndex : columnIndex + 1
      nextCells = [...cells.slice(0, insertAt), emptyCellFrom(referenceCell), ...cells.slice(insertAt)]
    }
    return schema.nodes.table_row.create(row.attrs, nextCells)
  })
  const nextTable = schema.nodes.table.create(table.node.attrs, nextRows)
  tr.replaceWith(table.pos, table.pos + table.node.nodeSize, nextTable)
  return ok(toolName === 'delete_table_column' ? '已删除表格列' : '已插入表格列', { table: tableSnapshot(nextTable) }, { docJson: tr.doc.toJSON() })
}

function buildMarkdownNodes(markdown, attrs = undefined, options = {}) {
  const lines = normalizeText(markdown).split('\n')
  const nodes = []
  let tableBuffer = []
  let paragraphOrdinal = 0
  const nextParagraphAttrs = (overrides = {}) => {
    const inherited = inheritedParagraphAttrs(attrs, {
      preservePageBreakBefore: options.preserveFirstPageBreakBefore && paragraphOrdinal === 0,
    })
    paragraphOrdinal += 1
    return { ...inherited, ...overrides }
  }
  const flushTable = () => {
    if (tableBuffer.length < 2 || !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(tableBuffer[1] ?? '')) {
      for (const line of tableBuffer) {
        if (line.trim()) nodes.push(buildParagraphNode(line, nextParagraphAttrs()))
      }
      tableBuffer = []
      return
    }
    const tableRows = tableBuffer
      .filter((_, index) => index !== 1)
      .map(line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim()))
    const cols = Math.max(1, ...tableRows.map(row => row.length))
    const table = schema.nodes.table.create(null, tableRows.map((row, rowIndex) => schema.nodes.table_row.create(null, Array.from({ length: cols }, (_, colIndex) => schema.nodes.table_cell.create({ header: rowIndex === 0 }, buildParagraphNodesFromText(row[colIndex] ?? ''))))))
    nodes.push(table)
    tableBuffer = []
  }
  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    if (line.includes('|') && line.trim().startsWith('|')) {
      tableBuffer.push(line)
      continue
    }
    if (tableBuffer.length > 0) flushTable()
    if (!line.trim()) continue
    if (/^\s*-{3,}\s*$/.test(line)) {
      nodes.push(schema.nodes.horizontal_rule.create())
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      nodes.push(buildParagraphNode(heading[2], nextParagraphAttrs({ headingLevel: heading[1].length })))
      continue
    }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/)
    if (bullet) {
      nodes.push(buildParagraphNode(bullet[1], nextParagraphAttrs({ listType: 'bullet' })))
      continue
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/)
    if (ordered) {
      nodes.push(buildParagraphNode(ordered[1], nextParagraphAttrs({ listType: 'ordered' })))
      continue
    }
    nodes.push(buildParagraphNode(line, nextParagraphAttrs()))
  }
  if (tableBuffer.length > 0) flushTable()
  return nodes.length > 0 ? nodes : [buildParagraphNode('', nextParagraphAttrs())]
}

async function renderMermaidDataUrl(code) {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<!doctype html><html><body><div id="graph"></div></body></html>')
    await page.addScriptTag({ path: 'node_modules/mermaid/dist/mermaid.min.js' })
    const svg = await page.evaluate(async source => {
      window.mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' })
      const rendered = await window.mermaid.render(`server-mermaid-${Date.now()}`, source)
      return rendered.svg
    }, code)
    const b64 = Buffer.from(svg, 'utf8').toString('base64')
    return `data:image/svg+xml;base64,${b64}`
  } finally {
    await browser.close()
  }
}

async function measurePageBlockIndexes(doc, pageConfig, pageNumber) {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  let renderPage = null
  let staticServer = null
  try {
    const opened = await openFrontendRendererPage(browser, doc.toJSON(), pageConfig)
    renderPage = opened.renderPage
    staticServer = opened.staticServer
    const renderError = await renderPage.evaluate(() => window.__OPENWPS_HEADLESS_ERROR__ ?? null)
    if (renderError) throw new Error(`前端 headless 渲染失败：${renderError}`)
    const metrics = await renderPage.evaluate(() => window.__OPENWPS_HEADLESS_READY__)
    const pageCount = Math.max(1, Number(metrics?.pageCount ?? 1) || 1)
    const blockIndexesByPage = Array.isArray(metrics?.blockIndexesByPage) ? metrics.blockIndexesByPage : []
    const blockIndexes = Array.isArray(blockIndexesByPage[pageNumber - 1])
      ? blockIndexesByPage[pageNumber - 1].filter(index => Number.isInteger(index))
      : []
    return { pageCount, blockIndexes: [...new Set(blockIndexes)] }
  } finally {
    if (renderPage) await renderPage.close().catch(() => undefined)
    if (staticServer) await new Promise(resolveClose => staticServer.close(resolveClose))
    await browser.close()
  }
}

async function getPageBlocks(doc, pageConfig, pageNumber) {
  const blocks = documentBlockRefs(doc)
  try {
    const measured = await measurePageBlockIndexes(doc, pageConfig, pageNumber)
    if (pageNumber > measured.pageCount) return { error: `未找到第 ${pageNumber} 页，当前服务端渲染约 ${measured.pageCount} 页` }
    const selected = measured.blockIndexes
      .map(index => blocks[index])
      .filter(Boolean)
    return { pageCount: measured.pageCount, blocks: selected.length > 0 ? selected : [] }
  } catch {
    if (pageNumber !== 1) return { error: `未找到第 ${pageNumber} 页，服务端当前只能回退读取第 1 页结构` }
    return { pageCount: 1, blocks }
  }
}

async function getPageContent(doc, pageConfig, params) {
  const pageNumber = Number(params.page ?? 1)
  if (!Number.isInteger(pageNumber) || pageNumber < 1) return fail('page 必须是从 1 开始的整数')
  const pageBlocks = await getPageBlocks(doc, pageConfig, pageNumber)
  if (pageBlocks.error) return fail(pageBlocks.error)
  const paragraphIndexes = pageBlocks.blocks
    .map(block => block.paragraphIndex)
    .filter(index => Number.isInteger(index))
  const snapshots = pageBlocks.blocks.map(blockContentSnapshot)
  const text = pageBlocks.blocks.map(blockText).filter(Boolean).join('\n')
  return ok(`已读取第 ${pageNumber} 页文字结构`, {
    detail: 'content',
    page: pageNumber,
    pageCount: pageBlocks.pageCount,
    blockCount: snapshots.length,
    paragraphIndexes,
    paragraphRange: paragraphIndexes.length > 0
      ? { from: Math.min(...paragraphIndexes), to: Math.max(...paragraphIndexes) }
      : null,
    text,
    blocks: snapshots,
  })
}

async function getPageStyleSummary(doc, pageConfig, params) {
  const pageNumber = Number(params.page ?? 1)
  if (!Number.isInteger(pageNumber) || pageNumber < 1) return fail('page 必须是从 1 开始的整数')
  const pageBlocks = await getPageBlocks(doc, pageConfig, pageNumber)
  if (pageBlocks.error) return fail(pageBlocks.error)
  const paragraphIndexes = pageBlocks.blocks
    .map(block => block.paragraphIndex)
    .filter(index => Number.isInteger(index))
  return ok(`已读取第 ${pageNumber} 页样式摘要`, {
    page: pageNumber,
    pageCount: pageBlocks.pageCount,
    paragraphIndexes,
    paragraphRange: paragraphIndexes.length > 0
      ? { from: Math.min(...paragraphIndexes), to: Math.max(...paragraphIndexes) }
      : null,
    paragraphs: compactSnapshots(doc, paragraphIndexes),
    blocks: pageBlocks.blocks.map(block => ({ blockIndex: block.blockIndex, type: block.node.type.name, text: block.node.textContent })),
  })
}

function appendHeadlessRenderParam(url) {
  const parsed = new URL(url)
  parsed.searchParams.set('openwpsHeadlessRender', '1')
  return parsed.toString()
}

function contentTypeForPath(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8'
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8'
  if (filePath.endsWith('.svg')) return 'image/svg+xml'
  if (filePath.endsWith('.png')) return 'image/png'
  if (filePath.endsWith('.ico')) return 'image/x-icon'
  return 'application/octet-stream'
}

async function startStaticDistRendererServer() {
  const { createServer } = await import('node:http')
  const { readFile, stat } = await import('node:fs/promises')
  const { resolve, join } = await import('node:path')
  const distRoot = resolve('dist')
  await stat(join(distRoot, 'index.html'))

  const server = createServer(async (request, response) => {
    try {
      const parsed = new URL(request.url ?? '/', 'http://127.0.0.1')
      const pathname = decodeURIComponent(parsed.pathname).replace(/^\/+/, '')
      let filePath = resolve(distRoot, pathname || 'index.html')
      if (!filePath.startsWith(distRoot)) {
        response.writeHead(403)
        response.end('Forbidden')
        return
      }
      try {
        const info = await stat(filePath)
        if (info.isDirectory()) filePath = join(filePath, 'index.html')
      } catch {
        filePath = join(distRoot, 'index.html')
      }
      const data = await readFile(filePath)
      response.writeHead(200, { 'Content-Type': contentTypeForPath(filePath) })
      response.end(data)
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end(error instanceof Error ? error.message : String(error))
    }
  })

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法启动前端 headless 静态渲染服务')
  return {
    server,
    url: `http://127.0.0.1:${address.port}/?openwpsHeadlessRender=1`,
  }
}

async function openFrontendRendererPage(browser, docJson, pageConfig) {
  const renderPage = await browser.newPage({
    viewport: { width: pageConfig.pageWidth, height: pageConfig.pageHeight },
    deviceScaleFactor: 1,
  })
  const payload = { docJson, pageConfig }
  await renderPage.addInitScript(value => {
    window.__OPENWPS_HEADLESS_PAYLOAD__ = value
    window.sessionStorage.setItem('openwps.headless.payload', JSON.stringify(value))
  }, payload)

  let lastError = null
  try {
    await renderPage.goto(appendHeadlessRenderParam(process.env.OPENWPS_HEADLESS_RENDERER_URL || 'http://localhost:5174/'), {
      waitUntil: 'networkidle',
      timeout: 10000,
    })
    await renderPage.waitForFunction(() => window.__OPENWPS_HEADLESS_READY__ || window.__OPENWPS_HEADLESS_ERROR__, null, { timeout: 10000 })
    return { renderPage, staticServer: null }
  } catch (error) {
    lastError = error
  }

  const staticRenderer = await startStaticDistRendererServer()
  try {
    await renderPage.goto(staticRenderer.url, { waitUntil: 'networkidle', timeout: 10000 })
    await renderPage.waitForFunction(() => window.__OPENWPS_HEADLESS_READY__ || window.__OPENWPS_HEADLESS_ERROR__, null, { timeout: 10000 })
    return { renderPage, staticServer: staticRenderer.server }
  } catch (error) {
    await new Promise(resolveClose => staticRenderer.server.close(resolveClose))
    throw error || lastError
  }
}

async function capturePageScreenshot(doc, pageConfig, params) {
  const pageNumber = Number(params.page ?? 1)
  if (!Number.isInteger(pageNumber) || pageNumber < 1) return fail('page 必须是从 1 开始的整数')
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  let renderPage = null
  let staticServer = null
  try {
    const opened = await openFrontendRendererPage(browser, doc.toJSON(), pageConfig)
    renderPage = opened.renderPage
    staticServer = opened.staticServer
    const renderError = await renderPage.evaluate(() => window.__OPENWPS_HEADLESS_ERROR__ ?? null)
    if (renderError) return fail(`前端 headless 渲染失败：${renderError}`)
    await renderPage.evaluate(() => document.fonts?.ready)
    const metrics = await renderPage.evaluate(() => window.__OPENWPS_HEADLESS_READY__)
    const pageCount = Math.max(1, Number(metrics?.pageCount ?? 1) || 1)
    if (pageNumber > pageCount) return fail(`未找到第 ${pageNumber} 页，当前服务端渲染约 ${pageCount} 页`)
    const pageGap = Number(metrics?.pageGap ?? HEADLESS_PAGE_GAP) || HEADLESS_PAGE_GAP
    const clipY = (pageNumber - 1) * (pageConfig.pageHeight + pageGap)
    const totalHeight = pageCount * pageConfig.pageHeight + Math.max(0, pageCount - 1) * pageGap
    await renderPage.setViewportSize({
      width: pageConfig.pageWidth,
      height: Math.max(pageConfig.pageHeight, Math.min(totalHeight, 16000)),
    })
    const bytes = await renderPage.screenshot({
      type: 'png',
      clip: {
        x: 0,
        y: clipY,
        width: pageConfig.pageWidth,
        height: pageConfig.pageHeight,
      },
    })
    const dataUrl = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`
    const paragraphs = getParagraphs(doc)
    return ok(`已截取第 ${pageNumber} 页截图`, {
      page: pageNumber,
      pageCount,
      paragraphIndexes: paragraphs.map(p => p.index),
      paragraphRange: paragraphs.length > 0 ? { from: paragraphs[0].index, to: paragraphs.at(-1).index } : null,
      previewText: doc.textContent.slice(0, 180),
      width: pageConfig.pageWidth,
      height: pageConfig.pageHeight,
      instruction: String(params.instruction ?? ''),
      renderer: 'frontend-pretext-headless',
      dataUrl,
    })
  } catch (error) {
    return fail(`服务端页面截图失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (renderPage) await renderPage.close().catch(() => undefined)
    if (staticServer) await new Promise(resolveClose => staticServer.close(resolveClose))
    await browser.close()
  }
}

function collectImages(doc, pageConfig) {
  const images = []
  const occurrences = new Map()
  const paragraphs = getParagraphs(doc)
  for (const paragraph of paragraphs) {
    let imageIndex = 0
    paragraph.node.forEach(child => {
      if (child.type.name !== 'image') return
      const attrs = child.attrs
      const fingerprint = hashString(JSON.stringify({
        src: String(attrs.src ?? ''),
        alt: String(attrs.alt ?? ''),
        title: String(attrs.title ?? ''),
        width: attrs.width ?? null,
        height: attrs.height ?? null,
      }))
      const occurrence = occurrences.get(fingerprint) ?? 0
      occurrences.set(fingerprint, occurrence + 1)
      images.push({
        imageId: `img_${fingerprint}_${occurrence}`,
        fingerprint,
        paragraphIndex: paragraph.index,
        imageIndex,
        page: 1,
        alt: String(attrs.alt ?? ''),
        title: String(attrs.title ?? ''),
        width: attrs.width == null ? null : Number(attrs.width),
        height: attrs.height == null ? null : Number(attrs.height),
        srcKind: String(attrs.src ?? '').startsWith('data:') ? 'data' : 'url',
        dataUrl: String(attrs.src ?? ''),
        beforeText: paragraphs.find(p => p.index === paragraph.index - 1)?.node.textContent ?? '',
        paragraphText: paragraph.node.textContent,
        afterText: paragraphs.find(p => p.index === paragraph.index + 1)?.node.textContent ?? '',
      })
      imageIndex += 1
    })
  }
  return images
}

function locateDocumentImage(doc, pageConfig, params) {
  const images = collectImages(doc, pageConfig)
  const imageId = String(params.imageId ?? '')
  const paragraphIndex = Number(params.paragraphIndex)
  const imageIndex = Number(params.imageIndex ?? 0)
  const target = imageId
    ? images.find(image => image.imageId === imageId)
    : images.find(image => image.paragraphIndex === paragraphIndex && image.imageIndex === imageIndex)
  if (!target) return fail('未找到指定的文档图片', { availableImages: images.map(({ dataUrl, ...image }) => image) })
  return ok(`已定位文档图片：${target.imageId}`, { target, availableImageCount: images.length })
}

async function execute(input) {
  const toolName = String(input.toolName ?? '')
  const params = input.params && typeof input.params === 'object' ? input.params : {}
  const pageConfig = { ...DEFAULT_PAGE_CONFIG, ...(input.pageConfig || {}) }
  let state
  try {
    state = EditorState.create({ doc: schema.nodeFromJSON(input.docJson) })
  } catch (error) {
    return fail(`文档 JSON 无效：${error instanceof Error ? error.message : String(error)}`)
  }
  let tr = state.tr
  const selectionContext = input.selectionContext || null

  switch (toolName) {
    case 'search_text': {
      const text = String(params.text ?? '')
      if (!text) return fail('search_text 需要 text')
      const matches = resolveContainsText(state.doc, {
        type: 'contains_text',
        text,
        caseSensitive: params.caseSensitive === true,
        matchMode: params.matchMode === 'exact' ? 'exact' : 'contains',
        paragraphIndex: Number.isInteger(params.paragraphIndex) ? Number(params.paragraphIndex) : undefined,
        from: Number.isInteger(params.fromParagraph) ? Number(params.fromParagraph) : undefined,
        to: Number.isInteger(params.toParagraph) ? Number(params.toParagraph) : undefined,
        paragraphIndexes: normalizeIndexes(params.paragraphIndexes),
      })
      const maxResults = Math.max(1, Math.min(200, Number(params.maxResults ?? 80) || 80))
      const returned = matches.slice(0, maxResults).map(match => ({
        matchIndex: match.matchIndex,
        paragraphIndex: match.paragraph.index,
        startOffset: match.startOffset,
        endOffset: match.endOffset,
        text: match.matchText,
        range: { type: 'text_ranges', caseSensitive: true, textRanges: [{ paragraphIndex: match.paragraph.index, startOffset: match.startOffset, endOffset: match.endOffset, text: match.matchText }] },
      }))
      return ok(matches.length > 0 ? `找到 ${matches.length} 处匹配文字` : `未找到文字“${text}”`, {
        query: text,
        matchCount: matches.length,
        returnedCount: returned.length,
        matches: returned,
        lockedRange: { type: 'text_ranges', caseSensitive: true, textRanges: returned.map(match => ({ paragraphIndex: match.paragraphIndex, startOffset: match.startOffset, endOffset: match.endOffset, text: match.text })) },
      })
    }

    case 'get_document_info': {
      const paragraphs = getParagraphs(state.doc)
      return ok(`文档共 ${paragraphs.length} 个段落，约 ${state.doc.textContent.length} 字`, {
        paragraphCount: paragraphs.length,
        wordCount: state.doc.textContent.length,
        pageCount: 1,
        pageBreakCount: paragraphs.filter(p => p.node.attrs.pageBreakBefore).length,
        blockCounts: Object.fromEntries(Object.entries(state.doc.content.content.reduce((acc, node) => ({ ...acc, [node.type.name]: (acc[node.type.name] ?? 0) + 1 }), {}))),
      })
    }

    case 'get_document_outline':
    case 'get_document_content': {
      const paragraphs = getParagraphs(state.doc)
      const from = Number.isInteger(params.fromParagraph) ? Number(params.fromParagraph) : 0
      const to = Number.isInteger(params.toParagraph) ? Number(params.toParagraph) : Math.max(0, paragraphs.length - 1)
      const selected = paragraphs.filter(p => p.index >= from && p.index <= to)
      const content = documentContentSnapshot(state.doc, from, to)
      return ok(`已读取第 ${from + 1} 到第 ${to + 1} 段`, {
        detail: 'content',
        ...content,
        paragraphCount: selected.length,
        totalChars: selected.reduce((sum, p) => sum + p.node.textContent.length, 0),
      })
    }

    case 'get_paragraph': {
      const paragraph = paragraphAt(state.doc, Number(params.index))
      if (!paragraph) return fail(`未找到第 ${Number(params.index) + 1} 段`)
      return ok(`已读取第 ${paragraph.index + 1} 段`, paragraphSnapshot(paragraph))
    }

    case 'get_page_content':
      return await getPageContent(state.doc, pageConfig, params)

    case 'get_page_style_summary':
      return await getPageStyleSummary(state.doc, pageConfig, params)

    case 'get_comments': {
      const comments = []
      let paragraphIndex = 0
      state.doc.forEach(node => {
        if (node.type.name !== 'paragraph') return
        node.forEach(inline => {
          const mark = schema.marks.comment.isInSet(inline.marks)
          if (mark && inline.isText) comments.push({ ...mark.attrs, paragraphIndex, markedText: inline.text ?? '' })
        })
        paragraphIndex += 1
      })
      return ok(comments.length > 0 ? `共找到 ${comments.length} 条批注` : '文档中没有批注', { comments })
    }

    case 'set_text_style': {
      const range = params.range
      const error = validateRange(toolName, range)
      if (error) return fail(error)
      const matches = resolveTextMatches(state.doc, range, selectionContext)
      if (matches.length === 0) return fail('未找到可设置文字样式的范围')
      const attrs = Object.fromEntries(Object.entries(params).filter(([key, value]) => key !== 'range' && value !== undefined))
      if (typeof attrs.fontFamily === 'string') attrs.fontFamily = FONT_MAP[attrs.fontFamily] ?? attrs.fontFamily
      for (const match of matches) tr = addTextMark(tr, state, match.from, match.to, attrs)
      const nextDoc = tr.doc
      const affected = [...new Set(matches.map(m => m.paragraph.index).filter(index => index >= 0))]
      return ok('文字样式已更新', { matchedTextCount: matches.length, affectedParagraphs: compactSnapshots(nextDoc, affected) }, { docJson: nextDoc.toJSON() })
    }

    case 'set_paragraph_style': {
      const range = params.range
      const error = validateRange(toolName, range)
      if (error) return fail(error)
      const paragraphs = resolveParagraphRange(state.doc, range, selectionContext)
      if (paragraphs.length === 0) return fail('未找到可设置段落格式的范围')
      const attrs = Object.fromEntries(Object.entries(params).filter(([key, value]) => key !== 'range' && value !== undefined))
      if (attrs.listType === 'none') attrs.listType = null
      if (attrs.headingLevel === 0 || attrs.headingLevel === 'none') attrs.headingLevel = null
      for (const paragraph of paragraphs) tr.setNodeMarkup(paragraph.pos, undefined, { ...paragraph.node.attrs, ...attrs })
      const nextDoc = tr.doc
      return ok('段落格式已更新', { affectedParagraphs: compactSnapshots(nextDoc, paragraphs.map(p => p.index)) }, { docJson: nextDoc.toJSON() })
    }

    case 'clear_formatting': {
      const range = params.range
      const error = validateRange(toolName, range)
      if (error) return fail(error)
      const paragraphs = resolveParagraphRange(state.doc, range, selectionContext)
      const matches = resolveTextMatches(state.doc, range, selectionContext)
      if (params.clearTextStyles !== false) {
        for (const match of matches) tr = tr.removeMark(match.from, match.to, schema.marks.textStyle)
      }
      if (params.clearParagraphStyles !== false) {
        for (const paragraph of paragraphs) tr.setNodeMarkup(paragraph.pos, undefined, { ...paragraph.node.attrs, ...DEFAULT_PARAGRAPH_ATTRS })
      }
      const nextDoc = tr.doc
      return ok('已清除指定范围的格式', { affectedParagraphs: compactSnapshots(nextDoc, paragraphs.map(p => p.index)) }, { docJson: nextDoc.toJSON() })
    }

    case 'apply_style_batch': {
      const rules = Array.isArray(params.rules) ? params.rules : []
      if (rules.length === 0) return fail('apply_style_batch 需要至少一条规则')
      const affected = new Set()
      for (const rule of rules) {
        const range = rule.range
        const error = validateRange(toolName, range)
        if (error) return fail(error)
        if (rule.textStyle && typeof rule.textStyle === 'object') {
          const attrs = Object.fromEntries(Object.entries(rule.textStyle).filter(([, value]) => value !== undefined))
          if (typeof attrs.fontFamily === 'string') attrs.fontFamily = FONT_MAP[attrs.fontFamily] ?? attrs.fontFamily
          for (const match of resolveTextMatches(state.doc, range, selectionContext)) {
            tr = addTextMark(tr, state, match.from, match.to, attrs)
            if (match.paragraph.index >= 0) affected.add(match.paragraph.index)
          }
        }
        if (rule.paragraphStyle && typeof rule.paragraphStyle === 'object') {
          const attrs = Object.fromEntries(Object.entries(rule.paragraphStyle).filter(([, value]) => value !== undefined))
          if (attrs.listType === 'none') attrs.listType = null
          if (attrs.headingLevel === 0 || attrs.headingLevel === 'none') attrs.headingLevel = null
          for (const paragraph of resolveParagraphRange(state.doc, range, selectionContext)) {
            tr.setNodeMarkup(paragraph.pos, undefined, { ...paragraph.node.attrs, ...attrs })
            affected.add(paragraph.index)
          }
        }
      }
      const nextDoc = tr.doc
      return ok(`已批量应用 ${rules.length} 条样式规则`, { affectedParagraphs: compactSnapshots(nextDoc, [...affected]) }, { docJson: nextDoc.toJSON() })
    }

    case 'set_page_config': {
      const nextPageConfig = { ...pageConfig }
      if (typeof params.paperSize === 'string') {
        const sizes = { A4: [794, 1123], A3: [1123, 1587], Letter: [816, 1056], B5: [665, 942] }
        const size = sizes[params.paperSize]
        if (size) [nextPageConfig.pageWidth, nextPageConfig.pageHeight] = size
      }
      if (params.orientation === 'landscape' && nextPageConfig.pageWidth < nextPageConfig.pageHeight) [nextPageConfig.pageWidth, nextPageConfig.pageHeight] = [nextPageConfig.pageHeight, nextPageConfig.pageWidth]
      if (params.orientation === 'portrait' && nextPageConfig.pageWidth > nextPageConfig.pageHeight) [nextPageConfig.pageWidth, nextPageConfig.pageHeight] = [nextPageConfig.pageHeight, nextPageConfig.pageWidth]
      for (const [key, param] of [['marginTop', 'marginTop'], ['marginBottom', 'marginBottom'], ['marginLeft', 'marginLeft'], ['marginRight', 'marginRight']]) {
        if (params[param] != null) nextPageConfig[key] = Math.round(Number(params[param]) * 3.7795)
      }
      return ok('页面配置已更新', { pageConfig: nextPageConfig }, { pageConfig: nextPageConfig })
    }

    case 'insert_page_break': {
      const after = Number(params.afterParagraph)
      const next = paragraphAt(state.doc, after + 1)
      if (next) tr.setNodeMarkup(next.pos, undefined, { ...next.node.attrs, pageBreakBefore: true })
      else {
        const inserted = insertBlockAfterParagraph(state, after, schema.nodes.paragraph.create({ pageBreakBefore: true }))
        if (!inserted) return fail('afterParagraph 无效')
        tr = inserted
      }
      return ok(`已在第 ${after + 1} 段后插入分页符`, undefined, { docJson: tr.doc.toJSON() })
    }

    case 'insert_horizontal_rule': {
      const inserted = insertBlockAfterParagraph(state, Number(params.afterParagraph), schema.nodes.horizontal_rule.create())
      if (!inserted) return fail('afterParagraph 无效')
      return ok('已插入分割线', undefined, { docJson: inserted.doc.toJSON() })
    }

    case 'insert_table_of_contents': {
      const minLevel = Math.min(6, Math.max(1, Number(params.minLevel ?? 1)))
      const maxLevel = Math.min(6, Math.max(minLevel, Number(params.maxLevel ?? 3)))
      const node = schema.nodes.table_of_contents.create({ title: String(params.title ?? '目录') || '目录', minLevel, maxLevel, hyperlink: params.hyperlink !== false })
      const inserted = insertBlockAfterParagraph(state, Number(params.afterParagraph ?? -1), node)
      if (!inserted) return fail('afterParagraph 无效')
      return ok(`已插入 Word 自动目录（标题级别 ${minLevel}-${maxLevel}）`, { tableOfContents: node.attrs }, { docJson: inserted.doc.toJSON() })
    }

    case 'insert_table': {
      const data = Array.isArray(params.data) ? params.data.map(row => Array.isArray(row) ? row.map(cell => normalizeText(cell)) : []) : []
      const rows = Math.min(20, Math.max(1, data.length || Number(params.rows) || 1))
      const cols = Math.min(10, Math.max(1, data.reduce((max, row) => Math.max(max, row.length), 0) || Number(params.cols) || 1))
      const headerRow = Boolean(params.headerRow ?? data.length > 0)
      const table = schema.nodes.table.create(null, Array.from({ length: rows }, (_, rowIndex) => schema.nodes.table_row.create(null, Array.from({ length: cols }, (_, colIndex) => schema.nodes.table_cell.create({ header: headerRow && rowIndex === 0 }, buildParagraphNodesFromText(data[rowIndex]?.[colIndex] ?? ''))))))
      const inserted = insertBlockAfterParagraph(state, Number(params.afterParagraph), table)
      if (!inserted) return fail('afterParagraph 无效')
      return ok(`已插入 ${rows} 行 ${cols} 列表格`, { table: tableSnapshot(table) }, { docJson: inserted.doc.toJSON() })
    }

    case 'insert_table_row_before':
    case 'insert_table_row_after':
    case 'delete_table_row':
    case 'insert_table_column_before':
    case 'insert_table_column_after':
    case 'delete_table_column':
      return executeTableStructureTool(state, tr, toolName, params, selectionContext)

    case 'begin_streaming_write': {
      const action = String(params.action ?? '')
      const markdown = typeof params.markdown === 'string' ? params.markdown : ''
      if (!['insert_after_paragraph', 'replace_paragraph'].includes(action)) return fail(`begin_streaming_write 的 action 无效：${action || '空值'}`)
      if (!markdown) {
        return fail('begin_streaming_write 需要 markdown 参数。请把要写入文档的完整 Markdown 正文放入工具参数，不要在侧边栏回复中输出正文。')
      }
      if (action === 'insert_after_paragraph') {
        const after = Number(params.afterParagraph)
        const paragraph = paragraphAt(state.doc, after)
        if (!paragraph) return fail(`未找到第 ${after + 1} 段`)
        const nodes = buildMarkdownNodes(markdown, paragraph.node.attrs)
        tr.insert(paragraph.pos + paragraph.node.nodeSize, Fragment.fromArray(nodes))
        return ok(`已在第 ${after + 1} 段后写入 Markdown 正文`, { insertedBlockCount: nodes.length }, { docJson: tr.doc.toJSON() })
      }
      const paragraphIndex = Number(params.paragraphIndex)
      const paragraph = paragraphAt(state.doc, paragraphIndex)
      if (!paragraph) return fail(`未找到第 ${paragraphIndex + 1} 段`)
      const nodes = buildMarkdownNodes(markdown, paragraph.node.attrs, { preserveFirstPageBreakBefore: true })
      tr.replaceWith(paragraph.pos, paragraph.pos + paragraph.node.nodeSize, Fragment.fromArray(nodes))
      return ok(`已改写第 ${paragraphIndex + 1} 段`, { insertedBlockCount: nodes.length }, { docJson: tr.doc.toJSON() })
    }

    case 'insert_text': {
      const paragraph = paragraphAt(state.doc, Number(params.paragraphIndex))
      if (!paragraph) return fail(`未找到第 ${Number(params.paragraphIndex) + 1} 段`)
      tr.insertText(normalizeText(params.text), paragraph.pos + paragraph.node.nodeSize - 1)
      return ok(`已在第 ${paragraph.index + 1} 段末尾插入文字`, undefined, { docJson: tr.doc.toJSON() })
    }

    case 'insert_paragraph_after': {
      const paragraph = paragraphAt(state.doc, Number(params.afterParagraph))
      if (!paragraph) return fail(`未找到第 ${Number(params.afterParagraph) + 1} 段`)
      const insertPos = paragraph.pos + paragraph.node.nodeSize
      tr.insert(insertPos, Fragment.fromArray(buildParagraphNodesFromText(params.text, paragraph.node.attrs)))
      return ok(`已在第 ${paragraph.index + 1} 段后插入新段落`, undefined, { docJson: tr.doc.toJSON() })
    }

    case 'replace_paragraph_text': {
      const paragraph = paragraphAt(state.doc, Number(params.paragraphIndex))
      if (!paragraph) return fail(`未找到第 ${Number(params.paragraphIndex) + 1} 段`)
      tr.replaceWith(paragraph.pos, paragraph.pos + paragraph.node.nodeSize, Fragment.fromArray(buildParagraphNodesFromText(params.text, paragraph.node.attrs, { preserveFirstPageBreakBefore: true })))
      return ok(`已替换第 ${paragraph.index + 1} 段文字`, undefined, { docJson: tr.doc.toJSON() })
    }

    case 'replace_selection_text': {
      const bounds = resolveSelection(state.doc, params.range, selectionContext)[0]
      if (!bounds) return fail('replace_selection_text 需要有效的 selection 范围')
      tr.insertText(normalizeText(params.text), bounds.from, bounds.to)
      return ok('已替换选区文字', undefined, { docJson: tr.doc.toJSON() })
    }

    case 'delete_selection_text': {
      const bounds = resolveSelection(state.doc, params.range, selectionContext)[0]
      if (!bounds) return fail('delete_selection_text 需要有效的 selection 范围')
      tr.delete(bounds.from, bounds.to)
      return ok('已删除选区文字', undefined, { docJson: tr.doc.toJSON() })
    }

    case 'delete_paragraph': {
      const indexes = normalizeIndexes(params.indices).length > 0 ? normalizeIndexes(params.indices) : (Number.isInteger(params.index) ? [Number(params.index)] : [])
      if (indexes.length === 0) return fail('delete_paragraph 需要 index 或 indices')
      for (const index of [...indexes].sort((a, b) => b - a)) {
        const paragraph = paragraphAt(tr.doc, index)
        if (!paragraph) return fail(`未找到第 ${index + 1} 段`)
        if (tr.doc.childCount === 1 && indexes.length === 1) tr.replaceWith(paragraph.pos, paragraph.pos + paragraph.node.nodeSize, schema.nodes.paragraph.create())
        else tr.delete(paragraph.pos, paragraph.pos + paragraph.node.nodeSize)
      }
      return ok(indexes.length === 1 ? `已删除第 ${indexes[0] + 1} 段` : `已批量删除 ${indexes.length} 个段落`, undefined, { docJson: tr.doc.toJSON() })
    }

    case 'insert_image': {
      const src = String(params.src ?? '')
      if (!src) return fail('insert_image 需要 src 参数')
      const node = schema.nodes.paragraph.create(undefined, schema.nodes.image.create({ src, alt: String(params.alt ?? ''), width: null, height: null }))
      const after = params.afterParagraph === undefined ? getParagraphs(state.doc).at(-1)?.index ?? -1 : Number(params.afterParagraph)
      const inserted = insertBlockAfterParagraph(state, after, node)
      if (!inserted) return fail('afterParagraph 无效')
      return ok(`已插入图片${params.alt ? `（${params.alt}）` : ''}`, undefined, { docJson: inserted.doc.toJSON() })
    }

    case 'insert_mermaid': {
      const code = String(params.code ?? '')
      if (!code.trim()) return fail('insert_mermaid 需要 code 参数')
      try {
        const src = await renderMermaidDataUrl(code)
        const node = schema.nodes.paragraph.create(undefined, schema.nodes.image.create({ src, alt: String(params.alt ?? '') || 'Mermaid 图表', width: null, height: null }))
        const after = params.afterParagraph === undefined ? getParagraphs(state.doc).at(-1)?.index ?? -1 : Number(params.afterParagraph)
        const inserted = insertBlockAfterParagraph(state, after, node)
        if (!inserted) return fail('afterParagraph 无效')
        return ok(`已插入 Mermaid 图表${params.alt ? `（${params.alt}）` : ''}`, undefined, { docJson: inserted.doc.toJSON() })
      } catch (error) {
        return fail(`Mermaid 服务端渲染失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    case 'capture_page_screenshot':
      try {
        return await capturePageScreenshot(state.doc, pageConfig, params)
      } catch (error) {
        return fail(`服务端页面截图失败：${error instanceof Error ? error.message : String(error)}`)
      }

    case 'analyze_document_image':
      return locateDocumentImage(state.doc, pageConfig, params)

    default:
      return fail(`未知工具: ${toolName}`)
  }
}

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  input += chunk
})
process.stdin.on('end', async () => {
  try {
    const request = JSON.parse(input || '{}')
    process.stdout.write(JSON.stringify(await execute(request)))
  } catch (error) {
    process.stdout.write(JSON.stringify(fail(error instanceof Error ? error.message : String(error))))
  }
})
