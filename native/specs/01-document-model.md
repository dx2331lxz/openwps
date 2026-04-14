# 01 - 文档模型规格 (Document Model Specification)

本文件为 openwps-native 文档内核的 AST 数据模型定义。所有节点类型、字段、枚举值、取值单位、必填/可选均在此冻结。

## 1. 设计原则

1. **结构稳定** — 不依赖视图节点是否存在。
2. **地址稳定** — 不仅通过数组索引进行跨事务定位；所有块级节点和表格单元格具有稳定 UUID。
3. **样式显式化** — 渲染层不推断业务语义。
4. **块行分离** — 块级结构与行内结构严格分离。
5. **可序列化** — 所有结构均可 serde 序列化/反序列化为 JSON。

## 2. 顶层结构

```
Document
  ├── id: Uuid                     (必填, 稳定)
  ├── version: u32                 (必填, 内部格式版本, 初始值 1)
  ├── metadata: DocumentMetadata   (必填)
  ├── sections: Vec<Section>       (必填, 至少一个)
  ├── document_styles: DocumentStyles (必填)
  ├── assets_index: Vec<Asset>     (可选)
  └── revision_counter: u64        (必填, 事务序号, 初始值 0)
```

### 2.1 DocumentMetadata

| 字段        | 类型   | 必填 | 说明            |
| ----------- | ------ | ---- | --------------- |
| title       | String | 否   | 文档标题        |
| author      | String | 否   | 作者            |
| created_at  | String | 否   | ISO 8601 时间戳 |
| modified_at | String | 否   | ISO 8601 时间戳 |

### 2.2 DocumentStyles

| 字段                | 类型          | 必填 | 说明                           |
| ------------------- | ------------- | ---- | ------------------------------ |
| default_font_family | FontFamilyKey | 是   | 默认字体键                     |
| default_font_size   | f64           | 是   | 默认字号，单位 pt，初始值 12.0 |
| default_line_height | f64           | 是   | 默认行高倍数，初始值 1.5       |
| default_color       | String        | 是   | 默认文字颜色, hex "#000000"    |

## 3. Section

Section 是版面边界对象，不可省略。

| 字段        | 类型         | 必填 | 说明         |
| ----------- | ------------ | ---- | ------------ |
| id          | Uuid         | 是   | 稳定 ID      |
| page_config | PageConfig   | 是   | 页面参数     |
| blocks      | Vec\<Block\> | 是   | 块级节点列表 |

### 3.1 PageConfig

| 字段          | 类型 | 必填 | 单位 | 默认值 | 说明   |
| ------------- | ---- | ---- | ---- | ------ | ------ |
| width         | f64  | 是   | pt   | 595.28 | A4 宽  |
| height        | f64  | 是   | pt   | 841.89 | A4 高  |
| margin_top    | f64  | 是   | pt   | 72.0   | 上边距 |
| margin_bottom | f64  | 是   | pt   | 72.0   | 下边距 |
| margin_left   | f64  | 是   | pt   | 90.0   | 左边距 |
| margin_right  | f64  | 是   | pt   | 90.0   | 右边距 |

## 4. Block 类型

块级节点为枚举类型，固定为以下成员：

```rust
enum Block {
    Paragraph(Paragraph),
    Table(Table),
    HorizontalRule(HorizontalRule),
    PageBreak(PageBreak),
    CodeBlock(CodeBlock),
    FormulaBlock(FormulaBlock),
    MermaidBlock(MermaidBlock),
    ImageBlock(ImageBlock),
}
```

所有 Block 变体内的结构体至少包含 `id: Uuid` 字段。

### 4.1 Paragraph

| 字段  | 类型           | 必填 | 说明     |
| ----- | -------------- | ---- | -------- |
| id    | Uuid           | 是   | 稳定 ID  |
| runs  | Vec\<Inline\>  | 是   | 行内内容 |
| style | ParagraphStyle | 是   | 段落样式 |

#### ParagraphStyle

| 字段                | 类型               | 必填 | 单位 | 默认值 | 说明       |
| ------------------- | ------------------ | ---- | ---- | ------ | ---------- |
| align               | TextAlign          | 是   | -    | Left   | 对齐方式   |
| first_line_indent   | f64                | 是   | em   | 0.0    | 首行缩进   |
| indent_left         | f64                | 是   | pt   | 0.0    | 左缩进     |
| indent_right        | f64                | 是   | pt   | 0.0    | 右缩进     |
| line_height         | f64                | 是   | 倍数 | 1.5    | 行高       |
| space_before        | f64                | 是   | pt   | 0.0    | 段前       |
| space_after         | f64                | 是   | pt   | 0.0    | 段后       |
| list_type           | Option\<ListType\> | 是   | -    | None   | 列表类型   |
| list_level          | u8                 | 是   | -    | 0      | 列表层级   |
| page_break_before   | bool               | 是   | -    | false  | 段前分页   |
| keep_with_next      | bool               | 是   | -    | false  | 与下段同页 |
| keep_lines_together | bool               | 是   | -    | false  | 段中不分页 |

#### TextAlign 枚举

```
Left | Center | Right | Justify
```

#### ListType 枚举

```
Bullet | Ordered
```

### 4.2 Table

| 字段           | 类型             | 必填 | 说明                           |
| -------------- | ---------------- | ---- | ------------------------------ |
| id             | Uuid             | 是   | 稳定 ID                        |
| rows           | Vec\<TableRow\>  | 是   | 行列表                         |
| column_widths  | Vec\<f64\>       | 是   | 各列宽度, pt                   |
| width_policy   | TableWidthPolicy | 是   | 宽度策略                       |
| borders        | TableBorders     | 是   | 表格边框                       |
| cell_padding   | f64              | 是   | 默认单元格内边距, pt, 默认 4.0 |
| spacing_before | f64              | 是   | 表格前间距, pt                 |
| spacing_after  | f64              | 是   | 表格后间距, pt                 |

#### TableWidthPolicy 枚举

```
Auto | Fixed | Percent
```

#### TableRow

| 字段       | 类型             | 必填 | 说明                   |
| ---------- | ---------------- | ---- | ---------------------- |
| id         | Uuid             | 是   | 稳定 ID                |
| cells      | Vec\<TableCell\> | 是   | 单元格列表             |
| min_height | f64              | 是   | 最小行高, pt, 默认 0.0 |

#### TableCell

| 字段             | 类型                  | 必填 | 说明                     |
| ---------------- | --------------------- | ---- | ------------------------ |
| id               | Uuid                  | 是   | 稳定 ID                  |
| blocks           | Vec\<Block\>          | 是   | 内容块(通常为 Paragraph) |
| colspan          | u32                   | 是   | 列合并, 默认 1           |
| rowspan          | u32                   | 是   | 行合并, 默认 1           |
| vertical_align   | VerticalAlign         | 是   | 垂直对齐                 |
| background_color | Option\<String\>      | 是   | 背景色                   |
| borders          | Option\<CellBorders\> | 是   | 单元格边框覆盖           |
| padding          | Option\<f64\>         | 是   | 内边距覆盖               |

#### VerticalAlign 枚举

```
Top | Middle | Bottom
```

### 4.3 HorizontalRule

| 字段 | 类型 | 必填 |
| ---- | ---- | ---- |
| id   | Uuid | 是   |

### 4.4 PageBreak

| 字段 | 类型 | 必填 |
| ---- | ---- | ---- |
| id   | Uuid | 是   |

### 4.5 CodeBlock

| 字段     | 类型   | 必填 | 说明     |
| -------- | ------ | ---- | -------- |
| id       | Uuid   | 是   |          |
| code     | String | 是   | 源代码   |
| language | String | 是   | 语言标识 |

### 4.6 FormulaBlock

| 字段               | 类型             | 必填 | 说明       |
| ------------------ | ---------------- | ---- | ---------- |
| id                 | Uuid             | 是   |            |
| latex_source       | String           | 是   | LaTeX 源码 |
| rendered_cache_key | Option\<String\> | 否   | 渲染缓存键 |

### 4.7 MermaidBlock

| 字段               | 类型             | 必填 | 说明         |
| ------------------ | ---------------- | ---- | ------------ |
| id                 | Uuid             | 是   |              |
| mermaid_source     | String           | 是   | Mermaid 源码 |
| rendered_cache_key | Option\<String\> | 否   | 渲染缓存键   |

### 4.8 ImageBlock

| 字段     | 类型          | 必填 | 说明         |
| -------- | ------------- | ---- | ------------ |
| id       | Uuid          | 是   |              |
| asset_id | String        | 是   | 资源索引键   |
| alt      | String        | 是   | 替代文本     |
| width    | Option\<f64\> | 否   | 显示宽度, pt |
| height   | Option\<f64\> | 否   | 显示高度, pt |

## 5. Inline 类型

行内节点为枚举类型：

```rust
enum Inline {
    TextRun(TextRun),
    ImageSpan(ImageSpan),
    SoftBreak,
    InlineCode(InlineCode),
    LinkSpan(LinkSpan),
}
```

### 5.1 TextRun

| 字段  | 类型      | 必填 | 说明           |
| ----- | --------- | ---- | -------------- |
| text  | String    | 是   | 文本内容(非空) |
| style | TextStyle | 是   | 文字样式       |

#### TextStyle

| 字段             | 类型             | 必填 | 默认值    | 说明          |
| ---------------- | ---------------- | ---- | --------- | ------------- |
| font_family      | FontFamilyKey    | 是   | Song      | 字体键        |
| font_size        | f64              | 是   | 12.0      | 字号, pt      |
| color            | String           | 是   | "#000000" | 文字颜色, hex |
| background_color | Option\<String\> | 否   | None      | 背景色        |
| bold             | bool             | 是   | false     | 粗体          |
| italic           | bool             | 是   | false     | 斜体          |
| underline        | bool             | 是   | false     | 下划线        |
| strikethrough    | bool             | 是   | false     | 删除线        |
| superscript      | bool             | 是   | false     | 上标          |
| subscript        | bool             | 是   | false     | 下标          |
| letter_spacing   | f64              | 是   | 0.0       | 字间距, pt    |

### 5.2 FontFamilyKey 枚举

模型存储字体键，不存储 CSS font-family stack。

```
Song | Hei | Kai | Fang | Arial | TimesNewRoman | CourierNew | Custom(String)
```

DOCX 导出时映射:
- Song → SimSun
- Hei → SimHei
- Kai → KaiTi
- Fang → FangSong

渲染时映射到平台 fallback 列表。

### 5.3 ImageSpan

| 字段     | 类型          | 必填 | 说明       |
| -------- | ------------- | ---- | ---------- |
| asset_id | String        | 是   | 资源索引键 |
| alt      | String        | 是   | 替代文本   |
| width    | Option\<f64\> | 否   | 宽度, pt   |
| height   | Option\<f64\> | 否   | 高度, pt   |

### 5.4 InlineCode

| 字段 | 类型   | 必填 |
| ---- | ------ | ---- |
| code | String | 是   |

### 5.5 LinkSpan

| 字段     | 类型          | 必填 | 说明                 |
| -------- | ------------- | ---- | -------------------- |
| children | Vec\<Inline\> | 是   | 链接内容(TextRun 等) |
| href     | String        | 是   | URL                  |

## 6. 边框模型

### TableBorders / CellBorders

| 字段   | 类型                 | 说明   |
| ------ | -------------------- | ------ |
| top    | Option\<BorderSide\> | 上边框 |
| bottom | Option\<BorderSide\> | 下边框 |
| left   | Option\<BorderSide\> | 左边框 |
| right  | Option\<BorderSide\> | 右边框 |

### BorderSide

| 字段  | 类型        | 说明      |
| ----- | ----------- | --------- |
| width | f64         | 线宽, pt  |
| color | String      | 颜色, hex |
| style | BorderStyle | 样式      |

### BorderStyle 枚举

```
None | Solid | Dashed | Dotted
```

## 7. Asset

| 字段      | 类型             | 说明          |
| --------- | ---------------- | ------------- |
| id        | String           | 资源键        |
| mime_type | String           | MIME 类型     |
| data_uri  | Option\<String\> | 内联 data URI |
| file_path | Option\<String\> | 外部文件路径  |

## 8. 选择模型

### 8.1 LogicalSelection

作用于 AST 的选择。

```rust
enum LogicalSelection {
    Collapsed(CaretPosition),
    Range { anchor: CaretPosition, focus: CaretPosition },
    BlockSelection(Vec<Uuid>),
    TableCellSelection { table_id: Uuid, cells: Vec<(usize, usize)> },
}
```

### 8.2 CaretPosition

| 字段      | 类型  | 说明           |
| --------- | ----- | -------------- |
| block_id  | Uuid  | 所在块 ID      |
| run_index | usize | 行内元素索引   |
| offset    | usize | UTF-8 字节偏移 |

## 9. Selector 类型

跨事务稳定定位，用于命令入参。

```rust
enum Selector {
    NodeId(Uuid),
    TextRange { node_id: Uuid, start: usize, end: usize },
    StructuralInsert(StructuralInsertSelector),
    TableCell { table_id: Uuid, row: usize, col: usize },
    CurrentSelection,
}

struct StructuralInsertSelector {
    before_node_id: Option<Uuid>,
    after_node_id: Option<Uuid>,
    parent_id: Uuid,
}
```

## 10. 稳定 ID 规则

1. 所有块级节点创建时分配 UUID v4。
2. 所有 TableRow、TableCell 创建时分配 UUID v4。
3. Section 创建时分配 UUID v4。
4. ID 在节点生命周期内不变。
5. 复制节点时必须生成新 ID。
6. 导入外部文档时必须生成新 ID。
