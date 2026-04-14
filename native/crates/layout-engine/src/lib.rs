use document_core::{Block, Document};

#[derive(Debug, Clone, PartialEq)]
pub struct LayoutDocument {
    pub viewport_width: u32,
    pub viewport_height: u32,
    pub pages: Vec<PageLayout>,
    pub status: LayoutStatus,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LayoutStatus {
    pub page_count: usize,
    pub block_count: usize,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PageLayout {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub content: Vec<LayoutPrimitive>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum LayoutPrimitive {
    TextLine(RectPrimitive),
    Heading(RectPrimitive),
    Table(RectPrimitive),
    RichBlock(RectPrimitive),
    Divider(RectPrimitive),
}

#[derive(Debug, Clone, PartialEq)]
pub struct RectPrimitive {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

pub fn layout_document(document: &Document, viewport_width: u32, viewport_height: u32) -> LayoutDocument {
    let section = &document.sections[0];
    let page = &section.page_config;
    let viewport_width_f = viewport_width.max(1) as f32;
    let viewport_height_f = viewport_height.max(1) as f32;
    let scale_x = (viewport_width_f - 96.0).max(320.0) / page.width as f32;
    let scale_y = (viewport_height_f - 96.0).max(420.0) / page.height as f32;
    let scale = scale_x.min(scale_y).min(1.85);

    let page_width = page.width as f32 * scale;
    let page_height = page.height as f32 * scale;
    let page_x = ((viewport_width_f - page_width) / 2.0).max(24.0);
    let page_y = 28.0;
    let content_x = page_x + page.margin_left as f32 * scale;
    let content_width = (page.content_width() as f32 * scale).max(120.0);
    let mut cursor_y = page_y + page.margin_top as f32 * scale;
    let mut content = Vec::new();

    for block in &section.blocks {
        match block {
            Block::Paragraph(paragraph) => {
                let text = paragraph.plain_text();
                let max_chars = ((content_width / 9.2).floor() as usize).max(8);
                let lines = split_preview_lines(&text, max_chars).max(1);
                let first_ratio = first_line_ratio(&text, max_chars);

                for line_index in 0..lines {
                    let width_ratio = if line_index == 0 { first_ratio } else { line_ratio(&text, max_chars, line_index) };
                    let rect = RectPrimitive {
                        x: content_x,
                        y: cursor_y,
                        width: (content_width * width_ratio).max(72.0),
                        height: if line_index == 0 { 10.0 } else { 8.0 },
                    };
                    content.push(if line_index == 0 {
                        LayoutPrimitive::Heading(rect)
                    } else {
                        LayoutPrimitive::TextLine(rect)
                    });
                    cursor_y += 18.0;
                }
                cursor_y += 12.0;
            }
            Block::HorizontalRule(_) => {
                content.push(LayoutPrimitive::Divider(RectPrimitive {
                    x: content_x,
                    y: cursor_y,
                    width: content_width,
                    height: 2.0,
                }));
                cursor_y += 18.0;
            }
            Block::Table(table) => {
                let rows = table.rows.len().max(1) as f32;
                content.push(LayoutPrimitive::Table(RectPrimitive {
                    x: content_x,
                    y: cursor_y,
                    width: content_width,
                    height: 32.0 + rows * 24.0,
                }));
                cursor_y += 32.0 + rows * 24.0 + 14.0;
            }
            Block::CodeBlock(_) | Block::FormulaBlock(_) | Block::MermaidBlock(_) | Block::ImageBlock(_) | Block::PageBreak(_) => {
                content.push(LayoutPrimitive::RichBlock(RectPrimitive {
                    x: content_x,
                    y: cursor_y,
                    width: content_width,
                    height: 88.0,
                }));
                cursor_y += 102.0;
            }
        }
    }

    LayoutDocument {
        viewport_width,
        viewport_height,
        pages: vec![PageLayout {
            x: page_x,
            y: page_y,
            width: page_width,
            height: page_height,
            content,
        }],
        status: LayoutStatus {
            page_count: 1,
            block_count: section.blocks.len(),
            revision: document.revision_counter,
        },
    }
}

fn split_preview_lines(text: &str, max_chars: usize) -> usize {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 1;
    }
    let char_count = trimmed.chars().count();
    char_count.div_ceil(max_chars).max(1)
}

fn first_line_ratio(text: &str, max_chars: usize) -> f32 {
    let length = text.trim().chars().count().min(max_chars) as f32;
    ((length / max_chars as f32) * 0.82).clamp(0.28, 0.96)
}

fn line_ratio(text: &str, max_chars: usize, line_index: usize) -> f32 {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0.34;
    }
    let start = line_index * max_chars;
    let remaining = trimmed.chars().count().saturating_sub(start);
    let chars_on_line = remaining.min(max_chars) as f32;
    ((chars_on_line / max_chars as f32) * 0.9).clamp(0.22, 0.94)
}

#[cfg(test)]
mod tests {
    use super::*;
    use document_core::Document;

    #[test]
    fn produces_page_preview_layout() {
        let document = Document::new();
        let layout = layout_document(&document, 1280, 900);

        assert_eq!(layout.pages.len(), 1);
        assert_eq!(layout.status.page_count, 1);
        assert_eq!(layout.status.block_count, 1);
        assert!(!layout.pages[0].content.is_empty());
    }
}
