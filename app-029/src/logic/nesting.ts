/**
 * 亚克力板材拼版（规格书第 8 节）：
 * - 板材按矩形切出，异形字用「外接矩形」计算，不用轮廓面积；
 * - 同一套 guillotine 思路（每层料条横向贯通、再纵向分切），重复件用分层装箱；
 * - 输出所需板数、利用率与裁切清单；单件超过板材尺寸时显式报错，不静默。
 */

export interface Piece {
  id: string
  label: string
  wMm: number
  hMm: number
}

export interface PlacedPiece {
  id: string
  label: string
  x: number
  y: number
  wMm: number
  hMm: number
  rotated: boolean
}

export interface ShelfCut {
  y: number
  heightMm: number
  pieces: number
}

export interface SheetLayout {
  index: number
  pieces: PlacedPiece[]
  shelves: ShelfCut[]
  usedAreaMm2: number
  sheetAreaMm2: number
  utilization: number
}

export interface CutItem {
  label: string
  wMm: number
  hMm: number
  count: number
}

export interface NestingResult {
  sheets: SheetLayout[]
  sheetCount: number
  utilization: number
  cutList: CutItem[]
  pieceCount: number
  totalPieceAreaMm2: number
  sheetAreaMm2: number
  oversize: Piece[]
}

/**
 * 分层装箱（shelf / guillotine）：
 * 1) 按高度降序；2) 尽量塞进已有料层，否则开新层；3) 层高 = 该层最高件，横向贯通可一刀切到底。
 */
export function nestPieces(pieces: Piece[], sheetW: number, sheetH: number, kerfMm = 3, allowRotate = true): NestingResult {
  const kerf = Math.max(0, kerfMm)
  const oversize: Piece[] = []
  const usable = pieces.filter((p) => {
    const fits = (p.wMm + kerf <= sheetW && p.hMm + kerf <= sheetH) || (allowRotate && p.hMm + kerf <= sheetW && p.wMm + kerf <= sheetH)
    if (!fits) oversize.push(p)
    return fits
  })
  // 高度降序（高件优先，减少层数浪费）
  const sorted = [...usable].sort((a, b) => Math.max(b.wMm, b.hMm) - Math.max(a.wMm, a.hMm) || b.hMm - a.hMm)
  const sheets: SheetLayout[] = []
  interface SheetAcc {
    pieces: PlacedPiece[]
    shelves: ShelfCut[]
    cursorY: number
  }
  let current: SheetAcc | null = null

  const newSheet = (): SheetAcc => {
    const s: SheetAcc = { pieces: [], shelves: [], cursorY: 0 }
    sheets.push({
      index: sheets.length,
      pieces: s.pieces,
      shelves: s.shelves,
      usedAreaMm2: 0,
      sheetAreaMm2: sheetW * sheetH,
      utilization: 0
    })
    return s
  }

  for (const p of sorted) {
    // 先尝试在已有层内横排
    const tryOrient = (sheet: { pieces: PlacedPiece[]; shelves: ShelfCut[] }, w: number, h: number, rotated: boolean): boolean => {
      // 找到能容纳该件的料层（本层剩余宽度足够）
      for (const shelf of sheet.shelves) {
        if (h > shelf.heightMm + 1e-9) continue
        const used = shelfWidthUsed(sheet.pieces, shelf)
        if (used + w + kerf <= sheetW + 1e-9) {
          sheet.pieces.push({ id: p.id, label: p.label, x: used, y: shelf.y, wMm: w, hMm: h, rotated })
          return true
        }
      }
      return false
    }
    let placed = false
    const cur = current
    if (cur) {
      placed = tryOrient(cur, p.wMm, p.hMm, false)
      if (!placed && allowRotate) placed = tryOrient(cur, p.hMm, p.wMm, true)
      if (!placed) {
        // 开新层（层高 = 本件高度，横向贯通，可一刀切到底）
        const rotated = allowRotate && p.wMm + kerf > sheetW
        const w = rotated ? p.hMm : p.wMm
        const hh = rotated ? p.wMm : p.hMm
        if (cur.cursorY + hh + kerf <= sheetH + 1e-9) {
          const shelf: ShelfCut = { y: cur.cursorY, heightMm: hh, pieces: 0 }
          cur.shelves.push(shelf)
          cur.pieces.push({ id: p.id, label: p.label, x: 0, y: shelf.y, wMm: w, hMm: hh, rotated })
          cur.cursorY += hh + kerf
          placed = true
        }
      }
    }
    if (!placed) {
      const fresh = newSheet()
      current = fresh
      const rotated = allowRotate && p.wMm + kerf > sheetW && p.hMm + kerf <= sheetW
      const w = rotated ? p.hMm : p.wMm
      const h = rotated ? p.wMm : p.hMm
      const shelf: ShelfCut = { y: 0, heightMm: h, pieces: 0 }
      fresh.shelves.push(shelf)
      fresh.pieces.push({ id: p.id, label: p.label, x: 0, y: 0, wMm: w, hMm: h, rotated })
      fresh.cursorY = h + kerf
    }
  }

  // 统计
  let totalPieceArea = 0
  for (const s of sheets) {
    let area = 0
    for (const pp of s.pieces) {
      area += pp.wMm * pp.hMm
      const shelf = s.shelves.find((sh) => Math.abs(sh.y - pp.y) < 1e-9)
      if (shelf) shelf.pieces++
    }
    totalPieceArea += area
    s.usedAreaMm2 = area
    s.utilization = s.sheetAreaMm2 > 0 ? area / s.sheetAreaMm2 : 0
  }
  const sheetAreaTotal = sheets.length * sheetW * sheetH
  const cutMap = new Map<string, CutItem>()
  for (const p of usable) {
    const key = `${p.label}|${p.wMm}x${p.hMm}`
    const hit = cutMap.get(key)
    if (hit) hit.count++
    else cutMap.set(key, { label: p.label, wMm: p.wMm, hMm: p.hMm, count: 1 })
  }
  const cutList = [...cutMap.values()].map((c) => ({ ...c }))
  cutList.sort((a, b) => b.wMm * b.hMm - a.wMm * a.hMm || a.label.localeCompare(b.label))

  return {
    sheets,
    sheetCount: sheets.length,
    utilization: sheetAreaTotal > 0 ? totalPieceArea / sheetAreaTotal : 0,
    cutList,
    pieceCount: usable.length,
    totalPieceAreaMm2: totalPieceArea,
    sheetAreaMm2: sheetAreaTotal,
    oversize
  }
}

function shelfWidthUsed(pieces: PlacedPiece[], shelf: ShelfCut): number {
  let max = 0
  for (const p of pieces) {
    if (Math.abs(p.y - shelf.y) > 1e-9) continue
    max = Math.max(max, p.x + p.wMm)
  }
  return max
}