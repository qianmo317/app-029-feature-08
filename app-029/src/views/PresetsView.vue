<script setup lang="ts">
import { computed, ref } from 'vue'
import { defaultPresetDeep, resetPreset, savePreset, loadPreset } from '../logic/store'
import type { Preset } from '../logic/materials'
import { runAcceptance, type AcceptanceReport } from '../logic/selftest'
import { yuan } from '../logic/materials'

const preset = ref<Preset>(loadPreset())
const saved = ref('')
const report = ref<AcceptanceReport | null>(null)
const running = ref(false)

const dirty = computed(() => JSON.stringify(preset.value) !== JSON.stringify(loadPreset()))

function save(): void {
  savePreset(preset.value)
  saved.value = `已保存（${new Date().toLocaleTimeString('zh-CN')}）`
}

function reset(): void {
  preset.value = resetPreset()
  saved.value = '已恢复默认参数'
}

function restoreDefaults(): void {
  preset.value = defaultPresetDeep()
  saved.value = '已载入出厂默认（尚未保存）'
}

async function run(): Promise<void> {
  running.value = true
  report.value = null
  try {
    report.value = await runAcceptance(preset.value)
  } finally {
    running.value = false
  }
}

function addSheet(): void {
  preset.value.acrylicSheets.push({
    id: `custom-${Date.now().toString(36)}`,
    spec: '自定义板材（改规格与单价）',
    wMm: 1220,
    hMm: 2440,
    thicknessMm: 3,
    priceCents: 28000,
    kerfMm: 3
  })
}

function removeSheet(i: number): void {
  preset.value.acrylicSheets.splice(i, 1)
}
</script>

<template>
  <div class="page">
    <div class="grid cols-2" style="align-items: start">
      <section class="card">
        <header>
          <h1>材质与工艺预设</h1>
          <span class="hint">{{ saved || '改动会自动保存到本地' }}</span>
        </header>
        <div class="row">
          <button class="primary" @click="save">保存参数</button>
          <button @click="restoreDefaults">载入出厂默认</button>
          <button class="danger" @click="reset">恢复默认并保存</button>
          <span class="tag" v-if="dirty">有未保存改动</span>
        </div>

        <h3 style="margin-top: 14px">工艺参数</h3>
        <div class="field">
          <label>最细笔画下限（mm）</label>
          <div class="ctl"><input type="number" v-model.number="preset.process.strokeLimitMm" min="1" step="1" /></div>
        </div>
        <div class="field">
          <label>默认字距比例（×字号）</label>
          <div class="ctl"><input type="number" v-model.number="preset.process.defaultTrackRatio" step="0.01" /></div>
        </div>
        <div class="field">
          <label>自动字号预留留边比例</label>
          <div class="ctl"><input type="number" v-model.number="preset.process.defaultMarginRatio" step="0.01" /></div>
        </div>
        <div class="field">
          <label>默认行距比例</label>
          <div class="ctl"><input type="number" v-model.number="preset.process.defaultLineGapRatio" step="0.01" /></div>
        </div>
        <div class="field">
          <label>默认铝塑板边框（mm）</label>
          <div class="ctl"><input type="number" v-model.number="preset.process.panelFrameMm" step="5" /></div>
        </div>

        <h3 style="margin-top: 14px">亚克力板材</h3>
        <table>
          <thead>
            <tr><th>名称</th><th class="num">宽</th><th class="num">高</th><th class="num">厚</th><th class="num">单价（元）</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="(s, i) in preset.acrylicSheets" :key="s.id">
              <td><input type="text" v-model="s.spec" style="width: 100%" /></td>
              <td class="num"><input type="number" v-model.number="s.wMm" step="10" style="width: 74px" /></td>
              <td class="num"><input type="number" v-model.number="s.hMm" step="10" style="width: 74px" /></td>
              <td class="num"><input type="number" v-model.number="s.thicknessMm" step="1" style="width: 56px" /></td>
              <td class="num"><input type="number" v-model.number="s.priceCents" step="100" style="width: 84px" /></td>
              <td><button class="danger" @click="removeSheet(i)">删</button></td>
            </tr>
          </tbody>
        </table>
        <button style="margin-top: 6px" @click="addSheet">新增板材规格</button>

        <h3 style="margin-top: 14px">LED 模组</h3>
        <table>
          <thead>
            <tr><th>型号说明</th><th class="num">间距</th><th class="num">功率 W</th><th class="num">亮度 lm</th><th class="num">单价（分）</th></tr>
          </thead>
          <tbody>
            <tr v-for="m in preset.ledModules" :key="m.id">
              <td><input type="text" v-model="m.spec" style="width: 100%" /></td>
              <td class="num"><input type="number" v-model.number="m.spacingMm" step="10" style="width: 66px" /></td>
              <td class="num"><input type="number" v-model.number="m.powerW" step="0.01" style="width: 66px" /></td>
              <td class="num"><input type="number" v-model.number="m.lumen" step="5" style="width: 62px" /></td>
              <td class="num"><input type="number" v-model.number="m.priceCents" step="1" style="width: 62px" /></td>
            </tr>
          </tbody>
        </table>

        <h3 style="margin-top: 14px">电源</h3>
        <div class="field">
          <label>默认效率</label>
          <div class="ctl"><input type="number" v-model.number="preset.psu.efficiency" step="0.01" /></div>
        </div>
        <div class="field">
          <label>默认安全系数</label>
          <div class="ctl"><input type="number" v-model.number="preset.psu.safetyFactor" step="0.05" /></div>
        </div>
        <div class="field">
          <label>标准功率档位（W）</label>
          <div class="ctl">
            <input
              type="text"
              :value="preset.psu.tiers.join(',')"
              style="width: 200px"
              @change="
                preset.psu.tiers = ($event.target as HTMLInputElement).value
                  .split(',')
                  .map((x) => Number(x.trim()))
                  .filter((x) => Number.isFinite(x) && x > 0)
              "
            />
            <span class="muted">英文逗号分隔</span>
          </div>
        </div>
        <div class="field">
          <label>电源单价（分/W）</label>
          <div class="ctl"><input type="number" v-model.number="preset.psu.pricePerWattCents" step="10" /></div>
        </div>

        <h3 style="margin-top: 14px">胶与配件</h3>
        <table>
          <thead>
            <tr><th>名称</th><th class="num">单价（分）</th><th>单位</th><th class="num">用量系数</th><th>计量口径</th></tr>
          </thead>
          <tbody>
            <tr v-for="c in preset.consumables" :key="c.id">
              <td><input type="text" v-model="c.spec" style="width: 100%" /></td>
              <td class="num"><input type="number" v-model.number="c.unitPriceCents" step="10" style="width: 80px" /></td>
              <td><input type="text" v-model="c.unit" style="width: 44px" /></td>
              <td class="num"><input type="number" v-model.number="c.rule.value" step="0.005" style="width: 78px" /></td>
              <td class="muted mono">{{ c.rule.type }}</td>
            </tr>
          </tbody>
        </table>

        <h3 style="margin-top: 14px">加工费</h3>
        <table>
          <thead>
            <tr><th>项目</th><th class="num">单价（分）</th><th>单位</th><th class="num">系数</th><th>计量口径</th></tr>
          </thead>
          <tbody>
            <tr v-for="l in preset.labor" :key="l.id">
              <td><input type="text" v-model="l.spec" style="width: 100%" /></td>
              <td class="num"><input type="number" v-model.number="l.unitPriceCents" step="100" style="width: 84px" /></td>
              <td><input type="text" v-model="l.unit" style="width: 44px" /></td>
              <td class="num"><input type="number" v-model.number="l.rule.value" step="0.05" style="width: 70px" /></td>
              <td class="muted mono">{{ l.rule.type }}</td>
            </tr>
          </tbody>
        </table>

        <h3 style="margin-top: 14px">多材质对照单价</h3>
        <table>
          <thead>
            <tr><th>材质</th><th class="num">元/㎡</th><th class="num">元/米周长</th><th class="num">加工费 元/字</th><th>发光</th></tr>
          </thead>
          <tbody>
            <tr v-for="m in preset.panelMaterials" :key="m.id">
              <td><input type="text" v-model="m.name" style="width: 96px" /></td>
              <td class="num"><input type="number" v-model.number="m.areaPriceCentsPerM2" step="500" style="width: 88px" /></td>
              <td class="num"><input type="number" v-model.number="m.perimeterPriceCentsPerM" step="100" style="width: 80px" /></td>
              <td class="num"><input type="number" v-model.number="m.charLaborCents" step="100" style="width: 80px" /></td>
              <td><input type="checkbox" v-model="m.useLed" /></td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="card">
        <header>
          <h2>验收自检（规格书第 10 节）</h2>
          <span class="hint">{{ report ? `用时 ${report.elapsedMs.toFixed(0)}ms` : '在浏览器中真实运行全部断言' }}</span>
        </header>
        <div class="row">
          <button class="primary" :disabled="running" @click="run">{{ running ? '运行中…' : '运行全部验收用例' }}</button>
          <span class="tag" v-if="report" :class="report.allPass ? 'ok' : 'bad'">
            {{ report.allPass ? '全部通过' : '存在未通过项' }}
          </span>
        </div>
        <p class="muted" style="margin-top: 6px">
          覆盖：排版正确性与建议字号、视觉间距极差、20 字连通域与最细笔画、低于工艺下限的警告与拦截、LED 与电源档位、板材拼版利用率、
          金额整数分合计、断网可用与 12 字性能；另含两套独立算法互验（扫描线并查集 vs 光栅洪泛）。
        </p>

        <div v-if="report" style="margin-top: 10px">
          <div v-for="c in report.checks" :key="c.id" class="card" style="margin-bottom: 10px; padding: 10px 12px">
            <header style="margin-bottom: 6px">
              <h3>
                <span class="tag" :class="c.pass ? 'ok' : 'bad'">{{ c.pass ? 'PASS' : 'FAIL' }}</span>
                {{ c.id }} {{ c.title }}
              </h3>
              <span class="hint">{{ c.detail }}</span>
            </header>
            <ul class="notes">
              <li v-for="(e, i) in c.evidence" :key="i" class="mono" style="font-size: 12px">{{ e }}</li>
            </ul>
          </div>
          <h3>拼版与金额核对摘录</h3>
          <p class="muted">
            合计金额示例：¥{{ yuan(12345) }}（当前预设置下报价单页面展示实际金额）；所有金额按整数「分」计算，Σ 明细 = 合计。
          </p>
        </div>
      </section>
    </div>
  </div>
</template>