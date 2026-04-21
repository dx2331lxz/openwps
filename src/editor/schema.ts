import { Schema } from 'prosemirror-model'
import { DEFAULT_EDITOR_FONT_STACK } from '../fonts'

export const schema = new Schema({
  nodes: {
    doc: { content: '(paragraph|horizontal_rule|table|floating_object)+' },
    paragraph: {
      attrs: {
        align: { default: 'left' },
        firstLineIndent: { default: 0 },
        indent: { default: 0 },
        rightIndent: { default: 0 },
        fontSizeHint: { default: null },
        fontFamilyHint: { default: null },
        lineHeight: { default: 1.5 },
        spaceBefore: { default: 0 },
        spaceAfter: { default: 0 },
        listType: { default: null },
        listLevel: { default: 0 },
        pageBreakBefore: { default: false },
        tabStops: { default: [] },
      },
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'p' }],
      toDOM(node) {
        const style: string[] = []
        if (node.attrs.align !== 'left') style.push(`text-align:${node.attrs.align}`)
        if (node.attrs.firstLineIndent) style.push(`text-indent:${node.attrs.firstLineIndent}em`)
        if (node.attrs.indent) style.push(`margin-left:${node.attrs.indent * 2}em`)
        if (node.attrs.rightIndent) style.push(`margin-right:${node.attrs.rightIndent * 2}em`)
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
      tableRole: 'table',
      parseDOM: [{ tag: 'table' }],
      toDOM() {
        return ['table', { style: 'border-collapse:collapse;width:100%;margin:8px 0;box-sizing:border-box;table-layout:fixed' }, ['tbody', 0]]
      },
    },
    table_row: {
      content: 'table_cell+',
      tableRole: 'row',
      parseDOM: [{ tag: 'tr' }],
      toDOM() { return ['tr', 0] },
    },
    table_cell: {
      content: 'paragraph+',
      tableRole: 'cell',
      isolating: true,
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
            'box-sizing:border-box',
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
    floating_object: {
      group: 'block',
      atom: true,
      selectable: false,
      draggable: false,
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
      parseDOM: [{
        tag: 'div[data-floating-object]',
        getAttrs: (dom) => {
          const element = dom as HTMLElement
          return {
            kind: element.getAttribute('data-kind') ?? 'textbox',
            src: element.getAttribute('data-src') ?? '',
            alt: element.getAttribute('data-alt') ?? '',
            title: element.getAttribute('data-title') ?? '',
            width: element.getAttribute('data-width') ? Number(element.getAttribute('data-width')) : null,
            height: element.getAttribute('data-height') ? Number(element.getAttribute('data-height')) : null,
            positionX: element.getAttribute('data-position-x') ? Number(element.getAttribute('data-position-x')) : 0,
            positionY: element.getAttribute('data-position-y') ? Number(element.getAttribute('data-position-y')) : 0,
            relativeFromX: element.getAttribute('data-relative-from-x') ?? 'column',
            relativeFromY: element.getAttribute('data-relative-from-y') ?? 'paragraph',
            wrap: element.getAttribute('data-wrap') ?? 'none',
            behindDoc: element.getAttribute('data-behind-doc') === 'true',
            allowOverlap: element.getAttribute('data-allow-overlap') !== 'false',
            distT: element.getAttribute('data-dist-t') ? Number(element.getAttribute('data-dist-t')) : 0,
            distB: element.getAttribute('data-dist-b') ? Number(element.getAttribute('data-dist-b')) : 0,
            distL: element.getAttribute('data-dist-l') ? Number(element.getAttribute('data-dist-l')) : 0,
            distR: element.getAttribute('data-dist-r') ? Number(element.getAttribute('data-dist-r')) : 0,
            paddingTop: element.getAttribute('data-padding-top') ? Number(element.getAttribute('data-padding-top')) : 0,
            paddingRight: element.getAttribute('data-padding-right') ? Number(element.getAttribute('data-padding-right')) : 0,
            paddingBottom: element.getAttribute('data-padding-bottom') ? Number(element.getAttribute('data-padding-bottom')) : 0,
            paddingLeft: element.getAttribute('data-padding-left') ? Number(element.getAttribute('data-padding-left')) : 0,
            paragraphs: [],
          }
        },
      }],
      toDOM(node) {
        return ['div', {
          'data-floating-object': 'true',
          'data-kind': node.attrs.kind,
          'data-src': node.attrs.src || undefined,
          'data-alt': node.attrs.alt || undefined,
          'data-title': node.attrs.title || undefined,
          'data-width': node.attrs.width ?? undefined,
          'data-height': node.attrs.height ?? undefined,
          'data-position-x': node.attrs.positionX ?? 0,
          'data-position-y': node.attrs.positionY ?? 0,
          'data-relative-from-x': node.attrs.relativeFromX ?? 'column',
          'data-relative-from-y': node.attrs.relativeFromY ?? 'paragraph',
          'data-wrap': node.attrs.wrap ?? 'none',
          'data-behind-doc': String(Boolean(node.attrs.behindDoc)),
          'data-allow-overlap': String(Boolean(node.attrs.allowOverlap)),
          'data-dist-t': node.attrs.distT ?? 0,
          'data-dist-b': node.attrs.distB ?? 0,
          'data-dist-l': node.attrs.distL ?? 0,
          'data-dist-r': node.attrs.distR ?? 0,
          'data-padding-top': node.attrs.paddingTop ?? 0,
          'data-padding-right': node.attrs.paddingRight ?? 0,
          'data-padding-bottom': node.attrs.paddingBottom ?? 0,
          'data-padding-left': node.attrs.paddingLeft ?? 0,
          style: 'display:none',
        }]
      },
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
        fontFamily: { default: DEFAULT_EDITOR_FONT_STACK },
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
    comment: {
      attrs: {
        id: { default: '' },
        author: { default: '' },
        date: { default: '' },
        content: { default: '' },
      },
      inclusive: false,
      spanning: true,
      parseDOM: [{
        tag: 'span[data-comment-id]',
        getAttrs: (dom) => ({
          id: (dom as HTMLElement).getAttribute('data-comment-id') ?? '',
          author: (dom as HTMLElement).getAttribute('data-comment-author') ?? '',
          date: (dom as HTMLElement).getAttribute('data-comment-date') ?? '',
          content: (dom as HTMLElement).getAttribute('data-comment-content') ?? '',
        }),
      }],
      toDOM(mark) {
        return ['span', {
          'data-comment-id': mark.attrs.id,
          'data-comment-author': mark.attrs.author,
          'data-comment-date': mark.attrs.date,
          'data-comment-content': mark.attrs.content,
          class: 'pm-comment',
        }, 0]
      },
    },
  },
})

export type DocSchema = typeof schema
