use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use document_core::{Document, Transaction};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

pub const PACKAGE_EXTENSION: &str = "owps";
pub const DOCUMENT_FILE: &str = "document.json";
pub const METADATA_FILE: &str = "metadata.json";
pub const ASSETS_DIR: &str = "assets";
pub const PREVIEWS_DIR: &str = "previews";
pub const HISTORY_DIR: &str = "history";
pub const TRANSACTION_LOG_FILE: &str = "transactions.jsonl";
pub const AUTOSAVE_FILE: &str = "autosave.json";
pub const PACKAGE_FORMAT_VERSION: u32 = 1;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("invalid package: {0}")]
    InvalidPackage(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackageMetadata {
    pub package_format_version: u32,
    pub document_id: Uuid,
    pub document_version: u32,
    pub revision_counter: u64,
    pub created_at_unix_ms: u128,
    pub modified_at_unix_ms: u128,
}

impl PackageMetadata {
    pub fn from_document(document: &Document) -> Self {
        let now = unix_timestamp_ms();
        Self {
            package_format_version: PACKAGE_FORMAT_VERSION,
            document_id: document.id,
            document_version: document.version,
            revision_counter: document.revision_counter,
            created_at_unix_ms: now,
            modified_at_unix_ms: now,
        }
    }

    pub fn refresh_for_document(&self, document: &Document) -> Self {
        Self {
            package_format_version: self.package_format_version,
            document_id: document.id,
            document_version: document.version,
            revision_counter: document.revision_counter,
            created_at_unix_ms: self.created_at_unix_ms,
            modified_at_unix_ms: unix_timestamp_ms(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativePackage {
    pub metadata: PackageMetadata,
    pub document: Document,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransactionLogEntry {
    pub transaction_id: Uuid,
    pub revision: u64,
    pub command_name: String,
    pub changed_node_ids: Vec<Uuid>,
    pub logged_at_unix_ms: u128,
}

impl From<&Transaction> for TransactionLogEntry {
    fn from(transaction: &Transaction) -> Self {
        Self {
            transaction_id: transaction.transaction_id,
            revision: transaction.revision,
            command_name: transaction.command_name.clone(),
            changed_node_ids: transaction.changed_node_ids.clone(),
            logged_at_unix_ms: unix_timestamp_ms(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutosaveSnapshot {
    pub metadata: PackageMetadata,
    pub document: Document,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryBundle {
    pub snapshot: AutosaveSnapshot,
    pub transactions: Vec<TransactionLogEntry>,
}

pub fn save_package(path: impl AsRef<Path>, document: &Document) -> Result<PackageMetadata, StorageError> {
    let metadata = PackageMetadata::from_document(document);
    save_package_with_metadata(path, document, &metadata)
}

pub fn save_package_with_metadata(
    path: impl AsRef<Path>,
    document: &Document,
    metadata: &PackageMetadata,
) -> Result<PackageMetadata, StorageError> {
    let package_root = path.as_ref();
    ensure_package_dirs(package_root)?;

    let refreshed_metadata = metadata.refresh_for_document(document);
    atomic_write_json(&package_root.join(DOCUMENT_FILE), document)?;
    atomic_write_json(&package_root.join(METADATA_FILE), &refreshed_metadata)?;

    Ok(refreshed_metadata)
}

pub fn load_package(path: impl AsRef<Path>) -> Result<NativePackage, StorageError> {
    let package_root = path.as_ref();
    ensure_package_layout_exists(package_root)?;

    let document: Document = read_json(&package_root.join(DOCUMENT_FILE))?;
    let metadata: PackageMetadata = read_json(&package_root.join(METADATA_FILE))?;

    Ok(NativePackage { metadata, document })
}

pub fn append_transaction_log(
    path: impl AsRef<Path>,
    transaction: &Transaction,
) -> Result<(), StorageError> {
    let package_root = path.as_ref();
    ensure_package_dirs(package_root)?;

    let log_path = package_root.join(HISTORY_DIR).join(TRANSACTION_LOG_FILE);
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)?;
    let entry = TransactionLogEntry::from(transaction);
    serde_json::to_writer(&mut file, &entry)?;
    file.write_all(b"\n")?;
    file.flush()?;
    Ok(())
}

pub fn read_transaction_log(path: impl AsRef<Path>) -> Result<Vec<TransactionLogEntry>, StorageError> {
    let log_path = path.as_ref().join(HISTORY_DIR).join(TRANSACTION_LOG_FILE);
    if !log_path.exists() {
        return Ok(Vec::new());
    }

    let file = File::open(log_path)?;
    let reader = BufReader::new(file);
    let mut entries = Vec::new();

    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        entries.push(serde_json::from_str(&line)?);
    }

    Ok(entries)
}

pub fn write_autosave(path: impl AsRef<Path>, document: &Document) -> Result<AutosaveSnapshot, StorageError> {
    let package_root = path.as_ref();
    ensure_package_dirs(package_root)?;

    let base_metadata = load_existing_metadata(package_root)?.unwrap_or_else(|| PackageMetadata::from_document(document));
    let snapshot = AutosaveSnapshot {
        metadata: base_metadata.refresh_for_document(document),
        document: document.clone(),
    };

    atomic_write_json(&package_root.join(HISTORY_DIR).join(AUTOSAVE_FILE), &snapshot)?;
    Ok(snapshot)
}

pub fn recover_from_autosave(path: impl AsRef<Path>) -> Result<Option<RecoveryBundle>, StorageError> {
    let package_root = path.as_ref();
    let autosave_path = package_root.join(HISTORY_DIR).join(AUTOSAVE_FILE);
    if !autosave_path.exists() {
        return Ok(None);
    }

    let snapshot: AutosaveSnapshot = read_json(&autosave_path)?;
    let transactions = read_transaction_log(package_root)?;
    Ok(Some(RecoveryBundle {
        snapshot,
        transactions,
    }))
}

pub fn clear_autosave(path: impl AsRef<Path>) -> Result<(), StorageError> {
    let autosave_path = path.as_ref().join(HISTORY_DIR).join(AUTOSAVE_FILE);
    if autosave_path.exists() {
        fs::remove_file(autosave_path)?;
    }
    Ok(())
}

pub fn package_paths(path: impl AsRef<Path>) -> Vec<PathBuf> {
    let package_root = path.as_ref();
    vec![
        package_root.join(DOCUMENT_FILE),
        package_root.join(METADATA_FILE),
        package_root.join(ASSETS_DIR),
        package_root.join(PREVIEWS_DIR),
        package_root.join(HISTORY_DIR),
        package_root.join(HISTORY_DIR).join(TRANSACTION_LOG_FILE),
        package_root.join(HISTORY_DIR).join(AUTOSAVE_FILE),
    ]
}

fn ensure_package_layout_exists(package_root: &Path) -> Result<(), StorageError> {
    if !package_root.exists() {
        return Err(StorageError::InvalidPackage(format!(
            "package does not exist: {}",
            package_root.display()
        )));
    }

    let document_path = package_root.join(DOCUMENT_FILE);
    let metadata_path = package_root.join(METADATA_FILE);
    if !document_path.exists() || !metadata_path.exists() {
        return Err(StorageError::InvalidPackage(format!(
            "package is missing {} or {}",
            DOCUMENT_FILE, METADATA_FILE
        )));
    }

    Ok(())
}

fn ensure_package_dirs(package_root: &Path) -> Result<(), StorageError> {
    fs::create_dir_all(package_root)?;
    fs::create_dir_all(package_root.join(ASSETS_DIR))?;
    fs::create_dir_all(package_root.join(PREVIEWS_DIR))?;
    fs::create_dir_all(package_root.join(HISTORY_DIR))?;
    Ok(())
}

fn load_existing_metadata(package_root: &Path) -> Result<Option<PackageMetadata>, StorageError> {
    let metadata_path = package_root.join(METADATA_FILE);
    if !metadata_path.exists() {
        return Ok(None);
    }
    Ok(Some(read_json(&metadata_path)?))
}

fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), StorageError> {
    let parent = path.parent().ok_or_else(|| {
        StorageError::InvalidPackage(format!("path has no parent: {}", path.display()))
    })?;
    fs::create_dir_all(parent)?;

    let temp_path = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("package"),
        Uuid::new_v4()
    ));

    {
        let mut file = File::create(&temp_path)?;
        serde_json::to_writer_pretty(&mut file, value)?;
        file.write_all(b"\n")?;
        file.flush()?;
    }

    fs::rename(temp_path, path)?;
    Ok(())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, StorageError> {
    let file = File::open(path)?;
    Ok(serde_json::from_reader(file)?)
}

fn unix_timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use document_core::{LogicalSelection, RedoPayload, Selector, UndoPayload};

    fn test_package_root(name: &str) -> PathBuf {
        std::env::temp_dir()
            .join("openwps-native-storage-tests")
            .join(format!("{}-{}.{}", name, Uuid::new_v4(), PACKAGE_EXTENSION))
    }

    fn test_document(title: &str, text: &str) -> Document {
        let mut document = Document::new();
        document.metadata.title = Some(title.to_string());
        if let Some(document_core::Block::Paragraph(paragraph)) = document.sections[0].blocks.first_mut() {
            *paragraph = document_core::Paragraph::with_text(text);
        }
        document.revision_counter = 7;
        document
    }

    fn sample_transaction(document: &Document) -> Transaction {
        Transaction {
            transaction_id: Uuid::new_v4(),
            revision: document.revision_counter,
            command_name: "InsertText".into(),
            input_selectors: vec![Selector::NodeId(document.sections[0].blocks[0].id())],
            changed_node_ids: vec![document.sections[0].blocks[0].id()],
            selection_before: None,
            selection_after: Some(LogicalSelection::BlockSelection(vec![document.sections[0].blocks[0].id()])),
            undo_payload: UndoPayload::FullSnapshot(Box::new(document.clone())),
            redo_payload: RedoPayload::FullSnapshot(Box::new(document.clone())),
        }
    }

    fn cleanup(path: &Path) {
        if path.exists() {
            let _ = fs::remove_dir_all(path);
        }
    }

    #[test]
    fn saves_and_loads_package_roundtrip() {
        let package_root = test_package_root("roundtrip");
        cleanup(&package_root);

        let document = test_document("Roundtrip", "hello native storage");
        let metadata = save_package(&package_root, &document).unwrap();
        let loaded = load_package(&package_root).unwrap();

        assert_eq!(loaded.document.id, document.id);
        assert_eq!(loaded.document.revision_counter, document.revision_counter);
        assert_eq!(loaded.metadata.document_id, metadata.document_id);
        assert!(package_root.join(ASSETS_DIR).exists());
        assert!(package_root.join(PREVIEWS_DIR).exists());
        assert!(package_root.join(HISTORY_DIR).exists());

        cleanup(&package_root);
    }

    #[test]
    fn writes_transaction_log_entries() {
        let package_root = test_package_root("log");
        cleanup(&package_root);

        let document = test_document("Log", "body");
        save_package(&package_root, &document).unwrap();
        let transaction = sample_transaction(&document);

        append_transaction_log(&package_root, &transaction).unwrap();
        let entries = read_transaction_log(&package_root).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].transaction_id, transaction.transaction_id);
        assert_eq!(entries[0].command_name, "InsertText");

        cleanup(&package_root);
    }

    #[test]
    fn writes_and_recovers_autosave_snapshot() {
        let package_root = test_package_root("autosave");
        cleanup(&package_root);

        let document = test_document("Autosave", "draft v1");
        save_package(&package_root, &document).unwrap();
        let transaction = sample_transaction(&document);
        append_transaction_log(&package_root, &transaction).unwrap();

        let mut changed_document = document.clone();
        changed_document.revision_counter = 8;
        if let Some(document_core::Block::Paragraph(paragraph)) = changed_document.sections[0].blocks.first_mut() {
            *paragraph = document_core::Paragraph::with_text("draft v2");
        }

        let snapshot = write_autosave(&package_root, &changed_document).unwrap();
        let recovered = recover_from_autosave(&package_root).unwrap().unwrap();

        assert_eq!(snapshot.document.revision_counter, 8);
        assert_eq!(recovered.snapshot.document.revision_counter, 8);
        assert_eq!(recovered.transactions.len(), 1);

        clear_autosave(&package_root).unwrap();
        assert!(recover_from_autosave(&package_root).unwrap().is_none());

        cleanup(&package_root);
    }

    #[test]
    fn exposes_expected_package_paths() {
        let package_root = test_package_root("paths");
        let paths = package_paths(&package_root);

        assert!(paths.iter().any(|path| path.ends_with(DOCUMENT_FILE)));
        assert!(paths.iter().any(|path| path.ends_with(METADATA_FILE)));
        assert!(paths.iter().any(|path| path.ends_with(AUTOSAVE_FILE)));
    }
}
