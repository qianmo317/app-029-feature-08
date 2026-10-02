/**
 * 字形几何底层工具：曲线离散化、环（轮廓）几何量、点/线段距离、形状最近距离。
 * 坐标约定：与 opentype.js 的 getPath 一致（y 向下），单位统一为「字形本地单位」；
 * 排版本地单位 = 1000（em），使用时按 字号mm/1000 线性缩放。
 */

export interface Pt {
  x: number
  y: number
}

/** 闭合环：首尾不重复点 */
export type Ring = Pt[]

export interface PathCmd {
  type: string
  x?: number
  y?: number
  x1?: number
  y1?: number
  x2?: number
  y2?: number
}

/** 曲线离散化容差（字形本地单位，1000 em 下 = 0.04% em） */
export const FLATTEN_TOL = 0.4

/** 把 opentype 的 path commands 离散成闭合环（直线段保留原始顶点） */
export function flattenCommands(commands: PathCmd[], tol = FLATTEN_TOL): Ring[] {
  const rings: Ring[] = []
  let cur: Ring = []
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0

  const closeRing = () => {
    if (cur.length >= 3) {
      // 去掉与起点重复的末点
      const last = cur[cur.length - 1]
      if (Math.abs(last.x - cur[0].x) < 1e-9 && Math.abs(last.y - cur[0].y) < 1e-9) cur.pop()
      if (cur.length >= 3) rings.push(simplifyCollinear(cur))
    }
    cur = []
  }

  for (const c of commands) {
    switch (c.type) {
      case 'M':
        closeRing()
        cx = c.x ?? 0
        cy = c.y ?? 0
        sx = cx
        sy = cy
        cur.push({ x: cx, y: cy })
        break
      case 'L':
        cx = c.x ?? cx
        cy = c.y ?? cy
        cur.push({ x: cx, y: cy })
        break
      case 'C':
        flattenCubic(
          { x: cx, y: cy },
          { x: c.x1 ?? cx, y: c.y1 ?? cy },
          { x: c.x2 ?? cx, y: c.y2 ?? cy },
          { x: c.x ?? cx, y: c.y ?? cy },
          tol,
          cur
        )
        cx = c.x ?? cx
        cy = c.y ?? cy
        break
      case 'Q': {
        // 二次贝塞尔转三次，统一处理
        const p0 = { x: cx, y: cy }
        const q = { x: c.x1 ?? cx, y: c.y1 ?? cy }
        const p3 = { x: c.x ?? cx, y: c.y ?? cy }
        flattenCubic(
          p0,
          { x: p0.x + (2 / 3) * (q.x - p0.x), y: p0.y + (2 / 3) * (q.y - p0.y) },
          { x: p3.x + (2 / 3) * (q.x - p3.x), y: p3.y + (2 / 3) * (q.y - p3.y) },
          p3,
          tol,
          cur
        )
        cx = p3.x
        cy = p3.y
        break
      }
      case 'Z':
        if (cur.length >= 3) {
          const last = cur[cur.length - 1]
          if (Math.abs(last.x - sx) > 1e-9 || Math.abs(last.y - sy) > 1e-9) cur.push({ x: sx, y: sy })
        }
        closeRing()
        cx = sx
        cy = sy
        break
      default:
        break
    }
  }
  closeRing()
  return rings
}

function flattenCubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, tol: number, out: Ring): void {
  let dx = p3.x - p0.x
  let dy = p3.y - p0.y
  const d1 = Math.abs((p1.x - p3.x) * dy - (p1.y - p3.y) * dx)
  const d2 = Math.abs((p2.x - p3.x) * dy - (p2.y - p3.y) * dx)
  if ((d1 + d2) * (d1 + d2) <= tol * tol * (dx * dx + dy * dy) && dx * dx + dy * dy > 0) {
    out.push(p3)
    return
  }
  // de Casteljau 递归二分
  const emit = (a: Pt, b: Pt, c: Pt, d: Pt, depth: number): void => {
    dx = d.x - a.x
    dy = d.y - a.y
    const e1 = Math.abs((b.x - d.x) * dy - (b.y - d.y) * dx)
    const e2 = Math.abs((c.x - d.x) * dy - (c.y - d.y) * dx)
    if (depth >= 14 || ((e1 + e2) * (e1 + e2) <= tol * tol * (dx * dx + dy * dy) && dx * dx + dy * dy > 0)) {
      out.push(d)
      return
    }
    const ab = mid(a, b)
    const bc = mid(b, c)
    const cd = mid(c, d)
    const abc = mid(ab, bc)
    const bcd = mid(bc, cd)
    const abcd = mid(abc, bcd)
    emit(a, ab, abc, abcd, depth + 1)
    emit(abcd, bcd, cd, d, depth + 1)
  }
  emit(p0, p1, p2, p3, 0)
}

function mid(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/** 合并共线点（直线段只保留端点），角度阈值 0.4° */
export function simplifyCollinear(ring: Ring, angleTol = 0.007): Ring {
  const n = ring.length
  if (n < 4) return ring
  const out: Ring = []
  for (let i = 0; i < n; i++) {
    const a = ring[(i - 1 + n) % n]
    const b = ring[i]
    const c = ring[(i + 1) % n]
    const v1x = b.x - a.x
    const v1y = b.y - a.y
    const v2x = c.x - b.x
    const v2y = c.y - b.y
    const l1 = Math.hypot(v1x, v1y)
    const l2 = Math.hypot(v2x, v2y)
    if (l1 < 1e-9 || l2 < 1e-9) continue
    const cross = (v1x * v2y - v1y * v2x) / (l1 * l2)
    const dot = (v1x * v2x + v1y * v2y) / (l1 * l2)
    if (Math.abs(cross) < angleTol && dot > 0) continue
    out.push(b)
  }
  return out.length >= 3 ? out : ring
}

export function ringSignedArea(ring: Ring): number {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y)
  }
  return a / 2
}

export function ringPerimeter(ring: Ring): number {
  let p = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    p += Math.hypot(ring[i].x - ring[j].x, ring[i].y - ring[j].y)
  }
  return p
}

export function ringBBox(ring: Ring): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of ring) {
    if (p.x < x0) x0 = p.x
    if (p.y < y0) y0 = p.y
    if (p.x > x1) x1 = p.x
    if (p.y > y1) y1 = p.y
  }
  return { x0, y0, x1, y1 }
}

/** 环绕数（非零填充规则）；不分配对象的重载，供热循环调用 */
export function windingNumberXY(px: number, py: number, ring: Ring): number {
  let wn = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]
    const b = ring[i]
    if (a.y <= py) {
      if (b.y > py && (b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y) > 0) wn++
    } else if (b.y <= py && (b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y) < 0) wn--
  }
  return wn
}

export function windingNumber(p: Pt, ring: Ring): number {
  return windingNumberXY(p.x, p.y, ring)
}

export function pointInRings(p: Pt, rings: Ring[]): boolean {
  let wn = 0
  for (const r of rings) wn += windingNumber(p, r)
  return wn !== 0
}

export function bboxOfRings(rings: Ring[]): { x0: number; y0: number; x1: number; y1: number } {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  for (const r of rings) {
    const rb = ringBBox(r)
    if (rb.x0 < b.x0) b.x0 = rb.x0
    if (rb.y0 < b.y0) b.y0 = rb.y0
    if (rb.x1 > b.x1) b.x1 = rb.x1
    if (rb.y1 > b.y1) b.y1 = rb.y1
  }
  return b
}

/** 线段-线段最短距离 */
export function segSegDist(a1: Pt, a2: Pt, b1: Pt, b2: Pt): number {
  if (segmentsIntersect(a1, a2, b1, b2)) return 0
  return Math.min(
    segPointDist(b1, b2, a1),
    segPointDist(b1, b2, a2),
    segPointDist(a1, a2, b1),
    segPointDist(a1, a2, b2)
  )
}

/** 点到线段距离 */
export function segPointDist(a: Pt, b: Pt, p: Pt): number {
  const vx = b.x - a.x
  const vy = b.y - a.y
  const l2 = vx * vx + vy * vy
  if (l2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy))
}

export function segmentsIntersect(a1: Pt, a2: Pt, b1: Pt, b2: Pt): boolean {
  const d1 = cross(b1, b2, a1)
  const d2 = cross(b1, b2, a2)
  const d3 = cross(a1, a2, b1)
  const d4 = cross(a1, a2, b2)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

function cross(a: Pt, b: Pt, c: Pt): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

/**
 * 轮廓采样集（扁平化 DoubleArray 存储，避免热循环里的对象属性访问与 GC 压力）。
 * all：多边形顶点 + 长边细分点（细分点严格落在边上，不改变形状）
 * coarse：抽稀后的粗筛点（存的是在 all 中的下标）
 */
export interface SampleSet {
  ax: Float64Array
  ay: Float64Array
  coarse: Int32Array
  /** 按 x 升序排列的点下标（精筛时二分定位条带，避免全量两两比较） */
  orderX: Int32Array
  minX: number
  maxX: number
}

export function buildSampleSet(rings: Ring[], maxSegLen: number): SampleSet {
  const xs: number[] = []
  const ys: number[] = []
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[j]
      const b = r[i]
      xs.push(b.x)
      ys.push(b.y)
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      if (len > maxSegLen) {
        const n = Math.ceil(len / maxSegLen) - 1
        for (let k = 1; k <= n; k++) {
          const t = k / (n + 1)
          xs.push(a.x + (b.x - a.x) * t)
          ys.push(a.y + (b.y - a.y) * t)
        }
      }
    }
  }
  const total = xs.length
  const ax = new Float64Array(total)
  const ay = new Float64Array(total)
  let minX = Infinity
  let maxX = -Infinity
  for (let i = 0; i < total; i++) {
    ax[i] = xs[i]
    ay[i] = ys[i]
    if (xs[i] < minX) minX = xs[i]
    if (xs[i] > maxX) maxX = xs[i]
  }
  const stride = Math.max(1, Math.floor(total / 48))
  const coarseList: number[] = []
  for (let i = 0; i < total; i += stride) coarseList.push(i)
  const order = Array.from({ length: total }, (_, i) => i).sort((p, q) => ax[p] - ax[q])
  return {
    ax,
    ay,
    coarse: Int32Array.from(coarseList),
    orderX: Int32Array.from(order),
    minX: total ? minX : 0,
    maxX: total ? maxX : 0
  }
}

export function makeSampleSet(rings: Ring[], maxSegLen: number): SampleSet {
  return buildSampleSet(rings, maxSegLen)
}

/** 空采样集（缺字/空白字符占位，避免静默退化） */
export function emptySamples(maxX = 0): SampleSet {
  return {
    ax: new Float64Array(0),
    ay: new Float64Array(0),
    coarse: new Int32Array(0),
    orderX: new Int32Array(0),
    minX: 0,
    maxX
  }
}

/** 二分：返回 orderX 中第一个 ax >= v 的位置 */
function lowerBound(set: SampleSet, v: number): number {
  const { ax, orderX } = set
  let lo = 0
  let hi = orderX.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ax[orderX[mid]] < v) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * 两个形状（按 offX 水平平移）轮廓点之间的最小距离。
 * 先粗筛（48×48 点对）得到上界，再在「可能更近的 x 条带」内精筛（二分定位，避免两两比较）。
 * 结果与形状尺度无关：求解时按归一化间距缓存，改字号无需重算。
 */
export function minSetDistance(a: SampleSet, aOffX: number, b: SampleSet, bOffX: number): number {
  let best2 = Infinity
  const ca = a.coarse
  const cb = b.coarse
  for (let i = 0; i < ca.length; i++) {
    const ai = ca[i]
    const px = a.ax[ai] + aOffX
    const py = a.ay[ai]
    for (let j = 0; j < cb.length; j++) {
      const bi = cb[j]
      const dx = b.ax[bi] + bOffX - px
      const dy = b.ay[bi] - py
      const d2 = dx * dx + dy * dy
      if (d2 < best2) best2 = d2
    }
  }
  let best = Math.sqrt(best2)
  const lowAx = b.minX + bOffX - best
  const na = a.ax.length
  for (let i = 0; i < na; i++) {
    const px = a.ax[i] + aOffX
    if (px < lowAx) continue
    const py = a.ay[i]
    const s = lowerBound(b, px - best)
    const e = lowerBound(b, px + best)
    for (let k = s; k < e; k++) {
      const j = b.orderX[k]
      const dx = b.ax[j] + bOffX - px
      const dy = b.ay[j] - py
      const d2 = dx * dx + dy * dy
      if (d2 < best2) best2 = d2
    }
  }
  best = Math.sqrt(best2)
  return best
}

/** 点到线段集合的最小距离（用于末端精修） */
export function minDistPointToRings(p: Pt, rings: Ring[]): number {
  let best = Infinity
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const d = segPointDist(r[j], r[i], p)
      if (d < best) best = d
    }
  }
  return best
}