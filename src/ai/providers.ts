export interface AIProviderSettings {
  id: string
  label: string
  endpoint: string
  defaultModel: string
  hasApiKey: boolean
  isPreset: boolean
}

export interface AISettingsData {
  activeProviderId: string
  providers: AIProviderSettings[]
  endpoint: string
  model: string
  hasApiKey: boolean
}

export interface ModelOption {
  id: string
  label: string
}

export const CUSTOM_PROVIDER_TEMPLATE = {
  label: '自定义服务商',
  endpoint: '',
  defaultModel: '',
}
