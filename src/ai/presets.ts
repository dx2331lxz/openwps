import { FONT_STACKS, normalizeFontFamily } from '../fonts'

export const fontFamilyMap: Record<string, string> = {
  仿宋: FONT_STACKS.fang,
  宋体: FONT_STACKS.song,
  黑体: FONT_STACKS.hei,
  楷体: FONT_STACKS.kai,
  Arial: FONT_STACKS.arial,
  'Times New Roman': FONT_STACKS.timesNewRoman,
}

export function mapFontFamily(name: string): string {
  return fontFamilyMap[name] ?? normalizeFontFamily(name)
}
