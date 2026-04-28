import React from 'react'
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  File,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  MoveRight,
  MoreVertical,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react'

export interface WorkspaceSummary {
  id: string
  name: string
  createdAt?: string
  updatedAt?: string
}

export interface WorkspaceFileNode {
  name: string
  path: string
  kind: 'directory' | 'file'
  role: string
  type?: string
  extension?: string
  size?: number
  updatedAt?: string
  editable?: boolean
  readOnly?: boolean
  isReference?: boolean
  children?: WorkspaceFileNode[]
}

export interface WorkspaceFileRef {
  workspaceId: string
  filePath: string
  fileType: string
}

interface WorkspacesResponse {
  activeWorkspaceId: string
  workspaces: WorkspaceSummary[]
}

interface WorkspaceTreeResponse {
  workspaceId: string
  root: WorkspaceFileNode
}

interface Props {
  onClose: () => void
  activeFile?: WorkspaceFileRef | null
  onOpenFile: (workspaceId: string, path: string) => Promise<void> | void
  onSaveActiveFile?: () => Promise<void> | void
  onWorkspaceChange?: (workspaceId: string) => void
}

function joinPath(dir: string, name: string) {
  const cleanName = name.trim().replace(/^\/+/, '')
  if (!dir) return cleanName
  return `${dir.replace(/\/+$/, '')}/${cleanName}`
}

function parentPath(path: string) {
  const index = path.lastIndexOf('/')
  return index >= 0 ? path.slice(0, index) : ''
}

function typeLabel(node: WorkspaceFileNode) {
  if (node.kind === 'directory') return node.role === 'reference' ? '参考目录' : '文件夹'
  if (node.type) return node.type.toUpperCase()
  return node.extension?.toUpperCase() || 'FILE'
}

export default function WorkspacePanel({
  onClose,
  activeFile,
  onOpenFile,
  onSaveActiveFile,
  onWorkspaceChange,
}: Props) {
  const [workspaces, setWorkspaces] = React.useState<WorkspaceSummary[]>([])
  const [workspaceId, setWorkspaceId] = React.useState('')
  const [tree, setTree] = React.useState<WorkspaceFileNode | null>(null)
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set(['_references']))
  const [selectedDir, setSelectedDir] = React.useState('')
  const [preview, setPreview] = React.useState<{ path: string; content: string } | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [dragActive, setDragActive] = React.useState(false)
  const [openMenuPath, setOpenMenuPath] = React.useState<string | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (!openMenuPath) return undefined
    const closeMenu = () => setOpenMenuPath(null)
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMenuPath(null)
    }
    document.addEventListener('click', closeMenu)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('click', closeMenu)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [openMenuPath])

  const loadTree = React.useCallback(async (nextWorkspaceId: string) => {
    if (!nextWorkspaceId) return
    const response = await fetch(`/api/workspaces/${encodeURIComponent(nextWorkspaceId)}/tree`)
    if (!response.ok) throw new Error(`读取工作区目录失败：HTTP ${response.status}`)
    const data = await response.json() as WorkspaceTreeResponse
    setTree(data.root)
  }, [])

  const loadWorkspaces = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/workspaces')
      if (!response.ok) throw new Error(`读取工作区失败：HTTP ${response.status}`)
      const data = await response.json() as WorkspacesResponse
      setWorkspaces(data.workspaces)
      const nextId = data.activeWorkspaceId || data.workspaces[0]?.id || ''
      setWorkspaceId(nextId)
      onWorkspaceChange?.(nextId)
      if (nextId) await loadTree(nextId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [loadTree, onWorkspaceChange])

  React.useEffect(() => {
    void loadWorkspaces()
  }, [loadWorkspaces])

  const refresh = React.useCallback(async () => {
    if (!workspaceId) {
      await loadWorkspaces()
      return
    }
    setLoading(true)
    setError(null)
    try {
      await loadTree(workspaceId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [loadTree, loadWorkspaces, workspaceId])

  const switchWorkspace = React.useCallback(async (nextId: string) => {
    if (!nextId || nextId === workspaceId) return
    setWorkspaceId(nextId)
    setPreview(null)
    setSelectedDir('')
    try {
      await fetch(`/api/workspaces/${encodeURIComponent(nextId)}/active`, { method: 'POST' })
      onWorkspaceChange?.(nextId)
      await loadTree(nextId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [loadTree, onWorkspaceChange, workspaceId])

  const createWorkspace = React.useCallback(async () => {
    const name = window.prompt('新工作区名称')
    if (!name?.trim()) return
    try {
      const response = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      })
      if (!response.ok) throw new Error(`创建工作区失败：HTTP ${response.status}`)
      await loadWorkspaces()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [loadWorkspaces])

  const createFolder = React.useCallback(async () => {
    if (!workspaceId) return
    const name = window.prompt('新文件夹名称')
    if (!name?.trim()) return
    const path = joinPath(selectedDir, name)
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/folders/${encodeURIComponent(path)}`, { method: 'POST' })
      if (!response.ok) throw new Error(`创建文件夹失败：HTTP ${response.status}`)
      setExpanded(prev => new Set(prev).add(selectedDir))
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [refresh, selectedDir, workspaceId])

  const createFile = React.useCallback(async () => {
    if (!workspaceId) return
    const name = window.prompt('新文件名（支持 .docx / .md / .txt）', 'untitled.docx')
    if (!name?.trim()) return
    const path = joinPath(selectedDir, name)
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/files/${encodeURIComponent(path)}`, { method: 'PUT' })
      if (!response.ok) throw new Error(`创建文件失败：HTTP ${response.status}`)
      await refresh()
      await onOpenFile(workspaceId, path)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [onOpenFile, refresh, selectedDir, workspaceId])

  const uploadFiles = React.useCallback(async (files: FileList | null) => {
    if (!files || !workspaceId) return
    setError(null)
    try {
      for (const file of Array.from(files)) {
        const formData = new FormData()
        formData.append('file', file)
        const query = selectedDir ? `?path=${encodeURIComponent(selectedDir)}` : ''
        const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/files/upload${query}`, {
          method: 'POST',
          body: formData,
        })
        if (!response.ok) throw new Error(`上传 ${file.name} 失败：HTTP ${response.status}`)
      }
      if (fileInputRef.current) fileInputRef.current.value = ''
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [refresh, selectedDir, workspaceId])

  const previewFile = React.useCallback(async (node: WorkspaceFileNode) => {
    if (!workspaceId) return
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/files/${encodeURIComponent(node.path)}/content`)
      if (!response.ok) throw new Error(`读取预览失败：HTTP ${response.status}`)
      const data = await response.json() as { content?: string }
      setPreview({ path: node.path, content: data.content || '' })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [workspaceId])

  const deleteNode = React.useCallback(async (node: WorkspaceFileNode) => {
    setOpenMenuPath(null)
    if (!workspaceId || !window.confirm(`删除 ${node.path}？`)) return
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/files/${encodeURIComponent(node.path)}`, { method: 'DELETE' })
      if (!response.ok) throw new Error(`删除失败：HTTP ${response.status}`)
      if (preview?.path === node.path) setPreview(null)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [preview?.path, refresh, workspaceId])

  const renameNode = React.useCallback(async (node: WorkspaceFileNode) => {
    setOpenMenuPath(null)
    if (!workspaceId) return
    const nextName = window.prompt('新名称', node.name)
    if (!nextName?.trim() || nextName.trim() === node.name) return
    const nextPath = joinPath(parentPath(node.path), nextName)
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/files/${encodeURIComponent(node.path)}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toPath: nextPath }),
      })
      if (!response.ok) throw new Error(`重命名失败：HTTP ${response.status}`)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [refresh, workspaceId])

  const moveNode = React.useCallback(async (node: WorkspaceFileNode) => {
    setOpenMenuPath(null)
    if (!workspaceId) return
    const nextPath = window.prompt('移动到工作区相对路径', node.path)
    if (!nextPath?.trim() || nextPath.trim() === node.path) return
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/files/${encodeURIComponent(node.path)}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toPath: nextPath.trim() }),
      })
      if (!response.ok) throw new Error(`移动失败：HTTP ${response.status}`)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [refresh, workspaceId])

  const handleNodeActivate = React.useCallback(async (node: WorkspaceFileNode) => {
    if (node.kind === 'directory') {
      setSelectedDir(node.path)
      setExpanded(prev => {
        const next = new Set(prev)
        if (next.has(node.path)) next.delete(node.path)
        else next.add(node.path)
        return next
      })
      return
    }
    if (node.editable) {
      await onOpenFile(workspaceId, node.path)
      setPreview(null)
    } else {
      await previewFile(node)
    }
  }, [onOpenFile, previewFile, workspaceId])

  const renderNode = React.useCallback((node: WorkspaceFileNode, depth = 0): React.ReactNode => {
    const isDir = node.kind === 'directory'
    const isExpanded = expanded.has(node.path)
    const isActive = activeFile?.workspaceId === workspaceId && activeFile.filePath === node.path
    const isSelectedDir = isDir && selectedDir === node.path
    const isMenuOpen = openMenuPath === node.path
    const Icon = isDir ? (isExpanded ? FolderOpen : Folder) : FileText
    return (
      <div key={node.path || 'root'}>
        <div
          className={`group relative flex h-8 items-center gap-1.5 rounded-md px-1.5 text-sm ${
            isActive
              ? 'bg-blue-50 text-blue-700'
              : isSelectedDir
                ? 'bg-slate-100 text-slate-900'
                : 'text-slate-700 hover:bg-slate-50'
          }`}
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          <button
            type="button"
            onClick={() => { void handleNodeActivate(node) }}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            title={node.path || node.name}
          >
            {isDir ? (isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : <span className="w-[13px]" />}
            <Icon size={15} className={isDir ? 'text-amber-500' : node.isReference ? 'text-slate-400' : 'text-blue-500'} />
            <span className="truncate">{node.name}</span>
            {node.role === 'memory' && <span className="rounded bg-emerald-50 px-1 text-[10px] text-emerald-700">记忆</span>}
            {node.isReference && !isDir && <span className="rounded bg-slate-100 px-1 text-[10px] text-slate-500">参考</span>}
          </button>
          {!isDir && (
            <span className="hidden flex-shrink-0 text-[10px] text-slate-400 group-hover:block">{typeLabel(node)}</span>
          )}
          <button
            type="button"
            className={`${isMenuOpen ? 'flex' : 'hidden group-hover:flex'} h-6 w-6 flex-shrink-0 items-center justify-center rounded text-slate-400 hover:bg-white hover:text-slate-700`}
            title="更多"
            onClick={(event) => {
              event.stopPropagation()
              setOpenMenuPath(current => current === node.path ? null : node.path)
            }}
          >
            <MoreVertical size={14} />
          </button>
          {isMenuOpen && (
            <div
              className="absolute right-1 top-7 z-50 w-32 overflow-hidden rounded-md border border-slate-200 bg-white py-1 text-xs text-slate-700 shadow-lg"
              onClick={event => event.stopPropagation()}
            >
              <button
                type="button"
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-slate-50"
                onClick={() => { void renameNode(node) }}
              >
                <Pencil size={13} />
                <span>重命名</span>
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-slate-50"
                onClick={() => { void moveNode(node) }}
              >
                <MoveRight size={13} />
                <span>移动</span>
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-red-600 hover:bg-red-50"
                onClick={() => { void deleteNode(node) }}
              >
                <Trash2 size={13} />
                <span>删除</span>
              </button>
            </div>
          )}
        </div>
        {isDir && isExpanded && node.children?.map(child => renderNode(child, depth + 1))}
      </div>
    )
  }, [activeFile?.filePath, activeFile?.workspaceId, deleteNode, expanded, handleNodeActivate, moveNode, openMenuPath, renameNode, selectedDir, workspaceId])

  return (
    <div
      data-openwps-workspace-panel="true"
      className={`relative flex h-full flex-shrink-0 flex-col border-r bg-white ${dragActive ? 'border-blue-300 shadow-[inset_0_0_0_2px_rgba(37,99,235,0.18)]' : 'border-slate-200'}`}
      style={{ width: 'clamp(300px, 22vw, 360px)' }}
      onDragEnter={event => {
        event.preventDefault()
        setDragActive(true)
      }}
      onDragOver={event => {
        event.preventDefault()
        setDragActive(true)
      }}
      onDragLeave={event => {
        event.preventDefault()
        if (event.currentTarget === event.target) setDragActive(false)
      }}
      onDrop={event => {
        event.preventDefault()
        setDragActive(false)
        void uploadFiles(event.dataTransfer.files)
      }}
    >
      <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-slate-100 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <HardDrive size={18} className="text-blue-600" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-slate-900">工作区</div>
            <div className="truncate text-[11px] text-slate-400">{selectedDir || '根目录'}</div>
          </div>
        </div>
        <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="关闭工作区">
          <X size={16} />
        </button>
      </div>

      <div className="flex flex-shrink-0 flex-col gap-2 border-b border-slate-100 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <select
            value={workspaceId}
            onChange={event => { void switchWorkspace(event.target.value) }}
            className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700 outline-none focus:border-blue-400"
          >
            {workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <button onClick={createWorkspace} className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50" title="新建工作区">
            <Plus size={14} />
          </button>
          <button onClick={() => { void refresh() }} className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50" title="刷新">
            <RefreshCw size={14} />
          </button>
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          <button onClick={createFile} className="flex h-8 items-center justify-center rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50" title="新建文件">
            <File size={14} />
          </button>
          <button onClick={createFolder} className="flex h-8 items-center justify-center rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50" title="新建文件夹">
            <FolderPlus size={14} />
          </button>
          <button onClick={() => fileInputRef.current?.click()} className="flex h-8 items-center justify-center rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50" title="上传到当前目录">
            <Upload size={14} />
          </button>
          <button onClick={() => { void onSaveActiveFile?.() }} className="flex h-8 items-center justify-center rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-300" title="保存当前文件" disabled={!activeFile}>
            <Save size={14} />
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".docx,.txt,.md,.markdown,.pdf,.ppt,.pptx"
          className="hidden"
          onChange={event => { void uploadFiles(event.target.files) }}
        />
      </div>

      {error && (
        <div className="mx-3 mt-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-xs text-red-600">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600" title="关闭错误提示">
            <X size={13} />
          </button>
        </div>
      )}

      {dragActive && (
        <div className="mx-3 mt-3 rounded-md border border-dashed border-blue-300 bg-blue-50 px-3 py-2 text-center text-xs font-medium text-blue-600">
          松开后上传到 {selectedDir || '根目录'}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {loading && !tree ? (
          <div className="mt-10 text-center text-sm text-slate-400">加载中...</div>
        ) : tree?.children?.length ? (
          <div className="space-y-0.5">{tree.children.map(child => renderNode(child))}</div>
        ) : (
          <div className="mt-12 text-center text-sm text-slate-400">当前工作区为空</div>
        )}
      </div>

      {preview && (
        <div className="max-h-[34%] flex-shrink-0 border-t border-slate-100 bg-slate-50">
          <div className="flex items-center justify-between gap-2 px-3 py-2">
            <div className="truncate text-xs font-medium text-slate-700" title={preview.path}>{preview.path}</div>
            <button onClick={() => setPreview(null)} className="text-slate-400 hover:text-slate-700" title="关闭预览">
              <X size={14} />
            </button>
          </div>
          <pre className="max-h-48 overflow-auto px-3 pb-3 text-xs leading-5 text-slate-600 whitespace-pre-wrap">{preview.content}</pre>
        </div>
      )}

      <div className="flex flex-shrink-0 items-center justify-between border-t border-slate-100 px-3 py-2 text-[11px] text-slate-400">
        <span>{activeFile?.filePath ? `当前：${activeFile.filePath}` : '未打开工作区文件'}</span>
        <button
          type="button"
          onClick={() => setSelectedDir('')}
          className="flex items-center gap-1 text-slate-500 hover:text-slate-800"
          title="回到根目录"
        >
          根目录
        </button>
      </div>
    </div>
  )
}
