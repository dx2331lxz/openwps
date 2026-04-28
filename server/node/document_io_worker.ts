#!/usr/bin/env node
// @ts-nocheck
import { DOMParser } from '@xmldom/xmldom'
import { schema, DEFAULT_PAGE_CONFIG } from '../../src/shared/document/schema.js'
import { markdownToDocument } from '../../src/markdown/importer.js'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

function installDomGlobals() {
  globalThis.DOMParser = DOMParser
  globalThis.Node = globalThis.Node ?? { ELEMENT_NODE: 1 }
}

function ok(data) {
  return { success: true, ...data }
}

function fail(error) {
  return {
    success: false,
    message: error instanceof Error ? error.message : String(error),
  }
}

function bufferFromBase64(value) {
  return Buffer.from(String(value ?? ''), 'base64')
}

function nodeText(node) {
  if (!node || typeof node !== 'object') return ''
  if (typeof node.text === 'string') return node.text
  if (!Array.isArray(node.content)) return ''
  return node.content.map(nodeText).join('')
}

function paragraphNode(text, attrs = {}) {
  const node = {
    type: 'paragraph',
    attrs: {
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
      ...attrs,
    },
  }
  if (text) node.content = [{ type: 'text', text }]
  return node
}

function plainTextToDoc(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  return {
    type: 'doc',
    content: lines.map(line => paragraphNode(line)),
  }
}

function serializePlainText(docJson) {
  const lines = []
  for (const node of docJson?.content ?? []) {
    if (node?.type === 'paragraph') lines.push(nodeText(node))
    else if (node?.type === 'table') {
      for (const row of node.content ?? []) {
        lines.push((row.content ?? []).map(nodeText).join(' | '))
      }
    } else if (node?.type === 'horizontal_rule') {
      lines.push('---')
    }
  }
  return lines.join('\n')
}

function serializeMarkdown(docJson) {
  const lines = []
  for (const node of docJson?.content ?? []) {
    if (node?.type === 'paragraph') {
      const attrs = node.attrs ?? {}
      const text = nodeText(node)
      if (Number.isInteger(attrs.headingLevel) && attrs.headingLevel >= 1 && attrs.headingLevel <= 6) {
        lines.push(`${'#'.repeat(attrs.headingLevel)} ${text}`.trimEnd())
      } else if (attrs.listType === 'bullet') {
        lines.push(`- ${text}`.trimEnd())
      } else if (attrs.listType === 'ordered') {
        lines.push(`1. ${text}`.trimEnd())
      } else {
        lines.push(text)
      }
    } else if (node?.type === 'table') {
      const rows = (node.content ?? []).map(row => (row.content ?? []).map(nodeText))
      if (rows.length > 0) {
        lines.push(`| ${rows[0].join(' | ')} |`)
        lines.push(`| ${rows[0].map(() => '---').join(' | ')} |`)
        for (const row of rows.slice(1)) lines.push(`| ${row.join(' | ')} |`)
      }
    } else if (node?.type === 'horizontal_rule') {
      lines.push('---')
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

async function openDocument(request) {
  const fileType = String(request.fileType ?? '').toLowerCase()
  const name = String(request.name ?? `document.${fileType || 'txt'}`)
  const content = bufferFromBase64(request.contentBase64)

  if (fileType === 'docx') {
    installDomGlobals()
    const { importDocx } = await import('../../src/docx/importer.js')
    const file = new File([content], name, { type: DOCX_MIME })
    const result = await importDocx(file)
    return ok({
      docJson: result.doc,
      pageConfig: result.pageConfig,
      exportOptions: {
        docGridLinePitchPt: result.docGridLinePitchPt,
        typography: result.typography,
      },
    })
  }

  const text = content.toString('utf8')
  if (fileType === 'md' || fileType === 'markdown') {
    return ok({
      docJson: markdownToDocument(text).toJSON(),
      pageConfig: DEFAULT_PAGE_CONFIG,
    })
  }
  return ok({ docJson: plainTextToDoc(text), pageConfig: DEFAULT_PAGE_CONFIG })
}

async function saveDocument(request) {
  const fileType = String(request.fileType ?? '').toLowerCase()
  const pageConfig = request.pageConfig ?? DEFAULT_PAGE_CONFIG

  if (fileType === 'docx') {
    const { buildDocxBlob } = await import('../../src/docx/exporter.js')
    const pmDoc = schema.nodeFromJSON(request.docJson)
    const blob = await buildDocxBlob(pmDoc, pageConfig, request.exportOptions ?? {})
    const bytes = Buffer.from(await blob.arrayBuffer())
    return ok({ contentBase64: bytes.toString('base64'), contentType: DOCX_MIME })
  }

  const text = fileType === 'md' || fileType === 'markdown'
    ? serializeMarkdown(request.docJson)
    : serializePlainText(request.docJson)
  return ok({
    contentBase64: Buffer.from(text, 'utf8').toString('base64'),
    contentType: fileType === 'txt' ? 'text/plain; charset=utf-8' : 'text/markdown; charset=utf-8',
  })
}

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  input += chunk
})
process.stdin.on('end', async () => {
  try {
    const request = JSON.parse(input || '{}')
    const result = request.operation === 'save'
      ? await saveDocument(request)
      : await openDocument(request)
    process.stdout.write(JSON.stringify(result))
  } catch (error) {
    process.stdout.write(JSON.stringify(fail(error)))
  }
})
