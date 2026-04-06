import { Schema } from 'prosemirror-model'

export const schema = new Schema({
  nodes: {
    doc: { content: '(paragraph|horizontal_rule|table)+' },
    paragraph: {
      attrs: {
        align: { default: 'left' },
        firstLineIndent: { default: 0 },
        indent: { default: 0 },
        lineHeight: { default: 1.5 },
        spaceBefore: { default: 0 },
        spaceAfter: { default: 0 },
        listType: { default: null },
        listLevel: { default: 0 },
        pageBreakBefore: { default: false },
      },
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'p' }],
      toDOM(node) {
        const style: string[] = []
        if (node.attrs.align !== 'left') style.push(`text-align:${node.attrs.align}`)
        if (node.attrs.firstLineIndent) style.push(`text-indent:${node.attrs.firstLineIndent}em`)
        if (node.attrs.indent) style.push(`margin-left:${node.attrs.indent * 2}em`)
        if (node.attrs.lineHeight !== 1.5) style.push(`line-height:${node.attrs.lineHeight}`)
        if (node.attrs.spaceBefore) style.push(`margin-top:${node.attrs.spaceBefore * 1.5}em`)
        if (node.attrs.spaceAfter) style.push(`margin-bottom:${node.attrs.spaceAfter * 1.5}em`)

        const cls: string[] = []
        if (node.attrs.listType === 'bullet') cls.push('list-bullet')
        if (node.attrs.listType === 'ordered') cls.push('list-ordered')
        if (node.attrs.pageBreakBefore) cls.push('page-break-before')

        const domAttrs: Record<string, string | undefined> = {
          style: style.join(';') || undefined,
          class: cls.join(' ') || undefined,
        }
        if (node.attrs.listType) domAttrs['data-list-type'] = node.attrs.listType
        if (node.attrs.pageBreakBefore) domAttrs['data-page-break'] = 'true'

        return ['p', domAttrs, 0]
      },
    },
    // ─── Table nodes ─────────────────────────────────────────────────────────
    table: {
      content: 'table_row+',
      group: 'block',
      parseDOM: [{ tag: 'table' }],
      toDOM() {
        return ['table', { style: 'border-collapse:collapse;width:100%;margin:8px 0' }, ['tbody', 0]]
      },
    },
    table_row: {
      content: 'table_cell+',
      parseDOM: [{ tag: 'tr' }],
      toDOM() { return ['tr', 0] },
    },
    table_cell: {
      content: 'paragraph+',
      attrs: { header: { default: false } },
      parseDOM: [{ tag: 'td' }, { tag: 'th' }],
      toDOM(node) {
        const tag = node.attrs.header ? 'th' : 'td'
        return [tag, { style: 'border:1px solid #ccc;padding:4px 8px;min-width:40px;vertical-align:top' }, 0]
      },
    },
    // ─────────────────────────────────────────────────────────────────────────
    horizontal_rule: {
      group: 'block',
      parseDOM: [{ tag: 'hr' }],
      toDOM() { return ['hr'] },
    },
    text: { group: 'inline' },
  },
  marks: {
    textStyle: {
      attrs: {
        fontFamily: { default: 'SimSun, 宋体, serif' },
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
      parseDOM: [{ tag: 'span' }],
      toDOM(mark) {
        const style: string[] = []
        if (mark.attrs.fontFamily) style.push(`font-family:${mark.attrs.fontFamily}`)
        if (mark.attrs.fontSize) style.push(`font-size:${mark.attrs.fontSize}pt`)
        if (mark.attrs.color) style.push(`color:${mark.attrs.color}`)
        if (mark.attrs.backgroundColor) style.push(`background-color:${mark.attrs.backgroundColor}`)
        if (mark.attrs.bold) style.push('font-weight:bold')
        if (mark.attrs.italic) style.push('font-style:italic')
        if (mark.attrs.underline) style.push('text-decoration:underline')
        if (mark.attrs.strikethrough) style.push('text-decoration:line-through')
        if (mark.attrs.superscript) style.push('vertical-align:super;font-size:smaller')
        if (mark.attrs.subscript) style.push('vertical-align:sub;font-size:smaller')
        if (mark.attrs.letterSpacing) style.push(`letter-spacing:${mark.attrs.letterSpacing}pt`)
        return ['span', { style: style.join(';') }]
      },
    },
  },
})

export type DocSchema = typeof schema
