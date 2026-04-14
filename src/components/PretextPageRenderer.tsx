import React from 'react'
import type { PageConfig, RenderedLine, RenderedPage, RenderUnit } from '../layout/paginator'

interface PretextPageRendererProps {
  pages: RenderedPage[]
  pageConfig: PageConfig
  pageGap: number
  caretPos?: number | null
  selectionFrom?: number | null
  selectionTo?: number | null
  showCaret?: boolean
  showSelection?: boolean
  onRequestCaretPos?: (pos: number) => void
  onRequestSelectionRange?: (anchor: number, head: number) => void
}

function getTextDecoration(unit: RenderUnit) {
  const decorations: string[] = []
  if (unit.style.underline) decorations.push('underline')
  if (unit.style.strikethrough) decorations.push('line-through')
  return decorations.join(' ') || undefined
}

function getVerticalOffset(unit: RenderUnit) {
  if (unit.style.superscript) return '-0.35em'
  if (unit.style.subscript) return '0.2em'
  return '0'
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
  showCaret = false,
  showSelection = false,
  onRequestCaretPos,
  onRequestSelectionRange,
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
      if (pos === anchor) onRequestCaretPos?.(pos)
      else onRequestSelectionRange?.(anchor, pos)
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
      onMouseDown={(event) => {
        if ((!onRequestCaretPos && !onRequestSelectionRange) || event.button !== 0) return
        const pos = getPointerCaretPos(event.clientX, event.clientY)
        if (typeof pos !== 'number') return
        event.preventDefault()
        dragStateRef.current = { active: true, anchor: pos }
        onRequestCaretPos?.(pos)
      }}
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
        return page.lines.map((line) => {
          const metrics = getLineLayoutMetrics(line, pageIndex, pageConfig, pageGap)
          const isHorizontalRule = line.blockType === 'horizontal_rule'

          return (
            <div
              key={`${pageIndex}-${line.blockIndex}-${line.lineIndex}-${line.startPos ?? 0}`}
              style={{
                position: 'absolute',
                top: metrics.top,
                left: metrics.left,
                height: line.lineHeight,
                display: 'flex',
                alignItems: 'flex-end',
                width: metrics.justifyEnabled ? line.availableWidth : Math.max(1, line.renderedWidth),
                whiteSpace: 'pre',
                overflow: 'visible',
              }}
            >
              {isHorizontalRule ? (
                <div
                  style={{
                    alignSelf: 'center',
                    width: Math.max(40, line.availableWidth),
                    borderTop: '1px solid #cbd5e1',
                    opacity: 0.95,
                  }}
                />
              ) : line.units.length > 0 ? (
                line.units.map((unit, index) => {
                  const isLastUnit = index === line.units.length - 1
                  const boxWidth = unit.renderWidth + (metrics.justifyEnabled && !isLastUnit ? metrics.justifyExtra : 0)
                  const fontSizePt = unit.style.superscript || unit.style.subscript
                    ? unit.style.fontSize * 0.75
                    : unit.style.fontSize

                  return (
                    <span
                      key={`${unit.startPos ?? index}-${unit.text}`}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'flex-end',
                        justifyContent: unit.anchor === 'end' ? 'flex-end' : 'flex-start',
                        width: Math.max(0, boxWidth),
                        minWidth: 0,
                        overflow: 'visible',
                        whiteSpace: 'pre',
                        fontFamily: unit.style.fontFamily,
                        fontSize: `${fontSizePt}pt`,
                        fontWeight: unit.style.bold ? 700 : 400,
                        fontStyle: unit.style.italic ? 'italic' : 'normal',
                        letterSpacing: unit.style.letterSpacing ? `${unit.style.letterSpacing}pt` : undefined,
                        color: unit.style.color || '#000000',
                        backgroundColor: unit.style.backgroundColor || undefined,
                        textDecoration: getTextDecoration(unit),
                        lineHeight: `${line.lineHeight}px`,
                        transform: `translateY(${getVerticalOffset(unit)})`,
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
          )
        })
      })}
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
