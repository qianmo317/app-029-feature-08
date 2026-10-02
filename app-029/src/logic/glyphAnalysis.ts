/**
 * 字形轮廓分析（规格书第 8 节关键实现点）：
 *  1. 用 opentype.js 解析本地字体 -> 取 glyph path -> 离散为闭合环（单位：字形本地单位，1000 em）
 *  2. 环的嵌套关系 -> isHole / 外轮廓
 *  3. 扫描线 + 并查集 标记填充区连通域 -> strokeBlocks（笔画块）
 *  4. 沿轮廓法线方向的局部宽度（射线求交）-> minStrokeMm（含端点/收锋的抑制滤波）
 */

import {
  bboxOfRings,
  flattenCommands,
  emptySamples,
  makeSampleSet,
  ringBBox,
  ringPerimeter,
  ringSignedArea,
  windingNumber,
  type PathCmd,
  type Pt,
  type Ring,
  type SampleSet
} from './geometry'

/** 本地单位（1000 em）下的数值；mm 值 = 本地值 × 字号mm / 1000 */
export interface RingGeom {
  ring: Ring
  area: number
  perimeter: number
  isHole: boolean
  depth: number
  block: number
  bbox: { x0: number; y0: number; x1: number; y1: number }
  pathData: string
  minStroke: number
  minStrokePoint: Pt | null
}

export interface GlyphGeom {
  char: string
  fontId: string
  weight: number
  missing: boolean
  blank: boolean
  rings: RingGeom[]
  strokeBlocks: number
  /** 由嵌套关系独立推出的块数（用于内部一致性自检） */
  strokeBlocksByNesting: number
  minStroke: number
  minStrokePoint: Pt | null
  bbox: { x0: number; y0: number; x1: number; y1: number }
  inkW: number
  inkH: number
  samples: SampleSet
  /** 外轮廓周长合计（不含内孔） */
  outerPerimeter: number
  blockBBoxes: Array<{ x0: number; y0: number; x1: number; y1: number }>
  pathData: string
  advance: number
}

const EPS_IN = 0.6
const BANDS = 48

interface EdgeIndex {
  ex: Float64Array
  ey: Float64Array
  dxArr: Float64Array
  dyArr: Float64Array
  bands: Int32Array[]
  y0: number
  bandH: number
}

/** 由扁平分环构建 Y 方向分带索引，加速射线求交（水平边同样需要：近垂直射线会命中水平边） */
function buildEdgeIndex(rings: Ring[], bbox: { y0: number; y1: number }): EdgeIndex {
  const segs: Array<[Pt, Pt]> = []
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      segs.push([r[j], r[i]])
    }
  }
  const n = segs.length
  const bandH = Math.max(1e-6, (bbox.y1 - bbox.y0) / BANDS)
  const ex = new Float64Array(n)
  const ey = new Float64Array(n)
  const dxArr = new Float64Array(n)
  const dyArr = new Float64Array(n)
  const bandLists: number[][] = []
  for (let i = 0; i < BANDS; i++) bandLists.push([])
  for (let i = 0; i < n; i++) {
    const a = segs[i][0]
    const b = segs[i][1]
    ex[i] = a.x
    ey[i] = a.y
    dxArr[i] = b.x - a.x
    dyArr[i] = b.y - a.y
    const s = Math.max(0, Math.min(BANDS - 1, Math.floor((Math.min(a.y, b.y) - bbox.y0) / bandH)))
    const e = Math.max(0, Math.min(BANDS - 1, Math.floor((Math.max(a.y, b.y) - bbox.y0) / bandH - 1e-9)))
    for (let k = s; k <= e; k++) bandLists[k].push(i)
  }
  return { ex, ey, dxArr, dyArr, bands: bandLists.map((l) => Int32Array.from(l)), y0: bbox.y0, bandH }
}

/** 每环最多参与射线测量的采样点数（复杂字形按步长抽稀，性能与精度折中） */
const MAX_RING_SAMPLES = 400

export interface RingBBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * 环绕数（复用 Y 分带边索引）：只需检查跨越该 y 的边，等价于对全部边做环绕数统计，
 * 但耗时从「全环点数」降到「该分带内的边数」（约 20~40 条），是热路径的关键优化。
 */
function windingFast(px: number, py: number, idx: EdgeIndex): number {
  const band = Math.max(0, Math.min(BANDS - 1, Math.floor((py - idx.y0) / idx.bandH)))
  const list = idx.bands[band]
  let wn = 0
  for (let k = 0; k < list.length; k++) {
    const e = list[k]
    const ay = idx.ey[e]
    const by = ay + idx.dyArr[e]
    if (ay <= py) {
      if (by > py) {
        const ax = idx.ex[e]
        const bx = ax + idx.dxArr[e]
        if ((bx - ax) * (py - ay) - (px - ax) * (by - ay) > 0) wn++
      }
    } else if (by <= py) {
      const ax = idx.ex[e]
      const bx = ax + idx.dxArr[e]
      if ((bx - ax) * (py - ay) - (px - ax) * (by - ay) < 0) wn--
    }
  }
  return wn
}

/**
 * 沿轮廓法线测量局部宽度，返回该环上经抑制滤波后的最小宽度与位置。
 * 材料侧与起始环绕数逐样本用「全部环的环绕数」判定：字形轮廓存在重叠时（非零填充）环绕数可为 2，
 * 因此不能用单一常量代替，必须逐样本求值（准确优先）。
 * 抽稀：单环采样点上限 MAX_RING_SAMPLES，兼顾精度与性能。
 * 抑制滤波：对环上的宽度序列做「窗口最大值」，滤掉收锋/尖角造成的非工艺性极小值。
 */
function measureRingStroke(ring: Ring, idx: EdgeIndex, sc: RayScratch): { value: number; point: Pt | null } {
  const n = ring.length
  if (n < 3) return { value: Infinity, point: null }
  const stride = Math.max(1, Math.ceil(n / MAX_RING_SAMPLES))
  const count = Math.floor((n - 1) / stride) + 1
  const widths = new Float64Array(count)
  const pts: Array<Pt | null> = new Array(count).fill(null)

  for (let s = 0; s < count; s++) {
    const i = s * stride
    const p = ring[i]
    const prev = ring[(i - 1 + n) % n]
    const next = ring[(i + 1) % n]
    const tx = next.x - prev.x
    const ty = next.y - prev.y
    const tl = Math.hypot(tx, ty)
    if (tl < 1e-9) {
      widths[s] = -1
      continue
    }
    let nx = -ty / tl
    let ny = tx / tl
    let wn = windingFast(p.x + nx * EPS_IN, p.y + ny * EPS_IN, idx)
    if (wn === 0) {
      nx = -nx
      ny = -ny
      wn = windingFast(p.x + nx * EPS_IN, p.y + ny * EPS_IN, idx)
      if (wn === 0) {
        widths[s] = -1
        continue
      }
    }
    const t = rayExit(p, nx, ny, wn, idx, sc)
    if (t === null) {
      widths[s] = -1
      continue
    }
    widths[s] = t
    pts[s] = p
  }

  // 窗口最大值滤波（抑制收锋/尖角造成的非工艺性极小值；环点数很少时不做滤波）
  const win = Math.max(0, Math.min(8, Math.round(count * 0.02)))
  let best = Infinity
  let bestPt: Pt | null = null
  for (let i = 0; i < count; i++) {
    if (widths[i] < 0) continue
    let mx = 0
    let ok = false
    for (let k = -win; k <= win; k++) {
      const w = widths[(i + k + count * 4) % count]
      if (w >= 0) {
        ok = true
        if (w > mx) mx = w
      }
    }
    if (!ok) continue
    if (mx < best) {
      best = mx
      bestPt = pts[i]
    }
  }
  return { value: Number.isFinite(best) ? best : Infinity, point: bestPt }
}

/**
 * 射线求交的复用缓冲区（避免每个采样点都新建数组/Set：这是热路径上的主要开销）。
 */
interface RayScratch {
  visited: Int32Array
  stamp: number
  cand: Int32Array
  ts: Float64Array
  dirs: Int8Array
  order: Int32Array
}

function makeScratch(edgeCount: number): RayScratch {
  const cap = Math.max(64, edgeCount)
  return {
    visited: new Int32Array(cap),
    stamp: 0,
    cand: new Int32Array(cap),
    ts: new Float64Array(cap),
    dirs: new Int8Array(cap),
    order: new Int32Array(cap)
  }
}

/** 从 p 沿 (nx,ny) 出发到材料外边界的最短距离；wn0 为 p 处的填充环数（非零即内部） */
function rayExit(p: Pt, nx: number, ny: number, wn0: number, idx: EdgeIndex, sc: RayScratch): number | null {
  const b0 = Math.max(0, Math.min(BANDS - 1, Math.floor((p.y - idx.y0) / idx.bandH)))
  const far = 4000
  const yEnd = p.y + ny * far
  const b1 = Math.max(0, Math.min(BANDS - 1, Math.floor((yEnd - idx.y0) / idx.bandH)))
  const lo = Math.min(b0, b1)
  const hi = Math.max(b0, b1)
  sc.stamp++
  let candCount = 0
  for (let b = lo; b <= hi; b++) {
    const list = idx.bands[b]
    for (let k = 0; k < list.length; k++) {
      const e = list[k]
      if (sc.visited[e] === sc.stamp) continue
      sc.visited[e] = sc.stamp
      sc.cand[candCount++] = e
    }
  }
  let tsCount = 0
  for (let ci = 0; ci < candCount; ci++) {
    const e = sc.cand[ci]
    const dx = idx.dxArr[e]
    const dy = idx.dyArr[e]
    const denom = dx * ny - dy * nx
    if (Math.abs(denom) < 1e-12) continue
    const rx = idx.ex[e] - p.x
    const ry = idx.ey[e] - p.y
    // 解 p + t·n = a + u·d（克拉默法则）
    const t = (dx * ry - rx * dy) / denom
    const u = (nx * ry - rx * ny) / denom
    if (t <= EPS_IN * 0.9) continue
    if (u < 0 || u > 1) continue
    if (t > far) continue
    sc.ts[tsCount] = t
    sc.dirs[tsCount] = dy > 0 ? 1 : -1
    tsCount++
  }
  if (tsCount === 0) return null
  // 交点按 t 升序（数量很少，插入排序即可）
  for (let i = 0; i < tsCount; i++) sc.order[i] = i
  for (let i = 1; i < tsCount; i++) {
    const oi = sc.order[i]
    const ti = sc.ts[oi]
    let j = i - 1
    while (j >= 0 && sc.ts[sc.order[j]] > ti) {
      sc.order[j + 1] = sc.order[j]
      j--
    }
    sc.order[j + 1] = oi
  }
  let wn = wn0
  for (let i = 0; i < tsCount; i++) {
    const oi = sc.order[i]
    wn += sc.dirs[oi]
    if (wn === 0) return sc.ts[oi]
  }
  return sc.ts[sc.order[tsCount - 1]]
}

/** 扫描线 + 并查集：统计填充区连通域数量 */
export function countFilledComponents(rings: Ring[]): number {
  const xs0: number[] = []
  const ys0: number[] = []
  const dxs: number[] = []
  const dys: number[] = []
  const ymin: number[] = []
  const ymax: number[] = []
  const allY: number[] = []
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[j]
      const b = r[i]
      if (a.y === b.y) continue
      xs0.push(a.x)
      ys0.push(a.y)
      dxs.push(b.x - a.x)
      dys.push(b.y - a.y)
      ymin.push(Math.min(a.y, b.y))
      ymax.push(Math.max(a.y, b.y))
      allY.push(a.y)
    }
  }
  const E = xs0.length
  if (E === 0) return 0
  allY.sort((a, b) => a - b)
  const parent: number[] = []
  const find = (x: number): number => {
    let r = x
    while (parent[r] !== r) {
      parent[r] = parent[parent[r]]
      r = parent[r]
    }
    return r
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }
  const order = Array.from({ length: E }, (_, i) => i).sort((a, b) => ymin[a] - ymin[b])
  let cursor = 0
  let active: number[] = []
  let prev: Array<{ x0: number; x1: number; id: number }> = []
  for (let yi = 0; yi < allY.length - 1; yi++) {
    if (allY[yi + 1] - allY[yi] < 1e-9) continue
    const y = (allY[yi] + allY[yi + 1]) / 2
    while (cursor < E && ymin[order[cursor]] <= y) active.push(order[cursor++])
    if (active.some((e) => ymax[e] <= y)) active = active.filter((e) => ymax[e] > y)
    const crossX: number[] = []
    const crossD: number[] = []
    for (const e of active) {
      const t = (y - ys0[e]) / dys[e]
      crossX.push(xs0[e] + t * dxs[e])
      crossD.push(dys[e] > 0 ? 1 : -1)
    }
    const idxs = crossX.map((_, i) => i).sort((a, b) => crossX[a] - crossX[b])
    const cur: Array<{ x0: number; x1: number; id: number }> = []
    let wn = 0
    for (let k = 0; k < idxs.length - 1; k++) {
      wn += crossD[idxs[k]]
      if (wn !== 0) {
        const x0 = crossX[idxs[k]]
        const x1 = crossX[idxs[k + 1]]
        if (x1 - x0 > 1e-9) {
          const id = parent.length
          parent.push(id)
          cur.push({ x0, x1, id })
        }
      }
    }
    // 与上一层扫描线的区间做重叠并查集
    let a = 0
    let b = 0
    while (a < prev.length && b < cur.length) {
      if (prev[a].x1 <= cur[b].x0) a++
      else if (cur[b].x1 <= prev[a].x0) b++
      else {
        union(prev[a].id, cur[b].id)
        if (prev[a].x1 < cur[b].x1) a++
        else b++
      }
    }
    prev = cur
  }
  const roots = new Set<number>()
  for (let i = 0; i < parent.length; i++) roots.add(find(i))
  return roots.size
}

/** 生成 SVG path 数据（把命令按子路径切分） */
export function commandsToRingPaths(cmds: PathCmd[]): string[] {
  const out: string[] = []
  let cur = ''
  const f = (v: number): string => (Math.round(v * 100) / 100).toString()
  for (const c of cmds) {
    switch (c.type) {
      case 'M':
        if (cur) out.push(cur)
        cur = `M${f(c.x ?? 0)} ${f(c.y ?? 0)}`
        break
      case 'L':
        cur += `L${f(c.x ?? 0)} ${f(c.y ?? 0)}`
        break
      case 'C':
        cur += `C${f(c.x1 ?? 0)} ${f(c.y1 ?? 0)} ${f(c.x2 ?? 0)} ${f(c.y2 ?? 0)} ${f(c.x ?? 0)} ${f(c.y ?? 0)}`
        break
      case 'Q':
        cur += `Q${f(c.x1 ?? 0)} ${f(c.y1 ?? 0)} ${f(c.x ?? 0)} ${f(c.y ?? 0)}`
        break
      case 'Z':
        cur += 'Z'
        break
      default:
        break
    }
  }
  if (cur) out.push(cur)
  return out
}

/** 分析单个字形（结果与字号无关，缓存本地单位下的几何） */
export function analyzeGlyphPath(
  char: string,
  fontId: string,
  weight: number,
  cmds: PathCmd[],
  advance: number
): GlyphGeom {
  const ringPaths = commandsToRingPaths(cmds)
  const flat = flattenCommands(cmds)
  if (flat.length === 0) {
    const w = advance > 0 ? advance : 1000
    return {
      char,
      fontId,
      weight,
      missing: false,
      blank: true,
      rings: [],
      strokeBlocks: 0,
      strokeBlocksByNesting: 0,
      minStroke: 0,
      minStrokePoint: null,
      bbox: { x0: 0, y0: 0, x1: w, y1: 0 },
      inkW: w,
      inkH: 0,
      samples: emptySamples(w),
      outerPerimeter: 0,
      blockBBoxes: [],
      pathData: '',
      advance: w
    }
  }
  const bb = bboxOfRings(flat)
  const rings: RingGeom[] = flat.map((ring, i) => ({
    ring,
    area: Math.abs(ringSignedArea(ring)),
    perimeter: ringPerimeter(ring),
    isHole: false,
    depth: 0,
    block: 0,
    bbox: ringBBox(ring),
    pathData: ringPaths[i] ?? '',
    minStroke: Infinity,
    minStrokePoint: null
  }))

  // 嵌套深度：用环内部代表点做包含测试
  for (let i = 0; i < rings.length; i++) {
    const rep = interiorPoint(rings[i].ring)
    if (!rep) continue
    let depth = 0
    for (let j = 0; j < rings.length; j++) {
      if (i === j) continue
      if (windingNumber(rep, rings[j].ring) !== 0) depth++
    }
    rings[i].depth = depth
    rings[i].isHole = depth % 2 === 1
  }

  // 块归属：偶深度环各成一块，奇深度环归属包含它的最近外层环
  let blockSeq = 0
  const outerIdx: number[] = []
  for (let i = 0; i < rings.length; i++) {
    if (!rings[i].isHole) {
      rings[i].block = blockSeq++
      outerIdx.push(i)
    }
  }
  for (let i = 0; i < rings.length; i++) {
    if (!rings[i].isHole) continue
    const rep = interiorPoint(rings[i].ring)
    let best = -1
    let bestDepth = Infinity
    for (const oi of outerIdx) {
      if (!rep) break
      if (windingNumber(rep, rings[oi].ring) !== 0 && rings[oi].depth < bestDepth) {
        best = oi
        bestDepth = rings[oi].depth
      }
    }
    rings[i].block = best >= 0 ? rings[best].block : 0
  }

  // 连通域数量（扫描线并查集）
  const strokeBlocks = countFilledComponents(flat)

  // 最细笔画：沿法线的局部宽度
  const ei = buildEdgeIndex(flat, { y0: bb.y0, y1: bb.y1 })
  const scratch = makeScratch(Math.max(1, ei.ex.length))
  let minStroke = Infinity
  let minStrokePoint: Pt | null = null
  for (const rg of rings) {
    const m = measureRingStroke(rg.ring, ei, scratch)
    rg.minStroke = m.value
    rg.minStrokePoint = m.point
    if (m.value < minStroke) {
      minStroke = m.value
      minStrokePoint = m.point
    }
  }

  const blockBBoxes = outerIdx.map((i) => rings[i].bbox)
  const outerPerimeter = outerIdx.reduce((s, i) => s + rings[i].perimeter, 0)
  const samples = makeSampleSet(flat, 1.5)

  return {
    char,
    fontId,
    weight,
    missing: false,
    blank: false,
    rings,
    strokeBlocks,
    strokeBlocksByNesting: outerIdx.length,
    minStroke: Number.isFinite(minStroke) ? minStroke : 0,
    minStrokePoint,
    bbox: bb,
    inkW: bb.x1 - bb.x0,
    inkH: bb.y1 - bb.y0,
    samples,
    outerPerimeter,
    blockBBoxes,
    pathData: ringPaths.join(''),
    advance: advance > 0 ? advance : bb.x1 - bb.x0
  }
}

/** 取环内部的一个代表点（长边中点沿法线内推） */
function interiorPoint(ring: Ring): Pt | null {
  if (ring.length < 3) return null
  let bi = 0
  let bl = -1
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const l = Math.hypot(ring[i].x - ring[j].x, ring[i].y - ring[j].y)
    if (l > bl) {
      bl = l
      bi = i
    }
  }
  const a = ring[(bi - 1 + ring.length) % ring.length]
  const b = ring[bi]
  const mx = (a.x + b.x) / 2
  const my = (a.y + b.y) / 2
  const tx = b.x - a.x
  const ty = b.y - a.y
  const tl = Math.hypot(tx, ty)
  if (tl < 1e-9) return null
  const nx = -ty / tl
  const ny = tx / tl
  const step = Math.max(0.5, bl * 0.01)
  const q1 = { x: mx + nx * step, y: my + ny * step }
  if (windingNumber(q1, ring) !== 0) return q1
  const q2 = { x: mx - nx * step, y: my - ny * step }
  if (windingNumber(q2, ring) !== 0) return q2
  return null
}