import { useEffect, useState } from 'react'
import type { PageConfig } from '../layout/paginator'

const pxToMm = (px: number) => Math.round((px / 3.7795) * 100) / 100
const mmToPx = (mm: number) => Math.round(mm * 3.7795)
const pxToCmLabel = (px: number) => (pxToMm(px) / 10).toFixed(2)

const PAGE_PRESETS: Record<string, { pageWidth: number; pageHeight: number }> = {
    A4: { pageWidth: 794, pageHeight: 1123 },
    A3: { pageWidth: 1123, pageHeight: 1587 },
    Letter: { pageWidth: 816, pageHeight: 1056 },
}

const MARGIN_PRESETS = [
    { id: 'normal', label: '普通', margins: { marginTop: 96, marginBottom: 96, marginLeft: 120, marginRight: 120 } },
    { id: 'narrow', label: '窄', margins: { marginTop: 48, marginBottom: 48, marginLeft: 48, marginRight: 48 } },
    { id: 'moderate', label: '适中', margins: { marginTop: 96, marginBottom: 96, marginLeft: 72, marginRight: 72 } },
    { id: 'wide', label: '宽', margins: { marginTop: 96, marginBottom: 96, marginLeft: 192, marginRight: 192 } },
] as const

export type PageSettingsSection = 'margins' | 'orientation' | 'size' | 'all'

interface PageSettingsPanelProps {
    pageConfig: PageConfig
    onPageConfigChange: (cfg: PageConfig) => void
    saveLabel?: string
    section?: PageSettingsSection
    onOpenAllSettings?: () => void
}

function withMargins(config: PageConfig, margins: Pick<PageConfig, 'marginTop' | 'marginBottom' | 'marginLeft' | 'marginRight'>) {
    return { ...config, ...margins }
}

function isSameMargins(config: PageConfig, margins: Pick<PageConfig, 'marginTop' | 'marginBottom' | 'marginLeft' | 'marginRight'>) {
    return config.marginTop === margins.marginTop
        && config.marginBottom === margins.marginBottom
        && config.marginLeft === margins.marginLeft
        && config.marginRight === margins.marginRight
}

function OrientationPreview({ portrait }: { portrait: boolean }) {
    return (
        <div className="mx-auto mb-3 flex h-28 w-20 items-center justify-center rounded-2xl border border-gray-300 bg-white shadow-sm">
            <div
                className="rounded-lg bg-gray-200"
                style={portrait ? { height: 88, width: 48 } : { height: 48, width: 64 }}
            />
        </div>
    )
}

export default function PageSettingsPanel({
    pageConfig,
    onPageConfigChange,
    saveLabel = '应用',
    section = 'all',
    onOpenAllSettings,
}: PageSettingsPanelProps) {
    const [draft, setDraft] = useState({ ...pageConfig })

    useEffect(() => {
        setDraft({ ...pageConfig })
    }, [pageConfig])

    const labelClassName = 'block text-xs font-medium text-gray-500 mb-1'
    const inputClassName = 'w-full text-sm border border-gray-300 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400'
    const isPortrait = draft.pageWidth <= draft.pageHeight

    const marginContent = (
        <div className="space-y-5">
            <div className="grid grid-cols-4 gap-5">
                {MARGIN_PRESETS.map(preset => {
                    const active = isSameMargins(draft, preset.margins)
                    return (
                        <button
                            key={preset.id}
                            type="button"
                            onClick={() => setDraft(current => withMargins(current, preset.margins))}
                            className={`rounded-2xl border px-4 py-4 text-left transition-colors ${active ? 'border-blue-300 bg-[#f5f8ff]' : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'}`}
                        >
                            <div className={`mx-auto mb-3 flex h-40 w-28 items-center justify-center rounded-2xl ${active ? 'bg-gray-100' : 'bg-white'}`}>
                                <div
                                    className="rounded-xl border border-gray-300 bg-white"
                                    style={{
                                        width: 102,
                                        height: 132,
                                        paddingTop: pxToMm(preset.margins.marginTop) * 2.1,
                                        paddingBottom: pxToMm(preset.margins.marginBottom) * 2.1,
                                        paddingLeft: pxToMm(preset.margins.marginLeft) * 1.5,
                                        paddingRight: pxToMm(preset.margins.marginRight) * 1.5,
                                        boxShadow: active ? '0 0 0 2px rgba(59,130,246,0.18)' : 'none',
                                    }}
                                >
                                    <div className="h-full w-full rounded-lg bg-gray-200" />
                                </div>
                            </div>
                            <div className="text-[15px] font-semibold text-gray-800">{preset.label}</div>
                            <div className="mt-3 space-y-1 text-sm text-gray-500">
                                <div>上下: {pxToCmLabel(preset.margins.marginTop)} cm</div>
                                <div>左右: {pxToCmLabel(preset.margins.marginLeft)} cm</div>
                            </div>
                        </button>
                    )
                })}
            </div>

            <div className="rounded-2xl border border-gray-200 bg-white p-5">
                <div className="mb-4 text-lg font-semibold text-gray-800">自定义页边距</div>
                <div className="grid grid-cols-2 gap-x-10 gap-y-4">
                    {(['marginTop', 'marginLeft', 'marginBottom', 'marginRight'] as const).map(key => (
                        <label key={key} className="flex items-center gap-3">
                            <span className="w-6 text-sm text-gray-700">{key === 'marginTop' ? '上' : key === 'marginBottom' ? '下' : key === 'marginLeft' ? '左' : '右'}</span>
                            <input
                                type="number"
                                min={0}
                                max={20}
                                step={0.1}
                                value={pxToCmLabel(draft[key])}
                                onChange={e => setDraft(current => ({ ...current, [key]: mmToPx(Number(e.target.value) * 10) }))}
                                className="w-40 rounded-xl border border-gray-300 px-4 py-2 text-base focus:outline-none focus:ring-2 focus:ring-blue-400"
                            />
                            <span className="text-sm text-gray-500">厘米</span>
                        </label>
                    ))}
                </div>
            </div>

            {onOpenAllSettings && (
                <div className="flex items-center justify-between border-t border-gray-100 pt-1">
                    <button
                        type="button"
                        onClick={onOpenAllSettings}
                        className="inline-flex items-center gap-2 rounded-xl px-2 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
                    >
                        <span className="text-base">⚙</span>
                        <span>更多设置</span>
                    </button>
                </div>
            )}
        </div>
    )

    const orientationContent = (
        <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
                <button
                    type="button"
                    onClick={() => setDraft(current => ({ ...current, pageWidth: Math.min(current.pageWidth, current.pageHeight), pageHeight: Math.max(current.pageWidth, current.pageHeight) }))}
                    className={`rounded-2xl border px-5 py-5 text-center transition-colors ${isPortrait ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white hover:bg-gray-50'}`}
                >
                    <OrientationPreview portrait />
                    <div className="text-lg font-semibold">纵向</div>
                </button>
                <button
                    type="button"
                    onClick={() => setDraft(current => ({ ...current, pageWidth: Math.max(current.pageWidth, current.pageHeight), pageHeight: Math.min(current.pageWidth, current.pageHeight) }))}
                    className={`rounded-2xl border px-5 py-5 text-center transition-colors ${!isPortrait ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white hover:bg-gray-50'}`}
                >
                    <OrientationPreview portrait={false} />
                    <div className="text-lg font-semibold">横向</div>
                </button>
            </div>
        </div>
    )

    const sizeContent = (
        <div className="space-y-4">
            <div>
                <label className={labelClassName}>纸张大小</label>
                <select
                    className={inputClassName}
                    value={Object.keys(PAGE_PRESETS).find(key => PAGE_PRESETS[key].pageWidth === draft.pageWidth && PAGE_PRESETS[key].pageHeight === draft.pageHeight) ?? 'custom'}
                    onChange={e => {
                        const preset = PAGE_PRESETS[e.target.value]
                        if (preset) setDraft(current => ({ ...current, ...preset }))
                    }}
                >
                    {Object.keys(PAGE_PRESETS).map(key => <option key={key} value={key}>{key}</option>)}
                    <option value="custom">自定义</option>
                </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
                <label>
                    <span className={labelClassName}>宽度（毫米）</span>
                    <input
                        type="number"
                        min={50}
                        max={1000}
                        step={1}
                        value={pxToMm(draft.pageWidth)}
                        onChange={e => setDraft(current => ({ ...current, pageWidth: mmToPx(Number(e.target.value)) }))}
                        className={inputClassName}
                    />
                </label>
                <label>
                    <span className={labelClassName}>高度（毫米）</span>
                    <input
                        type="number"
                        min={50}
                        max={1000}
                        step={1}
                        value={pxToMm(draft.pageHeight)}
                        onChange={e => setDraft(current => ({ ...current, pageHeight: mmToPx(Number(e.target.value)) }))}
                        className={inputClassName}
                    />
                </label>
            </div>
        </div>
    )

    const content = section === 'margins'
        ? marginContent
        : section === 'orientation'
            ? orientationContent
            : section === 'size'
                ? sizeContent
                : (
                    <div className="space-y-6">
                        {sizeContent}
                        {orientationContent}
                        {marginContent}
                    </div>
                )

    const widthClassName = section === 'margins'
        ? 'w-[800px]'
        : section === 'orientation'
            ? 'w-[360px]'
            : section === 'size'
                ? 'w-[360px]'
                : 'w-[840px]'

    return (
        <div className={`${widthClassName} max-w-[calc(100vw-2rem)] rounded-[24px] border border-gray-200 bg-white p-6 shadow-[0_18px_50px_rgba(15,23,42,0.14)]`}>
            {content}
            <div className="mt-5 flex justify-end border-t border-gray-100 pt-4">
                <button
                    type="button"
                    onClick={() => onPageConfigChange(draft)}
                    className="rounded-xl bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600"
                >
                    {saveLabel}
                </button>
            </div>
        </div>
    )
}