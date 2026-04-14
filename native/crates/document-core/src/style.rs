use serde::{Deserialize, Serialize};

// ── Font Family Key ─────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum FontFamilyKey {
    Song,
    Hei,
    Kai,
    Fang,
    Arial,
    TimesNewRoman,
    CourierNew,
    Custom(String),
}

impl Default for FontFamilyKey {
    fn default() -> Self {
        Self::Song
    }
}

impl FontFamilyKey {
    /// DOCX export font name
    pub fn to_docx_name(&self) -> &str {
        match self {
            Self::Song => "SimSun",
            Self::Hei => "SimHei",
            Self::Kai => "KaiTi",
            Self::Fang => "FangSong",
            Self::Arial => "Arial",
            Self::TimesNewRoman => "Times New Roman",
            Self::CourierNew => "Courier New",
            Self::Custom(name) => name,
        }
    }
}

// ── Text Align ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum TextAlign {
    #[default]
    Left,
    Center,
    Right,
    Justify,
}

// ── List Type ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ListType {
    Bullet,
    Ordered,
}

// ── Vertical Align ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum VerticalAlign {
    #[default]
    Top,
    Middle,
    Bottom,
}

// ── Table Width Policy ──────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum TableWidthPolicy {
    #[default]
    Auto,
    Fixed,
    Percent,
}

// ── Border Style ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum BorderStyle {
    #[default]
    None,
    Solid,
    Dashed,
    Dotted,
}

// ── Border Side ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BorderSide {
    pub width: f64,
    pub color: String,
    pub style: BorderStyle,
}

impl Default for BorderSide {
    fn default() -> Self {
        Self {
            width: 0.5,
            color: "#000000".into(),
            style: BorderStyle::Solid,
        }
    }
}

// ── Borders ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Borders {
    pub top: Option<BorderSide>,
    pub bottom: Option<BorderSide>,
    pub left: Option<BorderSide>,
    pub right: Option<BorderSide>,
}

// ── Text Style ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextStyle {
    pub font_family: FontFamilyKey,
    pub font_size: f64,
    pub color: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background_color: Option<String>,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strikethrough: bool,
    pub superscript: bool,
    pub subscript: bool,
    pub letter_spacing: f64,
}

impl Default for TextStyle {
    fn default() -> Self {
        Self {
            font_family: FontFamilyKey::default(),
            font_size: 12.0,
            color: "#000000".into(),
            background_color: None,
            bold: false,
            italic: false,
            underline: false,
            strikethrough: false,
            superscript: false,
            subscript: false,
            letter_spacing: 0.0,
        }
    }
}

// ── Paragraph Style ─────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParagraphStyle {
    pub align: TextAlign,
    pub first_line_indent: f64,
    pub indent_left: f64,
    pub indent_right: f64,
    pub line_height: f64,
    pub space_before: f64,
    pub space_after: f64,
    pub list_type: Option<ListType>,
    pub list_level: u8,
    pub page_break_before: bool,
    pub keep_with_next: bool,
    pub keep_lines_together: bool,
}

impl Default for ParagraphStyle {
    fn default() -> Self {
        Self {
            align: TextAlign::Left,
            first_line_indent: 0.0,
            indent_left: 0.0,
            indent_right: 0.0,
            line_height: 1.5,
            space_before: 0.0,
            space_after: 0.0,
            list_type: None,
            list_level: 0,
            page_break_before: false,
            keep_with_next: false,
            keep_lines_together: false,
        }
    }
}

// ── Document Styles ─────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DocumentStyles {
    pub default_font_family: FontFamilyKey,
    pub default_font_size: f64,
    pub default_line_height: f64,
    pub default_color: String,
}

impl Default for DocumentStyles {
    fn default() -> Self {
        Self {
            default_font_family: FontFamilyKey::Song,
            default_font_size: 12.0,
            default_line_height: 1.5,
            default_color: "#000000".into(),
        }
    }
}
