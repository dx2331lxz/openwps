use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ast::*;
use crate::error::DocumentError;

/// Stable cross-transaction selector for command input.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Selector {
    /// Select a block by its stable UUID.
    NodeId(Uuid),

    /// Select a text range within a paragraph.
    TextRange {
        node_id: Uuid,
        /// UTF-8 byte offset start (inclusive).
        start: usize,
        /// UTF-8 byte offset end (exclusive).
        end: usize,
    },

    /// Specify an insert position relative to existing nodes.
    StructuralInsert(StructuralInsertSelector),

    /// Select a table cell.
    TableCell {
        table_id: Uuid,
        row: usize,
        col: usize,
    },

    /// Use the current logical selection.
    CurrentSelection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructuralInsertSelector {
    pub before_node_id: Option<Uuid>,
    pub after_node_id: Option<Uuid>,
    pub parent_id: Uuid,
}

// ── Selector resolution ─────────────────────────────────────────────────

impl Selector {
    /// Validate that this selector can be resolved against the document.
    pub fn validate(&self, doc: &Document) -> Result<(), DocumentError> {
        match self {
            Selector::NodeId(id) => {
                doc.find_block(*id)
                    .ok_or(DocumentError::NodeNotFound(*id))?;
                Ok(())
            }
            Selector::TextRange { node_id, start, end } => {
                let (si, bi) = doc
                    .find_block(*node_id)
                    .ok_or(DocumentError::NodeNotFound(*node_id))?;
                let block = &doc.sections[si].blocks[bi];
                match block {
                    Block::Paragraph(p) => {
                        let text = p.plain_text();
                        let len = text.len();
                        if *start > len || *end > len || start > end {
                            return Err(DocumentError::TextRangeOutOfBounds {
                                node_id: *node_id,
                                start: *start,
                                end: *end,
                                length: len,
                            });
                        }
                        Ok(())
                    }
                    _ => Err(DocumentError::TypeMismatch {
                        expected: "Paragraph".into(),
                        found: format!("{:?}", std::mem::discriminant(block)),
                    }),
                }
            }
            Selector::StructuralInsert(sel) => {
                // Validate parent exists as a section
                let parent_found = doc.sections.iter().any(|s| s.id == sel.parent_id);
                if !parent_found {
                    return Err(DocumentError::InvalidSelector(format!(
                        "parent section {} not found",
                        sel.parent_id
                    )));
                }
                if let Some(before) = sel.before_node_id {
                    doc.find_block(before)
                        .ok_or(DocumentError::NodeNotFound(before))?;
                }
                if let Some(after) = sel.after_node_id {
                    doc.find_block(after)
                        .ok_or(DocumentError::NodeNotFound(after))?;
                }
                Ok(())
            }
            Selector::TableCell {
                table_id,
                row,
                col,
            } => {
                let (si, bi) = doc
                    .find_block(*table_id)
                    .ok_or(DocumentError::NodeNotFound(*table_id))?;
                match &doc.sections[si].blocks[bi] {
                    Block::Table(t) => {
                        if *row >= t.rows.len() {
                            return Err(DocumentError::InvalidSelector(format!(
                                "row {} out of range ({})",
                                row,
                                t.rows.len()
                            )));
                        }
                        if *col >= t.rows[*row].cells.len() {
                            return Err(DocumentError::InvalidSelector(format!(
                                "col {} out of range ({})",
                                col,
                                t.rows[*row].cells.len()
                            )));
                        }
                        Ok(())
                    }
                    _ => Err(DocumentError::TypeMismatch {
                        expected: "Table".into(),
                        found: "non-table block".into(),
                    }),
                }
            }
            Selector::CurrentSelection => Ok(()),
        }
    }
}
