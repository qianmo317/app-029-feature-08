﻿<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import SheetDiagram from '../components/SheetDiagram.vue'
import { findFont } from '../logic/fontLoader'
import { alignLabel } from '../logic/layout'
import { assertBomSum, buildBom, compareMaterials, yuan } from '../logic/materials'
import { bomGroupLabel, exportProcessCardCsv } from '../logic/quote'
import { getProject } from '../logic/store'
import { useSession } from '../logic/useSession'
import type { Project } from '../logic/types'

const route = useRoute()
const loaded = ref<Project | null>(getProject(String(route.params.id)))
const session = useSession(loaded)
const project = computed(() => loaded.value)
const layout = session.layout
const preset = session.preset
const ack = ref(false)

const bom = computed(() => (project.value && layout.value ? buildBom(project.value, layout.value, preset.value, { acknowledgeThinStroke: ack.value }) : null))
const sumCheck = computed(() => (bom.value ? assertBomSum(bom.value) : null))
const compare = computed(() =>
  project.value && layout.value && bom.value ? compareMaterials(project.value, layout.value, preset.value, bom.value) : []
)

const grouped = computed(() => {
  const b = bom.value
  if (!b) return []
  const map = new Map<string, { label: string; rows: typeof b.materials }>()
  for (const m of b.materials) {
    const label = bomGroupLabel(m.kind)
    const hit = map.get(m.kind) ?? { label, rows: [] }
    hit.rows.push(m)
    map.set(m.kind, hit)
  }
  return [...map.values()]
})

function applySheet(id: string): void {
  if (project.value) project.value.sheetId = id
}

function processCard(): void {
  if (project.value && layout.value && bom.value) {
    exportProcessCardCsv(project.value, layout.value, bom.value, findFont(project.value.layout.settings.fontId)?.family ?? '')
  }
}
</script>

<template>
  <div class="page">
    <div v-if="!project" class="card">
      <h1>项目不存在</h1>
      <router-link to="/">返回项目列表</router-link>
    </div>

    <template v-else>
      <div v-if="bom?.blocked" class="banner bad">
        <b>工艺风险拦截：</b>
        <ul class="notes" style="color: inherit">
          <li v-for="(r, i) in bom.blockReasons" :key="i">{{ r }}</li>
        </ul>
        <button class="primary" style="margin-top: 6px" @click="ack = true">已确认工艺风险，继续出报价</button>
        <span class="muted" style="margin-left: 8px">未确认前不出报价单（避免做不出来的活）</span>
      </div>

      <div class="split">
        <section class="card">
          <header>
            <h1>材料清单</h1>
            <span class="hint">{{ project.name }}</span>
          </header>

          <div class="field">
            <label>面板材料方案</label>
            <div class="ctl">
              <select v-model="project.panelMaterialId">
                <option v-for="m in preset.panelMaterials" :key="m.id" :value="m.id">{{ m.name }}</option>
              </select>
            </div>
          </div>
          <div class="field">
            <label>亚克力板材规格</label>
            <div class="ctl">
              <select :value="project.sheetId" @change="applySheet(($event.target as HTMLSelectElement).value)">
                <option v-for="s in preset.acrylicSheets" :key="s.id" :value="s.id">{{ s.spec }}</option>
              </select>
            </div>
          </div>

          <h3 style="margin-top: 12px">材料用量要点</h3>
          <div class="kv-list">
            <span class="muted">异形字口径</span><span>按外接矩形（每个连通域一件），不用轮廓面积</span>
            <span class="muted">拼版方式</span><span>分层装箱（guillotine，料条横向贯通）</span>
            <span class="muted">料件总数</span><span class="mono">{{ bom?.nesting.pieceCount ?? 0 }} 件</span>
            <span class="muted">料件面积</span><span class="mono">{{ bom?.pieceAreaM2.toFixed(3) ?? 0 }} ㎡</span>
            <span class="muted">用板数量</span><span class="mono">{{ bom?.nesting.sheetCount ?? 0 }} 张</span>
            <span class="muted">综合利用率</span>
            <span class="mono">{{ bom ? (bom.nesting.utilization * 100).toFixed(1) : 0 }}%</span>
            <span class="muted">排版摘要</span>
            <span>
              {{ layout?.sizeMm }}mm · {{ alignLabel(project.layout.settings.align) }} · 占宽 {{ layout?.occupiedW }}mm · 视觉间距极差
              {{ layout?.gapSpread }}mm
            </span>
          </div>

          <div class="row" style="margin-top: 12px">
            <button @click="processCard">导出工艺卡（CSV）</button>
            <router-link :to="`/quote/${project.id}`"><button class="primary">去报价单</button></router-link>
          </div>
          <p class="muted" v-if="bom?.nesting.oversize.length">
            超板料件：{{ bom.nesting.oversize.map((p) => `${p.label} ${p.wMm}×${p.hMm}`).join('；') }}（需换更大板材或分件拼接）
          </p>
        </section>

        <section>
          <div class="card">
            <header>
              <h2>材料明细与金额</h2>
              <span class="hint">金额单位「分」，Σ 明细 = 合计</span>
            </header>
            <table>
              <thead>
                <tr>
                  <th>类别</th>
                  <th>规格 / 说明</th>
                  <th class="num">数量</th>
                  <th>单位</th>
                  <th class="num">单价（元）</th>
                  <th class="num">金额（元）</th>
                </tr>
              </thead>
              <tbody>
                <template v-for="g in grouped" :key="g.label">
                  <tr v-for="(m, i) in g.rows" :key="`${g.label}${i}`">
                    <td>{{ i === 0 ? g.label : '' }}</td>
                    <td>{{ m.spec }}</td>
                    <td class="num">{{ m.qty }}</td>
                    <td>{{ m.unit }}</td>
                    <td class="num">{{ yuan(m.unitPriceCents) }}</td>
                    <td class="num">{{ yuan(m.amountCents) }}</td>
                  </tr>
                </template>
              </tbody>
              <tfoot>
                <tr>
                  <td colspan="5">合计</td>
                  <td class="num">{{ bom ? yuan(bom.totalCents) : '0.00' }}</td>
                </tr>
              </tfoot>
            </table>
            <p class="muted">{{ sumCheck?.message }}</p>
          </div>

          <div class="card" style="margin-top: 14px">
            <header>
              <h2>板材拼版图（{{ bom?.sheet.wMm }}×{{ bom?.sheet.hMm }}mm）</h2>
              <span class="hint">细虚线为分层切割线</span>
            </header>
            <SheetDiagram v-if="bom" :nesting="bom.nesting" :sheet-w="bom.sheet.wMm" :sheet-h="bom.sheet.hMm" />
          </div>

          <div class="card" style="margin-top: 14px">
            <header>
              <h2>裁切尺寸清单</h2>
              <span class="hint">同尺寸合并计数</span>
            </header>
            <table>
              <thead>
                <tr><th>料件</th><th class="num">宽 mm</th><th class="num">高 mm</th><th class="num">数量</th></tr>
              </thead>
              <tbody>
                <tr v-for="(c, i) in bom?.cutList ?? []" :key="i">
                  <td>{{ c.label }}</td>
                  <td class="num">{{ c.wMm }}</td>
                  <td class="num">{{ c.hMm }}</td>
                  <td class="num">{{ c.count }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="card" style="margin-top: 14px">
            <header>
              <h2>多材质成本对照</h2>
              <span class="hint">同一排版结果下 5 种工艺</span>
            </header>
            <table>
              <thead>
                <tr>
                  <th>材质</th>
                  <th>说明</th>
                  <th class="num">面板</th>
                  <th class="num">LED</th>
                  <th class="num">电源</th>
                  <th class="num">配件</th>
                  <th class="num">加工</th>
                  <th class="num">合计（元）</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in compare" :key="c.id" :class="{ 'row-active': c.id === project.panelMaterialId }">
                  <td>{{ c.name }}</td>
                  <td class="muted">{{ c.desc }}</td>
                  <td class="num">{{ yuan(c.panelCents) }}</td>
                  <td class="num">{{ yuan(c.ledCents) }}</td>
                  <td class="num">{{ yuan(c.psuCents) }}</td>
                  <td class="num">{{ yuan(c.accessoryCents) }}</td>
                  <td class="num">{{ yuan(c.laborCents) }}</td>
                  <td class="num"><b>{{ yuan(c.totalCents) }}</b></td>
                </tr>
              </tbody>
            </table>
            <p class="muted">
              蓝色高亮行为<strong>当前选中方案</strong>：直接采用实际材料清单（与报价单金额一致）；其余行为按预设单价估算。非发光材质不计 LED 与电源，配件与加工按同工艺比例折算。
            </p>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>