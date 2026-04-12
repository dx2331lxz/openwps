import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

declare global {
  interface Window {
    __OPENWPS_RELOAD_ON_ASSET_ERROR__?: () => void
  }
}

const ASSET_RETRY_KEY = 'openwps:boot-retry'
const ASSET_ERROR_PATTERNS = [
  'chunkloaderror',
  'loading chunk',
  'failed to fetch dynamically imported module',
  'error loading dynamically imported module',
  'importing a module script failed',
  'unable to preload css',
]

function clearAssetRetryFlag() {
  try {
    sessionStorage.removeItem(ASSET_RETRY_KEY)
  } catch {
    // ignore storage failures
  }
}

function isAssetLoadError(error: unknown) {
  const message = String(
    (error as { message?: unknown })?.message
      ?? (error as { reason?: { message?: unknown } })?.reason?.message
      ?? error
      ?? '',
  ).toLowerCase()

  return ASSET_ERROR_PATTERNS.some(pattern => message.includes(pattern))
}

function triggerAssetRecovery(reason: string, error: unknown) {
  if (!isAssetLoadError(error)) return
  console.error(`[asset-recovery] ${reason}`, error)
  window.__OPENWPS_RELOAD_ON_ASSET_ERROR__?.()
}

window.addEventListener('vite:preloadError', event => {
  event.preventDefault()
  const preloadEvent = event as Event & { payload?: unknown }
  triggerAssetRecovery('vite preload error', preloadEvent.payload ?? event)
})

window.addEventListener('error', event => {
  const target = event.target
  if (
    target instanceof HTMLScriptElement ||
    target instanceof HTMLLinkElement
  ) {
    triggerAssetRecovery('resource load error', `${target.tagName} ${target.getAttribute('src') ?? target.getAttribute('href') ?? ''}`)
    return
  }
  triggerAssetRecovery('window error', event.error ?? event.message)
}, true)

window.addEventListener('unhandledrejection', event => {
  triggerAssetRecovery('unhandled rejection', event.reason)
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

clearAssetRetryFlag()
