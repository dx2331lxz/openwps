export type ImageProcessingMode = 'direct_multimodal' | 'ocr_text'

export interface OcrConfigData {
  enabled: boolean
  providerId: string
  endpoint: string
  model: string
  hasApiKey: boolean
  timeoutSeconds: number
  maxImages: number
}

export interface AIProviderSettings {
  id: string
  label: string
  endpoint: string
  defaultModel: string
  hasApiKey: boolean
  isPreset: boolean
  supportsVision?: boolean
}

export interface AISettingsData {
  activeProviderId: string
  imageProcessingMode: ImageProcessingMode
  ocrConfig: OcrConfigData
  providers: AIProviderSettings[]
  endpoint: string
  model: string
  hasApiKey: boolean
  supportsVision?: boolean
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
