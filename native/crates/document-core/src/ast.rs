use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::style::*;

// ── Document ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Document {
    pub id: Uuid,
    pub version: u32,
    pub metadata: DocumentMetadata,
    pub sections: Vec<Section>,
    pub document_styles: DocumentStyles,
    #[serde(default)]
    pub assets_index: Vec<Asset>,
    pub revision_counter: u64,
}

impl Document {
    pub fn new() -> Self {
        Self {
            id: Uuid::new_v4(),
            version: 1,
            metadata: DocumentMetadata::default(),
            sections: vec![Section::new()],
            document_styles: DocumentStyles::default(),
            assets_index: Vec::new(),
            revision_counter: 0,
        }
    }

    /// Find a block by ID across all sections. Returns (section_index, block_index).
    pub fn find_block(&self, id: Uuid) -> Option<(usize, usize)> {
        for (si, section) in self.sections.iter().enumerate() {
            for (bi, block) in section.blocks.iter().enumerate() {
                if block.id() == id {
                    return Some((si, bi));
                }
            }
        }
        None
    }

    /// Find a block mutably by ID. Returns (section_index, block_index).
    pub fn find_block_mut(&mut self, id: Uuid) -> Option<&mut Block> {
        for section in &mut self.sections {
            for block in &mut section.blocks {
                if block.id() == id {
                    return Some(block);
                }
            }
        }
        None
    }

    /// Get all block IDs in document order.
    pub fn block_ids(&self) -> Vec<Uuid> {
        self.sections
            .iter()
            .flat_map(|s| s.blocks.iter().map(|b| b.id()))
            .collect()
    }

    /// Increment revision counter and return the new value.
    pub fn next_revision(&mut self) -> u64 {
        self.revision_counter += 1;
        self.revision_counter
    }
}

impl Default for Document {
    fn default() -> Self {
        Self::new()
    }
}

// ── DocumentMetadata ────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DocumentMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<String>,
}

// ── Section ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Section {
    pub id: Uuid,
    pub page_config: PageConfig,
    pub blocks: Vec<Block>,
}

impl Section {
    pub fn new() -> Self {
        Self {
            id: Uuid::new_v4(),
            page_config: PageConfig::default(),
            blocks: vec![Block::Paragraph(Paragraph::new())],
        }
    }
}

impl Default for Section {
    fn default() -> Self {
        Self::new()
    }
}

// ── PageConfig ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PageConfig {
    /// Page width in pt (A4: 595.28)
    pub width: f64,
    /// Page height in pt (A4: 841.89)
    pub height: f64,
    pub margin_top: f64,
    pub margin_bottom: f64,
    pub margin_left: f64,
    pub margin_right: f64,
}

impl Default for PageConfig {
    fn default() -> Self {
        Self {
            width: 595.28,
            height: 841.89,
            margin_top: 72.0,
            margin_bottom: 72.0,
            margin_left: 90.0,
            margin_right: 90.0,
        }
    }
}

impl PageConfig {
    /// Content area width
    pub fn content_width(&self) -> f64 {
        self.width - self.margin_left - self.margin_right
    }

    /// Content area height
    pub fn content_height(&self) -> f64 {
        self.height - self.margin_top - self.margin_bottom
    }
}

// ── Block ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Block {
    Paragraph(Paragraph),
    Table(Table),
    HorizontalRule(HorizontalRule),
    PageBreak(PageBreak),
    CodeBlock(CodeBlock),
    FormulaBlock(FormulaBlock),
    MermaidBlock(MermaidBlock),
    ImageBlock(ImageBlock),
}

impl Block {
    pub fn id(&self) -> Uuid {
        match self {
            Self::Paragraph(p) => p.id,
            Self::Table(t) => t.id,
            Self::HorizontalRule(hr) => hr.id,
            Self::PageBreak(pb) => pb.id,
            Self::CodeBlock(cb) => cb.id,
            Self::FormulaBlock(fb) => fb.id,
            Self::MermaidBlock(mb) => mb.id,
            Self::ImageBlock(ib) => ib.id,
        }
    }
}

// ── Paragraph ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Paragraph {
    pub id: Uuid,
    pub runs: Vec<Inline>,
    pub style: ParagraphStyle,
}

impl Paragraph {
    pub fn new() -> Self {
        Self {
            id: Uuid::new_v4(),
            runs: Vec::new(),
            style: ParagraphStyle::default(),
        }
    }

    pub fn with_text(text: &str) -> Self {
        Self {
            id: Uuid::new_v4(),
            runs: vec![Inline::TextRun(TextRun {
                text: text.to_string(),
                style: TextStyle::default(),
            })],
            style: ParagraphStyle::default(),
        }
    }

    /// Get the full plain text of this paragraph.
    pub fn plain_text(&self) -> String {
        let mut result = String::new();
        for run in &self.runs {
            match run {
                Inline::TextRun(tr) => result.push_str(&tr.text),
                Inline::SoftBreak => result.push('\n'),
                Inline::InlineCode(ic) => result.push_str(&ic.code),
                Inline::LinkSpan(ls) => {
                    for child in &ls.children {
                        if let Inline::TextRun(tr) = child {
                            result.push_str(&tr.text);
                        }
                    }
                }
                Inline::ImageSpan(_) => result.push('\u{FFFC}'),
            }
        }
        result
    }
}

impl Default for Paragraph {
    fn default() -> Self {
        Self::new()
    }
}

// ── Table ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Table {
    pub id: Uuid,
    pub rows: Vec<TableRow>,
    pub column_widths: Vec<f64>,
    pub width_policy: TableWidthPolicy,
    pub borders: Borders,
    pub cell_padding: f64,
    pub spacing_before: f64,
    pub spacing_after: f64,
}

impl Table {
    pub fn new(num_rows: usize, num_cols: usize, col_width: f64) -> Self {
        let rows = (0..num_rows)
            .map(|_| TableRow::new(num_cols))
            .collect();
        Self {
            id: Uuid::new_v4(),
            rows,
            column_widths: vec![col_width; num_cols],
            width_policy: TableWidthPolicy::Auto,
            borders: Borders::default(),
            cell_padding: 4.0,
            spacing_before: 8.0,
            spacing_after: 8.0,
        }
    }
}

// ── TableRow ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableRow {
    pub id: Uuid,
    pub cells: Vec<TableCell>,
    pub min_height: f64,
}

impl TableRow {
    pub fn new(num_cols: usize) -> Self {
        let cells = (0..num_cols).map(|_| TableCell::new()).collect();
        Self {
            id: Uuid::new_v4(),
            cells,
            min_height: 0.0,
        }
    }
}

// ── TableCell ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableCell {
    pub id: Uuid,
    pub blocks: Vec<Block>,
    pub colspan: u32,
    pub rowspan: u32,
    pub vertical_align: VerticalAlign,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub borders: Option<Borders>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub padding: Option<f64>,
}

impl TableCell {
    pub fn new() -> Self {
        Self {
            id: Uuid::new_v4(),
            blocks: vec![Block::Paragraph(Paragraph::new())],
            colspan: 1,
            rowspan: 1,
            vertical_align: VerticalAlign::Top,
            background_color: None,
            borders: None,
            padding: None,
        }
    }
}

impl Default for TableCell {
    fn default() -> Self {
        Self::new()
    }
}

// ── Simple blocks ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HorizontalRule {
    pub id: Uuid,
}

impl HorizontalRule {
    pub fn new() -> Self {
        Self { id: Uuid::new_v4() }
    }
}

impl Default for HorizontalRule {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageBreak {
    pub id: Uuid,
}

impl PageBreak {
    pub fn new() -> Self {
        Self { id: Uuid::new_v4() }
    }
}

impl Default for PageBreak {
    fn default() -> Self {
        Self::new()
    }
}

// ── Rich blocks ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeBlock {
    pub id: Uuid,
    pub code: String,
    pub language: String,
}

impl CodeBlock {
    pub fn new(code: &str, language: &str) -> Self {
        Self {
            id: Uuid::new_v4(),
            code: code.to_string(),
            language: language.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormulaBlock {
    pub id: Uuid,
    pub latex_source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rendered_cache_key: Option<String>,
}

impl FormulaBlock {
    pub fn new(latex: &str) -> Self {
        Self {
            id: Uuid::new_v4(),
            latex_source: latex.to_string(),
            rendered_cache_key: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MermaidBlock {
    pub id: Uuid,
    pub mermaid_source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rendered_cache_key: Option<String>,
}

impl MermaidBlock {
    pub fn new(source: &str) -> Self {
        Self {
            id: Uuid::new_v4(),
            mermaid_source: source.to_string(),
            rendered_cache_key: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageBlock {
    pub id: Uuid,
    pub asset_id: String,
    pub alt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
}

// ── Inline ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Inline {
    TextRun(TextRun),
    ImageSpan(ImageSpan),
    SoftBreak,
    InlineCode(InlineCode),
    LinkSpan(LinkSpan),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextRun {
    pub text: String,
    pub style: TextStyle,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageSpan {
    pub asset_id: String,
    pub alt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InlineCode {
    pub code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkSpan {
    pub children: Vec<Inline>,
    pub href: String,
}

// ── Asset ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Asset {
    pub id: String,
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
}

// ── Selection ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum LogicalSelection {
    Collapsed(CaretPosition),
    Range {
        anchor: CaretPosition,
        focus: CaretPosition,
    },
    BlockSelection(Vec<Uuid>),
    TableCellSelection {
        table_id: Uuid,
        cells: Vec<(usize, usize)>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaretPosition {
    pub block_id: Uuid,
    pub run_index: usize,
    pub offset: usize,
}
