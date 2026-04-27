export type ImageProcessingMode = 'direct_multimodal' | 'ocr_text'
export type OcrBackendMode = 'compat_chat' | 'paddleocr_service'

export interface OcrConfigData {
  enabled: boolean
  backend: OcrBackendMode
  providerId: string
  endpoint: string
  model: string
  hasApiKey: boolean
  timeoutSeconds: number
  maxImages: number
}

export interface TavilyConfigData {
  enabled: boolean
  hasApiKey: boolean
  searchDepth: 'basic' | 'advanced'
  topic: 'general' | 'news' | 'finance'
  maxResults: number
  timeoutSeconds: number
}

export interface VisionConfigData {
  enabled: boolean
  providerId: string
  endpoint: string
  model: string
  hasApiKey: boolean
  timeoutSeconds: number
}

export interface AIProviderSettings {
  id: string
  label: string
  endpoint: string
  defaultModel: string
  hasApiKey: boolean
  isPreset: boolean
  supportsVision?: boolean
  promptCacheMode?: 'off' | 'openai_auto'
  promptCacheRetention?: 'in_memory' | '24h'
}

export interface AISettingsData {
  activeProviderId: string
  imageProcessingMode: ImageProcessingMode
  ocrConfig: OcrConfigData
  visionConfig: VisionConfigData
  tavilyConfig: TavilyConfigData
  providers: AIProviderSettings[]
  endpoint: string
  model: string
  hasApiKey: boolean
  supportsVision?: boolean
  promptCacheMode?: 'off' | 'openai_auto'
  promptCacheRetention?: 'in_memory' | '24h'
}

export interface ModelOption {
  id: string
  label: string
  supportsVision?: boolean
}

export const CUSTOM_PROVIDER_TEMPLATE = {
  label: '自定义服务商',
  endpoint: '',
  defaultModel: '',
}
