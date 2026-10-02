/**
 * 连通域数量的独立复算（自检用）：
 * 扫描线+并查集（矢量法，主实现） vs 光栅化 + 4 邻域洪泛填充（完全独立的第二套算法）。
 * 两套结果一致，可作为「连通域数量与人工核对一致」的交叉验证。
 */

import testchars from '../data/testchars.json'
import { getGlyphGeom } from './fontLoader'
import type { Ring } from './geometry'

export interface BlockCountResult {
  char: string
  scanline: number
  raster: number
  same: boolean
}

/** 光栅化洪泛填充统计连通域（4 邻域；320px 边长下笔画分辨率约 3 字形单位/px） */
export function rasterBlockCount(rings: Ring[], resolution = 320): number {
  if (!rings.length) return 0
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const r of rings) {
    for (const p of r) {
      if (p.x < x0) x0 = p.x
      if (p.y < y0) y0 = p.y
      if (p.x > x1) x1 = p.x
      if (p.y > y1) y1 = p.y
    }
  }
  const w = Math.max(1e-6, x1 - x0)
  const h = Math.max(1e-6, y1 - y0)
  const scale = resolution / Math.max(w, h)
  const nx = Math.max(2, Math.round(w * scale) + 2)
  const ny = Math.max(2, Math.round(h * scale) + 2)
  const grid = new Uint8Array(nx * ny)
  const py = (iy: number): number => y0 + (iy / (ny - 1)) * h

  // 逐行扫描填充
  for (let iy = 0; iy < ny; iy++) {
    const yy = py(iy)
    const xs: number[] = []
    const dirs: number[] = []
    for (const r of rings) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const a = r[j]
        const b = r[i]
        if (a.y === b.y) continue
        const lo = Math.min(a.y, b.y)
        const hi = Math.max(a.y, b.y)
        if (yy < lo || yy >= hi) continue
        const t = (yy - a.y) / (b.y - a.y)
        xs.push(a.x + (b.x - a.x) * t)
        dirs.push(b.y > a.y ? 1 : -1)
      }
    }
    const order = xs.map((_, i) => i).sort((p, q) => xs[p] - xs[q])
    let wn = 0
    for (let k = 0; k < order.length - 1; k++) {
      wn += dirs[order[k]]
      if (wn !== 0) {
        const a = xs[order[k]]
        const b = xs[order[k + 1]]
        const i0 = Math.max(0, Math.ceil(((a - x0) / w) * (nx - 1)))
        const i1 = Math.min(nx - 1, Math.floor(((b - x0) / w) * (nx - 1)))
        for (let ix = i0; ix <= i1; ix++) grid[iy * nx + ix] = 1
      }
    }
  }

  // 4 邻域洪泛填充计数
  const stack: number[] = []
  let count = 0
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] !== 1) continue
    count++
    stack.push(i)
    grid[i] = 2
    while (stack.length) {
      const cur = stack.pop() as number
      const cx = cur % nx
      const cy = (cur - cx) / nx
      if (cx > 0 && grid[cur - 1] === 1) {
        grid[cur - 1] = 2
        stack.push(cur - 1)
      }
      if (cx < nx - 1 && grid[cur + 1] === 1) {
        grid[cur + 1] = 2
        stack.push(cur + 1)
      }
      if (cy > 0 && grid[cur - nx] === 1) {
        grid[cur - nx] = 2
        stack.push(cur - nx)
      }
      if (cy < ny - 1 && grid[cur + nx] === 1) {
        grid[cur + nx] = 2
        stack.push(cur + nx)
      }
    }
  }
  return count
}

export async function runBlockCount(): Promise<BlockCountResult[]> {
  const list = testchars as unknown as { font: { id: string; weight: number }; chars: Array<{ char: string }> }
  const out: BlockCountResult[] = []
  for (const t of list.chars) {
    const g = getGlyphGeom(list.font.id, list.font.weight, t.char)
    if (!g) continue
    const raster = rasterBlockCount(g.rings.map((r) => r.ring))
    out.push({ char: t.char, scanline: g.strokeBlocks, raster, same: raster === g.strokeBlocks })
  }
  return out
}