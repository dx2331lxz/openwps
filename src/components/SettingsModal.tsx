import { useEffect, useMemo, useState } from 'react'
import type { PageConfig } from '../layout/paginator'
import { CUSTOM_PROVIDER_TEMPLATE, type AISettingsData, type AIProviderSettings, type ModelOption } from '../ai/providers'

const pxToMm = (px: number) => Math.round(px / 3.7795)
const mmToPx = (mm: number) => Math.round(mm * 3.7795)

const PAGE_PRESETS: Record<string, { pageWidth: number; pageHeight: number }> = {
  A4: { pageWidth: 794, pageHeight: 1123 },
  A3: { pageWidth: 1123, pageHeight: 1587 },
  Letter: { pageWidth: 816, pageHeight: 1056 },
}

interface EditableProvider extends AIProviderSettings {
  apiKey: string
  apiKeyChanged: boolean
  models: ModelOption[]
  modelsLoading: boolean
  modelsError: string | null
}

interface Props {
  pageConfig: PageConfig
  onPageConfigChange: (cfg: PageConfig) => void
  onClose: () => void
  defaultTab?: 0 | 1
}

function slugify(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || `custom-${Date.now().toString(36)}`
}

function toEditableProvider(provider: AIProviderSettings): EditableProvider {
  return {
    ...provider,
    apiKey: '',
    apiKeyChanged: false,
    models: provider.defaultModel ? [{ id: provider.defaultModel, label: provider.defaultModel }] : [],
    modelsLoading: false,
    modelsError: null,
  }
}

export default function SettingsModal({ pageConfig, onPageConfigChange, onClose, defaultTab = 0 }: Props) {
  const [tab, setTab] = useState<0 | 1>(defaultTab)
  const [draft, setDraft] = useState({ ...pageConfig })

  const [providers, setProviders] = useState<EditableProvider[]>([])
  const [selectedProviderId, setSelectedProviderId] = useState('')
  const [activeProviderId, setActiveProviderId] = useState('')
  const [aiSaving, setAiSaving] = useState(false)
  const [aiSavedOk, setAiSavedOk] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/ai/settings')
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<AISettingsData>
      })
      .then(data => {
        setProviders(data.providers.map(toEditableProvider))
        setSelectedProviderId(data.activeProviderId)
        setActiveProviderId(data.activeProviderId)
      })
      .catch(() => setAiError('无法连接到后端，请确认服务已启动（端口 5174）'))
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const selectedProvider = useMemo(
    () => providers.find(provider => provider.id === selectedProviderId) ?? null,
    [providers, selectedProviderId],
  )

  function handlePageSave() {
    onPageConfigChange(draft)
    onClose()
  }

  function updateProvider(providerId: string, updater: (provider: EditableProvider) => EditableProvider) {
    setProviders(prev => prev.map(provider => (provider.id === providerId ? updater(provider) : provider)))
  }

  async function handleFetchModels(provider: EditableProvider) {
    updateProvider(provider.id, current => ({ ...current, modelsLoading: true, modelsError: null }))
    setAiError(null)

    try {
      const payload: Record<string, unknown> = {
        providerId: provider.id,
        endpoint: provider.endpoint,
      }
      if (provider.apiKeyChanged) payload.apiKey = provider.apiKey
      const response = await fetch('/api/ai/models/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await response.json() as { models?: ModelOption[]; detail?: string }
      if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`)
      const models = Array.isArray(data.models) ? data.models : []
      updateProvider(provider.id, current => ({
        ...current,
        models,
        modelsLoading: false,
        modelsError: models.length === 0 ? '该端点没有返回可用模型' : null,
        defaultModel: current.defaultModel || models[0]?.id || '',
      }))
    } catch (error) {
      updateProvider(provider.id, current => ({
        ...current,
        modelsLoading: false,
        modelsError: error instanceof Error ? error.message : String(error),
      }))
    }
  }

  function handleAddCustomProvider() {
    const id = `custom-${Date.now().toString(36)}`
    const nextProvider: EditableProvider = {
      id,
      label: CUSTOM_PROVIDER_TEMPLATE.label,
      endpoint: CUSTOM_PROVIDER_TEMPLATE.endpoint,
      defaultModel: CUSTOM_PROVIDER_TEMPLATE.defaultModel,
      hasApiKey: false,
      isPreset: false,
      apiKey: '',
      apiKeyChanged: true,
      models: [],
      modelsLoading: false,
      modelsError: null,
    }
    setProviders(prev => [...prev, nextProvider])
    setSelectedProviderId(id)
  }

  function handleRemoveProvider(providerId: string) {
    const remaining = providers.filter(provider => provider.id !== providerId)
    const fallbackId = remaining[0]?.id || ''
    setProviders(remaining)
    setSelectedProviderId(prev => (prev === providerId ? fallbackId : prev))
    setActiveProviderId(prev => (prev === providerId ? fallbackId : prev))
  }

  async function handleAISave() {
    if (providers.length === 0) {
      setAiError('请至少保留一个服务商配置')
      return
    }

    const normalizedProviders = providers.map(provider => ({
      id: provider.isPreset ? provider.id : slugify(provider.id || provider.label),
      label: provider.label.trim() || '自定义服务商',
      endpoint: provider.endpoint.trim(),
      defaultModel: provider.defaultModel.trim(),
      isPreset: provider.isPreset,
      ...(provider.apiKeyChanged ? { apiKey: provider.apiKey.trim() } : {}),
    }))

    if (!normalizedProviders.some(provider => provider.id === activeProviderId)) {
      setAiError('请选择一个默认服务商')
      return
    }

    const invalidProvider = normalizedProviders.find(provider => !provider.endpoint)
    if (invalidProvider) {
      setAiError(`请填写服务商“${invalidProvider.label}”的端点地址`)
      return
    }

    setAiSaving(true)
    setAiError(null)
    try {
      const response = await fetch('/api/ai/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activeProviderId,
          providers: normalizedProviders,
        }),
      })
      const updated = await response.json() as AISettingsData & { detail?: string }
      if (!response.ok) throw new Error(updated.detail || `HTTP ${response.status}`)

      setProviders(updated.providers.map(toEditableProvider))
      setSelectedProviderId(updated.activeProviderId)
      setActiveProviderId(updated.activeProviderId)
      setAiSavedOk(true)
      setTimeout(() => {
        setAiSavedOk(false)
        onClose()
      }, 900)
    } catch (error) {
      setAiError(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setAiSaving(false)
    }
  }

  const TAB_LABELS = ['📄 页面设置', '🤖 AI 配置']

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-[860px] max-w-[96vw] mx-4 flex flex-col"
        style={{ maxHeight: '90vh' }}
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 flex-shrink-0">
          <h2 className="font-semibold text-gray-800 text-base">⚙️ 设置</h2>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 text-xl leading-none"
          >×</button>
        </div>

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

        <div className="overflow-y-auto flex-1">
          {tab === 0 && (
            <div className="px-5 py-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">纸张大小</label>
                <select
                  className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
                  value={Object.keys(PAGE_PRESETS).find(k => PAGE_PRESETS[k].pageWidth === draft.pageWidth) ?? 'custom'}
                  onChange={e => {
                    const p = PAGE_PRESETS[e.target.value]
                    if (p) setDraft(d => ({ ...d, ...p }))
                  }}
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
                        type="number"
                        min={0}
                        max={200}
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
            <div className="px-5 py-4 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-gray-700">AI 服务配置</p>
                  <p className="text-xs text-gray-400 mt-1">可保存多个端点，为每个服务商配置默认模型，并指定当前默认使用的服务商。</p>
                </div>
                <button
                  type="button"
                  onClick={handleAddCustomProvider}
                  className="px-3 py-2 text-xs font-medium border border-blue-200 rounded-lg text-blue-600 bg-blue-50 hover:bg-blue-100 transition-colors"
                >
                  + 新增自定义服务商
                </button>
              </div>

              {aiError && (
                <div className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{aiError}</div>
              )}

              <div className="grid grid-cols-[240px_minmax(0,1fr)] gap-4 min-h-[420px]">
                <div className="border border-gray-200 rounded-2xl p-3 bg-gray-50 space-y-2 overflow-y-auto">
                  {providers.map(provider => (
                    <button
                      key={provider.id}
                      type="button"
                      onClick={() => setSelectedProviderId(provider.id)}
                      className={`w-full rounded-xl border px-3 py-2.5 text-left transition-colors ${
                        selectedProviderId === provider.id
                          ? 'border-blue-300 bg-white shadow-sm'
                          : 'border-transparent hover:border-gray-200 hover:bg-white'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-gray-800 truncate">{provider.label}</span>
                        {activeProviderId === provider.id && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">默认</span>
                        )}
                      </div>
                      <div className="mt-1 text-[11px] text-gray-400 truncate">{provider.endpoint || '未填写端点'}</div>
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-gray-500">
                        <span>{provider.defaultModel || '未设模型'}</span>
                        <span className={(provider.apiKeyChanged ? Boolean(provider.apiKey) : provider.hasApiKey) ? 'text-green-600' : 'text-yellow-600'}>
                          {(provider.apiKeyChanged ? Boolean(provider.apiKey) : provider.hasApiKey) ? 'Key 已配置' : '无 Key'}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>

                <div className="border border-gray-200 rounded-2xl p-4 bg-white">
                  {selectedProvider ? (
                    <div className="space-y-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-gray-800">{selectedProvider.label}</div>
                          <div className="text-xs text-gray-400 mt-1">
                            {selectedProvider.isPreset ? '预设服务商，可直接补充 Key、端点和默认模型。' : '自定义服务商，可自由填写名称和端点。'}
                          </div>
                        </div>
                        {!selectedProvider.isPreset && (
                          <button
                            type="button"
                            onClick={() => handleRemoveProvider(selectedProvider.id)}
                            className="px-2.5 py-1.5 text-xs rounded-lg border border-red-200 text-red-500 hover:bg-red-50"
                          >
                            删除
                          </button>
                        )}
                      </div>

                      <label className="flex items-center gap-2 rounded-xl border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-700">
                        <input
                          type="radio"
                          checked={activeProviderId === selectedProvider.id}
                          onChange={() => setActiveProviderId(selectedProvider.id)}
                        />
                        <span>设为默认服务商</span>
                      </label>

                      <div className="grid grid-cols-2 gap-3">
                        <label className="block">
                          <span className="block text-xs font-medium text-gray-500 mb-1">服务商名称</span>
                          <input
                            type="text"
                            className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
                            value={selectedProvider.label}
                            onChange={event => updateProvider(selectedProvider.id, current => ({ ...current, label: event.target.value }))}
                            disabled={selectedProvider.isPreset}
                            placeholder="例如：自定义网关"
                          />
                        </label>

                        <label className="block">
                          <span className="block text-xs font-medium text-gray-500 mb-1">默认模型</span>
                          <input
                            list={`models-${selectedProvider.id}`}
                            type="text"
                            className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
                            value={selectedProvider.defaultModel}
                            onChange={event => updateProvider(selectedProvider.id, current => ({ ...current, defaultModel: event.target.value }))}
                            placeholder="例如：gpt-4o"
                          />
                          <datalist id={`models-${selectedProvider.id}`}>
                            {selectedProvider.models.map(model => (
                              <option key={model.id} value={model.id}>{model.label}</option>
                            ))}
                          </datalist>
                        </label>
                      </div>

                      <label className="block">
                        <span className="block text-xs font-medium text-gray-500 mb-1">端点 URL</span>
                        <input
                          type="text"
                          className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
                          value={selectedProvider.endpoint}
                          onChange={event => updateProvider(selectedProvider.id, current => ({ ...current, endpoint: event.target.value }))}
                          placeholder="https://api.openai.com/v1"
                        />
                      </label>

                      <label className="block">
                        <span className="block text-xs font-medium text-gray-500 mb-1">
                          API Key
                          {(selectedProvider.hasApiKey && !selectedProvider.apiKeyChanged) && (
                            <span className="ml-1 font-normal text-gray-400">（留空则保持不变）</span>
                          )}
                        </span>
                        <input
                          type="password"
                          className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
                          value={selectedProvider.apiKey}
                          onChange={event => updateProvider(selectedProvider.id, current => ({
                            ...current,
                            apiKey: event.target.value,
                            apiKeyChanged: true,
                          }))}
                          placeholder={selectedProvider.hasApiKey && !selectedProvider.apiKeyChanged ? '已配置，留空不修改' : '输入 API Key，可留空'}
                          autoComplete="off"
                        />
                      </label>

                      <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-3 space-y-3">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-xs font-medium text-gray-600">模型发现</div>
                            <div className="text-[11px] text-gray-400 mt-1">从 `端点 + /models` 拉取模型列表，帮助你选择默认模型。</div>
                          </div>
                          <button
                            type="button"
                            onClick={() => void handleFetchModels(selectedProvider)}
                            disabled={!selectedProvider.endpoint || selectedProvider.modelsLoading}
                            className="px-3 py-1.5 text-xs rounded-lg border border-gray-300 bg-white hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {selectedProvider.modelsLoading ? '查询中...' : '查询模型'}
                          </button>
                        </div>

                        {selectedProvider.modelsError && (
                          <div className="text-xs text-red-600">{selectedProvider.modelsError}</div>
                        )}

                        {selectedProvider.models.length > 0 && (
                          <div className="max-h-44 overflow-y-auto rounded-lg border border-gray-200 bg-white">
                            {selectedProvider.models.map(model => (
                              <button
                                key={model.id}
                                type="button"
                                onClick={() => updateProvider(selectedProvider.id, current => ({ ...current, defaultModel: model.id }))}
                                className={`w-full px-3 py-2 text-left text-xs border-b border-gray-100 last:border-b-0 transition-colors ${
                                  selectedProvider.defaultModel === model.id
                                    ? 'bg-blue-50 text-blue-700'
                                    : 'text-gray-700 hover:bg-gray-50'
                                }`}
                              >
                                <div className="font-medium">{model.id}</div>
                                {model.label !== model.id && <div className="text-[11px] text-gray-400 mt-0.5">{model.label}</div>}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="h-full flex items-center justify-center text-sm text-gray-400">请选择一个服务商进行编辑</div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-100 flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50"
          >
            取消
          </button>

          {tab === 0 ? (
            <button
              onClick={handlePageSave}
              className="px-4 py-2 text-sm rounded-lg bg-blue-500 text-white hover:bg-blue-600"
            >
              保存页面设置
            </button>
          ) : (
            <button
              onClick={() => void handleAISave()}
              disabled={aiSaving}
              className={`px-4 py-2 text-sm rounded-lg text-white ${aiSaving ? 'bg-blue-300' : aiSavedOk ? 'bg-green-500' : 'bg-blue-500 hover:bg-blue-600'}`}
            >
              {aiSaving ? '保存中...' : aiSavedOk ? '已保存 ✓' : '保存 AI 配置'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
