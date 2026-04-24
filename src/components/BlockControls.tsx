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

function getBlockMenuPosition(rect: BlockRect) {
  const panelWidth = 210
  const pageEdgeGap = 12
  const pageLeft = Math.max(0, rect.left - 113)
  const left = pageLeft - pageEdgeGap - panelWidth
  return {
    width: panelWidth,
    left,
    top: Math.max(8, rect.top - 30),
  }
}

function MenuButton({
  children,
  title,
  onMouseDown,
  variant = 'tile',
}: {
  children: React.ReactNode
  title?: string
  onMouseDown: React.MouseEventHandler<HTMLButtonElement>
  variant?: 'tile' | 'compact' | 'wide'
}) {
  const isTile = variant === 'tile'
  const isWide = variant === 'wide'

  return (
    <button
      title={title}
      onMouseDown={onMouseDown}
      style={{
        width: isWide ? '100%' : isTile ? 34 : 'auto',
        minWidth: isTile ? 34 : 42,
        height: isTile ? 34 : 26,
        padding: isTile ? 0 : '0 8px',
        border: '1px solid transparent',
        borderRadius: isTile ? 7 : 6,
        background: 'transparent',
        color: '#1f2937',
        fontSize: isTile ? 17 : 11,
        fontWeight: isTile ? 400 : 400,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onMouseEnter={(event) => { event.currentTarget.style.background = '#f3f4f6' }}
      onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent' }}
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
  const menuPosition = menuRect ? getBlockMenuPosition(menuRect) : null

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
            display: 'block',
            padding: 10,
            border: '1px solid #e5e7eb',
            borderRadius: 10,
            background: 'rgba(255,255,255,0.98)',
            boxShadow: '0 20px 46px rgba(15, 23, 42, 0.18)',
            pointerEvents: 'auto',
          }}
        >
          {(selectedBlock.type === 'text' || selectedBlock.type === 'image') && (
            <>
              {selectedBlock.type === 'text' && (
                <>
                  <div style={tileGridStyle}>
                    <MenuButton title="正文" onMouseDown={() => onSetParagraphRole(selectedBlock, 0)}>T</MenuButton>
                    <MenuButton title="标题 1" onMouseDown={() => onSetParagraphRole(selectedBlock, 1)}>H1</MenuButton>
                    <MenuButton title="标题 2" onMouseDown={() => onSetParagraphRole(selectedBlock, 2)}>H2</MenuButton>
                    <MenuButton title="标题 3" onMouseDown={() => onSetParagraphRole(selectedBlock, 3)}>H3</MenuButton>
                    <MenuButton title="左对齐" onMouseDown={() => onSetParagraphAlign(selectedBlock, 'left')}>左</MenuButton>
                    <MenuButton title="居中" onMouseDown={() => onSetParagraphAlign(selectedBlock, 'center')}>中</MenuButton>
                    <MenuButton title="右对齐" onMouseDown={() => onSetParagraphAlign(selectedBlock, 'right')}>右</MenuButton>
                    <MenuButton title="两端对齐" onMouseDown={() => onSetParagraphAlign(selectedBlock, 'justify')}>齐</MenuButton>
                    <MenuButton title="任务列表" onMouseDown={() => onToggleParagraphList(selectedBlock, 'task')}>☑</MenuButton>
                    <MenuButton title="无序列表" onMouseDown={() => onToggleParagraphList(selectedBlock, 'bullet')}>•</MenuButton>
                    <MenuButton title="有序列表" onMouseDown={() => onToggleParagraphList(selectedBlock, 'ordered')}>1.</MenuButton>
                    <MenuButton title="清除格式" onMouseDown={() => onClearBlockFormatting(selectedBlock)}>¶</MenuButton>
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

          <PanelSeparator />
          <div style={compactGridStyle}>
            <MenuButton title="复制块" variant="compact" onMouseDown={() => onCopyBlock(selectedBlock)}>复制</MenuButton>
            <MenuButton title="剪切块" variant="compact" onMouseDown={() => onCutBlock(selectedBlock)}>剪切</MenuButton>
            <MenuButton title="重复块" variant="compact" onMouseDown={() => onDuplicateBlock(selectedBlock)}>重复</MenuButton>
            <MenuButton title="删除块" variant="compact" onMouseDown={() => onDeleteBlock(selectedBlock)}>删除</MenuButton>
          </div>
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
  return <div style={{ height: 1, background: '#e5e7eb', margin: '8px 0' }} />
}

const tileGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, 34px)',
  columnGap: 12,
  rowGap: 8,
  justifyContent: 'center',
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
  gap: 9,
  padding: '0 10px',
  border: '1px solid transparent',
  borderRadius: 8,
  background: 'transparent',
  color: '#111827',
  fontSize: 15,
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
