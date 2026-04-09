import { useEffect, useState } from 'react'

interface ServerDocumentSummary {
  name: string
  size: number
  updatedAt: string
}

interface Props {
  mode: 'open' | 'save'
  files: ServerDocumentSummary[]
  loading: boolean
  error: string | null
  initialName?: string
  onClose: () => void
  onOpen: (name: string) => void | Promise<void>
  onSave: (name: string) => void | Promise<void>
  onDelete: (name: string) => void | Promise<void>
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
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

export default function FileManagerModal({
  mode,
  files,
  loading,
  error,
  initialName = 'document.docx',
  onClose,
  onOpen,
  onSave,
  onDelete,
}: Props) {
  const [name, setName] = useState(initialName)
  const isSave = mode === 'save'

  useEffect(() => {
    setName(initialName)
  }, [initialName, mode])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    await onSave(trimmed)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-2xl w-[520px] max-w-[96vw] mx-4 flex flex-col" style={{ maxHeight: '88vh' }}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 flex-shrink-0">
          <h2 className="font-semibold text-gray-800 text-base">{isSave ? '保存到服务器' : '打开服务器文件'}</h2>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 text-xl leading-none"
          >
            ×
          </button>
        </div>

        {isSave && (
          <div className="px-5 py-4 border-b border-gray-100 space-y-2">
            <label className="block text-xs font-medium text-gray-500">文件名</label>
            <input
              type="text"
              value={name}
              onChange={event => setName(event.target.value)}
              placeholder="document.docx"
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
            />
            <p className="text-xs text-gray-400">会保存到后端 `server/data/documents/`，统一使用 `docx`。</p>
          </div>
        )}

        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-3">
          {error && (
            <div className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</div>
          )}

          {loading ? (
            <div className="text-sm text-gray-500">正在读取文件列表…</div>
          ) : files.length === 0 ? (
            <div className="text-sm text-gray-500">服务器上还没有保存的 docx 文件。</div>
          ) : (
            <div className="space-y-2">
              {files.map(file => (
                <div key={file.name} className="border border-gray-200 rounded-xl px-3 py-2.5 flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-800 truncate">{file.name}</div>
                    <div className="text-xs text-gray-400">{formatBytes(file.size)} · {formatTime(file.updatedAt)}</div>
                  </div>
                  {isSave ? (
                    <button
                      onClick={() => setName(file.name)}
                      className="px-2.5 py-1 text-xs rounded-lg border border-gray-300 hover:bg-gray-50"
                    >
                      使用此名
                    </button>
                  ) : (
                    <button
                      onClick={() => void onOpen(file.name)}
                      className="px-2.5 py-1 text-xs rounded-lg bg-blue-500 hover:bg-blue-600 text-white"
                    >
                      打开
                    </button>
                  )}
                  <button
                    onClick={() => void onDelete(file.name)}
                    className="px-2.5 py-1 text-xs rounded-lg border border-red-200 text-red-600 hover:bg-red-50"
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3.5 border-t border-gray-100 flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-gray-300 hover:bg-gray-50"
          >
            取消
          </button>
          {isSave && (
            <button
              onClick={() => void submit()}
              className="px-4 py-2 text-sm rounded-lg bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50"
              disabled={!name.trim()}
            >
              保存
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
