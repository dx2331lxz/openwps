export interface TemplateSummary {
  id: string
  name: string
  note: string
  summary: string
  createdAt: string
  updatedAt: string
  sourceFilename: string
  sourceSize: number
}

export interface TemplateRecord extends TemplateSummary {
  templateText: string
}

export interface TemplateAnalyzePayload {
  name: string
  sourceFilename: string
  sourceContentBase64: string
  rawText: string
  providerId?: string
  model?: string
}

export interface TemplateAnalyzeResult {
  summary: string
  templateText: string
}

export interface TemplateCreatePayload {
  name: string
  note?: string
  summary: string
  sourceFilename: string
  sourceContentBase64: string
  templateText: string
}
