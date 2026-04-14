# openwps 原生软件最终实施规格

## 1. 决策结论

openwps 后续不再被定义为“网页文档编辑器”，而被定义为“原生桌面文档软件”。

该决策包含以下不可回退的约束：

1. 文档编辑、排版、渲染、光标、选区、表格交互全部由原生内核负责。
2. 文档主视图不依赖浏览器 DOM、contenteditable、WebView selection、浏览器排版或浏览器表格编辑行为。
3. 当前仓库只保留三类价值：规则来源、AI 服务来源、导入导出语义来源。
4. 最终实现不以“最快可用”为目标，不接受临时桥接方案长期留存，不接受为了缩短实现周期而把浏览器重新引回文档编辑主链路。

## 2. 成品定义

本项目的成品是一个可安装、可离线打开文档、可稳定编辑、可精确分页、可由 AI 直接操作的原生软件。

成品必须满足以下条件：

1. 支持多页 A4 页面视图，缩放后仍保持稳定布局。
2. 支持段落、文字样式、列表、表格、图片、分页符、分割线、代码块、公式块、Mermaid 块。
3. 支持内部原生文档格式，并支持 DOCX 导入导出。
4. 支持 AI 读取文档摘要、生成命令计划、执行命令并校验结果。
5. 文档区在无网络、无 AI 服务、无浏览器的情况下仍可独立工作。
6. 表格、列表、光标、选区、输入法行为由原生运行时统一控制，不依赖浏览器默认行为。

## 3. 强约束与禁止妥协

以下条目为架构层面的硬约束，不允许在后续实现中被稀释为“临时方案”。

### 3.1 禁止事项

1. 禁止在最终产品中嵌入网页编辑器作为文档主编辑区。
2. 禁止将浏览器排版结果作为页面布局真值来源。
3. 禁止让 DOM selection 或浏览器 caret 决定文档光标位置。
4. 禁止继续以 ProseMirror 作为最终文档模型。
5. 禁止长期保留“原生文档模型”和“浏览器编辑模型”双写同步。
6. 禁止让 AI 通过 UI 补丁或模拟点击修改文档。
7. 禁止把 paragraph index 这类脆弱定位方式作为最终 AI 写操作主键。

### 3.2 允许事项

1. 允许当前仓库在迁移期间继续承担规则提炼和样例生成工作。
2. 允许 AI 服务在最终产品中继续作为独立进程存在。
3. 允许在实现过程中编写一次性迁移工具，但这些工具不能进入最终编辑主链路。

## 4. 产品边界

### 4.1 支持的平台

最终产品的优先平台定义如下：

1. 第一优先级：macOS
2. 第二优先级：Windows
3. 第三优先级：Linux，可选，不进入第一版强制范围

之所以这样定义，是因为字体、输入法、窗口行为、打印系统在桌面文档软件中属于一级问题，必须先把两个主要桌面平台做深，而不是一开始追求最大覆盖面。

### 4.2 支持的工作模式

最终产品支持以下工作模式：

1. 纯离线编辑
2. 本地文件编辑
3. AI 辅助编辑
4. 导入 DOCX 后继续本地编辑
5. 导出 DOCX 进行外部交换

### 4.3 非目标能力

以下能力不进入第一版成品边界：

1. 多人协作
2. 云同步
3. 浏览器在线编辑
4. 插件市场
5. 修订模式
6. 批注、脚注、尾注、目录、交叉引用
7. 图文绕排、多栏、复杂页眉页脚系统

这些能力并非永久排除，但它们必须建立在原生文档内核稳定之后，而不能反过来决定内核结构。

## 5. 最终技术栈

### 5.1 固定技术选择

最终架构固定采用以下技术路线：

1. 核心语言：Rust
2. 窗口与事件循环：winit 或 tao
3. 绘制与页面渲染：Skia
4. 文本 shaping：rustybuzz
5. 字体发现、注册与 fallback：fontdb
6. 文本分段与 Unicode 边界处理：unicode-segmentation 与必要的 Unicode 数据支持
7. AI 服务：独立 Python 进程，保持与当前仓库后端兼容的协议边界

### 5.2 不作为核心技术的选项

以下技术即便在外围工具中出现，也不得进入文档编辑核心：

1. React DOM
2. ProseMirror
3. HTML contenteditable
4. WebView 富文本
5. 浏览器 Canvas 作为最终页面绘制宿主

### 5.3 进程模型

最终应用采用多进程或最少双进程结构：

1. 主程序：原生桌面应用进程
2. AI 服务：独立 sidecar 进程

主程序内部再划分线程或任务域：

1. UI 事件循环线程
2. 布局与重排任务线程
3. 文件 I/O 与导入导出任务线程
4. AI 通讯任务线程

## 6. 模块架构与依赖规则

最终仓库建议拆分为以下模块：

1. app-shell
2. document-core
3. layout-engine
4. renderer-skia
5. editor-runtime
6. docx-interop
7. ai-bridge
8. native-storage
9. test-fixtures
10. legacy-spec

### 6.1 app-shell

职责：

1. 窗口生命周期
2. 菜单、最近文件、设置面板
3. 文档标签页或多窗口管理
4. 启动与关闭 sidecar
5. 文件打开、保存、另存为、自动恢复入口

允许依赖：

1. editor-runtime
2. ai-bridge
3. native-storage

禁止依赖：

1. 直接修改 AST
2. 直接发起布局计算
3. 直接读写渲染缓存

### 6.2 document-core

职责：

1. Native AST
2. 选择模型
3. 命令系统
4. 事务系统
5. Undo/Redo
6. 版本快照与操作日志

允许依赖：

1. 纯数据与基础算法库

禁止依赖：

1. Skia
2. 窗口系统
3. AI 服务实现
4. DOCX 文件 I/O 细节

### 6.3 layout-engine

职责：

1. 文本 shaping
2. 段落布局
3. 表格布局
4. 分页
5. hit-test 数据生成
6. 光标停靠点生成
7. 选区可视区域生成

允许依赖：

1. document-core
2. 字体与 shaping 库

禁止依赖：

1. 渲染器
2. UI 事件系统
3. AI 服务

### 6.4 renderer-skia

职责：

1. 根据布局树绘制页面
2. 管理页面缓存和局部重绘
3. 绘制光标、选区、命中提示

允许依赖：

1. layout-engine
2. Skia

禁止依赖：

1. 直接修改文档
2. 处理输入法

### 6.5 editor-runtime

职责：

1. 鼠标、键盘、滚轮、触控板事件
2. 输入法会话
3. 剪贴板
4. 缩放与视口滚动
5. 将交互映射为命令

允许依赖：

1. document-core
2. layout-engine
3. renderer-skia

禁止依赖：

1. 文件持久化实现
2. DOCX 解析实现

### 6.6 docx-interop

职责：

1. DOCX 导入为 Native AST
2. Native AST 导出 DOCX
3. 字体、段落、列表、表格、图片、页面参数映射

### 6.7 ai-bridge

职责：

1. sidecar 生命周期管理
2. 文档读模型序列化
3. AI 工具协议
4. 命令计划执行与验证

### 6.8 native-storage

职责：

1. 内部文档格式读写
2. 自动保存
3. 崩溃恢复
4. 附件和资源管理

### 6.9 legacy-spec

职责：

1. 保存从当前仓库提炼出的规则文档
2. 保存回归样例
3. 保存旧实现与新实现的对照说明

### 6.10 模块依赖硬规则

必须满足以下依赖方向：

1. app-shell -> editor-runtime -> document-core
2. layout-engine -> document-core
3. renderer-skia -> layout-engine
4. ai-bridge -> document-core
5. docx-interop -> document-core
6. native-storage -> document-core

禁止出现以下反向依赖：

1. document-core 依赖 UI
2. layout-engine 依赖 renderer-skia
3. renderer-skia 依赖命令执行器
4. AI 工具直接依赖渲染器

## 7. Native AST 最终规格边界

### 7.1 设计原则

Native AST 必须满足以下原则：

1. 结构稳定，不能依赖视图节点存在与否。
2. 地址稳定，不能仅通过数组索引进行跨事务定位。
3. 样式显式化，不让渲染层推断业务语义。
4. 既能支持最终渲染，也能支持 AI 操作和导入导出。
5. 块级结构与行内结构严格分离。

### 7.2 顶层结构

第一版 AST 至少包含以下对象：

1. Document
2. Section
3. Block
4. Inline
5. SelectionAnchor
6. StyleSet

### 7.3 Document

建议字段：

1. id
2. version
3. metadata
4. sections
5. documentStyles
6. assetsIndex
7. revisionCounter

其中：

1. id 必须为稳定 UUID。
2. version 用于内部格式版本迁移。
3. revisionCounter 用于事务序号和缓存失效判断。

### 7.4 Section

Section 不是可有可无的包装层，而是版面边界对象。

建议字段：

1. id
2. pageConfig
3. blocks
4. headerModel
5. footerModel
6. pageNumbering

第一版即便不实现复杂页眉页脚，也必须保留 Section 抽象，避免未来页面模型崩塌。

### 7.5 Block 类型

第一版块级节点固定为：

1. Paragraph
2. Table
3. HorizontalRule
4. PageBreak
5. CodeBlock
6. FormulaBlock
7. MermaidBlock
8. ImageBlock

Paragraph 内允许承载 inline image；ImageBlock 用于块级图片。二者必须区分。

### 7.6 Paragraph

建议字段：

1. id
2. runs
3. style
4. semanticRole
5. sourceMap

style 至少包含：

1. align
2. firstLineIndent
3. indentLeft
4. indentRight
5. lineHeight
6. spaceBefore
7. spaceAfter
8. listType
9. listLevel
10. pageBreakBefore
11. keepWithNext
12. keepLinesTogether

其中 keepWithNext 和 keepLinesTogether 即便第一版不全部启用，也必须进入模型，因为它们属于排版规则而不是 UI 规则。

### 7.7 Inline 类型

第一版行内节点固定为：

1. TextRun
2. ImageSpan
3. SoftBreak
4. InlineCode
5. LinkSpan

TextRun 字段至少包含：

1. text
2. fontFamily
3. fontSize
4. color
5. backgroundColor
6. bold
7. italic
8. underline
9. strikethrough
10. superscript
11. subscript
12. letterSpacing

### 7.8 Table 模型

Table 不能只表示二维字符串，必须是完整结构对象。

建议字段：

1. id
2. rows
3. columnWidths
4. widthPolicy
5. borders
6. cellPadding
7. spacingBefore
8. spacingAfter
9. preferredWidth

TableRow 字段：

1. id
2. cells
3. minHeight
4. allowSplitAcrossPages

TableCell 字段：

1. id
2. blocks
3. colspan
4. rowspan
5. width
6. verticalAlign
7. backgroundColor
8. borders
9. padding

### 7.9 富块模型

CodeBlock、FormulaBlock、MermaidBlock 必须同时保存两类数据：

1. 源数据
2. 渲染产物缓存信息

例如：

1. FormulaBlock 保存 latexSource 与 renderedSvgKey
2. MermaidBlock 保存 mermaidSource 与 renderedSvgKey
3. CodeBlock 保存 code、language、themeKey

这意味着渲染缓存永远是可重建的派生数据，而不是文档真值。

### 7.10 样式系统

样式系统必须拆成三个层面：

1. 字符样式
2. 段落样式
3. 文档级样式与预设样式

最终内部存储必须使用规范化数值，不允许把 CSS font-family stack 当作模型主值。

例如：

1. 模型中保存 fontFamilyKey，如 song、hei、kai、fang
2. 渲染时再映射为平台字体 fallback 列表
3. DOCX 导出时再映射为 SimSun、SimHei、KaiTi、FangSong 等目标字体名

### 7.11 节点身份与稳定定位

最终系统中，所有块级节点和表格单元格都必须具有稳定 ID。

禁止使用以下方式作为跨事务主定位：

1. paragraph index
2. block 在数组中的当前位置
3. 渲染后页面中的视觉坐标

最终定位系统至少支持：

1. NodeIdSelector
2. TextRangeSelector
3. StructuralInsertSelector
4. TableCellSelector

### 7.12 选择模型

最终选择模型必须显式建模，而不是隐藏在 UI 框架内部。

需要同时存在：

1. LogicalSelection：作用于 AST 的选择
2. VisualSelection：作用于布局树的可视选择区域
3. CaretAnchor：用于逻辑插入点与视觉插入点映射

## 8. 命令与事务系统最终规格

### 8.1 总原则

命令系统是整个软件的唯一写入口。

任何来自以下来源的修改都必须转为命令：

1. 键盘输入
2. 工具栏点击
3. 右键菜单
4. 快捷键
5. AI tool 调用
6. 批量样式应用

### 8.2 命令分类

第一版命令应分为五类：

1. TextCommands
2. ParagraphCommands
3. StructureCommands
4. TableCommands
5. DocumentCommands

#### TextCommands

1. InsertText
2. ReplaceTextRange
3. DeleteTextRange
4. ApplyTextStyle
5. ClearTextStyle

#### ParagraphCommands

1. InsertParagraphBefore
2. InsertParagraphAfter
3. DeleteParagraph
4. ApplyParagraphStyle
5. ToggleList
6. SplitParagraph
7. MergeParagraphWithNext

#### StructureCommands

1. InsertHorizontalRule
2. InsertPageBreak
3. InsertImageBlock
4. InsertCodeBlock
5. InsertFormulaBlock
6. InsertMermaidBlock

#### TableCommands

1. InsertTable
2. InsertTableRowBefore
3. InsertTableRowAfter
4. DeleteTableRow
5. InsertTableColumnBefore
6. InsertTableColumnAfter
7. DeleteTableColumn
8. SetTableCellContent
9. MergeTableCells
10. SplitTableCell

#### DocumentCommands

1. SetPageConfig
2. ApplyDocumentPreset
3. ReplaceBlockRange
4. BatchCommand

### 8.3 命令入参与定位方式

最终命令不能默认使用 paragraphIndex，而必须使用稳定 selector。

建议 selector 类型：

1. NodeIdSelector: 通过节点 ID 定位块
2. TextRangeSelector: 通过 nodeId + utf8From + utf8To 定位文本范围
3. StructuralInsertSelector: 通过 beforeNodeId 或 afterNodeId 指定插入位置
4. TableCellSelector: 通过 tableId + rowIndex + columnIndex 定位单元格
5. CurrentSelectionSelector: 通过当前逻辑选区定位

### 8.4 事务语义

每次命令执行都必须产生一个事务。

事务至少包含：

1. transactionId
2. inputSelectors
3. changedNodeIds
4. selectionBefore
5. selectionAfter
6. summary
7. layoutInvalidationScope
8. undoPayload
9. redoPayload

### 8.5 命令执行结果

命令执行结果必须结构化返回，至少包含：

1. success
2. message
3. changedNodeIds
4. affectedPagesIfKnown
5. snapshotPreview

snapshotPreview 不要求返回全量文档，但必须能被 AI 用来验证本次命令是否命中了正确对象。

### 8.6 Dry Run 与验证

所有 AI 写命令必须支持 dry run。

dry run 至少验证：

1. selector 是否解析成功
2. 命令参数是否合法
3. 目标节点类型是否匹配
4. 是否会破坏结构约束

### 8.7 Undo/Redo

Undo/Redo 不能是视图层重放，而必须是事务层重放。

约束如下：

1. 任何命令都可撤销
2. AI 命令与人工命令共用同一撤销栈
3. BatchCommand 应被视为单个逻辑事务

## 9. 排版引擎最终规格

### 9.1 输入

排版引擎输入必须是纯数据：

1. Document AST 快照
2. 字体注册表
3. 页面配置
4. 版面规则
5. 缓存上下文

### 9.2 输出

排版引擎输出必须是完整布局树，而不是“段落列表 + 高度估算”。

至少包括：

1. DocumentLayout
2. SectionLayout
3. PageLayout
4. BlockLayout
5. ParagraphLayout
6. LineLayout
7. GlyphRunLayout
8. TableLayout
9. TableCellLayout
10. CaretStop
11. HitRegion
12. SelectionRegion

### 9.3 排版流程

最终排版流程固定为：

1. 解析文档快照
2. 解析样式与字体
3. shaping 与 segment 准备
4. 行布局
5. 块布局
6. 表格布局
7. 分页装配
8. 生成 hit-test 与 caret map

### 9.4 文本排版规则

文本排版必须吸收当前仓库中已经验证的语义，但在原生环境中重新实现。

必须纳入最终规则的内容包括：

1. 中西文混排空隙策略
2. 标点压缩
3. 开始标点与结束标点的行首行尾停靠规则
4. 首行缩进
5. 段前段后
6. 多字号行高抬升
7. 内联图片对行高的影响
8. 长段落跨页

### 9.5 表格排版规则

表格必须由 layout-engine 自己完成布局，不允许依赖系统控件或 HTML 表格模型。

表格布局至少要解决：

1. 列数与列宽计算
2. 单元格内内容测量
3. 行高计算
4. 合并单元格宽高传播
5. 表格块前后间距
6. 表格跨页策略

第一版对表格跨页的要求如下：

1. 表格整体可跨页
2. 行不允许被任意切断
3. 若某行过高无法完整放入当前页，应整体移到下一页

### 9.6 富块排版规则

CodeBlock、FormulaBlock、MermaidBlock 必须作为块级对象参与分页。

规则如下：

1. 富块必须有稳定的占位尺寸
2. 富块渲染失败时仍要保留源数据并显示错误态占位
3. 富块不能把页面布局建立在异步浏览器测量上

### 9.7 分页不变量

分页系统必须保持以下不变量：

1. 同一输入文档、同一字体集合、同一页面配置，布局结果必须确定。
2. 页面重绘不能改变文档逻辑结构。
3. 布局缓存失效范围必须可计算，不能每次全文重排。
4. pageBreakBefore 是文档语义，不是渲染器临时标记。

### 9.8 命中测试与光标停靠点

排版引擎必须输出可供交互层直接使用的命中信息。

至少包括：

1. 每个字符前后的 caret stop
2. 每个块和单元格的命中区域
3. 每行可见选区矩形
4. 表格单元格导航映射

这意味着光标位置来自布局树，而不是来自渲染器像素回推。

## 10. 渲染系统最终规格

### 10.1 渲染职责

渲染器只做两件事：

1. 把布局树画出来
2. 维护高性能重绘机制

它不能承担：

1. 样式推断
2. 文档修改
3. 逻辑选区运算

### 10.2 图层模型

建议渲染图层固定为：

1. 页面背景层
2. 版心辅助层
3. 内容层
4. 选区层
5. 光标层
6. 调试层

### 10.3 坐标系统

必须同时维护三套坐标：

1. 文档坐标
2. 页面坐标
3. 视口坐标

任何 hit-test 与滚动逻辑都必须清晰转换这三套坐标，禁止在不同坐标系中混用临时偏移值。

### 10.4 缓存策略

渲染缓存至少分三层：

1. 字形与文本 blob 缓存
2. 页面位图或命令缓存
3. 富块渲染缓存

### 10.5 性能不变量

渲染器必须满足：

1. 光标闪烁不触发全文重绘
2. 局部文字编辑只触发必要页面重排与重绘
3. 视口外页面可延迟或降级绘制

## 11. 交互运行时最终规格

### 11.1 总原则

交互层的职责不是“模拟浏览器”，而是“定义桌面文档软件自己的编辑行为”。

### 11.2 鼠标与指针行为

必须明确定义：

1. 单击设置插入点
2. 双击选词
3. 三击选段
4. 拖拽扩展选区
5. 表格边界命中
6. 富块整体命中

### 11.3 键盘行为

必须原生实现：

1. 左右上下移动
2. Home/End
3. PageUp/PageDown
4. Shift 扩展选区
5. Backspace/Delete
6. Enter 拆段
7. Tab/Shift+Tab 在表格和列表中的行为

### 11.4 输入法

输入法是一级能力，不能后置为“后面再兼容”。

必须定义：

1. composition start
2. composition update
3. composition commit
4. composition cancel
5. 候选框锚点定位

候选框锚点必须由当前 caret 的视觉位置提供，而不是依赖浏览器输入框。

### 11.5 剪贴板

剪贴板至少支持：

1. 纯文本复制粘贴
2. 段落结构复制粘贴
3. 表格单元格区域复制粘贴
4. 图片粘贴

### 11.6 表格交互

表格交互必须从第一版开始作为原生能力设计，而不是“先文本、后表格”。

具体要求：

1. 光标可进入任意非合并单元格
2. 单元格内部文本编辑与普通段落编辑共享同一文本编辑内核
3. 表格选择、单元格选择、文本选择必须是三种显式模式
4. 行列增删是命令，不是视图层特例

### 11.7 列表交互

列表不是渲染时加一个圆点，而是段落语义。

具体要求：

1. 列表项仍然是 Paragraph，只是具有 listType 和 listLevel 等样式语义
2. Enter 在列表项中拆分当前项
3. 空列表项上 Backspace 可退出列表
4. Tab/Shift+Tab 改变 listLevel，而不是插入制表字符

## 12. 内部文件格式与持久化

### 12.1 内部文件格式

最终产品必须有自己的原生文件格式，不能把 DOCX 当作内部真值格式。

建议使用包格式，例如：

1. .owps

其内部可为 zip bundle 或目录包，至少包含：

1. document.json
2. assets/
3. previews/
4. history/
5. metadata.json

### 12.2 持久化原则

1. 文档真值是 Native AST 序列化结果
2. 渲染缓存可丢弃
3. 自动保存必须为原子写入
4. 崩溃恢复必须基于最近快照和事务日志

### 12.3 事务日志

建议保存轻量事务日志，用于：

1. 崩溃恢复
2. 调试
3. AI 操作审计

## 13. DOCX 互操作最终规格

### 13.1 总原则

DOCX 互操作的目标不是复制 Word 内部行为，而是在可控子集内提供稳定交换能力。

### 13.2 必须对齐的语义

必须优先对齐以下语义：

1. 页面大小与边距
2. 段落对齐、缩进、行距、段前段后
3. 字体、字号、粗斜体、下划线、删除线、字间距
4. 列表层级
5. 表格结构与基础边框
6. 图片尺寸
7. 分页符

### 13.3 可暂缓的语义

以下语义不作为第一版强制目标：

1. Word 样式体系完整继承
2. 域代码
3. 批注与修订
4. 高级目录与引用系统

### 13.4 导入流程

最终导入流程必须固定为：

1. 解析 DOCX 包
2. 抽取页面配置
3. 抽取段落和 runs
4. 抽取编号与列表层级
5. 抽取表格结构
6. 抽取图片与资源
7. 转为 Native AST
8. 生成导入报告

### 13.5 导出流程

最终导出流程必须固定为：

1. 读取 Native AST
2. 映射页面参数
3. 映射段落与字符样式
4. 映射表格与图片
5. 生成 DOCX
6. 运行导出后校验

## 14. AI 架构最终规格

### 14.1 AI 在最终系统中的角色

AI 不是文档内核的一部分，而是建立在文档内核之上的自动化操作者。

AI 的能力边界是：

1. 读取文档抽象信息
2. 生成命令计划
3. 调用命令执行器
4. 读取执行结果
5. 做二次校验

AI 不能：

1. 直接访问渲染器内部对象
2. 直接驱动鼠标键盘模拟编辑
3. 绕开命令系统修改文档

### 14.2 最终通讯模型

主程序与 AI sidecar 的最终协议至少包括两类接口：

1. 读接口
2. 写接口

#### 读接口

1. get_document_info
2. get_document_outline
3. get_page_content
4. get_node_snapshot
5. get_selection_context
6. get_style_summary

#### 写接口

1. dry_run_command
2. apply_command
3. apply_command_batch
4. undo_last_transaction

### 14.3 AI 写操作定位原则

最终 AI 协议不得默认依赖 paragraph index。

AI 必须逐步过渡到：

1. 先读取 outline
2. 再读取 node snapshot
3. 使用 nodeId 或 selector 执行写操作

### 14.4 AI 校验闭环

每次 AI 写操作必须遵循：

1. 读前状态
2. dry run
3. 执行事务
4. 读后快照
5. 比对变更范围
6. 输出结构化总结

## 15. 测试与质量体系

### 15.1 测试金字塔

最终系统至少包含以下测试层：

1. AST 与命令单元测试
2. 布局 golden 测试
3. hit-test 与 caret 测试
4. DOCX roundtrip 测试
5. AI 工具协议测试
6. 平台输入法手工回归测试

### 15.2 Golden 测试

布局引擎必须有固定样例文档，并保存以下 golden 结果：

1. 页面总数
2. 各页 block 范围
3. 行数与关键 line break
4. 关键对象坐标
5. caret stops 数量与位置

### 15.3 回归样例集

必须建立固定样例，至少覆盖：

1. 普通正文
2. 中英混排
3. 多级列表
4. 多列表切换
5. 多行表格
6. 合并单元格
7. 图片与文本混排
8. 分页符
9. 长段落跨页
10. 公式与 Mermaid 块

### 15.4 平台验证项

macOS 与 Windows 必须分别验证：

1. 中文输入法
2. 英文输入
3. Retina 或高 DPI 缩放
4. 字体 fallback
5. 复制粘贴
6. 文件打开保存

## 16. 能力关卡

后续实施不再以“周”为单位规划，而以“能力关卡”作为推进单位。只有前一关卡通过，后一关卡才允许开始承担关键路径责任。

### 关卡 G0：规格冻结

出口条件：

1. Native AST 定义冻结
2. 命令协议冻结
3. 模块依赖规则冻结
4. 样例文档集建立

### 关卡 G1：文档核心成立

出口条件：

1. document-core 能独立读写内部格式
2. 命令可修改 AST
3. Undo/Redo 可工作
4. 稳定 selector 可工作

### 关卡 G2：只读排版成立

出口条件：

1. layout-engine 可稳定输出分页结果
2. renderer-skia 可稳定绘制多页页面
3. 页面缩放、滚动、缓存稳定

### 关卡 G3：基础编辑成立

出口条件：

1. 文本插入、删除、拆段、合段稳定
2. 光标、选区、输入法稳定
3. 字符样式和段落样式稳定

### 关卡 G4：结构化编辑成立

出口条件：

1. 列表稳定
2. 表格稳定
3. 图片块稳定
4. 分页符、分割线、富块稳定

### 关卡 G5：文件交换成立

出口条件：

1. DOCX 基础导入稳定
2. DOCX 基础导出稳定
3. 回归样例可 roundtrip 到可接受结果

### 关卡 G6：AI 闭环成立

出口条件：

1. AI 读模型稳定
2. AI 写命令经 dry run 后可执行
3. AI 执行后可结构化校验
4. AI 操作可撤销

### 关卡 G7：发布口径成立

出口条件：

1. 文档区零浏览器依赖
2. 基础排版稳定
3. 结构化内容稳定
4. 内部格式与 DOCX 交换稳定
5. AI 能完成基础排版任务

## 17. 当前仓库到新系统的迁移映射

### 17.1 应保留的规则来源

以下文件不是未来实现，但必须作为规格与测试来源：

1. [src/layout/paginator.ts](src/layout/paginator.ts)
2. [src/editor/schema.ts](src/editor/schema.ts)
3. [src/ai/tools.ts](src/ai/tools.ts)
4. [src/ai/executor.ts](src/ai/executor.ts)
5. [src/ai/presets.ts](src/ai/presets.ts)
6. [src/fonts.ts](src/fonts.ts)
7. [src/docx/importer.ts](src/docx/importer.ts)
8. [src/docx/exporter.ts](src/docx/exporter.ts)
9. [server/app/tooling.py](server/app/tooling.py)

### 17.2 需要提炼的现有语义

必须从当前仓库提炼以下语义资产：

1. 字体名与字体族映射
2. 文本样式字段全集
3. 段落样式字段全集
4. 表格节点结构与属性
5. 分页和标点压缩规则
6. AI 工具清单与参数语义
7. 预设模板语义

### 17.3 应淘汰的实现形态

以下内容应被明确视为迁移对象，而非继续优化对象：

1. [src/components/Editor.tsx](src/components/Editor.tsx) 中的 DOM 驱动编辑
2. ProseMirror schema 作为最终真值模型
3. 基于浏览器节点视图的结构块编辑
4. 浏览器表格插件与浏览器选区补丁

### 17.4 新系统中的映射

建议映射如下：

1. paginator 的文本和分页规则迁移到 layout-engine
2. schema 的节点语义迁移到 document-core AST
3. executor 的写操作语义迁移到 command executor
4. ai/tools 与 tooling.py 的接口语义迁移到 ai-bridge 协议
5. importer 与 exporter 的互操作规则迁移到 docx-interop
6. fonts 与 presets 的语义迁移到 style registry

## 18. 立即执行顺序

后续实施的执行顺序必须遵守以下规则：

1. 先完成 specs，而不是先写 UI。
2. 先完成 document-core 和 layout-engine，而不是先做菜单和设置。
3. 先完成稳定 selector 和事务系统，而不是先做 AI 自动写作。
4. 先完成内部格式与 AST，再做 DOCX roundtrip。
5. 先完成表格原生交互模型，再做复杂富块编辑。

### 18.1 新仓库组织方式

建议直接建立独立仓库 openwps-native，并按以下结构组织：

```text
openwps-native/
├── crates/
│   ├── app-shell/
│   ├── document-core/
│   ├── layout-engine/
│   ├── renderer-skia/
│   ├── editor-runtime/
│   ├── native-storage/
│   ├── docx-interop/
│   └── ai-bridge/
├── specs/
│   ├── 01-document-model.md
│   ├── 02-command-protocol.md
│   ├── 03-layout-rules.md
│   ├── 04-rendering-contract.md
│   ├── 05-interaction-model.md
│   ├── 06-docx-mapping.md
│   ├── 07-ai-tool-protocol.md
│   └── 08-fixture-definition.md
├── fixtures/
│   ├── source-docx/
│   ├── source-native/
│   ├── golden-layout/
│   └── regression/
└── tools/
```

该结构的目的不是美观，而是把“实现代码”和“规格真值”明确分离。后续所有 AI 编程行为都应以 specs 为第一输入源，而不是直接对着实现代码猜测行为。

### 18.2 规格文件的先后顺序

由于后续会大量使用 AI 编程，因此必须先把规格拆成可独立引用的文件，而不是把所有要求都堆在一个总文档中。

规格文件编写顺序必须固定为：

1. 01-document-model.md
2. 02-command-protocol.md
3. 03-layout-rules.md
4. 05-interaction-model.md
5. 06-docx-mapping.md
6. 07-ai-tool-protocol.md
7. 04-rendering-contract.md
8. 08-fixture-definition.md

之所以不是先写 rendering-contract，是因为渲染层必须服从文档模型、命令系统和布局规则，而不能反过来定义它们。

### 18.3 AI 编程时的规格优先级

后续使用 AI 编程时，必须遵守以下优先级：

1. 先读取对应 specs 文件。
2. 再读取目标 crate 中的接口定义。
3. 最后才读取具体实现文件。

禁止的 AI 编程方式：

1. 直接根据现有实现猜测最终行为。
2. 先写代码，再倒推规格。
3. 在缺少 selector、事务、布局规则定义时先写交互层。

### 18.4 第一批必须产出的规格文件内容

第一批规格文件必须至少覆盖以下内容：

#### 01-document-model.md

1. 所有节点类型
2. 所有字段定义
3. 所有枚举值
4. 字段取值单位
5. 必填与可选边界
6. 稳定 ID 规则

#### 02-command-protocol.md

1. 所有命令名
2. 每个命令的 selector 规则
3. 每个命令的前置校验
4. 每个命令的事务输出
5. Undo/Redo 语义

#### 03-layout-rules.md

1. 文本 shaping 约束
2. 行布局规则
3. 标点压缩规则
4. 列表布局规则
5. 表格布局规则
6. 分页不变量
7. caret stop 生成规则

#### 05-interaction-model.md

1. 鼠标命中规则
2. 键盘移动规则
3. 选区扩展规则
4. 表格导航规则
5. 输入法会话规则
6. 剪贴板规则

#### 06-docx-mapping.md

1. 页面参数映射
2. 字体映射
3. 段落样式映射
4. 列表映射
5. 表格映射
6. 图片映射

#### 07-ai-tool-protocol.md

1. 读接口
2. 写接口
3. dry run 契约
4. 校验返回格式
5. AI 可依赖的 snapshot 粒度

### 18.5 不允许跳过的实现顺序

即便后续使用 AI 批量生成代码，也不允许跳过以下顺序：

1. document-core 的 AST 与 selector 未定型前，不得编写 table 命令执行器。
2. layout-engine 的 caret map 未定型前，不得编写输入法锚点逻辑。
3. interaction-model 未定型前，不得编写复杂快捷键映射。
4. docx-mapping 未定型前，不得宣称支持 DOCX roundtrip。
5. ai-tool-protocol 未定型前，不得让 AI 直接写入文档。

### 18.6 当前总文档的角色

本文件的角色是“总规格入口”，不是最终唯一真值文档。

后续应把本文件视为：

1. 总体架构和边界说明
2. 决策冻结记录
3. 各子规格的目录索引

真正驱动实现的，应当是拆分后的 specs 文件，而不是继续无限增厚本文件。

## 19. 发布前最终验收口径

只有同时满足以下条件，才允许对外称为“原生版本”：

1. 文档区无浏览器依赖。
2. 文本编辑、列表、表格、分页行为全部由原生内核决定。
3. 内部文档格式已成为真值来源。
4. DOCX 交换能力可用于真实办公文档。
5. AI 可以基于统一命令系统稳定读取和修改文档。

若出现以下任一情况，则不得视为原生版本完成：

1. 仍然需要浏览器 selection 才能稳定编辑。
2. 仍然依赖 HTML 表格来实现表格编辑。
3. 页面布局仍需借助浏览器测量或浏览器重排。
4. AI 仍通过前端编辑补丁间接写文档。