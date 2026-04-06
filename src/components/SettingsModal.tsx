import { useState, useEffect } from 'react'
import type { PageConfig } from '../layout/paginator'

// ── Page-settings helpers ──────────────────────────────────────────────────

const pxToMm = (px: number) => Math.round(px / 3.7795)
const mmToPx = (mm: number) => Math.round(mm * 3.7795)

const PAGE_PRESETS: Record<string, { pageWidth: number; pageHeight: number }> = {
  'A4':     { pageWidth: 794,  pageHeight: 1123 },
  'A3':     { pageWidth: 1123, pageHeight: 1587 },
  'Letter': { pageWidth: 816,  pageHeight: 1056 },
}

// ── AI-settings types ──────────────────────────────────────────────────────

interface AISettingsData {
  endpoint: string
  model: string
  hasApiKey: boolean
}

interface AIFormState {
  endpoint: string
  apiKey: string
  model: string
}

const AI_PRESETS = [
  { label: '硅基流动', endpoint: 'https://api.siliconflow.cn/v1',  model: 'Qwen/Qwen2.5-72B-Instruct' },
  { label: 'OpenAI',   endpoint: 'https://api.openai.com/v1',       model: 'gpt-4o' },
  { label: 'Claude',   endpoint: 'https://api.anthropic.com',        model: 'claude-sonnet-4-20250514' },
  { label: 'Ollama',   endpoint: 'http://localhost:11434/v1',        model: 'llama3' },
]

// ── Props ──────────────────────────────────────────────────────────────────

interface Props {
  pageConfig: PageConfig
  onPageConfigChange: (cfg: PageConfig) => void
  onClose: () => void
  defaultTab?: 0 | 1
}

// ── Component ──────────────────────────────────────────────────────────────

export default function SettingsModal({ pageConfig, onPageConfigChange, onClose, defaultTab = 0 }: Props) {
  const [tab, setTab] = useState<0 | 1>(defaultTab)

  // ── Page settings state ──────────────────────────────────────────────────
  const [draft, setDraft] = useState({ ...pageConfig })

  // ── AI settings state ────────────────────────────────────────────────────
  const [aiCurrent, setAiCurrent] = useState<AISettingsData | null>(null)
  const [aiForm, setAiForm] = useState<AIFormState>({ endpoint: '', apiKey: '', model: '' })
  const [aiSaving, setAiSaving] = useState(false)
  const [aiSavedOk, setAiSavedOk] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/ai/settings')
      .then(r => r.json())
      .then((d: AISettingsData) => {
        setAiCurrent(d)
        setAiForm({ endpoint: d.endpoint, apiKey: '', model: d.model })
      })
      .catch(() => setAiError('无法连接到后端，请确认服务已启动（端口 5174）'))
  }, [])

  // ── Handlers ─────────────────────────────────────────────────────────────

  function handlePageSave() {
    onPageConfigChange(draft)
    onClose()
  }

  async function handleAISave() {
    setAiSaving(true)
    setAiError(null)
    try {
      const body: Partial<AIFormState> = { endpoint: aiForm.endpoint, model: aiForm.model }
      if (aiForm.apiKey) body.apiKey = aiForm.apiKey
      const res = await fetch('/api/ai/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const updated = await res.json() as AISettingsData
      setAiCurrent(updated)
      setAiSavedOk(true)
      setTimeout(() => { setAiSavedOk(false); onClose() }, 900)
    } catch (e) {
      setAiError(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setAiSaving(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const TAB_LABELS = ['📄 页面设置', '🤖 AI 配置']

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-[440px] max-w-[96vw] mx-4 flex flex-col"
        style={{ maxHeight: '90vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 flex-shrink-0">
          <h2 className="font-semibold text-gray-800 text-base">⚙️ 设置</h2>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 text-xl leading-none"
          >×</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-100 flex-shrink-0">
          {TAB_LABELS.map((label, i) => (
            <button
              key={i}
              onClick={() => setTab(i as 0 | 1)}
              className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                tab === i
                  ? 'text-blue-600 border-b-2 border-blue-500 bg-blue-50/50'
                  : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              }`}
            >{label}</button>
          ))}
        </div>

        {/* Tab content */}
        <div className="overflow-y-auto flex-1">

          {tab === 0 && (
            /* ── Page settings tab ──────────────────────────────────────── */
            <div className="px-5 py-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">纸张大小</label>
                <select
                  className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
                  value={Object.keys(PAGE_PRESETS).find(k => PAGE_PRESETS[k].pageWidth === draft.pageWidth) ?? 'custom'}
                  onChange={e => { const p = PAGE_PRESETS[e.target.value]; if (p) setDraft(d => ({ ...d, ...p })) }}
                >
                  {Object.keys(PAGE_PRESETS).map(k => <option key={k} value={k}>{k}</option>)}
                  <option value="custom">自定义</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">纸张方向</label>
                <div className="flex gap-2">
                  <button
                    className={`flex-1 py-2 text-sm border rounded-lg transition-colors ${draft.pageWidth < draft.pageHeight ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-gray-300 hover:bg-gray-50'}`}
                    onClick={() => setDraft(d => ({ ...d, pageWidth: Math.min(d.pageWidth, d.pageHeight), pageHeight: Math.max(d.pageWidth, d.pageHeight) }))}
                  >纵向</button>
                  <button
                    className={`flex-1 py-2 text-sm border rounded-lg transition-colors ${draft.pageWidth > draft.pageHeight ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-gray-300 hover:bg-gray-50'}`}
                    onClick={() => setDraft(d => ({ ...d, pageWidth: Math.max(d.pageWidth, d.pageHeight), pageHeight: Math.min(d.pageWidth, d.pageHeight) }))}
                  >横向</button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-2">页边距（mm）</label>
                <div className="grid grid-cols-2 gap-3">
                  {(['marginTop', 'marginBottom', 'marginLeft', 'marginRight'] as const).map(k => (
                    <label key={k} className="flex flex-col gap-1">
                      <span className="text-xs text-gray-500">{k === 'marginTop' ? '上' : k === 'marginBottom' ? '下' : k === 'marginLeft' ? '左' : '右'}</span>
                      <input
                        type="number" min={0} max={200}
                        value={pxToMm(draft[k])}
                        onChange={e => setDraft(d => ({ ...d, [k]: mmToPx(Number(e.target.value)) }))}
                        className="text-sm border border-gray-300 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400 w-full"
                      />
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === 1 && (
            /* ── AI config tab ──────────────────────────────────────────── */
            <div className="px-5 py-4 space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-gray-700">AI 服务配置</p>
                {aiCurrent && (
                  <span className={`text-xs px-2 py-0.5 rounded-full ${aiCurrent.hasApiKey ? 'bg-green-50 text-green-700' : 'bg-yellow-50 text-yellow-700'}`}>
                    {aiCurrent.hasApiKey ? '✅ API Key 已配置' : '⚠️ 未配置 API Key'}
                  </span>
                )}
              </div>

              {aiError && (
                <div className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{aiError}</div>
              )}

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">端点 URL</label>
                <input
                  type="text"
                  className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
                  value={aiForm.endpoint}
                  onChange={e => setAiForm(f => ({ ...f, endpoint: e.target.value }))}
                  placeholder="https://api.openai.com/v1"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  API Key
                  {aiCurrent?.hasApiKey && <span className="ml-1 font-normal text-gray-400">（留空则保持不变）</span>}
                </label>
                <input
                  type="password"
                  className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
                  value={aiForm.apiKey}
                  onChange={e => setAiForm(f => ({ ...f, apiKey: e.target.value }))}
                  placeholder={aiCurrent?.hasApiKey ? '已配置，留空不修改' : '输入 API Key'}
                  autoComplete="off"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">模型</label>
                <input
                  type="text"
                  className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
                  value={aiForm.model}
                  onChange={e => setAiForm(f => ({ ...f, model: e.target.value }))}
                  placeholder="gpt-4o"
                />
              </div>

              <div>
                <p className="text-xs font-medium text-gray-500 mb-2">预设端点</p>
                <div className="flex flex-wrap gap-2">
                  {AI_PRESETS.map(p => (
                    <button
                      key={p.label}
                      onClick={() => setAiForm(f => ({ ...f, endpoint: p.endpoint, model: p.model }))}
                      className="px-3 py-1 text-xs border border-gray-300 rounded-full hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                    >{p.label}</button>
                  ))}
                </div>
              </div>
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3.5 border-t border-gray-100 flex-shrink-0">
          <button onClick={onClose} className="px-4 py-1.5 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50">
            取消
          </button>
          {tab === 0 ? (
            <button onClick={handlePageSave} className="px-5 py-1.5 text-sm bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors">
              确认
            </button>
          ) : (
            <button
              onClick={handleAISave}
              disabled={aiSaving}
              className="px-5 py-1.5 text-sm bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 text-white rounded-lg transition-colors"
            >
              {aiSavedOk ? '✅ 已保存' : aiSaving ? '保存中…' : '保存'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
