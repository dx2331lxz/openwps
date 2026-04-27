import React from 'react'
import type {
  FloatingParagraph,
  PageConfig,
  RenderedTableCell,
  RenderedFloatingObject,
  RenderedLine,
  RenderedPage,
  RenderUnit,
} from '../layout/paginator'

const DEFAULT_RENDER_TEXT_STYLE = {
  fontFamily: 'serif',
  fontSize: 12,
  color: '#000000',
  backgroundColor: '',
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  superscript: false,
  subscript: false,
  letterSpacing: 0,
} as const

function getSafeTextStyle(style: Partial<RenderUnit['style']> | undefined) {
  return { ...DEFAULT_RENDER_TEXT_STYLE, ...(style ?? {}) }
}

function getTextColor(style: ReturnType<typeof getSafeTextStyle>, hasLink: boolean) {
  return hasLink ? '#0b57d0' : (style.color || '#000000')
}

interface PretextPageRendererProps {
  pages: RenderedPage[]
  pageConfig: PageConfig
  pageGap: number
  caretPos?: number | null
  selectionFrom?: number | null
  selectionTo?: number | null
  selectedNodePos?: number | null
  showCaret?: boolean
  showSelection?: boolean
  onRequestCaretPos?: (pos: number, clientX: number, clientY: number) => void
  onRequestSelectionRange?: (anchor: number, head: number) => void
  onRequestNodeSelection?: (pos: number) => void
  ghostCompletion?: {
    pages: RenderedPage[]
    from: number
    to: number
  } | null
}

function renderFloatingParagraph(paragraph: FloatingParagraph, index: number) {
  return (
    <div
      key={`floating-paragraph-${index}`}
      style={{
        textAlign: paragraph.align,
        lineHeight: `${paragraph.lineHeight}px`,
        minHeight: paragraph.lineHeight,
        whiteSpace: 'pre-wrap',
      }}
    >
      {paragraph.runs.map((run, runIndex) => (
        (() => {
          const style = getSafeTextStyle(run.style)
          return (
            <span
              key={`floating-run-${runIndex}-${run.text}`}
              style={{
                fontFamily: style.fontFamily,
                fontSize: `${style.fontSize}pt`,
                fontWeight: style.bold ? 700 : 400,
                fontStyle: style.italic ? 'italic' : 'normal',
                letterSpacing: style.letterSpacing ? `${style.letterSpacing}pt` : undefined,
                color: getTextColor(style, run.hasLink),
                backgroundColor: run.hasComment ? 'rgba(253, 224, 71, 0.35)' : (style.backgroundColor || undefined),
                textDecoration: [
                  style.underline || run.hasLink ? 'underline' : '',
                  style.strikethrough ? 'line-through' : '',
                ].filter(Boolean).join(' ') || undefined,
              }}
            >
              {run.text}
            </span>
          )
        })()
      ))}
    </div>
  )
}

function renderFloatingObject(
  object: RenderedFloatingObject,
  pageIndex: number,
  pageConfig: PageConfig,
  pageGap: number,
  onRequestCaretPos?: (pos: number, clientX: number, clientY: number) => void
) {
  const pageTop = pageIndex * (pageConfig.pageHeight + pageGap)
  const commonStyle: React.CSSProperties = {
    position: 'absolute',
    left: object.left,
    top: pageTop + object.top,
    width: object.width,
    minHeight: Math.max(object.height, 1),
    boxSizing: 'border-box',
    paddingTop: object.paddingTop,
    paddingRight: object.paddingRight,
    paddingBottom: object.paddingBottom,
    paddingLeft: object.paddingLeft,
    pointerEvents: object.kind === 'image' ? 'auto' : 'none',
    zIndex: object.behindDoc ? 0 : 3,
  }

  if (object.kind === 'image' && object.src) {
    return (
      <img
        key={`floating-object-${pageIndex}-${object.blockIndex}`}
        src={object.src}
        alt={object.alt}
        title={object.title}
        onMouseDown={(event) => {
          if (!onRequestCaretPos || event.button !== 0) return
          event.preventDefault()
          event.stopPropagation()
          onRequestCaretPos(object.blockPos + 1, event.clientX, event.clientY)
        }}
        style={{
          ...commonStyle,
          height: object.height || undefined,
          objectFit: 'contain',
          cursor: 'text',
        }}
      />
    )
  }

  return (
    <div
      key={`floating-object-${pageIndex}-${object.blockIndex}`}
      style={{
        ...commonStyle,
        background: 'transparent',
        overflow: 'visible',
      }}
    >
      {object.paragraphs.map(renderFloatingParagraph)}
    </div>
  )
}

function getTextDecoration(unit: RenderUnit) {
  const style = getSafeTextStyle(unit.style)
  const decorations: string[] = []
  if (style.underline || unit.hasLink) decorations.push('underline')
  if (style.strikethrough) decorations.push('line-through')
  return decorations.join(' ') || undefined
}

function getVerticalOffset(unit: RenderUnit) {
  const style = getSafeTextStyle(unit.style)
  if (style.superscript) return '-0.35em'
  if (style.subscript) return '0.2em'
  return '0'
}

function getUnitBackgroundColor(unit: RenderUnit) {
  if (unit.hasComment) return 'rgba(253, 224, 71, 0.35)'
  return getSafeTextStyle(unit.style).backgroundColor || undefined
}

function getUnitUnderline(unit: RenderUnit) {
  if (!unit.hasComment) return undefined
  return 'inset 0 -2px 0 #f59e0b'
}

interface LineLayoutMetrics {
  left: number
  top: number
  justifyEnabled: boolean
  justifyExtra: number
}

function getLineLayoutMetrics(
  line: RenderedLine & { top: number },
  pageIndex: number,
  pageConfig: PageConfig,
  pageGap: number
): LineLayoutMetrics {
  const remainingWidth = Math.max(0, line.availableWidth - line.renderedWidth)
  const justifyEnabled =
    line.align === 'justify' && !line.isLastLineOfParagraph && line.units.length > 1
  const justifyExtra = justifyEnabled
    ? remainingWidth / Math.max(1, line.units.length - 1)
    : 0
  const left =
    pageConfig.marginLeft +
    line.xOffset +
    (line.align === 'center'
      ? remainingWidth / 2
      : line.align === 'right'
        ? remainingWidth
        : 0)
  const top = pageIndex * (pageConfig.pageHeight + pageGap) + pageConfig.marginTop + line.top

  return {
    left,
    top,
    justifyEnabled,
    justifyExtra,
  }
}

function renderListMarker(
  line: RenderedLine & { top: number },
  metrics: LineLayoutMetrics,
) {
  if (line.blockType !== 'paragraph' || line.lineIndex !== 0 || !line.listType) return null

  const marker = line.listType === 'task'
    ? (line.listChecked ? '☑' : '☐')
    : line.listType === 'ordered'
      ? `${line.listIndex ?? 1}.`
      : '•'

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        left: metrics.left - 24,
        top: metrics.top,
        width: 20,
        height: line.lineHeight,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#4b5563',
        fontSize: line.listType === 'bullet' ? 22 : 16,
        lineHeight: 1,
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    >
      {marker}
    </div>
  )
}

function renderGhostCompletion(
  ghostCompletion: NonNullable<PretextPageRendererProps['ghostCompletion']>,
  pageConfig: PageConfig,
  pageGap: number,
) {
  const from = Math.min(ghostCompletion.from, ghostCompletion.to)
  const to = Math.max(ghostCompletion.from, ghostCompletion.to)
  if (from === to) return null

  return ghostCompletion.pages.map((page, pageIndex) => (
    <React.Fragment key={`ghost-page-${pageIndex}`}>
      {page.lines.map((line) => {
        const metrics = getLineLayoutMetrics(line, pageIndex, pageConfig, pageGap)
        let cursorX = 0
        const unitOffsets = line.units.map((unit, index) => {
          const isLastUnit = index === line.units.length - 1
          const boxWidth = unit.renderWidth + (metrics.justifyEnabled && !isLastUnit ? metrics.justifyExtra : 0)
          const offset = typeof unit.offsetX === 'number' ? unit.offsetX : cursorX
          cursorX += boxWidth
          return offset
        })
        const ghostUnits = line.units.filter((unit) => (
          typeof unit.startPos === 'number' &&
          typeof unit.endPos === 'number' &&
          unit.endPos > from &&
          unit.startPos < to
        ))
        if (ghostUnits.length === 0) return null

        return (
          <div
            key={`ghost-line-${pageIndex}-${line.blockIndex}-${line.lineIndex}-${line.startPos ?? 0}`}
            data-openwps-ai-ghost="true"
            style={{
              position: 'absolute',
              top: metrics.top,
              left: metrics.left,
              height: line.lineHeight,
              display: 'block',
              width: metrics.justifyEnabled ? line.availableWidth : Math.max(1, line.renderedWidth),
              whiteSpace: 'pre',
              overflow: 'visible',
              pointerEvents: 'none',
              zIndex: 2,
            }}
          >
            {line.units.map((unit, index) => {
              const unitStart = typeof unit.startPos === 'number' ? unit.startPos : null
              const unitEnd = typeof unit.endPos === 'number' ? unit.endPos : null
              const inGhostRange = unitStart != null && unitEnd != null && unitEnd > from && unitStart < to
              if (!inGhostRange) return null

              const style = getSafeTextStyle(unit.style)
              const isLastUnit = index === line.units.length - 1
              const boxWidth = unit.renderWidth + (metrics.justifyEnabled && !isLastUnit ? metrics.justifyExtra : 0)
              const fontSizePt = style.superscript || style.subscript
                ? style.fontSize * 0.75
                : style.fontSize

              return (
                <span
                  key={`ghost-${unit.startPos ?? index}-${unit.text}`}
                  style={{
                    position: 'absolute',
                    left: unitOffsets[index],
                    top: 0,
                    display: 'inline-flex',
                    alignItems: 'flex-end',
                    justifyContent: unit.anchor === 'end' ? 'flex-end' : 'flex-start',
                    width: Math.max(0, boxWidth),
                    minWidth: 0,
                    overflow: 'visible',
                    whiteSpace: 'pre',
                    fontFamily: style.fontFamily,
                    fontSize: `${fontSizePt}pt`,
                    fontWeight: style.bold ? 700 : 400,
                    fontStyle: style.italic ? 'italic' : 'normal',
                    letterSpacing: style.letterSpacing ? `${style.letterSpacing}pt` : undefined,
                    color: '#9ca3af',
                    opacity: 0.9,
                    lineHeight: `${line.lineHeight}px`,
                    transform: `translateY(${getVerticalOffset(unit)})`,
                  }}
                >
                  {unit.text}
                </span>
              )
            })}
          </div>
        )
      })}
    </React.Fragment>
  ))
}

function getHorizontalRuleStyle(ruleStyle: string | undefined, ruleColor: string | undefined, selected: boolean): React.CSSProperties {
  const color = ruleColor || '#cbd5e1'
  const selectionGlow = selected ? '0 0 0 12px rgba(37, 99, 235, 0.12)' : undefined
  const selectionFill = selected ? 'rgba(37, 99, 235, 0.08)' : undefined

  switch (ruleStyle) {
    case 'dotted':
      return {
        height: 2,
        backgroundImage: `repeating-linear-gradient(to right, ${color} 0 2px, transparent 2px 6px)`,
        backgroundColor: selectionFill,
        boxShadow: selectionGlow,
        borderRadius: 2,
      }
    case 'dashed':
      return {
        height: 2,
        backgroundImage: `repeating-linear-gradient(to right, ${color} 0 12px, transparent 12px 18px)`,
        backgroundColor: selectionFill,
        boxShadow: selectionGlow,
        borderRadius: 2,
      }
    case 'dash-dot':
      return {
        height: 2,
        backgroundImage: `repeating-linear-gradient(to right, ${color} 0 12px, transparent 12px 16px, ${color} 16px 18px, transparent 18px 24px)`,
        backgroundColor: selectionFill,
        boxShadow: selectionGlow,
        borderRadius: 2,
      }
    case 'double':
      return {
        height: 5,
        borderTop: `1px solid ${color}`,
        borderBottom: `1px solid ${color}`,
        backgroundColor: selectionFill,
        boxShadow: selectionGlow,
        borderRadius: 2,
      }
    default:
      return {
        height: 1,
        borderTop: `1px solid ${color}`,
        backgroundColor: selectionFill,
        boxShadow: selectionGlow,
        borderRadius: 2,
      }
  }
}

function renderTableOfContentsBox(line: RenderedLine & { top: number }, selected: boolean) {
  const entries = line.tocEntries ?? []
  return (
    <div
      style={{
        width: line.availableWidth,
        height: Math.max(72, line.lineHeight - 8),
        border: selected ? '1px solid #2563eb' : '1px solid transparent',
        background: selected ? 'rgba(37, 99, 235, 0.06)' : 'transparent',
        boxShadow: selected ? '0 0 0 3px rgba(37, 99, 235, 0.12)' : undefined,
        boxSizing: 'border-box',
        padding: '4px 0',
        color: '#111827',
        fontFamily: '"OpenWPSSong", SimSun, "Songti SC", serif',
        overflow: 'hidden',
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 700, lineHeight: '28px', textAlign: 'center', marginBottom: 8 }}>
        {line.tocTitle || line.text || '目录'}
      </div>
      {entries.length > 0 ? entries.map((entry, index) => (
        <div
          key={`${entry.blockIndex}-${entry.title}-${index}`}
          data-pretext-toc-entry={entry.title}
          data-pretext-toc-level={entry.level}
          data-pretext-toc-page={entry.page ?? ''}
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr auto',
            alignItems: 'baseline',
            columnGap: 8,
            height: 24,
            paddingLeft: Math.max(0, entry.level - 1) * 24,
            fontSize: entry.level === 1 ? 14 : 13,
            fontWeight: entry.level === 1 ? 600 : 400,
            lineHeight: '24px',
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {entry.title}
          </span>
          <span
            aria-hidden="true"
            style={{
              borderBottom: '1px dotted #64748b',
              transform: 'translateY(-4px)',
              minWidth: 24,
            }}
          />
          <span>{entry.page ?? ''}</span>
        </div>
      )) : (
        <div style={{ color: '#64748b', fontSize: 13, lineHeight: '24px' }}>
          暂无可生成目录的标题
        </div>
      )}
    </div>
  )
}

function renderReadonlyTableCell(
  cell: RenderedTableCell,
  cellIndex: number,
  onRequestCaretPos: PretextPageRendererProps['onRequestCaretPos'],
) {
  const tag = cell.header ? 'th' : 'td'
  const content = cell.paragraphs.length ? cell.paragraphs : [cell.text]
  const handleMouseDown = (event: React.MouseEvent) => {
    if (event.button !== 0 || typeof cell.firstTextPos !== 'number') return
    event.preventDefault()
    event.stopPropagation()
    onRequestCaretPos?.(cell.firstTextPos, event.clientX, event.clientY)
  }

  return React.createElement(
    tag,
    {
      key: `cell-${cellIndex}`,
      colSpan: cell.colspan > 1 ? cell.colspan : undefined,
      rowSpan: cell.rowspan > 1 ? cell.rowspan : undefined,
      'data-pretext-table-cell': 'true',
      onMouseDown: handleMouseDown,
      style: {
        width: cell.width,
        minWidth: 40,
        height: cell.height,
        boxSizing: 'border-box',
        border: `${cell.borderWidth}px solid ${cell.borderColor}`,
        padding: '4px 8px',
        verticalAlign: 'top',
        backgroundColor: cell.backgroundColor || undefined,
        fontWeight: cell.header ? 700 : 400,
        textAlign: 'left',
        pointerEvents: 'auto',
        cursor: 'text',
        overflow: 'hidden',
      } satisfies React.CSSProperties,
    },
    content.map((paragraph, paragraphIndex) => (
      <p
        key={`paragraph-${paragraphIndex}`}
        style={{
          margin: 0,
          padding: 0,
          minHeight: '1.5em',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          wordBreak: 'normal',
          lineBreak: 'strict',
        }}
      >
        {paragraph}
      </p>
    )),
  )
}

function renderReadonlyTable(
  line: RenderedLine & { top: number },
  onRequestCaretPos: PretextPageRendererProps['onRequestCaretPos'],
) {
  if (!line.table) return <span style={{ width: 1, height: line.lineHeight }} />

  return (
    <table
      data-pretext-table="true"
      style={{
        borderCollapse: 'collapse',
        width: line.table.width,
        height: line.table.height,
        boxSizing: 'border-box',
        tableLayout: 'fixed',
        fontFamily: DEFAULT_RENDER_TEXT_STYLE.fontFamily,
        fontSize: `${DEFAULT_RENDER_TEXT_STYLE.fontSize}pt`,
        lineHeight: 1.5,
        color: DEFAULT_RENDER_TEXT_STYLE.color,
        whiteSpace: 'normal',
        pointerEvents: 'auto',
      }}
    >
      <tbody>
        {line.table.rows.map((row, rowIndex) => (
          <tr key={`row-${rowIndex}`} style={{ height: row.height }}>
            {row.cells.map((cell, cellIndex) => renderReadonlyTableCell(cell, cellIndex, onRequestCaretPos))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function getCaretRect(
  pages: RenderedPage[],
  pageConfig: PageConfig,
  pageGap: number,
  caretPos: number | null | undefined
) {
  if (caretPos == null) return null

  let lastRect: { left: number; top: number; height: number } | null = null

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex]!

    for (const line of page.lines) {
      const metrics = getLineLayoutMetrics(line, pageIndex, pageConfig, pageGap)
      const caretTop = metrics.top
      const caretHeight = line.lineHeight

      if (line.units.length === 0) {
        if (caretPos === line.startPos) {
          return { left: metrics.left, top: caretTop, height: caretHeight }
        }
        lastRect = { left: metrics.left, top: caretTop, height: caretHeight }
        continue
      }

      let cursorX = metrics.left
      for (let index = 0; index < line.units.length; index += 1) {
        const unit = line.units[index]!
        const isLastUnit = index === line.units.length - 1
        if (typeof unit.offsetX === 'number') cursorX = metrics.left + unit.offsetX
        const boxWidth = unit.renderWidth + (metrics.justifyEnabled && !isLastUnit ? metrics.justifyExtra : 0)

        if (caretPos === unit.startPos) {
          return { left: cursorX, top: caretTop, height: caretHeight }
        }

        cursorX += boxWidth

        if (caretPos === unit.endPos) {
          return { left: cursorX, top: caretTop, height: caretHeight }
        }
      }

      lastRect = { left: cursorX, top: caretTop, height: caretHeight }
    }
  }

  return lastRect
}

function getLineBoundaryStops(
  line: RenderedLine & { top: number },
  metrics: LineLayoutMetrics
) {
  const stops: Array<{ pos: number; x: number }> = []

  if (line.units.length === 0) {
    if (typeof line.startPos === 'number') stops.push({ pos: line.startPos, x: metrics.left })
    return stops
  }

  let cursorX = metrics.left

  for (let index = 0; index < line.units.length; index += 1) {
    const unit = line.units[index]!
    const isLastUnit = index === line.units.length - 1
    if (typeof unit.offsetX === 'number') cursorX = metrics.left + unit.offsetX
    const boxWidth = unit.renderWidth + (metrics.justifyEnabled && !isLastUnit ? metrics.justifyExtra : 0)

    if (typeof unit.startPos === 'number' && !stops.some((stop) => stop.pos === unit.startPos)) {
      stops.push({ pos: unit.startPos, x: cursorX })
    }

    cursorX += boxWidth

    if (typeof unit.endPos === 'number') {
      const existing = stops.find((stop) => stop.pos === unit.endPos)
      if (existing) existing.x = cursorX
      else stops.push({ pos: unit.endPos, x: cursorX })
    }
  }

  return stops
}

function getClosestCaretPos(
  pages: RenderedPage[],
  pageConfig: PageConfig,
  pageGap: number,
  x: number,
  y: number
) {
  let bestLine:
    | {
      line: RenderedLine & { top: number }
      metrics: LineLayoutMetrics
      distance: number
    }
    | null = null

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex]!

    for (const line of page.lines) {
      const metrics = getLineLayoutMetrics(line, pageIndex, pageConfig, pageGap)
      const lineTop = metrics.top
      const lineBottom = lineTop + line.lineHeight
      const distance =
        y < lineTop ? lineTop - y : y > lineBottom ? y - lineBottom : 0

      if (!bestLine || distance < bestLine.distance) {
        bestLine = { line, metrics, distance }
      }
    }
  }

  if (!bestLine) return null

  const stops = getLineBoundaryStops(bestLine.line, bestLine.metrics)
  if (stops.length === 0) return null

  let bestStop = stops[0]!
  let minDistance = Math.abs(x - bestStop.x)

  for (let index = 1; index < stops.length; index += 1) {
    const stop = stops[index]!
    const distance = Math.abs(x - stop.x)
    if (distance < minDistance) {
      bestStop = stop
      minDistance = distance
    }
  }

  return bestStop.pos
}

function getStopX(stops: Array<{ pos: number; x: number }>, pos: number) {
  const exact = stops.find((stop) => stop.pos === pos)
  if (exact) return exact.x
  if (pos <= stops[0]!.pos) return stops[0]!.x
  if (pos >= stops[stops.length - 1]!.pos) return stops[stops.length - 1]!.x

  for (let index = 1; index < stops.length; index += 1) {
    const prev = stops[index - 1]!
    const next = stops[index]!
    if (pos > prev.pos && pos < next.pos) {
      const ratio = (pos - prev.pos) / Math.max(1, next.pos - prev.pos)
      return prev.x + (next.x - prev.x) * ratio
    }
  }

  return stops[stops.length - 1]!.x
}

function getSelectionRects(
  pages: RenderedPage[],
  pageConfig: PageConfig,
  pageGap: number,
  selectionFrom: number | null | undefined,
  selectionTo: number | null | undefined
) {
  if (selectionFrom == null || selectionTo == null || selectionFrom === selectionTo) return []

  const from = Math.min(selectionFrom, selectionTo)
  const to = Math.max(selectionFrom, selectionTo)
  const rects: Array<{ left: number; top: number; width: number; height: number }> = []

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex]!

    for (const line of page.lines) {
      const metrics = getLineLayoutMetrics(line, pageIndex, pageConfig, pageGap)
      const stops = getLineBoundaryStops(line, metrics)
      if (stops.length < 2) continue

      const lineStart = stops[0]!.pos
      const lineEnd = stops[stops.length - 1]!.pos
      const overlapFrom = Math.max(from, lineStart)
      const overlapTo = Math.min(to, lineEnd)

      if (overlapFrom >= overlapTo) continue

      const startX = getStopX(stops, overlapFrom)
      const endX = getStopX(stops, overlapTo)
      const width = Math.max(0, endX - startX)
      if (width <= 0) continue

      rects.push({
        left: startX,
        top: metrics.top,
        width,
        height: line.lineHeight,
      })
    }
  }

  return rects
}

export const PretextPageRenderer: React.FC<PretextPageRendererProps> = ({
  pages,
  pageConfig,
  pageGap,
  caretPos,
  selectionFrom,
  selectionTo,
  selectedNodePos,
  showCaret = false,
  showSelection = false,
  onRequestCaretPos,
  onRequestSelectionRange,
  onRequestNodeSelection,
  ghostCompletion,
}) => {
  const caretRect = showCaret ? getCaretRect(pages, pageConfig, pageGap, caretPos) : null
  const selectionRects = showSelection
    ? getSelectionRects(pages, pageConfig, pageGap, selectionFrom, selectionTo)
    : []
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const dragStateRef = React.useRef<{ active: boolean; anchor: number | null }>({
    active: false,
    anchor: null,
  })

  const getPointerCaretPos = React.useCallback((clientX: number, clientY: number) => {
    const container = containerRef.current
    if (!container) return null
    const rect = container.getBoundingClientRect()
    return getClosestCaretPos(
      pages,
      pageConfig,
      pageGap,
      clientX - rect.left,
      clientY - rect.top
    )
  }, [pageConfig, pageGap, pages])

  React.useEffect(() => {
    if (!onRequestSelectionRange && !onRequestCaretPos) return undefined

    const handleMove = (event: MouseEvent) => {
      const drag = dragStateRef.current
      if (!drag.active || drag.anchor == null || !onRequestSelectionRange) return
      const pos = getPointerCaretPos(event.clientX, event.clientY)
      if (typeof pos !== 'number') return
      event.preventDefault()
      onRequestSelectionRange(drag.anchor, pos)
    }

    const handleUp = (event: MouseEvent) => {
      const drag = dragStateRef.current
      if (!drag.active) return
      drag.active = false
      const anchor = drag.anchor
      drag.anchor = null
      if (anchor == null) return

      const pos = getPointerCaretPos(event.clientX, event.clientY)
      if (typeof pos !== 'number') return
      if (pos !== anchor) onRequestSelectionRange?.(anchor, pos)
    }

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [getPointerCaretPos, onRequestCaretPos, onRequestSelectionRange])

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 1,
      }}
    >
      {selectionRects.map((rect, index) => (
        <div
          key={`selection-${index}-${rect.left}-${rect.top}`}
          style={{
            position: 'absolute',
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            background: 'rgba(24, 119, 242, 0.22)',
            borderRadius: 1,
            zIndex: 1,
            pointerEvents: 'none',
          }}
        />
      ))}
      {pages.map((page, pageIndex) => {
        return (
          <React.Fragment key={`page-${pageIndex}`}>
            {page.floatingObjects.map((object) => renderFloatingObject(object, pageIndex, pageConfig, pageGap, onRequestCaretPos))}
            {page.lines.map((line) => {
              const metrics = getLineLayoutMetrics(line, pageIndex, pageConfig, pageGap)
              const isHorizontalRule = line.blockType === 'horizontal_rule'
              const horizontalRulePos = isHorizontalRule && typeof line.startPos === 'number' ? line.startPos - 1 : null
              const isHorizontalRuleSelected = horizontalRulePos != null && selectedNodePos === horizontalRulePos
              const isTableOfContents = line.blockType === 'table_of_contents'
              const tableOfContentsPos = isTableOfContents && typeof line.startPos === 'number' ? line.startPos - 1 : null
              const isTableOfContentsSelected = tableOfContentsPos != null && selectedNodePos === tableOfContentsPos
              const isTable = line.blockType === 'table'
              const isParagraphLine = line.blockType === 'paragraph'
              const listMarkerHitInset = line.lineIndex === 0 && line.listType ? 28 : 0
              const hitZoneLeft = pageConfig.marginLeft + line.xOffset - listMarkerHitInset
              const hitZoneWidth = Math.max(1, line.availableWidth + listMarkerHitInset)

              return (
                <React.Fragment key={`${pageIndex}-${line.blockIndex}-${line.lineIndex}-${line.startPos ?? 0}`}>
                  {renderListMarker(line, metrics)}

                  {isParagraphLine && (
                    <div
                      data-pretext-hit="text-line"
                      onMouseDown={(event) => {
                        if ((!onRequestCaretPos && !onRequestSelectionRange) || event.button !== 0) return
                        const pos = getPointerCaretPos(event.clientX, event.clientY)
                        if (typeof pos !== 'number') return
                        event.preventDefault()
                        dragStateRef.current = { active: true, anchor: pos }
                        onRequestCaretPos?.(pos, event.clientX, event.clientY)
                      }}
                      style={{
                        position: 'absolute',
                        top: metrics.top,
                        left: hitZoneLeft,
                        width: hitZoneWidth,
                        height: line.lineHeight,
                        pointerEvents: 'auto',
                        background: 'transparent',
                        cursor: 'text',
                        zIndex: 0,
                      }}
                    />
                  )}

                  {isHorizontalRule && horizontalRulePos != null && (
                    <div
                      data-pretext-hit="horizontal-rule"
                      onMouseDown={(event) => {
                        if (!onRequestNodeSelection || event.button !== 0) return
                        event.preventDefault()
                        onRequestNodeSelection(horizontalRulePos)
                      }}
                      style={{
                        position: 'absolute',
                        top: metrics.top,
                        left: metrics.left,
                        width: line.availableWidth,
                        height: line.lineHeight,
                        pointerEvents: 'auto',
                        background: 'transparent',
                        cursor: 'pointer',
                        zIndex: 0,
                      }}
                    />
                  )}

                  {isTableOfContents && tableOfContentsPos != null && (
                    <div
                      data-pretext-hit="table-of-contents"
                      onMouseDown={(event) => {
                        if (!onRequestNodeSelection || event.button !== 0) return
                        event.preventDefault()
                        onRequestNodeSelection(tableOfContentsPos)
                      }}
                      style={{
                        position: 'absolute',
                        top: metrics.top,
                        left: metrics.left,
                        width: line.availableWidth,
                        height: line.lineHeight,
                        pointerEvents: 'auto',
                        background: 'transparent',
                        cursor: 'pointer',
                        zIndex: 0,
                      }}
                    />
                  )}

                  <div
                    style={{
                      position: 'absolute',
                      top: metrics.top,
                      left: metrics.left,
                      height: line.lineHeight,
                      display: isTable || line.units.some((unit) => typeof unit.offsetX === 'number') ? 'block' : 'flex',
                      alignItems: 'flex-end',
                      width: isHorizontalRule || isTableOfContents || isTable
                        ? line.availableWidth
                        : metrics.justifyEnabled
                          ? line.availableWidth
                          : Math.max(1, line.renderedWidth),
                      whiteSpace: 'pre',
                      overflow: 'visible',
                      pointerEvents: 'none',
                    }}
                  >
                    {isHorizontalRule ? (
                      <div
                        style={{
                          alignSelf: 'center',
                          width: Math.max(40, line.availableWidth),
                          flexShrink: 0,
                          opacity: 0.95,
                          ...getHorizontalRuleStyle(line.lineStyle, line.lineColor, isHorizontalRuleSelected),
                        }}
                      />
                    ) : isTableOfContents ? (
                      renderTableOfContentsBox(line, isTableOfContentsSelected)
                    ) : isTable ? (
                      renderReadonlyTable(line, onRequestCaretPos)
                    ) : line.units.length > 0 ? (
                      line.units.map((unit, index) => {
                        const style = getSafeTextStyle(unit.style)
                        const isLastUnit = index === line.units.length - 1
                        const boxWidth = unit.renderWidth + (metrics.justifyEnabled && !isLastUnit ? metrics.justifyExtra : 0)
                        const fontSizePt = style.superscript || style.subscript
                          ? style.fontSize * 0.75
                          : style.fontSize

                        return (
                          <span
                            key={`${unit.startPos ?? index}-${unit.text}`}
                            style={{
                              position: typeof unit.offsetX === 'number' ? 'absolute' : 'relative',
                              left: typeof unit.offsetX === 'number' ? unit.offsetX : undefined,
                              top: typeof unit.offsetX === 'number' ? 0 : undefined,
                              display: 'inline-flex',
                              alignItems: 'flex-end',
                              justifyContent: unit.anchor === 'end' ? 'flex-end' : 'flex-start',
                              width: Math.max(0, boxWidth),
                              minWidth: 0,
                              overflow: 'visible',
                              whiteSpace: 'pre',
                              fontFamily: style.fontFamily,
                              fontSize: `${fontSizePt}pt`,
                              fontWeight: style.bold ? 700 : 400,
                              fontStyle: style.italic ? 'italic' : 'normal',
                              letterSpacing: style.letterSpacing ? `${style.letterSpacing}pt` : undefined,
                              color: getTextColor(style, unit.hasLink),
                              backgroundColor: getUnitBackgroundColor(unit),
                              textDecoration: getTextDecoration(unit),
                              lineHeight: `${line.lineHeight}px`,
                              transform: `translateY(${getVerticalOffset(unit)})`,
                              boxShadow: getUnitUnderline(unit),
                            }}
                          >
                            {unit.text}
                          </span>
                        )
                      })
                    ) : (
                      <span style={{ width: 1, height: line.lineHeight }} />
                    )}
                  </div>
                </React.Fragment>
              )
            })}
          </React.Fragment>
        )
      })}
      {ghostCompletion && renderGhostCompletion(ghostCompletion, pageConfig, pageGap)}
      {caretRect && (
        <div
          style={{
            position: 'absolute',
            left: caretRect.left,
            top: caretRect.top,
            width: 1.5,
            height: caretRect.height,
            background: '#111',
            borderRadius: 1,
            zIndex: 2,
            animation: 'openwps-caret-blink 1.05s steps(1) infinite',
          }}
        />
      )}
    </div>
  )
}
