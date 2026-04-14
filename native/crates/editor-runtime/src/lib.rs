use document_core::{Document, DocumentEditor, Paragraph, Selector};

pub struct EditorRuntime {
    editor: DocumentEditor,
}

impl EditorRuntime {
    pub fn new() -> Self {
        let mut document = Document::new();
        if let Some(document_core::Block::Paragraph(paragraph)) = document.sections[0].blocks.first_mut() {
            *paragraph = Paragraph::with_text("openwps Native V2 已启动。下一步接入 layout-engine 与 renderer-skia。")
        }

        Self {
            editor: DocumentEditor::new(document),
        }
    }

    pub fn window_title(&self) -> String {
        let title = self
            .editor
            .document
            .metadata
            .title
            .as_deref()
            .unwrap_or("Untitled");
        format!("openwps Native V2 - {title}")
    }

    pub fn status_line(&self) -> String {
        let first_block_id = self.editor.document.block_ids().first().copied();
        let first_paragraph = first_block_id
            .and_then(|block_id| self.editor.document.find_block(block_id))
            .and_then(|(section_index, block_index)| self.editor.document.sections.get(section_index)?.blocks.get(block_index))
            .and_then(|block| match block {
                document_core::Block::Paragraph(paragraph) => Some(paragraph.plain_text()),
                _ => None,
            })
            .unwrap_or_else(|| "文档为空".to_string());

        format!(
            "sections={} blocks={} revision={} first=\"{}\"",
            self.editor.document.sections.len(),
            self.editor.document.block_ids().len(),
            self.editor.document.revision_counter,
            first_paragraph
        )
    }

    pub fn bootstrap_selection(&mut self) {
        if let Some(block_id) = self.editor.document.block_ids().first().copied() {
            self.editor.selection = Some(document_core::LogicalSelection::Collapsed(document_core::CaretPosition {
                block_id,
                run_index: 0,
                offset: 0,
            }));
            let _ = Selector::NodeId(block_id).validate(&self.editor.document);
        }
    }
}

impl Default for EditorRuntime {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_default_runtime() {
        let runtime = EditorRuntime::new();
        assert!(runtime.window_title().starts_with("openwps Native V2"));
        assert!(runtime.status_line().contains("sections=1"));
    }
}
