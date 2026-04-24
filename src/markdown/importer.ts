import { type Mark, type Node as PMNode } from 'prosemirror-model'
import { marked, type Token, type Tokens } from 'marked'
import { schema } from '../editor/schema'
import { FONT_STACKS } from '../fonts'

const DEFAULT_PARAGRAPH_ATTRS = {
  align: 'left',
  firstLineIndent: 0,
  indent: 0,
  headingLevel: null,
  lineHeight: 1.5,
  spaceBefore: 0,
  spaceAfter: 0,
  listType: null,
  listLevel: 0,
  listChecked: false,
  pageBreakBefore: false,
} as const

type ParagraphAttrs = Record<string, unknown>

interface InlineContext {
  linkHref?: string
  textStyle?: Record<string, unknown>
}

interface BlockContext {
  baseParagraphAttrs?: ParagraphAttrs
  paragraphOverrides?: ParagraphAttrs
}

function parseFallbackTaskState(raw: string | undefined) {
  if (!raw) return null
  const match = raw.match(/^\s*(?:[-+*]|\d+\.)\s+\[([ xX])\]\s*$/)
  if (!match) return null
  return match[1].toLowerCase() === 'x'
}

function normalizeMarkdown(markdown: string) {
  return markdown.replace(/\r\n?/g, '\n')
}

function mergeParagraphAttrs(base?: ParagraphAttrs, overrides?: ParagraphAttrs) {
  return {
    ...DEFAULT_PARAGRAPH_ATTRS,
    ...(base ?? {}),
    ...(overrides ?? {}),
  }
}

function hasTextStyle(attrs?: Record<string, unknown>) {
  if (!attrs) return false
  return Object.values(attrs).some(value => {
    if (value == null) return false
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value !== 0
    return String(value) !== ''
  })
}

function stripHtmlTags(text: string) {
  return text.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
}

function mergeInlineContext(
  context: InlineContext,
  textStyle?: Record<string, unknown>,
  extras: Partial<InlineContext> = {},
): InlineContext {
  return {
    ...context,
    ...extras,
    textStyle: textStyle ? { ...(context.textStyle ?? {}), ...textStyle } : context.textStyle,
  }
}

function createMarks(context: InlineContext): Mark[] {
  const marks: Mark[] = []

  if (hasTextStyle(context.textStyle)) {
    // Filter out null/undefined values to prevent ProseMirror from throwing
    const safeAttrs = Object.fromEntries(
      Object.entries(context.textStyle ?? {}).filter(([, value]) => value != null),
    )
    marks.push(schema.marks.textStyle.create(safeAttrs))
  }

  if (context.linkHref) {
    marks.push(schema.marks.link.create({ href: context.linkHref }))
  }

  return marks
}

function createTextNode(text: string, context: InlineContext) {
  if (!text) return null
  return schema.text(text, createMarks(context))
}

function inlineTokensToNodes(tokens: Token[] | undefined, context: InlineContext = {}): PMNode[] {
  if (!tokens || tokens.length === 0) return []

  return tokens.flatMap(token => {
    switch (token.type) {
      case 'text':
      case 'escape': {
        const value = (token as Tokens.Text | Tokens.Escape).text ?? ''
        return createTextNode(value, context) ?? []
      }
      case 'strong':
        return inlineTokensToNodes(
          (token as Tokens.Strong).tokens,
          mergeInlineContext(context, { bold: true }),
        )
      case 'em':
        return inlineTokensToNodes(
          (token as Tokens.Em).tokens,
          mergeInlineContext(context, { italic: true }),
        )
      case 'del':
        return inlineTokensToNodes(
          (token as Tokens.Del).tokens,
          mergeInlineContext(context, { strikethrough: true }),
        )
      case 'codespan': {
        const value = (token as Tokens.Codespan).text ?? ''
        return createTextNode(
          value,
          mergeInlineContext(context, {
            fontFamily: FONT_STACKS.courierNew,
            backgroundColor: '#f3f4f6',
          }),
        ) ?? []
      }
      case 'br':
        return createTextNode('\n', context) ?? []
      case 'link': {
        const link = token as Tokens.Link
        return inlineTokensToNodes(link.tokens, {
          ...context,
          linkHref: link.href ?? context.linkHref,
        })
      }
      case 'image': {
        const image = token as Tokens.Image
        return schema.nodes.image.create({
          src: image.href ?? '',
          alt: image.text ?? '',
          title: image.title ?? '',
        })
      }
      case 'html':
      case 'tag': {
        const raw = ((token as Tokens.HTML | Tokens.Tag).text ?? (token as Tokens.HTML | Tokens.Tag).raw ?? '')
        if (/^<br\s*\/?>$/i.test(raw)) return createTextNode('\n', context) ?? []
        return createTextNode(stripHtmlTags(raw), context) ?? []
      }
      default:
        if ('tokens' in token && Array.isArray(token.tokens)) return inlineTokensToNodes(token.tokens, context)
        if ('text' in token && typeof token.text === 'string') return createTextNode(token.text, context) ?? []
        return []
    }
  })
}

function createParagraph(tokens: Token[] | undefined, context: BlockContext, inlineContext: InlineContext = {}) {
  const content = inlineTokensToNodes(tokens, inlineContext)
  return schema.nodes.paragraph.create(
    mergeParagraphAttrs(context.baseParagraphAttrs, context.paragraphOverrides),
    content.length > 0 ? content : undefined,
  )
}

function createParagraphsFromText(text: string, context: BlockContext, inlineContext: InlineContext = {}) {
  const normalized = normalizeMarkdown(text)
  const parts = normalized === '' ? [''] : normalized.split('\n')
  return parts.map(part => createParagraph(
    part ? [{ type: 'text', raw: part, text: part } as Tokens.Text] : [],
    context,
    inlineContext,
  ))
}

function createParagraphsFromInlineTokens(tokens: Token[] | undefined, context: BlockContext, inlineContext: InlineContext = {}) {
  if (!tokens || tokens.length === 0) {
    return [createParagraph([], context, inlineContext)]
  }

  const paragraphs: PMNode[] = []
  let currentTokens: Token[] = []

  tokens.forEach(token => {
    if (token.type === 'br') {
      paragraphs.push(createParagraph(currentTokens, context, inlineContext))
      currentTokens = []
      return
    }
    currentTokens.push(token)
  })

  if (currentTokens.length > 0 || paragraphs.length === 0) {
    paragraphs.push(createParagraph(currentTokens, context, inlineContext))
  }

  return paragraphs
}

function blocksFromTokens(tokens: Token[], context: BlockContext): PMNode[] {
  return tokens.flatMap(token => {
    switch (token.type) {
      case 'space':
        return []
      case 'paragraph':
        return [createParagraph((token as Tokens.Paragraph).tokens, context)]
      case 'text':
        if ('tokens' in token && Array.isArray(token.tokens) && token.tokens.length > 0) {
          return createParagraphsFromInlineTokens(token.tokens, context)
        }
        return createParagraphsFromText((token as Tokens.Text).text ?? '', context)
      case 'heading': {
        const heading = token as Tokens.Heading
        const fontSize = heading.depth <= 1 ? 22 : heading.depth === 2 ? 18 : heading.depth === 3 ? 16 : 14
        return [createParagraph(
          heading.tokens,
          {
            ...context,
            paragraphOverrides: {
              ...(context.paragraphOverrides ?? {}),
              headingLevel: Math.min(6, Math.max(1, heading.depth)),
            },
          },
          { textStyle: { bold: true, fontSize } },
        )]
      }
      case 'hr':
        return [schema.nodes.horizontal_rule.create()]
      case 'code': {
        const codeToken = token as Tokens.Code
        if (codeToken.lang === 'mermaid') {
          return createParagraphsFromText('[Mermaid 图表]', context, {
            textStyle: { italic: true, color: '#9ca3af' },
          })
        }
        return createParagraphsFromText(codeToken.text ?? '', context, {
          textStyle: {
            fontFamily: FONT_STACKS.courierNew,
            backgroundColor: '#f3f4f6',
          },
        })
      }
      case 'blockquote':
        return blocksFromTokens((token as Tokens.Blockquote).tokens, {
          ...context,
          paragraphOverrides: {
            ...(context.paragraphOverrides ?? {}),
            indent: Number(context.paragraphOverrides?.indent ?? 0) + 1,
          },
        })
      case 'list': {
        const list = token as Tokens.List
        const currentLevel = context.paragraphOverrides?.listType
          ? Number(context.paragraphOverrides.listLevel ?? 0) + 1
          : 0
        return list.items.flatMap(item => {
          const fallbackTaskChecked = parseFallbackTaskState(item.raw)
          const isTaskItem = item.task || fallbackTaskChecked != null
          const taskChecked = item.task ? Boolean(item.checked) : Boolean(fallbackTaskChecked)
          const itemBlocks = blocksFromTokens(item.tokens ?? [], {
            ...context,
            paragraphOverrides: {
              ...(context.paragraphOverrides ?? {}),
              listType: isTaskItem ? 'task' : list.ordered ? 'ordered' : 'bullet',
              listLevel: currentLevel,
              listChecked: isTaskItem ? taskChecked : false,
            },
          })
          if (isTaskItem && itemBlocks.length === 1 && itemBlocks[0]?.type.name === 'paragraph' && itemBlocks[0].textContent === '[ ]') {
            return [schema.nodes.paragraph.create(
              {
                ...itemBlocks[0].attrs,
                listType: 'task',
                listLevel: currentLevel,
                listChecked: taskChecked,
              },
            )]
          }
          return itemBlocks.map((block, index) => {
            if (block.type.name !== 'paragraph') return block
            if (!isTaskItem) return block
            return schema.nodes.paragraph.create(
              {
                ...block.attrs,
                listType: 'task',
                listLevel: currentLevel,
                listChecked: index === 0 ? taskChecked : false,
              },
              block.content,
            )
          })
        })
      }
      case 'table': {
        const table = token as Tokens.Table
        const rows = [
          schema.nodes.table_row.create(
            undefined,
            table.header.map(cell =>
              schema.nodes.table_cell.create(
                { header: true },
                [createParagraph(cell.tokens, { baseParagraphAttrs: DEFAULT_PARAGRAPH_ATTRS })],
              ),
            ),
          ),
          ...table.rows.map(row =>
            schema.nodes.table_row.create(
              undefined,
              row.map(cell =>
                schema.nodes.table_cell.create(
                  { header: false },
                  [createParagraph(cell.tokens, { baseParagraphAttrs: DEFAULT_PARAGRAPH_ATTRS })],
                ),
              ),
            ),
          ),
        ]
        return [schema.nodes.table.create(undefined, rows)]
      }
      case 'html':
        return createParagraphsFromText(stripHtmlTags((token as Tokens.HTML).text ?? (token as Tokens.HTML).raw ?? ''), context)
      default:
        if ('tokens' in token && Array.isArray(token.tokens)) return [createParagraph(token.tokens, context)]
        if ('text' in token && typeof token.text === 'string') return createParagraphsFromText(token.text, context)
        return []
    }
  })
}

export function markdownToDocument(markdown: string, options: { baseParagraphAttrs?: ParagraphAttrs } = {}) {
  const normalized = normalizeMarkdown(markdown)

  try {
    const tokens = marked.lexer(normalized, { gfm: true, breaks: true })
    const blocks = blocksFromTokens(tokens, { baseParagraphAttrs: options.baseParagraphAttrs })
    return schema.nodes.doc.create(
      undefined,
      blocks.length > 0
        ? blocks
        : [schema.nodes.paragraph.create(mergeParagraphAttrs(options.baseParagraphAttrs))],
    )
  } catch (error) {
    console.warn('[markdown importer] Failed to parse markdown, falling back to plain text:', error)
    const fallback = createParagraphsFromText(normalized, { baseParagraphAttrs: options.baseParagraphAttrs })
    return schema.nodes.doc.create(
      undefined,
      fallback.length > 0
        ? fallback
        : [schema.nodes.paragraph.create(mergeParagraphAttrs(options.baseParagraphAttrs))],
    )
  }
}

export function markdownToFragment(markdown: string, options: { baseParagraphAttrs?: ParagraphAttrs } = {}) {
  return markdownToDocument(markdown, options).content
}
