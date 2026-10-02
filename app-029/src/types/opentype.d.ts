/**
 * opentype.js 的最小类型声明（该包未随版本发布 .d.ts，且不额外引入 @types 依赖）。
 * 只声明本项目实际使用到的 API。
 */
declare module 'opentype.js' {
  export interface PathCommand {
    type: 'M' | 'L' | 'C' | 'Q' | 'Z'
    x?: number
    y?: number
    x1?: number
    y1?: number
    x2?: number
    y2?: number
  }

  export class Path {
    commands: PathCommand[]
    fill: string | null
    stroke: string | null
    getBoundingBox(): { x1: number; y1: number; x2: number; y2: number }
    toPathData(decimalPlaces?: number): string
  }

  export class Glyph {
    index: number
    name: string | null
    unicode?: number
    unicodes: number[]
    advanceWidth?: number
    path: Path
    getPath(x?: number, y?: number, fontSize?: number, options?: unknown, font?: Font): Path
    getBoundingBox(): { x1: number; y1: number; x2: number; y2: number }
  }

  export class Font {
    unitsPerEm: number
    ascender: number
    descender: number
    numGlyphs: number
    familyName: string
    names: Record<string, Record<string, string>>
    charToGlyph(char: string | number): Glyph
    stringToGlyphs(text: string): Glyph[]
    getPath(text: string, x: number, y: number, fontSize: number, options?: unknown): Path
    getAdvanceWidth(text: string, fontSize: number, options?: unknown): number
  }

  export function parse(buffer: ArrayBuffer, options?: unknown): Font

  const opentype: {
    parse: typeof parse
    Font: typeof Font
    Glyph: typeof Glyph
    Path: typeof Path
  }
  export default opentype
}