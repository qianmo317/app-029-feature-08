/**
 * 本地字库加载与字形缓存。
 * - 字体文件全部随应用打包（public/fonts），运行时只读取同源静态资源，断网可用；
 * - 解析失败必须明确提示「该字体不可用」，不做静默退化。
 */

import { parse, type Font } from 'opentype.js'
import fontsData from '../data/fonts.json'
import { analyzeGlyphPath, type GlyphGeom } from './glyphAnalysis'
import { emptySamples } from './geometry'

export interface FontWeightDef {
  weight: number
  file: string
  fileSizeKb?: number
}

export interface FontFamily {
  id: string
  label: string
  family: string
  feature: string
  weights: FontWeightDef[]
  license: string
  source: string
}

export const FONT_CHARSET_NOTE: string = fontsData.charsetNote

export interface RuntimeFont {
  id: string
  label: string
  family: string
  feature: string
  license: string
  source: string
  weights: FontWeightDef[]
  /** 本地上传的字体（仅当前会话可用） */
  local?: boolean
}

interface LoadState {
  state: 'idle' | 'loading' | 'ready' | 'error'
  message: string
}

const registry: RuntimeFont[] = (fontsData.fonts as FontFamily[]).map((f) => ({ ...f }))
const extraFonts: RuntimeFont[] = []

const fontCache = new Map<string, Font>()
const geomCache = new Map<string, GlyphGeom>()
const loadState = new Map<string, LoadState>()
const inflight = new Map<string, Promise<Font>>()

function key(fontId: string, weight: number): string {
  return `${fontId}|${weight}`
}

export function listFonts(): RuntimeFont[] {
  return [...registry, ...extraFonts]
}

export function findFont(fontId: string): RuntimeFont | null {
  return listFonts().find((f) => f.id === fontId) ?? null
}

export function fontState(fontId: string, weight: number): LoadState {
  return loadState.get(key(fontId, weight)) ?? { state: 'idle', message: '' }
}

export function hasFont(fontId: string, weight: number): boolean {
  return fontCache.has(key(fontId, weight))
}

function assetUrl(file: string): string {
  const base = import.meta.env.BASE_URL || '/'
  return `${base}${file.replace(/^\//, '')}`
}

/** 加载并解析一个字体文件；失败时抛出「该字体不可用」的明确错误 */
export async function ensureFont(fontId: string, weight: number): Promise<Font> {
  const k = key(fontId, weight)
  const cached = fontCache.get(k)
  if (cached) return cached
  const running = inflight.get(k)
  if (running) return running
  const family = findFont(fontId)
  if (!family) {
    loadState.set(k, { state: 'error', message: '找不到该字体（字库中无此条目）' })
    throw new Error('找不到该字体')
  }
  const def = family.weights.find((w) => w.weight === weight) ?? family.weights[0]
  if (!def) {
    loadState.set(k, { state: 'error', message: '该字体不可用：没有可用字重' })
    throw new Error('该字体不可用')
  }
  loadState.set(k, { state: 'loading', message: '正在解析字体…' })
  const p = (async () => {
    try {
      const buf = family.local
        ? await readLocalBuffer(def.file)
        : await (await fetch(assetUrl(def.file))).arrayBuffer()
      const font = parse(buf) as Font
      if (!font || !font.unitsPerEm) throw new Error('字体解析结果为空')
      fontCache.set(k, font)
      loadState.set(k, { state: 'ready', message: `解析成功：${font.numGlyphs} 个字形` })
      inflight.delete(k)
      return font
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      loadState.set(k, { state: 'error', message: `该字体不可用：${detail}` })
      inflight.delete(k)
      throw new Error(`该字体不可用：${detail}`)
    }
  })()
  inflight.set(k, p)
  return p
}

/** 本地上传的字体以 dataURL 存放在内存中（仅当前会话） */
const localBuffers = new Map<string, ArrayBuffer>()

async function readLocalBuffer(file: string): Promise<ArrayBuffer> {
  const b = localBuffers.get(file)
  if (b) return b
  throw new Error('本地字体数据已失效，请重新上传')
}

/** 注册用户上传的本地字体（会话级）；解析失败会给出「该字体不可用」 */
export async function registerLocalFont(name: string, buffer: ArrayBuffer): Promise<RuntimeFont> {
  const font = parse(buffer) as Font
  if (!font || !font.unitsPerEm) throw new Error('该字体不可用：无法解析字体数据')
  const id = `local-${Date.now().toString(36)}`
  const file = `local:${id}`
  localBuffers.set(file, buffer)
  const familyName = font.names?.fontFamily?.en ?? name.replace(/\.(ttf|otf)$/i, '')
  const def: RuntimeFont = {
    id,
    label: `${familyName}（本地上传）`,
    family: familyName,
    feature: '用户上传字体，仅当前浏览器会话可用',
    license: '未知（用户自行上传，请确认授权）',
    source: '本地文件',
    weights: [{ weight: 400, file }],
    local: true
  }
  extraFonts.push(def)
  fontCache.set(key(id, 400), font)
  loadState.set(key(id, 400), { state: 'ready', message: `解析成功：${font.numGlyphs} 个字形` })
  return def
}

/** 取字形几何（与字号无关，本地单位 1000 em）；字体未加载返回 null */
export function getGlyphGeom(fontId: string, weight: number, char: string): GlyphGeom | null {
  const k = `${fontId}|${weight}|${char}`
  const hit = geomCache.get(k)
  if (hit) return hit
  const font = fontCache.get(key(fontId, weight))
  if (!font) return null
  const glyph = font.charToGlyph(char)
  if (!glyph || glyph.index === 0) {
    const missing: GlyphGeom = {
      char,
      fontId,
      weight,
      missing: true,
      blank: false,
      rings: [],
      strokeBlocks: 0,
      strokeBlocksByNesting: 0,
      minStroke: 0,
      minStrokePoint: null,
      bbox: { x0: 0, y0: 0, x1: 0, y1: 0 },
      inkW: 0,
      inkH: 0,
      samples: emptySamples(),
      outerPerimeter: 0,
      blockBBoxes: [],
      pathData: '',
      advance: 0
    }
    geomCache.set(k, missing)
    return missing
  }
  const path = glyph.getPath(0, 0, 1000)
  const geom = analyzeGlyphPath(char, fontId, weight, path.commands, glyph.advanceWidth ?? 1000)
  geomCache.set(k, geom)
  return geom
}

/** 清空字形几何缓存（用于性能自检：强制重新解析+分析） */
export function clearGeometryCache(): void {
  geomCache.clear()
}

export async function preloadAll(onProgress?: (done: number, total: number) => void): Promise<void> {
  const tasks: Array<Promise<unknown>> = []
  const all: Array<{ id: string; weight: number }> = []
  for (const f of listFonts()) for (const w of f.weights) all.push({ id: f.id, weight: w.weight })
  let done = 0
  for (const t of all) {
    tasks.push(
      ensureFont(t.id, t.weight)
        .catch(() => undefined)
        .finally(() => {
          done++
          onProgress?.(done, all.length)
        })
    )
  }
  await Promise.all(tasks)
}