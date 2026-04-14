use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum DocumentError {
    #[error("node not found: {0}")]
    NodeNotFound(Uuid),

    #[error("invalid selector: {0}")]
    InvalidSelector(String),

    #[error("type mismatch: expected {expected}, found {found}")]
    TypeMismatch { expected: String, found: String },

    #[error("structural constraint violated: {0}")]
    StructuralConstraint(String),

    #[error("text range out of bounds: node {node_id}, range {start}..{end}, length {length}")]
    TextRangeOutOfBounds {
        node_id: Uuid,
        start: usize,
        end: usize,
        length: usize,
    },

    #[error("empty undo stack")]
    EmptyUndoStack,

    #[error("empty redo stack")]
    EmptyRedoStack,

    #[error("serialization error: {0}")]
    Serialization(String),
}
