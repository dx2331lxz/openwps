import { useEffect, useMemo } from 'react'
import { paginate } from '../layout/paginator'
import { DEFAULT_PAGE_CONFIG, schema } from '../shared/document/schema'
import type { PageConfig } from '../shared/document/schema'
import { PretextPageRenderer } from './PretextPageRenderer'

const PAGE_GAP = 32
const PAYLOAD_STORAGE_KEY = 'openwps.headless.payload'

interface HeadlessPayload {
  docJson?: unknown
  pageConfig?: Partial<PageConfig>
}

declare global {
  interface Window {
    __OPENWPS_HEADLESS_PAYLOAD__?: HeadlessPayload
    __OPENWPS_HEADLESS_READY__?: {
      pageCount: number
      pageWidth: number
      pageHeight: number
      pageGap: number
      blockIndexesByPage: number[][]
    }
    __OPENWPS_HEADLESS_ERROR__?: string
  }
}

function readPayload(): HeadlessPayload {
  if (window.__OPENWPS_HEADLESS_PAYLOAD__) return window.__OPENWPS_HEADLESS_PAYLOAD__
  try {
    const raw = window.sessionStorage.getItem(PAYLOAD_STORAGE_KEY)
    return raw ? JSON.parse(raw) as HeadlessPayload : {}
  } catch {
    return {}
  }
}

function normalizePageConfig(value: Partial<PageConfig> | undefined): PageConfig {
  return {
    pageWidth: typeof value?.pageWidth === 'number' ? value.pageWidth : DEFAULT_PAGE_CONFIG.pageWidth,
    pageHeight: typeof value?.pageHeight === 'number' ? value.pageHeight : DEFAULT_PAGE_CONFIG.pageHeight,
    marginTop: typeof value?.marginTop === 'number' ? value.marginTop : DEFAULT_PAGE_CONFIG.marginTop,
    marginBottom: typeof value?.marginBottom === 'number' ? value.marginBottom : DEFAULT_PAGE_CONFIG.marginBottom,
    marginLeft: typeof value?.marginLeft === 'number' ? value.marginLeft : DEFAULT_PAGE_CONFIG.marginLeft,
    marginRight: typeof value?.marginRight === 'number' ? value.marginRight : DEFAULT_PAGE_CONFIG.marginRight,
  }
}

export function HeadlessDocumentRenderer() {
  const payload = useMemo(() => readPayload(), [])
  const pageConfig = useMemo(() => normalizePageConfig(payload.pageConfig), [payload.pageConfig])
  const result = useMemo(() => {
    try {
      const doc = schema.nodeFromJSON(payload.docJson)
      return { layout: paginate(doc, pageConfig), error: null as string | null }
    } catch (error) {
      return {
        layout: null,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }, [pageConfig, payload.docJson])

  useEffect(() => {
    document.documentElement.style.margin = '0'
    document.documentElement.style.background = '#ffffff'
    document.body.style.margin = '0'
    document.body.style.background = '#ffffff'
    if (result.error || !result.layout) {
      window.__OPENWPS_HEADLESS_ERROR__ = result.error || 'headless renderer failed'
      return
    }
    window.__OPENWPS_HEADLESS_READY__ = {
      pageCount: result.layout.renderedPages.length,
      pageWidth: pageConfig.pageWidth,
      pageHeight: pageConfig.pageHeight,
      pageGap: PAGE_GAP,
      blockIndexesByPage: result.layout.renderedPages.map((page) => (
        Array.from(new Set(page.lines.map(line => line.blockIndex)))
      )),
    }
  }, [pageConfig.pageHeight, pageConfig.pageWidth, result.error, result.layout])

  if (result.error || !result.layout) {
    return (
      <div style={{ padding: 24, color: '#b91c1c', fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>
        {result.error || 'headless renderer failed'}
      </div>
    )
  }

  const canvasHeight = result.layout.renderedPages.length * pageConfig.pageHeight
    + Math.max(0, result.layout.renderedPages.length - 1) * PAGE_GAP

  return (
    <main
      id="openwps-headless-renderer"
      data-openwps-headless-ready="true"
      style={{
        position: 'relative',
        width: pageConfig.pageWidth,
        height: canvasHeight,
        overflow: 'hidden',
        background: '#ffffff',
      }}
    >
      {result.layout.renderedPages.map((_, index) => (
        <div
          key={`page-bg-${index}`}
          style={{
            position: 'absolute',
            top: index * (pageConfig.pageHeight + PAGE_GAP),
            left: 0,
            width: pageConfig.pageWidth,
            height: pageConfig.pageHeight,
            background: '#ffffff',
          }}
        />
      ))}
      <PretextPageRenderer
        pages={result.layout.renderedPages}
        pageConfig={pageConfig}
        pageGap={PAGE_GAP}
        caretPos={null}
        selectionFrom={null}
        selectionTo={null}
        selectedNodePos={null}
      />
    </main>
  )
}
