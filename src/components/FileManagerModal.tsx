import { useEffect, useState } from 'react'

export type DocumentSource = 'internal' | 'wps_directory'

export interface DocumentFileSummary {
  name: string
  size: number
  updatedAt: string
  source: DocumentSource
  directory: string
}

export interface DocumentSettings {
  activeSource: DocumentSource
  wpsDirectory: string
  available: boolean
  errorMessage?: string | null
  activeDirectory: string
  internalDirectory: string
}

interface Props {
  mode: 'open' | 'save'
  files: DocumentFileSummary[]
  loading: boolean
  error: string | null
  settings: DocumentSettings
  settingsSaving: boolean
  initialName?: string
  onClose: () => void
  onOpen: (name: string) => void | Promise<void>
  onSave: (name: string) => void | Promise<void>
  onDelete: (name: string) => void | Promise<void>
  onRefresh: () => void | Promise<void>
  onChangeSource: (source: DocumentSource) => void | Promise<void>
  onUpdateWpsDirectory: (path: string) => void | Promise<void>
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

function sourceLabel(source: DocumentSource) {
  return source === 'wps_directory' ? 'WPS 目录' : '服务器文档'
}

export default function FileManagerModal({
  mode,
  files,
  loading,
  error,
  settings,
  settingsSaving,
  initialName = 'document.docx',
  onClose,
  onOpen,
  onSave,
  onDelete,
  onRefresh,
  onChangeSource,
  onUpdateWpsDirectory,
}: Props) {
  const [name, setName] = useState(initialName)
  const [wpsDirectoryDraft, setWpsDirectoryDraft] = useState(settings.wpsDirectory)
  const isSave = mode === 'save'
  const isWpsSource = settings.activeSource === 'wps_directory'

  useEffect(() => {
    const timer = window.setTimeout(() => setName(initialName), 0)
    return () => window.clearTimeout(timer)
  }, [initialName, mode])

  useEffect(() => {
    const timer = window.setTimeout(() => setWpsDirectoryDraft(settings.wpsDirectory), 0)
    return () => window.clearTimeout(timer)
  }, [settings.wpsDirectory])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed || !settings.available) return
    await onSave(trimmed)
  }

  const currentDirectory = settings.activeDirectory || (isWpsSource ? settings.wpsDirectory : settings.internalDirectory)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-2xl w-[620px] max-w-[96vw] mx-4 flex flex-col" style={{ maxHeight: '88vh' }}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 flex-shrink-0">
          <div>
            <h2 className="font-semibold text-gray-800 text-base">{isSave ? '保存文档' : '打开文档'}</h2>
            <p className="text-xs text-gray-400 mt-0.5">当前来源：{sourceLabel(settings.activeSource)}</p>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 text-xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4 border-b border-gray-100 space-y-3">
          <div className="flex items-center gap-2">
            <button
              onClick={() => void onChangeSource('internal')}
              className={`px-3 py-1.5 text-sm rounded-lg border ${
                settings.activeSource === 'internal'
                  ? 'border-blue-500 bg-blue-50 text-blue-700'
                  : 'border-gray-300 hover:bg-gray-50'
              }`}
              disabled={settingsSaving}
            >
              服务器文档
            </button>
            <button
              onClick={() => void onChangeSource('wps_directory')}
              className={`px-3 py-1.5 text-sm rounded-lg border ${
                settings.activeSource === 'wps_directory'
                  ? 'border-blue-500 bg-blue-50 text-blue-700'
                  : 'border-gray-300 hover:bg-gray-50'
              }`}
              disabled={settingsSaving}
            >
              WPS 目录
            </button>
            <button
              onClick={() => void onRefresh()}
              className="ml-auto px-3 py-1.5 text-xs rounded-lg border border-gray-300 hover:bg-gray-50"
              disabled={loading}
            >
              刷新
            </button>
          </div>

          {isWpsSource && (
            <div className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-3">
              <label className="block text-xs font-medium text-gray-600">WPS 本地 DOCX 目录</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={wpsDirectoryDraft}
                  onChange={event => setWpsDirectoryDraft(event.target.value)}
                  placeholder="/Users/you/Documents/WPS"
                  className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent bg-white"
                />
                <button
                  onClick={() => void onUpdateWpsDirectory(wpsDirectoryDraft)}
                  className="px-3 py-2 text-sm rounded-lg bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50"
                  disabled={settingsSaving}
                >
                  保存目录
                </button>
              </div>
              <p className="text-xs text-gray-500">仅读取该目录顶层 `.docx` 文件，不扫描子目录。</p>
            </div>
          )}

          <div className="text-xs text-gray-500 break-all">
            目录：{currentDirectory || '未配置'}
          </div>

          {!settings.available && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">
              {settings.errorMessage || '当前文档来源不可用'}
            </div>
          )}

          {isSave && (
            <div className="space-y-2">
              <label className="block text-xs font-medium text-gray-500">文件名</label>
              <input
                type="text"
                value={name}
                onChange={event => setName(event.target.value)}
                placeholder="document.docx"
                className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
              />
              <p className="text-xs text-gray-400">
                {isWpsSource ? '将直接保存到当前 WPS 目录。' : '会保存到后端 `server/data/documents/`。'}
              </p>
            </div>
          )}
        </div>

        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-3">
          {error && (
            <div className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</div>
          )}

          {loading ? (
            <div className="text-sm text-gray-500">正在读取文件列表…</div>
          ) : files.length === 0 ? (
            <div className="text-sm text-gray-500">
              {settings.available ? '当前目录还没有可用的 docx 文件。' : '当前目录不可用，请先修正配置或切回服务器文档。'}
            </div>
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
                      className="px-2.5 py-1 text-xs rounded-lg bg-blue-500 hover:bg-blue-600 text-white disabled:opacity-50"
                      disabled={!settings.available}
                    >
                      打开
                    </button>
                  )}
                  <button
                    onClick={() => void onDelete(file.name)}
                    className="px-2.5 py-1 text-xs rounded-lg border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50"
                    disabled={!settings.available}
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
              disabled={!name.trim() || !settings.available}
            >
              保存
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
