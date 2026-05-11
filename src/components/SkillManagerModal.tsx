import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw, Save, Trash2 } from 'lucide-react'

type SkillScope = 'workspace' | 'user' | 'builtin'
type EditableSkillScope = Exclude<SkillScope, 'builtin'>
type SkillContext = 'inline' | 'fork'

interface SkillSummary {
  id: string
  slug: string
  directoryName: string
  scope: SkillScope
  workspaceId?: string | null
  name: string
  description: string
  whenToUse: string
  argumentHint: string
  arguments: string[]
  disableModelInvocation: boolean
  availableForModel: boolean
  overriddenBy?: string | null
  context: SkillContext
  agent: string
  model: string
  effort: string
  version: string
  updatedAt: string
  readOnly: boolean
  canEdit: boolean
  canDelete: boolean
}

interface SkillDetail extends SkillSummary {
  content: string
}

interface SkillsResponse {
  workspaceId: string
  scope: string
  skills: SkillSummary[]
}

interface SkillDraft {
  id: string
  isNew: boolean
  scope: SkillScope
  directoryName: string
  name: string
  description: string
  whenToUse: string
  argumentText: string
  disableModelInvocation: boolean
  context: SkillContext
  agent: string
  model: string
  effort: string
  version: string
  content: string
}

const EMPTY_DRAFT: SkillDraft = {
  id: '',
  isNew: true,
  scope: 'workspace',
  directoryName: '',
  name: '',
  description: '',
  whenToUse: '',
  argumentText: '',
  disableModelInvocation: false,
  context: 'inline',
  agent: 'general-purpose',
  model: '',
  effort: '',
  version: '',
  content: '',
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

function draftFromSkill(skill: SkillDetail): SkillDraft {
  return {
    id: skill.id,
    isNew: false,
    scope: skill.scope,
    directoryName: skill.directoryName || skill.slug,
    name: skill.name,
    description: skill.description,
    whenToUse: skill.whenToUse,
    argumentText: skill.arguments.join(' '),
    disableModelInvocation: skill.disableModelInvocation,
    context: skill.context,
    agent: skill.agent || 'general-purpose',
    model: skill.model,
    effort: skill.effort,
    version: skill.version,
    content: skill.content,
  }
}

function splitArgumentText(value: string) {
  return value.split(/[,\s]+/).map(item => item.trim()).filter(Boolean)
}

function makePayload(draft: SkillDraft) {
  return {
    scope: draft.scope,
    directoryName: draft.directoryName.trim(),
    name: draft.name.trim(),
    description: draft.description.trim(),
    whenToUse: draft.whenToUse.trim(),
    arguments: splitArgumentText(draft.argumentText),
    disableModelInvocation: draft.disableModelInvocation,
    context: draft.context,
    agent: draft.context === 'fork' ? (draft.agent.trim() || 'general-purpose') : '',
    model: draft.model.trim(),
    effort: draft.effort.trim(),
    version: draft.version.trim(),
    content: draft.content,
  }
}

function scopeLabel(scope: SkillScope) {
  if (scope === 'workspace') return '工作区'
  if (scope === 'user') return '个人'
  return '内置'
}

function overrideLabel(value?: string | null) {
  if (!value) return ''
  if (value === 'user') return '个人同名技能'
  if (value === 'builtin') return '内置同名技能'
  return '工作区同名技能'
}

function isValidDirectoryName(value: string) {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.trim())
}

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json() as T & { detail?: string }
  if (!response.ok) {
    throw new Error(data.detail || `HTTP ${response.status}`)
  }
  return data
}

export default function SkillManagerModal() {
  const [scopeFilter, setScopeFilter] = useState<'all' | SkillScope>('all')
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [workspaceId, setWorkspaceId] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [draft, setDraft] = useState<SkillDraft | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const filteredSkills = useMemo(() => {
    if (scopeFilter === 'all') return skills
    return skills.filter(skill => skill.scope === scopeFilter)
  }, [scopeFilter, skills])

  const selectedSkill = useMemo(
    () => skills.find(skill => skill.id === selectedId) ?? null,
    [selectedId, skills],
  )

  const loadSkills = useCallback(async (nextScope = scopeFilter) => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(`/api/skills?scope=${encodeURIComponent(nextScope)}`)
      const data = await readJson<SkillsResponse>(response)
      setWorkspaceId(data.workspaceId)
      setSkills(data.skills)
      setSelectedId(current => {
        if (current && data.skills.some(skill => skill.id === current)) return current
        return data.skills[0]?.id ?? ''
      })
      if (!data.skills.length) setDraft(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [scopeFilter])

  useEffect(() => {
    void loadSkills()
  }, [loadSkills])

  useEffect(() => {
    if (!selectedId) return
    let active = true
    setError(null)
    void fetch(`/api/skills/${encodeURIComponent(selectedId)}`)
      .then(response => readJson<SkillDetail>(response))
      .then(detail => {
        if (active) setDraft(draftFromSkill(detail))
      })
      .catch(err => {
        if (active) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      active = false
    }
  }, [selectedId])

  const startNewSkill = useCallback((scope: EditableSkillScope) => {
    setSelectedId('')
    setNotice(null)
    setError(null)
    setDraft({
      ...EMPTY_DRAFT,
      scope,
      directoryName: scope === 'workspace' ? 'project-skill' : 'personal-skill',
      name: scope === 'workspace' ? '项目技能' : '个人技能',
      description: '',
      whenToUse: '',
      content: '# 使用说明\n\n在这里写这个 skill 的工作流程、约束和示例。',
    })
  }, [])

  const copySelectedToScope = useCallback((scope: EditableSkillScope) => {
    if (!draft) return
    setSelectedId('')
    setError(null)
    setNotice(`已复制为${scopeLabel(scope)}技能草稿，保存后生效`)
    setDraft({
      ...draft,
      id: '',
      isNew: true,
      scope,
      directoryName: draft.directoryName,
    })
  }, [draft])

  const saveDraft = useCallback(async () => {
    if (!draft) return
    if (draft.scope === 'builtin') {
      setError('内置技能为只读，请先复制到个人或工作区再编辑')
      return
    }
    if (!isValidDirectoryName(draft.directoryName)) {
      setError('目录名必须匹配 [a-z0-9][a-z0-9_-]{0,63}')
      return
    }
    if (!draft.content.trim()) {
      setError('SKILL.md 正文不能为空')
      return
    }
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch(draft.isNew ? '/api/skills' : `/api/skills/${encodeURIComponent(draft.id)}`, {
        method: draft.isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makePayload(draft)),
      })
      const saved = await readJson<SkillDetail>(response)
      setSelectedId(saved.id)
      setDraft(draftFromSkill(saved))
      setNotice('技能已保存')
      await loadSkills(scopeFilter)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [draft, loadSkills, scopeFilter])

  const deleteSelected = useCallback(async () => {
    if (!selectedSkill) return
    if (!selectedSkill.canDelete) {
      setError('内置技能为只读，不能删除')
      return
    }
    const confirmed = window.confirm(`删除技能「${selectedSkill.name || selectedSkill.slug}」？\n\n对应 SKILL.md 目录会被永久删除。`)
    if (!confirmed) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch(`/api/skills/${encodeURIComponent(selectedSkill.id)}`, { method: 'DELETE' })
      await readJson<{ success: boolean }>(response)
      setSelectedId('')
      setDraft(null)
      setNotice('技能已删除')
      await loadSkills(scopeFilter)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [loadSkills, scopeFilter, selectedSkill])

  const isReadOnly = Boolean(selectedSkill?.readOnly || draft?.scope === 'builtin')

  return (
    <div className="grid min-h-[520px] grid-cols-[320px_minmax(0,1fr)] gap-4">
      <div className="flex min-h-0 flex-col rounded-lg border border-gray-200 bg-gray-50">
        <div className="border-b border-gray-200 px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold text-gray-800">技能</div>
              <div className="mt-0.5 text-[11px] text-gray-400">当前工作区：{workspaceId || 'default'}</div>
            </div>
            <button
              type="button"
              onClick={() => void loadSkills(scopeFilter)}
              className="flex h-8 w-8 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-500 hover:bg-gray-100"
              title="刷新"
            >
              <RefreshCw size={14} />
            </button>
          </div>
          <div className="mt-3 grid grid-cols-4 gap-1 rounded-md bg-white p-1 text-xs">
            {([
              ['all', '全部'],
              ['workspace', '工作区'],
              ['user', '个人'],
              ['builtin', '内置'],
            ] as const).map(([scope, label]) => (
              <button
                key={scope}
                type="button"
                onClick={() => {
                  setScopeFilter(scope)
                  void loadSkills(scope)
                }}
                className={`rounded px-2 py-1.5 ${scopeFilter === scope ? 'bg-blue-500 text-white' : 'text-gray-500 hover:bg-gray-100'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => startNewSkill('workspace')}
              className="flex flex-1 items-center justify-center gap-1 rounded-md bg-blue-500 px-2 py-2 text-xs font-medium text-white hover:bg-blue-600"
            >
              <Plus size={13} />
              工作区
            </button>
            <button
              type="button"
              onClick={() => startNewSkill('user')}
              className="flex flex-1 items-center justify-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-2 text-xs font-medium text-gray-700 hover:bg-gray-100"
            >
              <Plus size={13} />
              个人
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loading && <div className="px-2 py-3 text-xs text-gray-400">正在加载...</div>}
          {!loading && filteredSkills.length === 0 && (
            <div className="rounded-md border border-dashed border-gray-300 bg-white px-3 py-4 text-sm text-gray-500">
              还没有技能。
            </div>
          )}
          <div className="space-y-2">
            {filteredSkills.map(skill => (
              <button
                key={skill.id}
                type="button"
                onClick={() => setSelectedId(skill.id)}
                className={`w-full rounded-md border px-3 py-3 text-left transition-colors ${selectedId === skill.id
                  ? 'border-blue-300 bg-white shadow-sm'
                  : 'border-transparent bg-white hover:border-gray-200'
                  }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-gray-800">{skill.name || skill.slug}</div>
                    <div className="mt-1 truncate text-[11px] text-gray-400">{skill.slug} · {scopeLabel(skill.scope)}</div>
                  </div>
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${skill.readOnly ? 'bg-indigo-100 text-indigo-700' : skill.availableForModel ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                    {skill.readOnly ? '内置' : skill.availableForModel ? '可调用' : '隐藏'}
                  </span>
                </div>
                <div className="mt-2 line-clamp-2 text-xs text-gray-500">{skill.whenToUse || skill.description || '无触发说明'}</div>
                {skill.overriddenBy && (
                  <div className="mt-2 text-[11px] text-amber-600">已被{overrideLabel(skill.overriddenBy)}覆盖</div>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="min-h-0 overflow-y-auto rounded-lg border border-gray-200 bg-white px-4 py-4">
        {error && <div className="mb-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>}
        {notice && <div className="mb-3 rounded-md bg-blue-50 px-3 py-2 text-xs text-blue-700">{notice}</div>}
        {draft ? (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-gray-800">{draft.isNew ? '新建技能' : draft.name || draft.directoryName}</div>
                {!draft.isNew && selectedSkill && <div className="mt-1 text-xs text-gray-400">更新：{formatTime(selectedSkill.updatedAt)}</div>}
                {isReadOnly && <div className="mt-1 text-xs text-indigo-600">内置技能为只读，可复制后编辑覆盖。</div>}
              </div>
              <div className="flex gap-2">
                {isReadOnly && (
                  <>
                    <button
                      type="button"
                      onClick={() => copySelectedToScope('user')}
                      disabled={saving}
                      className="flex items-center gap-1 rounded-md border border-gray-300 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Plus size={13} />
                      复制到个人
                    </button>
                    <button
                      type="button"
                      onClick={() => copySelectedToScope('workspace')}
                      disabled={saving}
                      className="flex items-center gap-1 rounded-md border border-blue-200 px-3 py-2 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Plus size={13} />
                      复制到工作区
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => void saveDraft()}
                  disabled={saving || isReadOnly}
                  className="flex items-center gap-1 rounded-md bg-blue-500 px-3 py-2 text-xs font-medium text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-gray-300"
                >
                  <Save size={13} />
                  保存
                </button>
                {!draft.isNew && selectedSkill?.canDelete && (
                  <button
                    type="button"
                    onClick={() => void deleteSelected()}
                    disabled={saving}
                    className="flex items-center gap-1 rounded-md border border-red-200 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Trash2 size={13} />
                    删除
                  </button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-gray-500">目录名</span>
                <input
                  value={draft.directoryName}
                  onChange={event => setDraft(current => current ? { ...current, directoryName: event.target.value } : current)}
                  disabled={isReadOnly}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-300"
                  placeholder="my-skill"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-gray-500">展示名</span>
                <input
                  value={draft.name}
                  onChange={event => setDraft(current => current ? { ...current, name: event.target.value } : current)}
                  disabled={isReadOnly}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-300"
                  placeholder="技能名称"
                />
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-gray-500">作用域</span>
                <select
                  value={draft.scope}
                  disabled={!draft.isNew || isReadOnly}
                  onChange={event => setDraft(current => current ? { ...current, scope: event.target.value as SkillScope } : current)}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:bg-gray-100"
                >
                  <option value="workspace">当前工作区</option>
                  <option value="user">个人全局</option>
                  <option value="builtin">内置只读</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-gray-500">执行方式</span>
                <select
                  value={draft.context}
                  onChange={event => setDraft(current => current ? { ...current, context: event.target.value as SkillContext } : current)}
                  disabled={isReadOnly}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-300"
                >
                  <option value="inline">Inline 展开</option>
                  <option value="fork">Fork 子代理</option>
                </select>
              </label>
            </div>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-500">描述</span>
              <input
                value={draft.description}
                onChange={event => setDraft(current => current ? { ...current, description: event.target.value } : current)}
                disabled={isReadOnly}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-300"
                placeholder="一句话描述这个技能"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-500">触发说明</span>
              <textarea
                value={draft.whenToUse}
                onChange={event => setDraft(current => current ? { ...current, whenToUse: event.target.value } : current)}
                disabled={isReadOnly}
                rows={3}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-300"
                placeholder="例如：用户要求按公司周报模板润色时使用"
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-gray-500">参数名</span>
                <input
                  value={draft.argumentText}
                  onChange={event => setDraft(current => current ? { ...current, argumentText: event.target.value } : current)}
                  disabled={isReadOnly}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-300"
                  placeholder="topic audience"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-gray-500">Agent 类型</span>
                <input
                  value={draft.agent}
                  onChange={event => setDraft(current => current ? { ...current, agent: event.target.value } : current)}
                  disabled={isReadOnly || draft.context !== 'fork'}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:bg-gray-100"
                  placeholder="general-purpose"
                />
              </label>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-gray-500">模型</span>
                <input
                  value={draft.model}
                  onChange={event => setDraft(current => current ? { ...current, model: event.target.value } : current)}
                  disabled={isReadOnly}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-300"
                  placeholder="inherit"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-gray-500">推理强度</span>
                <input
                  value={draft.effort}
                  onChange={event => setDraft(current => current ? { ...current, effort: event.target.value } : current)}
                  disabled={isReadOnly}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-300"
                  placeholder="medium"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-gray-500">版本</span>
                <input
                  value={draft.version}
                  onChange={event => setDraft(current => current ? { ...current, version: event.target.value } : current)}
                  disabled={isReadOnly}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-300"
                  placeholder="1.0.0"
                />
              </label>
            </div>

            <label className="flex items-center gap-2 text-sm text-gray-600">
              <input
                type="checkbox"
                checked={draft.disableModelInvocation}
                onChange={event => setDraft(current => current ? { ...current, disableModelInvocation: event.target.checked } : current)}
                disabled={isReadOnly}
              />
              <span>禁止模型自动调用</span>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-500">SKILL.md 正文</span>
              <textarea
                value={draft.content}
                onChange={event => setDraft(current => current ? { ...current, content: event.target.value } : current)}
                disabled={isReadOnly}
                rows={18}
                className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm leading-relaxed focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-300"
                placeholder="写入 skill 的完整 Markdown 指令"
              />
            </label>
          </div>
        ) : (
          <div className="flex h-full min-h-[420px] items-center justify-center text-sm text-gray-500">
            选择左侧技能，或新建一个技能。
          </div>
        )}
      </div>
    </div>
  )
}
