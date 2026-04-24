import { Node as PMNode } from 'prosemirror-model'
import { EditorView } from 'prosemirror-view'
import type { NodeView } from 'prosemirror-view'
import { TextSelection } from 'prosemirror-state'
import { schema } from './schema'

/**
 * ProseMirror NodeView for image nodes.
 *
 * Cursor behaviour:
 *   - Click left half of image  → cursor placed BEFORE the image (pos)
 *   - Click right half of image → cursor placed AFTER the image (pos + 1)
 *   This means Backspace only deletes the image when the cursor is right after it.
 *
 * Resize:
 *   - Drag the bottom-right handle to resize proportionally.
 *   - After resize finishes, onRepaginate() is called so the paginator
 *     recalculates page breaks with the new image height.
 *
 * Auto-width:
 *   - On first insert (width === null) the image auto-fits to the container width.
 */
export class ImageNodeView implements NodeView {
  dom: HTMLElement
  private img: HTMLImageElement
  private node: PMNode
  private view: EditorView
  private getPos: () => number | undefined
  private onRepaginate: () => void
  private getImageBounds: () => { maxWidth: number; maxHeight: number }

  constructor(
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
    getImageBounds: () => { maxWidth: number; maxHeight: number },
    onRepaginate: () => void,
  ) {
    this.node = node
    this.view = view
    this.getPos = getPos
    this.getImageBounds = getImageBounds
    this.onRepaginate = onRepaginate

    const src = String(node.attrs.src ?? '')
    const isSvg = src.startsWith('data:image/svg+xml') || src.endsWith('.svg')

    // ── outer wrapper ─────────────────────────────────────────────────────────
    const wrapper = document.createElement('span')
    wrapper.setAttribute('data-pm-image-wrapper', 'true')
    wrapper.style.cssText = [
      'display:inline-block',
      'position:relative',
      'vertical-align:bottom',
      'max-width:100%',
      'line-height:0',
      'cursor:text',
      'user-select:none',
      'caret-color:transparent',
      'border:2px solid transparent',
      'border-radius:2px',
      'box-sizing:border-box',
      'transition:border-color 0.15s',
    ].join(';')
    // 阻止任何输入/删除操作进入 wrapper，从而替代 contentEditable=false
    // 避免 Chrome 在 contentEditable=false 的 inline 边界渲染 phantom caret
    wrapper.addEventListener('beforeinput', (e) => {
      if (wrapper.contains(e.target as Node)) {
        e.preventDefault()
      }
    })

    // ── img element ───────────────────────────────────────────────────────────
    const img = document.createElement('img')
    this.img = img
    img.src = node.attrs.src
    img.alt = node.attrs.alt ?? ''
    img.title = node.attrs.title ?? ''
    img.draggable = false
    img.style.cssText = 'display:block;max-width:100%;'

    img.onload = () => {
      if (this.node.attrs.width) {
        this._normalizeExistingAttrsToBounds()
        return
      }

      const naturalWidth = img.naturalWidth || (isSvg ? 500 : 0)
      const naturalHeight = img.naturalHeight || (naturalWidth > 0 ? Math.round(naturalWidth * 0.6) : 0)
      if (naturalWidth <= 0 || naturalHeight <= 0) return

      const fitted = this._fitSizeToBounds(
        isSvg ? Math.min(500, naturalWidth || 500) : naturalWidth,
        naturalHeight,
        false,
      )
      this._applyDomSize(fitted.width, fitted.height)
      this._updateAttrs(fitted.width, fitted.height)
    }

    if (node.attrs.width) {
      const fitted = this._fitSizeToBounds(node.attrs.width, node.attrs.height)
      this._applyDomSize(fitted.width, fitted.height)
    }

    // ── resize handle (bottom-right) ──────────────────────────────────────────
    const handle = document.createElement('span')
    handle.style.cssText = [
      'position:absolute',
      'right:0',
      'bottom:0',
      'width:14px',
      'height:14px',
      'background:#2563eb',
      'border-radius:3px 0 0 0',
      'cursor:se-resize',
      'opacity:0',
      'transition:opacity 0.15s',
      'z-index:10',
    ].join(';')

    // hover effects
    wrapper.addEventListener('mouseenter', () => {
      handle.style.opacity = '1'
      wrapper.style.borderColor = '#93c5fd'
    })
    wrapper.addEventListener('mouseleave', () => {
      handle.style.opacity = '0'
      wrapper.style.borderColor = 'transparent'
    })

    // ── Click: place cursor before or after image based on click position ─────
    wrapper.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target === handle) return
      e.preventDefault()

      const pos = this.getPos()
      if (pos === undefined) return

      const { state, dispatch } = this.view
      const rect = wrapper.getBoundingClientRect()
      // Left half → cursor before image (pos), right half → cursor after image (pos + 1)
      const clickedRightHalf = e.clientX >= rect.left + rect.width / 2
      const targetPos = clickedRightHalf ? pos + 1 : pos

      try {
        const sel = TextSelection.create(state.doc, targetPos)
        const tr = state.tr.setSelection(sel).scrollIntoView()
        dispatch(tr)
      } catch { /* ignore — keep current selection rather than forcing a fallback */ }

      this.view.focus()

      // 浏览器 caret 渲染：PM dispatch 后用原生 Selection API 把 caret 拨到正确位置。
      // 因为 wrapper 是 user-select:none，浏览器不会在其内部放 caret；
      // 我们借助 view.coordsAtPos 计算出目标坐标，再用 caretRangeFromPoint 定位。
      requestAnimationFrame(() => {
        try {
          const coords = this.view.coordsAtPos(targetPos)
          const x = clickedRightHalf ? coords.right + 1 : coords.left - 1
          const y = (coords.top + coords.bottom) / 2
          const domSel = window.getSelection()
          if (!domSel) return
          // caretRangeFromPoint 是标准 API（Chrome/Safari/Firefox 均支持）
          const range = document.caretRangeFromPoint
            ? document.caretRangeFromPoint(x, y)
            : null
          if (range) {
            domSel.removeAllRanges()
            domSel.addRange(range)
          }
        } catch { /* ignore */ }
      })
    })

    // ── Resize drag ───────────────────────────────────────────────────────────
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()

      const startX = e.clientX
      const startWidth = img.offsetWidth
      const startHeight = img.offsetHeight
      const aspectRatio = startHeight > 0 && startWidth > 0 ? startHeight / startWidth : 1
      const minWidth = 20
      const { maxWidth, maxHeight } = this.getImageBounds()
      const maxResizeWidth = Math.max(minWidth, Math.min(maxWidth, Math.floor(maxHeight / Math.max(aspectRatio, 0.0001))))

      const onMouseMove = (me: MouseEvent) => {
        const dx = me.clientX - startX
        const rawWidth = Math.max(minWidth, startWidth + dx)
        const newWidth = Math.min(maxResizeWidth, rawWidth)
        this._applyDomSize(newWidth, Math.round(newWidth * aspectRatio))
      }

      const onMouseUp = (ue: MouseEvent) => {
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)

        const dx = ue.clientX - startX
        const rawWidth = Math.max(minWidth, startWidth + dx)
        const finalWidth = Math.min(maxResizeWidth, rawWidth)
        const finalHeight = Math.round(finalWidth * aspectRatio)

        this._updateAttrs(Math.round(finalWidth), finalHeight)
        // Trigger repagination so layout recalculates with new image size
        this.onRepaginate()
      }

      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    })

    wrapper.appendChild(img)
    wrapper.appendChild(handle)

    this.dom = wrapper
  }

  private _getAspectRatio(width?: number | null, height?: number | null) {
    if (typeof width === 'number' && width > 0 && typeof height === 'number' && height > 0) {
      return height / width
    }

    const naturalWidth = this.img.naturalWidth
    const naturalHeight = this.img.naturalHeight
    if (naturalWidth > 0 && naturalHeight > 0) return naturalHeight / naturalWidth

    const renderedWidth = this.img.offsetWidth
    const renderedHeight = this.img.offsetHeight
    if (renderedWidth > 0 && renderedHeight > 0) return renderedHeight / renderedWidth

    return 1
  }

  private _fitSizeToBounds(width: number, height?: number | null, allowUpscale = true) {
    const { maxWidth, maxHeight } = this.getImageBounds()
    const ratio = this._getAspectRatio(width, height)
    const resolvedHeight = typeof height === 'number' && height > 0
      ? height
      : Math.round(width * ratio)

    let fittedWidth = width
    let fittedHeight = resolvedHeight
    const scale = Math.min(
      maxWidth / Math.max(fittedWidth, 1),
      maxHeight / Math.max(fittedHeight, 1),
      allowUpscale ? Number.POSITIVE_INFINITY : 1,
    )

    if (scale < 1 || (!allowUpscale && scale !== Number.POSITIVE_INFINITY)) {
      fittedWidth = Math.max(20, Math.round(fittedWidth * scale))
      fittedHeight = Math.max(1, Math.round(fittedHeight * scale))
    }

    return {
      width: Math.max(20, Math.min(maxWidth, fittedWidth)),
      height: Math.max(1, Math.min(maxHeight, fittedHeight)),
    }
  }

  private _applyDomSize(width: number, height: number) {
    this.img.style.maxWidth = '100%'
    this.img.style.width = `${width}px`
    this.img.style.height = `${height}px`
  }

  private _normalizeExistingAttrsToBounds() {
    if (!this.node.attrs.width) return
    const fitted = this._fitSizeToBounds(this.node.attrs.width, this.node.attrs.height)
    this._applyDomSize(fitted.width, fitted.height)

    if (fitted.width !== this.node.attrs.width || fitted.height !== this.node.attrs.height) {
      this._updateAttrs(fitted.width, fitted.height)
    }
  }

  private _updateAttrs(width: number, height: number | null) {
    const pos = this.getPos()
    if (pos === undefined) return
    const fitted = this._fitSizeToBounds(width, height)
    this._applyDomSize(fitted.width, fitted.height)
    const { state, dispatch } = this.view
    const tr = state.tr.setNodeMarkup(pos, undefined, {
      ...this.node.attrs,
      width: fitted.width,
      height: fitted.height,
    })
    tr.setMeta('addToHistory', false)
    dispatch(tr)
  }

  update(node: PMNode): boolean {
    if (node.type !== schema.nodes.image) return false
    this.node = node
    // 只有 src 真正变化时才赋值，避免触发 onload（否则 resize 后的尺寸会被 onload 里的 auto-fit 覆盖）
    if (this.img.src !== node.attrs.src) {
      this.img.src = node.attrs.src
    }
    this.img.alt = node.attrs.alt ?? ''
    if (node.attrs.width) {
      const fitted = this._fitSizeToBounds(node.attrs.width, node.attrs.height)
      this._applyDomSize(fitted.width, fitted.height)
      if (fitted.width !== node.attrs.width || fitted.height !== node.attrs.height) {
        requestAnimationFrame(() => this._normalizeExistingAttrsToBounds())
      }
    } else {
      // 恢复默认自适应状态
      this.img.style.maxWidth = '100%'
      this.img.style.height = 'auto'
    }
    return true
  }

  stopEvent(event: Event): boolean {
    // Only intercept mousedown events that target THIS image wrapper or its children.
    // Returning true for events on unrelated nodes (e.g. table cells) would
    // prevent ProseMirror from handling them, so we must be precise.
    if (event.type === 'mousedown' && event.target instanceof Node && this.dom.contains(event.target as Node)) {
      return true
    }
    return false
  }

  ignoreMutation(): boolean {
    return true
  }
}

/**
 * Factory — accepts an onRepaginate callback so the NodeView can trigger
 * layout recalculation after resize.
 */
export function createImageNodeViewFactory(
  getImageBounds: () => { maxWidth: number; maxHeight: number },
  onRepaginate: () => void,
) {
  return (
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
  ): NodeView => new ImageNodeView(node, view, getPos, getImageBounds, onRepaginate)
}

/**
 * Backwards-compatible default factory (no repaginate callback).
 */
export function imageNodeView(
  node: PMNode,
  view: EditorView,
  getPos: () => number | undefined,
): NodeView {
  return new ImageNodeView(
    node,
    view,
    getPos,
    () => ({ maxWidth: 794 - 113 - 113, maxHeight: 1123 - 96 - 96 }),
    () => { /* no-op */ },
  )
}
