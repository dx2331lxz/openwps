import { useState, useEffect } from 'react'

interface Settings {
  endpoint: string
  apiKey: string
  model: string
}

interface Props {
  onClose: () => void
}

const PRESETS = [
  { label: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { label: 'Claude', endpoint: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514' },
  { label: 'Ollama 本地', endpoint: 'http://localhost:11434/v1', model: 'llama3' },
]

export default function SettingsModal({ onClose }: Props) {
  const [settings, setSettings] = useState<Settings>({ endpoint: '', apiKey: '', model: '' })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch('/api/ai/settings')
      .then(r => r.json())
      .then((d: { endpoint: string; model: string; hasApiKey: boolean }) => {
        setSettings({ endpoint: d.endpoint, apiKey: '', model: d.model })
      })
      .catch(() => {})
  }, [])

  function applyPreset(preset: { endpoint: string; model: string }) {
    setSettings(s => ({ ...s, endpoint: preset.endpoint, model: preset.model }))
  }

  async function handleSave() {
    setSaving(true)
    try {
      await fetch('/api/ai/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      setSaved(true)
      setTimeout(() => {
        setSaved(false)
        onClose()
      }, 800)
    } catch {
      alert('保存失败，请检查后端服务是否启动')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-white rounded-lg shadow-xl w-[420px] max-w-full mx-4" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <h2 className="font-semibold text-gray-800">⚙️ 设置</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="px-4 py-4 space-y-4">
          <p className="text-sm font-medium text-gray-600 pb-1 border-b border-gray-100">🤖 AI 配置</p>

          {/* Endpoint */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">端点 URL</label>
            <input
              type="text"
              className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
              value={settings.endpoint}
              onChange={e => setSettings(s => ({ ...s, endpoint: e.target.value }))}
              placeholder="https://api.openai.com/v1"
            />
          </div>

          {/* API Key */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">API Key</label>
            <input
              type="password"
              className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
              value={settings.apiKey}
              onChange={e => setSettings(s => ({ ...s, apiKey: e.target.value }))}
              placeholder="留空则保持不变"
            />
          </div>

          {/* Model */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">模型</label>
            <input
              type="text"
              className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
              value={settings.model}
              onChange={e => setSettings(s => ({ ...s, model: e.target.value }))}
              placeholder="gpt-4o"
            />
          </div>

          {/* Presets */}
          <div>
            <p className="text-xs text-gray-500 mb-2">预设端点：</p>
            <div className="flex gap-2 flex-wrap">
              {PRESETS.map(p => (
                <button
                  key={p.label}
                  onClick={() => applyPreset(p)}
                  className="px-2 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50 hover:border-blue-400 hover:text-blue-600 transition-colors"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-gray-100">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50">取消</button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 text-sm bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 text-white rounded"
          >
            {saved ? '✅ 已保存' : saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
