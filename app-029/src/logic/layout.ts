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
import type { Align, CharItem, GlyphInfo, LayoutDef, LayoutSettings, MarginCfg, MarginSettings, MarginSide, Project, SignPanel } from './types'

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

/** 单侧留边的反算结果：设定值 vs 实际值，以及让位/触限标记 */
export interface MarginSideResult {
  /** 按配置算出的「本该留」的宽度 mm（比例模式 = ratio × 最终字号；固定模式 = fixedMm） */
  desired: number
  /** 排版后实际留边 mm */
  actual: number
  /** 是否因宽度不够被压到小于设定值 */
  compressed: boolean
  /** 是否被压到了下限 minMm */
  atLimit: boolean
  /** 该侧下限 mm */
  minMm: number
}

export interface MarginInfo {
  left: number
  right: number
  top: number
  bottom: number
  /** |左右留边差| */
  deltaX: number
  symmetric: boolean
  leftSide: MarginSideResult
  rightSide: MarginSideResult
  /** 是否有任何一侧未按设定值留边（让位/超限） */
  marginsCompressed: boolean
}

/** 自动字号让位说明：按哪一侧先让、让到什么程度、是否又缩了字号 */
export interface FitReport {
  /** 自动反算 or 手动字号超区时的建议反算 */
  mode: 'auto' | 'suggest'
  sizeMm: number
  stage: 1 | 2 | 3
  /** 先让的那一侧（即 keepSide 的对侧） */
  yieldedSide: MarginSide
  /** 先让侧是否被压到下限（stage 3 必然为 true；两侧固定边之和过大时两侧都触限） */
  yieldedAtLimit: boolean
  /** 保的一侧是否也被迫让位（仅 stage 3 且仍塞不下时可能发生） */
  keepSideYielded: boolean
  note: string
}

export interface LayoutResult {
  inner: { x: number; y: number; w: number; h: number }
  /** 文字实际使用的水平界线（扣掉两侧留边后的排版带）；逐字微调/上下偏移/撑满都按这条带刷新 */
  band: { x: number; y: number; w: number; h: number }
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
  /** 建议字号的让位说明（手动超区时展示） */
  suggestedFit: FitReport | null
  /** 自动字号时的让位说明 */
  fit: FitReport | null
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

/** 单侧留边的设定宽度：比例模式跟随字号，固定模式为常量 */
export function sideDesiredMm(cfg: MarginCfg, sizeMm: number): number {
  return Math.max(0, cfg.mode === 'fixed' ? cfg.fixedMm : cfg.ratio * sizeMm)
}

/** 两侧留边设定值（mm），按当前字号反算 */
export function desiredMargins(m: MarginSettings, sizeMm: number): { left: number; right: number } {
  return { left: sideDesiredMm(m.left, sizeMm), right: sideDesiredMm(m.right, sizeMm) }
}

/** 旧项目（只有 marginRatio）按「两边同宽的比例留边」接着用；非法输入也在这里兜底 */
export function normalizeLayoutSettings(settings: LayoutSettings & { marginRatio?: number }): LayoutSettings {
  const out = settings as LayoutSettings
  if (!out.margins) {
    const ratio = typeof settings.marginRatio === 'number' && Number.isFinite(settings.marginRatio) ? settings.marginRatio : 0.04
    out.margins = {
      left: { mode: 'ratio', ratio, fixedMm: 0, minMm: 0 },
      right: { mode: 'ratio', ratio, fixedMm: 0, minMm: 0 },
      keepSide: 'left'
    }
  }
  for (const side of ['left', 'right'] as const) {
    const c = out.margins[side]
    if (!c) {
      out.margins[side] = { mode: 'ratio', ratio: 0.04, fixedMm: 0, minMm: 0 }
    } else {
      if (c.mode !== 'ratio' && c.mode !== 'fixed') c.mode = 'ratio'
      if (!Number.isFinite(c.ratio) || c.ratio < 0) c.ratio = 0
      if (!Number.isFinite(c.fixedMm) || c.fixedMm < 0) c.fixedMm = 0
      if (!Number.isFinite(c.minMm) || c.minMm < 0) c.minMm = 0
    }
  }
  if (out.margins.keepSide !== 'left' && out.margins.keepSide !== 'right') out.margins.keepSide = 'left'
  delete (out as Partial<LayoutSettings> & { marginRatio?: number }).marginRatio
  return out
}

interface BuildResult {
  lines: LineLayout[]
  placed: PlacedChar[]
  occupiedW: number
  occupiedH: number
  missingCount: number
  /** 每行的目标视觉间距（仅两端对齐时非空） */
  lineGaps: Map<number, number>
  /** 同一行内相邻字视觉间距极差的最大值 */
  gapSpread: number
}

function buildAtSize(
  def: LayoutDef,
  /** 水平排版界线（带）：左/右/两端对齐相对它定位；字号反算时传入留边压缩后的带 */
  band: { x: number; w: number },
  inner: { x: number; y: number; w: number; h: number },
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

  for (const ln of lineNos) {
    const items = itemsByLine.get(ln) ?? []
    const geoms = items.map((it) => {
      const g = getGlyphGeom(st.fontId, st.weight, it.char)
      const ok = !!g && !g.missing
      if (!ok) missingCount++
      return { geom: ok ? (g as GlyphGeom) : missingGeom(it.char, st.fontId, st.weight), ok, blank: ok && (g as GlyphGeom).blank }
    })
    const pairs = Math.max(0, items.length - 1)
    // 两端对齐：撑满留边后的排版带（先按剩余宽度平均，再迭代 2 次让整行贴合带右界）
    let gTarget = 0
    if (justify && pairs > 0) {
      const inkSum = geoms.reduce((s, g) => s + (g.ok ? g.geom.inkW * k : sizeMm), 0)
      gTarget = Math.max(0, (band.w - inkSum) / pairs)
    }

    let chars: PlacedChar[] = []
    for (let iter = 0; iter < (justify && pairs > 0 ? 3 : 1); iter++) {
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
          if (g.ok && ng.ok) {
            const gap = justify ? gTarget : effectiveTrack(it, st, sizeMm)
            const res = solveVisualOffset(g.geom, ng.geom, sizeMm, gap)
            cursor += res.offset
            node.gapAfter = round2(res.gap)
            node.overlapAfter = res.overlap
          } else {
            const gap = justify ? gTarget : effectiveTrack(it, st, sizeMm)
            cursor += inkW + gap
          }
        }
      }
      if (justify && pairs > 0) {
        const right = chars.length ? Math.max(...chars.map((c) => c.x + c.inkW)) : 0
        const delta = band.w - right
        if (Math.abs(delta) < 0.05) break
        gTarget = Math.max(0, gTarget + delta / pairs)
      } else {
        break
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

  // 水平对齐（逐行，界线 = 留边后的排版带：左对齐/居中/右对齐/两端对齐）
  for (const l of lines) {
    let shiftX = band.x - l.inkLeft
    const w = l.inkRight - l.inkLeft
    if (st.align === 'center') shiftX = band.x + (band.w - w) / 2 - l.inkLeft
    else if (st.align === 'right') shiftX = band.x + band.w - l.inkRight
    for (const c of l.chars) c.x += shiftX
    l.inkLeft += shiftX
    l.inkRight += shiftX
  }

  // 垂直居中
  const top = lines.length ? Math.min(...lines.map((l) => l.inkTop)) : 0
  const bottom = lines.length ? Math.max(...lines.map((l) => l.inkBottom)) : 0
  const occupiedH = Math.max(0, bottom - top)
  const shiftY = inner.y + (inner.h - occupiedH) / 2 - top
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
    lineGaps,
    gapSpread: round2(gapSpread)
  }
}

interface FitContext {
  inner: { x: number; y: number; w: number; h: number }
  itemsByLine: Map<number, CharItem[]>
  lineNos: number[]
  justify: boolean
}

interface FitOutcome {
  sizeMm: number
  /** 最终排版带相对安装区的左留边 / 右留边（让位后实际使用值，可能已触下限） */
  bandLeft: number
  bandRight: number
  stage: 1 | 2 | 3
  /** 先让侧被压到下限 */
  yieldedAtLimit: boolean
  /** 保的一侧也被迫让位（stage 3 才可能） */
  keepSideYielded: boolean
  /** stage 3 是高度不够导致的（先让侧触限后仍然整体缩字号） */
  heightDriven: boolean
  empty: boolean
}

function measure(
  def: LayoutDef,
  ctx: FitContext,
  sizeMm: number,
  bandLeft: number,
  bandRight: number
): BuildResult {
  const band = { x: ctx.inner.x + bandLeft, w: Math.max(0, ctx.inner.w - bandLeft - bandRight) }
  return buildAtSize(def, band, ctx.inner, ctx.itemsByLine, ctx.lineNos, sizeMm, ctx.justify)
}

/** 在给定左右留边函数下，求能塞进安装区的最大字号（二分，占用宽高随字号单调） */
function maxSizeWithReserve(
  def: LayoutDef,
  ctx: FitContext,
  lo: number,
  hi: number,
  marginsAt: (s: number) => { left: number; right: number },
  reserveVAt: (s: number) => number
): number {
  const fits = (s: number): boolean => {
    const m = marginsAt(s)
    const bandW = Math.max(0, ctx.inner.w - m.left - m.right)
    const r = measure(def, ctx, s, m.left, m.right)
    if (r.occupiedW < 0.5 && r.occupiedH < 0.5) return true
    // 纵向总预留 = 左+右（上下各预留左右留边均值，整圈留边语义）
    return r.occupiedW <= bandW + 0.05 && r.occupiedH <= Math.max(1, ctx.inner.h - reserveVAt(s)) + 0.05
  }
  if (!fits(lo)) return Math.max(5, lo) // 5mm 仍放不下：配置本身不可行（如固定边之和 ≥ 安装区），由上层提示
  for (let i = 0; i < 18; i++) {
    if (hi - lo < 0.1) break
    const mid = (lo + hi) / 2
    if (fits(mid)) lo = mid
    else hi = mid
  }
  return Math.floor(lo * 10) / 10 // 向下取 0.1mm，保证实际不超出
}

/** 阶段 1 用：横向让位不占纵向，纵向只要求进安装区（reserve 0） */
function maxSizeWith(
  def: LayoutDef,
  ctx: FitContext,
  lo: number,
  hi: number,
  marginsAt: (s: number) => { left: number; right: number }
): number {
  return maxSizeWithReserve(def, ctx, lo, hi, marginsAt, () => 0)
}

/** 阶段 1：两侧都按设定留边时求最大字号。先用牛顿式比例迭代（通常 4~6 次），不收敛再二分兜底 */
function fitStage1(def: LayoutDef, ctx: FitContext, base: number, desiredAt: (s: number) => { left: number; right: number }): number {
  const ratioOf = (s: number): number => {
    const m = desiredAt(s)
    const bandW = Math.max(0, ctx.inner.w - m.left - m.right)
    const r = measure(def, ctx, s, m.left, m.right)
    if (r.occupiedW < 0.5 && r.occupiedH < 0.5) return 0
    // 横向留边只占宽度；高度按整安装区判断
    return Math.max(r.occupiedW / Math.max(bandW, 1e-6), r.occupiedH / Math.max(ctx.inner.h, 1e-6))
  }
  let s = base
  let ok = true
  for (let i = 0; i < 10; i++) {
    const q = ratioOf(s)
    if (q === 0) {
      ok = false
      break
    }
    if (Math.abs(q - 1) < 0.002) break
    const next = s / q
    if (!Number.isFinite(next) || next <= 0) {
      ok = false
      break
    }
    s = Math.min(base * 5, Math.max(5, next))
  }
  // 验证牛顿结果；偏差大或发散则二分重算（保证结果可用）
  if (!ok || ratioOf(s) > 1.002) {
    s = maxSizeWith(def, ctx, 5, Math.max(5, base * 5), desiredAt)
  }
  return Math.floor(s * 10) / 10
}

/**
 * 自动字号反算（建议字号共用），三级让位：
 * 1. 两侧都按设定留边，直接反算最大字号（字号小→留边也小，不需要让位）；
 * 2. 基础字号下宽度塞不下：先压「非保侧」留边（保侧不动），压到该侧下限为止；
 * 3. 非保侧到下限仍不够：整体缩字号（比例留边随字号继续缩，先让侧保持下限）。
 * 高度本身放不下时只缩字号、不压左右留边（横向让位与上下无关），最终报告里会标明。
 */
function fitAuto(def: LayoutDef, inner: { x: number; y: number; w: number; h: number }, itemsByLine: Map<number, CharItem[]>, lineNos: number[]): FitOutcome {
  const ctx: FitContext = { inner, itemsByLine, lineNos, justify: def.settings.align === 'justify' }
  const mg = def.settings.margins
  const keep: MarginSide = mg.keepSide
  const yieldSide: MarginSide = keep === 'left' ? 'right' : 'left'
  const cfgKeep = keep === 'left' ? mg.left : mg.right
  const cfgYield = yieldSide === 'left' ? mg.left : mg.right
  const base = Math.max(5, def.settings.baseSizeMm)
  const clampSide = (cfg: MarginCfg, m: number): number => Math.max(cfg.minMm, Math.min(inner.w, m))

  // 空排版（还没输入文字）不参与反算，避免字号发散
  const probeDesired = desiredMargins(mg, base)
  const probe = measure(def, ctx, base, probeDesired.left, probeDesired.right)
  if (probe.occupiedW < 0.5 && probe.occupiedH < 0.5) {
    return { sizeMm: base, bandLeft: probeDesired.left, bandRight: probeDesired.right, stage: 1, yieldedAtLimit: false, keepSideYielded: false, heightDriven: false, empty: true }
  }

  const desiredAt = (s: number) => {
    const d = desiredMargins(mg, s)
    return { left: Math.max(mg.left.minMm, Math.min(inner.w, d.left)), right: Math.max(mg.right.minMm, Math.min(inner.w, d.right)) }
  }

  // 基础字号 + 设定留边：宽度进横向带、高度进安装区（横向留边不占纵向空间）
  const dBase = desiredAt(base)
  const rBase = measure(def, ctx, base, dBase.left, dBase.right)
  const baseWidthFit = rBase.occupiedW <= inner.w - dBase.left - dBase.right + 0.05
  const baseHeightFit = rBase.occupiedH <= inner.h + 0.05
  if (baseWidthFit && baseHeightFit) {
    // 阶段 1：放得下 → 像旧版一样尽量放大（上限 5 倍基础字号）
    const s1 = fitStage1(def, ctx, base, desiredAt)
    const usedSize = s1 >= base ? s1 : base
    const d = desiredAt(usedSize)
    return { sizeMm: usedSize, bandLeft: d.left, bandRight: d.right, stage: 1, yieldedAtLimit: false, keepSideYielded: false, heightDriven: false, empty: false }
  }

  // 高度连整个安装区（横向压边不占纵向）都放不下时，才只能靠缩字号解决高度
  const rHeightZeroMargins = measure(def, ctx, base, 0, 0)
  const heightRequiresShrink = rHeightZeroMargins.occupiedH > inner.h + 0.05

  // 阶段 2：基础字号下先压非保侧（保侧维持设定值），看横向能否塞下
  const keepAtBase = clampSide(cfgKeep, sideDesiredMm(cfgKeep, base))
  const yieldDesiredBase = clampSide(cfgYield, sideDesiredMm(cfgYield, base))
  const floorLeft = yieldSide === 'left' ? cfgYield.minMm : keepAtBase
  const floorRight = yieldSide === 'right' ? cfgYield.minMm : keepAtBase
  const rFloor = measure(def, ctx, base, floorLeft, floorRight)
  // 阶段 2 只做横向让位：宽度进得了横向带、高度进得了安装区即可（横向压边不削上下）
  const floorWidthFit = rFloor.occupiedW <= inner.w - floorLeft - floorRight + 0.05
  const floorHeightFit = rFloor.occupiedH <= inner.h + 0.05
  if (!heightRequiresShrink && floorWidthFit && floorHeightFit) {
    // 找非保侧刚好够用的留边量（≥ 下限）：在 [minMm, 设定值] 上二分
    const needs = (yieldMm: number): boolean => {
      const mL = yieldSide === 'left' ? yieldMm : keepAtBase
      const mR = yieldSide === 'right' ? yieldMm : keepAtBase
      const r = measure(def, ctx, base, mL, mR)
      return r.occupiedW <= inner.w - mL - mR + 0.05 && r.occupiedH <= inner.h + 0.05
    }
    let lo = cfgYield.minMm
    let hi = yieldDesiredBase
    if (needs(lo)) {
      for (let i = 0; i < 16; i++) {
        if (hi - lo < 0.1) break
        const mid = (lo + hi) / 2
        // 留边越大带越窄：mid 能塞下说明留边还可以再大 → 向上找
        if (needs(mid)) lo = mid
        else hi = mid
      }
      const yieldMm = Math.max(cfgYield.minMm, Math.floor(lo * 10) / 10)
      return {
        sizeMm: base,
        bandLeft: yieldSide === 'left' ? yieldMm : keepAtBase,
        bandRight: yieldSide === 'right' ? yieldMm : keepAtBase,
        stage: 2,
        yieldedAtLimit: Math.abs(yieldMm - cfgYield.minMm) <= 0.15,
        keepSideYielded: false,
        heightDriven: false,
        empty: false
      }
    }
  }

  // 阶段 3：整体缩字号。
  // 非保侧固定在下限；保侧为比例留边时随字号继续缩（直到自己的下限），固定边不动。
  // 若基础字号下高度本来就放不下（heightDriven），跳过横向让位、两侧留边始终按设定走。
  const stage3Margins = heightRequiresShrink
    ? (s: number) => desiredAt(s)
    : (s: number) => {
        const keepMm = clampSide(cfgKeep, sideDesiredMm(cfgKeep, s))
        return {
          left: keep === 'left' ? keepMm : cfgYield.minMm,
          right: keep === 'right' ? keepMm : cfgYield.minMm
        }
      }
  // 阶段 3 横向让位不削上下：纵向只要求放进安装区（reserve 0）；高度本来不够时高度同样按整安装区收紧
  const s3 = maxSizeWithReserve(def, ctx, 5, base, stage3Margins, () => 0)
  const m3 = stage3Margins(s3)
  // 报告口径：宽度在该字号+该留部下仍顶格，说明宽度参与了缩字号；否则就是高度单独逼的
  const r3 = measure(def, ctx, s3, m3.left, m3.right)
  const bandW3 = Math.max(0, inner.w - m3.left - m3.right)
  const widthTight = r3.occupiedW > bandW3 - 1
  const heightDriven = heightRequiresShrink || !widthTight
  const keepDesiredAtS3 = clampSide(cfgKeep, sideDesiredMm(cfgKeep, s3))
  const keepSideYielded =
    !heightRequiresShrink && (keep === 'left' ? m3.left < keepDesiredAtS3 - 0.15 : m3.right < keepDesiredAtS3 - 0.15)
  const yieldedAtLimit = !heightRequiresShrink
  return { sizeMm: s3, bandLeft: m3.left, bandRight: m3.right, stage: 3, yieldedAtLimit, keepSideYielded, heightDriven, empty: false }
}

const sideLabel = (s: MarginSide): string => (s === 'left' ? '左' : '右')

function describeFit(f: FitOutcome, mg: MarginSettings, mode: 'auto' | 'suggest'): FitReport {
  const keep = mg.keepSide
  const yieldedSide: MarginSide = keep === 'left' ? 'right' : 'left'
  const prefix = mode === 'auto' ? '自动字号：' : '建议方案：'
  let note: string
  if (f.stage === 1) {
    note = `${prefix}两侧留边都按设定保留，字号 ${f.sizeMm}mm，未发生让位`
  } else if (f.stage === 2) {
    const at = f.yieldedAtLimit ? '（已压到下限）' : ''
    note = `${prefix}宽度不够，先让${sideLabel(yieldedSide)}侧留边（保${sideLabel(keep)}侧不动），${sideLabel(yieldedSide)}侧压到 ${
      yieldedSide === 'left' ? round1(f.bandLeft) : round1(f.bandRight)
    }mm${at}；字号仍为 ${f.sizeMm}mm，没有整排一起缩`
  } else {
    if (f.heightDriven && !f.yieldedAtLimit && !f.keepSideYielded) {
      note = `${prefix}安装区高度放不下设定字号（左右留边未让位，两侧仍按设定保留），整体缩字号到 ${f.sizeMm}mm`
    } else {
      const extra = f.keepSideYielded ? `；保的${sideLabel(keep)}侧留边也被继续压缩` : '；保的一侧未动'
      const why = f.heightDriven ? '（高度也不够，由高度一起收紧）' : ''
      note = `${prefix}宽度不够，先让${sideLabel(yieldedSide)}侧、压到下限后仍塞不下，才整体缩字号到 ${f.sizeMm}mm（${sideLabel(yieldedSide)}侧先让出来的，不是整排一起缩）${extra}${why}`
    }
  }
  return {
    mode,
    sizeMm: f.sizeMm,
    stage: f.stage,
    yieldedSide,
    yieldedAtLimit: f.yieldedAtLimit,
    keepSideYielded: f.keepSideYielded,
    note
  }
}

export function computeLayout(def: LayoutDef, opts: LayoutOptions = {}): LayoutResult {
  const panel: SignPanel = def.panel
  const st = normalizeLayoutSettings(def.settings)
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

  const desiredAtBase = desiredMargins(st.margins, st.baseSizeMm)
  const buildAt = (
    sizeMm: number,
    bandLeftMm: number,
    bandRightMm: number
  ): {
    built: BuildResult
    placed: PlacedChar[]
    band: { x: number; y: number; w: number; h: number }
    inkLeft: number
    inkRight: number
    inkTop: number
    inkBottom: number
    occupiedW: number
    occupiedH: number
    bandOverflowXMm: number
    overflowXMm: number
    overflowYMm: number
  } => {
    const bd = {
      x: inner.x + bandLeftMm,
      y: inner.y,
      w: Math.max(0, inner.w - bandLeftMm - bandRightMm),
      h: inner.h
    }
    const res = buildAtSize(def, bd, inner, itemsByLine, lineNos, sizeMm, justify)
    const pl = res.placed
    const iL = pl.length ? Math.min(...pl.map((c) => c.x)) : bd.x
    const iR = pl.length ? Math.max(...pl.map((c) => c.x + c.inkW)) : bd.x
    const iT = pl.length ? Math.min(...pl.map((c) => c.y)) : inner.y
    const iB = pl.length ? Math.max(...pl.map((c) => c.y + c.inkH)) : inner.y
    const oW = Math.max(0, iR - iL)
    const oH = Math.max(0, iB - iT)
    return {
      built: res,
      placed: pl,
      band: bd,
      inkLeft: iL,
      inkRight: iR,
      inkTop: iT,
      inkBottom: iB,
      occupiedW: oW,
      occupiedH: oH,
      bandOverflowXMm: Math.max(0, oW - bd.w),
      overflowXMm: Math.max(0, oW - inner.w),
      overflowYMm: Math.max(0, oH - inner.h)
    }
  }

  // 自动模式：直接三级让位反算；手动模式：先按设定留边排，只有顶进留边带/超出安装区时才跑反算（避免无谓性能开销）
  let autoFit: FitOutcome | null = null
  let sizeMm = st.baseSizeMm
  let bandLeft = desiredAtBase.left
  let bandRight = desiredAtBase.right
  if (opts.autoSize) {
    autoFit = fitAuto(def, inner, itemsByLine, lineNos)
    sizeMm = autoFit.sizeMm
    bandLeft = autoFit.bandLeft
    bandRight = autoFit.bandRight
  }

  let built2 = buildAt(sizeMm, bandLeft, bandRight)
  if (!opts.autoSize && (built2.overflowXMm > 0 || built2.overflowYMm > 0 || built2.bandOverflowXMm > 0)) {
    autoFit = fitAuto(def, inner, itemsByLine, lineNos)
  }

  const autoReport = autoFit ? describeFit(autoFit, st.margins, 'auto') : null
  const band = built2.band
  const built = built2.built
  const placed = built2.placed
  const inkLeft = built2.inkLeft
  const inkRight = built2.inkRight
  const inkTop = built2.inkTop
  const inkBottom = built2.inkBottom
  const occupiedW = built2.occupiedW
  const occupiedH = built2.occupiedH
  const marginLeft = round1(inkLeft - inner.x)
  const marginRight = round1(inner.x + inner.w - inkRight)
  const marginTop = round1(inkTop - inner.y)
  const marginBottom = round1(inner.y + inner.h - inkBottom)
  const deltaX = round1(Math.abs(marginLeft - marginRight))
  const overflowXMm = round1(built2.overflowXMm)
  const overflowYMm = round1(built2.overflowYMm)
  // 手动模式下，字超出留边带（顶着柱子/卷帘门一侧）但还没超出安装区，也要点出来
  const bandOverflowXMm = round1(built2.bandOverflowXMm)

  const buildSide = (cfg: MarginCfg, actualMm: number): MarginSideResult => {
    const desired = round1(sideDesiredMm(cfg, sizeMm))
    const actual = round1(actualMm)
    const compressed = actual + 0.6 < desired
    const atLimit = cfg.minMm > 0 && actual <= cfg.minMm + 0.6 && compressed
    return { desired, actual, compressed, atLimit, minMm: cfg.minMm }
  }
  const leftSide = buildSide(st.margins.left, marginLeft)
  const rightSide = buildSide(st.margins.right, marginRight)
  const marginsCompressed = leftSide.compressed || rightSide.compressed

  const glyphs = placed.map((p) => buildGlyphInfo(p, sizeMm, st.strokeLimitMm))
  const ledLengthMm = round1(placed.reduce((s, c) => s + c.geom.outerPerimeter * (sizeMm / 1000), 0))

  const warnings: string[] = []
  // 两侧固定边/下限本身就超过安装区：属于配置不可行，必须明说
  const fixedSum = (st.margins.left.mode === 'fixed' ? st.margins.left.fixedMm : 0) + (st.margins.right.mode === 'fixed' ? st.margins.right.fixedMm : 0)
  if (fixedSum > inner.w + 0.001) {
    warnings.push(`两侧固定留边合计 ${round1(fixedSum)}mm 已超过安装区宽 ${inner.w}mm：排版带为负，固定边无法同时满足，请减小固定留边`)
  } else if (st.margins.left.minMm + st.margins.right.minMm > inner.w + 0.001) {
    warnings.push(`两侧让位下限合计 ${round1(st.margins.left.minMm + st.margins.right.minMm)}mm 已超过安装区宽 ${inner.w}mm：宽度不够时下限无法同时保住`)
  }
  if (built.missingCount > 0) warnings.push(`有 ${built.missingCount} 个字符缺失（字体未加载或该字不在字库中）`)
  if (overflowXMm > 0) warnings.push(`超出安装区宽度 ${overflowXMm}mm`)
  if (overflowYMm > 0) warnings.push(`超出安装区高度 ${overflowYMm}mm`)
  for (const g of glyphs) warnings.push(...g.warnings)
  if (!justify && st.trackRatio < 0.04) warnings.push('默认字距比例过小，字与字容易粘连')
  if (!justify && st.trackRatio > 0.35) warnings.push('默认字距比例过大，整排会显得松散')

  // 留边让位提示（自动字号才有让位；手动模式不主动压边）。
  // 被压到下限 / 没按设定比例走，都要明说，不能让人以为还按设的比例在走。
  if (opts.autoSize) {
    for (const item of [
      { sr: leftSide, name: '左' },
      { sr: rightSide, name: '右' }
    ]) {
      if (item.sr.atLimit) {
        warnings.push(`${item.name}侧留边被压到下限 ${round1(item.sr.minMm)}mm（设定应为 ${item.sr.desired}mm，实际只剩 ${item.sr.actual}mm），已不是按设定比例留边`)
      } else if (item.sr.compressed) {
        warnings.push(`${item.name}侧留边让位：设定 ${item.sr.desired}mm，实际 ${item.sr.actual}mm（宽度不够先压了这一侧）`)
      }
    }
  }
  if (!opts.autoSize && bandOverflowXMm > 0) {
    if (overflowXMm === 0) {
      warnings.push(`文字已顶入留边带 ${bandOverflowXMm}mm：当前字号会压到一侧留边，可采用建议字号自动让位`)
    }
    // 手动模式下真正被吃掉的留边（居中时两侧分摊，或对齐时贴到某一侧），照实点出
    for (const item of [
      { sr: leftSide, name: '左' },
      { sr: rightSide, name: '右' }
    ]) {
      if (item.sr.atLimit) warnings.push(`${item.name}侧留边只剩 ${item.sr.actual}mm，已被压到下限 ${round1(item.sr.minMm)}mm`)
    }
  }

  let suggestedSizeMm: number | null = null
  let suggestedFit: FitReport | null = null
  if (!opts.autoSize && autoFit && (overflowXMm > 0 || overflowYMm > 0 || bandOverflowXMm > 0)) {
    suggestedSizeMm = autoFit.sizeMm
    suggestedFit = describeFit(autoFit, st.margins, 'suggest')
  }

  const justifyGapMm = built.lineGaps.size
    ? round2(Math.min(...[...built.lineGaps.values()]))
    : null

  return {
    inner,
    band,
    lines: built.lines,
    chars: built.placed,
    inkLeft: round1(inkLeft),
    inkRight: round1(inkRight),
    inkTop: round1(inkTop),
    inkBottom: round1(inkBottom),
    occupiedW: round1(occupiedW),
    occupiedH: round1(occupiedH),
    margins: {
      left: marginLeft,
      right: marginRight,
      top: marginTop,
      bottom: marginBottom,
      deltaX,
      symmetric: deltaX <= 1,
      leftSide,
      rightSide,
      marginsCompressed
    },
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
    suggestedFit,
    fit: opts.autoSize && autoFit ? autoReport : null,
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
        margins: {
          left: { mode: 'ratio', ratio: 0.1, fixedMm: 60, minMm: 0 },
          right: { mode: 'ratio', ratio: 0.1, fixedMm: 60, minMm: 0 },
          keepSide: 'left'
        },
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