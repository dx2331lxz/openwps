import { useEffect, useMemo, useState } from 'react'
import {
  CUSTOM_PROVIDER_TEMPLATE,
  type AISettingsData,
  type AIProviderSettings,
  type ModelOption,
  type OcrConfigData,
  type TavilyConfigData,
  type VisionConfigData,
} from '../ai/providers'

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

interface EditableVisionConfig extends VisionConfigData {
  apiKey: string
  apiKeyChanged: boolean
  models: ModelOption[]
  modelsLoading: boolean
  modelsError: string | null
  testing: boolean
  testMessage: string | null
}

interface EditableTavilyConfig extends TavilyConfigData {
  apiKey: string
  apiKeyChanged: boolean
}

interface Props {
  onClose: () => void
}

type SettingsTab = 'providers' | 'vision' | 'ocr' | 'search'
type CapabilityTone = 'green' | 'amber' | 'red' | 'gray'

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string; description: string }> = [
  { id: 'providers', label: '模型服务', description: '主聊天模型与共享服务商' },
  { id: 'vision', label: '多模态图片', description: '文档图片与视觉理解' },
  { id: 'ocr', label: 'OCR 识别', description: '扫描件、表格、公式' },
  { id: 'search', label: '联网搜索', description: 'Tavily web_search' },
]

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
    promptCacheMode: provider.promptCacheMode ?? (provider.id === 'openai' ? 'openai_auto' : 'off'),
    promptCacheRetention: provider.promptCacheRetention ?? 'in_memory',
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

function toEditableVisionConfig(visionConfig: VisionConfigData): EditableVisionConfig {
  return {
    ...visionConfig,
    apiKey: '',
    apiKeyChanged: false,
    models: visionConfig.model ? [{ id: visionConfig.model, label: visionConfig.model }] : [],
    modelsLoading: false,
    modelsError: null,
    testing: false,
    testMessage: null,
  }
}

function toEditableTavilyConfig(tavilyConfig: TavilyConfigData): EditableTavilyConfig {
  return {
    ...tavilyConfig,
    apiKey: '',
    apiKeyChanged: false,
  }
}

export default function SettingsModal({ onClose }: Props) {
  const [providers, setProviders] = useState<EditableProvider[]>([])
  const [selectedProviderId, setSelectedProviderId] = useState('')
  const [activeProviderId, setActiveProviderId] = useState('')
  const [ocrConfig, setOcrConfig] = useState<EditableOcrConfig>(toEditableOcrConfig({
    enabled: true,
    backend: 'compat_chat',
    providerId: 'siliconflow',
    endpoint: 'https://api.siliconflow.cn/v1',
    model: 'PaddlePaddle/PaddleOCR-VL-1.5',
    hasApiKey: false,
    timeoutSeconds: 60,
    maxImages: 5,
  }))
  const [visionConfig, setVisionConfig] = useState<EditableVisionConfig>(toEditableVisionConfig({
    enabled: false,
    providerId: 'openai',
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    hasApiKey: false,
    timeoutSeconds: 30,
  }))
  const [tavilyConfig, setTavilyConfig] = useState<EditableTavilyConfig>(toEditableTavilyConfig({
    enabled: true,
    hasApiKey: false,
    searchDepth: 'basic',
    topic: 'general',
    maxResults: 5,
    timeoutSeconds: 15,
  }))
  const [aiSaving, setAiSaving] = useState(false)
  const [aiSavedOk, setAiSavedOk] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiNotice, setAiNotice] = useState<string | null>(null)
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTab>('providers')
  const [advancedOpen, setAdvancedOpen] = useState<Record<SettingsTab, boolean>>({
    providers: false,
    vision: false,
    ocr: false,
    search: false,
  })

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
        setOcrConfig(toEditableOcrConfig(data.ocrConfig))
        setVisionConfig(toEditableVisionConfig(data.visionConfig))
        setTavilyConfig(toEditableTavilyConfig(data.tavilyConfig))
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
  const selectedVisionProvider = useMemo(
    () => providers.find(provider => provider.id === visionConfig.providerId) ?? null,
    [providers, visionConfig.providerId],
  )
  const ocrBackendRequiresModel = ocrConfig.backend === 'compat_chat'

  function updateProvider(providerId: string, updater: (provider: EditableProvider) => EditableProvider) {
    setProviders(prev => prev.map(provider => (provider.id === providerId ? updater(provider) : provider)))
  }

  function updateOcrConfig(updater: (config: EditableOcrConfig) => EditableOcrConfig) {
    setOcrConfig(prev => updater(prev))
  }

  function updateVisionConfig(updater: (config: EditableVisionConfig) => EditableVisionConfig) {
    setVisionConfig(prev => updater(prev))
  }

  function updateTavilyConfig(updater: (config: EditableTavilyConfig) => EditableTavilyConfig) {
    setTavilyConfig(prev => updater(prev))
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
    if (!ocrBackendRequiresModel) {
      updateOcrConfig(current => ({
        ...current,
        modelsLoading: false,
        modelsError: '官方 PaddleOCR 服务模式不提供 /models 枚举，模型发现仅适用于兼容 chat/completions 端点。',
      }))
      return
    }

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

  async function handleFetchVisionModels() {
    updateVisionConfig(current => ({ ...current, modelsLoading: true, modelsError: null, testMessage: null }))
    setAiError(null)

    try {
      const payload: Record<string, unknown> = {
        providerId: visionConfig.providerId,
        endpoint: visionConfig.endpoint || selectedVisionProvider?.endpoint || '',
      }
      if (visionConfig.apiKeyChanged) payload.apiKey = visionConfig.apiKey
      const response = await fetch('/api/ai/models/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await response.json() as { models?: ModelOption[]; detail?: string }
      if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`)
      const models = Array.isArray(data.models) ? data.models : []
      updateVisionConfig(current => ({
        ...current,
        models,
        modelsLoading: false,
        modelsError: models.length === 0 ? '该多模态端点没有返回可用模型' : null,
        model: current.model || models.find(model => model.supportsVision)?.id || models[0]?.id || '',
      }))
    } catch (error) {
      updateVisionConfig(current => ({
        ...current,
        modelsLoading: false,
        modelsError: error instanceof Error ? error.message : String(error),
      }))
    }
  }

  async function handleTestVisionModel() {
    updateVisionConfig(current => ({ ...current, testing: true, modelsError: null, testMessage: null }))
    setAiError(null)
    try {
      const response = await fetch('/api/ai/vision/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: visionConfig.providerId,
          endpoint: visionConfig.endpoint || selectedVisionProvider?.endpoint || '',
          model: visionConfig.model,
          apiKey: visionConfig.apiKeyChanged ? visionConfig.apiKey : undefined,
          timeoutSeconds: visionConfig.timeoutSeconds,
        }),
      })
      const data = await response.json() as { message?: string; detail?: string }
      if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`)
      updateVisionConfig(current => ({ ...current, testing: false, testMessage: data.message || '多模态测试通过' }))
    } catch (error) {
      updateVisionConfig(current => ({
        ...current,
        testing: false,
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
    setOcrConfig(prev => (prev.providerId === providerId ? { ...prev, providerId: fallbackId, endpoint: remaining[0]?.endpoint || prev.endpoint } : prev))
    setVisionConfig(prev => (prev.providerId === providerId ? { ...prev, providerId: fallbackId, endpoint: remaining[0]?.endpoint || prev.endpoint, model: remaining[0]?.defaultModel || prev.model } : prev))
  }

  async function handleAISave() {
    setAiNotice(null)
    if (providers.length === 0) {
      setActiveSettingsTab('providers')
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
      promptCacheMode: provider.promptCacheMode === 'openai_auto' ? 'openai_auto' : 'off',
      promptCacheRetention: provider.promptCacheRetention === '24h' ? '24h' : 'in_memory',
      ...(provider.apiKeyChanged ? { apiKey: provider.apiKey.trim() } : {}),
    }))

    const normalizedOcrConfig: Record<string, unknown> = {
      enabled: ocrConfig.enabled,
      backend: ocrConfig.backend,
      providerId: ocrConfig.providerId.trim() || 'siliconflow',
      endpoint: ocrConfig.endpoint.trim(),
      model: ocrConfig.model.trim(),
      timeoutSeconds: ocrConfig.timeoutSeconds,
      maxImages: ocrConfig.maxImages,
    }
    if (ocrConfig.apiKeyChanged) normalizedOcrConfig.apiKey = ocrConfig.apiKey.trim()

    const normalizedVisionConfig: Record<string, unknown> = {
      enabled: visionConfig.enabled,
      providerId: visionConfig.providerId.trim() || 'openai',
      endpoint: visionConfig.endpoint.trim(),
      model: visionConfig.model.trim(),
      timeoutSeconds: visionConfig.timeoutSeconds,
    }
    if (visionConfig.apiKeyChanged) normalizedVisionConfig.apiKey = visionConfig.apiKey.trim()

    const normalizedTavilyConfig: Record<string, unknown> = {
      enabled: tavilyConfig.enabled,
      searchDepth: tavilyConfig.searchDepth,
      topic: tavilyConfig.topic,
      maxResults: tavilyConfig.maxResults,
      timeoutSeconds: tavilyConfig.timeoutSeconds,
    }
    if (tavilyConfig.apiKeyChanged) normalizedTavilyConfig.apiKey = tavilyConfig.apiKey.trim()

    if (!normalizedProviders.some(provider => provider.id === activeProviderId)) {
      setActiveSettingsTab('providers')
      setAiError('请选择一个默认服务商')
      return
    }

    const invalidProvider = normalizedProviders.find(provider => !provider.endpoint)
    if (invalidProvider) {
      setActiveSettingsTab('providers')
      setAiError(`请填写服务商“${invalidProvider.label}”的端点地址`)
      return
    }

    const activeProvider = normalizedProviders.find(provider => provider.id === activeProviderId)
    if (!activeProvider?.defaultModel.trim()) {
      setActiveSettingsTab('providers')
      setAiError('请填写默认聊天模型 ID')
      return
    }

    if (ocrConfig.enabled) {
      const ocrProviderExists = normalizedProviders.some(provider => provider.id === normalizedOcrConfig.providerId)
      if (ocrBackendRequiresModel && !String(normalizedOcrConfig.model || '').trim()) {
        setActiveSettingsTab('ocr')
        setAiError('请填写 OCR 模型 ID')
        return
      }
      if (!ocrProviderExists && !String(normalizedOcrConfig.endpoint || '').trim()) {
        setActiveSettingsTab('ocr')
        setAiError('请填写 OCR 端点，或选择一个 OCR 服务商')
        return
      }
    }

    if (visionConfig.enabled) {
      const visionProviderExists = normalizedProviders.some(provider => provider.id === normalizedVisionConfig.providerId)
      if (!String(normalizedVisionConfig.model || '').trim()) {
        setActiveSettingsTab('vision')
        setAiError('请填写多模态图片分析模型 ID')
        return
      }
      if (!visionProviderExists && !String(normalizedVisionConfig.endpoint || '').trim()) {
        setActiveSettingsTab('vision')
        setAiError('请填写多模态图片分析端点，或选择一个服务商')
        return
      }
    }

    if (tavilyConfig.enabled) {
      const hasTavilyKey = tavilyConfig.apiKeyChanged ? Boolean(tavilyConfig.apiKey.trim()) : Boolean(tavilyConfig.hasApiKey)
      if (!hasTavilyKey) {
        setActiveSettingsTab('search')
        setAiError('联网搜索需要填写 Tavily API Key')
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
          imageProcessingMode: 'direct_multimodal',
          ocrConfig: normalizedOcrConfig,
          visionConfig: normalizedVisionConfig,
          tavilyConfig: normalizedTavilyConfig,
          providers: normalizedProviders,
        }),
      })
      const updated = await response.json() as AISettingsData & { detail?: string }
      if (!response.ok) throw new Error(updated.detail || `HTTP ${response.status}`)

      setProviders(updated.providers.map(toEditableProvider))
      setSelectedProviderId(updated.activeProviderId)
      setActiveProviderId(updated.activeProviderId)
      setOcrConfig(toEditableOcrConfig(updated.ocrConfig))
      setVisionConfig(toEditableVisionConfig(updated.visionConfig))
      setTavilyConfig(toEditableTavilyConfig(updated.tavilyConfig))
      setAiSavedOk(true)
      setTimeout(() => {
        setAiSavedOk(false)
      }, 1200)
    } catch (error) {
      setAiError(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setAiSaving(false)
    }
  }

  function toggleAdvanced(tab: SettingsTab) {
    setAdvancedOpen(prev => ({ ...prev, [tab]: !prev[tab] }))
  }

  function getProviderHasKey(provider: EditableProvider | null) {
    if (!provider) return false
    return provider.apiKeyChanged ? Boolean(provider.apiKey.trim()) : Boolean(provider.hasApiKey)
  }

  function getProviderStatus() {
    const provider = providers.find(item => item.id === activeProviderId) ?? null
    if (!provider) return { tone: 'red' as CapabilityTone, label: '缺少配置', detail: '尚未选择默认聊天服务商。' }
    if (!provider.endpoint.trim()) return { tone: 'red' as CapabilityTone, label: '缺少配置', detail: `默认服务商“${provider.label}”缺少端点。` }
    if (!provider.defaultModel.trim()) return { tone: 'red' as CapabilityTone, label: '缺少配置', detail: `默认服务商“${provider.label}”缺少默认模型。` }
    if (!getProviderHasKey(provider)) return { tone: 'amber' as CapabilityTone, label: '缺少 Key', detail: `默认服务商“${provider.label}”还没有 API Key。` }
    return { tone: 'green' as CapabilityTone, label: '可用', detail: `默认使用 ${provider.label} / ${provider.defaultModel}` }
  }

  function getVisionStatus() {
    const provider = selectedVisionProvider
    const fallbackReady = Boolean(
      visionConfig.enabled
      && provider
      && (visionConfig.endpoint.trim() || provider.endpoint)
      && visionConfig.model.trim()
      && (visionConfig.apiKeyChanged ? visionConfig.apiKey.trim() : (visionConfig.hasApiKey || provider.hasApiKey))
    )
    const activeProvider = providers.find(item => item.id === activeProviderId) ?? null
    const mainVision = Boolean(activeProvider?.supportsVision)
    if (mainVision) {
      return { tone: 'green' as CapabilityTone, label: '主模型可看图', detail: `主模型服务商“${activeProvider?.label}”已标记支持多模态。` }
    }
    if (!visionConfig.enabled) return { tone: 'amber' as CapabilityTone, label: '未启用 fallback', detail: '主模型未标记多模态；文档图片分析需要启用多模态图片模型。' }
    if (!fallbackReady) return { tone: 'red' as CapabilityTone, label: '缺少配置', detail: '多模态图片模型缺少服务商、端点、模型或 API Key。' }
    if (visionConfig.testMessage) return { tone: 'green' as CapabilityTone, label: '测试通过', detail: visionConfig.testMessage }
    return { tone: 'amber' as CapabilityTone, label: '未测试', detail: `将使用 ${provider?.label ?? visionConfig.providerId} / ${visionConfig.model}` }
  }

  function getOcrStatus() {
    const provider = selectedOcrProvider
    if (!ocrConfig.enabled) return { tone: 'gray' as CapabilityTone, label: '未启用', detail: 'OCR 工具不会处理扫描件、表格、公式等图片。' }
    if (!provider) return { tone: 'red' as CapabilityTone, label: '缺少配置', detail: 'OCR 服务商不存在，请重新选择。' }
    if (!(ocrConfig.endpoint.trim() || provider.endpoint)) return { tone: 'red' as CapabilityTone, label: '缺少端点', detail: 'OCR 识别缺少端点。' }
    if (ocrBackendRequiresModel && !ocrConfig.model.trim()) return { tone: 'red' as CapabilityTone, label: '缺少模型', detail: '兼容 chat/completions 模式需要 OCR 模型 ID。' }
    const hasKey = ocrConfig.apiKeyChanged ? Boolean(ocrConfig.apiKey.trim()) : (ocrConfig.hasApiKey || provider.hasApiKey)
    if (!hasKey) return { tone: 'amber' as CapabilityTone, label: '缺少 Key', detail: 'OCR 识别还没有 API Key。' }
    return { tone: 'green' as CapabilityTone, label: '可用', detail: `${ocrConfig.backend === 'compat_chat' ? '兼容聊天接口' : 'PaddleOCR 服务'} / ${ocrConfig.model || '服务端默认模型'}` }
  }

  function getSearchStatus() {
    if (!tavilyConfig.enabled) return { tone: 'gray' as CapabilityTone, label: '未启用', detail: 'Agent 不会调用 web_search。' }
    const hasKey = tavilyConfig.apiKeyChanged ? Boolean(tavilyConfig.apiKey.trim()) : Boolean(tavilyConfig.hasApiKey)
    if (!hasKey) return { tone: 'red' as CapabilityTone, label: '缺少 Key', detail: '联网搜索需要 Tavily API Key。' }
    return { tone: 'green' as CapabilityTone, label: '可用', detail: `${tavilyConfig.searchDepth} / ${tavilyConfig.topic} / ${tavilyConfig.maxResults} 条结果` }
  }

  function renderStatusCard(
    title: string,
    status: { tone: CapabilityTone; label: string; detail: string },
    action?: { label: string; onClick: () => void; disabled?: boolean },
  ) {
    const toneClass = {
      green: 'border-emerald-200 bg-emerald-50 text-emerald-700',
      amber: 'border-amber-200 bg-amber-50 text-amber-700',
      red: 'border-red-200 bg-red-50 text-red-700',
      gray: 'border-gray-200 bg-gray-50 text-gray-600',
    }[status.tone]
    return (
      <div className={`rounded-xl border px-3 py-3 ${toneClass}`}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-semibold">{title} · {status.label}</div>
            <div className="text-[11px] mt-1 opacity-80">{status.detail}</div>
          </div>
          {action && (
            <button
              type="button"
              onClick={action.onClick}
              disabled={action.disabled}
              className="flex-shrink-0 px-3 py-1.5 text-xs rounded-lg border border-current bg-white/70 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {action.label}
            </button>
          )}
        </div>
      </div>
    )
  }

  function markConfigChecked(tab: SettingsTab) {
    const label = SETTINGS_TABS.find(item => item.id === tab)?.label ?? '配置'
    setAiError(null)
    setAiNotice(`${label}配置完整性检查完成：${tab === 'providers' ? getProviderStatus().detail : tab === 'ocr' ? getOcrStatus().detail : getSearchStatus().detail}`)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-[980px] max-w-[96vw] mx-4 flex flex-col"
        style={{ maxHeight: '90vh' }}
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 flex-shrink-0">
          <div>
            <h2 className="font-semibold text-gray-800 text-base">AI 设置</h2>
            <p className="text-xs text-gray-400 mt-0.5">服务商是共享资源；图片、OCR 和联网搜索在各自能力页选择使用方式。</p>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 text-xl leading-none"
          >×</button>
        </div>

        <div className="border-b border-gray-100 px-5 pt-3 flex-shrink-0">
          <div className="grid grid-cols-4 gap-2">
            {SETTINGS_TABS.map(tab => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveSettingsTab(tab.id)}
                className={`rounded-t-xl border px-3 py-2 text-left transition-colors ${activeSettingsTab === tab.id
                  ? 'border-gray-200 border-b-white bg-white text-blue-700'
                  : 'border-transparent bg-gray-50 text-gray-500 hover:bg-gray-100'
                  }`}
              >
                <div className="text-sm font-medium">{tab.label}</div>
                <div className="text-[11px] mt-0.5 truncate">{tab.description}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-y-auto flex-1">
          <div className="px-5 py-4 space-y-4">
            {aiError && <div className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{aiError}</div>}
            {aiNotice && <div className="text-xs text-blue-700 bg-blue-50 px-3 py-2 rounded-lg">{aiNotice}</div>}

            {activeSettingsTab === 'providers' && (
              <div className="space-y-4">
                {renderStatusCard('模型服务', getProviderStatus(), {
                  label: '检查配置',
                  onClick: () => markConfigChecked('providers'),
                })}

                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-gray-700">共享服务商</p>
                    <p className="text-xs text-gray-400 mt-1">这里维护端点、Key 和默认聊天模型；其他能力通过服务商复用这些连接信息。</p>
                  </div>
                  <button
                    type="button"
                    onClick={handleAddCustomProvider}
                    className="px-3 py-2 text-xs font-medium border border-blue-200 rounded-lg text-blue-600 bg-blue-50 hover:bg-blue-100 transition-colors"
                  >
                    新增自定义服务商
                  </button>
                </div>

                <div className="grid grid-cols-[240px_minmax(0,1fr)] gap-4 min-h-[420px]">
                  <div className="border border-gray-200 rounded-xl p-3 bg-gray-50 space-y-2 overflow-y-auto">
                    {providers.map(provider => (
                      <button
                        key={provider.id}
                        type="button"
                        onClick={() => setSelectedProviderId(provider.id)}
                        className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${selectedProviderId === provider.id
                          ? 'border-blue-300 bg-white shadow-sm'
                          : 'border-transparent hover:border-gray-200 hover:bg-white'
                          }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-gray-800 truncate">{provider.label}</span>
                          {activeProviderId === provider.id && <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">默认</span>}
                        </div>
                        <div className="mt-1 text-[11px] text-gray-400 truncate">{provider.endpoint || '未填写端点'}</div>
                        <div className="mt-1 flex items-center gap-2 text-[11px] text-gray-500">
                          <span className="truncate">{provider.defaultModel || '未设模型'}</span>
                          <span className={getProviderHasKey(provider) ? 'text-green-600' : 'text-yellow-600'}>
                            {getProviderHasKey(provider) ? 'Key 已配置' : '无 Key'}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>

                  <div className="border border-gray-200 rounded-xl p-4 bg-white">
                    {selectedProvider ? (
                      <div className="space-y-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold text-gray-800">{selectedProvider.label}</div>
                            <div className="text-xs text-gray-400 mt-1">
                              {selectedProvider.isPreset ? '预设服务商，可补充 Key、端点和默认模型。' : '自定义服务商，可自由填写名称和端点。'}
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

                        <label className="flex items-center gap-2 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-700">
                          <input
                            type="radio"
                            checked={activeProviderId === selectedProvider.id}
                            onChange={() => setActiveProviderId(selectedProvider.id)}
                          />
                          <span>设为默认聊天服务商</span>
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
                            <span className="block text-xs font-medium text-gray-500 mb-1">默认聊天模型</span>
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

                        <label className="flex items-center gap-2 text-xs text-gray-600">
                          <input
                            type="checkbox"
                            checked={Boolean(selectedProvider.supportsVision)}
                            onChange={event => updateProvider(selectedProvider.id, current => ({ ...current, supportsVision: event.target.checked }))}
                          />
                          <span>该服务商默认模型支持图片输入</span>
                        </label>

                        <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-3 space-y-3">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="text-xs font-medium text-gray-600">模型发现</div>
                              <div className="text-[11px] text-gray-400 mt-1">从端点拉取模型列表，选择默认聊天模型。</div>
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

                          {selectedProvider.modelsError && <div className="text-xs text-red-600">{selectedProvider.modelsError}</div>}
                          {selectedProvider.models.length > 0 && (
                            <div className="max-h-44 overflow-y-auto rounded-lg border border-gray-200 bg-white">
                              {selectedProvider.models.map(model => (
                                <button
                                  key={model.id}
                                  type="button"
                                  onClick={() => updateProvider(selectedProvider.id, current => ({
                                    ...current,
                                    defaultModel: model.id,
                                    supportsVision: model.supportsVision ?? current.supportsVision,
                                  }))}
                                  className={`w-full px-3 py-2 text-left text-xs border-b border-gray-100 last:border-b-0 transition-colors ${selectedProvider.defaultModel === model.id ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50'}`}
                                >
                                  <div className="font-medium">{model.id}{model.supportsVision ? ' · 多模态' : ''}</div>
                                  {model.label !== model.id && <div className="text-[11px] text-gray-400 mt-0.5">{model.label}</div>}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>

                        <button
                          type="button"
                          onClick={() => toggleAdvanced('providers')}
                          className="text-xs text-gray-500 hover:text-gray-700"
                        >
                          {advancedOpen.providers ? '收起高级设置' : '展开高级设置'}
                        </button>
                        {advancedOpen.providers && (
                          <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 px-3 py-3 space-y-3">
                            <div>
                              <div className="text-xs font-medium text-emerald-700">Prompt Cache</div>
                              <div className="text-[11px] text-emerald-600 mt-1">未知网关建议保持关闭。</div>
                            </div>
                            <label className="flex items-center gap-2 text-xs text-gray-700">
                              <input
                                type="checkbox"
                                checked={selectedProvider.promptCacheMode === 'openai_auto'}
                                onChange={event => updateProvider(selectedProvider.id, current => ({
                                  ...current,
                                  promptCacheMode: event.target.checked ? 'openai_auto' : 'off',
                                }))}
                              />
                              <span>启用 OpenAI 自动 Prompt Cache 参数</span>
                            </label>
                            <label className="block">
                              <span className="block text-xs font-medium text-gray-500 mb-1">缓存保留策略</span>
                              <select
                                className="w-full text-sm border border-emerald-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-300 disabled:bg-gray-100 disabled:text-gray-400"
                                value={selectedProvider.promptCacheRetention ?? 'in_memory'}
                                disabled={selectedProvider.promptCacheMode !== 'openai_auto'}
                                onChange={event => updateProvider(selectedProvider.id, current => ({
                                  ...current,
                                  promptCacheRetention: event.target.value === '24h' ? '24h' : 'in_memory',
                                }))}
                              >
                                <option value="in_memory">in_memory</option>
                                <option value="24h">24h</option>
                              </select>
                            </label>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="h-full flex items-center justify-center text-sm text-gray-400">请选择一个服务商进行编辑</div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeSettingsTab === 'vision' && (
              <div className="space-y-4">
                {renderStatusCard('多模态图片', getVisionStatus(), {
                  label: visionConfig.testing ? '测试中...' : '测试多模态',
                  onClick: () => void handleTestVisionModel(),
                  disabled: visionConfig.testing || !visionConfig.model,
                })}
                <div className="rounded-xl border border-sky-200 bg-sky-50/70 px-3 py-3 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-sky-800">图片分析 fallback</div>
                      <div className="text-xs text-sky-600 mt-1">主聊天模型不支持图片时，文档内图片分析使用这里的模型。</div>
                    </div>
                    <label className="inline-flex items-center gap-2 text-xs text-sky-700">
                      <input
                        type="checkbox"
                        checked={visionConfig.enabled}
                        onChange={event => updateVisionConfig(current => ({ ...current, enabled: event.target.checked }))}
                      />
                      <span>启用 fallback</span>
                    </label>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <label className="block">
                      <span className="block text-xs font-medium text-sky-700 mb-1">服务商</span>
                      <select
                        className="w-full text-sm border border-sky-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-sky-300"
                        value={visionConfig.providerId}
                        onChange={event => updateVisionConfig(current => {
                          const provider = providers.find(item => item.id === event.target.value)
                          return {
                            ...current,
                            providerId: event.target.value,
                            endpoint: provider?.endpoint || current.endpoint,
                            model: provider?.defaultModel || current.model,
                            testMessage: null,
                          }
                        })}
                      >
                        {providers.map(provider => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
                      </select>
                    </label>
                    <label className="block">
                      <span className="block text-xs font-medium text-sky-700 mb-1">视觉模型 ID</span>
                      <input
                        className="w-full text-sm border border-sky-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-300"
                        value={visionConfig.model}
                        list="vision-models"
                        onChange={event => updateVisionConfig(current => ({ ...current, model: event.target.value, testMessage: null }))}
                        placeholder="gpt-4o-mini / Qwen2.5-VL..."
                      />
                      <datalist id="vision-models">
                        {visionConfig.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
                      </datalist>
                    </label>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleFetchVisionModels()}
                      disabled={visionConfig.modelsLoading}
                      className="px-3 py-1.5 text-xs rounded-lg border border-sky-300 bg-white hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {visionConfig.modelsLoading ? '查询中...' : '查询模型'}
                    </button>
                    {visionConfig.testMessage && <span className="text-xs text-emerald-600">{visionConfig.testMessage}</span>}
                  </div>
                  {visionConfig.modelsError && <div className="text-xs text-red-600">{visionConfig.modelsError}</div>}

                  {visionConfig.models.length > 0 && (
                    <div className="max-h-36 overflow-y-auto rounded-lg border border-sky-100 bg-white">
                      {visionConfig.models.map(model => (
                        <button
                          key={model.id}
                          type="button"
                          onClick={() => updateVisionConfig(current => ({ ...current, model: model.id, testMessage: null }))}
                          className={`w-full px-3 py-2 text-left text-xs border-b border-sky-50 last:border-b-0 transition-colors ${visionConfig.model === model.id ? 'bg-sky-100 text-sky-700' : 'text-gray-700 hover:bg-sky-50'}`}
                        >
                          <div className="font-medium">{model.id}{model.supportsVision ? ' · 多模态' : ''}</div>
                          {model.label !== model.id && <div className="text-[11px] text-gray-400 mt-0.5">{model.label}</div>}
                        </button>
                      ))}
                    </div>
                  )}

                  <button type="button" onClick={() => toggleAdvanced('vision')} className="text-xs text-sky-700 hover:text-sky-900">
                    {advancedOpen.vision ? '收起高级设置' : '展开高级设置'}
                  </button>
                  {advancedOpen.vision && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 rounded-lg border border-sky-100 bg-white px-3 py-3">
                      <label className="block">
                        <span className="block text-xs font-medium text-sky-700 mb-1">能力专用端点</span>
                        <input
                          className="w-full text-sm border border-sky-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-300"
                          value={visionConfig.endpoint}
                          onChange={event => updateVisionConfig(current => ({ ...current, endpoint: event.target.value, testMessage: null }))}
                          placeholder={selectedVisionProvider?.endpoint || 'https://api.openai.com/v1'}
                        />
                      </label>
                      <label className="block">
                        <span className="block text-xs font-medium text-sky-700 mb-1">能力专用 API Key</span>
                        <input
                          className="w-full text-sm border border-sky-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-300"
                          type="password"
                          value={visionConfig.apiKey}
                          onChange={event => updateVisionConfig(current => ({
                            ...current,
                            apiKey: event.target.value,
                            apiKeyChanged: true,
                            testMessage: null,
                          }))}
                          placeholder={visionConfig.hasApiKey && !visionConfig.apiKeyChanged ? '已配置，留空不修改' : '可留空以复用所选服务商 Key'}
                        />
                      </label>
                      <label className="block">
                        <span className="block text-xs font-medium text-sky-700 mb-1">超时（秒）</span>
                        <input
                          type="number"
                          min={5}
                          max={120}
                          className="w-32 text-sm border border-sky-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-300"
                          value={visionConfig.timeoutSeconds}
                          onChange={event => updateVisionConfig(current => ({ ...current, timeoutSeconds: Number(event.target.value) || 30 }))}
                        />
                      </label>
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeSettingsTab === 'ocr' && (
              <div className="space-y-4">
                {renderStatusCard('OCR 识别', getOcrStatus(), {
                  label: '检查配置',
                  onClick: () => markConfigChecked('ocr'),
                })}
                <div className="rounded-xl border border-violet-200 bg-violet-50/70 px-3 py-3 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-violet-800">OCR 专用识别</div>
                      <div className="text-xs text-violet-600 mt-1">用于扫描件、表格、手写、公式等文本密集图片。</div>
                    </div>
                    <label className="inline-flex items-center gap-2 text-xs text-violet-700">
                      <input
                        type="checkbox"
                        checked={ocrConfig.enabled}
                        onChange={event => updateOcrConfig(current => ({ ...current, enabled: event.target.checked }))}
                      />
                      <span>启用 OCR</span>
                    </label>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <label className="block">
                      <span className="block text-xs font-medium text-gray-500 mb-1">接口模式</span>
                      <select
                        className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-300"
                        value={ocrConfig.backend}
                        onChange={event => {
                          const nextBackend = event.target.value as EditableOcrConfig['backend']
                          updateOcrConfig(current => ({
                            ...current,
                            backend: nextBackend,
                            model: nextBackend === 'compat_chat' ? (current.model || 'PaddlePaddle/PaddleOCR-VL-1.5') : current.model,
                            modelsError: null,
                          }))
                        }}
                      >
                        <option value="compat_chat">兼容 chat/completions</option>
                        <option value="paddleocr_service">官方 layout-parsing 服务</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="block text-xs font-medium text-gray-500 mb-1">服务商</span>
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
                        {providers.map(provider => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
                      </select>
                    </label>
                  </div>

                  <label className="block">
                    <span className="block text-xs font-medium text-gray-500 mb-1">
                      {ocrBackendRequiresModel ? 'OCR 模型 ID' : 'OCR 模型 ID（可选）'}
                    </span>
                    <input
                      list="ocr-models"
                      type="text"
                      className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-300"
                      value={ocrConfig.model}
                      onChange={event => updateOcrConfig(current => ({ ...current, model: event.target.value }))}
                      placeholder={ocrBackendRequiresModel ? 'PaddlePaddle/PaddleOCR-VL-1.5' : '官方服务模式通常不需要填写'}
                      disabled={!ocrBackendRequiresModel}
                    />
                    <datalist id="ocr-models">
                      {ocrConfig.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
                    </datalist>
                  </label>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleFetchOcrModels()}
                      disabled={!ocrConfig.endpoint || ocrConfig.modelsLoading || !ocrBackendRequiresModel}
                      className="px-3 py-1.5 text-xs rounded-lg border border-violet-300 bg-white hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {ocrConfig.modelsLoading ? '查询中...' : '查询 OCR 模型'}
                    </button>
                  </div>
                  {ocrConfig.modelsError && <div className="text-xs text-red-600">{ocrConfig.modelsError}</div>}
                  {ocrConfig.models.length > 0 && (
                    <div className="max-h-40 overflow-y-auto rounded-lg border border-violet-100 bg-white">
                      {ocrConfig.models.map(model => (
                        <button
                          key={model.id}
                          type="button"
                          onClick={() => updateOcrConfig(current => ({ ...current, model: model.id }))}
                          className={`w-full px-3 py-2 text-left text-xs border-b border-violet-50 last:border-b-0 transition-colors ${ocrConfig.model === model.id ? 'bg-violet-50 text-violet-700' : 'text-gray-700 hover:bg-gray-50'}`}
                        >
                          <div className="font-medium">{model.id}</div>
                          {model.label !== model.id && <div className="text-[11px] text-gray-400 mt-0.5">{model.label}</div>}
                        </button>
                      ))}
                    </div>
                  )}

                  <button type="button" onClick={() => toggleAdvanced('ocr')} className="text-xs text-violet-700 hover:text-violet-900">
                    {advancedOpen.ocr ? '收起高级设置' : '展开高级设置'}
                  </button>
                  {advancedOpen.ocr && (
                    <div className="space-y-3 rounded-lg border border-violet-100 bg-white px-3 py-3">
                      <label className="block">
                        <span className="block text-xs font-medium text-gray-500 mb-1">能力专用端点 URL</span>
                        <input
                          type="text"
                          className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-300"
                          value={ocrConfig.endpoint}
                          onChange={event => updateOcrConfig(current => ({ ...current, endpoint: event.target.value, apiKeyChanged: current.apiKeyChanged }))}
                          placeholder={ocrBackendRequiresModel ? 'https://api.siliconflow.cn/v1' : 'http://your-paddleocr-service'}
                        />
                      </label>
                      <label className="block">
                        <span className="block text-xs font-medium text-gray-500 mb-1">
                          OCR API Key
                          {(ocrConfig.hasApiKey && !ocrConfig.apiKeyChanged) && <span className="ml-1 font-normal text-gray-400">（留空则保持不变）</span>}
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
                          placeholder={ocrConfig.hasApiKey && !ocrConfig.apiKeyChanged ? '已配置，留空不修改' : '可留空以复用所选服务商 Key'}
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
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeSettingsTab === 'search' && (
              <div className="space-y-4">
                {renderStatusCard('联网搜索', getSearchStatus(), {
                  label: '检查配置',
                  onClick: () => markConfigChecked('search'),
                })}
                <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 px-3 py-3 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-emerald-800">Tavily 联网搜索</div>
                      <div className="text-xs text-emerald-600 mt-1">Agent 需要最新网页、新闻和外部资料时会调用 web_search。</div>
                    </div>
                    <label className="inline-flex items-center gap-2 text-xs text-emerald-700">
                      <input
                        type="checkbox"
                        checked={tavilyConfig.enabled}
                        onChange={event => updateTavilyConfig(current => ({ ...current, enabled: event.target.checked }))}
                      />
                      <span>启用联网搜索</span>
                    </label>
                  </div>

                  <label className="block">
                    <span className="block text-xs font-medium text-gray-500 mb-1">
                      Tavily API Key
                      {(tavilyConfig.hasApiKey && !tavilyConfig.apiKeyChanged) && <span className="ml-1 font-normal text-gray-400">（留空则保持不变）</span>}
                    </span>
                    <input
                      type="password"
                      className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-300"
                      value={tavilyConfig.apiKey}
                      onChange={event => updateTavilyConfig(current => ({
                        ...current,
                        apiKey: event.target.value,
                        apiKeyChanged: true,
                      }))}
                      placeholder={tavilyConfig.hasApiKey && !tavilyConfig.apiKeyChanged ? '已配置，留空不修改' : '输入 tvly- 开头的 API Key'}
                      autoComplete="off"
                    />
                  </label>

                  <button type="button" onClick={() => toggleAdvanced('search')} className="text-xs text-emerald-700 hover:text-emerald-900">
                    {advancedOpen.search ? '收起高级设置' : '展开高级设置'}
                  </button>
                  {advancedOpen.search && (
                    <div className="space-y-3 rounded-lg border border-emerald-100 bg-white px-3 py-3">
                      <div className="grid grid-cols-2 gap-3">
                        <label className="block">
                          <span className="block text-xs font-medium text-gray-500 mb-1">默认搜索深度</span>
                          <select
                            className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-300"
                            value={tavilyConfig.searchDepth}
                            onChange={event => updateTavilyConfig(current => ({
                              ...current,
                              searchDepth: event.target.value as EditableTavilyConfig['searchDepth'],
                            }))}
                          >
                            <option value="basic">basic（更快更省）</option>
                            <option value="advanced">advanced（更深入）</option>
                          </select>
                        </label>
                        <label className="block">
                          <span className="block text-xs font-medium text-gray-500 mb-1">默认搜索主题</span>
                          <select
                            className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-300"
                            value={tavilyConfig.topic}
                            onChange={event => updateTavilyConfig(current => ({
                              ...current,
                              topic: event.target.value as EditableTavilyConfig['topic'],
                            }))}
                          >
                            <option value="general">general</option>
                            <option value="news">news</option>
                            <option value="finance">finance</option>
                          </select>
                        </label>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <label className="block">
                          <span className="block text-xs font-medium text-gray-500 mb-1">默认结果数</span>
                          <input
                            type="number"
                            min={1}
                            max={10}
                            className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-300"
                            value={tavilyConfig.maxResults}
                            onChange={event => updateTavilyConfig(current => ({ ...current, maxResults: Number(event.target.value) || 5 }))}
                          />
                        </label>
                        <label className="block">
                          <span className="block text-xs font-medium text-gray-500 mb-1">超时（秒）</span>
                          <input
                            type="number"
                            min={5}
                            max={60}
                            className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-300"
                            value={tavilyConfig.timeoutSeconds}
                            onChange={event => updateTavilyConfig(current => ({ ...current, timeoutSeconds: Number(event.target.value) || 15 }))}
                          />
                        </label>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-100 flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50"
          >
            取消
          </button>

          <button
            onClick={() => void handleAISave()}
            disabled={aiSaving}
            className={`px-4 py-2 text-sm rounded-lg text-white ${aiSaving ? 'bg-blue-300' : aiSavedOk ? 'bg-green-500' : 'bg-blue-500 hover:bg-blue-600'}`}
          >
            {aiSaving ? '保存中...' : aiSavedOk ? '已保存' : '保存 AI 配置'}
          </button>
        </div>
      </div>
    </div>
  )
}
