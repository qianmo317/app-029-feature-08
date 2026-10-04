/**
 * 排版引擎（规格书第 8 节关键实现点）：
 * - 字距 = 相邻两字形「轮廓最近距离」（视觉间距），不是文本框宽度相减；
 * - 两端对齐按视觉间距平均分配（同一目标间距 → 视觉间距极差≈0）；
 * - 字形几何按「本地单位 1000 em」缓存，实际尺寸只做线性缩放（改字号不重解析字体）；
 * - 调字距只重算受影响的相邻对：视觉间距求解结果按 (字对, 归一化间距) 缓存（增量）。
 */

import { getGlyphGeom, type FontFamily } from './fontLoader'
import { emptySamples, minSetDistance } from './geometry'
import type { GlyphGeom } from './glyphAnalysis'
import type { Align, CharItem, GlyphInfo, LayoutDef, LayoutSettings, MarginSettings, MarginSide, Project, SignPanel } from './types'

export interface PlacedChar {
  index: number
  char: string
  geom: GlyphGeom
  missing: boolean
  blank: boolean
  /** 墨迹左上角（面板坐标 mm，y 向下） */
  x: number
  y: number
  /** 墨迹尺寸 mm */
  inkW: number
  inkH: number
  /** 与下一个字的视觉间距（实测，mm） */
  gapAfter: number | null
  /** 字距为负 / 轮廓相交 */
  overlapAfter: boolean
  line: number
  item: CharItem
}

export interface LineLayout {
  line: number
  chars: PlacedChar[]
  inkLeft: number
  inkRight: number
  inkTop: number
  inkBottom: number
  width: number
}

export interface MarginInfo {
  left: number
  right: number
  top: number
  bottom: number
  /** |左右留边差| */
  deltaX: number
  symmetric: boolean
}

/**
 * 自动字号留边反算明细（排版结果里一次写清）：
 * - nominalLeft/right：按设定（字号比例或固定 mm）应留的留边；
 * - reservedLeft/right：反算实际预留（被让后可能小于 nominal）；
 * - yieldedSide：先让出来的一侧（压另一侧），null 表示两侧都按设定走、没让过；
 * - shrunkSize：压到下限仍不够、整体缩了字号；
 * - atLimitLeft/right：该侧留边已压到下限（需提示，别让人以为还在按比例走）。
 */
export interface MarginFit {
  auto: boolean
  nominalLeft: number
  nominalRight: number
  reservedLeft: number
  reservedRight: number
  yieldedSide: 'left' | 'right' | null
  shrunkSize: boolean
  /** 缩字号原因：宽度（让位到下限仍不够）/ 高度 / 两者 */
  shrinkReason: 'none' | 'width' | 'height' | 'both'
  atLimitLeft: boolean
  atLimitRight: boolean
  /** 人读说明：按设定 / 先让哪一侧 / 是否整体缩字号 */
  note: string
}

export interface LayoutResult {
  inner: { x: number; y: number; w: number; h: number }
  lines: LineLayout[]
  chars: PlacedChar[]
  /** 墨迹整体范围（面板坐标 mm） */
  inkLeft: number
  inkRight: number
  inkTop: number
  inkBottom: number
  occupiedW: number
  occupiedH: number
  margins: MarginInfo
  /** 留边反算明细（设定值/实际值/让位说明/下限提示） */
  marginFit: MarginFit
  /** 左右留边界线（内容区，相对面板坐标 mm） */
  contentBox: { x: number; y: number; w: number; h: number }
  overflowX: boolean
  overflowY: boolean
  overflowXMm: number
  overflowYMm: number
  /** 同排相邻字视觉间距极差 mm */
  gapSpread: number
  glyphs: GlyphInfo[]
  /** 外轮廓周长合计 mm（= LED 布点长度） */
  ledLengthMm: number
  warnings: string[]
  sizeMm: number
  /** 超出安装区时的建议字号（自动字号，保证不超出） */
  suggestedSizeMm: number | null
  /** 字体缺失/未加载的字符数 */
  missingCount: number
  /** 两端对齐使用的目标视觉间距 */
  justifyGapMm: number | null
}

export interface LayoutOptions {
  /** 自动字号 */
  autoSize?: boolean
}

const pairCache = new Map<string, number>()

export function round1(v: number): number {
  return Math.round(v * 10) / 10
}
export function round2(v: number): number {
  return Math.round(v * 100) / 100
}

/** 视觉间距求解（核心）：返回 B 墨迹左边界相对 A 墨迹左边界的偏移（mm）与实测间距 */
export function solveVisualOffset(
  a: GlyphGeom,
  b: GlyphGeom,
  sizeMm: number,
  gapMm: number
): { offset: number; gap: number; overlap: boolean } {
  const k = sizeMm / 1000
  const usable = !a.blank && !b.blank && !a.missing && !b.missing && a.samples.ax.length > 0 && b.samples.ax.length > 0
  if (!usable) {
    return { offset: (a.inkW + b.inkW) * k + gapMm, gap: gapMm, overlap: gapMm < 0 }
  }
  const target = Math.max(0, gapMm)
  const gn = target / k // 归一化到本地单位
  const ck = `${a.fontId}|${a.weight}|${a.char}|${b.char}|${gn.toFixed(3)}`
  const ax = -a.bbox.x0
  const bx = -b.bbox.x0
  const evalD = (delta: number): number => (delta <= 1e-9 ? 0 : minSetDistance(a.samples, ax, b.samples, bx + delta))

  let solved = pairCache.get(ck)
  if (solved === undefined) {
    let lo = 1e-6
    let hi = a.inkW + b.inkW + 4 * gn + 50
    // 初值取「包围盒模型」Δ = inkW_A + 目标间距，通常 2~4 步牛顿迭代即收敛
    let d = Math.min(hi * 0.9, a.inkW + gn)
    let cur = d
    for (let i = 0; i < 16; i++) {
      const D = evalD(d)
      cur = d
      if (D > gn) hi = d
      else lo = d
      if (Math.abs(D - gn) <= 0.02 || hi - lo <= 0.02) break
      let next = d + (gn - D)
      if (!(next > lo && next < hi)) next = (lo + hi) / 2
      d = next
    }
    solved = cur
    pairCache.set(ck, solved)
  }
  const offset = solved * k
  // 实测视觉间距（用于界面展示与验收断言，不做「静默使用目标值」）
  const measured = gapMm < 0 ? gapMm : evalD(solved) * k
  return { offset, gap: measured, overlap: gapMm < 0 }
}

/** 第 i 个字的实际字距：未手动调整过则跟随「默认字距比例 × 字号」 */
export function effectiveTrack(item: CharItem, settings: LayoutSettings, sizeMm: number): number {
  if (item.trackTouched) return item.trackMm
  return round1(settings.trackRatio * sizeMm)
}

/** 单侧留边默认值：按字号比例 4%，可压到 0mm 下限 */
export function defaultMarginSide(ratio = 0.04): MarginSide {
  return { mode: 'ratio', ratio, fixedMm: 0, minMm: 0 }
}

/** 留边方式标签 */
export function marginModeLabel(mode: MarginSide['mode']): string {
  return mode === 'ratio' ? '字号比例' : '固定 mm'
}

/**
 * 兼容旧项目：缺 margins 字段时，按「两边同宽的比例」接着用。
 * 旧 marginRatio 原指安装区宽的比例；迁移时直接把同一比例值当作「字号比例」，
 * 保证老项目打开后仍是左右等宽、不会一侧顶柱（这正是旧版的视觉口径）。
 */
export function normalizeSettings(st: LayoutSettings): LayoutSettings {
  if (st.margins && st.margins.left && st.margins.right) return st
  const legacy = typeof st.marginRatio === 'number' ? st.marginRatio : 0.04
  st.margins = { left: defaultMarginSide(legacy), right: defaultMarginSide(legacy), prioritySide: 'left' }
  return st
}

function clampSide(side: MarginSide): MarginSide {
  const mode = side.mode === 'fixed' ? 'fixed' : 'ratio'
  const ratio = Number.isFinite(side.ratio) ? Math.min(0.9, Math.max(0, side.ratio)) : 0
  const fixedMm = Number.isFinite(side.fixedMm) && side.fixedMm > 0 ? side.fixedMm : 0
  const minMm = Number.isFinite(side.minMm) && side.minMm > 0 ? side.minMm : 0
  return { mode, ratio, fixedMm, minMm: Math.max(0, minMm) }
}

/** 按设定求单侧「名义留边」（未让位时应有的值，mm） */
function nominalMarginMm(side: MarginSide, sizeMm: number): number {
  return Math.max(side.minMm, side.mode === 'fixed' ? side.fixedMm : side.ratio * sizeMm)
}

interface ReserveCase {
  left: number
  right: number
}

/**
 * 按「先保 prioritySide」的规则，把两侧名义留边收敛进可用宽度：
 * 先压非优先侧（压到其下限为止），还放不下再压优先侧。两侧都给非负值，且保证内容至少 1mm。
 */
function resolveMarginReserves(nom: ReserveCase, cfg: MarginSettings, availW: number): ReserveCase {
  const L = clampSide(cfg.left)
  const R = clampSide(cfg.right)
  let left = Math.max(L.minMm, nom.left)
  let right = Math.max(R.minMm, nom.right)
  const floorW = Math.min(availW - 1, availW)
  if (left + right <= floorW) return { left, right }
  const otherKey: 'left' | 'right' = cfg.prioritySide === 'left' ? 'right' : 'left'
  const otherMin = otherKey === 'left' ? L.minMm : R.minMm
  const otherNom = otherKey === 'left' ? left : right
  const other = Math.max(otherMin, otherNom - (left + right - floorW))
  if (otherKey === 'left') left = other
  else right = other
  if (left + right <= floorW) return { left, right }
  // 非优先侧已到下限仍不够：压优先侧
  const pKey: 'left' | 'right' = cfg.prioritySide
  const pMin = pKey === 'left' ? L.minMm : R.minMm
  const pNom = pKey === 'left' ? left : right
  const p = Math.max(pMin, pNom - (left + right - floorW))
  if (pKey === 'left') left = p
  else right = p
  if (left + right > availW) {
    // 极端配置（两侧下限之和就已超宽）：保证内容至少 1mm，优先侧最后让
    const scale = Math.max(0, availW - 1) / Math.max(1e-9, left + right)
    left *= scale
    right *= scale
  }
  return { left, right }
}

interface BuildResult {
  lines: LineLayout[]
  placed: PlacedChar[]
  occupiedW: number
  occupiedH: number
  missingCount: number
  /** 每行墨迹宽之和（两端对齐时的最小内容宽口径） */
  maxLineInkSum: number
  /** 每行的目标视觉间距（仅两端对齐时非空） */
  lineGaps: Map<number, number>
  /** 同一行内相邻字视觉间距极差的最大值 */
  gapSpread: number
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

function buildAtSize(
  def: LayoutDef,
  /** 水平界线：左右留边之后的内容区（对齐/撑满都按它） */
  contentBox: Box,
  /** 垂直界线：仍是整个有效安装区（留边只管左右） */
  innerV: Box,
  itemsByLine: Map<number, CharItem[]>,
  lineNos: number[],
  sizeMm: number,
  justify: boolean
): BuildResult {
  const st = def.settings
  const k = sizeMm / 1000
  const lines: LineLayout[] = []
  const placed: PlacedChar[] = []
  const lineGaps = new Map<number, number>()
  let missingCount = 0
  let gapSpread = 0
  let maxLineInkSum = 0

  for (const ln of lineNos) {
    const items = itemsByLine.get(ln) ?? []
    const geoms = items.map((it) => {
      const g = getGlyphGeom(st.fontId, st.weight, it.char)
      const ok = !!g && !g.missing
      if (!ok) missingCount++
      return { geom: ok ? (g as GlyphGeom) : missingGeom(it.char, st.fontId, st.weight), ok, blank: ok && (g as GlyphGeom).blank }
    })
    const pairs = Math.max(0, items.length - 1)
    /** 以统一视觉间距 gapMm 排一行（两端对齐反算/撑满共用），返回逐字与右边界 */
    const layoutLineWithGap = (gapMm: number): { chars: PlacedChar[]; right: number } => {
      const out: PlacedChar[] = []
      let cursor = 0
      for (let i = 0; i < items.length; i++) {
        const it = items[i]
        const g = geoms[i]
        const inkW = g.ok ? g.geom.inkW * k : sizeMm
        const inkH = g.ok ? g.geom.inkH * k : sizeMm
        const node: PlacedChar = {
          index: out.length,
          char: it.char,
          geom: g.geom,
          missing: !g.ok,
          blank: g.blank,
          x: cursor,
          y: g.ok ? g.geom.bbox.y0 * k : 0,
          inkW,
          inkH,
          gapAfter: null,
          overlapAfter: false,
          line: ln,
          item: it
        }
        out.push(node)
        if (i < items.length - 1) {
          const ng = geoms[i + 1]
          if (g.ok && ng.ok) {
            const res = solveVisualOffset(g.geom, ng.geom, sizeMm, gapMm)
            cursor += res.offset
            node.gapAfter = round2(res.gap)
            node.overlapAfter = res.overlap
          } else {
            cursor += inkW + gapMm
          }
        }
      }
      const right = out.length ? Math.max(...out.map((c) => c.x + c.inkW)) : 0
      return { chars: out, right }
    }

    // 零视觉间距下的最小占宽（两端对齐能压到的最紧宽度；供自动字号反算）
    const tight = layoutLineWithGap(0)
    maxLineInkSum = Math.max(maxLineInkSum, tight.right)

    let chars: PlacedChar[]
    let gTarget = 0
    if (justify && pairs > 0) {
      // 两端对齐：对「目标视觉间距 → 整行右边界」二分求根，让整行严格贴合留边后内容区
      const targetRight = contentBox.w
      const rightAt = (gapMm: number): number => layoutLineWithGap(gapMm).right
      if (rightAt(0) >= targetRight) {
        // 零间距都放不下：不强行撑，gTarget=0（反算字号阶段会据此缩小字号）
        gTarget = 0
        chars = tight.chars
      } else {
        let lo = 0
        let hi = Math.max(1, (targetRight - tight.right) / pairs)
        while (rightAt(hi) < targetRight) hi *= 2
        for (let i = 0; i < 18; i++) {
          const mid = (lo + hi) / 2
          if (rightAt(mid) < targetRight) lo = mid
          else hi = mid
        }
        gTarget = (lo + hi) / 2
        chars = layoutLineWithGap(gTarget).chars
      }
    } else {
      // 非两端对齐：每个字用各自字距（手动/跟随默认），按统一 0 间距骨架 + 实际字距排
      gTarget = 0
      chars = []
      let cursor = 0
      for (let i = 0; i < items.length; i++) {
        const it = items[i]
        const g = geoms[i]
        const inkW = g.ok ? g.geom.inkW * k : sizeMm
        const inkH = g.ok ? g.geom.inkH * k : sizeMm
        const node: PlacedChar = {
          index: chars.length,
          char: it.char,
          geom: g.geom,
          missing: !g.ok,
          blank: g.blank,
          x: cursor,
          y: g.ok ? g.geom.bbox.y0 * k : 0,
          inkW,
          inkH,
          gapAfter: null,
          overlapAfter: false,
          line: ln,
          item: it
        }
        chars.push(node)
        if (i < items.length - 1) {
          const ng = geoms[i + 1]
          const gap = effectiveTrack(it, st, sizeMm)
          if (g.ok && ng.ok) {
            const res = solveVisualOffset(g.geom, ng.geom, sizeMm, gap)
            cursor += res.offset
            node.gapAfter = round2(res.gap)
            node.overlapAfter = res.overlap
          } else {
            cursor += inkW + gap
          }
        }
      }
    }
    if (justify && pairs > 0) lineGaps.set(ln, Math.round(gTarget * 100) / 100)
    const gapsInLine = chars.filter((c) => c.gapAfter !== null).map((c) => c.gapAfter as number)
    if (gapsInLine.length > 1) {
      gapSpread = Math.max(gapSpread, Math.max(...gapsInLine) - Math.min(...gapsInLine))
    }
    const inkLeft = chars.length ? Math.min(...chars.map((c) => c.x)) : 0
    const inkRight = chars.length ? Math.max(...chars.map((c) => c.x + c.inkW)) : 0
    const inkTop = chars.length ? Math.min(...chars.map((c) => c.y)) : 0
    const inkBottom = chars.length ? Math.max(...chars.map((c) => c.y + c.inkH)) : 0
    lines.push({ line: ln, chars, inkLeft, inkRight, inkTop, inkBottom, width: inkRight - inkLeft })
    placed.push(...chars)
  }

  // 纵向：按基线排布，行距 = 字号 ×(1 + lineGapRatio)
  const pitch = sizeMm * (1 + st.lineGapRatio)
  for (const l of lines) {
    const off = l.line * pitch
    for (const c of l.chars) c.y += off
    l.inkTop += off
    l.inkBottom += off
  }

  // 水平对齐（逐行：左对齐/居中/右对齐/两端对齐）——界线 = 左右留边后的内容区
  for (const l of lines) {
    let shiftX = contentBox.x - l.inkLeft
    const w = l.inkRight - l.inkLeft
    if (st.align === 'center') shiftX = contentBox.x + (contentBox.w - w) / 2 - l.inkLeft
    else if (st.align === 'right') shiftX = contentBox.x + contentBox.w - l.inkRight
    for (const c of l.chars) c.x += shiftX
    l.inkLeft += shiftX
    l.inkRight += shiftX
  }

  // 垂直居中（界线仍是整个有效安装区）
  const top = lines.length ? Math.min(...lines.map((l) => l.inkTop)) : 0
  const bottom = lines.length ? Math.max(...lines.map((l) => l.inkBottom)) : 0
  const occupiedH = Math.max(0, bottom - top)
  const shiftY = innerV.y + (innerV.h - occupiedH) / 2 - top
  for (const c of placed) c.y += shiftY + c.item.offsetYMm
  for (const l of lines) {
    l.inkTop += shiftY
    l.inkBottom += shiftY
  }

  const left = lines.length ? Math.min(...lines.map((l) => l.inkLeft)) : 0
  const right = lines.length ? Math.max(...lines.map((l) => l.inkRight)) : 0

  return {
    lines,
    placed,
    occupiedW: Math.max(0, right - left),
    occupiedH,
    missingCount,
    maxLineInkSum: round2(maxLineInkSum),
    lineGaps,
    gapSpread: round2(gapSpread)
  }
}

/** 自动字号反算结果 */
interface FitResult {
  sizeMm: number
  reserved: ReserveCase
  /** 最终字号下两侧名义留边（未让位应有的值，供说明/对照） */
  nominalAtStart: ReserveCase
  /** 先让出来的一侧（被压的非优先侧）；null = 没让位 */
  yieldedSide: 'left' | 'right' | null
  /** 是否整体缩了字号（非优先侧压到下限仍不够，或高度受限） */
  shrunkSize: boolean
  /** 缩字号的原因 */
  shrinkReason: 'none' | 'width' | 'height' | 'both'
}

const MIN_FIT_SIZE = 5
/** 实际留边比名义小超过这个值才算「让位」（更小的值视为字号取整的舍入） */
const YIELD_EPS = 0.5

/**
 * 自动字号反算（核心）：
 * 目标：在「优先侧留边一定不小于设定、非优先侧留边不小于其下限」的前提下，把字号反算到最大。
 * - 用「最宽界线」= 优先侧名义留边 + 非优先侧下限，按宽+高定点反求字号 s（比例留边随字号缩放）；
 * - s 即最大可用字号：非优先侧的实际留边 = 该字号下的剩余空间，夹在 [下限, 名义] 内；
 * - 若字号是相对基准缩小得到的（压到下限仍放不下，或高度受限），标记整体缩字号及原因；
 * - 高度只会整体缩字号，不挤压左右留边。
 */
function fitAuto(
  def: LayoutDef,
  inner: Box,
  itemsByLine: Map<number, CharItem[]>,
  lineNos: number[],
  justify: boolean,
  /** 建议字号口径：只按「两侧名义留边都保住」反算（手动采用后不会再超），不做让位 */
  nominalOnly = false
): FitResult {
  const cfg = def.settings.margins
  const sideL = clampSide(cfg.left)
  const sideR = clampSide(cfg.right)
  const pKey: 'left' | 'right' = cfg.prioritySide
  const oKey: 'left' | 'right' = pKey === 'left' ? 'right' : 'left'
  const pSide = pKey === 'left' ? sideL : sideR
  const oSide = oKey === 'left' ? sideL : sideR
  const box = (res: ReserveCase): Box => ({
    x: inner.x + res.left,
    y: inner.y,
    w: Math.max(1, inner.w - res.left - res.right),
    h: inner.h
  })
  const nomAt = (s: number): ReserveCase => ({ left: nominalMarginMm(sideL, s), right: nominalMarginMm(sideR, s) })
  // 反算一律用自然排布（非撑满）测量；两端对齐只看墨迹之和，否则看自然占宽
  const probe = (s: number, res: ReserveCase): BuildResult => buildAtSize(def, box(res), inner, itemsByLine, lineNos, s, false)
  const needW = (b: BuildResult): number => (justify ? b.maxLineInkSum : b.occupiedW)

  const baseS = Math.max(MIN_FIT_SIZE, def.settings.baseSizeMm)
  const startNom = nomAt(baseS)
  if (probe(baseS, { left: 0, right: 0 }).occupiedW < 0.5) {
    // 空排版（还没输入文字）不参与反算，避免字号发散
    return { sizeMm: baseS, reserved: resolveMarginReserves(startNom, cfg, inner.w), nominalAtStart: startNom, yieldedSide: null, shrunkSize: false, shrinkReason: 'none' }
  }

  // 目标一：两侧都保名义留边，按宽+高反求字号（可放大填满，沿用旧版自动字号口径）
  let sNom = baseS
  for (let i = 0; i < 40; i++) {
    const b = probe(sNom, { left: 0, right: 0 })
    const n = nomAt(sNom)
    const ratioW = needW(b) / Math.max(1, inner.w - n.left - n.right)
    const ratioH = b.occupiedH / Math.max(1, inner.h)
    const ratio = Math.max(ratioW, ratioH)
    if (Math.abs(ratio - 1) <= 1e-4) break
    const next = Math.min(sNom * 5, Math.max(MIN_FIT_SIZE, sNom / Math.max(ratio, 1e-9)))
    if (Math.abs(next - sNom) <= 0.05) {
      sNom = next
      break
    }
    sNom = next
  }

  // 统一收尾：字号取 0.1mm，按最终字号求非优先侧实际留边（剩余夹在 [下限, 名义]）；
  // mode='keepNominal' 时两侧保名义，若取整后放不下则字号逐档 0.1mm 下调。
  function finish(s0: number, mode: 'keepNominal' | 'yieldOther'): FitResult {
    let s = s0
    let reserves: ReserveCase = { left: 0, right: 0 }
    let nomEnd = nomAt(s)
    let bEnd = probe(s, { left: 0, right: 0 })

    if (mode === 'yieldOther') {
      // 先用宽步长定点反求到「优先侧名义 + 非优先侧下限」界线内（避免逐 0.1 循环）
      for (let i = 0; i < 40; i++) {
        const pNom = nominalMarginMm(pSide, s)
        const floor: ReserveCase = { left: 0, right: 0 } as ReserveCase
        floor[pKey] = pNom
        floor[oKey] = oSide.minMm
        if (floor.left + floor.right > inner.w - 1) {
          const c = resolveMarginReserves(nomAt(s), cfg, inner.w)
          floor.left = c.left
          floor.right = c.right
        }
        bEnd = probe(s, floor)
        const ratioW = needW(bEnd) / Math.max(1, inner.w - floor.left - floor.right)
        const ratioH = bEnd.occupiedH / Math.max(1, inner.h)
        const ratio = Math.max(ratioW, ratioH)
        if (ratio <= 1 + 1e-6) break
        const next = Math.max(MIN_FIT_SIZE, s / Math.max(ratio, 1e-9))
        if (Math.abs(next - s) <= 0.05 || s <= MIN_FIT_SIZE + 0.05) {
          s = next
          break
        }
        s = next
      }
    }

    // 0.1mm 取整 + 最多几档微调，保证最终排版确实不溢出
    for (let guard = 0; guard < 12; guard++) {
      s = Math.round(s * 10) / 10
      nomEnd = nomAt(s)
      bEnd = probe(s, { left: 0, right: 0 })
      const wEnd = needW(bEnd)
      if (mode === 'keepNominal') {
        reserves = { left: nomEnd.left, right: nomEnd.right }
        if (wEnd <= inner.w - reserves.left - reserves.right + 0.05 && bEnd.occupiedH <= inner.h + 0.05) break
      } else {
        const pEnd = nomEnd[pKey]
        const slack = inner.w - wEnd - pEnd
        const oEnd = slack >= nomEnd[oKey] - 1e-6 ? nomEnd[oKey] : Math.max(oSide.minMm, slack)
        reserves = { left: 0, right: 0 } as ReserveCase
        reserves[pKey] = pEnd
        reserves[oKey] = oEnd
        if (reserves.left + reserves.right > inner.w - 1) {
          const c = resolveMarginReserves(nomEnd, cfg, inner.w)
          reserves.left = c.left
          reserves.right = c.right
        }
        if (wEnd <= inner.w - reserves.left - reserves.right + 0.05 && bEnd.occupiedH <= inner.h + 0.05) break
      }
      s = Math.round((s - 0.1) * 10) / 10
      if (s <= MIN_FIT_SIZE) break
    }

    const yieldedSide = mode === 'yieldOther' && reserves[oKey] < nomEnd[oKey] - YIELD_EPS ? oKey : null
    const shrunkSize = s < baseS - 0.1
    let shrinkReason: FitResult['shrinkReason'] = 'none'
    if (shrunkSize) {
      const contentW = inner.w - reserves.left - reserves.right
      const overW = needW(bEnd) >= contentW - 0.5
      const overH = bEnd.occupiedH >= inner.h - 0.5
      shrinkReason = overW && overH ? 'both' : overH ? 'height' : 'width'
    }
    return { sizeMm: s, reserved: reserves, nominalAtStart: nomEnd, yieldedSide, shrunkSize, shrinkReason }
  }

  // 基准字号放得进「两侧名义留边」：按目标一反算（可能放大填满），两侧保名义、不让位
  if (nominalOnly) return finish(sNom, 'keepNominal')
  if (baseS <= sNom + 0.05) return finish(sNom, 'keepNominal')

  // 基准字号太大：先保优先侧名义、压非优先侧；finish 会先试基准字号（只压留边不缩字号），
  // 压到下限仍放不下再逐档缩字号。
  return finish(baseS, 'yieldOther')
}

/** 手动字号：不挤压，留边一律按当前字号下的名义设定（放不下就报超出） */
function nominalReserves(def: LayoutDef, sizeMm: number, innerW: number): ReserveCase {
  const cfg = def.settings.margins
  return resolveMarginReserves(
    { left: nominalMarginMm(clampSide(cfg.left), sizeMm), right: nominalMarginMm(clampSide(cfg.right), sizeMm) },
    cfg,
    innerW
  )
}

export function computeLayout(def: LayoutDef, opts: LayoutOptions = {}): LayoutResult {
  const panel: SignPanel = def.panel
  const st = normalizeSettings(def.settings)
  const inner = {
    x: panel.frameMm,
    y: panel.frameMm,
    w: Math.max(1, panel.wMm - panel.frameMm * 2),
    h: Math.max(1, panel.hMm - panel.frameMm * 2)
  }
  const itemsByLine = new Map<number, CharItem[]>()
  for (const it of def.items) {
    const arr = itemsByLine.get(it.line) ?? []
    arr.push(it)
    itemsByLine.set(it.line, arr)
  }
  const lineNos = [...itemsByLine.keys()].sort((a, b) => a - b)
  const justify = st.align === 'justify'

  let sizeMm = st.baseSizeMm
  let fit: FitResult | null = null
  let reserves: ReserveCase
  if (opts.autoSize) {
    fit = fitAuto(def, inner, itemsByLine, lineNos, justify)
    sizeMm = fit.sizeMm
    reserves = fit.reserved
  } else {
    reserves = nominalReserves(def, sizeMm, inner.w)
  }

  const contentBox: Box = {
    x: inner.x + reserves.left,
    y: inner.y,
    w: Math.max(1, inner.w - reserves.left - reserves.right),
    h: inner.h
  }
  const built = buildAtSize(def, contentBox, inner, itemsByLine, lineNos, sizeMm, justify)
  const { lines, placed } = built
  const inkLeft = placed.length ? Math.min(...placed.map((c) => c.x)) : contentBox.x
  const inkRight = placed.length ? Math.max(...placed.map((c) => c.x + c.inkW)) : contentBox.x
  const inkTop = placed.length ? Math.min(...placed.map((c) => c.y)) : inner.y
  const inkBottom = placed.length ? Math.max(...placed.map((c) => c.y + c.inkH)) : inner.y
  const occupiedW = Math.max(0, inkRight - inkLeft)
  const occupiedH = Math.max(0, inkBottom - inkTop)
  // 实际留边以墨迹相对「有效安装区」计量（两端对齐/居中时即等于反算预留）
  const marginLeft = round1(inkLeft - inner.x)
  const marginRight = round1(inner.x + inner.w - inkRight)
  const marginTop = round1(inkTop - inner.y)
  const marginBottom = round1(inner.y + inner.h - inkBottom)
  const deltaX = round1(Math.abs(marginLeft - marginRight))
  const overflowXMm = round1(Math.max(0, occupiedW - contentBox.w))
  const overflowYMm = round1(Math.max(0, occupiedH - inner.h))

  // 留边反算明细
  const nominalAtFinal = {
    left: nominalMarginMm(clampSide(st.margins.left), sizeMm),
    right: nominalMarginMm(clampSide(st.margins.right), sizeMm)
  }
  const reservedL = round1(reserves.left)
  const reservedR = round1(reserves.right)
  const minL = clampSide(st.margins.left).minMm
  const minR = clampSide(st.margins.right).minMm
  const atLimitLeft = opts.autoSize && reservedL <= minL + 0.05 && nominalAtFinal.left > minL + 0.05
  const atLimitRight = opts.autoSize && reservedR <= minR + 0.05 && nominalAtFinal.right > minR + 0.05
  // 手动模式极端配置下也可能被收敛到下限
  const atLimitManualL = !opts.autoSize && reservedL <= minL + 0.05 && nominalAtFinal.left > minL + 0.05
  const atLimitManualR = !opts.autoSize && reservedR <= minR + 0.05 && nominalAtFinal.right > minR + 0.05

  const sideName = (k: 'left' | 'right'): string => (k === 'left' ? '左' : '右')
  const startNom = fit ? fit.nominalAtStart : nominalAtFinal
  // 让位侧是否真的压到了下限（区别于比例留边只是随字号一起缩）
  const yAtLimit = fit?.yieldedSide === 'left' ? atLimitLeft : fit?.yieldedSide === 'right' ? atLimitRight : false
  let note: string
  if (!opts.autoSize) {
    note = `手动字号：左右留边按设定走（左 ${reservedL}mm / 右 ${reservedR}mm）`
  } else if (fit && fit.yieldedSide) {
    const y = fit.yieldedSide
    const ySideCfg = clampSide(st.margins[y])
    // 「让出前」按基准字号下的名义留边估算（比例留边会随缩字号变小，用基准口径才看得出让了多少）
    const fromMm = round1(ySideCfg.mode === 'fixed' ? ySideCfg.fixedMm : ySideCfg.ratio * st.baseSizeMm)
    if (fit.shrunkSize) {
      const limitPart = yAtLimit ? `、压到下限 ${y === 'left' ? reservedL : reservedR}mm` : ''
      note = `宽度不够：先让${sideName(y)}侧（保${sideName(st.margins.prioritySide)}侧，该侧设定约 ${fromMm}mm${limitPart}）仍不够，再整体缩字号到 ${round1(
        sizeMm
      )}mm；最终${sideName(y)}留边 ${y === 'left' ? reservedL : reservedR}mm`
    } else {
      const limitPart = yAtLimit ? `、已压到下限` : ''
      note = `宽度不够：先让${sideName(y)}侧（保${sideName(st.margins.prioritySide)}侧），该侧留边从约 ${fromMm}mm 压到 ${
        y === 'left' ? reservedL : reservedR
      }mm${limitPart}；字号未缩`
    }
  } else if (fit && fit.shrunkSize) {
    const why = fit.shrinkReason === 'height' ? '安装区高度放不下' : fit.shrinkReason === 'both' ? '宽、高都放不下' : '宽度放不下'
    note = `${why}：整体缩字号到 ${round1(sizeMm)}mm（左右留边仍按设定，随字号走）`
  } else {
    note = `两侧留边都按设定走（左 ${reservedL}mm / 右 ${reservedR}mm），字号未缩、没有让位`
  }

  const marginFit: MarginFit = {
    auto: !!opts.autoSize,
    nominalLeft: round1(nominalAtFinal.left),
    nominalRight: round1(nominalAtFinal.right),
    reservedLeft: reservedL,
    reservedRight: reservedR,
    yieldedSide: opts.autoSize && fit ? fit.yieldedSide : null,
    shrunkSize: !!(opts.autoSize && fit && fit.shrunkSize),
    shrinkReason: opts.autoSize && fit ? fit.shrinkReason : 'none',
    atLimitLeft: atLimitLeft || atLimitManualL,
    atLimitRight: atLimitRight || atLimitManualR,
    note
  }

  const glyphs = placed.map((p) => buildGlyphInfo(p, sizeMm, st.strokeLimitMm))
  const ledLengthMm = round1(placed.reduce((s, c) => s + c.geom.outerPerimeter * (sizeMm / 1000), 0))

  const warnings: string[] = []
  if (built.missingCount > 0) warnings.push(`有 ${built.missingCount} 个字符缺失（字体未加载或该字不在字库中）`)
  if (overflowXMm > 0) warnings.push(`超出内容区宽度 ${overflowXMm}mm（左右留边已到下限仍放不下）`)
  if (overflowYMm > 0) warnings.push(`超出安装区高度 ${overflowYMm}mm`)
  for (const g of glyphs) warnings.push(...g.warnings)
  // 留边被压到下限必须明确提示，别让人以为还在按设定比例走
  if (atLimitLeft || atLimitManualL) {
    warnings.push(
      `左留边已压到下限 ${round1(minL)}mm（设定名义 ${round1(startNom.left)}mm）：现在不是按设定在走，左侧已让到极限`
    )
  }
  if (atLimitRight || atLimitManualR) {
    warnings.push(
      `右留边已压到下限 ${round1(minR)}mm（设定名义 ${round1(startNom.right)}mm）：现在不是按设定在走，右侧已让到极限`
    )
  }
  // 只有「用户本意是左右对称」（最终字号下两侧名义留边一致）却出现不对称时才提示；
  // 故意把左右分开设成不一样（立柱/卷帘门）时不再误报。
  const symmetricIntent = Math.abs(nominalAtFinal.left - nominalAtFinal.right) <= 1
  if (placed.length > 0 && symmetricIntent && !(fit?.yieldedSide) && !atLimitLeft && !atLimitRight && deltaX > 1 && st.align === 'center') {
    warnings.push(`居中排布下左右留边不对称（差 ${deltaX}mm）`)
  }
  if (!justify && st.trackRatio < 0.04) warnings.push('默认字距比例过小，字与字容易粘连')
  if (!justify && st.trackRatio > 0.35) warnings.push('默认字距比例过大，整排会显得松散')

  let suggestedSizeMm: number | null = null
  if ((overflowXMm > 0 || overflowYMm > 0) && !opts.autoSize) {
    // 建议字号按「两侧名义留边都保住」反算（手动采用该字号后按名义留边排，不会再超）
    suggestedSizeMm = fitAuto(def, inner, itemsByLine, lineNos, justify, true).sizeMm
  }

  const justifyGapMm = built.lineGaps.size
    ? round2(Math.min(...[...built.lineGaps.values()]))
    : null

  return {
    inner,
    lines,
    chars: placed,
    inkLeft: round1(inkLeft),
    inkRight: round1(inkRight),
    inkTop: round1(inkTop),
    inkBottom: round1(inkBottom),
    occupiedW: round1(occupiedW),
    occupiedH: round1(occupiedH),
    margins: { left: marginLeft, right: marginRight, top: marginTop, bottom: marginBottom, deltaX, symmetric: deltaX <= 1 },
    marginFit,
    contentBox,
    overflowX: overflowXMm > 0,
    overflowY: overflowYMm > 0,
    overflowXMm,
    overflowYMm,
    gapSpread: built.gapSpread,
    glyphs,
    ledLengthMm,
    warnings,
    sizeMm: round1(sizeMm),
    suggestedSizeMm,
    missingCount: built.missingCount,
    justifyGapMm
  }
}

function buildGlyphInfo(p: PlacedChar, sizeMm: number, strokeLimitMm: number): GlyphInfo {
  const k = sizeMm / 1000
  const warnings: string[] = []
  if (p.missing) {
    warnings.push(`「${p.char}」不在当前字体中：请更换字体或更换文字（不会静默退化）`)
  }
  const minStrokeMm = round1(p.geom.minStroke * k)
  if (!p.missing && !p.blank && minStrokeMm > 0 && minStrokeMm < strokeLimitMm) {
    warnings.push(
      `「${p.char}」最细笔画 ${minStrokeMm}mm < 工艺下限 ${strokeLimitMm}mm：太细做不出/易断；建议加粗（换更粗字重）、换字体或减小字高比例`
    )
  }
  if (p.overlapAfter) warnings.push(`「${p.char}」与下一个字字距为负，轮廓可能相交/粘连`)
  return {
    char: p.char,
    fontId: p.geom.fontId,
    weight: p.geom.weight,
    sizeMm: round1(sizeMm),
    bboxMm: { x: round1(p.x), y: round1(p.y), w: round1(p.inkW), h: round1(p.inkH) },
    contours: p.geom.rings.map((r) => ({
      areaMm2: round1(r.area * k * k),
      perimeterMm: round1(r.perimeter * k),
      isHole: r.isHole,
      blockIndex: r.block
    })),
    strokeBlocks: p.geom.strokeBlocks,
    minStrokeMm,
    minStrokePoint: p.geom.minStrokePoint
      ? {
          x: round1(p.x + (p.geom.minStrokePoint.x - p.geom.bbox.x0) * k),
          y: round1(p.y + (p.geom.minStrokePoint.y - p.geom.bbox.y0) * k)
        }
      : null,
    missing: p.missing,
    warnings
  }
}

function missingGeom(char: string, fontId: string, weight: number): GlyphGeom {
  return {
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
}

export function alignLabel(a: Align): string {
  switch (a) {
    case 'left':
      return '左对齐'
    case 'center':
      return '居中'
    case 'right':
      return '右对齐'
    default:
      return '两端对齐'
  }
}

export function mountingLabel(m: SignPanel['mounting']): string {
  switch (m) {
    case 'wall':
      return '贴墙安装'
    case 'board':
      return '挂板安装'
    default:
      return '落地立牌'
  }
}

export function fontFamilyLabel(f: FontFamily | null): string {
  return f ? `${f.label}（${f.family}）` : '未知字体'
}

/** 新建项目默认参数 */
export function defaultProject(id: string, panel?: Partial<SignPanel>): Project {
  return {
    id,
    name: '新门头',
    layout: {
      panel: { wMm: 3000, hMm: 800, mounting: 'board', frameMm: 60, ...panel },
      items: [],
      settings: {
        align: 'center',
        baseSizeMm: 300,
        fontId: 'hei',
        weight: 400,
        strokeLimitMm: 8,
        trackRatio: 0.1,
        margins: { left: defaultMarginSide(0.04), right: defaultMarginSide(0.04), prioritySide: 'left' },
        lineGapRatio: 0.18
      }
    },
    led: {
      moduleSpacingMm: 150,
      modulePowerW: 0.72,
      moduleLumen: 60,
      safetyFactor: 1.2,
      psuEfficiency: 0.85
    },
    panelMaterialId: 'acrylic_led',
    sheetId: 'acr-1220x2440x3',
    ledModuleId: 'led-12v-072-60',
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

/** 把文本转成逐字项（保留已有微调值，多行用 \n 分隔） */
export function textToItems(text: string, prev: CharItem[], settings: LayoutSettings, sizeMm: number): CharItem[] {
  const lines = text.split('\n')
  const out: CharItem[] = []
  let seq = 0
  lines.forEach((lineText, li) => {
    for (const ch of lineText) {
      if (ch === '\r') continue
      const old = prev.find((p) => p.seq === seq && p.char === ch)
      out.push({
        char: ch,
        trackMm: old && old.trackTouched ? old.trackMm : round1(settings.trackRatio * sizeMm),
        offsetYMm: old ? old.offsetYMm : 0,
        mode: old ? old.mode : 'solid',
        line: li,
        trackTouched: old ? old.trackTouched : false,
        seq
      })
      seq++
    }
  })
  return out
}