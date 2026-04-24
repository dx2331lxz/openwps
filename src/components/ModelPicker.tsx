import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ModelOption } from '../ai/providers'

interface ModelPickerProps {
  models: ModelOption[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  placeholder?: string
  loading?: boolean
}

function normalizeText(text: string) {
  return text.toLowerCase().replace(/[-_\s]+/g, '')
}

export default function ModelPicker({
  models,
  value,
  onChange,
  disabled = false,
  placeholder = '选择模型',
  loading = false,
}: ModelPickerProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const filteredModels = useMemo(() => {
    if (!query.trim()) return models
    const q = normalizeText(query)
    return models.filter(
      model =>
        normalizeText(model.id).includes(q) ||
        normalizeText(model.label || '').includes(q) ||
        normalizeText(model.id + (model.label || '')).includes(q),
    )
  }, [models, query])

  const selectedModel = useMemo(
    () => models.find(m => m.id === value) || null,
    [models, value],
  )

  // Measure and position dropdown when opening
  useEffect(() => {
    if (!isOpen) {
      setDropdownPos(null)
      return
    }
    const measure = () => {
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      const dropdownHeight = 280
      const gap = 6
      let top = rect.top - dropdownHeight - gap
      // If not enough space above, place below
      if (top < 8) {
        top = rect.bottom + gap
      }
      setDropdownPos({
        top,
        left: rect.left,
        width: rect.width,
      })
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [isOpen])

  // Reset highlight when filtered list changes
  useEffect(() => {
    setHighlightedIndex(0)
  }, [filteredModels.length])

  // Focus input when opening
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 0)
    } else {
      setQuery('')
    }
  }, [isOpen])

  // Close on click outside (check both trigger and dropdown)
  useEffect(() => {
    if (!isOpen) return
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node
      if (
        !containerRef.current?.contains(target) &&
        !dropdownRef.current?.contains(target)
      ) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isOpen])

  // Scroll highlighted item into view
  useEffect(() => {
    if (!isOpen || !listRef.current) return
    const item = listRef.current.children[highlightedIndex] as HTMLElement | undefined
    if (item) {
      item.scrollIntoView({ block: 'nearest' })
    }
  }, [highlightedIndex, isOpen])

  const handleSelect = useCallback(
    (modelId: string) => {
      onChange(modelId)
      setIsOpen(false)
      setQuery('')
    },
    [onChange],
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (!isOpen) {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
          event.preventDefault()
          setIsOpen(true)
        }
        return
      }

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault()
          setHighlightedIndex(prev => (prev + 1) % filteredModels.length)
          break
        case 'ArrowUp':
          event.preventDefault()
          setHighlightedIndex(prev => (prev - 1 + filteredModels.length) % filteredModels.length)
          break
        case 'Enter':
          event.preventDefault()
          if (filteredModels[highlightedIndex]) {
            handleSelect(filteredModels[highlightedIndex].id)
          }
          break
        case 'Escape':
          event.preventDefault()
          setIsOpen(false)
          break
        case 'Tab':
          setIsOpen(false)
          break
      }
    },
    [isOpen, filteredModels, highlightedIndex, handleSelect],
  )

  const displayText = selectedModel
    ? `${selectedModel.id}${selectedModel.supportsVision ? ' · 多模态' : ''}`
    : value || placeholder

  const dropdownPanel = (
    <div
      ref={dropdownRef}
      className="rounded-xl border border-slate-200 bg-white shadow-lg overflow-hidden"
      style={{
        position: 'fixed',
        top: dropdownPos?.top ?? 0,
        left: dropdownPos?.left ?? 0,
        width: dropdownPos?.width ?? 0,
        maxHeight: 280,
        zIndex: 9999,
      }}
    >
      <div className="sticky top-0 bg-white border-b border-slate-100 px-3 py-2">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="搜索模型..."
          className="w-full bg-transparent text-[12px] text-slate-700 outline-none placeholder:text-slate-400"
        />
      </div>
      <div ref={listRef} className="overflow-y-auto" style={{ maxHeight: 220 }}>
        {filteredModels.length === 0 ? (
          <div className="px-3 py-3 text-[11px] text-slate-400 text-center">
            未找到匹配的模型
          </div>
        ) : (
          filteredModels.map((model, index) => {
            const isHighlighted = index === highlightedIndex
            return (
              <button
                key={model.id}
                type="button"
                onClick={() => handleSelect(model.id)}
                onMouseEnter={() => setHighlightedIndex(index)}
                className={`w-full text-left px-3 py-2 text-[11px] transition-colors ${
                  isHighlighted ? 'bg-blue-50 text-blue-700' : 'text-slate-700 hover:bg-slate-50'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {model.id}
                  </span>
                  {model.supportsVision && (
                    <span className="shrink-0 rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-600 border border-blue-100">
                      多模态
                    </span>
                  )}
                </div>
                {model.label && model.label !== model.id && (
                  <div className={`mt-0.5 truncate text-[10px] ${isHighlighted ? 'text-blue-500' : 'text-slate-400'}`}>
                    {model.label}
                  </div>
                )}
              </button>
            )
          })
        )}
      </div>
      <div className="sticky bottom-0 bg-slate-50 border-t border-slate-100 px-3 py-1.5 text-[10px] text-slate-400 flex items-center justify-between">
        <span>{filteredModels.length} 个模型</span>
        <span className="text-slate-300">↑↓ 选择 · Enter 确认 · Esc 关闭</span>
      </div>
    </div>
  )

  return (
    <div ref={containerRef} className="relative flex min-w-0 flex-1">
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(prev => !prev)}
        disabled={disabled}
        onKeyDown={handleKeyDown}
        className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-full border border-slate-200 bg-white pl-3 pr-2 py-1.5 text-left text-[11px] transition-colors ${
          disabled
            ? 'cursor-not-allowed bg-slate-100 text-slate-400'
            : 'text-slate-700 hover:bg-slate-50'
        }`}
        title={selectedModel?.id || value || placeholder}
      >
        <span className="shrink-0 text-slate-500">模型</span>
        <span className="min-w-0 flex-1 truncate">
          {loading ? '模型加载中...' : displayText}
        </span>
        <span className="shrink-0 text-slate-400 text-[10px]">{isOpen ? '▲' : '▼'}</span>
      </button>

      {isOpen && dropdownPos && createPortal(dropdownPanel, document.body)}
    </div>
  )
}
