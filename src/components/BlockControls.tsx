import React from 'react'

export type BlockKind =
  | 'text'
  | 'image'
  | 'table'
  | 'table_of_contents'
  | 'horizontal_rule'
  | 'floating_object'

export interface BlockRect {
  pageIndex: number
  left: number
  top: number
  width: number
  height: number
}

export interface BlockDescriptor {
  blockIndex: number
  pos: number
  nodeSize: number
  type: BlockKind
  nodeType: string
  paragraphIndex: number | null
  title: string
  rects: BlockRect[]
  tableStyle?: {
    backgroundColor: string
    borderColor: string
    borderWidth: number
  }
  paragraphStyle?: {
    headingLevel: number | null
    align: 'left' | 'center' | 'right' | 'justify'
    listType: 'none' | 'bullet' | 'ordered' | 'task'
  }
}

export type BlockTableCommand =
  | 'row-before'
  | 'row-after'
  | 'row-delete'
  | 'col-before'
  | 'col-after'
  | 'col-delete'

interface BlockControlsProps {
  blocks: BlockDescriptor[]
  selectedBlockPos: number | null
  onSelectBlock: (block: BlockDescriptor) => void
  onCopyBlock: (block: BlockDescriptor) => void
  onCutBlock: (block: BlockDescriptor) => void
  onDuplicateBlock: (block: BlockDescriptor) => void
  onDeleteBlock: (block: BlockDescriptor) => void
  onSetParagraphRole: (block: BlockDescriptor, headingLevel: 0 | 1 | 2 | 3) => void
  onSetParagraphAlign: (block: BlockDescriptor, align: 'left' | 'center' | 'right' | 'justify') => void
  onToggleParagraphList: (block: BlockDescriptor, listType: 'bullet' | 'ordered' | 'task') => void
  onClearBlockFormatting: (block: BlockDescriptor) => void
  onReplaceImage: (block: BlockDescriptor, file: File) => void
  onRunTableCommand: (block: BlockDescriptor, command: BlockTableCommand) => void
  onSetTableStyle: (block: BlockDescriptor, attrs: { backgroundColor?: string; borderColor?: string; borderWidth?: number }) => void
  onAskAI: (block: BlockDescriptor) => void
}

function getPrimaryRect(block: BlockDescriptor) {
  return block.rects[0] ?? null
}

function getHandleLabel(block: BlockDescriptor) {
  if (block.type === 'image') return '图'
  if (block.type === 'table') return '表'
  if (block.type === 'table_of_contents') return '目'
  if (block.type === 'horizontal_rule') return '线'
  if (block.type === 'floating_object') return '浮'
  return 'T'
}

function getColorValue(value: string | undefined, fallback: string) {
  return /^#[0-9a-f]{6}$/i.test(value ?? '') ? value! : fallback
}

const TEXT_MENU_WIDTH = 220
const COMPACT_MENU_WIDTH = 210
const MENU_VIEWPORT_GAP = 8
const MENU_PAGE_EDGE_GAP = 12
const TEXT_MENU_CONTENT_GAP = 48
const TEXT_MENU_ESTIMATED_HEIGHT = 220

function getBlockMenuPosition(rect: BlockRect, type: BlockKind) {
  const panelWidth = type === 'text' ? TEXT_MENU_WIDTH : COMPACT_MENU_WIDTH
  const pageLeft = Math.max(0, rect.left - 113)
  const preferredLeft = type === 'text'
    ? rect.left - TEXT_MENU_CONTENT_GAP - panelWidth
    : pageLeft - MENU_PAGE_EDGE_GAP - panelWidth
  const maxLeft = Math.max(MENU_VIEWPORT_GAP, rect.left + rect.width - panelWidth)
  const left = Math.min(Math.max(MENU_VIEWPORT_GAP, preferredLeft), maxLeft)
  return {
    width: panelWidth,
    left,
    top: type === 'text'
      ? (rect.top - TEXT_MENU_ESTIMATED_HEIGHT - MENU_VIEWPORT_GAP >= MENU_VIEWPORT_GAP
        ? rect.top - TEXT_MENU_ESTIMATED_HEIGHT - MENU_VIEWPORT_GAP
        : rect.top + rect.height + MENU_VIEWPORT_GAP)
      : Math.max(MENU_VIEWPORT_GAP, rect.top - 30),
  }
}

function MenuButton({
  children,
  title,
  onMouseDown,
  variant = 'tile',
  active = false,
}: {
  children: React.ReactNode
  title?: string
  onMouseDown: React.MouseEventHandler<HTMLButtonElement>
  variant?: 'tile' | 'compact' | 'wide'
  active?: boolean
}) {
  const isTile = variant === 'tile'
  const isWide = variant === 'wide'
  const restingBackground = active ? '#e5e7eb' : 'transparent'

  return (
    <button
      title={title}
      onMouseDown={onMouseDown}
      style={{
        width: isWide ? '100%' : isTile ? 38 : 'auto',
        minWidth: isTile ? 38 : 42,
        height: isTile ? 38 : 26,
        padding: isTile ? 0 : '0 8px',
        border: '1px solid transparent',
        borderRadius: isTile ? 8 : 6,
        background: restingBackground,
        color: '#1f2937',
        fontSize: isTile ? 19 : 11,
        fontWeight: isTile ? 400 : 400,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'background 120ms ease',
      }}
      onMouseEnter={(event) => { event.currentTarget.style.background = '#e5e7eb' }}
      onMouseLeave={(event) => { event.currentTarget.style.background = restingBackground }}
    >
      {children}
    </button>
  )
}

export const BlockControls: React.FC<BlockControlsProps> = ({
  blocks,
  selectedBlockPos,
  onSelectBlock,
  onCopyBlock,
  onCutBlock,
  onDuplicateBlock,
  onDeleteBlock,
  onSetParagraphRole,
  onSetParagraphAlign,
  onToggleParagraphList,
  onClearBlockFormatting,
  onReplaceImage,
  onRunTableCommand,
  onSetTableStyle,
  onAskAI,
}) => {
  const [hoveredBlockPos, setHoveredBlockPos] = React.useState<number | null>(null)
  const imageInputRef = React.useRef<HTMLInputElement | null>(null)
  const pendingImageBlockRef = React.useRef<BlockDescriptor | null>(null)
  const selectedBlock = selectedBlockPos == null
    ? null
    : blocks.find((block) => block.pos === selectedBlockPos) ?? null
  const menuRect = selectedBlock ? getPrimaryRect(selectedBlock) : null
  const menuPosition = menuRect && selectedBlock ? getBlockMenuPosition(menuRect, selectedBlock.type) : null
  const paragraphStyle = selectedBlock?.paragraphStyle

  return (
    <div
      aria-hidden="true"
      data-openwps-block-controls="true"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 6,
      }}
    >
      {blocks.flatMap((block) => block.rects.map((rect) => {
        const selected = selectedBlockPos === block.pos
        const hovered = hoveredBlockPos === block.pos
        return (
          <React.Fragment key={`${block.pos}-${rect.pageIndex}`}>
            {selected && (
              <div
                data-openwps-block-outline={block.type}
                style={{
                  position: 'absolute',
                  left: rect.left - 4,
                  top: rect.top - 3,
                  width: rect.width + 8,
                  height: rect.height + 6,
                  border: '2px solid #2563eb',
                  borderRadius: block.type === 'table' || block.type === 'image' ? 6 : 4,
                  background: 'rgba(37, 99, 235, 0.04)',
                  boxSizing: 'border-box',
                  pointerEvents: 'none',
                }}
              />
            )}
            <button
              aria-label={`选择${block.title}`}
              title={`选择${block.title}`}
              data-openwps-block-handle={block.type}
              onMouseDown={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onSelectBlock(block)
              }}
              onMouseEnter={() => setHoveredBlockPos(block.pos)}
              onMouseLeave={() => setHoveredBlockPos((current) => (current === block.pos ? null : current))}
              style={{
                position: 'absolute',
                left: Math.max(4, rect.left - 36),
                top: rect.top,
                width: 28,
                height: 28,
                border: selected ? '1px solid #2563eb' : '1px solid transparent',
                borderRadius: selected ? 7 : 4,
                background: selected ? '#dbeafe' : hovered ? 'rgba(243,244,246,0.96)' : 'transparent',
                color: selected ? '#1d4ed8' : '#4b5563',
                boxShadow: selected ? '0 4px 14px rgba(15, 23, 42, 0.14)' : 'none',
                cursor: 'pointer',
                fontSize: block.type === 'text' ? 26 : 12,
                fontWeight: 700,
                lineHeight: 1,
                pointerEvents: 'auto',
                userSelect: 'none',
              }}
            >
              {getHandleLabel(block)}
            </button>
          </React.Fragment>
        )
      }))}

      {selectedBlock && menuRect && menuPosition && (
        <div
          data-openwps-block-menu={selectedBlock.type}
          onMouseDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          style={{
            position: 'absolute',
            left: menuPosition.left,
            top: menuPosition.top,
            width: menuPosition.width,
            boxSizing: 'border-box',
            display: 'block',
            padding: selectedBlock.type === 'text' ? '16px 16px 14px' : 10,
            border: '1px solid #e5e7eb',
            borderRadius: selectedBlock.type === 'text' ? 16 : 10,
            background: 'rgba(255,255,255,0.98)',
            boxShadow: selectedBlock.type === 'text'
              ? '0 22px 54px rgba(15, 23, 42, 0.16)'
              : '0 20px 46px rgba(15, 23, 42, 0.18)',
            pointerEvents: 'auto',
          }}
        >
          {(selectedBlock.type === 'text' || selectedBlock.type === 'image') && (
            <>
              {selectedBlock.type === 'text' && (
                <>
                  <div style={tileGridStyle}>
                    <MenuButton title="正文" active={!paragraphStyle?.headingLevel} onMouseDown={() => onSetParagraphRole(selectedBlock, 0)}>T</MenuButton>
                    <MenuButton title="标题 1" active={paragraphStyle?.headingLevel === 1} onMouseDown={() => onSetParagraphRole(selectedBlock, 1)}>H1</MenuButton>
                    <MenuButton title="标题 2" active={paragraphStyle?.headingLevel === 2} onMouseDown={() => onSetParagraphRole(selectedBlock, 2)}>H2</MenuButton>
                    <MenuButton title="标题 3" active={paragraphStyle?.headingLevel === 3} onMouseDown={() => onSetParagraphRole(selectedBlock, 3)}>H3</MenuButton>
                    <MenuButton title="左对齐" active={paragraphStyle?.align === 'left'} onMouseDown={() => onSetParagraphAlign(selectedBlock, 'left')}><AlignGlyph align="left" /></MenuButton>
                    <MenuButton title="居中" active={paragraphStyle?.align === 'center'} onMouseDown={() => onSetParagraphAlign(selectedBlock, 'center')}><AlignGlyph align="center" /></MenuButton>
                    <MenuButton title="右对齐" active={paragraphStyle?.align === 'right'} onMouseDown={() => onSetParagraphAlign(selectedBlock, 'right')}><AlignGlyph align="right" /></MenuButton>
                    <MenuButton title="两端对齐" active={paragraphStyle?.align === 'justify'} onMouseDown={() => onSetParagraphAlign(selectedBlock, 'justify')}><AlignGlyph align="justify" /></MenuButton>
                    <MenuButton title="任务列表" active={paragraphStyle?.listType === 'task'} onMouseDown={() => onToggleParagraphList(selectedBlock, 'task')}><TaskGlyph /></MenuButton>
                    <MenuButton title="无序列表" active={paragraphStyle?.listType === 'bullet'} onMouseDown={() => onToggleParagraphList(selectedBlock, 'bullet')}><BulletListGlyph /></MenuButton>
                    <MenuButton title="有序列表" active={paragraphStyle?.listType === 'ordered'} onMouseDown={() => onToggleParagraphList(selectedBlock, 'ordered')}><OrderedListGlyph /></MenuButton>
                    <MenuButton title="清除格式" onMouseDown={() => onClearBlockFormatting(selectedBlock)}><ParagraphGlyph /></MenuButton>
                  </div>
                </>
              )}
              {selectedBlock.type === 'image' && (
                <div style={compactGridStyle}>
                  <MenuButton
                    title="替换图片"
                    variant="compact"
                    onMouseDown={() => {
                      pendingImageBlockRef.current = selectedBlock
                      imageInputRef.current?.click()
                    }}
                  >
                    替换
                  </MenuButton>
                </div>
              )}
            </>
          )}

          {selectedBlock.type === 'table' && (
            <div style={{ display: 'grid', gap: 12 }}>
              <div style={compactGridStyle}>
                <MenuButton title="上方插入行" variant="compact" onMouseDown={() => onRunTableCommand(selectedBlock, 'row-before')}>上行</MenuButton>
                <MenuButton title="下方插入行" variant="compact" onMouseDown={() => onRunTableCommand(selectedBlock, 'row-after')}>下行</MenuButton>
                <MenuButton title="删除行" variant="compact" onMouseDown={() => onRunTableCommand(selectedBlock, 'row-delete')}>删行</MenuButton>
                <MenuButton title="左侧插入列" variant="compact" onMouseDown={() => onRunTableCommand(selectedBlock, 'col-before')}>左列</MenuButton>
                <MenuButton title="右侧插入列" variant="compact" onMouseDown={() => onRunTableCommand(selectedBlock, 'col-after')}>右列</MenuButton>
                <MenuButton title="删除列" variant="compact" onMouseDown={() => onRunTableCommand(selectedBlock, 'col-delete')}>删列</MenuButton>
              </div>
              <div style={inlineControlRowStyle}>
              <label style={labelStyle}>
                填充
                <input
                  title="表格填充色"
                  type="color"
                  value={getColorValue(selectedBlock.tableStyle?.backgroundColor, '#ffffff')}
                  onChange={(event) => onSetTableStyle(selectedBlock, { backgroundColor: event.target.value })}
                  style={colorInputStyle}
                />
              </label>
              <label style={labelStyle}>
                边框
                <input
                  title="表格边框色"
                  type="color"
                  value={getColorValue(selectedBlock.tableStyle?.borderColor, '#cccccc')}
                  onChange={(event) => onSetTableStyle(selectedBlock, { borderColor: event.target.value })}
                  style={colorInputStyle}
                />
              </label>
              <select
                title="表格边框宽度"
                value={String(selectedBlock.tableStyle?.borderWidth ?? 1)}
                onChange={(event) => onSetTableStyle(selectedBlock, { borderWidth: Number(event.target.value) })}
                style={{
                  height: 28,
                  border: '1px solid #d1d5db',
                  borderRadius: 6,
                  background: 'white',
                  fontSize: 12,
                }}
              >
                {[0, 1, 2, 3].map((value) => (
                  <option key={value} value={value}>{value}px</option>
                ))}
              </select>
              </div>
            </div>
          )}

          {selectedBlock.type !== 'text' && (
            <>
              <PanelSeparator />
              <div style={compactGridStyle}>
                <MenuButton title="复制块" variant="compact" onMouseDown={() => onCopyBlock(selectedBlock)}>复制</MenuButton>
                <MenuButton title="剪切块" variant="compact" onMouseDown={() => onCutBlock(selectedBlock)}>剪切</MenuButton>
                <MenuButton title="重复块" variant="compact" onMouseDown={() => onDuplicateBlock(selectedBlock)}>重复</MenuButton>
                <MenuButton title="删除块" variant="compact" onMouseDown={() => onDeleteBlock(selectedBlock)}>删除</MenuButton>
              </div>
            </>
          )}
          {selectedBlock.type === 'text' && (
            <>
              <PanelSeparator />
              <button
                title="用 WPS AI 修改此文本块"
                onMouseDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  onAskAI(selectedBlock)
                }}
                style={aiButtonStyle}
              >
                <span style={aiMarkStyle}>A</span>
                WPS AI
              </button>
            </>
          )}
        </div>
      )}

      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0]
          const block = pendingImageBlockRef.current
          pendingImageBlockRef.current = null
          if (file && block) onReplaceImage(block, file)
          event.target.value = ''
        }}
      />
    </div>
  )
}

function PanelSeparator() {
  return <div style={{ height: 1, background: '#eceff3', margin: '14px 0 12px' }} />
}

const tileGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, 38px)',
  columnGap: 6,
  rowGap: 8,
  justifyContent: 'space-between',
}

const compactGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
  gap: 6,
}

const inlineControlRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
}

const labelStyle: React.CSSProperties = {
  height: 26,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '0 6px',
  borderRadius: 6,
  color: '#374151',
  fontSize: 11,
  whiteSpace: 'nowrap',
}

const colorInputStyle: React.CSSProperties = {
  width: 20,
  height: 20,
  padding: 0,
  border: '1px solid #d1d5db',
  borderRadius: 4,
  background: 'transparent',
  cursor: 'pointer',
}

const aiButtonStyle: React.CSSProperties = {
  width: '100%',
  height: 34,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '0 10px',
  border: '1px solid transparent',
  borderRadius: 10,
  background: 'transparent',
  color: '#111827',
  fontSize: 18,
  fontWeight: 400,
  cursor: 'pointer',
}

const aiMarkStyle: React.CSSProperties = {
  width: 18,
  height: 18,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 6,
  background: 'linear-gradient(135deg, #2563eb, #a855f7 48%, #f97316)',
  color: '#ffffff',
  fontSize: 11,
  fontWeight: 700,
}

function AlignGlyph({ align }: { align: 'left' | 'center' | 'right' | 'justify' }) {
  const widths = align === 'justify' ? [24, 24, 24] : [24, 15, 20]
  const justifyContent = align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start'
  return (
    <span style={{ width: 25, display: 'grid', gap: 4 }}>
      {widths.map((width, index) => (
        <span
          key={index}
          style={{
            width,
            height: 2,
            justifySelf: justifyContent,
            borderRadius: 999,
            background: '#1f2937',
          }}
        />
      ))}
    </span>
  )
}

function TaskGlyph() {
  return (
    <span
      style={{
        width: 28,
        height: 28,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '2px solid #1f2937',
        borderRadius: 2,
        fontSize: 18,
        lineHeight: 1,
      }}
    >
      ✓
    </span>
  )
}

function BulletListGlyph() {
  return (
    <span style={{ width: 27, display: 'grid', gridTemplateColumns: '5px 1fr', alignItems: 'center', gap: '4px 6px' }}>
      {[0, 1, 2].flatMap((index) => [
        <span key={`dot-${index}`} style={{ width: 4, height: 4, borderRadius: 999, background: '#1f2937' }} />,
        <span key={`line-${index}`} style={{ width: 18, height: 2, borderRadius: 999, background: '#1f2937' }} />,
      ])}
    </span>
  )
}

function OrderedListGlyph() {
  return (
    <span style={{ width: 30, display: 'grid', gridTemplateColumns: '9px 1fr', alignItems: 'center', gap: '1px 4px', fontSize: 13, lineHeight: '11px' }}>
      <span>1</span><span style={{ width: 17, height: 2, borderRadius: 999, background: '#1f2937' }} />
      <span>2</span><span style={{ width: 17, height: 2, borderRadius: 999, background: '#1f2937' }} />
      <span>3</span><span style={{ width: 17, height: 2, borderRadius: 999, background: '#1f2937' }} />
    </span>
  )
}

function ParagraphGlyph() {
  return (
    <span style={{ position: 'relative', width: 27, height: 27, display: 'inline-block' }}>
      <span style={{ position: 'absolute', left: 1, top: 6, width: 21, height: 2, borderRadius: 999, background: '#1f2937' }} />
      <span style={{ position: 'absolute', right: 0, top: 14, width: 16, height: 2, borderRadius: 999, background: '#1f2937' }} />
      <span style={{ position: 'absolute', left: 1, bottom: 5, width: 21, height: 2, borderRadius: 999, background: '#1f2937' }} />
      <span style={{ position: 'absolute', right: 3, bottom: 0, color: '#2563eb', fontSize: 18, lineHeight: 1 }}>¶</span>
    </span>
  )
}
