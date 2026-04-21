import React from 'react'

interface WorkspaceDoc {
  id: string
  name: string
  type: string
  size: number
  textLength: number
  uploadedAt: string
}

const TYPE_ICONS: Record<string, string> = {
  docx: '📄',
  txt: '📝',
  md: '📝',
  markdown: '📝',
  pdf: '📕',
  ppt: '📊',
  pptx: '📊',
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
    if (e.dataTransfer.files.length > 0) handleUpload(e.dataTransfer.files)
  }, [handleUpload])

  const allowedExts = '.docx,.txt,.md,.markdown,.pdf,.ppt,.pptx'

  return (
    <div
      className="relative flex flex-col flex-shrink-0 h-full bg-white border-r border-gray-200 shadow-lg"
      style={{ width: 260 }}
    >
      <div className="flex items-center justify-between px-3 py-2.5 bg-gray-50 border-b border-gray-200 flex-shrink-0 select-none">
        <span className="font-semibold text-sm text-gray-700">📁 工作区</span>
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-200 text-lg leading-none flex-shrink-0 text-gray-500"
          title="关闭工作区"
        >
          ×
        </button>
      </div>

      <div
        className="flex-shrink-0 mx-3 mt-3 mb-2 border-2 border-dashed border-gray-300 rounded-lg p-4 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/50 transition-colors"
        onDragOver={e => { e.preventDefault(); e.stopPropagation() }}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <div className="text-2xl mb-1">{uploading ? '⏳' : '📂'}</div>
        <div className="text-sm text-gray-600 font-medium">
          {uploading ? '上传中...' : '点击或拖放上传文件'}
        </div>
        <div className="text-xs text-gray-400 mt-1">
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

      {error && (
        <div className="mx-3 mb-2 px-2 py-1 bg-red-50 border border-red-200 rounded text-xs text-red-600 flex items-start gap-1">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600">×</button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto min-h-0 px-3 pb-3">
        {loading && docs.length === 0 ? (
          <div className="text-center text-sm text-gray-400 mt-8">加载中...</div>
        ) : docs.length === 0 ? (
          <div className="text-center text-sm text-gray-400 mt-8">
            暂无参考文档<br />
            <span className="text-xs">上传文档供 AI 查阅</span>
          </div>
        ) : (
          <div className="space-y-1.5">
            {docs.map(doc => (
              <div
                key={doc.id}
                className="group flex items-start gap-2 px-2 py-1.5 rounded hover:bg-gray-50 transition-colors"
              >
                <span className="text-base mt-0.5 flex-shrink-0">
                  {TYPE_ICONS[doc.type] || '📄'}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-800 truncate font-medium">{doc.name}</div>
                  <div className="text-[11px] text-gray-400">
                    {TYPE_LABELS[doc.type] || doc.type.toUpperCase()} · {formatSize(doc.size)}
                    {doc.textLength > 0 && ` · ${doc.textLength.toLocaleString()} 字`}
                  </div>
                </div>
                <button
                  onClick={() => handleDelete(doc.id)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-red-500 text-xs mt-1 flex-shrink-0"
                  title="删除"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}