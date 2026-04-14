use uuid::Uuid;

use crate::ast::*;
use crate::error::DocumentError;
use crate::selector::Selector;
use crate::style::*;
use crate::transaction::*;

// ── Command Definitions ─────────────────────────────────────────────────

/// All commands that can modify the document.
#[derive(Debug, Clone)]
pub enum Command {
    // Text commands
    InsertText {
        selector: Selector,
        text: String,
        style: Option<TextStyle>,
    },
    ReplaceTextRange {
        selector: Selector,
        new_text: String,
        style: Option<TextStyle>,
    },
    DeleteTextRange {
        selector: Selector,
    },
    ApplyTextStyle {
        selector: Selector,
        style: TextStyle,
    },
    ClearTextStyle {
        selector: Selector,
    },

    // Paragraph commands
    InsertParagraphBefore {
        selector: Selector,
        content: Option<Paragraph>,
    },
    InsertParagraphAfter {
        selector: Selector,
        content: Option<Paragraph>,
    },
    DeleteParagraph {
        selector: Selector,
    },
    ApplyParagraphStyle {
        selector: Selector,
        style: ParagraphStyle,
    },
    ToggleList {
        selector: Selector,
        list_type: ListType,
    },
    SplitParagraph {
        selector: Selector,
    },
    MergeParagraphWithNext {
        selector: Selector,
    },

    // Structure commands
    InsertHorizontalRule {
        selector: Selector,
    },
    InsertPageBreak {
        selector: Selector,
    },
    InsertImageBlock {
        selector: Selector,
        asset_id: String,
        alt: String,
        width: Option<f64>,
        height: Option<f64>,
    },
    InsertCodeBlock {
        selector: Selector,
        code: String,
        language: String,
    },
    InsertFormulaBlock {
        selector: Selector,
        latex: String,
    },
    InsertMermaidBlock {
        selector: Selector,
        source: String,
    },

    // Table commands
    InsertTable {
        selector: Selector,
        rows: usize,
        cols: usize,
    },
    InsertTableRowBefore {
        selector: Selector,
    },
    InsertTableRowAfter {
        selector: Selector,
    },
    DeleteTableRow {
        selector: Selector,
    },
    InsertTableColumnBefore {
        selector: Selector,
    },
    InsertTableColumnAfter {
        selector: Selector,
    },
    DeleteTableColumn {
        selector: Selector,
    },
    SetTableCellContent {
        selector: Selector,
        blocks: Vec<Block>,
    },

    // Document commands
    SetPageConfig {
        section_index: usize,
        config: PageConfig,
    },
    BatchCommand {
        commands: Vec<Command>,
    },
}

// ── Command Executor ────────────────────────────────────────────────────

/// The document editor: owns the document, selection, and undo/redo stacks.
pub struct DocumentEditor {
    pub document: Document,
    pub selection: Option<LogicalSelection>,
    undo_stack: Vec<Transaction>,
    redo_stack: Vec<Transaction>,
}

impl DocumentEditor {
    pub fn new(document: Document) -> Self {
        Self {
            document,
            selection: None,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
        }
    }

    pub fn from_default() -> Self {
        Self::new(Document::new())
    }

    /// Execute a command with dry_run=false.
    pub fn execute(&mut self, cmd: Command) -> CommandResult {
        self.execute_impl(cmd, false)
    }

    /// Dry-run a command: validate without applying.
    pub fn dry_run(&self, cmd: &Command) -> CommandResult {
        // Clone the editor state for validation
        let mut clone = DocumentEditor {
            document: self.document.clone(),
            selection: self.selection.clone(),
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
        };
        clone.execute_impl(cmd.clone(), true)
    }

    fn execute_impl(&mut self, cmd: Command, dry_run: bool) -> CommandResult {
        match cmd {
            Command::InsertText { selector, text, style } => {
                self.cmd_insert_text(selector, text, style, dry_run)
            }
            Command::ReplaceTextRange {
                selector,
                new_text,
                style,
            } => self.cmd_replace_text_range(selector, new_text, style, dry_run),
            Command::DeleteTextRange { selector } => {
                self.cmd_delete_text_range(selector, dry_run)
            }
            Command::ClearTextStyle { selector } => {
                self.cmd_clear_text_style(selector, dry_run)
            }
            Command::InsertParagraphAfter { selector, content } => {
                self.cmd_insert_paragraph_after(selector, content, dry_run)
            }
            Command::InsertParagraphBefore { selector, content } => {
                self.cmd_insert_paragraph_before(selector, content, dry_run)
            }
            Command::DeleteParagraph { selector } => {
                self.cmd_delete_paragraph(selector, dry_run)
            }
            Command::ApplyParagraphStyle { selector, style } => {
                self.cmd_apply_paragraph_style(selector, style, dry_run)
            }
            Command::ToggleList {
                selector,
                list_type,
            } => self.cmd_toggle_list(selector, list_type, dry_run),
            Command::SplitParagraph { selector } => {
                self.cmd_split_paragraph(selector, dry_run)
            }
            Command::MergeParagraphWithNext { selector } => {
                self.cmd_merge_paragraph_with_next(selector, dry_run)
            }
            Command::ApplyTextStyle { selector, style } => {
                self.cmd_apply_text_style(selector, style, dry_run)
            }
            Command::InsertTable { selector, rows, cols } => {
                self.cmd_insert_table(selector, rows, cols, dry_run)
            }
            Command::InsertHorizontalRule { selector } => {
                self.cmd_insert_structure(
                    selector,
                    Block::HorizontalRule(HorizontalRule::new()),
                    "InsertHorizontalRule",
                    dry_run,
                )
            }
            Command::InsertPageBreak { selector } => {
                self.cmd_insert_structure(
                    selector,
                    Block::PageBreak(PageBreak::new()),
                    "InsertPageBreak",
                    dry_run,
                )
            }
            Command::InsertCodeBlock { selector, code, language } => {
                self.cmd_insert_structure(
                    selector,
                    Block::CodeBlock(CodeBlock::new(&code, &language)),
                    "InsertCodeBlock",
                    dry_run,
                )
            }
            Command::InsertFormulaBlock { selector, latex } => {
                self.cmd_insert_structure(
                    selector,
                    Block::FormulaBlock(FormulaBlock::new(&latex)),
                    "InsertFormulaBlock",
                    dry_run,
                )
            }
            Command::InsertMermaidBlock { selector, source } => {
                self.cmd_insert_structure(
                    selector,
                    Block::MermaidBlock(MermaidBlock::new(&source)),
                    "InsertMermaidBlock",
                    dry_run,
                )
            }
            Command::InsertImageBlock {
                selector,
                asset_id,
                alt,
                width,
                height,
            } => {
                self.cmd_insert_structure(
                    selector,
                    Block::ImageBlock(ImageBlock {
                        id: Uuid::new_v4(),
                        asset_id,
                        alt,
                        width,
                        height,
                    }),
                    "InsertImageBlock",
                    dry_run,
                )
            }
            Command::InsertTableRowBefore { selector } => {
                self.cmd_insert_table_row(selector, true, dry_run)
            }
            Command::InsertTableRowAfter { selector } => {
                self.cmd_insert_table_row(selector, false, dry_run)
            }
            Command::DeleteTableRow { selector } => {
                self.cmd_delete_table_row(selector, dry_run)
            }
            Command::InsertTableColumnBefore { selector } => {
                self.cmd_insert_table_column(selector, true, dry_run)
            }
            Command::InsertTableColumnAfter { selector } => {
                self.cmd_insert_table_column(selector, false, dry_run)
            }
            Command::DeleteTableColumn { selector } => {
                self.cmd_delete_table_column(selector, dry_run)
            }
            Command::SetTableCellContent { selector, blocks } => {
                self.cmd_set_table_cell_content(selector, blocks, dry_run)
            }
            Command::SetPageConfig { section_index, config } => {
                self.cmd_set_page_config(section_index, config, dry_run)
            }
            Command::BatchCommand { commands } => {
                self.cmd_batch(commands, dry_run)
            }
        }
    }

    // ── Undo / Redo ─────────────────────────────────────────────────────

    pub fn undo(&mut self) -> Result<CommandResult, DocumentError> {
        let tx = self.undo_stack.pop().ok_or(DocumentError::EmptyUndoStack)?;
        let changed = tx.changed_node_ids.clone();
        let tx_id = tx.transaction_id;
        self.apply_undo_payload(&tx.undo_payload);
        self.selection = tx.selection_before.clone();
        self.redo_stack.push(tx);
        Ok(CommandResult::ok(changed, tx_id))
    }

    pub fn redo(&mut self) -> Result<CommandResult, DocumentError> {
        let tx = self.redo_stack.pop().ok_or(DocumentError::EmptyRedoStack)?;
        let changed = tx.changed_node_ids.clone();
        let tx_id = tx.transaction_id;
        self.apply_redo_payload(&tx.redo_payload);
        self.selection = tx.selection_after.clone();
        self.undo_stack.push(tx);
        Ok(CommandResult::ok(changed, tx_id))
    }

    pub fn can_undo(&self) -> bool {
        !self.undo_stack.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo_stack.is_empty()
    }

    fn apply_undo_payload(&mut self, payload: &UndoPayload) {
        match payload {
            UndoPayload::FullSnapshot(doc) => self.document = *doc.clone(),
            UndoPayload::BlockRestore { blocks } => {
                for (si, bi, block) in blocks {
                    self.document.sections[*si].blocks[*bi] = block.clone();
                }
            }
            UndoPayload::BlockInsert {
                section_index,
                block_index,
                blocks,
            } => {
                for (i, block) in blocks.iter().enumerate() {
                    self.document.sections[*section_index]
                        .blocks
                        .insert(*block_index + i, block.clone());
                }
            }
            UndoPayload::BlockRemove { node_ids } => {
                for section in &mut self.document.sections {
                    section.blocks.retain(|b| !node_ids.contains(&b.id()));
                }
            }
        }
    }

    fn apply_redo_payload(&mut self, payload: &RedoPayload) {
        match payload {
            RedoPayload::FullSnapshot(doc) => self.document = *doc.clone(),
            RedoPayload::BlockRestore { blocks } => {
                for (si, bi, block) in blocks {
                    self.document.sections[*si].blocks[*bi] = block.clone();
                }
            }
            RedoPayload::BlockInsert {
                section_index,
                block_index,
                blocks,
            } => {
                for (i, block) in blocks.iter().enumerate() {
                    self.document.sections[*section_index]
                        .blocks
                        .insert(*block_index + i, block.clone());
                }
            }
            RedoPayload::BlockRemove { node_ids } => {
                for section in &mut self.document.sections {
                    section.blocks.retain(|b| !node_ids.contains(&b.id()));
                }
            }
        }
    }

    fn push_transaction(&mut self, tx: Transaction) {
        self.redo_stack.clear();
        self.undo_stack.push(tx);
    }

    fn push_snapshot_transaction(
        &mut self,
        command_name: &str,
        input_selectors: Vec<Selector>,
        changed_node_ids: Vec<Uuid>,
        selection_before: Option<LogicalSelection>,
        selection_after: Option<LogicalSelection>,
        old_doc: Document,
    ) -> Uuid {
        let revision = self.document.next_revision();
        let tx_id = Uuid::new_v4();
        self.push_transaction(Transaction {
            transaction_id: tx_id,
            revision,
            command_name: command_name.into(),
            input_selectors,
            changed_node_ids,
            selection_before,
            selection_after,
            undo_payload: UndoPayload::FullSnapshot(Box::new(old_doc)),
            redo_payload: RedoPayload::FullSnapshot(Box::new(self.document.clone())),
        });
        tx_id
    }

    fn paragraph_indices(&self, selector: &Selector, command_name: &str) -> Result<(usize, usize, Uuid), CommandResult> {
        let node_id = match selector {
            Selector::NodeId(id) => *id,
            _ => {
                return Err(CommandResult::err(format!(
                    "{command_name} requires NodeId selector"
                )))
            }
        };

        let (si, bi) = self.document.find_block(node_id).unwrap();
        match &self.document.sections[si].blocks[bi] {
            Block::Paragraph(_) => Ok((si, bi, node_id)),
            _ => Err(CommandResult::err("target is not a Paragraph")),
        }
    }

    fn table_selector_indices(
        &self,
        selector: &Selector,
        command_name: &str,
    ) -> Result<(usize, usize, usize, usize, Uuid), CommandResult> {
        match selector {
            Selector::TableCell { table_id, row, col } => {
                let (si, bi) = self.document.find_block(*table_id).unwrap();
                match &self.document.sections[si].blocks[bi] {
                    Block::Table(_) => Ok((si, bi, *row, *col, *table_id)),
                    _ => Err(CommandResult::err("target is not a Table")),
                }
            }
            _ => Err(CommandResult::err(format!(
                "{command_name} requires TableCell selector"
            ))),
        }
    }

    // ── Command implementations ─────────────────────────────────────────

    fn cmd_insert_text(
        &mut self,
        selector: Selector,
        text: String,
        style: Option<TextStyle>,
        dry_run: bool,
    ) -> CommandResult {
        if let Err(e) = selector.validate(&self.document) {
            return CommandResult::err(e.to_string());
        }

        match &selector {
            Selector::TextRange { node_id, start, .. } => {
                let node_id = *node_id;
                let start = *start;
                if dry_run {
                    return CommandResult::ok(vec![node_id], Uuid::new_v4());
                }

                let (si, bi) = self.document.find_block(node_id).unwrap();
                let old_block = self.document.sections[si].blocks[bi].clone();

                if let Block::Paragraph(ref mut p) = self.document.sections[si].blocks[bi] {
                    let run_style = style.unwrap_or_default();
                    p.runs = insert_text_into_runs(&p.runs, start, text, run_style);
                }

                let revision = self.document.next_revision();
                let tx_id = Uuid::new_v4();
                self.push_transaction(Transaction {
                    transaction_id: tx_id,
                    revision,
                    command_name: "InsertText".into(),
                    input_selectors: vec![selector],
                    changed_node_ids: vec![node_id],
                    selection_before: self.selection.clone(),
                    selection_after: None,
                    undo_payload: UndoPayload::BlockRestore {
                        blocks: vec![(si, bi, old_block)],
                    },
                    redo_payload: RedoPayload::BlockRestore {
                        blocks: vec![(si, bi, self.document.sections[si].blocks[bi].clone())],
                    },
                });

                CommandResult::ok(vec![node_id], tx_id)
            }
            _ => CommandResult::err("InsertText requires TextRange selector"),
        }
    }

    fn cmd_replace_text_range(
        &mut self,
        selector: Selector,
        new_text: String,
        style: Option<TextStyle>,
        dry_run: bool,
    ) -> CommandResult {
        if let Err(e) = selector.validate(&self.document) {
            return CommandResult::err(e.to_string());
        }

        match &selector {
            Selector::TextRange { node_id, start, end } => {
                let node_id = *node_id;
                let start = *start;
                let end = *end;
                if dry_run {
                    return CommandResult::ok(vec![node_id], Uuid::new_v4());
                }

                let (si, bi) = self.document.find_block(node_id).unwrap();
                let old_block = self.document.sections[si].blocks[bi].clone();

                if let Block::Paragraph(ref mut p) = self.document.sections[si].blocks[bi] {
                    let replacement_style = style.unwrap_or_default();
                    p.runs = replace_text_in_runs(&p.runs, start, end, new_text, replacement_style);
                }

                let revision = self.document.next_revision();
                let tx_id = Uuid::new_v4();
                self.push_transaction(Transaction {
                    transaction_id: tx_id,
                    revision,
                    command_name: "ReplaceTextRange".into(),
                    input_selectors: vec![selector],
                    changed_node_ids: vec![node_id],
                    selection_before: self.selection.clone(),
                    selection_after: None,
                    undo_payload: UndoPayload::BlockRestore {
                        blocks: vec![(si, bi, old_block)],
                    },
                    redo_payload: RedoPayload::BlockRestore {
                        blocks: vec![(si, bi, self.document.sections[si].blocks[bi].clone())],
                    },
                });

                CommandResult::ok(vec![node_id], tx_id)
            }
            _ => CommandResult::err("ReplaceTextRange requires TextRange selector"),
        }
    }

    fn cmd_delete_text_range(
        &mut self,
        selector: Selector,
        dry_run: bool,
    ) -> CommandResult {
        if let Err(e) = selector.validate(&self.document) {
            return CommandResult::err(e.to_string());
        }

        match &selector {
            Selector::TextRange { node_id, start, end } => {
                let node_id = *node_id;
                let start = *start;
                let end = *end;
                if dry_run {
                    return CommandResult::ok(vec![node_id], Uuid::new_v4());
                }

                let (si, bi) = self.document.find_block(node_id).unwrap();
                let old_block = self.document.sections[si].blocks[bi].clone();

                if let Block::Paragraph(ref mut p) = self.document.sections[si].blocks[bi] {
                    p.runs = delete_text_from_runs(&p.runs, start, end);
                }

                let revision = self.document.next_revision();
                let tx_id = Uuid::new_v4();
                self.push_transaction(Transaction {
                    transaction_id: tx_id,
                    revision,
                    command_name: "DeleteTextRange".into(),
                    input_selectors: vec![selector],
                    changed_node_ids: vec![node_id],
                    selection_before: self.selection.clone(),
                    selection_after: None,
                    undo_payload: UndoPayload::BlockRestore {
                        blocks: vec![(si, bi, old_block)],
                    },
                    redo_payload: RedoPayload::BlockRestore {
                        blocks: vec![(si, bi, self.document.sections[si].blocks[bi].clone())],
                    },
                });

                CommandResult::ok(vec![node_id], tx_id)
            }
            _ => CommandResult::err("DeleteTextRange requires TextRange selector"),
        }
    }

    fn cmd_insert_paragraph_after(
        &mut self,
        selector: Selector,
        content: Option<Paragraph>,
        dry_run: bool,
    ) -> CommandResult {
        if let Err(e) = selector.validate(&self.document) {
            return CommandResult::err(e.to_string());
        }

        let node_id = match &selector {
            Selector::NodeId(id) => *id,
            _ => return CommandResult::err("InsertParagraphAfter requires NodeId selector"),
        };

        if dry_run {
            return CommandResult::ok(vec![], Uuid::new_v4());
        }

        let (si, bi) = self.document.find_block(node_id).unwrap();
        let new_para = content.unwrap_or_else(Paragraph::new);
        let new_id = new_para.id;
        self.document.sections[si]
            .blocks
            .insert(bi + 1, Block::Paragraph(new_para));

        let revision = self.document.next_revision();
        let tx_id = Uuid::new_v4();
        self.push_transaction(Transaction {
            transaction_id: tx_id,
            revision,
            command_name: "InsertParagraphAfter".into(),
            input_selectors: vec![selector],
            changed_node_ids: vec![new_id],
            selection_before: self.selection.clone(),
            selection_after: None,
            undo_payload: UndoPayload::BlockRemove {
                node_ids: vec![new_id],
            },
            redo_payload: RedoPayload::BlockInsert {
                section_index: si,
                block_index: bi + 1,
                blocks: vec![self.document.sections[si].blocks[bi + 1].clone()],
            },
        });

        CommandResult::ok(vec![new_id], tx_id)
    }

    fn cmd_insert_paragraph_before(
        &mut self,
        selector: Selector,
        content: Option<Paragraph>,
        dry_run: bool,
    ) -> CommandResult {
        if let Err(e) = selector.validate(&self.document) {
            return CommandResult::err(e.to_string());
        }

        let node_id = match &selector {
            Selector::NodeId(id) => *id,
            _ => return CommandResult::err("InsertParagraphBefore requires NodeId selector"),
        };

        if dry_run {
            return CommandResult::ok(vec![], Uuid::new_v4());
        }

        let (si, bi) = self.document.find_block(node_id).unwrap();
        let new_para = content.unwrap_or_else(Paragraph::new);
        let new_id = new_para.id;
        self.document.sections[si]
            .blocks
            .insert(bi, Block::Paragraph(new_para));

        let revision = self.document.next_revision();
        let tx_id = Uuid::new_v4();
        self.push_transaction(Transaction {
            transaction_id: tx_id,
            revision,
            command_name: "InsertParagraphBefore".into(),
            input_selectors: vec![selector],
            changed_node_ids: vec![new_id],
            selection_before: self.selection.clone(),
            selection_after: None,
            undo_payload: UndoPayload::BlockRemove {
                node_ids: vec![new_id],
            },
            redo_payload: RedoPayload::BlockInsert {
                section_index: si,
                block_index: bi,
                blocks: vec![self.document.sections[si].blocks[bi].clone()],
            },
        });

        CommandResult::ok(vec![new_id], tx_id)
    }

    fn cmd_delete_paragraph(
        &mut self,
        selector: Selector,
        dry_run: bool,
    ) -> CommandResult {
        if let Err(e) = selector.validate(&self.document) {
            return CommandResult::err(e.to_string());
        }

        let node_id = match &selector {
            Selector::NodeId(id) => *id,
            _ => return CommandResult::err("DeleteParagraph requires NodeId selector"),
        };

        let (si, bi) = self.document.find_block(node_id).unwrap();

        // Prevent deleting the last block in a section
        if self.document.sections[si].blocks.len() <= 1 {
            return CommandResult::err("cannot delete the last block in a section");
        }

        if dry_run {
            return CommandResult::ok(vec![node_id], Uuid::new_v4());
        }

        let removed = self.document.sections[si].blocks.remove(bi);

        let revision = self.document.next_revision();
        let tx_id = Uuid::new_v4();
        self.push_transaction(Transaction {
            transaction_id: tx_id,
            revision,
            command_name: "DeleteParagraph".into(),
            input_selectors: vec![selector],
            changed_node_ids: vec![node_id],
            selection_before: self.selection.clone(),
            selection_after: None,
            undo_payload: UndoPayload::BlockInsert {
                section_index: si,
                block_index: bi,
                blocks: vec![removed],
            },
            redo_payload: RedoPayload::BlockRemove {
                node_ids: vec![node_id],
            },
        });

        CommandResult::ok(vec![node_id], tx_id)
    }

    fn cmd_apply_paragraph_style(
        &mut self,
        selector: Selector,
        style: ParagraphStyle,
        dry_run: bool,
    ) -> CommandResult {
        if let Err(e) = selector.validate(&self.document) {
            return CommandResult::err(e.to_string());
        }

        let node_id = match &selector {
            Selector::NodeId(id) => *id,
            _ => return CommandResult::err("ApplyParagraphStyle requires NodeId selector"),
        };

        let (si, bi) = self.document.find_block(node_id).unwrap();
        match &self.document.sections[si].blocks[bi] {
            Block::Paragraph(_) => {}
            _ => return CommandResult::err("target is not a Paragraph"),
        }

        if dry_run {
            return CommandResult::ok(vec![node_id], Uuid::new_v4());
        }

        let old_block = self.document.sections[si].blocks[bi].clone();
        if let Block::Paragraph(ref mut p) = self.document.sections[si].blocks[bi] {
            p.style = style;
        }

        let revision = self.document.next_revision();
        let tx_id = Uuid::new_v4();
        self.push_transaction(Transaction {
            transaction_id: tx_id,
            revision,
            command_name: "ApplyParagraphStyle".into(),
            input_selectors: vec![selector],
            changed_node_ids: vec![node_id],
            selection_before: self.selection.clone(),
            selection_after: None,
            undo_payload: UndoPayload::BlockRestore {
                blocks: vec![(si, bi, old_block)],
            },
            redo_payload: RedoPayload::BlockRestore {
                blocks: vec![(si, bi, self.document.sections[si].blocks[bi].clone())],
            },
        });

        CommandResult::ok(vec![node_id], tx_id)
    }

    fn cmd_toggle_list(
        &mut self,
        selector: Selector,
        list_type: ListType,
        dry_run: bool,
    ) -> CommandResult {
        if let Err(e) = selector.validate(&self.document) {
            return CommandResult::err(e.to_string());
        }

        let (si, bi, node_id) = match self.paragraph_indices(&selector, "ToggleList") {
            Ok(indices) => indices,
            Err(err) => return err,
        };

        if dry_run {
            return CommandResult::ok(vec![node_id], Uuid::new_v4());
        }

        let old_block = self.document.sections[si].blocks[bi].clone();
        if let Block::Paragraph(ref mut p) = self.document.sections[si].blocks[bi] {
            if p.style.list_type == Some(list_type) {
                p.style.list_type = None;
                p.style.list_level = 0;
            } else {
                p.style.list_type = Some(list_type);
            }
        }

        let revision = self.document.next_revision();
        let tx_id = Uuid::new_v4();
        self.push_transaction(Transaction {
            transaction_id: tx_id,
            revision,
            command_name: "ToggleList".into(),
            input_selectors: vec![selector],
            changed_node_ids: vec![node_id],
            selection_before: self.selection.clone(),
            selection_after: None,
            undo_payload: UndoPayload::BlockRestore {
                blocks: vec![(si, bi, old_block)],
            },
            redo_payload: RedoPayload::BlockRestore {
                blocks: vec![(si, bi, self.document.sections[si].blocks[bi].clone())],
            },
        });

        CommandResult::ok(vec![node_id], tx_id)
    }

    fn cmd_apply_text_style(
        &mut self,
        selector: Selector,
        style: TextStyle,
        dry_run: bool,
    ) -> CommandResult {
        if let Err(e) = selector.validate(&self.document) {
            return CommandResult::err(e.to_string());
        }

        match &selector {
            Selector::TextRange {
                node_id,
                start,
                end,
            } => {
                let node_id = *node_id;
                if dry_run {
                    return CommandResult::ok(vec![node_id], Uuid::new_v4());
                }

                let (si, bi) = self.document.find_block(node_id).unwrap();
                let old_block = self.document.sections[si].blocks[bi].clone();

                if let Block::Paragraph(ref mut p) = self.document.sections[si].blocks[bi] {
                    p.runs = apply_style_to_runs(&p.runs, *start, *end, &style);
                }

                let revision = self.document.next_revision();
                let tx_id = Uuid::new_v4();
                self.push_transaction(Transaction {
                    transaction_id: tx_id,
                    revision,
                    command_name: "ApplyTextStyle".into(),
                    input_selectors: vec![selector],
                    changed_node_ids: vec![node_id],
                    selection_before: self.selection.clone(),
                    selection_after: None,
                    undo_payload: UndoPayload::BlockRestore {
                        blocks: vec![(si, bi, old_block)],
                    },
                    redo_payload: RedoPayload::BlockRestore {
                        blocks: vec![(si, bi, self.document.sections[si].blocks[bi].clone())],
                    },
                });

                CommandResult::ok(vec![node_id], tx_id)
            }
            _ => CommandResult::err("ApplyTextStyle requires TextRange selector"),
        }
    }

    fn cmd_clear_text_style(
        &mut self,
        selector: Selector,
        dry_run: bool,
    ) -> CommandResult {
        if let Err(e) = selector.validate(&self.document) {
            return CommandResult::err(e.to_string());
        }

        match &selector {
            Selector::TextRange { node_id, start, end } => {
                let node_id = *node_id;
                if dry_run {
                    return CommandResult::ok(vec![node_id], Uuid::new_v4());
                }

                let (si, bi) = self.document.find_block(node_id).unwrap();
                let old_block = self.document.sections[si].blocks[bi].clone();

                if let Block::Paragraph(ref mut p) = self.document.sections[si].blocks[bi] {
                    p.runs = clear_style_from_runs(&p.runs, *start, *end);
                }

                let revision = self.document.next_revision();
                let tx_id = Uuid::new_v4();
                self.push_transaction(Transaction {
                    transaction_id: tx_id,
                    revision,
                    command_name: "ClearTextStyle".into(),
                    input_selectors: vec![selector],
                    changed_node_ids: vec![node_id],
                    selection_before: self.selection.clone(),
                    selection_after: None,
                    undo_payload: UndoPayload::BlockRestore {
                        blocks: vec![(si, bi, old_block)],
                    },
                    redo_payload: RedoPayload::BlockRestore {
                        blocks: vec![(si, bi, self.document.sections[si].blocks[bi].clone())],
                    },
                });

                CommandResult::ok(vec![node_id], tx_id)
            }
            _ => CommandResult::err("ClearTextStyle requires TextRange selector"),
        }
    }

    fn cmd_split_paragraph(
        &mut self,
        selector: Selector,
        dry_run: bool,
    ) -> CommandResult {
        if let Err(e) = selector.validate(&self.document) {
            return CommandResult::err(e.to_string());
        }

        let (node_id, split_at) = match &selector {
            Selector::TextRange {
                node_id,
                start,
                end,
            } if start == end => (*node_id, *start),
            Selector::TextRange { .. } => {
                return CommandResult::err("SplitParagraph requires a collapsed TextRange")
            }
            _ => return CommandResult::err("SplitParagraph requires TextRange selector"),
        };

        if dry_run {
            return CommandResult::ok(vec![node_id], Uuid::new_v4());
        }

        let old_doc = self.document.clone();
        let (si, bi) = self.document.find_block(node_id).unwrap();

        let (right_runs, new_id) = {
            let block = &mut self.document.sections[si].blocks[bi];
            let Block::Paragraph(paragraph) = block else {
                return CommandResult::err("target is not a Paragraph");
            };
            let (left_runs, right_runs) = split_runs_at_offset(&paragraph.runs, split_at);
            paragraph.runs = left_runs;
            (right_runs, Uuid::new_v4())
        };

        let original_style = match &self.document.sections[si].blocks[bi] {
            Block::Paragraph(paragraph) => paragraph.style.clone(),
            _ => unreachable!(),
        };
        let new_paragraph = Paragraph {
            id: new_id,
            runs: right_runs,
            style: original_style,
        };
        self.document.sections[si]
            .blocks
            .insert(bi + 1, Block::Paragraph(new_paragraph));

        let tx_id = self.push_snapshot_transaction(
            "SplitParagraph",
            vec![selector],
            vec![node_id, new_id],
            self.selection.clone(),
            None,
            old_doc,
        );

        CommandResult::ok(vec![node_id, new_id], tx_id)
    }

    fn cmd_merge_paragraph_with_next(
        &mut self,
        selector: Selector,
        dry_run: bool,
    ) -> CommandResult {
        if let Err(e) = selector.validate(&self.document) {
            return CommandResult::err(e.to_string());
        }

        let (si, bi, node_id) = match self.paragraph_indices(&selector, "MergeParagraphWithNext") {
            Ok(indices) => indices,
            Err(err) => return err,
        };

        if bi + 1 >= self.document.sections[si].blocks.len() {
            return CommandResult::err("no following paragraph to merge");
        }

        let next_id = self.document.sections[si].blocks[bi + 1].id();
        match &self.document.sections[si].blocks[bi + 1] {
            Block::Paragraph(_) => {}
            _ => return CommandResult::err("next block is not a Paragraph"),
        }

        if dry_run {
            return CommandResult::ok(vec![node_id, next_id], Uuid::new_v4());
        }

        let old_doc = self.document.clone();
        let next_block = self.document.sections[si].blocks.remove(bi + 1);
        let next_runs = match next_block {
            Block::Paragraph(paragraph) => paragraph.runs,
            _ => unreachable!(),
        };

        if let Block::Paragraph(ref mut paragraph) = self.document.sections[si].blocks[bi] {
            paragraph.runs.extend(next_runs);
            paragraph.runs = merge_adjacent_text_runs(paragraph.runs.clone());
        }

        let tx_id = self.push_snapshot_transaction(
            "MergeParagraphWithNext",
            vec![selector],
            vec![node_id, next_id],
            self.selection.clone(),
            None,
            old_doc,
        );

        CommandResult::ok(vec![node_id, next_id], tx_id)
    }

    fn cmd_insert_table(
        &mut self,
        selector: Selector,
        rows: usize,
        cols: usize,
        dry_run: bool,
    ) -> CommandResult {
        if let Err(e) = selector.validate(&self.document) {
            return CommandResult::err(e.to_string());
        }

        let node_id = match &selector {
            Selector::NodeId(id) => *id,
            _ => return CommandResult::err("InsertTable requires NodeId selector"),
        };

        if dry_run {
            return CommandResult::ok(vec![], Uuid::new_v4());
        }

        let (si, bi) = self.document.find_block(node_id).unwrap();
        let content_width = self.document.sections[si].page_config.content_width();
        let col_width = content_width / cols as f64;
        let table = Table::new(rows, cols, col_width);
        let table_id = table.id;
        self.document.sections[si]
            .blocks
            .insert(bi + 1, Block::Table(table));

        let revision = self.document.next_revision();
        let tx_id = Uuid::new_v4();
        self.push_transaction(Transaction {
            transaction_id: tx_id,
            revision,
            command_name: "InsertTable".into(),
            input_selectors: vec![selector],
            changed_node_ids: vec![table_id],
            selection_before: self.selection.clone(),
            selection_after: None,
            undo_payload: UndoPayload::BlockRemove {
                node_ids: vec![table_id],
            },
            redo_payload: RedoPayload::BlockInsert {
                section_index: si,
                block_index: bi + 1,
                blocks: vec![self.document.sections[si].blocks[bi + 1].clone()],
            },
        });

        CommandResult::ok(vec![table_id], tx_id)
    }

    fn cmd_insert_table_row(
        &mut self,
        selector: Selector,
        before: bool,
        dry_run: bool,
    ) -> CommandResult {
        if let Err(e) = selector.validate(&self.document) {
            return CommandResult::err(e.to_string());
        }

        let (si, bi, row, _, table_id) = match self.table_selector_indices(
            &selector,
            if before {
                "InsertTableRowBefore"
            } else {
                "InsertTableRowAfter"
            },
        ) {
            Ok(indices) => indices,
            Err(err) => return err,
        };

        if dry_run {
            return CommandResult::ok(vec![table_id], Uuid::new_v4());
        }

        let old_doc = self.document.clone();
        let mut changed_node_ids = vec![table_id];
        if let Block::Table(ref mut table) = self.document.sections[si].blocks[bi] {
            let cols = table.column_widths.len().max(1);
            let insert_index = if before { row } else { row + 1 };
            let new_row = TableRow::new(cols);
            changed_node_ids.push(new_row.id);
            table.rows.insert(insert_index, new_row);
        }

        let tx_id = self.push_snapshot_transaction(
            if before {
                "InsertTableRowBefore"
            } else {
                "InsertTableRowAfter"
            },
            vec![selector],
            changed_node_ids.clone(),
            self.selection.clone(),
            None,
            old_doc,
        );

        CommandResult::ok(changed_node_ids, tx_id)
    }

    fn cmd_delete_table_row(
        &mut self,
        selector: Selector,
        dry_run: bool,
    ) -> CommandResult {
        if let Err(e) = selector.validate(&self.document) {
            return CommandResult::err(e.to_string());
        }

        let (si, bi, row, _, table_id) = match self.table_selector_indices(&selector, "DeleteTableRow") {
            Ok(indices) => indices,
            Err(err) => return err,
        };

        if let Block::Table(table) = &self.document.sections[si].blocks[bi] {
            if table.rows.len() <= 1 {
                return CommandResult::err("cannot delete the last table row");
            }
            let changed_node_ids = vec![table_id, table.rows[row].id];
            if dry_run {
                return CommandResult::ok(changed_node_ids, Uuid::new_v4());
            }
        }

        let old_doc = self.document.clone();
        let changed_node_ids = if let Block::Table(ref mut table) = self.document.sections[si].blocks[bi] {
            let removed = table.rows.remove(row);
            vec![table_id, removed.id]
        } else {
            unreachable!()
        };

        let tx_id = self.push_snapshot_transaction(
            "DeleteTableRow",
            vec![selector],
            changed_node_ids.clone(),
            self.selection.clone(),
            None,
            old_doc,
        );

        CommandResult::ok(changed_node_ids, tx_id)
    }

    fn cmd_insert_table_column(
        &mut self,
        selector: Selector,
        before: bool,
        dry_run: bool,
    ) -> CommandResult {
        if let Err(e) = selector.validate(&self.document) {
            return CommandResult::err(e.to_string());
        }

        let (si, bi, _, col, table_id) = match self.table_selector_indices(
            &selector,
            if before {
                "InsertTableColumnBefore"
            } else {
                "InsertTableColumnAfter"
            },
        ) {
            Ok(indices) => indices,
            Err(err) => return err,
        };

        if dry_run {
            return CommandResult::ok(vec![table_id], Uuid::new_v4());
        }

        let old_doc = self.document.clone();
        let mut changed_node_ids = vec![table_id];
        if let Block::Table(ref mut table) = self.document.sections[si].blocks[bi] {
            let insert_index = if before { col } else { col + 1 };
            let width = table
                .column_widths
                .get(col)
                .copied()
                .or_else(|| table.column_widths.last().copied())
                .unwrap_or(120.0);
            table.column_widths.insert(insert_index, width);
            for row in &mut table.rows {
                let cell = TableCell::new();
                changed_node_ids.push(cell.id);
                row.cells.insert(insert_index, cell);
            }
        }

        let tx_id = self.push_snapshot_transaction(
            if before {
                "InsertTableColumnBefore"
            } else {
                "InsertTableColumnAfter"
            },
            vec![selector],
            changed_node_ids.clone(),
            self.selection.clone(),
            None,
            old_doc,
        );

        CommandResult::ok(changed_node_ids, tx_id)
    }

    fn cmd_delete_table_column(
        &mut self,
        selector: Selector,
        dry_run: bool,
    ) -> CommandResult {
        if let Err(e) = selector.validate(&self.document) {
            return CommandResult::err(e.to_string());
        }

        let (si, bi, row, col, table_id) = match self.table_selector_indices(&selector, "DeleteTableColumn") {
            Ok(indices) => indices,
            Err(err) => return err,
        };

        if let Block::Table(table) = &self.document.sections[si].blocks[bi] {
            if table.column_widths.len() <= 1 {
                return CommandResult::err("cannot delete the last table column");
            }
            let changed_node_ids = vec![table_id, table.rows[row].cells[col].id];
            if dry_run {
                return CommandResult::ok(changed_node_ids, Uuid::new_v4());
            }
        }

        let old_doc = self.document.clone();
        let changed_node_ids = if let Block::Table(ref mut table) = self.document.sections[si].blocks[bi] {
            table.column_widths.remove(col);
            let mut removed_cells = Vec::new();
            for row in &mut table.rows {
                removed_cells.push(row.cells.remove(col).id);
            }
            let mut ids = vec![table_id];
            ids.extend(removed_cells);
            ids
        } else {
            unreachable!()
        };

        let tx_id = self.push_snapshot_transaction(
            "DeleteTableColumn",
            vec![selector],
            changed_node_ids.clone(),
            self.selection.clone(),
            None,
            old_doc,
        );

        CommandResult::ok(changed_node_ids, tx_id)
    }

    fn cmd_set_table_cell_content(
        &mut self,
        selector: Selector,
        blocks: Vec<Block>,
        dry_run: bool,
    ) -> CommandResult {
        if let Err(e) = selector.validate(&self.document) {
            return CommandResult::err(e.to_string());
        }

        let (si, bi, row, col, table_id) = match self.table_selector_indices(&selector, "SetTableCellContent") {
            Ok(indices) => indices,
            Err(err) => return err,
        };

        let changed_node_ids = if let Block::Table(table) = &self.document.sections[si].blocks[bi] {
            vec![table_id, table.rows[row].cells[col].id]
        } else {
            unreachable!()
        };
        if dry_run {
            return CommandResult::ok(changed_node_ids, Uuid::new_v4());
        }

        let old_doc = self.document.clone();
        if let Block::Table(ref mut table) = self.document.sections[si].blocks[bi] {
            table.rows[row].cells[col].blocks = if blocks.is_empty() {
                vec![Block::Paragraph(Paragraph::new())]
            } else {
                blocks
            };
        }

        let tx_id = self.push_snapshot_transaction(
            "SetTableCellContent",
            vec![selector],
            changed_node_ids.clone(),
            self.selection.clone(),
            None,
            old_doc,
        );

        CommandResult::ok(changed_node_ids, tx_id)
    }

    fn cmd_insert_structure(
        &mut self,
        selector: Selector,
        block: Block,
        cmd_name: &str,
        dry_run: bool,
    ) -> CommandResult {
        if let Err(e) = selector.validate(&self.document) {
            return CommandResult::err(e.to_string());
        }

        let anchor_id = match &selector {
            Selector::NodeId(id) => *id,
            _ => return CommandResult::err(format!("{cmd_name} requires NodeId selector")),
        };

        if dry_run {
            return CommandResult::ok(vec![], Uuid::new_v4());
        }

        let (si, bi) = self.document.find_block(anchor_id).unwrap();
        let new_id = block.id();
        self.document.sections[si].blocks.insert(bi + 1, block);

        let revision = self.document.next_revision();
        let tx_id = Uuid::new_v4();
        self.push_transaction(Transaction {
            transaction_id: tx_id,
            revision,
            command_name: cmd_name.into(),
            input_selectors: vec![selector],
            changed_node_ids: vec![new_id],
            selection_before: self.selection.clone(),
            selection_after: None,
            undo_payload: UndoPayload::BlockRemove {
                node_ids: vec![new_id],
            },
            redo_payload: RedoPayload::BlockInsert {
                section_index: si,
                block_index: bi + 1,
                blocks: vec![self.document.sections[si].blocks[bi + 1].clone()],
            },
        });

        CommandResult::ok(vec![new_id], tx_id)
    }

    fn cmd_set_page_config(
        &mut self,
        section_index: usize,
        config: PageConfig,
        dry_run: bool,
    ) -> CommandResult {
        if section_index >= self.document.sections.len() {
            return CommandResult::err(format!(
                "section index {} out of range ({})",
                section_index,
                self.document.sections.len()
            ));
        }

        if dry_run {
            return CommandResult::ok(vec![], Uuid::new_v4());
        }

        let old_doc = self.document.clone();
        self.document.sections[section_index].page_config = config;

        let revision = self.document.next_revision();
        let tx_id = Uuid::new_v4();
        self.push_transaction(Transaction {
            transaction_id: tx_id,
            revision,
            command_name: "SetPageConfig".into(),
            input_selectors: vec![],
            changed_node_ids: vec![self.document.sections[section_index].id],
            selection_before: self.selection.clone(),
            selection_after: self.selection.clone(),
            undo_payload: UndoPayload::FullSnapshot(Box::new(old_doc)),
            redo_payload: RedoPayload::FullSnapshot(Box::new(self.document.clone())),
        });

        CommandResult::ok(
            vec![self.document.sections[section_index].id],
            tx_id,
        )
    }

    fn cmd_batch(&mut self, commands: Vec<Command>, dry_run: bool) -> CommandResult {
        if dry_run {
            for cmd in &commands {
                let result = self.dry_run(cmd);
                if !result.success {
                    return result;
                }
            }
            return CommandResult::ok(vec![], Uuid::new_v4());
        }

        let old_doc = self.document.clone();
        let selection_before = self.selection.clone();
        let mut all_changed = Vec::new();

        for cmd in commands {
            let result = self.execute(cmd);
            if !result.success {
                // Rollback
                self.document = old_doc;
                self.selection = selection_before;
                return result;
            }
            all_changed.extend(result.changed_node_ids);
            // Remove individual transactions pushed by sub-commands
            self.undo_stack.pop();
        }

        let revision = self.document.next_revision();
        let tx_id = Uuid::new_v4();
        self.push_transaction(Transaction {
            transaction_id: tx_id,
            revision,
            command_name: "BatchCommand".into(),
            input_selectors: vec![],
            changed_node_ids: all_changed.clone(),
            selection_before,
            selection_after: self.selection.clone(),
            undo_payload: UndoPayload::FullSnapshot(Box::new(old_doc)),
            redo_payload: RedoPayload::FullSnapshot(Box::new(self.document.clone())),
        });

        CommandResult::ok(all_changed, tx_id)
    }
}

fn inline_text_len(inline: &Inline) -> usize {
    match inline {
        Inline::TextRun(run) => run.text.len(),
        Inline::ImageSpan(_) => 1,
        Inline::SoftBreak => 1,
        Inline::InlineCode(code) => code.code.len(),
        Inline::LinkSpan(link) => link.children.iter().map(inline_text_len).sum(),
    }
}

fn split_runs_at_offset(runs: &[Inline], offset: usize) -> (Vec<Inline>, Vec<Inline>) {
    let mut left = Vec::new();
    let mut right = Vec::new();
    let mut cursor = 0;

    for run in runs {
        let len = inline_text_len(run);
        if offset <= cursor {
            right.push(run.clone());
        } else if offset >= cursor + len {
            left.push(run.clone());
        } else {
            match run {
                Inline::TextRun(text_run) => {
                    let split_at = offset - cursor;
                    if split_at > 0 {
                        left.push(Inline::TextRun(TextRun {
                            text: text_run.text[..split_at].to_string(),
                            style: text_run.style.clone(),
                        }));
                    }
                    if split_at < text_run.text.len() {
                        right.push(Inline::TextRun(TextRun {
                            text: text_run.text[split_at..].to_string(),
                            style: text_run.style.clone(),
                        }));
                    }
                }
                _ => right.push(run.clone()),
            }
        }
        cursor += len;
    }

    (merge_adjacent_text_runs(left), merge_adjacent_text_runs(right))
}

fn merge_adjacent_text_runs(runs: Vec<Inline>) -> Vec<Inline> {
    let mut merged: Vec<Inline> = Vec::new();
    for run in runs {
        match run {
            Inline::TextRun(text_run) if !text_run.text.is_empty() => {
                if let Some(Inline::TextRun(previous)) = merged.last_mut() {
                    if previous.style == text_run.style {
                        previous.text.push_str(&text_run.text);
                        continue;
                    }
                }
                merged.push(Inline::TextRun(text_run));
            }
            Inline::TextRun(_) => {}
            other => merged.push(other),
        }
    }
    merged
}

fn insert_text_into_runs(
    runs: &[Inline],
    offset: usize,
    text: String,
    style: TextStyle,
) -> Vec<Inline> {
    let (mut left, right) = split_runs_at_offset(runs, offset);
    if !text.is_empty() {
        left.push(Inline::TextRun(TextRun { text, style }));
    }
    left.extend(right);
    merge_adjacent_text_runs(left)
}

fn delete_text_from_runs(runs: &[Inline], start: usize, end: usize) -> Vec<Inline> {
    let (mut left, rest) = split_runs_at_offset(runs, start);
    let (_, right) = split_runs_at_offset(&rest, end.saturating_sub(start));
    left.extend(right);
    merge_adjacent_text_runs(left)
}

fn replace_text_in_runs(
    runs: &[Inline],
    start: usize,
    end: usize,
    new_text: String,
    style: TextStyle,
) -> Vec<Inline> {
    let (mut left, rest) = split_runs_at_offset(runs, start);
    let (_, right) = split_runs_at_offset(&rest, end.saturating_sub(start));
    if !new_text.is_empty() {
        left.push(Inline::TextRun(TextRun {
            text: new_text,
            style,
        }));
    }
    left.extend(right);
    merge_adjacent_text_runs(left)
}

fn apply_style_to_runs(
    runs: &[Inline],
    start: usize,
    end: usize,
    style: &TextStyle,
) -> Vec<Inline> {
    let (mut left, rest) = split_runs_at_offset(runs, start);
    let (middle, right) = split_runs_at_offset(&rest, end.saturating_sub(start));
    left.extend(middle.into_iter().map(|run| match run {
        Inline::TextRun(mut text_run) => {
            text_run.style = style.clone();
            Inline::TextRun(text_run)
        }
        other => other,
    }));
    left.extend(right);
    merge_adjacent_text_runs(left)
}

fn clear_style_from_runs(runs: &[Inline], start: usize, end: usize) -> Vec<Inline> {
    apply_style_to_runs(runs, start, end, &TextStyle::default())
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_document_and_insert_text() {
        let mut editor = DocumentEditor::from_default();
        let block_ids = editor.document.block_ids();
        let para_id = block_ids[0];

        let result = editor.execute(Command::InsertText {
            selector: Selector::TextRange {
                node_id: para_id,
                start: 0,
                end: 0,
            },
            text: "Hello, World!".into(),
            style: None,
        });

        assert!(result.success);

        if let Block::Paragraph(p) = &editor.document.sections[0].blocks[0] {
            assert_eq!(p.plain_text(), "Hello, World!");
        } else {
            panic!("expected Paragraph");
        }
    }

    #[test]
    fn test_delete_text_range() {
        let mut editor = DocumentEditor::from_default();
        let para = Paragraph::with_text("Hello, World!");
        let para_id = para.id;
        editor.document.sections[0].blocks[0] = Block::Paragraph(para);

        let result = editor.execute(Command::DeleteTextRange {
            selector: Selector::TextRange {
                node_id: para_id,
                start: 5,
                end: 13,
            },
        });

        assert!(result.success);
        if let Block::Paragraph(p) = &editor.document.sections[0].blocks[0] {
            assert_eq!(p.plain_text(), "Hello");
        }
    }

    #[test]
    fn test_insert_text_inside_existing_run() {
        let mut editor = DocumentEditor::from_default();
        let para = Paragraph::with_text("Hello");
        let para_id = para.id;
        editor.document.sections[0].blocks[0] = Block::Paragraph(para);

        let result = editor.execute(Command::InsertText {
            selector: Selector::TextRange {
                node_id: para_id,
                start: 1,
                end: 1,
            },
            text: "ey".into(),
            style: None,
        });

        assert!(result.success);
        if let Block::Paragraph(p) = &editor.document.sections[0].blocks[0] {
            assert_eq!(p.plain_text(), "Heyello");
        }
    }

    #[test]
    fn test_replace_text_range() {
        let mut editor = DocumentEditor::from_default();
        let para = Paragraph::with_text("Hello, World!");
        let para_id = para.id;
        editor.document.sections[0].blocks[0] = Block::Paragraph(para);

        let result = editor.execute(Command::ReplaceTextRange {
            selector: Selector::TextRange {
                node_id: para_id,
                start: 7,
                end: 12,
            },
            new_text: "Rust".into(),
            style: None,
        });

        assert!(result.success);
        if let Block::Paragraph(p) = &editor.document.sections[0].blocks[0] {
            assert_eq!(p.plain_text(), "Hello, Rust!");
        }
    }

    #[test]
    fn test_insert_paragraph_and_undo() {
        let mut editor = DocumentEditor::from_default();
        let block_ids = editor.document.block_ids();
        let first_id = block_ids[0];

        assert_eq!(editor.document.sections[0].blocks.len(), 1);

        let result = editor.execute(Command::InsertParagraphAfter {
            selector: Selector::NodeId(first_id),
            content: Some(Paragraph::with_text("Second paragraph")),
        });

        assert!(result.success);
        assert_eq!(editor.document.sections[0].blocks.len(), 2);

        // Undo
        let undo_result = editor.undo().unwrap();
        assert!(undo_result.success);
        assert_eq!(editor.document.sections[0].blocks.len(), 1);

        // Redo
        let redo_result = editor.redo().unwrap();
        assert!(redo_result.success);
        assert_eq!(editor.document.sections[0].blocks.len(), 2);
    }

    #[test]
    fn test_delete_paragraph() {
        let mut editor = DocumentEditor::from_default();
        let first_id = editor.document.block_ids()[0];

        // Add second paragraph
        editor.execute(Command::InsertParagraphAfter {
            selector: Selector::NodeId(first_id),
            content: Some(Paragraph::with_text("To delete")),
        });
        assert_eq!(editor.document.sections[0].blocks.len(), 2);

        let second_id = editor.document.sections[0].blocks[1].id();
        let result = editor.execute(Command::DeleteParagraph {
            selector: Selector::NodeId(second_id),
        });

        assert!(result.success);
        assert_eq!(editor.document.sections[0].blocks.len(), 1);
    }

    #[test]
    fn test_cannot_delete_last_block() {
        let mut editor = DocumentEditor::from_default();
        let only_id = editor.document.block_ids()[0];

        let result = editor.execute(Command::DeleteParagraph {
            selector: Selector::NodeId(only_id),
        });

        assert!(!result.success);
    }

    #[test]
    fn test_insert_table() {
        let mut editor = DocumentEditor::from_default();
        let first_id = editor.document.block_ids()[0];

        let result = editor.execute(Command::InsertTable {
            selector: Selector::NodeId(first_id),
            rows: 3,
            cols: 4,
        });

        assert!(result.success);
        assert_eq!(editor.document.sections[0].blocks.len(), 2);

        if let Block::Table(t) = &editor.document.sections[0].blocks[1] {
            assert_eq!(t.rows.len(), 3);
            assert_eq!(t.rows[0].cells.len(), 4);
            assert_eq!(t.column_widths.len(), 4);
        } else {
            panic!("expected Table");
        }
    }

    #[test]
    fn test_apply_paragraph_style() {
        let mut editor = DocumentEditor::from_default();
        let para_id = editor.document.block_ids()[0];

        let mut style = ParagraphStyle::default();
        style.align = TextAlign::Center;
        style.first_line_indent = 2.0;

        let result = editor.execute(Command::ApplyParagraphStyle {
            selector: Selector::NodeId(para_id),
            style: style.clone(),
        });

        assert!(result.success);
        if let Block::Paragraph(p) = &editor.document.sections[0].blocks[0] {
            assert_eq!(p.style.align, TextAlign::Center);
            assert_eq!(p.style.first_line_indent, 2.0);
        }
    }

    #[test]
    fn test_apply_and_clear_text_style_in_range() {
        let mut editor = DocumentEditor::from_default();
        let para = Paragraph::with_text("Hello");
        let para_id = para.id;
        editor.document.sections[0].blocks[0] = Block::Paragraph(para);

        let mut style = TextStyle::default();
        style.bold = true;
        style.color = "#ff0000".into();

        let result = editor.execute(Command::ApplyTextStyle {
            selector: Selector::TextRange {
                node_id: para_id,
                start: 1,
                end: 4,
            },
            style,
        });
        assert!(result.success);

        let result = editor.execute(Command::ClearTextStyle {
            selector: Selector::TextRange {
                node_id: para_id,
                start: 2,
                end: 3,
            },
        });
        assert!(result.success);

        if let Block::Paragraph(p) = &editor.document.sections[0].blocks[0] {
            assert_eq!(p.runs.len(), 5);
            assert!(matches!(&p.runs[1], Inline::TextRun(TextRun { style, .. }) if style.bold));
            assert!(matches!(&p.runs[2], Inline::TextRun(TextRun { style, .. }) if !style.bold));
            assert!(matches!(&p.runs[3], Inline::TextRun(TextRun { style, .. }) if style.bold));
        }
    }

    #[test]
    fn test_toggle_list() {
        let mut editor = DocumentEditor::from_default();
        let para_id = editor.document.block_ids()[0];

        let result = editor.execute(Command::ToggleList {
            selector: Selector::NodeId(para_id),
            list_type: ListType::Bullet,
        });
        assert!(result.success);

        if let Block::Paragraph(p) = &editor.document.sections[0].blocks[0] {
            assert_eq!(p.style.list_type, Some(ListType::Bullet));
        }

        let result = editor.execute(Command::ToggleList {
            selector: Selector::NodeId(para_id),
            list_type: ListType::Bullet,
        });
        assert!(result.success);

        if let Block::Paragraph(p) = &editor.document.sections[0].blocks[0] {
            assert_eq!(p.style.list_type, None);
            assert_eq!(p.style.list_level, 0);
        }
    }

    #[test]
    fn test_split_and_merge_paragraph() {
        let mut editor = DocumentEditor::from_default();
        let para = Paragraph::with_text("HelloWorld");
        let para_id = para.id;
        editor.document.sections[0].blocks[0] = Block::Paragraph(para);

        let result = editor.execute(Command::SplitParagraph {
            selector: Selector::TextRange {
                node_id: para_id,
                start: 5,
                end: 5,
            },
        });
        assert!(result.success);
        assert_eq!(editor.document.sections[0].blocks.len(), 2);

        if let Block::Paragraph(p) = &editor.document.sections[0].blocks[0] {
            assert_eq!(p.plain_text(), "Hello");
        }
        if let Block::Paragraph(p) = &editor.document.sections[0].blocks[1] {
            assert_eq!(p.plain_text(), "World");
        }

        let result = editor.execute(Command::MergeParagraphWithNext {
            selector: Selector::NodeId(para_id),
        });
        assert!(result.success);
        assert_eq!(editor.document.sections[0].blocks.len(), 1);
        if let Block::Paragraph(p) = &editor.document.sections[0].blocks[0] {
            assert_eq!(p.plain_text(), "HelloWorld");
        }
    }

    #[test]
    fn test_dry_run() {
        let editor = DocumentEditor::from_default();
        let para_id = editor.document.block_ids()[0];

        let result = editor.dry_run(&Command::InsertParagraphAfter {
            selector: Selector::NodeId(para_id),
            content: None,
        });

        assert!(result.success);
        // Document unchanged
        assert_eq!(editor.document.sections[0].blocks.len(), 1);
    }

    #[test]
    fn test_dry_run_invalid_selector() {
        let editor = DocumentEditor::from_default();
        let fake_id = Uuid::new_v4();

        let result = editor.dry_run(&Command::DeleteParagraph {
            selector: Selector::NodeId(fake_id),
        });

        assert!(!result.success);
    }

    #[test]
    fn test_serialization_roundtrip() {
        let mut doc = Document::new();
        let para = Paragraph::with_text("Test document");
        doc.sections[0].blocks = vec![Block::Paragraph(para)];

        let json = serde_json::to_string_pretty(&doc).unwrap();
        let restored: Document = serde_json::from_str(&json).unwrap();

        assert_eq!(doc.id, restored.id);
        assert_eq!(
            doc.sections[0].blocks.len(),
            restored.sections[0].blocks.len()
        );
        if let (Block::Paragraph(a), Block::Paragraph(b)) = (
            &doc.sections[0].blocks[0],
            &restored.sections[0].blocks[0],
        ) {
            assert_eq!(a.plain_text(), b.plain_text());
        }
    }

    #[test]
    fn test_batch_command() {
        let mut editor = DocumentEditor::from_default();
        let first_id = editor.document.block_ids()[0];

        let result = editor.execute(Command::BatchCommand {
            commands: vec![
                Command::InsertParagraphAfter {
                    selector: Selector::NodeId(first_id),
                    content: Some(Paragraph::with_text("Para 2")),
                },
                Command::InsertHorizontalRule {
                    selector: Selector::NodeId(first_id),
                },
            ],
        });

        assert!(result.success);
        // first_id block + HR + Para 2
        assert_eq!(editor.document.sections[0].blocks.len(), 3);

        // Single undo should revert the whole batch
        editor.undo().unwrap();
        assert_eq!(editor.document.sections[0].blocks.len(), 1);
    }

    #[test]
    fn test_insert_code_block() {
        let mut editor = DocumentEditor::from_default();
        let first_id = editor.document.block_ids()[0];

        let result = editor.execute(Command::InsertCodeBlock {
            selector: Selector::NodeId(first_id),
            code: "fn main() {}".into(),
            language: "rust".into(),
        });

        assert!(result.success);
        if let Block::CodeBlock(cb) = &editor.document.sections[0].blocks[1] {
            assert_eq!(cb.code, "fn main() {}");
            assert_eq!(cb.language, "rust");
        } else {
            panic!("expected CodeBlock");
        }
    }

    #[test]
    fn test_insert_image_block() {
        let mut editor = DocumentEditor::from_default();
        let first_id = editor.document.block_ids()[0];

        let result = editor.execute(Command::InsertImageBlock {
            selector: Selector::NodeId(first_id),
            asset_id: "asset-1".into(),
            alt: "preview".into(),
            width: Some(120.0),
            height: Some(80.0),
        });

        assert!(result.success);
        if let Block::ImageBlock(image) = &editor.document.sections[0].blocks[1] {
            assert_eq!(image.asset_id, "asset-1");
            assert_eq!(image.alt, "preview");
        } else {
            panic!("expected ImageBlock");
        }
    }

    #[test]
    fn test_table_row_column_and_cell_commands() {
        let mut editor = DocumentEditor::from_default();
        let first_id = editor.document.block_ids()[0];
        editor.execute(Command::InsertTable {
            selector: Selector::NodeId(first_id),
            rows: 2,
            cols: 2,
        });
        let table_id = editor.document.sections[0].blocks[1].id();

        let result = editor.execute(Command::InsertTableRowAfter {
            selector: Selector::TableCell {
                table_id,
                row: 0,
                col: 0,
            },
        });
        assert!(result.success);

        let result = editor.execute(Command::InsertTableColumnBefore {
            selector: Selector::TableCell {
                table_id,
                row: 0,
                col: 1,
            },
        });
        assert!(result.success);

        let blocks = vec![Block::Paragraph(Paragraph::with_text("Cell"))];
        let result = editor.execute(Command::SetTableCellContent {
            selector: Selector::TableCell {
                table_id,
                row: 1,
                col: 1,
            },
            blocks,
        });
        assert!(result.success);

        let result = editor.execute(Command::DeleteTableColumn {
            selector: Selector::TableCell {
                table_id,
                row: 0,
                col: 0,
            },
        });
        assert!(result.success);

        let result = editor.execute(Command::DeleteTableRow {
            selector: Selector::TableCell {
                table_id,
                row: 0,
                col: 0,
            },
        });
        assert!(result.success);

        if let Block::Table(table) = &editor.document.sections[0].blocks[1] {
            assert_eq!(table.rows.len(), 2);
            assert_eq!(table.column_widths.len(), 2);
            if let Block::Paragraph(p) = &table.rows[0].cells[0].blocks[0] {
                assert_eq!(p.plain_text(), "Cell");
            } else {
                panic!("expected Paragraph in cell");
            }
        } else {
            panic!("expected Table");
        }
    }

    #[test]
    fn test_set_page_config() {
        let mut editor = DocumentEditor::from_default();
        let config = PageConfig {
            width: 612.0,
            height: 792.0,  // US Letter
            margin_top: 72.0,
            margin_bottom: 72.0,
            margin_left: 72.0,
            margin_right: 72.0,
        };

        let result = editor.execute(Command::SetPageConfig {
            section_index: 0,
            config: config.clone(),
        });

        assert!(result.success);
        assert_eq!(editor.document.sections[0].page_config.width, 612.0);
        assert_eq!(editor.document.sections[0].page_config.height, 792.0);
    }

    #[test]
    fn test_selector_validation() {
        let doc = Document::new();
        let para_id = doc.sections[0].blocks[0].id();

        // Valid NodeId
        assert!(Selector::NodeId(para_id).validate(&doc).is_ok());

        // Invalid NodeId
        assert!(Selector::NodeId(Uuid::new_v4()).validate(&doc).is_err());

        // Valid TextRange
        assert!(Selector::TextRange {
            node_id: para_id,
            start: 0,
            end: 0,
        }
        .validate(&doc)
        .is_ok());

        // Invalid TextRange (out of bounds)
        assert!(Selector::TextRange {
            node_id: para_id,
            start: 0,
            end: 100,
        }
        .validate(&doc)
        .is_err());
    }
}
