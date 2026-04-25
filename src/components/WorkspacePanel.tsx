import React from 'react'
import {
  AlertCircle,
  FileText,
  FolderOpen,
  Presentation,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

interface WorkspaceDoc {
  id: string
  name: string
  type: string
  size: number
  textLength: number
  uploadedAt: string
}

const TYPE_ICONS: Record<string, LucideIcon> = {
  docx: FileText,
  txt: FileText,
  md: FileText,
  markdown: FileText,
  pdf: FileText,
  ppt: Presentation,
  pptx: Presentation,
}

const TYPE_LABELS: Record<string, string> = {
  docx: 'DOCX',
  txt: 'TXT',
  md: 'MD',
  markdown: 'MD',
  pdf: 'PDF',
  ppt: 'PPT',
  pptx: 'PPTX',
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function WorkspacePanel({ onClose }: { onClose: () => void }) {
  const [docs, setDocs] = React.useState<WorkspaceDoc[]>([])
  const [loading, setLoading] = React.useState(false)
  const [uploading, setUploading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [dragActive, setDragActive] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const fetchDocs = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/workspace')
      if (!res.ok) throw new Error('获取文档列表失败')
      setDocs(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : '未知错误')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { fetchDocs() }, [fetchDocs])

  const handleUpload = React.useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setUploading(true)
    setError(null)
    let lastError: string | null = null
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const formData = new FormData()
      formData.append('file', file)
      try {
        const res = await fetch('/api/workspace/upload', { method: 'POST', body: formData })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          lastError = data.detail || `上传 ${file.name} 失败`
        }
      } catch {
        lastError = `上传 ${file.name} 失败`
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = ''
    setUploading(false)
    if (lastError) setError(lastError)
    fetchDocs()
  }, [fetchDocs])

  const handleDelete = React.useCallback(async (docId: string) => {
    try {
      const res = await fetch(`/api/workspace/${docId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('删除失败')
      setDocs(prev => prev.filter(d => d.id !== docId))
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败')
    }
  }, [])

  const handleDrop = React.useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)
    if (e.dataTransfer.files.length > 0) handleUpload(e.dataTransfer.files)
  }, [handleUpload])

  const allowedExts = '.docx,.txt,.md,.markdown,.pdf,.ppt,.pptx'
  const docCountText = docs.length === 0 ? '暂无文档' : `${docs.length} 个文档`

  return (
    <div
      data-openwps-workspace-panel="true"
      className={`relative flex h-full flex-shrink-0 flex-col border-r bg-white transition-colors ${dragActive ? 'border-blue-300 shadow-[inset_0_0_0_2px_rgba(37,99,235,0.18)]' : 'border-gray-200'}`}
      style={{ width: 'clamp(280px, 18vw, 300px)' }}
      onDragEnter={e => {
        e.preventDefault()
        e.stopPropagation()
        setDragActive(true)
      }}
      onDragOver={e => {
        e.preventDefault()
        e.stopPropagation()
        setDragActive(true)
      }}
      onDragLeave={e => {
        e.preventDefault()
        e.stopPropagation()
        if (e.currentTarget === e.target) setDragActive(false)
      }}
      onDrop={handleDrop}
    >
      <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-gray-100 px-4 py-3 select-none">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
            <FolderOpen size={18} strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-gray-900">工作区</div>
            <div className="text-xs text-gray-400">{docCountText}</div>
          </div>
        </div>
        <button
          onClick={onClose}
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700"
          title="关闭工作区"
        >
          <X size={16} strokeWidth={2} />
        </button>
      </div>

      <div className="flex flex-shrink-0 flex-col gap-1.5 px-4 py-3">
        <button
          type="button"
          data-openwps-workspace-upload-button="true"
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex h-9 w-full items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-blue-600 px-3 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
          disabled={uploading}
          title="上传工作区参考文档"
        >
          <Upload size={16} strokeWidth={2.2} className="flex-shrink-0" />
          <span>{uploading ? '上传中...' : '上传文件'}</span>
        </button>
        <div className="text-[11px] leading-4 text-gray-400">
          支持 DOCX、TXT、MD、PDF、PPT
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept={allowedExts}
          multiple
          onChange={e => handleUpload(e.target.files)}
          className="hidden"
        />
      </div>

      {dragActive && (
        <div className="mx-4 mb-3 rounded-lg border border-dashed border-blue-300 bg-blue-50 px-3 py-2 text-center text-xs font-medium text-blue-600">
          松开鼠标上传到工作区
        </div>
      )}

      {error && (
        <div className="mx-4 mb-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
          <AlertCircle size={14} strokeWidth={2} className="mt-0.5 flex-shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600" title="关闭错误提示">
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {loading && docs.length === 0 ? (
          <div className="mt-12 text-center text-sm text-gray-400">加载中...</div>
        ) : docs.length === 0 ? (
          <div className="mt-16 flex flex-col items-center text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-50 text-gray-400">
              <FolderOpen size={24} strokeWidth={1.8} />
            </div>
            <div className="text-sm font-medium text-gray-700">暂无参考文档</div>
            <div className="mt-1 max-w-[210px] text-xs leading-5 text-gray-400">上传资料后，AI 可以在写作时检索并引用这些内容。</div>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              <Upload size={14} strokeWidth={2} />
              上传文件
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {docs.map(doc => (
              <WorkspaceDocRow key={doc.id} doc={doc} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function WorkspaceDocRow({
  doc,
  onDelete,
}: {
  doc: WorkspaceDoc
  onDelete: (docId: string) => void
}) {
  const Icon = TYPE_ICONS[doc.type] || FileText

  return (
    <div data-openwps-workspace-doc-row="true" className="group flex items-start gap-3 rounded-xl border border-gray-100 bg-white px-3 py-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:border-blue-100 hover:bg-blue-50/40">
      <span className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-gray-50 text-gray-500 group-hover:bg-white group-hover:text-blue-600">
        <Icon size={18} strokeWidth={1.9} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-gray-800" title={doc.name}>{doc.name}</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] leading-4 text-gray-400">
          <span>{TYPE_LABELS[doc.type] || doc.type.toUpperCase()}</span>
          <span>·</span>
          <span>{formatSize(doc.size)}</span>
          {doc.textLength > 0 && (
            <>
              <span>·</span>
              <span>{doc.textLength.toLocaleString()} 字</span>
            </>
          )}
        </div>
      </div>
      <button
        data-openwps-workspace-delete="true"
        onClick={() => onDelete(doc.id)}
        className="mt-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-gray-300 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-500 group-hover:opacity-100"
        title="删除"
      >
        <Trash2 size={14} strokeWidth={2} />
      </button>
    </div>
  )
}
