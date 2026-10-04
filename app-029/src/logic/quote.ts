/**
 * 报价单导出（规格书第 4.6 节）：
 * - PDF：走浏览器打印（打印样式见各页面 @media print），不引入需要编译的依赖；
 * - Excel：纯前端生成 .xls（HTML 表格 + Excel MIME），无需第三方库；
 * - 金额单位：整数「分」。
 */

import type { BomResult, CompareRow } from './materials'
import { yuan } from './materials'
import type { LayoutResult } from './layout'
import { alignLabel, mountingLabel } from './layout'
import type { Project } from './types'

export function bomGroupLabel(kind: string): string {
  switch (kind) {
    case 'acrylic':
      return '面板材料'
    case 'led_module':
      return 'LED 模组'
    case 'psu':
      return '电源'
    case 'glue':
      return '胶与配件'
    default:
      return '加工费'
  }
}

export interface QuoteDoc {
  title: string
  projectName: string
  date: string
  validUntil: string
  panelText: string
  fontText: string
  layoutText: string
  rows: Array<{ group: string; spec: string; qty: string; unit: string; unitPrice: string; amount: string }>
  total: string
  notes: string[]
  footer: string
}

export function buildQuoteDoc(project: Project, layout: LayoutResult, bom: BomResult, fontLabel: string): QuoteDoc {
  const now = new Date()
  const valid = new Date(now.getTime() + 30 * 24 * 3600 * 1000)
  const fmt = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const rows = bom.materials.map((m) => ({
    group: bomGroupLabel(m.kind),
    spec: m.spec,
    qty: String(m.qty),
    unit: m.unit,
    unitPrice: yuan(m.unitPriceCents),
    amount: yuan(m.amountCents)
  }))
  return {
    title: '招牌字制作报价单',
    projectName: project.name,
    date: fmt(now),
    validUntil: fmt(valid),
    panelText: `${project.layout.panel.wMm}×${project.layout.panel.hMm}mm（边框 ${project.layout.panel.frameMm}mm，${mountingLabel(
      project.layout.panel.mounting
    )}）`,
    fontText: `${fontLabel}　字重 ${project.layout.settings.weight}　字号 ${layout.sizeMm}mm（${alignLabel(project.layout.settings.align)}）`,
    layoutText:
      `占宽 ${layout.occupiedW}mm × 占高 ${layout.occupiedH}mm；` +
      `左留边 设定${layout.marginFit.nominalLeft}/实际${layout.marginFit.reservedLeft}mm，` +
      `右留边 设定${layout.marginFit.nominalRight}/实际${layout.marginFit.reservedRight}mm；` +
      `${layout.marginFit.note}；视觉间距极差 ${layout.gapSpread}mm`,
    rows,
    total: yuan(bom.totalCents),
    notes: [
      `面板材料：${bom.panelMaterial.name}（${bom.panelMaterial.desc}）`,
      `亚克力拼版：${bom.nesting.sheetCount} 张 ${bom.sheet.spec}，利用率 ${(bom.nesting.utilization * 100).toFixed(1)}%`,
      `LED：布点长度 ${bom.led.perimeterTotalMm}mm，模组 ${bom.led.modules} 只，额定功率 ${bom.led.ratedW}W，建议电源 ${bom.led.suggestedPsu}`,
      bom.led.note
    ].filter((s) => !!s),
    footer: '本报价基于当前材料单价，有效期 30 天；含材料与加工费，不含安装与运输。'
  }
}

function download(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 导出 Excel（.xls，Excel/WPS 可直接打开） */
export function exportQuoteXls(project: Project, layout: LayoutResult, bom: BomResult, fontLabel: string, compare: CompareRow[]): void {
  const doc = buildQuoteDoc(project, layout, bom, fontLabel)
  const table = `
  <table border="1">
    <tr><th colspan="6">${esc(doc.title)}</th></tr>
    <tr><td>项目</td><td colspan="5">${esc(doc.projectName)}</td></tr>
    <tr><td>门头尺寸</td><td colspan="5">${esc(doc.panelText)}</td></tr>
    <tr><td>字体/排版</td><td colspan="5">${esc(doc.fontText)}</td></tr>
    <tr><td>排版结果</td><td colspan="5">${esc(doc.layoutText)}</td></tr>
    <tr><th>类别</th><th>规格/说明</th><th>数量</th><th>单位</th><th>单价(元)</th><th>金额(元)</th></tr>
    ${doc.rows
      .map(
        (r) =>
          `<tr><td>${esc(r.group)}</td><td>${esc(r.spec)}</td><td>${esc(r.qty)}</td><td>${esc(r.unit)}</td><td>${esc(
            r.unitPrice
          )}</td><td>${esc(r.amount)}</td></tr>`
      )
      .join('\n')}
    <tr><td colspan="5">合计</td><td>${esc(doc.total)}</td></tr>
    <tr><th colspan="6">多材质成本对照（元）</th></tr>
    <tr><th>材质</th><th>说明</th><th>面板</th><th>LED+电源</th><th>配件</th><th>合计</th></tr>
    ${compare
      .map(
        (c) =>
          `<tr><td>${esc(c.name)}</td><td>${esc(c.desc)}</td><td>${yuan(c.panelCents)}</td><td>${yuan(
            c.ledCents + c.psuCents
          )}</td><td>${yuan(c.accessoryCents + c.laborCents)}</td><td>${yuan(c.totalCents)}</td></tr>`
      )
      .join('\n')}
    <tr><th colspan="6">工艺说明</th></tr>
    ${doc.notes.map((n) => `<tr><td colspan="6">${esc(n)}</td></tr>`).join('\n')}
    <tr><td colspan="6">${esc(doc.footer)}</td></tr>
  </table>`
  const html = `<html><head><meta charset="utf-8"></head><body>${table}</body></html>`
  download(`${project.name || '招牌'}报价单.xls`, new Blob([`\ufeff${html}`], { type: 'application/vnd.ms-excel;charset=utf-8' }))
}

/** 导出工艺卡（CSV，供车间流转；PDF 走浏览器打印） */
export function exportProcessCardCsv(project: Project, layout: LayoutResult, bom: BomResult, fontLabel: string): void {
  const lines: string[] = []
  lines.push('招牌字工艺卡')
  lines.push(`项目,${project.name}`)
  lines.push(`门头,${project.layout.panel.wMm}×${project.layout.panel.hMm}mm 边框${project.layout.panel.frameMm}mm`)
  lines.push(`字体,${fontLabel} 字重${project.layout.settings.weight} 字号${layout.sizeMm}mm`)
  lines.push(`排版,${alignLabel(project.layout.settings.align)} 占宽${layout.occupiedW}mm 占高${layout.occupiedH}mm`)
  lines.push('')
  lines.push('字形工艺分析')
  lines.push('字符,字号mm,笔画块数,外轮廓周长mm,最细笔画mm,轮廓数,警告')
  for (const g of layout.glyphs) {
    const outer = g.contours.filter((c) => !c.isHole).reduce((s, c) => s + c.perimeterMm, 0)
    lines.push(
      [g.char, g.sizeMm, g.strokeBlocks, outer.toFixed(1), g.minStrokeMm, g.contours.length, g.warnings.join(' / ')].join(',')
    )
  }
  lines.push('')
  lines.push('裁切清单')
  lines.push('料件,宽mm,高mm,数量')
  for (const c of bom.cutList) lines.push([c.label, c.wMm, c.hMm, c.count].join(','))
  lines.push('')
  lines.push('LED 与电源')
  lines.push(`布点长度mm,${bom.led.perimeterTotalMm}`)
  lines.push(`模组数,${bom.led.modules}`)
  lines.push(`额定功率W,${bom.led.ratedW}`)
  lines.push(`建议电源,${bom.led.suggestedPsu}`)
  lines.push(`说明,${bom.led.note}`)
  lines.push('')
  lines.push('亚克力拼版')
  lines.push(`板材,${bom.sheet.spec}`)
  lines.push(`板数,${bom.nesting.sheetCount}`)
  lines.push(`利用率,${(bom.nesting.utilization * 100).toFixed(1)}%`)
  download(`${project.name || '招牌'}工艺卡.csv`, new Blob([`\ufeff${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' }))
}