/**
 * 全局共享类型定义（对应规格书第 7 节数据模型）
 * 说明：内部长度单位统一 mm（1 位小数），金额统一整数「分」。
 */

export type Mounting = 'wall' | 'board' | 'freestanding'
export type Align = 'left' | 'center' | 'right' | 'justify'
export type CharMode = 'solid' | 'outline'
/** 左右留边分开设置；keepSide = 宽度不够时优先保住的一侧 */
export type MarginSide = 'left' | 'right'
export type MarginMode = 'ratio' | 'fixed'

/** 门头面板参数；frameMm = 铝塑板边框宽度，有效安装区 = 面板尺寸 - 2×边框 */
export interface SignPanel {
  wMm: number
  hMm: number
  mounting: Mounting
  frameMm: number
}

/** 逐字项；line 为行号、seq 为全文字序（多行扩展，供逐字微调定位用） */
export interface CharItem {
  char: string
  trackMm: number
  offsetYMm: number
  mode: CharMode
  line: number
  /** 是否手动调整过字距（未调整时跟随「默认字距比例 × 字号」） */
  trackTouched?: boolean
  seq?: number
}

/** 单侧留边：可按「比例 × 字号」给，也可直接给固定毫米数；minMm 为让位下限时的最小保留量 */
export interface MarginCfg {
  mode: MarginMode
  /** mode='ratio' 时生效：留边 = ratio × 当前字号 */
  ratio: number
  /** mode='fixed' 时生效：固定留边 mm */
  fixedMm: number
  /** 让位压缩时该侧保留的下限 mm（压到此值后不再让） */
  minMm: number
}

export interface MarginSettings {
  /** 左、右留边分别配置（如门口一侧有立柱、另一侧靠卷帘门时可给不同值） */
  left: MarginCfg
  right: MarginCfg
  /** 先保哪一边：宽度不够时先压另一侧 */
  keepSide: MarginSide
}

export interface LayoutSettings {
  align: Align
  baseSizeMm: number
  fontId: string
  weight: number
  strokeLimitMm: number
  /** 默认字距 = trackRatio × 字号 */
  trackRatio: number
  /** 自动字号的左右留边（比例/固定毫米均可，两侧可不同） */
  margins: MarginSettings
  /** 行距（行与行之间墨迹间隙）= lineGapRatio × 字号 */
  lineGapRatio: number
}

export interface LayoutDef {
  panel: SignPanel
  items: CharItem[]
  settings: LayoutSettings
}

export interface LedCfg {
  moduleSpacingMm: number
  modulePowerW: number
  moduleLumen: number
  safetyFactor: number
  psuEfficiency: number
}

export interface LedResult {
  /** 总布点长度（各连通域外轮廓周长之和） */
  perimeterTotalMm: number
  modules: number
  ratedW: number
  recommendedW: number
  suggestedPsu: string
  note: string
  /** 因向上取整补足的模组数 */
  extraModules: number
  /** 理论布点小数（L / spacing） */
  exactModules: number
  /** 末段余长 mm */
  spareMm: number
  psuCount: number
  psuUnitW: number
}

export type MaterialKind = 'acrylic' | 'led_module' | 'psu' | 'glue' | 'labor'

export interface Material {
  kind: MaterialKind
  spec: string
  qty: number
  unit: string
  unitPriceCents: number
  amountCents: number
}

export interface BBox {
  x: number
  y: number
  w: number
  h: number
}

export interface ContourInfo {
  areaMm2: number
  perimeterMm: number
  isHole: boolean
  blockIndex: number
}

export interface GlyphInfo {
  char: string
  fontId: string
  weight: number
  sizeMm: number
  bboxMm: BBox
  contours: ContourInfo[]
  /** 连通域（笔画块）数量 */
  strokeBlocks: number
  /** 最细笔画宽度 mm */
  minStrokeMm: number
  /** 最细笔画位置（mm，字形本地坐标 y 向下） */
  minStrokePoint: { x: number; y: number } | null
  /** 字体中不存在该字符 */
  missing: boolean
  /** 工艺警告 */
  warnings: string[]
}

export interface Project {
  id: string
  name: string
  layout: LayoutDef
  led: LedCfg
  /** 面板材料预设 id（见 materials.json 的 panelMaterials） */
  panelMaterialId: string
  sheetId: string
  ledModuleId: string
  createdAt: number
  updatedAt: number
}