import type { TemplateAnalyzePayload } from './types'

function normalizeTemplateName(name: string) {
  return name.replace(/\.docx$/i, '').trim()
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  let binary = ''
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const slice = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}

async function extractRawText(file: File) {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })
  return result.value.replace(/\r\n/g, '\n').trim()
}

export async function buildTemplateAnalysisPayload(
  file: File,
  options?: { providerId?: string | null, model?: string | null },
): Promise<TemplateAnalyzePayload> {
  const [rawText, buffer] = await Promise.all([
    extractRawText(file),
    file.arrayBuffer(),
  ])

  return {
    name: normalizeTemplateName(file.name),
    sourceFilename: file.name,
    sourceContentBase64: arrayBufferToBase64(buffer),
    rawText,
    providerId: options?.providerId ?? undefined,
    model: options?.model ?? undefined,
  }
}
