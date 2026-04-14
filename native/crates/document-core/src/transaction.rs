use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ast::*;
use crate::selector::Selector;

/// A transaction records one atomic change to the document.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transaction {
    pub transaction_id: Uuid,
    pub revision: u64,
    pub command_name: String,
    pub input_selectors: Vec<Selector>,
    pub changed_node_ids: Vec<Uuid>,
    pub selection_before: Option<LogicalSelection>,
    pub selection_after: Option<LogicalSelection>,
    pub undo_payload: UndoPayload,
    pub redo_payload: RedoPayload,
}

/// Payload to reverse a transaction.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum UndoPayload {
    /// Restore entire document snapshot (used for complex operations).
    FullSnapshot(Box<Document>),
    /// Restore specific blocks that were changed.
    BlockRestore {
        /// (section_index, block_index, old_block)
        blocks: Vec<(usize, usize, Block)>,
    },
    /// Restore blocks that were deleted.
    BlockInsert {
        section_index: usize,
        block_index: usize,
        blocks: Vec<Block>,
    },
    /// Remove blocks that were inserted.
    BlockRemove {
        node_ids: Vec<Uuid>,
    },
}

/// Payload to re-apply a transaction.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RedoPayload {
    FullSnapshot(Box<Document>),
    BlockRestore {
        blocks: Vec<(usize, usize, Block)>,
    },
    BlockInsert {
        section_index: usize,
        block_index: usize,
        blocks: Vec<Block>,
    },
    BlockRemove {
        node_ids: Vec<Uuid>,
    },
}

/// Result of a command execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub changed_node_ids: Vec<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transaction_id: Option<Uuid>,
}

impl CommandResult {
    pub fn ok(changed: Vec<Uuid>, tx_id: Uuid) -> Self {
        Self {
            success: true,
            message: None,
            changed_node_ids: changed,
            transaction_id: Some(tx_id),
        }
    }

    pub fn err(msg: impl Into<String>) -> Self {
        Self {
            success: false,
            message: Some(msg.into()),
            changed_node_ids: Vec::new(),
            transaction_id: None,
        }
    }
}
