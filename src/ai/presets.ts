export interface BodyStyle {
  fontFamily?: string
  fontSize?: number
  firstLineIndent?: number
  lineHeight?: number
  spaceBefore?: number
  spaceAfter?: number
  align?: string
}

export interface HeadingStyle {
  fontFamily?: string
  fontSize?: number
  align?: string
  bold?: boolean
  spaceBefore?: number
  spaceAfter?: number
}

export interface PageStyle {
  paperSize: string
  orientation?: string
  marginTop?: number
  marginBottom?: number
  marginLeft?: number
  marginRight?: number
}

export interface PresetStyle {
  page?: PageStyle
  body?: BodyStyle
  heading1?: HeadingStyle
  heading2?: HeadingStyle
  heading3?: HeadingStyle
}

export const presetStyles: Record<string, PresetStyle> = {
  公文: {
    page: { paperSize: 'A4', marginTop: 37, marginBottom: 35, marginLeft: 28, marginRight: 28 },
    body: { fontFamily: '仿宋', fontSize: 16, firstLineIndent: 2, lineHeight: 1.5 },
    heading1: { fontFamily: '黑体', fontSize: 22, align: 'center', spaceBefore: 12, spaceAfter: 12 },
    heading2: { fontFamily: '黑体', fontSize: 18, spaceBefore: 10, spaceAfter: 6 },
    heading3: { fontFamily: '楷体', fontSize: 16, spaceBefore: 6, spaceAfter: 4 },
  },
  论文: {
    page: { paperSize: 'A4', marginTop: 25, marginBottom: 25, marginLeft: 30, marginRight: 30 },
    body: { fontFamily: '宋体', fontSize: 12, firstLineIndent: 2, lineHeight: 1.5 },
    heading1: { fontFamily: '黑体', fontSize: 18, align: 'center', spaceBefore: 18, spaceAfter: 12 },
    heading2: { fontFamily: '黑体', fontSize: 14, spaceBefore: 12, spaceAfter: 6 },
    heading3: { fontFamily: '黑体', fontSize: 12, spaceBefore: 6, spaceAfter: 4 },
  },
  合同: {
    page: { paperSize: 'A4', marginTop: 30, marginBottom: 30, marginLeft: 30, marginRight: 30 },
    body: { fontFamily: '宋体', fontSize: 12, firstLineIndent: 2, lineHeight: 1.5 },
    heading1: { fontFamily: '黑体', fontSize: 16, align: 'center', spaceBefore: 12, spaceAfter: 12 },
  },
  报告: {
    page: { paperSize: 'A4', marginTop: 25, marginBottom: 25, marginLeft: 25, marginRight: 25 },
    body: { fontFamily: '宋体', fontSize: 12, firstLineIndent: 2, lineHeight: 1.5 },
    heading1: { fontFamily: '黑体', fontSize: 16, spaceBefore: 12, spaceAfter: 8 },
    heading2: { fontFamily: '黑体', fontSize: 14, spaceBefore: 8, spaceAfter: 6 },
  },
  信函: {
    page: { paperSize: 'A4', marginTop: 30, marginBottom: 30, marginLeft: 30, marginRight: 30 },
    body: { fontFamily: '宋体', fontSize: 12, lineHeight: 1.5 },
  },
}

/** Map Chinese font short names to CSS font stacks */
export const fontFamilyMap: Record<string, string> = {
  仿宋: 'FangSong, 仿宋, serif',
  宋体: 'SimSun, 宋体, serif',
  黑体: 'SimHei, 黑体, sans-serif',
  楷体: 'KaiTi, 楷体, serif',
  隶书: 'LiSu, 隶书, serif',
  幼圆: 'YouYuan, 幼圆, sans-serif',
  Arial: 'Arial, sans-serif',
  'Times New Roman': 'Times New Roman, serif',
  'Courier New': 'Courier New, monospace',
}

export function mapFontFamily(name: string): string {
  return fontFamilyMap[name] ?? name
}
