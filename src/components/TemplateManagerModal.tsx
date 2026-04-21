import { useEffect, useMemo, useRef, useState } from 'react'
import type { TemplateRecord, TemplateSummary } from '../templates/types'

type TemplateExtractionStatus = 'idle' | 'preparing' | 'analyzing' | 'saving' | 'success' | 'error'

interface TemplateExtractionState {
  status: TemplateExtractionStatus
  fileName: string
  providerId: string
  model: string
  message: string
  errorMessage: string
  startedAt: string
  finishedAt: string
  resultTemplateId?: string
}

interface Props {
  templates: TemplateSummary[]
  activeTemplateId: string | null
  activeTemplate: TemplateRecord | null
  extractionState: TemplateExtractionState
  isExtracting: boolean
  onClose: () => void
  onUpload: (file: File) => void | Promise<void>
  onLoadDetail: (id: string) => Promise<TemplateRecord>
  onActivate: (id: string) => void | Promise<void>
  onDelete: (id: string) => void | Promise<void>
  onRename: (id: string, payload: { name: string; note: string; templateText: string }) => TemplateRecord | Promise<TemplateRecord>
}

function formatTime(value: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function TemplateManagerModal({
  templates,
  activeTemplateId,
  activeTemplate,
  extractionState,
  isExtracting,
  onClose,
  onUpload,
  onLoadDetail,
  onActivate,
  onDelete,
  onRename,
}: Props) {
  const uploadRef = useRef<HTMLInputElement>(null)
  const [selectedId, setSelectedId] = useState<string | null>(activeTemplateId ?? templates[0]?.id ?? null)
  const [selectedTemplateDetail, setSelectedTemplateDetail] = useState<TemplateRecord | null>(activeTemplate)
  const [detailLoading, setDetailLoading] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftNote, setDraftNote] = useState('')
  const [draftTemplateText, setDraftTemplateText] = useState('')

  useEffect(() => {
    setSelectedId((current) => {
      if (extractionState.resultTemplateId && templates.some((item) => item.id === extractionState.resultTemplateId)) {
        return extractionState.resultTemplateId
      }
      if (current && templates.some((item) => item.id === current)) return current
      return activeTemplateId ?? templates[0]?.id ?? null
    })
  }, [activeTemplateId, extractionState.resultTemplateId, templates])

  const selectedTemplate = useMemo(
    () => templates.find((item) => item.id === selectedId) ?? null,
    [selectedId, templates],
  )

  useEffect(() => {
    let active = true
    if (!selectedId) {
      setDetailLoading(false)
      setSelectedTemplateDetail(null)
      return () => {
        active = false
      }
    }

    if (activeTemplate?.id === selectedId) {
      setDetailLoading(false)
      setSelectedTemplateDetail(activeTemplate)
      return () => {
        active = false
      }
    }

    setDetailLoading(true)
    void onLoadDetail(selectedId)
      .then((detail) => {
        if (!active) return
        setSelectedTemplateDetail(detail)
      })
      .catch((error) => {
        console.error('[TemplateManagerModal] load template detail failed', error)
        if (!active) return
        setSelectedTemplateDetail(null)
      })
      .finally(() => {
        if (active) setDetailLoading(false)
      })

    return () => {
      active = false
    }
  }, [activeTemplate, onLoadDetail, selectedId])

  useEffect(() => {
    setDraftName(selectedTemplateDetail?.name ?? selectedTemplate?.name ?? '')
    setDraftNote(selectedTemplateDetail?.note ?? selectedTemplate?.note ?? '')
    const rawText = selectedTemplateDetail?.templateText ?? ''
    setDraftTemplateText(rawText.replace(/\\n/g, '\n').replace(/\\r/g, ''))
  }, [selectedTemplate, selectedTemplateDetail])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const canSave = Boolean(
    selectedTemplateDetail
    && draftName.trim()
    && draftTemplateText.trim()
    && !isExtracting
    && (
      draftName !== selectedTemplateDetail.name
      || draftNote !== selectedTemplateDetail.note
      || draftTemplateText !== selectedTemplateDetail.templateText
    ),
  )

  const showExtractionCard = extractionState.status !== 'idle'
  const extractionTone = extractionState.status === 'error'
    ? 'border-red-200 bg-red-50 text-red-700'
    : extractionState.status === 'success'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : 'border-blue-200 bg-blue-50 text-blue-700'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-2xl w-[920px] max-w-[96vw] mx-4 flex flex-col" style={{ maxHeight: '88vh' }}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 flex-shrink-0">
          <div>
            <h2 className="font-semibold text-gray-800 text-base">模板库</h2>
            <div className="text-xs text-gray-400 mt-1">上传 DOCX 模板后，会自动生成排版指导并可在 AI 中直接引用。</div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 text-xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="w-[360px] border-r border-gray-100 px-4 py-4 flex flex-col gap-3">
            {showExtractionCard && (
              <div className={`rounded-xl border px-3 py-3 text-sm space-y-2 ${extractionTone}`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="font-medium">
                    {extractionState.status === 'preparing' && '正在准备模板证据'}
                    {extractionState.status === 'analyzing' && '正在提取模板信息'}
                    {extractionState.status === 'saving' && '正在保存模板'}
                    {extractionState.status === 'success' && '模板提取完成'}
                    {extractionState.status === 'error' && '模板提取失败'}
                  </div>
                  {isExtracting && <span className="text-[11px]">进行中</span>}
                </div>
                <div className="text-xs leading-5">
                  <div>文件：{extractionState.fileName || '未命名模板'}</div>
                  <div>模型：{extractionState.providerId || '未识别服务商'} / {extractionState.model || '未识别模型'}</div>
                  <div>开始时间：{formatTime(extractionState.startedAt)}</div>
                  {(extractionState.finishedAt || !isExtracting) && extractionState.finishedAt && (
                    <div>结束时间：{formatTime(extractionState.finishedAt)}</div>
                  )}
                </div>
                {extractionState.message && (
                  <div className="text-xs leading-5">{extractionState.message}</div>
                )}
                {extractionState.errorMessage && (
                  <div className="rounded-lg bg-white/70 px-2.5 py-2 text-xs leading-5 text-red-700">
                    {extractionState.errorMessage}
                  </div>
                )}
                {extractionState.status === 'success' && extractionState.resultTemplateId && (
                  <button
                    type="button"
                    onClick={() => setSelectedId(extractionState.resultTemplateId ?? null)}
                    className="text-xs underline underline-offset-2"
                  >
                    查看新模板
                  </button>
                )}
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                onClick={() => uploadRef.current?.click()}
                disabled={isExtracting}
                className="px-3 py-2 text-sm rounded-lg bg-blue-500 text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {isExtracting ? '提取中...' : '上传模板'}
              </button>
              <div className="text-xs text-gray-400">仅支持 `.docx`</div>
            </div>

            <div className="overflow-y-auto flex-1 space-y-2 pr-1">
              {templates.length === 0 ? (
                <div className="text-sm text-gray-500 border border-dashed border-gray-300 rounded-xl p-4">
                  还没有模板。上传一个 DOCX 模板后，这里会自动生成可复用的排版模板。
                </div>
              ) : (
                templates.map((template) => {
                  const active = template.id === activeTemplateId
                  const selected = template.id === selectedId
                  return (
                    <button
                      key={template.id}
                      type="button"
                      onClick={() => setSelectedId(template.id)}
                      className={`w-full text-left border rounded-xl px-3 py-3 transition-colors ${selected ? 'border-blue-400 bg-blue-50/70' : 'border-gray-200 hover:bg-gray-50'}`}
                    >
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <div className="text-sm font-medium text-gray-800 truncate">{template.name}</div>
                            {active && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700">当前激活</span>
                            )}
                          </div>
                          <div className="text-xs text-gray-400 mt-1">{formatTime(template.updatedAt)}</div>
                        </div>
                      </div>
                      <div className="text-xs text-gray-500 mt-2 line-clamp-3">{template.summary}</div>
                    </button>
                  )
                })
              )}
            </div>
          </div>

          <div className="flex-1 min-w-0 px-5 py-4 overflow-y-auto">
            {selectedTemplate ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="block text-xs font-medium text-gray-500">模板名称</label>
                  <input
                    type="text"
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                    disabled={isExtracting}
                    className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
                  />
                </div>

                <div className="space-y-2">
                  <label className="block text-xs font-medium text-gray-500">备注</label>
                  <textarea
                    value={draftNote}
                    onChange={(event) => setDraftNote(event.target.value)}
                    rows={3}
                    disabled={isExtracting}
                    className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
                    placeholder="例如：学校毕业论文模板 / 公司周报模板"
                  />
                </div>

                <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600 space-y-2">
                  <div><span className="font-medium text-gray-800">摘要：</span>{selectedTemplate.summary}</div>
                  <div><span className="font-medium text-gray-800">源文件：</span>{selectedTemplate.sourceFilename}</div>
                </div>

                <div className="space-y-2">
                  <label className="block text-xs font-medium text-gray-500">模板内容</label>
                  {detailLoading && (
                    <div className="text-xs text-gray-400">正在加载模板详情...</div>
                  )}
                  <textarea
                    value={draftTemplateText}
                    onChange={(event) => setDraftTemplateText(event.target.value)}
                    rows={20}
                    disabled={isExtracting}
                    className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
                    placeholder={detailLoading ? '模板正文加载中...' : 'AI 生成的模板内容会显示在这里，可直接编辑修改'}
                  />
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void onActivate(selectedTemplate.id)}
                    disabled={isExtracting}
                    className={`px-4 py-2 text-sm rounded-lg ${selectedTemplate.id === activeTemplateId ? 'bg-emerald-500 text-white hover:bg-emerald-600' : 'bg-blue-500 text-white hover:bg-blue-600'}`}
                  >
                    {selectedTemplate.id === activeTemplateId ? '重新激活到当前会话' : '设为当前模板'}
                  </button>
                  <button
                    onClick={() => {
                      void Promise.resolve(onRename(selectedTemplate.id, {
                        name: draftName.trim(),
                        note: draftNote,
                        templateText: draftTemplateText.trim(),
                      })).then((updated) => {
                        setSelectedTemplateDetail(updated)
                      }).catch((error) => {
                        console.error('[TemplateManagerModal] save template failed', error)
                      })
                    }}
                    disabled={!canSave}
                    className="px-4 py-2 text-sm rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    保存模板
                  </button>
                  <button
                    onClick={() => void onDelete(selectedTemplate.id)}
                    disabled={isExtracting}
                    className="px-4 py-2 text-sm rounded-lg border border-red-200 text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    删除模板
                  </button>
                </div>
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-sm text-gray-500">
                选择左侧模板，或先上传一个新的 DOCX 模板。
              </div>
            )}
          </div>
        </div>

        <input
          ref={uploadRef}
          type="file"
          accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.currentTarget.value = ''
            if (file) void onUpload(file)
          }}
        />
      </div>
    </div>
  )
}
