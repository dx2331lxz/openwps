export const FONT_STACKS = {
  song: '"OpenWPSSong", SimSun, 宋体, "Songti SC", STSong, "Noto Serif CJK SC", serif',
  hei: '"OpenWPSHei", SimHei, 黑体, "Heiti SC", STHeiti, "Microsoft YaHei", "PingFang SC", sans-serif',
  kai: '"OpenWPSKai", KaiTi, 楷体, "Kaiti SC", STKaiti, serif',
  fang: '"OpenWPSFang", FangSong, 仿宋, STFangsong, serif',
  arial: 'Arial, sans-serif',
  timesNewRoman: 'Times New Roman, serif',
  courierNew: 'Courier New, monospace',
} as const

export const DEFAULT_EDITOR_FONT_STACK = FONT_STACKS.song

export const SUPPORTED_AI_FONT_NAMES = ['宋体', '黑体', '楷体', '仿宋', 'Arial', 'Times New Roman'] as const

export type SupportedAiFontName = (typeof SUPPORTED_AI_FONT_NAMES)[number]

const FONT_NAME_TO_STACK: Record<SupportedAiFontName, string> = {
  宋体: FONT_STACKS.song,
  黑体: FONT_STACKS.hei,
  楷体: FONT_STACKS.kai,
  仿宋: FONT_STACKS.fang,
  Arial: FONT_STACKS.arial,
  'Times New Roman': FONT_STACKS.timesNewRoman,
}

export function isSupportedAiFontName(value: string): value is SupportedAiFontName {
  return SUPPORTED_AI_FONT_NAMES.includes(value as SupportedAiFontName)
}

export function fontStackFromName(name: string): string | undefined {
  return FONT_NAME_TO_STACK[name as SupportedAiFontName]
}

export function fontNameFromFamily(fontFamily: string | undefined): string | undefined {
  if (!fontFamily) return undefined
  if (fontFamily.includes('OpenWPSFang')) return '仿宋'
  if (fontFamily.includes('OpenWPSKai')) return '楷体'
  if (fontFamily.includes('OpenWPSHei')) return '黑体'
  if (fontFamily.includes('OpenWPSSong')) return '宋体'
  if (fontFamily.includes('FangSong') || fontFamily.includes('仿宋') || fontFamily.includes('STFangsong')) return '仿宋'
  if (fontFamily.includes('KaiTi') || fontFamily.includes('楷体') || fontFamily.includes('Kaiti') || fontFamily.includes('STKaiti')) return '楷体'
  if (fontFamily.includes('SimHei') || fontFamily.includes('黑体') || fontFamily.includes('Heiti') || fontFamily.includes('STHeiti')) return '黑体'
  if (fontFamily.includes('SimSun') || fontFamily.includes('宋体') || fontFamily.includes('Songti') || fontFamily.includes('STSong')) return '宋体'
  if (fontFamily.includes('Arial')) return 'Arial'
  if (fontFamily.includes('Times New Roman')) return 'Times New Roman'
  if (fontFamily.includes('Courier New')) return 'Courier New'
  return undefined
}

export function toDocxFontName(fontFamily: string | undefined): string {
  const name = fontNameFromFamily(fontFamily)
  switch (name) {
    case '黑体':
      return 'SimHei'
    case '楷体':
      return 'KaiTi'
    case '仿宋':
      return 'FangSong'
    case 'Arial':
      return 'Arial'
    case 'Times New Roman':
      return 'Times New Roman'
    case 'Courier New':
      return 'Courier New'
    case '宋体':
    default:
      return 'SimSun'
  }
}

export function normalizeFontFamily(name: string): string {
  return fontStackFromName(name) ?? name
}
