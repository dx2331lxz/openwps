use font8x8::{BASIC_FONTS, UnicodeFonts};
use layout_engine::{LayoutDocument, LayoutPrimitive, RectPrimitive};

pub fn render_layout(layout: &LayoutDocument) -> Vec<u32> {
    let width = layout.viewport_width.max(1) as usize;
    let height = layout.viewport_height.max(1) as usize;
    let mut pixels = vec![rgb(244, 240, 231); width * height];

    draw_app_chrome(&mut pixels, width, height, layout);

    for page in &layout.pages {
        fill_rect(&mut pixels, width, height, page.x + 8.0, page.y + 10.0, page.width, page.height, rgb(213, 203, 183));
        fill_rect(&mut pixels, width, height, page.x, page.y, page.width, page.height, rgb(255, 252, 247));
        stroke_rect(&mut pixels, width, height, page.x, page.y, page.width, page.height, rgb(222, 211, 191), 1.0);

        fill_rect(&mut pixels, width, height, page.x + 34.0, page.y + 34.0, page.width * 0.28, 12.0, rgb(87, 76, 62));
        fill_rect(&mut pixels, width, height, page.x + 34.0, page.y + 60.0, page.width * 0.18, 6.0, rgb(180, 166, 144));

        for primitive in &page.content {
            match primitive {
                LayoutPrimitive::Heading(rect) => fill_rounded_rect(&mut pixels, width, height, rect, rgb(74, 66, 53), 4.0),
                LayoutPrimitive::TextLine(rect) => fill_rounded_rect(&mut pixels, width, height, rect, rgb(150, 141, 129), 3.0),
                LayoutPrimitive::Table(rect) => draw_table_block(&mut pixels, width, height, rect),
                LayoutPrimitive::RichBlock(rect) => draw_rich_block(&mut pixels, width, height, rect),
                LayoutPrimitive::Divider(rect) => fill_rect(&mut pixels, width, height, rect.x, rect.y, rect.width, rect.height, rgb(198, 186, 166)),
            }
        }
    }

    pixels
}

fn draw_app_chrome(pixels: &mut [u32], width: usize, height: usize, layout: &LayoutDocument) {
    fill_rect(pixels, width, height, 0.0, 0.0, width as f32, 86.0, rgb(238, 232, 220));
    fill_rect(pixels, width, height, 0.0, 86.0, 248.0, height as f32 - 86.0, rgb(239, 234, 224));
    stroke_rect(pixels, width, height, 248.0, 86.0, 1.0, height as f32 - 86.0, rgb(220, 210, 191), 1.0);

    fill_rect(pixels, width, height, 26.0, 20.0, 230.0, 32.0, rgb(226, 214, 194));
    fill_rect(pixels, width, height, 40.0, 30.0, 10.0, 10.0, rgb(189, 92, 71));
    fill_rect(pixels, width, height, 60.0, 30.0, 96.0, 8.0, rgb(77, 69, 57));
    fill_rect(pixels, width, height, 164.0, 30.0, 56.0, 8.0, rgb(130, 118, 98));

    draw_metric_chip(pixels, width, height, 286.0, 22.0, 98.0, layout.status.page_count as u32, rgb(204, 225, 208));
    draw_metric_chip(pixels, width, height, 394.0, 22.0, 98.0, layout.status.block_count as u32, rgb(222, 214, 242));
    draw_metric_chip(pixels, width, height, 502.0, 22.0, 116.0, layout.status.revision as u32, rgb(241, 223, 198));

    draw_sidebar_card(pixels, width, height, 24.0, 112.0, rgb(205, 228, 209));
    draw_sidebar_card(pixels, width, height, 24.0, 198.0, rgb(223, 216, 244));
    draw_sidebar_card(pixels, width, height, 24.0, 284.0, rgb(245, 226, 201));
    draw_sidebar_card(pixels, width, height, 24.0, 370.0, rgb(229, 233, 237));

    fill_rect(pixels, width, height, 40.0, 126.0, 12.0, 12.0, rgb(71, 132, 83));
    fill_rect(pixels, width, height, 40.0, 212.0, 12.0, 12.0, rgb(116, 96, 159));
    fill_rect(pixels, width, height, 40.0, 298.0, 12.0, 12.0, rgb(179, 121, 62));
    fill_rect(pixels, width, height, 40.0, 384.0, 12.0, 12.0, rgb(96, 108, 119));

    draw_card_lines(pixels, width, height, 64.0, 122.0, rgb(59, 80, 64));
    draw_card_lines(pixels, width, height, 64.0, 208.0, rgb(74, 63, 101));
    draw_card_lines(pixels, width, height, 64.0, 294.0, rgb(111, 80, 44));
    draw_card_lines(pixels, width, height, 64.0, 380.0, rgb(73, 82, 89));

    draw_text(pixels, width, height, 656, 30, &format!("P{}", layout.status.page_count), rgb(89, 77, 60), 2);
    draw_text(pixels, width, height, 736, 30, &format!("B{}", layout.status.block_count), rgb(89, 77, 60), 2);
}

fn draw_metric_chip(pixels: &mut [u32], width: usize, height: usize, x: f32, y: f32, chip_width: f32, value: u32, color: u32) {
    fill_rect(pixels, width, height, x, y, chip_width, 34.0, color);
    fill_rect(pixels, width, height, x + 14.0, y + 13.0, chip_width * 0.38, 8.0, rgb(84, 74, 60));
    draw_text(pixels, width, height, (x + chip_width - 28.0) as i32, (y + 10.0) as i32, &value.to_string(), rgb(84, 74, 60), 2);
}

fn draw_sidebar_card(pixels: &mut [u32], width: usize, height: usize, x: f32, y: f32, color: u32) {
    fill_rect(pixels, width, height, x, y, 192.0, 68.0, color);
}

fn draw_card_lines(pixels: &mut [u32], width: usize, height: usize, x: f32, y: f32, color: u32) {
    fill_rect(pixels, width, height, x, y, 94.0, 8.0, color);
    fill_rect(pixels, width, height, x, y + 18.0, 132.0, 6.0, color);
    fill_rect(pixels, width, height, x, y + 34.0, 108.0, 6.0, color);
}

fn draw_table_block(pixels: &mut [u32], width: usize, height: usize, rect: &RectPrimitive) {
    fill_rounded_rect(pixels, width, height, rect, rgb(233, 242, 232), 6.0);
    stroke_rect(pixels, width, height, rect.x, rect.y, rect.width, rect.height, rgb(143, 169, 141), 1.0);
    let row_height = (rect.height / 4.0).max(18.0);
    let col_width = rect.width / 3.0;
    for row in 1..4 {
        fill_rect(
            pixels,
            width,
            height,
            rect.x + 8.0,
            rect.y + row as f32 * row_height - 1.0,
            rect.width - 16.0,
            1.0,
            rgb(164, 186, 161),
        );
    }
    for col in 1..3 {
        fill_rect(
            pixels,
            width,
            height,
            rect.x + col as f32 * col_width,
            rect.y + 8.0,
            1.0,
            rect.height - 16.0,
            rgb(164, 186, 161),
        );
    }
}

fn draw_rich_block(pixels: &mut [u32], width: usize, height: usize, rect: &RectPrimitive) {
    fill_rounded_rect(pixels, width, height, rect, rgb(238, 233, 248), 8.0);
    stroke_rect(pixels, width, height, rect.x, rect.y, rect.width, rect.height, rgb(159, 146, 183), 1.0);
    fill_rect(pixels, width, height, rect.x + 16.0, rect.y + 16.0, rect.width * 0.42, 10.0, rgb(117, 99, 153));
    fill_rect(pixels, width, height, rect.x + 16.0, rect.y + 36.0, rect.width * 0.72, 8.0, rgb(168, 156, 194));
    fill_rect(pixels, width, height, rect.x + 16.0, rect.y + 54.0, rect.width * 0.58, 8.0, rgb(168, 156, 194));
}

fn draw_text(pixels: &mut [u32], width: usize, height: usize, x: i32, y: i32, text: &str, color: u32, scale: i32) {
    let scale = scale.max(1);
    let mut cursor_x = x;
    for ch in text.chars() {
        if ch == ' ' {
            cursor_x += 4 * scale;
            continue;
        }
        if let Some(glyph) = BASIC_FONTS.get(ch) {
            for (row, bits) in glyph.iter().enumerate() {
                for col in 0..8 {
                    if bits & (1 << col) != 0 {
                        fill_rect(
                            pixels,
                            width,
                            height,
                            cursor_x as f32 + (col * scale) as f32,
                            y as f32 + (row as i32 * scale) as f32,
                            scale as f32,
                            scale as f32,
                            color,
                        );
                    }
                }
            }
        }
        cursor_x += 8 * scale + scale;
    }
}

fn fill_rounded_rect(pixels: &mut [u32], width: usize, height: usize, rect: &RectPrimitive, color: u32, radius: f32) {
    let inset = radius.min(3.0);
    fill_rect(
        pixels,
        width,
        height,
        rect.x + inset / 2.0,
        rect.y,
        (rect.width - inset).max(1.0),
        rect.height,
        color,
    );
}

fn fill_rect(pixels: &mut [u32], buffer_width: usize, buffer_height: usize, x: f32, y: f32, width: f32, height: f32, color: u32) {
    let start_x = x.floor().max(0.0) as usize;
    let start_y = y.floor().max(0.0) as usize;
    let end_x = (x + width).ceil().max(0.0) as usize;
    let end_y = (y + height).ceil().max(0.0) as usize;

    for py in start_y.min(buffer_height)..end_y.min(buffer_height) {
        let row_start = py * buffer_width;
        for px in start_x.min(buffer_width)..end_x.min(buffer_width) {
            pixels[row_start + px] = color;
        }
    }
}

fn stroke_rect(pixels: &mut [u32], buffer_width: usize, buffer_height: usize, x: f32, y: f32, width: f32, height: f32, color: u32, stroke: f32) {
    fill_rect(pixels, buffer_width, buffer_height, x, y, width, stroke, color);
    fill_rect(pixels, buffer_width, buffer_height, x, y + height - stroke, width, stroke, color);
    fill_rect(pixels, buffer_width, buffer_height, x, y, stroke, height, color);
    fill_rect(pixels, buffer_width, buffer_height, x + width - stroke, y, stroke, height, color);
}

fn rgb(red: u8, green: u8, blue: u8) -> u32 {
    ((red as u32) << 16) | ((green as u32) << 8) | blue as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use document_core::Document;
    use layout_engine::layout_document;

    #[test]
    fn renders_preview_pixels() {
        let document = Document::new();
        let layout = layout_document(&document, 1024, 768);
        let pixels = render_layout(&layout);

        assert_eq!(pixels.len(), 1024 * 768);
        assert!(pixels.iter().any(|pixel| *pixel != 0));
    }
}
