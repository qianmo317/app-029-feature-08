/**
 * 全局共享类型定义（对应规格书第 7 节数据模型）
 * 说明：内部长度单位统一 mm（1 位小数），金额统一整数「分」。
 */

export type Mounting = 'wall' | 'board' | 'freestanding'
export type Align = 'left' | 'center' | 'right' | 'justify'
export type CharMode = 'solid' | 'outline'
/** 单侧留边方式：按字号比例，或直接给固定毫米数 */
export type MarginMode = 'ratio' | 'fixed'
/** 先保哪一侧留边：宽度不够时先压另一侧 */
export type PrioritySide = 'left' | 'right'

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

/** 单侧留边：可按字号比例，也可直接给固定毫米数；minMm 为该侧允许压到的下限 */
export interface MarginSide {
  mode: MarginMode
  /** mode='ratio' 时：留边 = ratio × 字号 */
  ratio: number
  /** mode='fixed' 时：固定留边 mm（不随字号缩放） */
  fixedMm: number
  /** 让位时该侧允许被压到的最小留边 mm */
  minMm: number
}

/** 左右分开的留边设置；prioritySide 指定宽度不够时先保（不让）的一侧 */
export interface MarginSettings {
  left: MarginSide
  right: MarginSide
  prioritySide: PrioritySide
}

export interface LayoutSettings {
  align: Align
  baseSizeMm: number
  fontId: string
  weight: number
  strokeLimitMm: number
  /** 默认字距 = trackRatio × 字号 */
  trackRatio: number
  /**
   * 自动字号留边（左右分开，各支持字号比例或固定毫米）。
   * 注：旧项目只有 marginRatio（按安装区宽的比例），打开时迁移成左右同宽的字号比例。
   */
  margins: MarginSettings
  /** @deprecated 旧字段：迁移自旧项目「两边同宽比例」，新逻辑不再读取 */
  marginRatio?: number
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