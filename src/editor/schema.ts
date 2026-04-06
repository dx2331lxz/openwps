import { Schema } from 'prosemirror-model'

export const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
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
      },
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'p' }],
      toDOM(node) {
        const style: string[] = []
        if (node.attrs.align !== 'left') style.push(`text-align:${node.attrs.align}`)
        if (node.attrs.firstLineIndent) style.push(`text-indent:${node.attrs.firstLineIndent}em`)
        return ['p', { style: style.join(';') || undefined }, 0]
      },
    },
    text: { group: 'inline' },
  },
  marks: {
    textStyle: {
      attrs: {
        fontFamily: { default: 'SimSun, serif' },
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
