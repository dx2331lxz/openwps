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

  constructor(
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
    onRepaginate: () => void,
  ) {
    this.node = node
    this.view = view
    this.getPos = getPos
    this.onRepaginate = onRepaginate

    // ── outer wrapper ─────────────────────────────────────────────────────────
    const wrapper = document.createElement('span')
    wrapper.contentEditable = 'false'
    wrapper.setAttribute('data-pm-image-wrapper', 'true')
    wrapper.style.cssText = [
      'display:inline-block',
      'position:relative',
      'vertical-align:bottom',
      'max-width:100%',
      'line-height:0',
      'cursor:text',
      'user-select:none',
      'border:2px solid transparent',
      'border-radius:2px',
      'box-sizing:border-box',
      'transition:border-color 0.15s',
    ].join(';')

    // ── img element ───────────────────────────────────────────────────────────
    const img = document.createElement('img')
    img.src = node.attrs.src
    img.alt = node.attrs.alt ?? ''
    img.title = node.attrs.title ?? ''
    img.draggable = false
    img.style.cssText = 'display:block;max-width:100%;'

    if (node.attrs.width) {
      img.style.width = `${node.attrs.width}px`
      if (node.attrs.height) img.style.height = `${node.attrs.height}px`
    } else {
      // Auto-fit on first load
      img.onload = () => {
        let containerWidth = 0
        let el: HTMLElement | null = wrapper.parentElement
        while (el) {
          if (el.offsetWidth > 10) { containerWidth = el.offsetWidth; break }
          el = el.parentElement
        }
        const fitted = containerWidth > 10
          ? Math.min(img.naturalWidth, containerWidth - 8)
          : img.naturalWidth
        img.style.width = `${fitted}px`
        img.style.height = 'auto'
        this._updateAttrs(Math.round(fitted), null)
      }
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
      // Left half → cursor before image, right half → cursor after image
      const clickedRightHalf = e.clientX >= rect.left + rect.width / 2
      const targetPos = clickedRightHalf ? pos + 1 : pos

      try {
        const sel = TextSelection.create(state.doc, targetPos)
        dispatch(state.tr.setSelection(sel))
      } catch {
        // fallback: put cursor after
        try {
          const sel = TextSelection.create(state.doc, pos + 1)
          dispatch(state.tr.setSelection(sel))
        } catch { /* ignore */ }
      }
      this.view.focus()
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

      const onMouseMove = (me: MouseEvent) => {
        const dx = me.clientX - startX
        const newWidth = Math.max(minWidth, startWidth + dx)
        img.style.width = `${newWidth}px`
        img.style.height = `${Math.round(newWidth * aspectRatio)}px`
      }

      const onMouseUp = (ue: MouseEvent) => {
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)

        const dx = ue.clientX - startX
        const finalWidth = Math.max(minWidth, startWidth + dx)
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
    this.img = img
  }

  private _updateAttrs(width: number, height: number | null) {
    const pos = this.getPos()
    if (pos === undefined) return
    const { state, dispatch } = this.view
    const tr = state.tr.setNodeMarkup(pos, undefined, {
      ...this.node.attrs,
      width,
      height,
    })
    tr.setMeta('addToHistory', false)
    dispatch(tr)
  }

  update(node: PMNode): boolean {
    if (node.type !== schema.nodes.image) return false
    this.node = node
    this.img.src = node.attrs.src
    this.img.alt = node.attrs.alt ?? ''
    if (node.attrs.width) {
      this.img.style.width = `${node.attrs.width}px`
      if (node.attrs.height) this.img.style.height = `${node.attrs.height}px`
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
export function createImageNodeViewFactory(onRepaginate: () => void) {
  return (
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
  ): NodeView => new ImageNodeView(node, view, getPos, onRepaginate)
}

/**
 * Backwards-compatible default factory (no repaginate callback).
 */
export function imageNodeView(
  node: PMNode,
  view: EditorView,
  getPos: () => number | undefined,
): NodeView {
  return new ImageNodeView(node, view, getPos, () => { /* no-op */ })
}
