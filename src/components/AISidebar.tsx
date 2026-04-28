import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ClipboardEvent as ReactClipboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { EditorView } from 'prosemirror-view'
import type { EditorState } from 'prosemirror-state'
import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { marked } from 'marked'
import type { Tokens } from 'marked'
import mermaid from 'mermaid'
import { prepareWithSegments, layout, walkLineRanges } from '@chenglou/pretext'
import type { PreparedTextWithSegments } from '@chenglou/pretext'
import type { ExecuteResult } from '../ai/executor'
import { agentTools } from '../ai/tools'
import { schema } from '../editor/schema'
import type { TemplateRecord, TemplateSummary } from '../templates/types'
import type {
  AIProviderSettings,
  AISettingsData,
  ModelOption,
  OcrConfigData,
  VisionConfigData,
} from '../ai/providers'
import { paginate, type PageConfig } from '../layout/paginator'
import ModelPicker from './ModelPicker'

type View = 'history' | 'chat'
type AssistantMode = 'agent' | 'layout' | 'edit'
const ACTIVE_CONVERSATION_STORAGE_KEY = 'openwps:ai-active-conversation'

function createDocumentClientId() {
  const randomId = globalThis.crypto?.randomUUID?.()
  return `client_${randomId ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`
}

interface ConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  runStatus?: ReactRunSummary['status'] | null
  activeRunSessionId?: string | null
}

interface ConversationGroup {
  key: string
  label: string
  conversations: ConversationSummary[]
}

type AgentTraceStatus = 'running' | 'completed' | 'failed' | 'cancelled'
type AgentTraceRunMode = 'sync' | 'background'
type AgentTraceEventType = 'round_start' | 'thinking' | 'content' | 'tool_call' | 'tool_result' | 'done' | 'error'

interface AgentTraceEvent {
  id: string
  type: AgentTraceEventType
  round?: number
  phase?: string
  toolCallId?: string
  toolName?: string
  summary?: string
  params?: Record<string, unknown>
  status?: ToolCallResult['status']
  message?: string
  dataPreview?: string
  content?: string
  isExpanded?: boolean
}

interface AgentTrace {
  id: string
  agentType: string
  description: string
  runMode: AgentTraceRunMode
  model?: string
  status: AgentTraceStatus
  tools: string[]
  events: AgentTraceEvent[]
  result?: string
  error?: string
  isExpanded?: boolean
}

interface StoredMessage {
  role: 'user' | 'assistant' | 'tool'
  content?: string | null
  attachments?: ChatAttachment[]
  thinking?: string
  toolCalls?: ToolCallResult[]
  tool_calls?: Array<{ id?: string; type?: 'function'; function?: { name?: string; arguments?: string } }>
  tool_call_id?: string
  agentTraces?: AgentTrace[]
}

interface ConversationDetail extends ConversationSummary {
  messages: StoredMessage[]
}

interface ReactRunSummary {
  sessionId: string
  conversationId?: string | null
  status: 'running' | 'completed' | 'failed'
  error?: string | null
  lastSeq?: number
}

interface ToolCallResult {
  id?: string
  name: string
  params: Record<string, unknown>
  originalParams?: Record<string, unknown>
  status: 'pending' | 'ok' | 'err'
  message?: string
  data?: unknown
  isExpanded?: boolean
}

type MessageSegment =
  | { id: string; type: 'content'; text: string }
  | { id: string; type: 'thinking'; text: string }
  | { id: string; type: 'tool'; toolCall: ToolCallResult }
  | { id: string; type: 'agent'; trace: AgentTrace }

type AttachmentKind = 'image' | 'text'

interface ChatAttachment {
  id: string
  name: string
  size: number
  type: string
  kind: AttachmentKind
  dataUrl?: string
  textContent?: string
  textFormat?: 'plain' | 'markdown' | 'docx'
}

interface Message {
  id: string
  role: 'user' | 'ai'
  text: string
  segments: MessageSegment[]
  thinking: string
  isThinkingExpanded: boolean
  toolCalls: ToolCallResult[]
  streaming: boolean
  activityLabel: string
  prepared?: PreparedTextWithSegments
  tightWidth: number
  selectionTag?: { text: string; paragraphIndex: number } | null
  attachments?: ChatAttachment[]
}

interface TaskItem {
  id: string
  subject: string
  description: string
  activeForm?: string
  owner?: string
  status: 'pending' | 'in_progress' | 'completed'
  blocks: string[]
  blockedBy: string[]
  metadata?: Record<string, unknown>
}

interface TaskListResponse {
  tasks: TaskItem[]
}

interface AgentRunItem {
  id: string
  agentType: string
  description: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  result?: string
  error?: string
  createdAt?: string
  updatedAt?: string
}

interface AgentRunsResponse {
  agents: AgentRunItem[]
}

type OcrTaskType = 'general_parse' | 'document_text' | 'table' | 'chart' | 'handwriting' | 'formula'

const TASK_PANEL_HIDE_DELAY_MS = 5000

interface OcrIntentMatch {
  taskType: OcrTaskType
  instruction: string
  source: 'slash' | 'intent'
}

type SlashCommandId =
  | 'template-layout'
  | 'template-manager'
  | 'ocr-general'
  | 'ocr-table'
  | 'ocr-chart'
  | 'ocr-handwriting'
  | 'ocr-formula'
  | 'ocr-document'
  | `template:${string}`

interface SlashCommandItem {
  id: SlashCommandId
  title: string
  detail: string
  keywords: string[]
  kind: 'action' | 'template'
  disabled?: boolean
}

interface OcrAnalysisResult {
  imageIndex: number
  name: string
  taskType: OcrTaskType
  summary: string
  plainText: string
  markdown: string
  tables?: Array<{ title?: string; markdown?: string; rowCount?: number; columnCount?: number }>
  charts?: Array<{ title?: string; summary?: string }>
  handwritingText?: string
  formulas?: Array<{ latex?: string; text?: string }>
  warnings?: string[]
}

interface OcrAnalysisResponse {
  taskType: OcrTaskType
  imageCount: number
  results: OcrAnalysisResult[]
}

// ─── Selection context ───────────────────────────────────────────────────────

interface TextRun {
  text: string
  startOffset: number
  endOffset: number
  marks: Record<string, unknown>
}

interface SelectionContext {
  from: number
  to: number
  selectedText: string
  paragraphIndex: number
  charOffset: number
  prefixText: string
  suffixText: string
  paragraphText: string
  paragraphAttrs: Record<string, unknown>
  textRuns: TextRun[]
}

function truncatePreviewText(text: string, maxLength = 120) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized
}

function serializeSelection(editorState: EditorState): SelectionContext | null {
  const { from, to } = editorState.selection
  if (from === to) return null

  const doc = editorState.doc
  let paraIndex = 0
  let targetParaIndex = -1
  let targetParaStart = -1
  let targetParaNode: ProseMirrorNode | null = null

  doc.forEach((node, pos) => {
    if (node.type.name !== 'paragraph') return
    const paraFrom = pos + 1
    const paraTo = pos + node.nodeSize - 1
    if (targetParaIndex === -1 && from >= paraFrom && from <= paraTo) {
      targetParaIndex = paraIndex
      targetParaStart = paraFrom
      targetParaNode = node
    }
    paraIndex += 1
  })

  const selectedText = doc.textBetween(from, to, '\n')

  if (!targetParaNode || targetParaStart === -1) {
    return {
      from, to, selectedText,
      paragraphIndex: -1, charOffset: 0,
      prefixText: '',
      suffixText: '',
      paragraphText: '',
      paragraphAttrs: {}, textRuns: [],
    }
  }

  const paraNode = targetParaNode as ProseMirrorNode
  const charOffset = from - targetParaStart
  const paragraphText = paraNode.textContent
  const paragraphAttrs = { ...(paraNode.attrs as Record<string, unknown>) }

  // Build textRuns for the selected range inside this paragraph
  const selStartInPara = charOffset
  const selEndInPara = Math.min(paraNode.textContent.length, to - targetParaStart)
  const prefixText = paragraphText.slice(Math.max(0, charOffset - 12), charOffset)
  const suffixText = paragraphText.slice(selEndInPara, Math.min(paragraphText.length, selEndInPara + 12))
  const textRuns: TextRun[] = []
  let runningOffset = 0

  paraNode.forEach((child: ProseMirrorNode) => {
    if (!child.isText) { runningOffset += child.nodeSize; return }
    const text = child.text ?? ''
    const runStart = runningOffset
    const runEnd = runningOffset + text.length
    runningOffset = runEnd

    if (runEnd <= selStartInPara || runStart >= selEndInPara) return

    const sliceStart = Math.max(runStart, selStartInPara)
    const sliceEnd = Math.min(runEnd, selEndInPara)
    const slicedText = text.slice(sliceStart - runStart, sliceEnd - runStart)

    const tm = child.marks.find((m: { type: { name: string } }) => m.type.name === 'textStyle')
    const marks: Record<string, unknown> = tm ? { ...(tm.attrs as Record<string, unknown>) } : {}

    textRuns.push({ text: slicedText, startOffset: sliceStart, endOffset: sliceEnd, marks })
  })

  return {
    from,
    to,
    selectedText,
    paragraphIndex: targetParaIndex,
    charOffset,
    prefixText,
    suffixText,
    paragraphText,
    paragraphAttrs,
    textRuns,
  }
}

function buildContextPreview(editorState: EditorState, pageConfig: PageConfig) {
  const paragraphPreviews: Array<{ index: number; text: string; charCount: number }> = []
  const blockParagraphIndexes: Array<number | null> = []
  let paragraphIndex = 0

  editorState.doc.forEach((node) => {
    if (node.type.name === 'paragraph') {
      paragraphPreviews.push({
        index: paragraphIndex,
        text: truncatePreviewText(node.textContent, 100),
        charCount: node.textContent.length,
      })
      blockParagraphIndexes.push(paragraphIndex)
      paragraphIndex += 1
      return
    }

    blockParagraphIndexes.push(null)
  })

  const pagination = paginate(editorState.doc, pageConfig)
  const totalPages = pagination.renderedPages.length
  const pageIndexes = totalPages <= 4 ? [...pagination.renderedPages.keys()] : [0, 1, totalPages - 1]
  const pages = pageIndexes.map(pageIndex => {
    const page = pagination.renderedPages[pageIndex]
    const paragraphIndexes = [...new Set(
      page.lines
        .map(line => blockParagraphIndexes[line.blockIndex] ?? null)
        .filter((value): value is number => typeof value === 'number')
    )]

    return {
      page: pageIndex + 1,
      paragraphRange: paragraphIndexes.length > 0
        ? { from: Math.min(...paragraphIndexes), to: Math.max(...paragraphIndexes) }
        : null,
      previewText: truncatePreviewText(page.lines.map(line => line.text).join(' '), 160),
    }
  })

  return {
    firstParagraphs: paragraphPreviews.slice(0, 4),
    lastParagraphs: paragraphPreviews.length > 4 ? paragraphPreviews.slice(-2) : [],
    pages,
    omittedPageCount: Math.max(0, totalPages - pages.length),
  }
}

interface Props {
  view: EditorView | null
  editorState?: EditorState | null
  pageConfig: PageConfig
  templates: TemplateSummary[]
  activeTemplate: TemplateRecord | null
  activeWorkspaceFile?: { workspaceId: string; filePath: string; fileType: string } | null
  onModelContextChange?: (next: { providerId: string | null, model: string | null }) => void
  onActivateTemplate: (templateId: string) => Promise<void> | void
  onOpenTemplateManager: () => void
  onPageConfigChange: (cfg: PageConfig) => void
  onApplyServerDocumentState?: (docJson: Record<string, unknown>, pageConfig: PageConfig) => void
  onWorkspaceFileActivated?: (file: { workspaceId: string; filePath: string; fileType: string }) => void
  onDocumentStyleMutation?: () => void
  onClose: () => void
}

const SIDEBAR_MIN = 360
const SIDEBAR_MAX = 760
const SIDEBAR_DEFAULT = 560
const FONT = '14px -apple-system, BlinkMacSystemFont, sans-serif'
const LINE_HEIGHT = 20
const PADDING_H = 12
const PADDING_V = 8
const BUBBLE_MAX_RATIO = 0.85
const TEXTAREA_MIN_HEIGHT = 72
const TEXTAREA_MAX_HEIGHT = 200
const MAX_ATTACHMENT_COUNT = 8
const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const TOOL_DESCRIPTIONS = Object.fromEntries(agentTools.map(tool => [tool.name, tool.description]))

let msgIdCounter = 0

function newId() {
  msgIdCounter += 1
  return `m${msgIdCounter}`
}

function findTightBubbleWidth(prepared: PreparedTextWithSegments, maxWidth: number): number {
  if (maxWidth <= 0) return 0
  const targetLineCount = layout(prepared, maxWidth, LINE_HEIGHT).lineCount

  let lo = 1
  let hi = Math.ceil(maxWidth)
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (layout(prepared, mid, LINE_HEIGHT).lineCount <= targetLineCount) hi = mid
    else lo = mid + 1
  }

  let maxLineWidth = 0
  walkLineRanges(prepared, lo, line => {
    if (line.width > maxLineWidth) maxLineWidth = line.width
  })
  return Math.ceil(maxLineWidth) + PADDING_H * 2
}

function bubbleContentMax(sidebarWidth: number): number {
  return Math.floor(sidebarWidth * BUBBLE_MAX_RATIO) - PADDING_H * 2
}

function truncateTitle(title: string, maxLength = 20) {
  return title.length > maxLength ? `${title.slice(0, maxLength)}...` : title
}

function formatConversationTime(value: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const targetDay = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

  if (targetDay.getTime() === today.getTime()) return `今天${time}`
  if (targetDay.getTime() === yesterday.getTime()) return `昨天${time}`
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function formatConversationMonth(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function getLocalDayIndex(date: Date) {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000)
}

function getConversationGroupLabel(value: string, now = new Date()) {
  if (!value) return '未知时间'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '未知时间'

  const diffDays = getLocalDayIndex(now) - getLocalDayIndex(date)

  if (diffDays < 0) return '未来'
  if (diffDays === 0) return '今天'
  if (diffDays === 1) return '昨天'

  // 互斥区间：7天内不含今天/昨天，三十天内不含前面的7天内。
  if (diffDays >= 2 && diffDays <= 7) return '7天内'
  if (diffDays >= 8 && diffDays <= 30) return '三十天内'

  return formatConversationMonth(date)
}

function groupConversationsByTime(conversations: ConversationSummary[], now = new Date()): ConversationGroup[] {
  const groups: ConversationGroup[] = []
  const groupByKey = new Map<string, ConversationGroup>()

  conversations.forEach(conversation => {
    const value = conversation.updatedAt || conversation.createdAt
    const label = getConversationGroupLabel(value, now)
    const key = label === '未知时间' ? 'unknown' : label
    let group = groupByKey.get(key)
    if (!group) {
      group = { key, label, conversations: [] }
      groupByKey.set(key, group)
      groups.push(group)
    }
    group.conversations.push(conversation)
  })

  return groups
}

function truncateText(value: string, maxLength = 48) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value
}

function finiteParamNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

function describeToolTarget(params: Record<string, unknown>) {
  const range = params.range
  if (range && typeof range === 'object' && !Array.isArray(range)) {
    const type = String((range as Record<string, unknown>).type ?? '')
    if (type === 'selection') return '当前选区'
    if (type === 'all') return '全文'
    if (type === 'paragraph') {
      const paragraphIndex = finiteParamNumber((range as Record<string, unknown>).paragraphIndex)
      if (paragraphIndex !== null) return `第 ${paragraphIndex + 1} 段`
    }
    if (type === 'paragraphs') {
      const from = finiteParamNumber((range as Record<string, unknown>).from)
      const to = finiteParamNumber((range as Record<string, unknown>).to)
      if (from !== null && to !== null) return `第 ${from + 1}-${to + 1} 段`
    }
  }

  const paragraphIndex = finiteParamNumber(params.paragraphIndex)
  const fromParagraph = finiteParamNumber(params.fromParagraph)
  const toParagraph = finiteParamNumber(params.toParagraph)
  const afterParagraph = finiteParamNumber(params.afterParagraph)
  const index = finiteParamNumber(params.index)
  const page = finiteParamNumber(params.page)
  if (fromParagraph !== null && toParagraph !== null) return `第 ${fromParagraph + 1}-${toParagraph + 1} 段`
  if (fromParagraph !== null) return `第 ${fromParagraph + 1} 段起`
  if (toParagraph !== null) return `截至第 ${toParagraph + 1} 段`
  if (paragraphIndex !== null) return `第 ${paragraphIndex + 1} 段`
  if (afterParagraph !== null) return `第 ${afterParagraph + 1} 段后`
  if (index !== null) return `第 ${index + 1} 段`
  if (page !== null) return `第 ${page} 页`
  return ''
}

function describeStreamingWriteTarget(params: Record<string, unknown>) {
  const action = String(params.action ?? '')
  if (action === 'insert_after_paragraph') {
    const afterParagraph = finiteParamNumber(params.afterParagraph)
    return afterParagraph !== null ? `第 ${afterParagraph + 1} 段后` : ''
  }
  if (action === 'replace_paragraph') {
    const paragraphIndex = finiteParamNumber(params.paragraphIndex)
    return paragraphIndex !== null ? `第 ${paragraphIndex + 1} 段` : ''
  }
  return describeToolTarget(params)
}

function summarizeToolPurpose(toolCall: ToolCallResult) {
  const textKeys = ['purpose', 'goal', 'reason', 'instruction', 'query', 'message', 'text']
  for (const key of textKeys) {
    const value = toolCall.params[key]
    if (typeof value === 'string' && value.trim()) return truncateText(value.trim())
  }

  const target = describeToolTarget(toolCall.params)
  const description = TOOL_DESCRIPTIONS[toolCall.name]

  if (toolCall.name === 'TaskCreate') return '创建 AI 内部任务'
  if (toolCall.name === 'TaskGet') return '读取 AI 内部任务详情'
  if (toolCall.name === 'TaskList') return '读取 AI 内部任务列表'
  if (toolCall.name === 'TaskUpdate') return '更新 AI 内部任务状态'
  if (toolCall.name === 'get_document_info') return '读取当前文档的统计信息'
  if (toolCall.name === 'get_document_outline') return '读取整篇文档的分页概览和样式概览'
  if (toolCall.name === 'get_document_content') return target ? `读取${target}的内容` : '读取全文内容，辅助后续判断'
  if (toolCall.name === 'get_page_content') return target ? `查看${target}的分页快照` : '查看指定页面的排版快照'
  if (toolCall.name === 'get_page_style_summary') return target ? `查看${target}的样式摘要` : '查看指定页面的样式摘要'
  if (toolCall.name === 'get_paragraph') return target ? `查看${target}的内容和样式` : '查看指定段落内容和样式'
  if (toolCall.name === 'search_text') return target ? `搜索${target}的精确文字位置` : '搜索文字并锁定匹配位置'
  if (toolCall.name === 'web_search') return '联网搜索最新网页、新闻或外部资料'
  if (toolCall.name === 'set_page_config') return '调整纸张大小、方向或页边距'
  if (toolCall.name === 'set_text_style') return target ? `修改${target}的文字样式` : '修改文字样式'
  if (toolCall.name === 'set_paragraph_style') return target ? `调整${target}的段落格式` : '调整段落格式'
  if (toolCall.name === 'clear_formatting') return target ? `清除${target}的排版格式` : '清除排版格式'
  if (toolCall.name === 'begin_streaming_write') {
    const streamingTarget = describeStreamingWriteTarget(toolCall.params)
    return streamingTarget ? `开始向${streamingTarget}流式写正文` : '开始流式写正文'
  }
  if (toolCall.name === 'insert_text') return target ? `向${target}补充文字` : '插入新的文字内容'
  if (toolCall.name === 'insert_paragraph_after') return target ? `在${target}后新增段落` : '插入一个新段落'
  if (toolCall.name === 'replace_paragraph_text') return target ? `整体改写${target}` : '整体替换段落内容'
  if (toolCall.name === 'replace_selection_text') return '替换当前选中的文本'
  if (toolCall.name === 'delete_selection_text') return '删除当前选中的文本'
  if (toolCall.name === 'delete_paragraph') return target ? `删除${target}` : '删除指定段落'
  if (toolCall.name === 'insert_page_break') return target ? `在${target}插入分页符` : '插入分页符'
  if (toolCall.name === 'insert_horizontal_rule') return target ? `在${target}插入分割线` : '插入分割线'
  if (toolCall.name === 'insert_table') return target ? `在${target}插入表格` : '插入表格'
  if (toolCall.name === 'delete_table') return '删除整个表格'
  if (toolCall.name === 'insert_table_row_before') return '在指定表格行上方插入一行'
  if (toolCall.name === 'insert_table_row_after') return '在指定表格行下方插入一行'
  if (toolCall.name === 'delete_table_row') return '删除指定表格行'
  if (toolCall.name === 'insert_table_column_before') return '在指定表格列左侧插入一列'
  if (toolCall.name === 'insert_table_column_after') return '在指定表格列右侧插入一列'
  if (toolCall.name === 'delete_table_column') return '删除指定表格列'
  if (toolCall.name === 'apply_style_batch') {
    const ruleCount = Array.isArray(toolCall.params.rules) ? toolCall.params.rules.length : 0
    return ruleCount > 0 ? `批量应用 ${ruleCount} 条样式规则` : '批量应用样式规则'
  }
  return description || '执行工具调用'
}

function formatToolParams(params: Record<string, unknown>) {
  try {
    return JSON.stringify(params, null, 2)
  } catch {
    return String(params)
  }
}

function sortTaskItems(tasks: TaskItem[]) {
  return [...tasks].sort((left, right) => {
    const leftNum = Number(left.id)
    const rightNum = Number(right.id)
    if (Number.isFinite(leftNum) && Number.isFinite(rightNum)) return leftNum - rightNum
    return left.id.localeCompare(right.id)
  })
}

function normalizeTaskItem(raw: unknown): TaskItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const status = String(value.status ?? 'pending')
  if (!['pending', 'in_progress', 'completed'].includes(status)) return null
  return {
    id: String(value.id ?? ''),
    subject: String(value.subject ?? ''),
    description: String(value.description ?? ''),
    activeForm: typeof value.activeForm === 'string' && value.activeForm.trim() ? value.activeForm : undefined,
    owner: typeof value.owner === 'string' && value.owner.trim() ? value.owner : undefined,
    status: status as TaskItem['status'],
    blocks: Array.isArray(value.blocks) ? value.blocks.map(item => String(item)).filter(Boolean) : [],
    blockedBy: Array.isArray(value.blockedBy) ? value.blockedBy.map(item => String(item)).filter(Boolean) : [],
    metadata: value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata)
      ? value.metadata as Record<string, unknown>
      : undefined,
  }
}

function normalizeAgentRunItem(raw: unknown): AgentRunItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const status = String(value.status ?? 'running')
  if (!['running', 'completed', 'failed', 'cancelled'].includes(status)) return null
  const id = String(value.id ?? '')
  const agentType = String(value.agentType ?? '')
  if (!id || !agentType) return null
  return {
    id,
    agentType,
    description: String(value.description ?? ''),
    status: status as AgentRunItem['status'],
    result: typeof value.result === 'string' ? value.result : undefined,
    error: typeof value.error === 'string' ? value.error : undefined,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : undefined,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : undefined,
  }
}

function buildTaskStats(tasks: TaskItem[]) {
  return {
    total: tasks.length,
    completed: tasks.filter(task => task.status === 'completed').length,
    pending: tasks.filter(task => task.status === 'pending').length,
    inProgress: tasks.filter(task => task.status === 'in_progress').length,
  }
}

function formatToolData(data: unknown) {
  try {
    return JSON.stringify(data, null, 2)
  } catch {
    return String(data)
  }
}

const AGENT_TRACE_TEXT_LIMIT = 900
const AGENT_TRACE_DATA_LIMIT = 700

function compactAgentTraceText(value: unknown, maxLength = AGENT_TRACE_TEXT_LIMIT) {
  const text = typeof value === 'string' ? value : formatToolData(value)
  const normalized = text.replace(/\s+/g, ' ').trim()
  return truncateText(normalized, maxLength)
}

function normalizeAgentTraceStatus(value: unknown): AgentTraceStatus {
  const status = String(value ?? 'running')
  return status === 'completed' || status === 'failed' || status === 'cancelled' ? status : 'running'
}

function normalizeAgentTraceRunMode(value: unknown): AgentTraceRunMode {
  return String(value ?? '') === 'background' ? 'background' : 'sync'
}

function normalizeAgentTraceEventType(value: unknown): AgentTraceEventType | null {
  const type = String(value ?? '')
  if (
    type === 'round_start' ||
    type === 'thinking' ||
    type === 'content' ||
    type === 'tool_call' ||
    type === 'tool_result' ||
    type === 'done' ||
    type === 'error'
  ) {
    return type
  }
  return null
}

function normalizeAgentTraceEvent(raw: unknown): AgentTraceEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const type = normalizeAgentTraceEventType(value.type)
  if (!type) return null
  const status = value.status === 'ok' || value.status === 'err' || value.status === 'pending'
    ? value.status
    : undefined
  return {
    id: String(value.id ?? newId()),
    type,
    round: Number.isFinite(Number(value.round)) ? Number(value.round) : undefined,
    phase: typeof value.phase === 'string' ? value.phase : undefined,
    toolCallId: typeof value.toolCallId === 'string' ? value.toolCallId : undefined,
    toolName: typeof value.toolName === 'string' ? value.toolName : undefined,
    summary: typeof value.summary === 'string' ? value.summary : undefined,
    params: normalizeToolParams(value.params),
    status,
    message: typeof value.message === 'string' ? value.message : undefined,
    dataPreview: typeof value.dataPreview === 'string' ? value.dataPreview : undefined,
    content: typeof value.content === 'string' ? value.content : undefined,
    isExpanded: Boolean(value.isExpanded),
  }
}

function shouldMergeAgentTraceTextEvent(left: AgentTraceEvent | undefined, right: AgentTraceEvent): left is AgentTraceEvent {
  return Boolean(
    left
    && right.content
    && (right.type === 'thinking' || right.type === 'content')
    && left.type === right.type
    && (left.phase ?? right.phase ?? '') === (right.phase ?? left.phase ?? ''),
  )
}

function mergeAgentTraceTextContent(left: string | undefined, right: string) {
  const previous = left ?? ''
  const needsSpace = previous.length > 0
    && right.length > 0
    && !/\s$/.test(previous)
    && !/^\s|^[,.;:!?，。；：！？、）\]}]/.test(right)
  return compactAgentTraceText(`${previous}${needsSpace ? ' ' : ''}${right}`, AGENT_TRACE_TEXT_LIMIT)
}

function coalesceAgentTraceEvents(events: AgentTraceEvent[]) {
  const result: AgentTraceEvent[] = []
  for (const event of events) {
    const lastEvent = result.at(-1)
    if (shouldMergeAgentTraceTextEvent(lastEvent, event)) {
      result[result.length - 1] = {
        ...lastEvent,
        content: mergeAgentTraceTextContent(lastEvent?.content, event.content ?? ''),
      }
      continue
    }
    result.push(event)
  }
  return result
}

function normalizeAgentTrace(raw: unknown): AgentTrace | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const id = String(value.id ?? '')
  if (!id) return null
  const events = Array.isArray(value.events)
    ? value.events.map(normalizeAgentTraceEvent).filter((event): event is AgentTraceEvent => event !== null)
    : []
  const tools = Array.isArray(value.tools)
    ? value.tools.map(item => String(item)).filter(Boolean)
    : []
  return {
    id,
    agentType: String(value.agentType ?? 'agent'),
    description: String(value.description ?? '子代理任务'),
    runMode: normalizeAgentTraceRunMode(value.runMode),
    model: typeof value.model === 'string' ? value.model : undefined,
    status: normalizeAgentTraceStatus(value.status),
    tools,
    events: coalesceAgentTraceEvents(events),
    result: typeof value.result === 'string' ? value.result : undefined,
    error: typeof value.error === 'string' ? value.error : undefined,
    isExpanded: value.isExpanded !== false,
  }
}

function compactAgentTraceForStorage(trace: AgentTrace): AgentTrace {
  const events = coalesceAgentTraceEvents(trace.events)
  return {
    id: trace.id,
    agentType: trace.agentType,
    description: compactAgentTraceText(trace.description, 180),
    runMode: trace.runMode,
    model: trace.model ? compactAgentTraceText(trace.model, 80) : undefined,
    status: trace.status,
    tools: trace.tools.slice(0, 30),
    events: events.map(event => ({
      id: event.id,
      type: event.type,
      round: event.round,
      phase: event.phase,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      summary: event.summary ? compactAgentTraceText(event.summary, 180) : undefined,
      params: event.params && Object.keys(event.params).length > 0 ? event.params : undefined,
      status: event.status,
      message: event.message ? compactAgentTraceText(event.message, 260) : undefined,
      dataPreview: event.dataPreview ? compactAgentTraceText(event.dataPreview, AGENT_TRACE_DATA_LIMIT) : undefined,
      content: event.content ? compactAgentTraceText(event.content, 360) : undefined,
      isExpanded: false,
    })),
    result: trace.result ? compactAgentTraceText(trace.result, 1200) : undefined,
    error: trace.error ? compactAgentTraceText(trace.error, 360) : undefined,
    isExpanded: trace.isExpanded !== false,
  }
}

function createAgentTraceFromEvent(event: Record<string, unknown>): AgentTrace {
  const agentId = String(event.agentId ?? newId())
  const tools = Array.isArray(event.tools)
    ? event.tools.map(item => String(item)).filter(Boolean)
    : []
  return {
    id: agentId,
    agentType: String(event.agentType ?? 'agent'),
    description: String(event.description ?? '子代理任务'),
    runMode: normalizeAgentTraceRunMode(event.runMode),
    model: typeof event.model === 'string' ? event.model : undefined,
    status: 'running',
    tools,
    events: [],
    isExpanded: true,
  }
}

function createFallbackAgentTrace(agentId: string, agentType = 'agent'): AgentTrace {
  return {
    id: agentId || newId(),
    agentType,
    description: '子代理任务',
    runMode: 'sync',
    status: 'running',
    tools: [],
    events: [],
    isExpanded: true,
  }
}

function upsertAgentTraceInList(
  traces: AgentTrace[],
  trace: AgentTrace,
  updater: (current: AgentTrace) => AgentTrace = current => current,
) {
  const nextTrace = updater(trace)
  const found = traces.some(current => current.id === nextTrace.id)
  if (!found) return [...traces, nextTrace]
  return traces.map(current => (current.id === nextTrace.id ? updater(current) : current))
}

function upsertAgentTraceInMessage(
  message: Message,
  trace: AgentTrace,
  updater: (current: AgentTrace) => AgentTrace = current => current,
): Message {
  let found = false
  const nextSegments = message.segments.map(segment => {
    if (segment.type !== 'agent' || segment.trace.id !== trace.id) return segment
    found = true
    return { ...segment, trace: updater(segment.trace) }
  })
  if (!found) nextSegments.push({ id: newId(), type: 'agent', trace: updater(trace) })
  return { ...message, segments: nextSegments }
}

function appendAgentTraceEvent(trace: AgentTrace, event: AgentTraceEvent): AgentTrace {
  const lastEvent = trace.events.at(-1)
  if (shouldMergeAgentTraceTextEvent(lastEvent, event)) {
    return {
      ...trace,
      events: [
        ...trace.events.slice(0, -1),
        {
          ...lastEvent,
          content: mergeAgentTraceTextContent(lastEvent?.content, event.content ?? ''),
        },
      ],
    }
  }
  return { ...trace, events: [...trace.events, event] }
}

function updateAgentTraceToolResult(trace: AgentTrace, toolCallId: string | undefined, toolName: string, result: Record<string, unknown>): AgentTrace {
  let matched = false
  const nextEvents = trace.events.map(event => {
    if (event.type !== 'tool_call' || matched) return event
    const sameId = Boolean(toolCallId && event.toolCallId === toolCallId)
    const samePendingName = !toolCallId && event.toolName === toolName && event.status === 'pending'
    if (!sameId && !samePendingName) return event
    matched = true
    return {
      ...event,
      type: 'tool_result' as const,
      status: result.success === true ? 'ok' as const : 'err' as const,
      message: typeof result.message === 'string' ? compactAgentTraceText(result.message, 260) : '',
      dataPreview: result.data != null ? compactAgentTraceText(result.data, AGENT_TRACE_DATA_LIMIT) : undefined,
      isExpanded: false,
    }
  })
  if (matched) return { ...trace, events: nextEvents }
  return appendAgentTraceEvent(trace, {
    id: newId(),
    type: 'tool_result',
    toolCallId,
    toolName,
    summary: toolName,
    status: result.success === true ? 'ok' : 'err',
    message: typeof result.message === 'string' ? compactAgentTraceText(result.message, 260) : '',
    dataPreview: result.data != null ? compactAgentTraceText(result.data, AGENT_TRACE_DATA_LIMIT) : undefined,
    isExpanded: false,
  })
}

function getAgentTraceStatusLabel(status: AgentTraceStatus) {
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'cancelled') return '已取消'
  return '运行中'
}

function getAgentTraceEventIcon(event: AgentTraceEvent) {
  if (event.type === 'tool_result') {
    return event.status === 'ok' ? '✓' : event.status === 'err' ? '×' : '…'
  }
  if (event.type === 'tool_call') return '⌕'
  if (event.type === 'round_start') return '•'
  if (event.type === 'done') return '✓'
  if (event.type === 'error') return '×'
  return '◦'
}

function getAgentTraceEventTitle(event: AgentTraceEvent) {
  if (event.type === 'round_start') return event.round ? `Round ${event.round}` : '开始新一轮'
  if (event.type === 'thinking') return 'Thinking'
  if (event.type === 'content') return 'Drafting'
  if (event.type === 'tool_call' || event.type === 'tool_result') {
    const toolName = event.toolName || 'tool'
    const lowerName = toolName.toLowerCase()
    if (lowerName.includes('search')) return `Search ${toolName}`
    if (lowerName.includes('read') || lowerName.includes('content') || lowerName.includes('paragraph')) return `Read ${toolName}`
    if (lowerName.includes('screenshot') || lowerName.includes('image')) return `Inspect ${toolName}`
    return toolName
  }
  if (event.type === 'done') return 'Done'
  return 'Error'
}

const AgentTraceBlock: React.FC<{
  trace: AgentTrace
  onToggleTrace: () => void
  onToggleEvent: (eventId: string) => void
}> = ({ trace, onToggleTrace, onToggleEvent }) => {
  const expanded = trace.isExpanded !== false
  const statusClass = trace.status === 'completed'
    ? 'text-emerald-600'
    : trace.status === 'failed'
      ? 'text-red-600'
      : trace.status === 'cancelled'
        ? 'text-slate-400'
        : 'text-blue-600'

  return (
    <div className="relative rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2 text-xs text-slate-600 before:absolute before:-left-4 before:top-3 before:h-2 before:w-2 before:rounded-full before:bg-slate-400">
      <button
        type="button"
        onClick={onToggleTrace}
        className="flex w-full items-start justify-between gap-3 text-left"
      >
        <span className="min-w-0">
          <span className="block font-semibold text-slate-700">
            {trace.agentType}: {trace.description}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-slate-400">
            {trace.runMode === 'background' ? '后台子代理' : '同步子代理'}
            {trace.model ? ` · ${trace.model}` : ''}
            {trace.tools.length > 0 ? ` · ${trace.tools.length} tools` : ''}
          </span>
        </span>
        <span className={`flex-shrink-0 text-[11px] ${statusClass}`}>
          {getAgentTraceStatusLabel(trace.status)} {expanded ? '▾' : '▸'}
        </span>
      </button>

      {expanded && (
        <div className="mt-2 space-y-2 border-l border-slate-200 pl-4">
          {coalesceAgentTraceEvents(trace.events).length === 0 && trace.status === 'running' && (
            <div className="relative text-[11px] text-slate-400 before:absolute before:-left-[21px] before:top-1.5 before:h-2 before:w-2 before:rounded-full before:bg-blue-300">
              等待子代理开始输出...
            </div>
          )}
          {coalesceAgentTraceEvents(trace.events).map(event => {
            const eventExpanded = event.isExpanded === true
            const canExpand = Boolean(event.params && Object.keys(event.params).length > 0) || Boolean(event.dataPreview) || Boolean(event.message)
            return (
              <div key={event.id} className="relative before:absolute before:-left-[21px] before:top-1.5 before:h-2 before:w-2 before:rounded-full before:bg-slate-300">
                <div className="flex items-start gap-2">
                  <span className={`mt-0.5 w-3 flex-shrink-0 text-center ${event.status === 'err' ? 'text-red-500' : event.status === 'ok' ? 'text-emerald-600' : 'text-slate-400'}`}>
                    {getAgentTraceEventIcon(event)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      disabled={!canExpand}
                      onClick={() => canExpand && onToggleEvent(event.id)}
                      className="w-full text-left disabled:cursor-default"
                    >
                      <span className="font-medium text-slate-600">{getAgentTraceEventTitle(event)}</span>
                      {event.summary && (
                        <>
                          <span className="mx-1 text-slate-300">·</span>
                          <span className="text-slate-500">{event.summary}</span>
                        </>
                      )}
                      {canExpand && (
                        <span className="ml-1 text-[10px] text-slate-400">{eventExpanded ? '▾' : '▸'}</span>
                      )}
                    </button>
                    {event.content && (
                      <div className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-5 text-slate-500">
                        {event.content}
                      </div>
                    )}
                    {eventExpanded && (
                      <div className="mt-1 space-y-1">
                        {event.params && Object.keys(event.params).length > 0 && (
                          <pre className="max-h-40 overflow-auto rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] leading-4 text-slate-500">
                            {formatToolParams(event.params)}
                          </pre>
                        )}
                        {event.message && (
                          <div className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] leading-4 text-slate-500">
                            {event.message}
                          </div>
                        )}
                        {event.dataPreview && (
                          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] leading-4 text-slate-500">
                            {event.dataPreview}
                          </pre>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
          {(trace.result || trace.error) && (
            <div className={`relative rounded-md border px-2 py-1 text-[11px] leading-5 before:absolute before:-left-[21px] before:top-2 before:h-2 before:w-2 before:rounded-full ${trace.error ? 'border-red-100 bg-red-50 text-red-600 before:bg-red-300' : 'border-emerald-100 bg-emerald-50 text-emerald-700 before:bg-emerald-300'}`}>
              <span className="font-medium">{trace.error ? 'Error' : 'Result'}: </span>
              <span className="whitespace-pre-wrap break-words">{trace.error || trace.result}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function createAttachmentId(file: File) {
  return `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function isImageAttachment(attachment: ChatAttachment): attachment is ChatAttachment & { kind: 'image'; dataUrl: string } {
  return attachment.kind === 'image' && typeof attachment.dataUrl === 'string' && attachment.dataUrl.length > 0
}

function isTextAttachment(attachment: ChatAttachment): attachment is ChatAttachment & { kind: 'text'; textContent: string } {
  return attachment.kind === 'text' && typeof attachment.textContent === 'string' && attachment.textContent.trim().length > 0
}

function normalizeAttachmentText(text: string) {
  return text.replace(/\r\n/g, '\n').trim()
}

function getAttachmentTextFormat(file: File): ChatAttachment['textFormat'] | null {
  const lowerName = file.name.toLowerCase()
  if (lowerName.endsWith('.md') || lowerName.endsWith('.markdown') || file.type === 'text/markdown') return 'markdown'
  if (lowerName.endsWith('.txt') || file.type.startsWith('text/')) return 'plain'
  if (lowerName.endsWith('.docx') || file.type === DOCX_MIME) return 'docx'
  return null
}

function getUnsupportedAttachmentReason(file: File): string | null {
  const lowerName = file.name.toLowerCase()
  if (lowerName.endsWith('.pdf') || file.type === 'application/pdf') {
    return '暂不支持直接发送 PDF 附件，请先转换为 TXT、Markdown 或 DOCX。'
  }
  return '当前仅支持图片、TXT、Markdown 和 DOCX 附件。'
}

async function extractTextAttachment(file: File): Promise<ChatAttachment> {
  const textFormat = getAttachmentTextFormat(file)
  if (!textFormat) {
    throw new Error(getUnsupportedAttachmentReason(file) || `暂不支持附件类型：${file.name}`)
  }

  let textContent = ''
  if (textFormat === 'docx') {
    const mammoth = await import('mammoth')
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })
    textContent = normalizeAttachmentText(result.value || '')
  } else {
    textContent = normalizeAttachmentText(await file.text())
  }

  if (!textContent) {
    throw new Error(`${file.name} 中未提取到可发送的文本内容`)
  }

  return {
    id: createAttachmentId(file),
    name: file.name,
    size: file.size,
    type: file.type,
    kind: 'text',
    textContent,
    textFormat,
  }
}

async function extractAttachment(file: File): Promise<ChatAttachment> {
  if (file.type.startsWith('image/')) {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result ?? ''))
      reader.onerror = () => reject(reader.error ?? new Error(`读取图片失败：${file.name}`))
      reader.readAsDataURL(file)
    })

    return {
      id: createAttachmentId(file),
      name: file.name,
      size: file.size,
      type: file.type,
      kind: 'image',
      dataUrl,
    }
  }

  return extractTextAttachment(file)
}

function getAttachmentBadge(attachment: ChatAttachment) {
  if (attachment.kind === 'image') return '图片'
  if (attachment.textFormat === 'markdown') return 'Markdown'
  if (attachment.textFormat === 'docx') return 'DOCX'
  return '文本'
}

function buildAttachmentContextBlock(attachments: ChatAttachment[]) {
  if (attachments.length === 0) return ''

  const parts = ['[附件内容]']
  let totalChars = 0
  const maxTotalChars = 16000
  attachments.forEach((attachment, index) => {
    const header = `附件 ${index + 1}: ${attachment.name} (${getAttachmentBadge(attachment)})`
    if (isImageAttachment(attachment)) {
      parts.push(`${header}\n该附件为图片，历史上下文仅保留附件名称。`)
      return
    }
    if (isTextAttachment(attachment)) {
      const label = attachment.textFormat === 'markdown' ? '原始 Markdown' : '提取文本'
      const remaining = maxTotalChars - totalChars
      if (remaining <= 0) return
      const clipped = attachment.textContent.slice(0, remaining)
      totalChars += clipped.length
      const suffix = clipped.length < attachment.textContent.length ? '\n[后续内容已截断]' : ''
      parts.push(`${header}\n${label}:\n${clipped}${suffix}`)
    }
  })
  return parts.join('\n\n')
}

function buildStoredUserContent(text: string, attachments: ChatAttachment[]) {
  const attachmentBlock = buildAttachmentContextBlock(attachments)
  if (!attachmentBlock) return text
  if (!text.trim()) return attachmentBlock
  return `${text}\n\n${attachmentBlock}`
}

function downloadJsonFile(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function extractSelectionContext(context: Record<string, unknown>) {
  const selection = context.selection
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return null
  const from = Number((selection as Record<string, unknown>).from)
  const to = Number((selection as Record<string, unknown>).to)
  const paragraphIndex = Number((selection as Record<string, unknown>).paragraphIndex)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null
  return {
    from,
    to,
    paragraphIndex: Number.isFinite(paragraphIndex) ? paragraphIndex : undefined,
    charOffset: Number((selection as Record<string, unknown>).charOffset ?? 0),
    selectedText: String((selection as Record<string, unknown>).selectedText ?? ''),
    prefixText: String((selection as Record<string, unknown>).prefixText ?? ''),
    suffixText: String((selection as Record<string, unknown>).suffixText ?? ''),
    paragraphText: String((selection as Record<string, unknown>).paragraphText ?? ''),
  }
}

function escapeHtmlText(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const safeMarkdownRenderer = new marked.Renderer()
safeMarkdownRenderer.html = ({ text }: Tokens.HTML | Tokens.Tag) => escapeHtmlText(text)

function toHtml(markdown: string) {
  const parsed = marked.parse(markdown, { renderer: safeMarkdownRenderer })
  return typeof parsed === 'string' ? parsed : markdown
}

// ─── Mermaid 初始化 ────────────────────────────────────────────────────────────
mermaid.initialize({ startOnLoad: false, theme: 'default' })

// ─── Mermaid 代码块组件 ────────────────────────────────────────────────────────
const MermaidBlock: React.FC<{
  code: string
  onInsertToEditor?: (svgDataUrl: string) => void
}> = ({ code, onInsertToEditor }) => {
  const [svgContent, setSvgContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [codeExpanded, setCodeExpanded] = useState(false)
  const mermaidId = `mermaid-${useId().replace(/:/g, '')}`

  useEffect(() => {
    let active = true
    const timer = window.setTimeout(() => {
      setSvgContent(null)
      setError(null)
      mermaid.render(mermaidId, code)
        .then(({ svg }) => {
          if (active) setSvgContent(svg)
        })
        .catch(err => {
          if (active) setError(String(err))
        })
    }, 0)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [code, mermaidId])

  const handleInsert = () => {
    if (!svgContent || !onInsertToEditor) return
    // SVG → base64 data URL（用 TextEncoder 替代已废弃的 unescape）
    const bytes = new TextEncoder().encode(svgContent)
    let binary = ''
    bytes.forEach(b => { binary += String.fromCharCode(b) })
    const b64 = btoa(binary)
    onInsertToEditor(`data:image/svg+xml;base64,${b64}`)
  }

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, overflow: 'hidden', margin: '4px 0' }}>
      {/* 代码折叠区 */}
      <div
        onClick={() => setCodeExpanded(v => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', background: '#f9fafb', fontSize: 12, color: '#6b7280', cursor: 'pointer', userSelect: 'none' }}
      >
        <span>{codeExpanded ? '▾' : '▸'}</span>
        <span style={{ fontFamily: 'monospace' }}>mermaid</span>
        <span style={{ marginLeft: 'auto', color: '#9ca3af' }}>代码</span>
      </div>
      {codeExpanded && (
        <pre style={{ margin: 0, padding: '8px 10px', fontSize: 12, background: '#f3f4f6', overflowX: 'auto', lineHeight: 1.5 }}>
          <code>{code}</code>
        </pre>
      )}
      {/* 预览区 */}
      <div style={{ padding: '8px 10px', background: 'white', textAlign: 'center' }}>
        {error
          ? <div style={{ color: '#dc2626', fontSize: 12 }}>渲染失败：{error}</div>
          : svgContent
            ? <div dangerouslySetInnerHTML={{ __html: svgContent }} style={{ display: 'inline-block', maxWidth: '100%' }} />
            : <div style={{ color: '#9ca3af', fontSize: 12, padding: '8px 0' }}>渲染中…</div>
        }
      </div>
      {/* 插入正文按钮 */}
      {svgContent && onInsertToEditor && (
        <div style={{ padding: '6px 10px', borderTop: '1px solid #e5e7eb', background: '#f9fafb' }}>
          <button
            onMouseDown={e => { e.preventDefault(); handleInsert() }}
            style={{ fontSize: 12, padding: '3px 10px', borderRadius: 4, border: '1px solid #d1d5db', background: 'white', cursor: 'pointer', color: '#374151' }}
          >
            📄 插入正文
          </button>
        </div>
      )}
    </div>
  )
}

// ─── AI markdown 智能渲染（识别 mermaid 块） ─────────────────────────────────
const MERMAID_BLOCK_RE = /^```mermaid\n([\s\S]*?)\n```/gm

function splitMermaidParts(markdown: string): Array<{ type: 'text'; content: string } | { type: 'mermaid'; code: string }> {
  const parts: Array<{ type: 'text'; content: string } | { type: 'mermaid'; code: string }> = []
  let lastIndex = 0
  MERMAID_BLOCK_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = MERMAID_BLOCK_RE.exec(markdown)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', content: markdown.slice(lastIndex, match.index) })
    }
    parts.push({ type: 'mermaid', code: match[1] })
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < markdown.length) {
    parts.push({ type: 'text', content: markdown.slice(lastIndex) })
  }
  return parts
}


function normalizeToolParams(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {}
}

function hasToolParams(params: Record<string, unknown> | undefined) {
  return Boolean(params && Object.keys(params).length > 0)
}

function getReplayToolParams(tool: Pick<ToolCallResult, 'params' | 'originalParams'>) {
  return hasToolParams(tool.originalParams) ? normalizeToolParams(tool.originalParams) : normalizeToolParams(tool.params)
}

function makeUserMessage(text: string, sidebarWidth: number, attachments: ChatAttachment[] = []): Message {
  const message: Message = {
    id: newId(),
    role: 'user',
    text,
    segments: [{ id: newId(), type: 'content', text }],
    thinking: '',
    isThinkingExpanded: false,
    toolCalls: [],
    streaming: false,
    activityLabel: '',
    tightWidth: 0,
    attachments,
  }

  try {
    const prepared = prepareWithSegments(text || ' ', FONT)
    message.prepared = prepared
    message.tightWidth = findTightBubbleWidth(prepared, bubbleContentMax(sidebarWidth))
  } catch {
    // Canvas may be unavailable briefly; CSS max-width is the fallback.
  }

  return message
}

function makeAiMessage(text = '', streaming = false): Message {
  const visibleText = stripToolResultJsonLeaks(text)
  return {
    id: newId(),
    role: 'ai',
    text: visibleText,
    segments: visibleText ? [{ id: newId(), type: 'content', text: visibleText }] : [],
    thinking: '',
    isThinkingExpanded: false,
    toolCalls: [],
    streaming,
    activityLabel: streaming ? '正在准备响应...' : '',
    tightWidth: 0,
  }
}

function appendThinkingChunk(message: Message, chunk: string): Message {
  const nextThinking = message.thinking + chunk
  const nextSegments = [...message.segments]
  const lastSegment = nextSegments.at(-1)

  if (lastSegment?.type === 'thinking') {
    nextSegments[nextSegments.length - 1] = { ...lastSegment, text: lastSegment.text + chunk }
  } else {
    nextSegments.push({ id: newId(), type: 'thinking', text: chunk })
  }

  return { ...message, thinking: nextThinking, segments: nextSegments }
}

function looksLikeToolResultJson(text: string) {
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    const payload = parsed as Record<string, unknown>
    const hasToolResultShape = typeof payload.success === 'boolean' && typeof payload.message === 'string'
    return hasToolResultShape && (
      'data' in payload ||
      'toolName' in payload ||
      'executedParams' in payload ||
      'originalParams' in payload ||
      'paramsRepaired' in payload
    )
  } catch {
    return /"success"\s*:\s*(true|false)/.test(text)
      && /"message"\s*:/.test(text)
      && /("data"|"toolName"|"executedParams"|"originalParams"|"paramsRepaired")\s*:/.test(text)
  }
}

function stripToolResultJsonLeaks(text: string) {
  let result = ''
  let cursor = 0

  while (cursor < text.length) {
    const start = text.indexOf('{', cursor)
    if (start === -1) {
      result += text.slice(cursor)
      break
    }

    result += text.slice(cursor, start)
    let depth = 0
    let inString = false
    let escaped = false
    let end = -1

    for (let index = start; index < text.length; index++) {
      const char = text[index]
      if (inString && escaped) {
        escaped = false
        continue
      }
      if (inString && char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') {
        inString = !inString
        continue
      }
      if (inString) continue
      if (char === '{') depth += 1
      if (char === '}') {
        depth -= 1
        if (depth === 0) {
          end = index + 1
          break
        }
      }
    }

    if (end === -1) {
      const tail = text.slice(start)
      if (looksLikeToolResultJson(tail)) break
      result += tail
      break
    }

    const candidate = text.slice(start, end)
    if (!looksLikeToolResultJson(candidate)) {
      result += candidate
    }
    cursor = end
  }

  return result.replace(/[ \t]+\n/g, '\n')
}

function buildContentSegments(message: Message, text: string): MessageSegment[] {
  const contentIndex = message.segments.findIndex(segment => segment.type === 'content')
  const nonContentSegments = message.segments.filter(segment => segment.type !== 'content')
  if (!text) return nonContentSegments

  const contentSegment: MessageSegment = { id: newId(), type: 'content', text }
  if (contentIndex === -1) return [...nonContentSegments, contentSegment]

  const insertIndex = Math.min(contentIndex, nonContentSegments.length)
  return [
    ...nonContentSegments.slice(0, insertIndex),
    contentSegment,
    ...nonContentSegments.slice(insertIndex),
  ]
}

function appendContentChunk(message: Message, chunk: string, replace = false): Message {
  const rawNextText = replace ? chunk : message.text + chunk
  const nextText = stripToolResultJsonLeaks(rawNextText)

  if (replace || nextText !== rawNextText || !nextText.startsWith(message.text)) {
    return { ...message, text: nextText, segments: buildContentSegments(message, nextText) }
  }

  const visibleChunk = nextText.slice(message.text.length)
  if (!visibleChunk) return { ...message, text: nextText }

  const nextSegments = [...message.segments]
  const lastSegment = nextSegments.at(-1)

  if (lastSegment?.type === 'content') {
    nextSegments[nextSegments.length - 1] = { ...lastSegment, text: lastSegment.text + visibleChunk }
  } else if (nextText) {
    nextSegments.push({ id: newId(), type: 'content', text: visibleChunk })
  }

  return { ...message, text: nextText, segments: nextSegments }
}

function appendToolSegment(message: Message, toolCall: ToolCallResult): Message {
  return {
    ...message,
    toolCalls: [...message.toolCalls, toolCall],
    segments: [...message.segments, { id: newId(), type: 'tool', toolCall }],
  }
}

function updateToolCallInMessage(
  message: Message,
  matcher: (toolCall: ToolCallResult, index: number, array: ToolCallResult[]) => boolean,
  updater: (toolCall: ToolCallResult) => ToolCallResult,
): Message {
  const nextToolCalls = message.toolCalls.map((toolCall, index, array) => (
    matcher(toolCall, index, array) ? updater(toolCall) : toolCall
  ))

  let toolIndex = -1
  const nextSegments = message.segments.map(segment => {
    if (segment.type !== 'tool') return segment
    toolIndex += 1
    const nextToolCall = nextToolCalls[toolIndex]
    return nextToolCall ? { ...segment, toolCall: nextToolCall } : segment
  })

  return { ...message, toolCalls: nextToolCalls, segments: nextSegments }
}

interface ToolCallRecord {
  id: string
  name: string
  params: Record<string, unknown>
  originalParams?: Record<string, unknown>
  result: ExecuteResult
}

type ReactMessagePayload =
  | { role: 'user' | 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string }

function normalizeReactToolCalls(
  toolCalls: StoredMessage['tool_calls'] | ToolCallResult[] | undefined,
): Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> | undefined {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined

  if ('params' in toolCalls[0]) {
    return (toolCalls as ToolCallResult[]).map(tool => ({
      id: tool.id ?? tool.name,
      type: 'function',
      function: {
        name: tool.name,
        arguments: JSON.stringify(getReplayToolParams(tool)),
      },
    }))
  }

  return (toolCalls as NonNullable<StoredMessage['tool_calls']>)
    .map(call => {
      const name = call.function?.name
      if (!call.id || !name) return null
      return {
        id: call.id,
        type: 'function' as const,
        function: {
          name,
          arguments: String(call.function?.arguments ?? '{}'),
        },
      }
    })
    .filter((call): call is { id: string; type: 'function'; function: { name: string; arguments: string } } => Boolean(call))
}

function serializeToolResultPayload({
  toolName,
  result,
  executedParams,
  originalParams,
  extra = {},
}: {
  toolName: string
  result: ExecuteResult
  executedParams: Record<string, unknown>
  originalParams?: Record<string, unknown>
  extra?: Record<string, unknown>
}) {
  const replayParams = hasToolParams(originalParams)
    ? normalizeToolParams(originalParams)
    : normalizeToolParams(executedParams)
  const payload: Record<string, unknown> = {
    ...extra,
    success: result.success,
    message: result.message,
    data: result.data ?? null,
    toolName,
    originalParams: hasToolParams(originalParams) ? originalParams : null,
    executedParams,
    paramsRepaired: stableStringify(replayParams) !== stableStringify(executedParams),
  }

  return JSON.stringify(payload)
}

function serializeToolResult(tool: ToolCallRecord) {
  return serializeToolResultPayload({
    toolName: tool.name,
    result: tool.result,
    executedParams: tool.params,
    originalParams: tool.originalParams,
  })
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

function repairToolArgsJson(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null

  const stack: string[] = []
  let inString = false
  let escaped = false

  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }

    if (char === '"') inString = true
    else if (char === '{') stack.push('}')
    else if (char === '[') stack.push(']')
    else if (char === '}' || char === ']') {
      if (stack.at(-1) !== char) return null
      stack.pop()
    }
  }

  let repaired = text
  if (inString) repaired += '"'
  if (escaped) repaired += '"'
  if (stack.length > 0) repaired += stack.slice().reverse().join('')
  repaired = repaired.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']')
  return repaired === text ? null : repaired
}

function parseToolArguments(rawArguments: unknown): Record<string, unknown> {
  if (rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)) {
    return normalizeToolParams(rawArguments)
  }
  if (typeof rawArguments !== 'string') return {}

  try {
    return normalizeToolParams(JSON.parse(rawArguments))
  } catch {
    const repaired = repairToolArgsJson(rawArguments)
    if (!repaired) return {}
    try {
      return normalizeToolParams(JSON.parse(repaired))
    } catch {
      return {}
    }
  }
}

function normalizeStoredToolCalls(message: StoredMessage): ToolCallResult[] {
  if (Array.isArray(message.toolCalls)) {
    return message.toolCalls.map(toolCall => ({
      id: toolCall.id,
      name: toolCall.name,
      params: normalizeToolParams(toolCall.params),
      originalParams: normalizeToolParams(toolCall.originalParams),
      status: toolCall.status,
      message: toolCall.message,
      data: toolCall.data,
      isExpanded: false,
    }))
  }

  if (Array.isArray(message.tool_calls)) {
    return message.tool_calls.map(call => {
      const params = parseToolArguments(call.function?.arguments)
      return {
        id: call.id,
        name: String(call.function?.name ?? ''),
        params,
        originalParams: params,
        status: 'pending' as const,
        isExpanded: false,
      }
    })
  }

  return []
}

function applyStoredToolResult(message: Message | undefined, stored: StoredMessage) {
  if (!message || message.role !== 'ai' || stored.role !== 'tool') return

  let parsed: { success?: boolean; message?: string; data?: unknown } | null = null
  if (typeof stored.content === 'string') {
    try {
      parsed = JSON.parse(stored.content) as { success?: boolean; message?: string }
    } catch {
      parsed = null
    }
  }

  const nextStatus = parsed?.success === false ? 'err' : 'ok'
  const nextMessage = parsed?.message ?? (typeof stored.content === 'string' ? stored.content : '')
  const targetId = stored.tool_call_id
  let matched = false

  const nextMessageState = updateToolCallInMessage(
    message,
    (toolCall, index, array) => {
      const shouldUse =
        (!matched && targetId && toolCall.id === targetId) ||
        (!matched && !targetId && index === array.length - 1)
      if (shouldUse) matched = true
      return shouldUse
    },
    toolCall => ({ ...toolCall, status: nextStatus, message: nextMessage, data: parsed?.data }),
  )

  message.toolCalls = nextMessageState.toolCalls
  message.segments = nextMessageState.segments
}

function fromStoredMessages(messages: StoredMessage[], sidebarWidth: number): Message[] {
  const restored: Message[] = []

  for (const stored of messages) {
    if (stored.role === 'user') {
      restored.push(makeUserMessage(stored.content ?? '', sidebarWidth, stored.attachments ?? []))
      continue
    }

    if (stored.role === 'assistant') {
      const aiMessage = makeAiMessage(stored.content ?? '', false)
      const agentTraces = Array.isArray(stored.agentTraces)
        ? stored.agentTraces.map(normalizeAgentTrace).filter((trace): trace is AgentTrace => trace !== null)
        : []
      aiMessage.thinking = stored.thinking ?? ''
      aiMessage.toolCalls = normalizeStoredToolCalls(stored)
      aiMessage.segments = [
        ...(stored.thinking ? [{ id: newId(), type: 'thinking' as const, text: stored.thinking }] : []),
        ...(stored.content ? [{ id: newId(), type: 'content' as const, text: stored.content }] : []),
        ...agentTraces.map(trace => ({ id: newId(), type: 'agent' as const, trace })),
        ...aiMessage.toolCalls.map(toolCall => ({ id: newId(), type: 'tool' as const, toolCall })),
      ]
      restored.push(aiMessage)
      continue
    }

    applyStoredToolResult(restored.at(-1), stored)
  }

  return restored
}

function buildReactMessages(messages: StoredMessage[], userText: string): ReactMessagePayload[] {
  const history = messages
    .map(message => {
      if (message.role === 'tool') {
        return {
          role: 'tool' as const,
          tool_call_id: String(message.tool_call_id ?? ''),
          content: typeof message.content === 'string' ? message.content : '',
        }
      }

      if (message.role === 'assistant') {
        return {
          role: 'assistant' as const,
          content: typeof message.content === 'string' ? message.content : null,
          tool_calls: normalizeReactToolCalls(message.toolCalls ?? message.tool_calls),
        }
      }

      return {
        role: 'user' as const,
        content: buildStoredUserContent(
          typeof message.content === 'string' ? message.content : '',
          message.attachments ?? [],
        ),
      }
    })
    .slice(-40)

  return [...history, { role: 'user', content: userText }]
}

function buildErrorText(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)

  if (
    message.includes('Cloudflare') ||
    message.includes('人机验证') ||
    message.includes('挑战页') ||
    message.includes('返回了 HTML 页面')
  ) {
    return `❌ 上游模型服务不可用：${message}\n\n后端已经响应，但当前模型服务端点没有返回标准 API 响应。请在 AI 设置中切换到可直连的服务商/端点，或更换当前 API 网关。`
  }

  if (message.includes('未接受图片输入') || message.includes('不兼容 image_url 图片格式')) {
    return `❌ 当前模型未接受图片输入：${message}\n\n你可以切换到明确支持视觉的模型，或改用 OCR 路径。`
  }

  if (message.includes('OCR API Key 未配置') || message.includes('OCR 端点未配置') || message.includes('OCR 模型未配置')) {
    return `❌ OCR 配置不完整：${message}\n\n请在设置中检查 OCR 端点、模型 ID 和 API Key。`
  }

  if (message.includes('OCR 模型请求失败')) {
    return `❌ OCR 接口调用失败：${message}\n\n请检查 OCR 服务端点、API Key、模型 ID，以及当前服务是否可达。`
  }

  if (message.includes('OCR 结果解析失败')) {
    return `❌ OCR 已返回响应，但结果格式不可解析：${message}\n\n这通常表示 OCR 模型返回了非预期格式，或输出被截断。建议先换一张更清晰的图片，或检查当前 OCR 模型是否支持该接口格式。`
  }

  if (message.includes('AI API 请求失败') || message.includes('AI 请求失败')) {
    return `❌ AI 服务请求失败：${message}\n\n后端服务已返回错误，但上游模型服务调用失败。请检查当前 AI 设置中的服务商、端点、模型和 API Key。`
  }

  return `❌ 请求失败：${message}\n\n请确认后端服务已启动（端口 5174）并已配置 API Key。`
}

function makeConversationTitle(text: string) {
  return text.trim().slice(0, 30) || '新会话'
}

function createDefaultOcrConfig(): OcrConfigData {
  return {
    enabled: true,
    backend: 'compat_chat',
    providerId: 'siliconflow',
    endpoint: 'https://api.siliconflow.cn/v1',
    model: 'PaddlePaddle/PaddleOCR-VL-1.5',
    hasApiKey: false,
    timeoutSeconds: 60,
    maxImages: 5,
  }
}

function createDefaultVisionConfig(): VisionConfigData {
  return {
    enabled: false,
    providerId: 'openai',
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    hasApiKey: false,
    timeoutSeconds: 30,
  }
}

function normalizeOcrTaskType(value: string | undefined): OcrTaskType {
  const normalized = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_')
  if (normalized === 'table' || normalized === 'tables') return 'table'
  if (normalized === 'chart' || normalized === 'charts' || normalized === 'graph') return 'chart'
  if (normalized === 'handwriting' || normalized === 'handwritten' || normalized === 'handwrite') return 'handwriting'
  if (normalized === 'formula' || normalized === 'math') return 'formula'
  if (normalized === 'document_text' || normalized === 'document' || normalized === 'text' || normalized === 'doc') return 'document_text'
  return 'general_parse'
}

function parseOcrCommand(text: string): OcrIntentMatch | null {
  const match = text.match(/^\/ocr(?:\s+([a-zA-Z_-]+))?(?:\s+([\s\S]+))?$/i)
  if (!match) return null
  return {
    taskType: normalizeOcrTaskType(match[1]),
    instruction: String(match[2] || '').trim(),
    source: 'slash',
  }
}

function detectOcrIntent(text: string): OcrIntentMatch | null {
  const normalized = text.trim()
  if (!normalized) return null
  if (!/(识别|提取|解析|读取|ocr)/i.test(normalized)) return null

  let taskType: OcrTaskType = 'general_parse'
  if (/(表格|表单|table)/i.test(normalized)) taskType = 'table'
  else if (/(图表|柱状图|折线图|饼图|chart|graph)/i.test(normalized)) taskType = 'chart'
  else if (/(手写|手写字|笔迹|handwriting|handwritten)/i.test(normalized)) taskType = 'handwriting'
  else if (/(公式|数学|latex|equation)/i.test(normalized)) taskType = 'formula'
  else if (/(扫描件|文档文字|正文|段落|document|text)/i.test(normalized)) taskType = 'document_text'

  return {
    taskType,
    instruction: normalized,
    source: 'intent',
  }
}

function compactOcrDisplayText(text: string, maxLines = 24, maxChars = 1200): string {
  const lines = text.split(/\r?\n/)
  let compact = lines.slice(0, maxLines).join('\n').trim()
  let truncated = lines.length > maxLines

  if (compact.length > maxChars) {
    compact = `${compact.slice(0, maxChars).trimEnd()}…`
    truncated = true
  }

  if (truncated) compact = `${compact}\n[内容已截断]`
  return compact
}

function formatOcrResponseForChat(response: OcrAnalysisResponse): string {
  const parts: string[] = []
  parts.push(`已完成 OCR 识别，共处理 ${response.imageCount} 张图片，任务类型：${response.taskType}。`)

  response.results.forEach(result => {
    parts.push('')
    parts.push(`图片 ${result.imageIndex}：${result.name}`)
    if (result.summary) parts.push(`摘要：${result.summary}`)
    if (result.handwritingText) parts.push(`手写识别：\n${compactOcrDisplayText(result.handwritingText)}`)
    if (result.markdown) parts.push(`Markdown：\n${compactOcrDisplayText(result.markdown)}`)
    else if (result.plainText) parts.push(`文本：\n${compactOcrDisplayText(result.plainText)}`)
    if (Array.isArray(result.tables) && result.tables.length > 0) {
      parts.push(`表格数：${result.tables.length}`)
      result.tables.forEach((table, index) => {
        const title = table.title ? `表格 ${index + 1}：${table.title}` : `表格 ${index + 1}`
        parts.push(title)
        if (table.markdown) parts.push(compactOcrDisplayText(table.markdown, 32, 1600))
      })
    }
    if (Array.isArray(result.charts) && result.charts.length > 0) {
      parts.push(`图表数：${result.charts.length}`)
      result.charts.forEach((chart, index) => {
        const title = chart.title ? `图表 ${index + 1}：${chart.title}` : `图表 ${index + 1}`
        parts.push(chart.summary ? `${title}\n${chart.summary}` : title)
      })
    }
    if (Array.isArray(result.formulas) && result.formulas.length > 0) {
      parts.push(`公式：${result.formulas.map(item => item.latex || item.text).filter(Boolean).join('；')}`)
    }
    if (Array.isArray(result.warnings) && result.warnings.length > 0) {
      parts.push(`提示：${result.warnings.join('；')}`)
    }
  })

  return parts.join('\n')
}

function extractClipboardImageFiles(event: ReactClipboardEvent<HTMLTextAreaElement>): File[] {
  const items = Array.from(event.clipboardData?.items || [])
  return items
    .filter(item => item.type.startsWith('image/'))
    .map(item => item.getAsFile())
    .filter((file): file is File => file !== null)
}

function normalizeTemplateName(value: string) {
  return value.trim().toLowerCase().replace(/\.docx$/i, '')
}

function resolveTemplateFromMessage(message: string, templates: TemplateSummary[]) {
  const normalizedMessage = normalizeTemplateName(message)
  if (!normalizedMessage) return { match: null as TemplateSummary | null, ambiguous: [] as TemplateSummary[] }

  const exact = templates.filter((template) => normalizeTemplateName(template.name) === normalizedMessage)
  if (exact.length === 1) return { match: exact[0]!, ambiguous: [] }
  if (exact.length > 1) return { match: null, ambiguous: exact }

  const includes = templates.filter((template) => normalizedMessage.includes(normalizeTemplateName(template.name)))
  if (includes.length === 1) return { match: includes[0]!, ambiguous: [] }
  if (includes.length > 1) return { match: null, ambiguous: includes }

  return { match: null, ambiguous: [] }
}

export default function AISidebar({
  view: editorView,
  editorState,
  pageConfig,
  templates,
  activeTemplate,
  activeWorkspaceFile,
  onModelContextChange,
  onActivateTemplate,
  onOpenTemplateManager,
  onPageConfigChange,
  onApplyServerDocumentState,
  onWorkspaceFileActivated,
  onDocumentStyleMutation,
  onClose,
}: Props) {
  const [viewMode, setViewMode] = useState<View>('history')
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT)
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [openingConversationId, setOpeningConversationId] = useState<string | null>(null)
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null)
  const [currentConversationTitle, setCurrentConversationTitle] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [assistantMode, setAssistantMode] = useState<AssistantMode>('agent')
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [isTaskPanelExpanded, setIsTaskPanelExpanded] = useState(false)
  const [agentRuns, setAgentRuns] = useState<AgentRunItem[]>([])
  const [isAgentPanelExpanded, setIsAgentPanelExpanded] = useState(false)
  const [includeSelection, setIncludeSelection] = useState(true)
  const documentSessionRef = useRef<{ id: string; version: number } | null>(null)
  const documentClientIdRef = useRef(createDocumentClientId())
  const [documentSessionInfo, setDocumentSessionInfo] = useState<{ id: string; version: number } | null>(null)
  const [providers, setProviders] = useState<AIProviderSettings[]>([])
  const [modelName, setModelName] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [activeProviderId, setActiveProviderId] = useState('')
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([])
  const [ocrConfig, setOcrConfig] = useState<OcrConfigData>(createDefaultOcrConfig())
  const [visionConfig, setVisionConfig] = useState<VisionConfigData>(createDefaultVisionConfig())
  const [slashCommandIndex, setSlashCommandIndex] = useState(0)
  const [selectedTemplateId, setSelectedTemplateId] = useState(activeTemplate?.id ?? '')

  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const activeRunSessionIdRef = useRef<string | null>(null)
  const autoRestoreAttemptedRef = useRef(false)
  const conversationNavigationSeqRef = useRef(0)
  const isDragging = useRef(false)
  const isComposingRef = useRef(false)
  const shouldAutoScrollRef = useRef(true)
  const currentConversationIdRef = useRef<string | null>(null)
  const conversationMessagesRef = useRef<StoredMessage[]>([])
  const tasksRef = useRef<TaskItem[]>([])
  const taskHideTimerRef = useRef<number | null>(null)

  const activeProvider = useMemo(
    () => providers.find(provider => provider.id === activeProviderId) ?? null,
    [providers, activeProviderId],
  )
  const activeOcrProvider = useMemo(
    () => providers.find(provider => provider.id === ocrConfig.providerId) ?? null,
    [ocrConfig.providerId, providers],
  )
  const activeVisionProvider = useMemo(
    () => providers.find(provider => provider.id === visionConfig.providerId) ?? null,
    [providers, visionConfig.providerId],
  )
  const activeProviderSupportsVision = Boolean(activeProvider?.supportsVision)
  const currentModelId = selectedModel || modelName
  const currentModelSupportsVision = useMemo(() => {
    const matched = availableModels.find(model => model.id === currentModelId)
    return matched?.supportsVision ?? activeProviderSupportsVision
  }, [activeProviderSupportsVision, availableModels, currentModelId])
  const effectiveOcrEndpoint = ocrConfig.endpoint || activeOcrProvider?.endpoint || ''
  const effectiveOcrHasApiKey = ocrConfig.hasApiKey || Boolean(activeOcrProvider?.hasApiKey)
  const ocrBackendRequiresModel = ocrConfig.backend === 'compat_chat'
  const isOcrReady = Boolean(
    ocrConfig.enabled
    && (!ocrBackendRequiresModel || ocrConfig.model.trim())
    && effectiveOcrEndpoint
    && effectiveOcrHasApiKey,
  )
  const canSendMessage = Boolean(input.trim() || pendingAttachments.length > 0)
  const selectedTemplate = useMemo(
    () => templates.find(template => template.id === selectedTemplateId) ?? activeTemplate ?? null,
    [activeTemplate, selectedTemplateId, templates],
  )

  useEffect(() => {
    currentConversationIdRef.current = currentConversationId
    if (currentConversationId) {
      window.localStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, currentConversationId)
    }
  }, [currentConversationId])

  useEffect(() => {
    tasksRef.current = tasks
  }, [tasks])

  useEffect(() => {
    setSelectedTemplateId(activeTemplate?.id ?? '')
  }, [activeTemplate?.id])

  useEffect(() => () => {
    if (taskHideTimerRef.current != null) {
      window.clearTimeout(taskHideTimerRef.current)
      taskHideTimerRef.current = null
    }
  }, [activeWorkspaceFile?.filePath, activeWorkspaceFile?.fileType, activeWorkspaceFile?.workspaceId])

  const clearTaskHideTimer = useCallback(() => {
    if (taskHideTimerRef.current != null) {
      window.clearTimeout(taskHideTimerRef.current)
      taskHideTimerRef.current = null
    }
  }, [activeWorkspaceFile?.filePath, activeWorkspaceFile?.fileType, activeWorkspaceFile?.workspaceId])

  const applyTaskState = useCallback((nextTasks: TaskItem[], options?: { preserveExpanded?: boolean }) => {
    const normalizedTasks = sortTaskItems(nextTasks)
    clearTaskHideTimer()
    setTasks(normalizedTasks)
    tasksRef.current = normalizedTasks

    if (normalizedTasks.length === 0) {
      setIsTaskPanelExpanded(false)
      return
    }

    const hasIncomplete = normalizedTasks.some(task => task.status !== 'completed')
    if (hasIncomplete) {
      setIsTaskPanelExpanded(prev => options?.preserveExpanded === true ? prev : (prev || normalizedTasks.length > 0))
      return
    }

    setIsTaskPanelExpanded(prev => options?.preserveExpanded === true ? prev : (prev || normalizedTasks.length > 0))
    const scheduledConversationId = currentConversationIdRef.current
    if (!scheduledConversationId) return

    taskHideTimerRef.current = window.setTimeout(async () => {
      if (currentConversationIdRef.current !== scheduledConversationId) return
      try {
        const response = await fetch(`/api/conversations/${scheduledConversationId}/tasks/reset-completed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        if (currentConversationIdRef.current !== scheduledConversationId) return
        setTasks([])
        tasksRef.current = []
        setIsTaskPanelExpanded(false)
      } catch (error) {
        console.error('[AISidebar] reset completed tasks failed', error)
      } finally {
        if (taskHideTimerRef.current != null) {
          window.clearTimeout(taskHideTimerRef.current)
          taskHideTimerRef.current = null
        }
      }
    }, TASK_PANEL_HIDE_DELAY_MS)
  }, [clearTaskHideTimer])

  const fetchTasksForConversation = useCallback(async (conversationId: string, options?: { preserveExpanded?: boolean }) => {
    const response = await fetch(`/api/conversations/${conversationId}/tasks`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json() as Partial<TaskListResponse>
    const nextTasks = Array.isArray(payload.tasks)
      ? payload.tasks.map(normalizeTaskItem).filter((task): task is TaskItem => task !== null)
      : []
    applyTaskState(nextTasks, options)
    return nextTasks
  }, [applyTaskState])

  const applyTaskToolResultData = useCallback((data: unknown, options?: { preserveExpanded?: boolean }) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return
    const value = data as Record<string, unknown>
    if (Array.isArray(value.tasks)) {
      const nextTasks = value.tasks.map(normalizeTaskItem).filter((task): task is TaskItem => task !== null)
      applyTaskState(nextTasks, options)
      return
    }

    const task = normalizeTaskItem(value.task)
    if (!task) return
    const mergedById = new Map(tasksRef.current.map(item => [item.id, item]))
    mergedById.set(task.id, task)
    applyTaskState([...mergedById.values()], options)
  }, [applyTaskState])

  const fetchAgentRunsForConversation = useCallback(async (conversationId: string) => {
    const response = await fetch(`/api/conversations/${conversationId}/agents`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json() as Partial<AgentRunsResponse>
    const nextAgentRuns = Array.isArray(payload.agents)
      ? payload.agents.map(normalizeAgentRunItem).filter((agentRun): agentRun is AgentRunItem => agentRun !== null)
      : []
    setAgentRuns(nextAgentRuns)
    setIsAgentPanelExpanded(prev => prev || nextAgentRuns.some(agentRun => agentRun.status === 'running'))
    return nextAgentRuns
  }, [])

  useEffect(() => {
    if (!currentConversationId) {
      applyTaskState([])
      setAgentRuns([])
      setIsAgentPanelExpanded(false)
      return
    }
    void fetchTasksForConversation(currentConversationId, { preserveExpanded: true }).catch(error => {
      console.error('[AISidebar] load conversation tasks failed', error)
      if (currentConversationIdRef.current === currentConversationId) {
        applyTaskState([])
      }
    })
    void fetchAgentRunsForConversation(currentConversationId).catch(error => {
      console.error('[AISidebar] load conversation agents failed', error)
      if (currentConversationIdRef.current === currentConversationId) {
        setAgentRuns([])
        setIsAgentPanelExpanded(false)
      }
    })
  }, [applyTaskState, currentConversationId, fetchAgentRunsForConversation, fetchTasksForConversation])

  useEffect(() => {
    if (!currentConversationId || !agentRuns.some(agentRun => agentRun.status === 'running')) return
    const timer = window.setInterval(() => {
      const conversationId = currentConversationIdRef.current
      if (!conversationId) return
      void fetchAgentRunsForConversation(conversationId).catch(error => {
        console.error('[AISidebar] refresh conversation agents failed', error)
      })
    }, 3000)
    return () => window.clearInterval(timer)
  }, [agentRuns, currentConversationId, fetchAgentRunsForConversation])

  const autoResize = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, TEXTAREA_MIN_HEIGHT), TEXTAREA_MAX_HEIGHT)}px`
  }, [])

  const scrollToBottomIfNeeded = useCallback(() => {
    const scrollArea = scrollAreaRef.current
    if (!scrollArea || !shouldAutoScrollRef.current) return
    scrollArea.scrollTop = scrollArea.scrollHeight
  }, [])

  const resetTextareaHeight = useCallback(() => {
    if (!textareaRef.current) return
    textareaRef.current.style.height = `${TEXTAREA_MIN_HEIGHT}px`
  }, [])

  const insertMermaidToEditor = useCallback((svgDataUrl: string) => {
    if (!editorView) return
    const { state, dispatch } = editorView
    const imageNode = schema.nodes.image.create({ src: svgDataUrl, alt: 'Mermaid 图表', width: null, height: null })
    const paragraphNode = schema.nodes.paragraph.create(undefined, imageNode)
    // 插入到文档最后一个顶级节点之后（doc.content.size 是文档末尾的关闭 token，
    // 正确插入位置是 doc.content.size，对于 top-level insert 是正确的）
    // ProseMirror: doc 节点 size = sum(child.nodeSize) + 2（开/关 token）
    // 正确方式：在最后一个 block 节点末尾后插入
    const lastChildEnd = state.doc.content.size
    const tr = state.tr.insert(lastChildEnd, paragraphNode)
    dispatch(tr)
    editorView.focus()
  }, [editorView])

  const getContext = useCallback(() => {
    if (!editorView) return {}
    let paragraphCount = 0
    let wordCount = 0
    editorView.state.doc.forEach((node) => {
      if (node.type.name === 'paragraph') {
        paragraphCount += 1
        wordCount += node.textContent.length
      }
    })
    const preview = buildContextPreview(editorView.state, pageConfig)
    const ctx: Record<string, unknown> = {
      paragraphCount,
      wordCount,
      pageCount: preview.pages.length + preview.omittedPageCount,
      preview,
      availableTemplates: templates.map((template) => ({
        id: template.id,
        name: template.name,
        summary: template.summary,
      })),
    }
    if (activeWorkspaceFile) {
      ctx.workspaceId = activeWorkspaceFile.workspaceId
      ctx.filePath = activeWorkspaceFile.filePath
      ctx.fileType = activeWorkspaceFile.fileType
    }
    if (activeTemplate) {
      ctx.activeTemplate = {
        id: activeTemplate.id,
        name: activeTemplate.name,
        note: activeTemplate.note,
        summary: activeTemplate.summary,
        templateText: activeTemplate.templateText,
      }
    }
    if (includeSelection && editorState) {
      const sel = serializeSelection(editorState)
      if (sel) ctx.selection = sel
    }
    return ctx
  }, [activeTemplate, activeWorkspaceFile, editorView, editorState, includeSelection, pageConfig, templates])

  const rememberDocumentSession = useCallback((next: { id: string; version: number } | null) => {
    documentSessionRef.current = next
    setDocumentSessionInfo(prev => {
      if (!next && !prev) return prev
      if (next && prev && prev.id === next.id && prev.version === next.version) return prev
      return next
    })
  }, [])

  const registerActiveDocumentSession = useCallback(async (sessionId: string) => {
    try {
      await fetch(`/api/doc-sessions/${sessionId}/active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: documentClientIdRef.current,
          workspaceId: activeWorkspaceFile?.workspaceId,
          filePath: activeWorkspaceFile?.filePath,
          fileType: activeWorkspaceFile?.fileType,
        }),
      })
    } catch (error) {
      console.warn('登记当前后端文档会话失败', error)
    }
  }, [activeWorkspaceFile?.filePath, activeWorkspaceFile?.fileType, activeWorkspaceFile?.workspaceId])

  const syncDocumentSession = useCallback(async (contextSnapshot?: Record<string, unknown>) => {
    if (!editorView) return null
    const selectionContext = extractSelectionContext(contextSnapshot ?? getContext())
    const payload = {
      docJson: editorView.state.doc.toJSON() as Record<string, unknown>,
      pageConfig,
      selectionContext,
      workspaceId: activeWorkspaceFile?.workspaceId,
      filePath: activeWorkspaceFile?.filePath,
      fileType: activeWorkspaceFile?.fileType,
    }
    const createDocumentSession = async () => {
      const response = await fetch('/api/doc-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) throw new Error(`创建后端文档会话失败：HTTP ${response.status}`)
      const data = await response.json() as { documentSessionId?: string; version?: number }
      const id = String(data.documentSessionId || '')
      if (!id) throw new Error('后端未返回 documentSessionId')
      rememberDocumentSession({ id, version: Number(data.version ?? 1) || 1 })
      await registerActiveDocumentSession(id)
      return id
    }
    const current = documentSessionRef.current
    if (!current) {
      return createDocumentSession()
    }

    const response = await fetch(`/api/doc-sessions/${current.id}/client-patches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, baseVersion: current.version, clientId: documentClientIdRef.current }),
    })
    if (response.status === 404) {
      rememberDocumentSession(null)
      return createDocumentSession()
    }
    if (response.status === 409) {
      rememberDocumentSession(null)
      return syncDocumentSession(contextSnapshot)
    }
    if (!response.ok) throw new Error(`同步后端文档会话失败：HTTP ${response.status}`)
    const data = await response.json() as { version?: number }
    rememberDocumentSession({ id: current.id, version: Number(data.version ?? current.version + 1) || current.version + 1 })
    await registerActiveDocumentSession(current.id)
    return current.id
  }, [activeWorkspaceFile?.filePath, activeWorkspaceFile?.fileType, activeWorkspaceFile?.workspaceId, editorView, getContext, pageConfig, registerActiveDocumentSession, rememberDocumentSession])

  const applyDocumentEventRecords = useCallback((
    data: unknown,
    options?: { ignoreOwnClientPatch?: boolean; skipSnapshotApply?: boolean },
  ) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return
    const record = data as Record<string, unknown>
    const events = Array.isArray(record.documentEvents)
      ? record.documentEvents
      : record.type && record.type !== 'snapshot'
        ? [record]
        : []
    const sessionId = typeof record.documentSessionId === 'string'
      ? record.documentSessionId
      : documentSessionRef.current?.id
    if (!sessionId) return
    const nextWorkspaceId = typeof record.workspaceId === 'string' ? record.workspaceId : undefined
    const nextFilePath = typeof record.filePath === 'string' ? record.filePath : undefined
    const nextFileType = typeof record.fileType === 'string' ? record.fileType : undefined
    if (nextWorkspaceId && nextFilePath && nextFileType) {
      onWorkspaceFileActivated?.({
        workspaceId: nextWorkspaceId,
        filePath: nextFilePath,
        fileType: nextFileType,
      })
    }
    if (record.type === 'snapshot') {
      const version = Number(record.version ?? documentSessionRef.current?.version ?? 1) || 1
      rememberDocumentSession({ id: sessionId, version })
      return
    }

    let nextDocJson: Record<string, unknown> | null = null
    let nextPageConfig: PageConfig | null = null
    let nextVersion = documentSessionRef.current?.id === sessionId ? documentSessionRef.current.version : 0
    for (const event of events) {
      if (!event || typeof event !== 'object' || Array.isArray(event)) continue
      const eventRecord = event as Record<string, unknown>
      const eventVersion = typeof eventRecord.version === 'number' ? eventRecord.version : undefined
      if (eventVersion !== undefined && documentSessionRef.current?.id === sessionId && eventVersion <= documentSessionRef.current.version) {
        continue
      }
      if (
        options?.ignoreOwnClientPatch
        && eventRecord.source === 'client_patch'
        && eventRecord.originClientId === documentClientIdRef.current
      ) {
        if (eventVersion !== undefined) nextVersion = Math.max(nextVersion, eventVersion)
        continue
      }
      if (options?.skipSnapshotApply && eventRecord.type === 'snapshot') {
        if (eventVersion !== undefined) nextVersion = Math.max(nextVersion, eventVersion)
        continue
      }
      if (
        eventRecord.type === 'document_replace'
        && eventRecord.docJson
        && typeof eventRecord.docJson === 'object'
        && !Array.isArray(eventRecord.docJson)
      ) {
        nextDocJson = eventRecord.docJson as Record<string, unknown>
      }
      if (
        eventRecord.type === 'page_config_changed'
        && eventRecord.pageConfig
        && typeof eventRecord.pageConfig === 'object'
        && !Array.isArray(eventRecord.pageConfig)
      ) {
        nextPageConfig = eventRecord.pageConfig as PageConfig
      }
      if (eventVersion !== undefined) nextVersion = Math.max(nextVersion, eventVersion)
    }
    if (typeof record.version === 'number' && typeof record.documentSessionId === 'string') {
      nextVersion = Math.max(nextVersion, record.version)
    }
    if (nextDocJson && onApplyServerDocumentState) {
      onApplyServerDocumentState(nextDocJson, nextPageConfig ?? pageConfig)
      onDocumentStyleMutation?.()
    } else if (nextPageConfig) {
      onPageConfigChange(nextPageConfig)
    }
    if (nextVersion > 0) rememberDocumentSession({ id: sessionId, version: nextVersion })
  }, [onApplyServerDocumentState, onDocumentStyleMutation, onPageConfigChange, onWorkspaceFileActivated, pageConfig, rememberDocumentSession])

  const applyServerDocumentEvents = useCallback((data: unknown) => {
    applyDocumentEventRecords(data)
  }, [applyDocumentEventRecords])

  useEffect(() => {
    if (!editorView || documentSessionRef.current) return
    void syncDocumentSession().catch(error => {
      console.warn('初始化后端文档会话失败', error)
    })
  }, [editorView, syncDocumentSession])

  useEffect(() => {
    if (!editorView || !documentSessionInfo?.id) return
    const timer = window.setTimeout(() => {
      void syncDocumentSession().catch(error => {
        console.warn('同步后端文档会话失败', error)
      })
    }, 800)
    return () => window.clearTimeout(timer)
  }, [documentSessionInfo?.id, editorState, editorView, pageConfig, syncDocumentSession])

  useEffect(() => {
    const sessionId = documentSessionInfo?.id
    if (!sessionId) return
    const source = new EventSource(`/api/doc-sessions/${sessionId}/events`)
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as Record<string, unknown>
        applyDocumentEventRecords(data, { ignoreOwnClientPatch: true, skipSnapshotApply: true })
      } catch (error) {
        console.warn('解析后端文档事件失败', error)
      }
    }
    source.onerror = () => {
      console.warn('后端文档事件连接异常')
    }
    return () => source.close()
  }, [applyDocumentEventRecords, documentSessionInfo?.id])

  const requestOcrAnalysis = useCallback(async (
    request: OcrIntentMatch,
    images: ChatAttachment[],
    imageIndices?: number[],
  ) => {
    if (!isOcrReady) {
      throw new Error('OCR 配置未就绪，请先在设置中补充 OCR 模型、端点和 API Key。')
    }

    const response = await fetch('/api/ai/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskType: request.taskType,
        instruction: request.instruction || undefined,
        imageIndices,
        ocrConfig: {
          enabled: ocrConfig.enabled,
          backend: ocrConfig.backend,
          providerId: ocrConfig.providerId,
          endpoint: effectiveOcrEndpoint || undefined,
          model: ocrConfig.model || undefined,
          timeoutSeconds: ocrConfig.timeoutSeconds,
          maxImages: ocrConfig.maxImages,
        },
        images: images.map(image => ({
          name: image.name,
          type: image.type,
          size: image.size,
          dataUrl: image.dataUrl,
        })),
      }),
    })

    const data = await response.json() as OcrAnalysisResponse & { detail?: string }
    if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`)
    return data
  }, [effectiveOcrEndpoint, isOcrReady, ocrConfig.backend, ocrConfig.enabled, ocrConfig.maxImages, ocrConfig.model, ocrConfig.providerId, ocrConfig.timeoutSeconds])

  const loadConversations = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const response = await fetch('/api/conversations')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = (await response.json()) as ConversationSummary[]
      const enriched = await Promise.all(data.map(async conversation => {
        try {
          const runResponse = await fetch(`/api/conversations/${conversation.id}/runs/active`)
          if (!runResponse.ok) return conversation
          const payload = await runResponse.json() as { run?: ReactRunSummary | null }
          return {
            ...conversation,
            runStatus: payload.run?.status ?? null,
            activeRunSessionId: payload.run?.sessionId ?? null,
          }
        } catch {
          return conversation
        }
      }))
      setConversations(enriched)
    } catch (error) {
      console.error('[AISidebar] load conversations failed', error)
      setConversations([])
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  const subscribeToExistingRun = useCallback(async (
    conversationId: string,
    sessionId: string,
    after = 0,
  ) => {
    if (!sessionId) return
    const aiMessage = makeAiMessage('', true)
    setMessages(prev => prev.some(message => message.streaming) ? prev : [...prev, aiMessage])
    setLoading(true)
    activeRunSessionIdRef.current = sessionId
    const controller = new AbortController()
    abortRef.current = controller

    const updateMessage = (updater: (message: Message) => Message) => {
      setMessages(prev => prev.map(message => (message.id === aiMessage.id ? updater(message) : message)))
    }

    let buffer = ''
    let finalText = ''
    let thinkingText = ''
    let finished = false
    let replayAgentTraces: AgentTrace[] = []
    const updateReplayAgentTrace = (
      trace: AgentTrace,
      updater: (current: AgentTrace) => AgentTrace = current => current,
    ) => {
      replayAgentTraces = upsertAgentTraceInList(replayAgentTraces, trace, updater)
      updateMessage(message => upsertAgentTraceInMessage(message, trace, updater))
    }
    try {
      const response = await fetch(`/api/ai/react/runs/${sessionId}/events?after=${after}`, {
        signal: controller.signal,
      })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()

      while (!finished) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          let event: Record<string, unknown>
          try {
            event = JSON.parse(line.slice(6)) as Record<string, unknown>
          } catch {
            continue
          }

          switch (event.type) {
            case 'thinking': {
              const chunk = String(event.content ?? '')
              thinkingText += chunk
              updateMessage(message => ({
                ...appendThinkingChunk(message, chunk),
                activityLabel: '正在恢复思考过程...',
              }))
              break
            }
            case 'round_start':
              break
            case 'content': {
              const chunk = String(event.content ?? '')
              finalText = stripToolResultJsonLeaks(finalText + chunk)
              updateMessage(message => ({
                ...appendContentChunk(message, chunk),
                activityLabel: '正在生成回复...',
              }))
              break
            }
            case 'tool_call': {
              const toolCall: ToolCallResult = {
                id: typeof event.id === 'string' ? event.id : undefined,
                name: String(event.name ?? ''),
                params: normalizeToolParams(event.params),
                originalParams: normalizeToolParams(event.params),
                status: 'pending',
                isExpanded: true,
              }
              updateMessage(message => ({
                ...appendToolSegment(message, toolCall),
                activityLabel: `等待执行 ${toolCall.name}...`,
              }))
              break
            }
            case 'tool_result': {
              const toolId = typeof event.id === 'string' ? event.id : undefined
              const toolName = String(event.name ?? '')
              const result = (event.result && typeof event.result === 'object' && !Array.isArray(event.result))
                ? event.result as Record<string, unknown>
                : {}
              applyServerDocumentEvents(result.data)
              applyTaskToolResultData(result.data)
              updateMessage(message => ({
                ...updateToolCallInMessage(
                  message,
                  currentToolCall => Boolean(toolId && currentToolCall.id === toolId) || (!toolId && currentToolCall.name === toolName && currentToolCall.status === 'pending'),
                  currentToolCall => ({
                    ...currentToolCall,
                    status: result.success === true ? 'ok' : 'err',
                    message: typeof result.message === 'string' ? result.message : '',
                    data: result.data,
                    isExpanded: false,
                  }),
                ),
                activityLabel: '已收到工具结果，继续生成...',
              }))
              break
            }
            case 'agent_start': {
              const trace = createAgentTraceFromEvent(event)
              updateReplayAgentTrace(trace)
              if (trace.id) {
                setAgentRuns(prev => [{
                  id: trace.id,
                  agentType: trace.agentType,
                  description: trace.description,
                  status: 'running',
                }, ...prev.filter(agentRun => agentRun.id !== trace.id)])
                setIsAgentPanelExpanded(true)
              }
              updateMessage(message => ({
                ...message,
                activityLabel: `子代理 ${trace.agentType} 正在处理：${trace.description}`,
              }))
              break
            }
            case 'agent_progress': {
              const agentId = typeof event.agentId === 'string' ? event.agentId : ''
              const agentType = String(event.agentType ?? 'agent')
              const phase = String(event.phase ?? '')
              const fallbackTrace = createFallbackAgentTrace(agentId, agentType)
              if (phase === 'round_start') {
                updateReplayAgentTrace(fallbackTrace, trace => appendAgentTraceEvent(trace, {
                  id: newId(),
                  type: 'round_start',
                  round: Number.isFinite(Number(event.round)) ? Number(event.round) : undefined,
                }))
              } else if (phase === 'thinking' || phase === 'content') {
                const content = String(event.content ?? '')
                if (content) {
                  updateReplayAgentTrace(fallbackTrace, trace => appendAgentTraceEvent(trace, {
                    id: newId(),
                    type: phase,
                    phase,
                    content: compactAgentTraceText(content, 360),
                  }))
                }
              }
              updateMessage(message => ({
                ...message,
                activityLabel: phase === 'thinking'
                  ? `子代理 ${agentType} 正在推理...`
                  : phase === 'content'
                    ? `子代理 ${agentType} 正在汇总结论...`
                    : `子代理 ${agentType} 正在执行...`,
              }))
              break
            }
            case 'agent_tool_call': {
              const agentId = typeof event.agentId === 'string' ? event.agentId : ''
              if (!agentId) break
              const agentType = String(event.agentType ?? 'agent')
              const toolCall: ToolCallResult = {
                id: typeof event.id === 'string' ? event.id : undefined,
                name: String(event.name ?? ''),
                params: normalizeToolParams(event.params),
                originalParams: normalizeToolParams(event.params),
                status: 'pending',
                isExpanded: true,
              }
              updateReplayAgentTrace(createFallbackAgentTrace(agentId, agentType), trace => appendAgentTraceEvent(trace, {
                id: newId(),
                type: 'tool_call',
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                summary: summarizeToolPurpose(toolCall),
                params: getReplayToolParams(toolCall),
                status: 'pending',
                isExpanded: false,
              }))
              updateMessage(message => ({
                ...message,
                activityLabel: `子代理正在读取：${toolCall.name}`,
              }))
              break
            }
            case 'agent_tool_result': {
              const agentId = typeof event.agentId === 'string' ? event.agentId : ''
              const agentType = String(event.agentType ?? 'agent')
              const toolResult = event.toolResult && typeof event.toolResult === 'object' && !Array.isArray(event.toolResult)
                ? event.toolResult as Record<string, unknown>
                : {}
              const toolId = typeof toolResult.id === 'string' ? toolResult.id : undefined
              const toolName = String(toolResult.name ?? '')
              const result = toolResult.result && typeof toolResult.result === 'object' && !Array.isArray(toolResult.result)
                ? toolResult.result as Record<string, unknown>
                : {}
              applyTaskToolResultData(result.data)
              updateReplayAgentTrace(createFallbackAgentTrace(agentId, agentType), trace => updateAgentTraceToolResult(trace, toolId, toolName, result))
              updateMessage(message => ({
                ...message,
                activityLabel: '子代理已收到工具结果，继续分析...',
              }))
              break
            }
            case 'agent_done': {
              const agentType = String(event.agentType ?? 'agent')
              const agentId = String(event.agentId ?? '')
              const result = String(event.result ?? '').trim()
              if (agentId) {
                setAgentRuns(prev => prev.map(agentRun => agentRun.id === agentId
                  ? { ...agentRun, status: 'completed', result }
                  : agentRun))
              }
              updateReplayAgentTrace(createFallbackAgentTrace(agentId, agentType), trace => ({
                ...appendAgentTraceEvent(trace, {
                  id: newId(),
                  type: 'done',
                  content: result ? compactAgentTraceText(result, 360) : undefined,
                }),
                agentType,
                status: 'completed',
                result: result ? compactAgentTraceText(result, 1200) : undefined,
              }))
              updateMessage(message => ({
                ...message,
                activityLabel: `子代理 ${agentType} 已完成，主 Agent 正在继续...`,
              }))
              break
            }
            case 'agent_background_launched': {
              const agentType = String(event.agentType ?? 'agent')
              const agentId = String(event.agentId ?? '')
              const description = String(event.description ?? '后台任务')
              updateReplayAgentTrace({
                id: agentId || newId(),
                agentType,
                description,
                runMode: 'background',
                status: 'running',
                tools: [],
                events: [{
                  id: newId(),
                  type: 'content',
                  phase: 'content',
                  content: '后台子代理已启动，主 Agent 会继续当前流程。',
                }],
                isExpanded: true,
              })
              updateMessage(message => ({
                ...message,
                activityLabel: '后台子代理已启动，主 Agent 正在继续...',
              }))
              break
            }
            case 'done':
              finished = true
              updateMessage(message => ({ ...message, streaming: false, activityLabel: '' }))
              break
            case 'error':
              throw new Error(String(event.message ?? 'AI 请求失败'))
          }
        }
      }

      if (finalText.trim() || thinkingText.trim() || replayAgentTraces.length > 0) {
        const message: StoredMessage = {
          role: 'assistant',
          content: finalText || null,
          thinking: thinkingText || undefined,
          agentTraces: replayAgentTraces.length > 0
            ? replayAgentTraces.map(compactAgentTraceForStorage)
            : undefined,
        }
        await fetch(`/api/conversations/${conversationId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [message] }),
        })
        conversationMessagesRef.current = [...conversationMessagesRef.current, message]
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        console.error('[AISidebar] restore react run failed', error)
        updateMessage(message => ({
          ...appendContentChunk(message, buildErrorText(error), true),
          streaming: false,
          activityLabel: '',
        }))
      }
    } finally {
      setLoading(false)
      abortRef.current = null
      if (activeRunSessionIdRef.current === sessionId) activeRunSessionIdRef.current = null
      void loadConversations()
    }
  }, [loadConversations])

  useEffect(() => {
    void loadConversations()
  }, [loadConversations])

  useEffect(() => {
    let active = true
    fetch('/api/ai/settings')
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<AISettingsData>
      })
      .then(data => {
        if (!active) return
        setProviders(data.providers)
        setActiveProviderId(data.activeProviderId)
        setOcrConfig(data.ocrConfig || createDefaultOcrConfig())
        setVisionConfig(data.visionConfig || createDefaultVisionConfig())
        setModelName(data.model || '')
        setSelectedModel(data.model || '')
      })
      .catch(error => {
        console.error('[AISidebar] load ai settings failed', error)
        if (!active) return
        setModelName('')
        setSelectedModel('')
      })

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!activeProviderId) return

    let active = true
    setModelsLoading(true)
    fetch(`/api/ai/models?providerId=${encodeURIComponent(activeProviderId)}`)
      .then(async response => {
        const data = await response.json() as { models?: ModelOption[]; defaultModel?: string; detail?: string }
        if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`)
        return data
      })
      .then(data => {
        if (!active) return
        const models = Array.isArray(data.models) ? data.models : []
        setAvailableModels(models)
        const fallbackModel = data.defaultModel || ''
        setSelectedModel(prev => {
          if (prev && models.some(model => model.id === prev)) return prev
          return fallbackModel || models[0]?.id || prev
        })
      })
      .catch(error => {
        console.error('[AISidebar] load models failed', error)
        if (!active) return
        setAvailableModels([])
      })
      .finally(() => {
        if (active) setModelsLoading(false)
      })

    return () => {
      active = false
    }
  }, [activeProviderId])

  useEffect(() => {
    onModelContextChange?.({
      providerId: activeProviderId || null,
      model: selectedModel || modelName || null,
    })
  }, [activeProviderId, modelName, onModelContextChange, selectedModel])

  useEffect(() => {
    if (viewMode !== 'chat') return
    scrollToBottomIfNeeded()
  }, [messages, loading, scrollToBottomIfNeeded, viewMode])

  useEffect(() => {
    setMessages(prev =>
      prev.map(message => {
        if (message.role !== 'user' || message.streaming || !message.prepared) return message
        const tightWidth = findTightBubbleWidth(message.prepared, bubbleContentMax(sidebarWidth))
        return tightWidth !== message.tightWidth ? { ...message, tightWidth } : message
      }),
    )
  }, [sidebarWidth])

  useEffect(() => {
    resetTextareaHeight()
    if (textareaRef.current) autoResize(textareaRef.current)
    setTimeout(() => textareaRef.current?.focus(), 0)
  }, [viewMode, autoResize, resetTextareaHeight])

  const onDragStart = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    isDragging.current = true

    const handleMove = (moveEvent: MouseEvent) => {
      if (!isDragging.current) return
      setSidebarWidth(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, window.innerWidth - moveEvent.clientX)))
    }

    const handleUp = () => {
      isDragging.current = false
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
  }, [])

  const openConversation = useCallback(async (conversationId: string) => {
    if (openingConversationId) return
    const navigationSeq = conversationNavigationSeqRef.current + 1
    conversationNavigationSeqRef.current = navigationSeq
    shouldAutoScrollRef.current = true
    setOpeningConversationId(conversationId)
    try {
      const response = await fetch(`/api/conversations/${conversationId}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = (await response.json()) as ConversationDetail
      if (conversationNavigationSeqRef.current !== navigationSeq) return
      setCurrentConversationId(data.id)
      setCurrentConversationTitle(data.title || '新会话')
      conversationMessagesRef.current = data.messages ?? []
      setMessages(fromStoredMessages(conversationMessagesRef.current, sidebarWidth))
      setViewMode('chat')
      try {
        const runResponse = await fetch(`/api/conversations/${conversationId}/runs/active`)
        if (runResponse.ok) {
          const payload = await runResponse.json() as { run?: ReactRunSummary | null }
          if (conversationNavigationSeqRef.current !== navigationSeq) return
          const run = payload.run
          const hasFinalAssistant = (data.messages ?? []).some(message => message.role === 'assistant')
          if (run?.sessionId && (run.status !== 'completed' || !hasFinalAssistant)) {
            void subscribeToExistingRun(conversationId, run.sessionId, 0)
          }
        }
      } catch (error) {
        console.error('[AISidebar] load active react run failed', error)
      }
    } catch (error) {
      console.error('[AISidebar] open conversation failed', error)
    } finally {
      setOpeningConversationId(current => (current === conversationId ? null : current))
    }
  }, [openingConversationId, sidebarWidth, subscribeToExistingRun])

  const deleteConversation = useCallback(async (conversationId: string) => {
    try {
      const response = await fetch(`/api/conversations/${conversationId}`, { method: 'DELETE' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setConversations(prev => prev.filter(conversation => conversation.id !== conversationId))
      if (currentConversationIdRef.current === conversationId) {
        setCurrentConversationId(null)
        setCurrentConversationTitle('')
        conversationMessagesRef.current = []
        setMessages([])
        window.localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY)
      }
    } catch (error) {
      console.error('[AISidebar] delete conversation failed', error)
    }
  }, [])

  useEffect(() => {
    if (autoRestoreAttemptedRef.current) return
    if (currentConversationId || openingConversationId || conversations.length === 0) return
    autoRestoreAttemptedRef.current = true
    const storedConversationId = window.localStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY)
    if (!storedConversationId) return
    if (!conversations.some(conversation => conversation.id === storedConversationId)) return
    void openConversation(storedConversationId)
  }, [conversations, currentConversationId, openConversation, openingConversationId])

  const exportConversation = useCallback(async (conversationId?: string | null) => {
    const targetConversationId = conversationId ?? currentConversationIdRef.current
    const title = currentConversationTitle || 'conversation'

    let detail: ConversationDetail | null = null
    let reactTraces: unknown[] = []
    if (targetConversationId) {
      const response = await fetch(`/api/conversations/${targetConversationId}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      detail = await response.json() as ConversationDetail

      const traceResponse = await fetch(`/api/conversations/${targetConversationId}/react-traces`)
      if (traceResponse.ok) {
        const tracePayload = await traceResponse.json() as { traces?: unknown[] }
        reactTraces = Array.isArray(tracePayload.traces) ? tracePayload.traces : []
      }
    }

    const payload = {
      exportedAt: new Date().toISOString(),
      conversationId: targetConversationId,
      title: detail?.title || title,
      mode: assistantMode,
      providerId: activeProviderId || null,
      model: selectedModel || modelName || null,
      imageProcessingMode: 'direct_multimodal',
      ocrConfig: {
        backend: ocrConfig.backend,
        providerId: ocrConfig.providerId,
        endpoint: effectiveOcrEndpoint || null,
        model: ocrConfig.model || null,
      },
      visionConfig: {
        enabled: visionConfig.enabled,
        providerId: visionConfig.providerId,
        endpoint: visionConfig.endpoint || activeVisionProvider?.endpoint || null,
        model: visionConfig.model || null,
      },
      includeSelection,
      currentContext: getContext(),
      storedMessages: detail?.messages ?? conversationMessagesRef.current,
      uiMessages: messages,
      reactHistory: buildReactMessages(detail?.messages ?? conversationMessagesRef.current, '').slice(0, -1),
      reactTraces,
    }

    const safeTitle = String(payload.title || 'conversation').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40) || 'conversation'
    downloadJsonFile(`${safeTitle}-${targetConversationId ?? 'draft'}.json`, payload)
  }, [activeProviderId, activeVisionProvider?.endpoint, assistantMode, currentConversationTitle, effectiveOcrEndpoint, getContext, includeSelection, messages, modelName, ocrConfig.backend, ocrConfig.model, ocrConfig.providerId, selectedModel, visionConfig.enabled, visionConfig.endpoint, visionConfig.model, visionConfig.providerId])

  const handleCancel = useCallback(() => {
    const sessionId = activeRunSessionIdRef.current
    if (sessionId) {
      void fetch(`/api/ai/react/runs/${sessionId}/cancel`, { method: 'POST' }).catch(error => {
        console.error('[AISidebar] cancel react run failed', error)
      })
    }
    abortRef.current?.abort()
  }, [])

  const appendPendingAttachments = useCallback(async (incomingFiles: File[]) => {
    if (incomingFiles.length === 0) return

    const errors: string[] = []
    const existingTotalSize = pendingAttachments.reduce((sum, attachment) => sum + attachment.size, 0)
    const remainingSlots = Math.max(MAX_ATTACHMENT_COUNT - pendingAttachments.length, 0)
    if (remainingSlots <= 0) {
      window.alert(`最多只能附带 ${MAX_ATTACHMENT_COUNT} 个附件。`)
      return
    }

    let nextTotalSize = existingTotalSize
    const acceptedFiles: File[] = []
    for (const file of incomingFiles.slice(0, remainingSlots)) {
      if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
        errors.push(`${file.name} 超过 ${Math.floor(MAX_ATTACHMENT_SIZE_BYTES / (1024 * 1024))}MB 限制`)
        continue
      }
      if (nextTotalSize + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
        errors.push(`附件总大小不能超过 ${Math.floor(MAX_TOTAL_ATTACHMENT_BYTES / (1024 * 1024))}MB`)
        break
      }
      acceptedFiles.push(file)
      nextTotalSize += file.size
    }

    if (incomingFiles.length > remainingSlots) {
      errors.push(`最多只能附带 ${MAX_ATTACHMENT_COUNT} 个附件，超出的文件已忽略`)
    }

    if (acceptedFiles.length === 0) {
      if (errors.length > 0) window.alert(errors.join('\n'))
      return
    }

    const nextAttachments: ChatAttachment[] = []
    for (const file of acceptedFiles) {
      try {
        nextAttachments.push(await extractAttachment(file))
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }

    if (nextAttachments.length > 0) {
      setPendingAttachments(prev => [...prev, ...nextAttachments])
    }
    if (errors.length > 0) window.alert(errors.join('\n'))
  }, [pendingAttachments])

  const handleAttachmentPick = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return
    await appendPendingAttachments(Array.from(files))
  }, [appendPendingAttachments])

  const removePendingAttachment = useCallback((id: string) => {
    setPendingAttachments(prev => prev.filter(attachment => attachment.id !== id))
  }, [])

  const handleSend = useCallback(async (overrideText?: string) => {
    const rawText = (overrideText ?? input).trim()
    const imageAttachments = pendingAttachments.filter(isImageAttachment)
    const textAttachments = pendingAttachments.filter(isTextAttachment)
    if (rawText.startsWith('/ocr') && imageAttachments.length === 0) {
      window.alert('请先附带至少一张图片，再使用 /ocr 命令。')
      return
    }
    const ocrIntent = imageAttachments.length > 0 ? (parseOcrCommand(rawText) ?? detectOcrIntent(rawText)) : null
    const text = rawText
    if ((!text && pendingAttachments.length === 0) || loading) return

    const templateMatch = resolveTemplateFromMessage(text, templates)
    if (templateMatch.ambiguous.length > 0) {
      window.alert(`检测到多个同名或相近模板：${templateMatch.ambiguous.map((item) => item.name).join('、')}，请在模板选择器中先选定一个模板后再发送。`)
      return
    }
    if (templateMatch.match && templateMatch.match.id !== activeTemplate?.id) {
      await onActivateTemplate(templateMatch.match.id)
    }

    const shouldStartNewConversation = viewMode === 'history'
    const nextTitle = makeConversationTitle(text)
    const previousConversationMessages = shouldStartNewConversation ? [] : conversationMessagesRef.current
    const userMessage = makeUserMessage(text, sidebarWidth, pendingAttachments)
    const imagesForRequest = imageAttachments
    const textAttachmentsForRequest = textAttachments

    // Capture selection tag for this message, then clear it from input area
    const currentSel = (includeSelection && editorState) ? serializeSelection(editorState) : null
    if (currentSel) {
      userMessage.selectionTag = {
        text: currentSel.selectedText,
        paragraphIndex: currentSel.paragraphIndex,
      }
    }

    const aiMessage = makeAiMessage('', true)

    if (shouldStartNewConversation) {
      autoRestoreAttemptedRef.current = true
      conversationNavigationSeqRef.current += 1
      currentConversationIdRef.current = null
      window.localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY)
      applyTaskState([])
      setAgentRuns([])
      setIsAgentPanelExpanded(false)
    }
    setInput('')
    setPendingAttachments([])
    setIncludeSelection(true)
    resetTextareaHeight()
    shouldAutoScrollRef.current = true

    if (shouldStartNewConversation) {
      setCurrentConversationId(null)
      setCurrentConversationTitle(nextTitle)
      conversationMessagesRef.current = []
      setMessages([userMessage, aiMessage])
      setViewMode('chat')
    } else {
      setMessages(prev => [...prev, userMessage, aiMessage])
    }

    setLoading(true)
    const controller = new AbortController()
    abortRef.current = controller

    const updateMessage = (updater: (message: Message) => Message) => {
      setMessages(prev => prev.map(message => (message.id === aiMessage.id ? updater(message) : message)))
    }

    let conversationId = shouldStartNewConversation ? null : currentConversationIdRef.current
    let context = getContext()
    try {
      const documentSessionId = await syncDocumentSession(context)
      if (documentSessionId) {
        context = { ...getContext(), ...context, documentSessionId }
      }
    } catch (error) {
      console.error('[AISidebar] sync document session failed', error)
      updateMessage(message => ({
        ...message,
        activityLabel: `后端文档会话同步失败：${error instanceof Error ? error.message : String(error)}`,
      }))
      setLoading(false)
      return
    }
    let persistedAssistantText = ''
    let conversationPersisted = false
    let userMessagePersisted = false
    const userRecord: StoredMessage = { role: 'user', content: text, attachments: pendingAttachments }
    const persistedRecords: StoredMessage[] = [userRecord]

    const appendAssistantRound = (
      assistantText: string,
      thinkingText: string,
      toolResults: ToolCallRecord[],
      agentTraces: AgentTrace[] = [],
    ) => {
      if (!assistantText && !thinkingText && toolResults.length === 0 && agentTraces.length === 0) return
      persistedRecords.push({
        role: 'assistant',
        content: assistantText || null,
        thinking: thinkingText || undefined,
        agentTraces: agentTraces.length > 0
          ? agentTraces.map(compactAgentTraceForStorage)
          : undefined,
        tool_calls: toolResults.length > 0
          ? toolResults.map(tool => ({
            id: tool.id,
            type: 'function' as const,
            function: {
              name: tool.name,
              arguments: JSON.stringify(getReplayToolParams(tool)),
            },
          }))
          : undefined,
        toolCalls: toolResults.length > 0
          ? toolResults.map(tool => ({
            id: tool.id,
            name: tool.name,
            params: tool.params,
            originalParams: tool.originalParams,
            status: tool.result.success ? 'ok' : 'err',
            message: tool.result.message,
            data: tool.result.data,
          }))
          : undefined,
      })
    }

    const serverExecutedToolResults: ToolCallRecord[] = []
    let persistRoundToolResults = (toolResults: ToolCallRecord[]) => {
      void toolResults
    }

    try {
      if (!conversationId) {
        const createResponse = await fetch('/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: nextTitle }),
        })
        if (!createResponse.ok) throw new Error(`HTTP ${createResponse.status}`)
        const created = (await createResponse.json()) as { id: string }
        conversationId = created.id
        currentConversationIdRef.current = created.id
        setCurrentConversationId(created.id)
        setCurrentConversationTitle(nextTitle)
        void loadConversations()
      }

      if (conversationId && !userMessagePersisted) {
        await fetch(`/api/conversations/${conversationId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [userRecord] }),
        })
        userMessagePersisted = true
        conversationMessagesRef.current = [...previousConversationMessages, userRecord]
      }

      const reactMessages = buildReactMessages(previousConversationMessages, text)
      let finished = false
      let sessionId = ''

      if (ocrIntent) {
        const ocrResponse = await requestOcrAnalysis(ocrIntent, imagesForRequest)
        const ocrText = formatOcrResponseForChat(ocrResponse)
        persistedAssistantText = ocrText
        persistedRecords.push({ role: 'assistant', content: ocrText })
        setMessages(prev => prev.map(message => (
          message.id === aiMessage.id
            ? { ...appendContentChunk(message, ocrText, true), streaming: false, activityLabel: '' }
            : message
        )))

        if (conversationId) {
          await fetch(`/api/conversations/${conversationId}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: userMessagePersisted ? persistedRecords.slice(1) : persistedRecords }),
          })
          conversationPersisted = true
          conversationMessagesRef.current = userMessagePersisted
            ? [...previousConversationMessages, userRecord, ...persistedRecords.slice(1)]
            : [...previousConversationMessages, ...persistedRecords]
        }
        return
      }

      const runResponse = await fetch('/api/ai/react/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          message: text,
          history: previousConversationMessages.filter(message => message.role !== 'tool').slice(-20),
          context,
          conversationId,
          reactMessages,
          mode: assistantMode,
          documentSessionId: typeof context.documentSessionId === 'string' ? context.documentSessionId : undefined,
          model: selectedModel || modelName || undefined,
          providerId: activeProviderId || undefined,
          imageProcessingMode: 'direct_multimodal',
          attachments: textAttachmentsForRequest.map(attachment => ({
            name: attachment.name,
            type: attachment.type,
            size: attachment.size,
            textContent: attachment.textContent,
            textFormat: attachment.textFormat,
          })),
          images: imagesForRequest.map(image => ({
            name: image.name,
            type: image.type,
            size: image.size,
            dataUrl: image.dataUrl,
          })),
        }),
      })

      if (!runResponse.ok) throw new Error(`HTTP ${runResponse.status}`)
      const run = (await runResponse.json()) as ReactRunSummary
      sessionId = String(run.sessionId || '')
      activeRunSessionIdRef.current = sessionId || null
      if (!sessionId) throw new Error('后端未返回 ReAct sessionId')

      // ── Subscribe to the Gateway-owned ReAct session ──
      const response = await fetch(`/api/ai/react/runs/${sessionId}/events?after=0`, {
        signal: controller.signal,
      })

      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let roundAssistantText = ''
      let roundThinkingText = ''
      let roundNumber = 0
      const pendingToolCalls: ToolCallResult[] = []
      let roundAgentTraces: AgentTrace[] = []
      let roundToolResultsPersisted = false

      const updateRoundAgentTrace = (
        trace: AgentTrace,
        updater: (current: AgentTrace) => AgentTrace = current => current,
      ) => {
        roundAgentTraces = upsertAgentTraceInList(roundAgentTraces, trace, updater)
        updateMessage(message => upsertAgentTraceInMessage(message, trace, updater))
      }

      persistRoundToolResults = (toolResults: ToolCallRecord[]) => {
        if (roundToolResultsPersisted || (toolResults.length === 0 && roundAgentTraces.length === 0)) return

        appendAssistantRound(roundAssistantText, roundThinkingText, toolResults, roundAgentTraces)
        persistedRecords.push(
          ...toolResults.map(tool => ({
            role: 'tool' as const,
            tool_call_id: tool.id,
            content: serializeToolResult(tool),
          })),
        )
        roundToolResultsPersisted = true
      }

      // ── Read SSE events from the single long-lived connection ──
      while (!finished) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          let event: Record<string, unknown>
          try {
            event = JSON.parse(line.slice(6)) as Record<string, unknown>
          } catch {
            continue
          }

          switch (event.type) {
            case 'session_created':
              sessionId = String(event.sessionId ?? sessionId)
              activeRunSessionIdRef.current = sessionId || null
              break

            case 'round_start':
              persistRoundToolResults(serverExecutedToolResults)
              roundNumber = Number(event.round ?? 0)
              roundAssistantText = ''
              roundThinkingText = ''
              roundAgentTraces = []
              serverExecutedToolResults.length = 0
              roundToolResultsPersisted = false
              break

            case 'thinking':
              roundThinkingText += String(event.content ?? '')
              updateMessage(message => ({
                ...appendThinkingChunk(message, String(event.content ?? '')),
                activityLabel: '正在思考下一步...',
              }))
              break

            case 'content': {
              const rawChunk = String(event.content ?? '')
              const nextRoundAssistantText = stripToolResultJsonLeaks(roundAssistantText + rawChunk)
              roundAssistantText = nextRoundAssistantText
              persistedAssistantText = stripToolResultJsonLeaks(persistedAssistantText + rawChunk)
              updateMessage(message => ({
                ...appendContentChunk(message, rawChunk),
                activityLabel: '正在生成回复...',
              }))
              break
            }

            case 'tool_call': {
              const toolCall: ToolCallResult = {
                id: typeof event.id === 'string' ? event.id : undefined,
                name: String(event.name ?? ''),
                params: normalizeToolParams(event.params),
                originalParams: normalizeToolParams(event.params),
                status: 'pending',
                isExpanded: true,
              }

              updateMessage(message => ({
                ...appendToolSegment(message, toolCall),
                activityLabel: `正在调用 ${toolCall.name}...`,
              }))
              pendingToolCalls.push(toolCall)
              break
            }

            case 'agent_start': {
              const agentType = String(event.agentType ?? 'general-purpose')
              const description = String(event.description ?? '子代理任务')
              const trace = createAgentTraceFromEvent(event)
              updateRoundAgentTrace(trace)
              if (trace.id) {
                setAgentRuns(prev => [{
                  id: trace.id,
                  agentType: trace.agentType,
                  description: trace.description,
                  status: 'running',
                }, ...prev.filter(agentRun => agentRun.id !== trace.id)])
                setIsAgentPanelExpanded(true)
              }
              updateMessage(message => ({
                ...message,
                activityLabel: `子代理 ${agentType} 正在处理：${description}`,
              }))
              break
            }

            case 'agent_progress': {
              const agentId = typeof event.agentId === 'string' ? event.agentId : ''
              const agentType = String(event.agentType ?? 'agent')
              const phase = String(event.phase ?? '')
              const fallbackTrace = createFallbackAgentTrace(agentId, agentType)
              if (phase === 'round_start') {
                updateRoundAgentTrace(fallbackTrace, trace => appendAgentTraceEvent(trace, {
                  id: newId(),
                  type: 'round_start',
                  round: Number.isFinite(Number(event.round)) ? Number(event.round) : undefined,
                }))
              } else if (phase === 'thinking' || phase === 'content') {
                const content = String(event.content ?? '')
                if (content) {
                  updateRoundAgentTrace(fallbackTrace, trace => appendAgentTraceEvent(trace, {
                    id: newId(),
                    type: phase,
                    phase,
                    content: compactAgentTraceText(content, 360),
                  }))
                }
              }
              updateMessage(message => ({
                ...message,
                activityLabel: phase === 'thinking'
                  ? `子代理 ${agentType} 正在推理...`
                  : phase === 'content'
                    ? `子代理 ${agentType} 正在汇总结论...`
                    : `子代理 ${agentType} 正在执行...`,
              }))
              break
            }

            case 'agent_tool_call': {
              const agentId = typeof event.agentId === 'string' ? event.agentId : ''
              if (!agentId) break
              const agentType = String(event.agentType ?? 'agent')
              const toolCall: ToolCallResult = {
                id: typeof event.id === 'string' ? event.id : undefined,
                name: String(event.name ?? ''),
                params: normalizeToolParams(event.params),
                originalParams: normalizeToolParams(event.params),
                status: 'pending',
                isExpanded: true,
              }
              const fallbackTrace = createFallbackAgentTrace(agentId, agentType)
              updateRoundAgentTrace(fallbackTrace, trace => appendAgentTraceEvent(trace, {
                id: newId(),
                type: 'tool_call',
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                summary: summarizeToolPurpose(toolCall),
                params: getReplayToolParams(toolCall),
                status: 'pending',
                isExpanded: false,
              }))
              updateMessage(message => ({
                ...message,
                activityLabel: `子代理正在读取：${toolCall.name}`,
              }))
              break
            }

            case 'agent_tool_result': {
              const agentId = typeof event.agentId === 'string' ? event.agentId : ''
              const agentType = String(event.agentType ?? 'agent')
              const toolResult = event.toolResult && typeof event.toolResult === 'object' && !Array.isArray(event.toolResult)
                ? event.toolResult as Record<string, unknown>
                : {}
              const toolId = typeof toolResult.id === 'string' ? toolResult.id : undefined
              const toolName = String(toolResult.name ?? '')
              const result = toolResult.result && typeof toolResult.result === 'object' && !Array.isArray(toolResult.result)
                ? toolResult.result as Record<string, unknown>
                : {}
              applyTaskToolResultData(result.data)
              const fallbackTrace = createFallbackAgentTrace(agentId, agentType)
              updateRoundAgentTrace(fallbackTrace, trace => updateAgentTraceToolResult(trace, toolId, toolName, result))
              updateMessage(message => ({
                ...message,
                activityLabel: '子代理已收到工具结果，继续分析...',
              }))
              break
            }

            case 'agent_done': {
              const agentType = String(event.agentType ?? 'agent')
              const agentId = String(event.agentId ?? '')
              const result = String(event.result ?? '').trim()
              if (agentId) {
                setAgentRuns(prev => prev.map(agentRun => agentRun.id === agentId
                  ? { ...agentRun, status: 'completed', result }
                  : agentRun))
              }
              updateRoundAgentTrace(createFallbackAgentTrace(agentId, agentType), trace => {
                const withDone = appendAgentTraceEvent(trace, {
                  id: newId(),
                  type: 'done',
                  content: result ? compactAgentTraceText(result, 360) : undefined,
                })
                return {
                  ...withDone,
                  agentType,
                  status: 'completed',
                  result: result ? compactAgentTraceText(result, 1200) : undefined,
                }
              })
              updateMessage(message => ({
                ...message,
                activityLabel: `子代理 ${agentType} 已完成，主 Agent 正在继续...`,
              }))
              break
            }

            case 'agent_background_launched': {
              const agentType = String(event.agentType ?? 'agent')
              const agentId = String(event.agentId ?? '')
              const description = String(event.description ?? '后台任务')
              if (agentId) {
                setAgentRuns(prev => [{
                  id: agentId,
                  agentType,
                  description,
                  status: 'running',
                }, ...prev.filter(agentRun => agentRun.id !== agentId)])
                setIsAgentPanelExpanded(true)
              }
              updateRoundAgentTrace({
                id: agentId || newId(),
                agentType,
                description,
                runMode: 'background',
                status: 'running',
                tools: [],
                events: [{
                  id: newId(),
                  type: 'content',
                  phase: 'content',
                  content: '后台子代理已启动，主 Agent 会继续当前流程。',
                }],
                isExpanded: true,
              })
              updateMessage(message => ({
                ...message,
                activityLabel: '后台子代理已启动，主 Agent 正在继续...',
              }))
              break
            }

            case 'tooling_delta': {
              const loadedCount = Number(event.loadedDeferredToolCount ?? 0)
              const deferredCount = Number(event.deferredToolCount ?? 0)
              updateMessage(message => ({
                ...message,
                activityLabel: loadedCount > 0
                  ? `已加载 ${loadedCount} 个延迟工具，剩余 ${deferredCount} 个`
                  : `已同步工具摘要，延迟工具 ${deferredCount} 个`,
              }))
              break
            }

            case 'layout_preflight_start': {
              const pageCount = Number(event.pageCount ?? 0)
              updateMessage(message => ({
                ...message,
                activityLabel: pageCount > 0
                  ? `排版前正在逐页分析样式（共 ${pageCount} 页）...`
                  : '排版前正在分析页面样式...',
              }))
              break
            }

            case 'layout_preflight_page_start': {
              const page = Number(event.page ?? 0)
              const pageCount = Number(event.pageCount ?? 0)
              updateMessage(message => ({
                ...message,
                activityLabel: page > 0 && pageCount > 0
                  ? `正在分析第 ${page}/${pageCount} 页样式...`
                  : '正在分析页面样式...',
              }))
              break
            }

            case 'layout_preflight_page_done': {
              const page = Number(event.page ?? 0)
              const pageCount = Number(event.pageCount ?? 0)
              updateMessage(message => ({
                ...message,
                activityLabel: page > 0 && pageCount > 0
                  ? `已完成第 ${page}/${pageCount} 页样式分析...`
                  : '已完成一页样式分析...',
              }))
              break
            }

            case 'layout_preflight_done': {
              updateMessage(message => ({
                ...message,
                activityLabel: event.success === false
                  ? '排版前样式分析未完成，正在调整策略...'
                  : '逐页样式分析完成，开始执行排版...',
              }))
              break
            }

            case 'tool_result': {
              const toolId = typeof event.id === 'string' ? event.id : undefined
              const toolName = String(event.name ?? '')
              const result = (event.result && typeof event.result === 'object' && !Array.isArray(event.result))
                ? event.result as Record<string, unknown>
                : {}
              applyServerDocumentEvents(result.data)
              applyTaskToolResultData(result.data)
              const toolRecord: ToolCallRecord = {
                id: toolId ?? String(event.executionId ?? newId()),
                name: toolName,
                params: normalizeToolParams(event.params),
                originalParams: normalizeToolParams(event.originalParams),
                result: {
                  success: result.success === true,
                  message: typeof result.message === 'string' ? result.message : '',
                  data: result.data,
                },
              }

              serverExecutedToolResults.push(toolRecord)
              if (toolId) {
                const toolIndex = pendingToolCalls.findIndex(toolCall => toolCall.id === toolId)
                if (toolIndex >= 0) pendingToolCalls.splice(toolIndex, 1)
              }

              updateMessage(message => {
                const updated = updateToolCallInMessage(
                  message,
                  currentToolCall => Boolean(toolId && currentToolCall.id === toolId) || (!toolId && currentToolCall.name === toolName && currentToolCall.status === 'pending'),
                  currentToolCall => ({
                    ...currentToolCall,
                    params: normalizeToolParams(event.params),
                    status: toolRecord.result.success ? 'ok' : 'err',
                    message: toolRecord.result.message,
                    data: toolRecord.result.data,
                    isExpanded: false,
                  }),
                )
                return {
                  ...updated,
                  activityLabel: toolRecord.result.success ? '已收到后端工具结果，继续下一步...' : '后端工具执行失败，正在调整策略...',
                }
              })
              break
            }

            case 'round_complete': {
              persistRoundToolResults(serverExecutedToolResults)
              updateMessage(message => ({
                ...message,
                activityLabel: String(event.message ?? '正在继续执行后续步骤...'),
              }))
              break
            }

            case 'done':
              finished = true
              {
                persistRoundToolResults(serverExecutedToolResults)
                // Persist the final round when it has text, thinking, or child-agent trace without tool results.
                if (!roundToolResultsPersisted && (roundAssistantText || roundThinkingText || roundAgentTraces.length > 0)) {
                  appendAssistantRound(roundAssistantText, roundThinkingText, [], roundAgentTraces)
                  roundToolResultsPersisted = true
                }
                updateMessage(message => {
                  let nextMessage = message
                  if (String(event.reason ?? '') === 'max_rounds') {
                    nextMessage = appendContentChunk(nextMessage, `${nextMessage.text ? '\n\n' : ''}已执行 ${roundNumber} 轮操作，已停止当前自动链路。请根据当前结果继续下达下一步指令。`)
                  }
                  return { ...nextMessage, streaming: false, activityLabel: '' }
                })
              }
              break

            case 'error':
              throw new Error(String(event.message ?? 'AI 请求失败'))

            case 'recovery': {
              const action = String(event.action ?? '')
              const attempt = Number(event.attempt ?? 0)
              if (action === 'retry') {
                const delay = Number(event.delay ?? 1)
                updateMessage(message => ({
                  ...message,
                  activityLabel: `API 请求失败，${delay}s 后重试（第 ${attempt} 次）...`,
                }))
              } else if (action === 'context_compress') {
                const tier = Number(event.tier ?? 1)
                updateMessage(message => ({
                  ...message,
                  activityLabel: `上下文过长，正在压缩（级别 ${tier}）...`,
                }))
              } else if (action === 'output_continue') {
                updateMessage(message => ({
                  ...message,
                  activityLabel: String(event.message ?? `模型输出被截断，正在继续生成（第 ${attempt} 次）...`),
                }))
              }
              break
            }

            case 'compression': {
              const source = String(event.source ?? 'auto')
              updateMessage(message => ({
                ...message,
                activityLabel: source === 'reactive' ? '上下文过长，已压缩后重试' : '上下文已自动压缩',
              }))
              break
            }

            case 'compact_start': {
              updateMessage(message => ({
                ...message,
                activityLabel: String(event.source ?? '') === 'reactive' ? '上下文过长，正在压缩...' : '正在压缩上下文...',
              }))
              break
            }

            case 'compact_end': {
              updateMessage(message => ({
                ...message,
                activityLabel: '上下文压缩完成',
              }))
              break
            }

            case 'compact_failed': {
              updateMessage(message => ({
                ...message,
                activityLabel: String(event.message ?? '上下文压缩失败'),
              }))
              break
            }

            case 'microcompact': {
              updateMessage(message => ({
                ...message,
                activityLabel: '已整理旧工具结果',
              }))
              break
            }

            case 'budget_warning': {
              updateMessage(message => ({
                ...message,
                activityLabel: String(event.message ?? '自动预算接近上限，正在收敛步骤...'),
              }))
              break
            }

            case 'stop_hook': {
              updateMessage(message => ({
                ...message,
                activityLabel: '后端正在调整执行路径...',
              }))
              break
            }

            case 'ask_continue':
            case 'round':
              break
          }
        }
      }

      if (conversationId) {
        await fetch(`/api/conversations/${conversationId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: userMessagePersisted ? persistedRecords.slice(1) : persistedRecords,
          }),
        })
        conversationPersisted = true
        conversationMessagesRef.current = userMessagePersisted
          ? [...previousConversationMessages, userRecord, ...persistedRecords.slice(1)]
          : [...previousConversationMessages, ...persistedRecords]
      }
    } catch (error) {
      persistRoundToolResults(serverExecutedToolResults)
      if (error instanceof Error && error.name === 'AbortError') {
        persistedAssistantText = '（已取消）'
        if (!persistedRecords.some(message => message.role === 'assistant')) {
          persistedRecords.push({ role: 'assistant', content: persistedAssistantText })
        }
        setMessages(prev =>
          prev.map(message =>
            message.id === aiMessage.id
              ? { ...appendContentChunk(message, message.text ? '' : '（已取消）'), streaming: false, activityLabel: '' }
              : message,
          ),
        )
      } else {
        const errorText = buildErrorText(error)
        persistedAssistantText = errorText
        if (!persistedRecords.some(message => message.role === 'assistant')) {
          persistedRecords.push({ role: 'assistant', content: errorText })
        }
        setMessages(prev =>
          prev.map(message =>
            message.id === aiMessage.id
              ? { ...appendContentChunk(message, errorText, true), streaming: false, activityLabel: '' }
              : message,
          ),
        )
      }

      if (conversationId && !conversationPersisted) {
        try {
          await fetch(`/api/conversations/${conversationId}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messages: userMessagePersisted ? persistedRecords.slice(1) : persistedRecords,
            }),
          })
          conversationMessagesRef.current = userMessagePersisted
            ? [...previousConversationMessages, userRecord, ...persistedRecords.slice(1)]
            : [...previousConversationMessages, ...persistedRecords]
        } catch (persistError) {
          console.error('[AISidebar] persist conversation failed', persistError)
        }
      }
    } finally {
      setLoading(false)
      abortRef.current = null
      activeRunSessionIdRef.current = null
      void loadConversations()
    }
  }, [activeProviderId, activeTemplate, applyServerDocumentEvents, applyTaskState, assistantMode, editorState, editorView, fetchTasksForConversation, getContext, includeSelection, input, loadConversations, loading, modelName, onActivateTemplate, pageConfig, pendingAttachments, requestOcrAnalysis, resetTextareaHeight, selectedModel, sidebarWidth, syncDocumentSession, templates, viewMode])

  const setInputAndFocus = useCallback((nextInput: string) => {
    setInput(nextInput)
    window.setTimeout(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      textarea.setSelectionRange(nextInput.length, nextInput.length)
      autoResize(textarea)
    }, 0)
  }, [autoResize])

  const insertTemplateLayoutPrompt = useCallback(() => {
    if (!selectedTemplate || loading) return
    setInputAndFocus(`请严格按照当前激活模板「${selectedTemplate.name}」对全文进行排版。优先遵循模板中的 templateText 执行页面、结构、标题和正文样式，并结合批量样式与页面设置完成排版。`)
  }, [loading, selectedTemplate, setInputAndFocus])

  const slashCommandQuery = useMemo(() => {
    if (loading) return null
    const match = input.match(/^\/([^\n]*)$/)
    if (!match) return null
    return String(match[1] || '').trim().toLowerCase()
  }, [input, loading])

  const slashCommands = useMemo<SlashCommandItem[]>(() => {
    const templateCommands: SlashCommandItem[] = templates.map(template => ({
      id: `template:${template.id}`,
      title: template.name,
      detail: template.id === selectedTemplate?.id ? '当前模板' : '设为当前模板',
      keywords: ['模板', 'template', template.name],
      kind: 'template',
    }))

    return [
      {
        id: 'template-layout',
        title: '按当前模板排版',
        detail: selectedTemplate ? selectedTemplate.name : '先选择一个模板',
        keywords: ['模板', '排版', 'layout', 'format'],
        kind: 'action',
        disabled: !selectedTemplate,
      },
      {
        id: 'template-manager',
        title: '打开模板库',
        detail: '上传、管理和编辑模板',
        keywords: ['模板', '管理', 'template', 'library'],
        kind: 'action',
      },
      {
        id: 'ocr-general',
        title: 'OCR 识别',
        detail: '识别已附带图片',
        keywords: ['ocr', '识别', '图片'],
        kind: 'action',
      },
      {
        id: 'ocr-table',
        title: 'OCR 表格',
        detail: '提取图片中的表格',
        keywords: ['ocr', '表格', 'table'],
        kind: 'action',
      },
      {
        id: 'ocr-document',
        title: 'OCR 文档文字',
        detail: '提取扫描件正文',
        keywords: ['ocr', '文档', '文字', 'document', 'text'],
        kind: 'action',
      },
      {
        id: 'ocr-chart',
        title: 'OCR 图表',
        detail: '解析图表内容',
        keywords: ['ocr', '图表', 'chart'],
        kind: 'action',
      },
      {
        id: 'ocr-handwriting',
        title: 'OCR 手写',
        detail: '识别手写内容',
        keywords: ['ocr', '手写', 'handwriting'],
        kind: 'action',
      },
      {
        id: 'ocr-formula',
        title: 'OCR 公式',
        detail: '识别公式和 LaTeX',
        keywords: ['ocr', '公式', 'latex', 'formula'],
        kind: 'action',
      },
      ...templateCommands,
    ]
  }, [activeTemplate, selectedTemplate, templates])

  const visibleSlashCommands = useMemo(() => {
    if (slashCommandQuery === null) return []
    if (!slashCommandQuery) return slashCommands
    return slashCommands.filter(command => {
      const haystack = [command.title, command.detail, ...command.keywords].join(' ').toLowerCase()
      return haystack.includes(slashCommandQuery)
    })
  }, [slashCommandQuery, slashCommands])

  const slashMenuOpen = slashCommandQuery !== null && visibleSlashCommands.length > 0

  useEffect(() => {
    setSlashCommandIndex(0)
  }, [slashCommandQuery, visibleSlashCommands.length])

  const runSlashCommand = useCallback((command: SlashCommandItem | undefined) => {
    if (!command || command.disabled || loading) return
    if (command.id.startsWith('template:')) {
      const templateId = command.id.slice('template:'.length)
      setSelectedTemplateId(templateId)
      setInputAndFocus('')
      void onActivateTemplate(templateId)
      return
    }

    switch (command.id) {
      case 'template-layout':
        insertTemplateLayoutPrompt()
        break
      case 'template-manager':
        setInputAndFocus('')
        onOpenTemplateManager()
        break
      case 'ocr-general':
        setInputAndFocus('/ocr ')
        break
      case 'ocr-table':
        setInputAndFocus('/ocr table ')
        break
      case 'ocr-document':
        setInputAndFocus('/ocr document_text ')
        break
      case 'ocr-chart':
        setInputAndFocus('/ocr chart ')
        break
      case 'ocr-handwriting':
        setInputAndFocus('/ocr handwriting ')
        break
      case 'ocr-formula':
        setInputAndFocus('/ocr formula ')
        break
    }
  }, [insertTemplateLayoutPrompt, loading, onActivateTemplate, onOpenTemplateManager, setInputAndFocus])

  const historyEmpty = !historyLoading && conversations.length === 0
  const groupedConversations = useMemo(() => groupConversationsByTime(conversations), [conversations])

  return (
    <div
      className="relative flex flex-col flex-shrink-0 h-full bg-white border-l border-gray-200 shadow-lg"
      style={{ width: sidebarWidth }}
    >
      <div
        onMouseDown={onDragStart}
        className="absolute left-0 top-0 bottom-0 z-10 w-1 cursor-col-resize transition-colors hover:bg-blue-400 active:bg-blue-500"
        style={{ touchAction: 'none' }}
      />

      {viewMode === 'history' ? (
        <div className="flex items-center justify-between px-3 py-2.5 bg-gray-50 border-b border-gray-200 flex-shrink-0 select-none">
          <div className="min-w-0">
            <span className="font-semibold text-sm truncate text-gray-700">openwps</span>
          </div>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-200 text-lg leading-none flex-shrink-0 text-gray-500"
            title="关闭侧边栏"
          >
            ×
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-3 py-2.5 bg-gray-50 border-b border-gray-200 flex-shrink-0 select-none">
          <button
            onClick={() => {
              setViewMode('history')
            }}
            className="px-1.5 py-0.5 rounded hover:bg-gray-200 text-sm flex-shrink-0 text-gray-600"
            title="返回会话历史"
          >
            ←
          </button>
          <div className="min-w-0 flex-1 font-semibold text-sm truncate text-gray-700">{currentConversationTitle || '新会话'}</div>
          <button
            onClick={() => void exportConversation()}
            className="px-1.5 py-0.5 rounded hover:bg-gray-200 text-sm flex-shrink-0 text-gray-600"
            title="导出当前会话调试 JSON"
          >
            ⤓
          </button>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-200 text-lg leading-none flex-shrink-0 text-gray-500"
            title="关闭侧边栏"
          >
            ×
          </button>
        </div>
      )}

      <div
        ref={scrollAreaRef}
        onScroll={event => {
          const element = event.currentTarget
          const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight
          shouldAutoScrollRef.current = distanceToBottom < 48
        }}
        className="flex-1 overflow-y-auto min-h-0 p-3"
      >
        {viewMode === 'history' ? (
          historyEmpty ? (
            <div className="h-full flex items-center justify-center text-sm text-gray-400">
              暂无会话，输入指令开始
            </div>
          ) : (
            <div className="space-y-2">
              {historyLoading && conversations.length === 0 && (
                <div className="text-sm text-gray-400 text-center py-8">加载中...</div>
              )}
              {groupedConversations.map(group => (
                <section key={group.key} className="space-y-2">
                  <div className="px-1 pt-1 text-[11px] font-medium text-gray-400">{group.label}</div>
                  <div className="space-y-2">
                    {group.conversations.map(conversation => (
                      <div
                        key={conversation.id}
                        role="button"
                        tabIndex={0}
                        aria-disabled={openingConversationId !== null}
                        onClick={() => void openConversation(conversation.id)}
                        onKeyDown={event => {
                          if (event.key !== 'Enter' && event.key !== ' ') return
                          event.preventDefault()
                          void openConversation(conversation.id)
                        }}
                        className="group w-full flex items-center gap-2 rounded-xl border border-gray-200 px-3 py-2 text-left hover:border-blue-300 hover:bg-blue-50 transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-200"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-gray-800 truncate">{truncateTitle(conversation.title || '新会话')}</div>
                          <div className="text-xs text-gray-400 mt-0.5">
                            {openingConversationId === conversation.id
                              ? '打开中...'
                              : conversation.runStatus === 'running'
                                  ? '运行中'
                                  : conversation.runStatus === 'failed'
                                    ? '运行失败'
                                    : formatConversationTime(conversation.updatedAt || conversation.createdAt)}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={event => {
                            event.stopPropagation()
                            void exportConversation(conversation.id)
                          }}
                          className="opacity-0 pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 focus:pointer-events-auto focus:opacity-100 transition-opacity text-gray-400 hover:text-blue-500 text-sm flex-shrink-0"
                          title="导出会话 JSON"
                        >
                          ⤓
                        </button>
                        <button
                          type="button"
                          onClick={event => {
                            event.stopPropagation()
                            void deleteConversation(conversation.id)
                          }}
                          className="opacity-0 pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 focus:pointer-events-auto focus:opacity-100 transition-opacity text-gray-400 hover:text-red-500 text-sm flex-shrink-0"
                          title="删除会话"
                        >
                          🗑
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )
        ) : (
          <div className="space-y-3">
            {messages.length === 0 && (
              <div className="text-sm text-gray-400 text-center py-8">开始一段新的排版对话</div>
            )}

            {/* Task Panel */}
            {tasks.length > 0 && (
              <div className="sticky top-0 z-20 -mx-1 -mt-3 px-1 pb-1">
                <div className="border border-blue-200 rounded-xl overflow-hidden bg-blue-50/95 backdrop-blur-sm shadow-sm flex-shrink-0">
                  {(() => {
                    const activeTask = tasks.find(task => task.status === 'in_progress')
                      ?? tasks.find(task => task.status === 'pending')
                      ?? tasks.at(-1)
                    const taskStats = buildTaskStats(tasks)
                    return (
                      <>
                        <button
                          type="button"
                          onClick={() => setIsTaskPanelExpanded(prev => !prev)}
                          className="w-full flex items-center justify-between px-3 py-2 bg-blue-100 hover:bg-blue-200 transition-colors text-left select-none"
                        >
                          <span className="min-w-0">
                            <span className="text-xs font-semibold text-blue-700 tracking-wide">📋 内部任务</span>
                            {!isTaskPanelExpanded && activeTask && (
                              <span className="mt-0.5 block truncate text-[11px] text-blue-600">
                                {activeTask.status === 'completed' ? '已完成' :
                                  activeTask.status === 'in_progress' ? '进行中' : '待处理'}：{activeTask.subject}
                              </span>
                            )}
                          </span>
                          <span className="text-xs text-blue-500 flex items-center gap-1.5">
                            <span>
                              {taskStats.completed}/{tasks.length}
                            </span>
                            <span>{isTaskPanelExpanded ? '▲' : '▼'}</span>
                          </span>
                        </button>
                        {isTaskPanelExpanded && (
                          <ul className="px-3 py-2 space-y-1.5">
                            {tasks.map(task => (
                              <li key={task.id} className="flex items-start gap-2 text-xs">
                                <span className="flex-shrink-0 mt-px">
                                  {task.status === 'completed' ? '✅' :
                                    task.status === 'in_progress' ? '🔄' :
                                      '⬜'}
                                </span>
                                <span className="min-w-0">
                                  <span
                                    className={
                                      task.status === 'completed'
                                        ? 'text-gray-400 line-through'
                                        : task.status === 'in_progress'
                                          ? 'text-blue-700 font-medium'
                                          : 'text-gray-600'
                                    }
                                  >
                                    {task.subject}
                                    {task.status === 'in_progress' && (
                                      <span
                                        className="ml-1.5 inline-block text-blue-400"
                                        style={{ animation: 'blink 1.2s step-end infinite' }}
                                      >
                                        …
                                      </span>
                                    )}
                                  </span>
                                  {(task.owner || task.blockedBy.length > 0) && (
                                    <span className="mt-0.5 block text-[11px] text-gray-400">
                                      {task.owner ? `owner: ${task.owner}` : ''}
                                      {task.owner && task.blockedBy.length > 0 ? ' · ' : ''}
                                      {task.blockedBy.length > 0 ? `blockedBy: ${task.blockedBy.join(', ')}` : ''}
                                    </span>
                                  )}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </>
                    )
                  })()}
                </div>
              </div>
            )}
            {/* End Task Panel */}

            {/* Agent Panel */}
            {agentRuns.length > 0 && (
              <div className="sticky top-0 z-10 -mx-1 px-1 pb-1">
                <div className="border border-emerald-200 rounded-xl overflow-hidden bg-emerald-50/95 backdrop-blur-sm shadow-sm flex-shrink-0">
                  {(() => {
                    const runningCount = agentRuns.filter(agentRun => agentRun.status === 'running').length
                    const activeAgent = agentRuns.find(agentRun => agentRun.status === 'running') ?? agentRuns[0]
                    return (
                      <>
                        <button
                          type="button"
                          onClick={() => setIsAgentPanelExpanded(prev => !prev)}
                          className="w-full flex items-center justify-between px-3 py-2 bg-emerald-100 hover:bg-emerald-200 transition-colors text-left select-none"
                        >
                          <span className="min-w-0">
                            <span className="text-xs font-semibold text-emerald-700 tracking-wide">Agent 子代理</span>
                            {!isAgentPanelExpanded && activeAgent && (
                              <span className="mt-0.5 block truncate text-[11px] text-emerald-600">
                                {activeAgent.status === 'running' ? '运行中' :
                                  activeAgent.status === 'completed' ? '已完成' :
                                    activeAgent.status === 'cancelled' ? '已取消' : '失败'}：{activeAgent.description || activeAgent.agentType}
                              </span>
                            )}
                          </span>
                          <span className="text-xs text-emerald-500 flex items-center gap-1.5">
                            <span>{runningCount > 0 ? `${runningCount} 运行中` : `${agentRuns.length} 个`}</span>
                            <span>{isAgentPanelExpanded ? '▲' : '▼'}</span>
                          </span>
                        </button>
                        {isAgentPanelExpanded && (
                          <ul className="px-3 py-2 space-y-1.5">
                            {agentRuns.map(agentRun => (
                              <li key={agentRun.id} className="flex items-start gap-2 text-xs">
                                <span className="flex-shrink-0 mt-px">
                                  {agentRun.status === 'completed' ? '✓' :
                                    agentRun.status === 'running' ? '…' :
                                      agentRun.status === 'cancelled' ? '×' : '!'}
                                </span>
                                <span className="min-w-0">
                                  <span
                                    className={
                                      agentRun.status === 'completed'
                                        ? 'text-gray-500'
                                        : agentRun.status === 'running'
                                          ? 'text-emerald-700 font-medium'
                                          : 'text-red-600'
                                    }
                                  >
                                    {agentRun.agentType}：{agentRun.description || agentRun.id}
                                  </span>
                                  {(agentRun.result || agentRun.error) && (
                                    <span className="mt-0.5 block text-[11px] text-gray-500 line-clamp-2">
                                      {agentRun.error || agentRun.result}
                                    </span>
                                  )}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </>
                    )
                  })()}
                </div>
              </div>
            )}
            {/* End Agent Panel */}

            {messages.map(message => (
              <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {message.role === 'user' ? (
                  <div className="flex flex-col items-end gap-1">
                    {message.attachments && message.attachments.length > 0 && (
                      <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
                        {message.attachments.map(attachment => (
                          <div
                            key={attachment.id}
                            className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-2.5 py-2 shadow-sm"
                          >
                            {isImageAttachment(attachment) ? (
                              <img
                                src={attachment.dataUrl}
                                alt={attachment.name}
                                className="h-10 w-10 rounded-xl border border-slate-200 bg-slate-100 object-cover"
                              />
                            ) : (
                              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                                {getAttachmentBadge(attachment)}
                              </div>
                            )}
                            <div className="min-w-0">
                              <div className="max-w-[180px] truncate text-xs font-medium text-slate-700">{attachment.name}</div>
                              <div className="text-[11px] text-slate-400">{formatFileSize(attachment.size)}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div
                      className="bg-blue-500 text-white rounded-2xl rounded-tr-sm px-3 py-2 text-sm"
                      style={{
                        width: message.tightWidth > 0 ? message.tightWidth : undefined,
                        maxWidth: message.tightWidth > 0 ? undefined : '85%',
                        wordBreak: 'break-word',
                        whiteSpace: 'pre-wrap',
                        paddingTop: PADDING_V,
                        paddingBottom: PADDING_V,
                      }}
                    >
                      {message.text}
                    </div>
                    {message.selectionTag && (
                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] bg-blue-50 border border-blue-200 text-blue-500">
                        <span>📎</span>
                        <span className="max-w-[120px] truncate">
                          {message.selectionTag.text.length > 15
                            ? `${message.selectionTag.text.slice(0, 15)}…`
                            : message.selectionTag.text}
                        </span>
                        <span className="opacity-50">P{message.selectionTag.paragraphIndex + 1}</span>
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="w-full min-w-0 space-y-1.5">
                    {message.segments.length > 0 ? (
                      <div className="relative space-y-2 pl-4 before:absolute before:left-[7px] before:top-1 before:bottom-1 before:w-px before:bg-gradient-to-b before:from-slate-200 before:via-slate-200 before:to-transparent">
                        {(() => {
                          let toolSegmentIndex = -1
                          return message.segments.map((segment, segmentIndex) => {
                            if (segment.type === 'content') {
                              const isStreamingSegment = message.streaming && segmentIndex === message.segments.length - 1
                              return isStreamingSegment ? (
                                <div
                                  key={segment.id}
                                  className="relative w-full text-sm text-gray-800 leading-6 before:absolute before:-left-4 before:top-2 before:h-2 before:w-2 before:rounded-full before:bg-slate-300"
                                  style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                                >
                                  {segment.text}
                                  <span
                                    className="inline-block w-0.5 h-4 bg-gray-600 ml-0.5 align-middle"
                                    style={{ animation: 'blink 1s step-end infinite' }}
                                  />
                                </div>
                              ) : (
                                <div
                                  key={segment.id}
                                  className="ai-markdown relative w-full text-sm text-gray-800 leading-6 before:absolute before:-left-4 before:top-2 before:h-2 before:w-2 before:rounded-full before:bg-slate-300"
                                >
                                  {splitMermaidParts(segment.text).map((part, partIdx) =>
                                    part.type === 'mermaid'
                                      ? <MermaidBlock key={partIdx} code={part.code} onInsertToEditor={insertMermaidToEditor} />
                                      : part.content
                                        ? <div key={partIdx} dangerouslySetInnerHTML={{ __html: toHtml(part.content) }} />
                                        : null
                                  )}
                                </div>
                              )
                            }

                            if (segment.type === 'thinking') {
                              const isActiveThinking = message.streaming
                              const isThinkingExpanded = isActiveThinking || message.isThinkingExpanded
                              const trimmedThinking = segment.text.trim()
                              const thinkingPreview = truncateText(trimmedThinking.split(/\n+/)[0] || trimmedThinking, 96)
                              return (
                                <div
                                  key={segment.id}
                                  className="relative border-l-2 border-dashed border-sky-200 bg-sky-50/40 rounded-r-lg py-1.5 pl-3 pr-2 text-[13px] leading-6 text-slate-600 before:absolute before:-left-[18px] before:top-3 before:h-2 before:w-2 before:rounded-full before:bg-sky-300"
                                >
                                  <button
                                    type="button"
                                    onClick={() => {
                                      shouldAutoScrollRef.current = false
                                      setMessages(prev =>
                                        prev.map(m => (m.id === message.id ? { ...m, isThinkingExpanded: !m.isThinkingExpanded } : m)),
                                      )
                                    }}
                                    className="flex items-center gap-1 text-[11px] font-medium text-sky-600 hover:text-sky-700 transition-colors"
                                  >
                                    <span>{isThinkingExpanded ? '▾' : '▸'}</span>
                                    <span>{isActiveThinking ? '思考中...' : '思考过程'}</span>
                                  </button>
                                  {isThinkingExpanded && (
                                    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }} className="mt-1">
                                      {segment.text}
                                    </div>
                                  )}
                                  {!isThinkingExpanded && thinkingPreview && (
                                    <div className="mt-0.5 truncate text-xs text-slate-400">
                                      {thinkingPreview}
                                    </div>
                                  )}
                                </div>
                              )
                            }

                            if (segment.type === 'agent') {
                              const trace = segment.trace
                              return (
                                <AgentTraceBlock
                                  key={segment.id}
                                  trace={trace}
                                  onToggleTrace={() => {
                                    shouldAutoScrollRef.current = false
                                    setMessages(prev => prev.map(item => {
                                      if (item.id !== message.id) return item
                                      return {
                                        ...item,
                                        segments: item.segments.map(currentSegment => (
                                          currentSegment.type === 'agent' && currentSegment.trace.id === trace.id
                                            ? { ...currentSegment, trace: { ...currentSegment.trace, isExpanded: currentSegment.trace.isExpanded === false } }
                                            : currentSegment
                                        )),
                                      }
                                    }))
                                  }}
                                  onToggleEvent={(eventId: string) => {
                                    shouldAutoScrollRef.current = false
                                    setMessages(prev => prev.map(item => {
                                      if (item.id !== message.id) return item
                                      return {
                                        ...item,
                                        segments: item.segments.map(currentSegment => (
                                          currentSegment.type === 'agent' && currentSegment.trace.id === trace.id
                                            ? {
                                                ...currentSegment,
                                                trace: {
                                                  ...currentSegment.trace,
                                                  events: currentSegment.trace.events.map(event => (
                                                    event.id === eventId ? { ...event, isExpanded: !event.isExpanded } : event
                                                  )),
                                                },
                                              }
                                            : currentSegment
                                        )),
                                      }
                                    }))
                                  }}
                                />
                              )
                            }

                            toolSegmentIndex += 1
                            const toolIndex = toolSegmentIndex
                            const toolCall = segment.toolCall

                            // 生成紧凑摘要，特殊处理 TaskCreate / TaskUpdate
                            let summaryText = summarizeToolPurpose(toolCall)
                            if (toolCall.name === 'TaskCreate') {
                              summaryText = typeof toolCall.params.subject === 'string'
                                ? `创建内部任务：${toolCall.params.subject}`
                                : '创建 AI 内部任务'
                            } else if (toolCall.name === 'TaskUpdate') {
                              const taskId = typeof toolCall.params.taskId === 'string' ? toolCall.params.taskId : ''
                              const status = typeof toolCall.params.status === 'string' ? toolCall.params.status : ''
                              summaryText = taskId
                                ? `更新任务 #${taskId}${status ? ` → ${status}` : ''}`
                                : '更新 AI 内部任务'
                            }

                            return (
                              <div key={segment.id} className="relative space-y-1 before:absolute before:-left-4 before:top-2 before:h-2 before:w-2 before:rounded-full before:bg-slate-300">
                                <button
                                  type="button"
                                  className={`group w-full text-left text-xs ${toolCall.status === 'ok'
                                    ? 'text-green-700'
                                    : toolCall.status === 'err'
                                      ? 'text-red-600'
                                      : 'text-gray-400'
                                    }`}
                                  onClick={() => {
                                    shouldAutoScrollRef.current = false
                                    setMessages(prev =>
                                      prev.map(item => {
                                        if (item.id !== message.id) return item
                                        const isExpanded = !toolCall.isExpanded
                                        const nextToolCalls = item.toolCalls.map((currentToolCall, currentIndex) => (
                                          currentIndex === toolIndex
                                            ? { ...currentToolCall, isExpanded }
                                            : currentToolCall
                                        ))
                                        let currentToolIdx = -1
                                        const nextSegments = item.segments.map(currentSegment => {
                                          if (currentSegment.type !== 'tool') return currentSegment
                                          currentToolIdx += 1
                                          return currentToolIdx === toolIndex
                                            ? { ...currentSegment, toolCall: { ...currentSegment.toolCall, isExpanded } }
                                            : currentSegment
                                        })
                                        return { ...item, toolCalls: nextToolCalls, segments: nextSegments }
                                      }),
                                    )
                                  }}
                                >
                                  <div className="flex items-start gap-2">
                                    <span className={`mt-0.5 flex-shrink-0 ${toolCall.status === 'pending' ? 'ai-status-pulse' : ''}`}>
                                      {toolCall.status === 'ok' ? '✅' : toolCall.status === 'err' ? '❌' : '⏳'}
                                    </span>
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0 flex-1">
                                          <span className="font-mono break-all text-[11px] text-gray-700">{toolCall.name}</span>
                                          <span className="mx-1.5 text-[10px] text-gray-300">·</span>
                                          <span className="text-[11px] text-gray-500">{summaryText}</span>
                                        </div>
                                        <span className="flex-shrink-0 text-[11px] text-gray-400">
                                          {toolCall.isExpanded ? '▾' : '▸'}
                                        </span>
                                      </div>

                                      {toolCall.isExpanded && (
                                        <div className="mt-2 space-y-2">
                                          <div>
                                            <div className="text-[10px] uppercase tracking-wide text-gray-400">params</div>
                                            <pre className="mt-1 whitespace-pre-wrap break-all text-[11px] leading-4 opacity-80 bg-white border border-gray-200 rounded-md px-2 py-1 text-gray-700">
                                              {formatToolParams(toolCall.params)}
                                            </pre>
                                          </div>
                                          {toolCall.data != null && (
                                            <div>
                                              <div className="text-[10px] uppercase tracking-wide text-gray-400">data</div>
                                              <pre className="mt-1 whitespace-pre-wrap break-all text-[11px] leading-4 opacity-90 bg-white border border-gray-200 rounded-md px-2 py-1 max-h-72 overflow-auto text-gray-700">
                                                {formatToolData(toolCall.data)}
                                              </pre>
                                            </div>
                                          )}
                                          {toolCall.message && (
                                            <div className="text-[11px] leading-4 text-gray-500 break-all">{toolCall.message}</div>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                </button>
                              </div>
                            )
                          })
                        })()}
                      </div>
                    ) : message.streaming ? (
                      <div className="text-sm text-gray-400 leading-6">等待模型开始输出...</div>
                    ) : null}

                    {message.streaming && message.activityLabel && (
                      <div className="inline-flex items-center gap-2 rounded-full border border-blue-100 bg-blue-50/80 px-3 py-1 text-[11px] text-blue-600">
                        <span className="inline-flex h-2 w-2 rounded-full bg-blue-400 ai-status-pulse" />
                        <span className="ai-status-glow">{message.activityLabel}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}

            {loading && !messages.find(message => message.streaming) && (
              <div className="flex justify-start">
                <div className="rounded-2xl rounded-tl-sm px-3 py-2 bg-gray-100">
                  <span className="inline-flex gap-1">
                    {[0, 150, 300].map(delay => (
                      <span
                        key={delay}
                        className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce"
                        style={{ animationDelay: `${delay}ms` }}
                      />
                    ))}
                  </span>
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <div className="border-t border-gray-200 p-2.5 flex-shrink-0">
        {(() => {
          const sel = editorState ? serializeSelection(editorState) : null
          const hasTopContent = Boolean(sel) || pendingAttachments.length > 0
          const hasPendingImageAttachment = pendingAttachments.some(isImageAttachment)

          return (
            <div className="rounded-[24px] border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.06)] overflow-hidden">
              <input
                ref={imageInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={async event => {
                  try {
                    await handleAttachmentPick(event.target.files)
                  } catch (error) {
                    console.error('[AISidebar] pick attachment failed', error)
                  } finally {
                    event.target.value = ''
                  }
                }}
              />

              <div className="border-b border-slate-100 bg-slate-50/80 px-3 py-2">
                {hasTopContent ? (
                  <div className="flex flex-wrap gap-2">
                    {pendingAttachments.map(attachment => (
                      <div
                        key={attachment.id}
                        className="group flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-2 py-2 shadow-sm"
                      >
                        {isImageAttachment(attachment) ? (
                          <img
                            src={attachment.dataUrl}
                            alt={attachment.name}
                            className="h-10 w-10 rounded-xl object-cover border border-slate-200 bg-slate-100"
                          />
                        ) : (
                          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                            {getAttachmentBadge(attachment)}
                          </div>
                        )}
                        <div className="min-w-0">
                          <div className="max-w-[160px] truncate text-xs font-medium text-slate-700">{attachment.name}</div>
                          <div className="text-[11px] text-slate-400">{getAttachmentBadge(attachment)} · {formatFileSize(attachment.size)}</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => removePendingAttachment(attachment.id)}
                          className="flex h-6 w-6 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                          title="移除附件"
                        >
                          ×
                        </button>
                      </div>
                    ))}

                    {sel && (
                      <button
                        type="button"
                        onMouseDown={event => {
                          event.preventDefault()
                          setIncludeSelection(prev => !prev)
                        }}
                        className={`inline-flex max-w-full items-center gap-2 rounded-2xl border px-3 py-2 text-left text-xs transition-colors ${includeSelection
                          ? 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100'
                          : 'border-slate-200 bg-slate-100 text-slate-400 hover:bg-slate-200 line-through'
                          }`}
                        title={includeSelection ? '点击取消携带选中内容' : '点击携带选中内容'}
                      >
                        <span className="text-sm">“</span>
                        <span className="max-w-[180px] truncate">
                          {sel.selectedText.length > 36
                            ? `${sel.selectedText.slice(0, 36)}…`
                            : sel.selectedText}
                        </span>
                        <span className="rounded-full bg-white/80 px-1.5 py-0.5 text-[10px] text-current">
                          引用 P{sel.paragraphIndex + 1}
                        </span>
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="text-xs text-slate-400">
                    {currentModelSupportsVision
                      ? '上传图片、文本或 DOCX 附件后会随本轮请求一起发送；表格、图表、手写识别可继续用 /ocr。'
                      : '当前模型未明确标记为多模态，图片仍会尝试发送；文本和 DOCX 附件会先提取内容再发送。'}
                  </div>
                )}
                {hasPendingImageAttachment && !isOcrReady && /(^\/ocr\b)|(识别|提取|解析|读取).*(表格|图表|手写|公式|扫描件|文档文字)/.test(input.trim()) && (
                  <div className="mt-2 text-[11px] text-amber-600">
                    当前命中了 OCR 专用识别请求，但 OCR 配置未就绪；请先在设置中补充 OCR 模型、端点和 API Key。
                  </div>
                )}
              </div>

              {slashMenuOpen && (
                <div className="border-b border-slate-100 bg-white px-2 py-2">
                  <div className="max-h-80 overflow-y-auto">
                    {visibleSlashCommands.some(command => command.kind === 'action') && (
                      <div className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">指令</div>
                    )}
                    {visibleSlashCommands.map((command, index) => {
                      if (command.kind !== 'action') return null
                      const isSelected = index === Math.min(slashCommandIndex, visibleSlashCommands.length - 1)
                      return (
                        <button
                          key={command.id}
                          type="button"
                          onMouseDown={event => event.preventDefault()}
                          onClick={() => runSlashCommand(command)}
                          disabled={command.disabled || loading}
                          className={`flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:text-slate-300 ${isSelected
                            ? 'bg-slate-100 text-slate-900'
                            : 'text-slate-700 hover:bg-slate-50'
                            }`}
                        >
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-[12px] font-semibold text-slate-500">
                            /
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{command.title}</span>
                            <span className="block truncate text-xs text-slate-400">{command.detail}</span>
                          </span>
                        </button>
                      )
                    })}
                    {visibleSlashCommands.some(command => command.kind === 'template') && (
                      <div className="mt-1 border-t border-slate-100 px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-slate-400">
                        选择模板
                      </div>
                    )}
                    {visibleSlashCommands.map((command, index) => {
                      if (command.kind !== 'template') return null
                      const isSelected = index === Math.min(slashCommandIndex, visibleSlashCommands.length - 1)
                      const isActiveTemplate = command.id === `template:${selectedTemplate?.id ?? ''}`
                      return (
                        <button
                          key={command.id}
                          type="button"
                          onMouseDown={event => event.preventDefault()}
                          onClick={() => runSlashCommand(command)}
                          disabled={command.disabled || loading}
                          className={`flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:text-slate-300 ${isSelected
                            ? 'bg-blue-50 text-blue-800'
                            : isActiveTemplate
                              ? 'text-blue-700 hover:bg-blue-50'
                              : 'text-slate-700 hover:bg-slate-50'
                            }`}
                          title={command.title}
                        >
                          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border text-[12px] font-semibold ${isActiveTemplate ? 'border-blue-200 bg-blue-50 text-blue-600' : 'border-slate-200 bg-white text-slate-400'}`}>
                            {isActiveTemplate ? '✓' : ''}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{command.title}</span>
                            <span className="block truncate text-xs text-slate-400">{command.detail}</span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              <div className="px-3 py-2.5">
                <textarea
                  ref={textareaRef}
                  className="w-full resize-none border-0 bg-transparent text-sm leading-6 text-slate-800 outline-none placeholder:text-slate-400"
                  rows={3}
                  placeholder={
                    assistantMode === 'agent'
                      ? (viewMode === 'history' ? '输入写作或排版需求，Agent 会边写边排…' : '继续让 Agent 写内容、调样式或处理分页…')
                      : assistantMode === 'layout'
                        ? (viewMode === 'history' ? '输入排版指令，自动新建会话…' : '继续输入排版指令…')
                        : (viewMode === 'history' ? '输入写作/删改指令，自动新建会话…' : '继续输入写作/删改指令…')
                  }
                  value={input}
                  style={{ minHeight: '72px', maxHeight: '200px', overflowY: 'auto' }}
                  onChange={event => {
                    setInput(event.target.value)
                    autoResize(event.target)
                  }}
                  onPaste={event => {
                    const pastedImageFiles = extractClipboardImageFiles(event)
                    if (pastedImageFiles.length === 0) return
                    event.preventDefault()
                    void appendPendingAttachments(pastedImageFiles)
                  }}
                  onCompositionStart={() => {
                    isComposingRef.current = true
                  }}
                  onCompositionEnd={() => {
                    isComposingRef.current = false
                  }}
                  onKeyDown={event => {
                    if (slashMenuOpen) {
                      if (event.key === 'ArrowDown') {
                        event.preventDefault()
                        setSlashCommandIndex(prev => (prev + 1) % visibleSlashCommands.length)
                        return
                      }
                      if (event.key === 'ArrowUp') {
                        event.preventDefault()
                        setSlashCommandIndex(prev => (prev - 1 + visibleSlashCommands.length) % visibleSlashCommands.length)
                        return
                      }
                      if (event.key === 'Enter' || event.key === 'Tab') {
                        event.preventDefault()
                        runSlashCommand(visibleSlashCommands[slashCommandIndex])
                        return
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        setInput('')
                        return
                      }
                    }
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !isComposingRef.current) {
                      event.preventDefault()
                      void handleSend()
                    }
                  }}
                  disabled={loading}
                />
              </div>

              <div className="border-t border-slate-100 bg-slate-50/90 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => imageInputRef.current?.click()}
                    disabled={loading}
                    className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-base transition-colors ${loading ? 'cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100'}`}
                    title="添加图片或文件附件"
                  >
                    ＋
                  </button>

                  <ModelPicker
                    models={availableModels}
                    value={selectedModel || modelName || ''}
                    onChange={setSelectedModel}
                    disabled={loading || modelsLoading}
                    loading={modelsLoading}
                    placeholder={availableModels.length === 0 && !modelName ? '未配置模型' : modelName || '选择模型'}
                  />

                  <label className="flex shrink-0 items-center gap-2 rounded-full border border-slate-200 bg-white pl-3 pr-2 py-1.5 text-[11px] text-slate-500">
                    <span className="shrink-0">模式</span>
                    <select
                      value={assistantMode}
                      onChange={event => setAssistantMode(event.target.value as AssistantMode)}
                      disabled={loading}
                      className="bg-transparent pr-1 text-slate-700 outline-none"
                      title="切换 Agent / 排版 / Edit 模式"
                    >
                      <option value="agent">Agent</option>
                      <option value="layout">排版</option>
                      <option value="edit">Edit</option>
                    </select>
                  </label>

                  <div className="ml-auto shrink-0">
                    {loading ? (
                      <button
                        onClick={handleCancel}
                        className="inline-flex h-9 min-w-9 items-center justify-center rounded-full bg-red-500 px-3 text-sm text-white transition-colors hover:bg-red-600"
                        title="取消"
                      >
                        ⏹
                      </button>
                    ) : (
                      <button
                        onClick={() => void handleSend()}
                        disabled={!canSendMessage}
                        className="inline-flex h-9 min-w-9 items-center justify-center rounded-full bg-slate-900 px-3 text-sm text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                        title="发送 (Enter)"
                      >
                        ↑
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )
        })()}
      </div>

      <style>{`
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
        @keyframes shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
        @keyframes pulse-soft { 0%,100%{transform:scale(1);opacity:.8} 50%{transform:scale(1.18);opacity:1} }
        .ai-status-glow {
          background-image: linear-gradient(90deg, #64748b 0%, #3b82f6 35%, #0f172a 50%, #3b82f6 65%, #64748b 100%);
          background-size: 200% 100%;
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
          animation: shimmer 2s linear infinite;
        }
        .ai-status-pulse {
          animation: pulse-soft 1.1s ease-in-out infinite;
        }
      `}</style>
    </div>
  )
}
