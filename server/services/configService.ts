import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.join(__dirname, '../config/ai.json')

export interface AIConfig {
  endpoint: string
  apiKey: string
  model: string
  provider: 'openai' | 'anthropic' | 'custom'
}

const DEFAULT_CONFIG: AIConfig = {
  endpoint: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o',
  provider: 'openai',
}

export function readConfig(): AIConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function writeConfig(partial: Partial<AIConfig>): AIConfig {
  const current = readConfig()
  const next: AIConfig = { ...current, ...partial }
  // Auto-detect provider from endpoint
  if (partial.endpoint) {
    if (partial.endpoint.includes('anthropic.com')) next.provider = 'anthropic'
    else if (
      partial.endpoint.includes('openai.com') ||
      partial.endpoint.includes('localhost') ||
      partial.endpoint.includes('127.0.0.1')
    ) next.provider = 'openai'
    else next.provider = 'custom'
  }
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf-8')
  return next
}
