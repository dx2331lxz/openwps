import { useEffect, useMemo, useState } from 'react'
import type { PageConfig } from '../layout/paginator'
import {
  CUSTOM_PROVIDER_TEMPLATE,
  type AISettingsData,
  type AIProviderSettings,
  type ImageProcessingMode,
  type ModelOption,
  type OcrConfigData,
} from '../ai/providers'

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

interface EditableOcrConfig extends OcrConfigData {
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

function toEditableOcrConfig(ocrConfig: OcrConfigData): EditableOcrConfig {
  return {
    ...ocrConfig,
    apiKey: '',
    apiKeyChanged: false,
    models: ocrConfig.model ? [{ id: ocrConfig.model, label: ocrConfig.model }] : [],
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
  const [imageProcessingMode, setImageProcessingMode] = useState<ImageProcessingMode>('direct_multimodal')
  const [ocrConfig, setOcrConfig] = useState<EditableOcrConfig>(toEditableOcrConfig({
    enabled: true,
    providerId: 'siliconflow',
    endpoint: 'https://api.siliconflow.cn/v1',
    model: 'PaddlePaddle/PaddleOCR-VL-1.5',
    hasApiKey: false,
    timeoutSeconds: 60,
    maxImages: 5,
  }))
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
        setImageProcessingMode(data.imageProcessingMode || 'direct_multimodal')
        setOcrConfig(toEditableOcrConfig(data.ocrConfig))
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

  const selectedOcrProvider = useMemo(
    () => providers.find(provider => provider.id === ocrConfig.providerId) ?? null,
    [providers, ocrConfig.providerId],
  )

  function handlePageSave() {
    onPageConfigChange(draft)
    onClose()
  }

  function updateProvider(providerId: string, updater: (provider: EditableProvider) => EditableProvider) {
    setProviders(prev => prev.map(provider => (provider.id === providerId ? updater(provider) : provider)))
  }

  function updateOcrConfig(updater: (config: EditableOcrConfig) => EditableOcrConfig) {
    setOcrConfig(prev => updater(prev))
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

  async function handleFetchOcrModels() {
    updateOcrConfig(current => ({ ...current, modelsLoading: true, modelsError: null }))
    setAiError(null)

    try {
      const payload: Record<string, unknown> = {
        providerId: ocrConfig.providerId,
        endpoint: ocrConfig.endpoint || selectedOcrProvider?.endpoint || '',
      }
      if (ocrConfig.apiKeyChanged) payload.apiKey = ocrConfig.apiKey
      const response = await fetch('/api/ai/models/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await response.json() as { models?: ModelOption[]; detail?: string }
      if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`)
      const models = Array.isArray(data.models) ? data.models : []
      updateOcrConfig(current => ({
        ...current,
        models,
        modelsLoading: false,
        modelsError: models.length === 0 ? '该 OCR 端点没有返回可用模型' : null,
        model: current.model || models[0]?.id || '',
      }))
    } catch (error) {
      updateOcrConfig(current => ({
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
      supportsVision: Boolean(provider.supportsVision),
      ...(provider.apiKeyChanged ? { apiKey: provider.apiKey.trim() } : {}),
    }))

    const normalizedOcrConfig: Record<string, unknown> = {
      enabled: ocrConfig.enabled,
      providerId: ocrConfig.providerId.trim() || 'siliconflow',
      endpoint: ocrConfig.endpoint.trim(),
      model: ocrConfig.model.trim(),
      timeoutSeconds: ocrConfig.timeoutSeconds,
      maxImages: ocrConfig.maxImages,
    }
    if (ocrConfig.apiKeyChanged) normalizedOcrConfig.apiKey = ocrConfig.apiKey.trim()

    if (!normalizedProviders.some(provider => provider.id === activeProviderId)) {
      setAiError('请选择一个默认服务商')
      return
    }

    const invalidProvider = normalizedProviders.find(provider => !provider.endpoint)
    if (invalidProvider) {
      setAiError(`请填写服务商“${invalidProvider.label}”的端点地址`)
      return
    }

    if (imageProcessingMode === 'ocr_text') {
      if (!String(normalizedOcrConfig.model || '').trim()) {
        setAiError('请填写 OCR 模型 ID')
        return
      }
      if (!String(normalizedOcrConfig.endpoint || '').trim() && !normalizedOcrConfig.providerId) {
        setAiError('请填写 OCR 端点，或选择一个 OCR 服务商')
        return
      }
    }

    setAiSaving(true)
    setAiError(null)
    try {
      const response = await fetch('/api/ai/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activeProviderId,
          imageProcessingMode,
          ocrConfig: normalizedOcrConfig,
          providers: normalizedProviders,
        }),
      })
      const updated = await response.json() as AISettingsData & { detail?: string }
      if (!response.ok) throw new Error(updated.detail || `HTTP ${response.status}`)

      setProviders(updated.providers.map(toEditableProvider))
      setSelectedProviderId(updated.activeProviderId)
      setActiveProviderId(updated.activeProviderId)
      setImageProcessingMode(updated.imageProcessingMode || 'direct_multimodal')
      setOcrConfig(toEditableOcrConfig(updated.ocrConfig))
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
              className={`flex-1 py-2.5 text-sm font-medium transition-colors ${tab === i
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
                      className={`w-full rounded-xl border px-3 py-2.5 text-left transition-colors ${selectedProviderId === provider.id
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
                              <option key={model.id} value={model.id}>{model.supportsVision ? `${model.label} · 多模态` : model.label}</option>
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
                                className={`w-full px-3 py-2 text-left text-xs border-b border-gray-100 last:border-b-0 transition-colors ${selectedProvider.defaultModel === model.id
                                    ? 'bg-blue-50 text-blue-700'
                                    : 'text-gray-700 hover:bg-gray-50'
                                  }`}
                              >
                                <div className="font-medium">{model.id}{model.supportsVision ? ' · 多模态' : ''}</div>
                                {model.label !== model.id && <div className="text-[11px] text-gray-400 mt-0.5">{model.label}</div>}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="rounded-xl border border-violet-200 bg-violet-50/70 px-3 py-3 space-y-3">
                        <div>
                          <div className="text-xs font-medium text-violet-700">图片处理方式</div>
                          <div className="text-[11px] text-violet-500 mt-1">全局决定图片是直接交给多模态模型，还是先经过 OCR 再交给文本模型。</div>
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          <label className={`rounded-lg border px-3 py-2 text-xs transition-colors ${imageProcessingMode === 'direct_multimodal' ? 'border-violet-300 bg-white text-violet-700' : 'border-violet-100 bg-white/70 text-gray-600'}`}>
                            <input
                              type="radio"
                              name="image-processing-mode"
                              className="mr-2"
                              checked={imageProcessingMode === 'direct_multimodal'}
                              onChange={() => setImageProcessingMode('direct_multimodal')}
                            />
                            直接多模态
                          </label>
                          <label className={`rounded-lg border px-3 py-2 text-xs transition-colors ${imageProcessingMode === 'ocr_text' ? 'border-violet-300 bg-white text-violet-700' : 'border-violet-100 bg-white/70 text-gray-600'}`}>
                            <input
                              type="radio"
                              name="image-processing-mode"
                              className="mr-2"
                              checked={imageProcessingMode === 'ocr_text'}
                              onChange={() => setImageProcessingMode('ocr_text')}
                            />
                            OCR + 文本模型
                          </label>
                        </div>

                        <div className="text-[11px] text-violet-600">
                          {imageProcessingMode === 'direct_multimodal'
                            ? '当前模式下，图片会直接发送给多模态模型。'
                            : '当前模式下，图片会先调用 OCR 模型提取内容和样式线索，再交给主文本模型继续完成写作与排版。'}
                        </div>

                        {imageProcessingMode === 'ocr_text' && (
                          <div className="space-y-3 rounded-lg border border-violet-100 bg-white px-3 py-3">
                            <label className="flex items-center gap-2 text-xs text-gray-600">
                              <input
                                type="checkbox"
                                checked={ocrConfig.enabled}
                                onChange={event => updateOcrConfig(current => ({ ...current, enabled: event.target.checked }))}
                              />
                              <span>启用 OCR 预处理</span>
                            </label>

                            <div className="grid grid-cols-2 gap-3">
                              <label className="block">
                                <span className="block text-xs font-medium text-gray-500 mb-1">OCR 服务商</span>
                                <select
                                  className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-300"
                                  value={ocrConfig.providerId}
                                  onChange={event => {
                                    const nextProviderId = event.target.value
                                    const nextProvider = providers.find(provider => provider.id === nextProviderId)
                                    updateOcrConfig(current => ({
                                      ...current,
                                      providerId: nextProviderId,
                                      endpoint: nextProvider?.endpoint || current.endpoint,
                                    }))
                                  }}
                                >
                                  {providers.map(provider => (
                                    <option key={provider.id} value={provider.id}>{provider.label}</option>
                                  ))}
                                </select>
                              </label>

                              <label className="block">
                                <span className="block text-xs font-medium text-gray-500 mb-1">OCR 模型 ID</span>
                                <input
                                  list="ocr-models"
                                  type="text"
                                  className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-300"
                                  value={ocrConfig.model}
                                  onChange={event => updateOcrConfig(current => ({ ...current, model: event.target.value }))}
                                  placeholder="PaddlePaddle/PaddleOCR-VL-1.5"
                                />
                                <datalist id="ocr-models">
                                  {ocrConfig.models.map(model => (
                                    <option key={model.id} value={model.id}>{model.label}</option>
                                  ))}
                                </datalist>
                              </label>
                            </div>

                            <label className="block">
                              <span className="block text-xs font-medium text-gray-500 mb-1">OCR 端点 URL</span>
                              <input
                                type="text"
                                className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-300"
                                value={ocrConfig.endpoint}
                                onChange={event => updateOcrConfig(current => ({ ...current, endpoint: event.target.value, apiKeyChanged: current.apiKeyChanged }))}
                                placeholder="https://api.siliconflow.cn/v1"
                              />
                            </label>

                            <label className="block">
                              <span className="block text-xs font-medium text-gray-500 mb-1">
                                OCR API Key
                                {(ocrConfig.hasApiKey && !ocrConfig.apiKeyChanged) && (
                                  <span className="ml-1 font-normal text-gray-400">（留空则保持不变）</span>
                                )}
                              </span>
                              <input
                                type="password"
                                className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-300"
                                value={ocrConfig.apiKey}
                                onChange={event => updateOcrConfig(current => ({
                                  ...current,
                                  apiKey: event.target.value,
                                  apiKeyChanged: true,
                                }))}
                                placeholder={ocrConfig.hasApiKey && !ocrConfig.apiKeyChanged ? '已配置，留空不修改' : '输入 OCR API Key，可留空以复用所选服务商 Key'}
                                autoComplete="off"
                              />
                            </label>

                            <div className="grid grid-cols-2 gap-3">
                              <label className="block">
                                <span className="block text-xs font-medium text-gray-500 mb-1">OCR 超时（秒）</span>
                                <input
                                  type="number"
                                  min={5}
                                  max={600}
                                  className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-300"
                                  value={ocrConfig.timeoutSeconds}
                                  onChange={event => updateOcrConfig(current => ({ ...current, timeoutSeconds: Number(event.target.value) || 60 }))}
                                />
                              </label>

                              <label className="block">
                                <span className="block text-xs font-medium text-gray-500 mb-1">最多图片数</span>
                                <input
                                  type="number"
                                  min={1}
                                  max={20}
                                  className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-300"
                                  value={ocrConfig.maxImages}
                                  onChange={event => updateOcrConfig(current => ({ ...current, maxImages: Number(event.target.value) || 5 }))}
                                />
                              </label>
                            </div>

                            <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-3 space-y-3">
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <div className="text-xs font-medium text-gray-600">OCR 模型发现</div>
                                  <div className="text-[11px] text-gray-400 mt-1">从 OCR 端点拉取模型列表，方便选择 PaddleOCR-VL-1.5 或兼容模型。</div>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => void handleFetchOcrModels()}
                                  disabled={!ocrConfig.endpoint || ocrConfig.modelsLoading}
                                  className="px-3 py-1.5 text-xs rounded-lg border border-gray-300 bg-white hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {ocrConfig.modelsLoading ? '查询中...' : '查询 OCR 模型'}
                                </button>
                              </div>

                              {ocrConfig.modelsError && (
                                <div className="text-xs text-red-600">{ocrConfig.modelsError}</div>
                              )}

                              {ocrConfig.models.length > 0 && (
                                <div className="max-h-40 overflow-y-auto rounded-lg border border-gray-200 bg-white">
                                  {ocrConfig.models.map(model => (
                                    <button
                                      key={model.id}
                                      type="button"
                                      onClick={() => updateOcrConfig(current => ({ ...current, model: model.id }))}
                                      className={`w-full px-3 py-2 text-left text-xs border-b border-gray-100 last:border-b-0 transition-colors ${ocrConfig.model === model.id ? 'bg-violet-50 text-violet-700' : 'text-gray-700 hover:bg-gray-50'}`}
                                    >
                                      <div className="font-medium">{model.id}</div>
                                      {model.label !== model.id && <div className="text-[11px] text-gray-400 mt-0.5">{model.label}</div>}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>

                            <div className="text-[11px] text-gray-500">
                              当前默认建议模型：PaddlePaddle/PaddleOCR-VL-1.5。你也可以填写硅基流动实际开放的兼容模型 ID。
                            </div>
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
