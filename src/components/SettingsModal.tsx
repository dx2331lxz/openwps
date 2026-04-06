import { useState, useEffect } from 'react'

interface SettingsData {
  endpoint: string
  model: string
  hasApiKey: boolean
}

interface FormState {
  endpoint: string
  apiKey: string
  model: string
}

interface Props {
  onClose: () => void
}

const PRESETS = [
  { label: '硅基流动', endpoint: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-72B-Instruct' },
  { label: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { label: 'Claude', endpoint: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514' },
  { label: 'Ollama', endpoint: 'http://localhost:11434/v1', model: 'llama3' },
]

export default function SettingsModal({ onClose }: Props) {
  const [current, setCurrent] = useState<SettingsData | null>(null)
  const [form, setForm] = useState<FormState>({ endpoint: '', apiKey: '', model: '' })
  const [saving, setSaving] = useState(false)
  const [savedOk, setSavedOk] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/ai/settings')
      .then(r => r.json())
      .then((d: SettingsData) => {
        setCurrent(d)
        setForm({ endpoint: d.endpoint, apiKey: '', model: d.model })
      })
      .catch(() => setError('无法连接到后端，请确认服务已启动（端口 5174）'))
  }, [])

  function applyPreset(p: { endpoint: string; model: string }) {
    setForm(f => ({ ...f, endpoint: p.endpoint, model: p.model }))
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const body: Partial<FormState> = { endpoint: form.endpoint, model: form.model }
      if (form.apiKey) body.apiKey = form.apiKey
      const res = await fetch('/api/ai/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const updated = await res.json() as SettingsData
      setCurrent(updated)
      setSavedOk(true)
      setTimeout(() => { setSavedOk(false); onClose() }, 900)
    } catch (e) {
      setError(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-[440px] max-w-[96vw] mx-4"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100">
          <h2 className="font-semibold text-gray-800 text-base">⚙️ 设置</h2>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 text-xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Section title */}
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-gray-700">🤖 AI 配置</p>
            {current && (
              <span className={`text-xs px-2 py-0.5 rounded-full ${current.hasApiKey ? 'bg-green-50 text-green-700' : 'bg-yellow-50 text-yellow-700'}`}>
                {current.hasApiKey ? '✅ API Key 已配置' : '⚠️ 未配置 API Key'}
              </span>
            )}
          </div>

          {error && (
            <div className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</div>
          )}

          {/* Endpoint */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">端点 URL</label>
            <input
              type="text"
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
              value={form.endpoint}
              onChange={e => setForm(f => ({ ...f, endpoint: e.target.value }))}
              placeholder="https://api.openai.com/v1"
            />
          </div>

          {/* API Key */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">
              API Key
              {current?.hasApiKey && <span className="ml-1 text-gray-400">(留空则保持不变)</span>}
            </label>
            <input
              type="password"
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
              value={form.apiKey}
              onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))}
              placeholder={current?.hasApiKey ? '已配置，留空不修改' : '输入 API Key'}
              autoComplete="off"
            />
          </div>

          {/* Model */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">模型</label>
            <input
              type="text"
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
              value={form.model}
              onChange={e => setForm(f => ({ ...f, model: e.target.value }))}
              placeholder="gpt-4o"
            />
          </div>

          {/* Presets */}
          <div>
            <p className="text-xs font-medium text-gray-500 mb-2">预设端点</p>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map(p => (
                <button
                  key={p.label}
                  onClick={() => applyPreset(p)}
                  className="px-3 py-1 text-xs border border-gray-300 rounded-full hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3.5 border-t border-gray-100">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-5 py-1.5 text-sm bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 text-white rounded-lg transition-colors"
          >
            {savedOk ? '✅ 已保存' : saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
