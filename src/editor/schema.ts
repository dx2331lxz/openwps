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
        if (node.attrs.spaceBefore) style.push(`margin-top:${node.attrs.spaceBefore}pt`)
        if (node.attrs.spaceAfter) style.push(`margin-bottom:${node.attrs.spaceAfter}pt`)
        if (node.attrs.listType) style.push(`--list-level:${node.attrs.listLevel ?? 0}`)

        const cls: string[] = []
        if (node.attrs.listType === 'bullet') cls.push('list-bullet')
        if (node.attrs.listType === 'ordered') cls.push('list-ordered')
        if (node.attrs.pageBreakBefore) cls.push('page-break-before')

        const domAttrs: Record<string, string | undefined> = {
          style: style.join(';') || undefined,
          class: cls.join(' ') || undefined,
        }
        if (node.attrs.listType) domAttrs['data-list-type'] = node.attrs.listType
        if (node.attrs.listType) domAttrs['data-list-level'] = String(node.attrs.listLevel ?? 0)
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
      attrs: {
        header: { default: false },
        colspan: { default: 1 },
        rowspan: { default: 1 },
        width: { default: null },
      },
      parseDOM: [{
        tag: 'td',
        getAttrs: (dom) => {
          const element = dom as HTMLTableCellElement
          return {
            header: false,
            colspan: element.colSpan || 1,
            rowspan: element.rowSpan || 1,
            width: element.style.width || null,
          }
        },
      }, {
        tag: 'th',
        getAttrs: (dom) => {
          const element = dom as HTMLTableCellElement
          return {
            header: true,
            colspan: element.colSpan || 1,
            rowspan: element.rowSpan || 1,
            width: element.style.width || null,
          }
        },
      }],
      toDOM(node) {
        const tag = node.attrs.header ? 'th' : 'td'
        return [tag, {
          colspan: node.attrs.colspan > 1 ? node.attrs.colspan : undefined,
          rowspan: node.attrs.rowspan > 1 ? node.attrs.rowspan : undefined,
          style: [
            'border:1px solid #ccc',
            'padding:4px 8px',
            'min-width:40px',
            'vertical-align:top',
            node.attrs.width ? `width:${node.attrs.width}` : '',
          ].filter(Boolean).join(';'),
        }, 0]
      },
    },
    // ─────────────────────────────────────────────────────────────────────────
    horizontal_rule: {
      group: 'block',
      parseDOM: [{ tag: 'hr' }],
      toDOM() { return ['hr'] },
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
      parseDOM: [{
        tag: 'img[src]',
        getAttrs: (dom) => {
          const element = dom as HTMLImageElement
          return {
            src: element.getAttribute('src') ?? '',
            alt: element.getAttribute('alt') ?? '',
            title: element.getAttribute('title') ?? '',
            width: element.getAttribute('width') ? Number(element.getAttribute('width')) : null,
            height: element.getAttribute('height') ? Number(element.getAttribute('height')) : null,
          }
        },
      }],
      toDOM(node) {
        return ['img', {
          src: node.attrs.src,
          alt: node.attrs.alt,
          title: node.attrs.title,
          width: node.attrs.width ?? undefined,
          height: node.attrs.height ?? undefined,
          style: 'display:inline-block;max-width:100%;vertical-align:bottom',
        }]
      },
    },
    text: { group: 'inline' },
  },
  marks: {
    textStyle: {
      attrs: {
        fontFamily: { default: 'SimSun, 宋体, "Songti SC", STSong, "Noto Serif CJK SC", serif' },
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
    link: {
      attrs: {
        href: {},
      },
      inclusive: false,
      parseDOM: [{
        tag: 'a[href]',
        getAttrs: (dom) => ({
          href: (dom as HTMLAnchorElement).getAttribute('href') ?? '',
        }),
      }],
      toDOM(mark) {
        return ['a', {
          href: mark.attrs.href,
          target: '_blank',
          rel: 'noopener noreferrer',
        }, 0]
      },
    },
  },
})

export type DocSchema = typeof schema
