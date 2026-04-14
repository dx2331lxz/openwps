# 02 - 命令协议规格 (Command Protocol Specification)

命令系统是文档的唯一写入口。所有修改（键盘、工具栏、AI tool 调用）必须转为命令。

## 1. 总原则

1. 每个命令执行产生一个事务 (Transaction)。
2. 所有命令使用 Selector 定位，禁止默认依赖 paragraph index。
3. 所有 AI 写命令必须支持 dry run。
4. 命令执行结果必须结构化返回。

## 2. 命令分类

### 2.1 TextCommands

| 命令             | Selector                     | 说明               |
| ---------------- | ---------------------------- | ------------------ |
| InsertText       | TextRange / CurrentSelection | 在指定位置插入文本 |
| ReplaceTextRange | TextRange                    | 替换指定范围文本   |
| DeleteTextRange  | TextRange                    | 删除指定范围文本   |
| ApplyTextStyle   | TextRange                    | 对范围应用文字样式 |
| ClearTextStyle   | TextRange                    | 清除范围内文字样式 |

### 2.2 ParagraphCommands

| 命令                   | Selector                  | 说明               |
| ---------------------- | ------------------------- | ------------------ |
| InsertParagraphBefore  | NodeId / StructuralInsert | 在指定块前插入段落 |
| InsertParagraphAfter   | NodeId / StructuralInsert | 在指定块后插入段落 |
| DeleteParagraph        | NodeId                    | 删除段落           |
| ApplyParagraphStyle    | NodeId                    | 应用段落样式       |
| ToggleList             | NodeId                    | 切换列表类型       |
| SplitParagraph         | TextRange                 | 在光标处拆分段落   |
| MergeParagraphWithNext | NodeId                    | 合并当前段与下一段 |

### 2.3 StructureCommands

| 命令                 | Selector         | 说明            |
| -------------------- | ---------------- | --------------- |
| InsertHorizontalRule | StructuralInsert | 插入分割线      |
| InsertPageBreak      | StructuralInsert | 插入分页符      |
| InsertImageBlock     | StructuralInsert | 插入块级图片    |
| InsertCodeBlock      | StructuralInsert | 插入代码块      |
| InsertFormulaBlock   | StructuralInsert | 插入公式块      |
| InsertMermaidBlock   | StructuralInsert | 插入 Mermaid 块 |

### 2.4 TableCommands

| 命令                    | Selector         | 说明           |
| ----------------------- | ---------------- | -------------- |
| InsertTable             | StructuralInsert | 插入表格       |
| InsertTableRowBefore    | TableCell        | 在行前插入行   |
| InsertTableRowAfter     | TableCell        | 在行后插入行   |
| DeleteTableRow          | TableCell        | 删除行         |
| InsertTableColumnBefore | TableCell        | 在列前插入列   |
| InsertTableColumnAfter  | TableCell        | 在列后插入列   |
| DeleteTableColumn       | TableCell        | 删除列         |
| SetTableCellContent     | TableCell        | 设置单元格内容 |
| MergeTableCells         | TableCell 范围   | 合并单元格     |
| SplitTableCell          | TableCell        | 拆分单元格     |

### 2.5 DocumentCommands

| 命令                | Selector    | 说明                     |
| ------------------- | ----------- | ------------------------ |
| SetPageConfig       | -           | 设置页面参数             |
| ApplyDocumentPreset | -           | 应用文档预设             |
| ReplaceBlockRange   | NodeId 范围 | 替换块范围               |
| BatchCommand        | -           | 批量命令（视为单一事务） |

## 3. 事务 (Transaction)

每次命令执行产生一个事务：

| 字段             | 类型                       | 说明                    |
| ---------------- | -------------------------- | ----------------------- |
| transaction_id   | Uuid                       | 事务 ID                 |
| revision         | u64                        | 对应的 revision_counter |
| command_name     | String                     | 命令名                  |
| input_selectors  | Vec\<Selector\>            | 输入定位                |
| changed_node_ids | Vec\<Uuid\>                | 变更的节点 ID           |
| selection_before | Option\<LogicalSelection\> | 执行前选区              |
| selection_after  | Option\<LogicalSelection\> | 执行后选区              |
| undo_payload     | UndoPayload                | 撤销数据                |
| redo_payload     | RedoPayload                | 重做数据                |

## 4. 命令执行结果 (CommandResult)

| 字段             | 类型             | 说明           |
| ---------------- | ---------------- | -------------- |
| success          | bool             | 是否成功       |
| message          | Option\<String\> | 错误或提示信息 |
| changed_node_ids | Vec\<Uuid\>      | 变更节点       |
| transaction_id   | Option\<Uuid\>   | 事务 ID        |

## 5. Dry Run

所有写命令支持 dry run 模式，至少验证：

1. selector 是否解析成功
2. 命令参数是否合法
3. 目标节点类型是否匹配
4. 是否会破坏结构约束

dry run 返回 CommandResult 但不修改文档。

## 6. Undo/Redo

1. 事务层重放，非视图层重放。
2. 任何命令均可撤销。
3. AI 命令与人工命令共用同一撤销栈。
4. BatchCommand 视为单个逻辑事务。
5. Undo 恢复 selection_before；Redo 恢复 selection_after。
