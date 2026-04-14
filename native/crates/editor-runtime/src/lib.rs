use document_core::{Block, CodeBlock, Document, DocumentEditor, HorizontalRule, Paragraph, Selector, Table};
use layout_engine::layout_document;
use renderer_skia::render_layout;

pub struct EditorRuntime {
    editor: DocumentEditor,
}

impl EditorRuntime {
    pub fn new() -> Self {
        Self::from_document(Self::default_document())
    }

    pub fn from_document(document: Document) -> Self {
        Self {
            editor: DocumentEditor::new(document),
        }
    }

    pub fn default_document() -> Document {
        let mut document = Document::new();
        document.metadata.title = Some("原生工作区".to_string());
        document.sections[0].blocks = vec![
            Block::Paragraph(Paragraph::with_text("openwps 原生版已接入文档模型、命令系统、撤销重做、原生存储与窗口渲染。")),
            Block::HorizontalRule(HorizontalRule::new()),
            Block::Paragraph(Paragraph::with_text("当前界面已经不再是空白壳，页面区会显示原生布局预览，左侧会展示已完成能力状态。")),
            Block::Table(Table::new(3, 3, 120.0)),
            Block::CodeBlock(CodeBlock::new(
                "document-core -> native-storage -> app-shell\nlayout-engine -> renderer-skia",
                "text",
            )),
        ];
        document
    }

    pub fn document(&self) -> &Document {
        &self.editor.document
    }

    pub fn render_frame(&self, viewport_width: u32, viewport_height: u32) -> Vec<u32> {
        let layout = layout_document(&self.editor.document, viewport_width, viewport_height);
        render_layout(&layout)
    }

    pub fn window_title(&self) -> String {
        let title = self
            .editor
            .document
            .metadata
            .title
            .as_deref()
            .unwrap_or("未命名文档");
        format!("openwps 原生版 V2 - {title}")
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
            "章节={} 块={} 修订={} 首段=\"{}\"",
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
        assert!(runtime.window_title().starts_with("openwps 原生版 V2"));
        assert!(runtime.status_line().contains("章节=1"));
    }

    #[test]
    fn creates_runtime_from_external_document() {
        let mut document = EditorRuntime::default_document();
        document.metadata.title = Some("Recovered".to_string());

        let runtime = EditorRuntime::from_document(document);
        assert!(runtime.window_title().contains("Recovered"));
        assert!(runtime.document().metadata.title.as_deref() == Some("Recovered"));
    }

    #[test]
    fn renders_non_empty_frame() {
        let runtime = EditorRuntime::new();
        let frame = runtime.render_frame(900, 700);

        assert_eq!(frame.len(), 900 * 700);
        assert!(frame.iter().any(|pixel| *pixel != 0));
    }
}
