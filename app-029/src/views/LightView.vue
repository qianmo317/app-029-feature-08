<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import PanelPreview from '../components/PanelPreview.vue'
import { computeLed, ledRows } from '../logic/led'
import { getProject } from '../logic/store'
import { useSession } from '../logic/useSession'
import type { Project } from '../logic/types'

const route = useRoute()
const loaded = ref<Project | null>(getProject(String(route.params.id)))
const session = useSession(loaded)
const project = computed(() => loaded.value)
const layout = session.layout
const preset = session.preset

const led = computed(() =>
  project.value && layout.value
    ? computeLed(layout.value.ledLengthMm, project.value.led, preset.value.psu)
    : null
)

const rows = computed(() => (layout.value ? ledRows(layout.value.chars, project.value!.led) : []))
const totalLumen = computed(() => (led.value ? led.value.modules * project.value!.led.moduleLumen : 0))

function applyModule(id: string): void {
  const m = preset.value.ledModules.find((x) => x.id === id)
  if (!m || !project.value) return
  project.value.ledModuleId = m.id
  project.value.led.moduleSpacingMm = m.spacingMm
  project.value.led.modulePowerW = m.powerW
  project.value.led.moduleLumen = m.lumen
}

const grade = computed(() => {
  if (!led.value || !project.value) return ''
  const spacing = project.value.led.moduleSpacingMm
  const size = layout.value?.sizeMm ?? 0
  const ratio = spacing / Math.max(1, size)
  if (ratio > 0.55) return '模组间距偏大（> 0.55×字高）：大笔画中间容易发暗，建议加密'
  if (ratio < 0.18) return '模组间距偏小（< 0.18×字高）：模组数量与发热偏高，建议放宽'
  return `模组间距 ${spacing}mm ≈ ${(ratio * 100).toFixed(0)}% 字高，布点密度合适`
})
</script>

<template>
  <div class="page">
    <div v-if="!project" class="card">
      <h1>项目不存在</h1>
      <router-link to="/">返回项目列表</router-link>
    </div>

    <template v-else>
      <div class="split">
        <section class="card">
          <header>
            <h1>LED 与电源计算</h1>
            <span class="hint">{{ project.name }}</span>
          </header>

          <div class="field">
            <label>模组规格预设</label>
            <div class="ctl">
              <select :value="project.ledModuleId" @change="applyModule(($event.target as HTMLSelectElement).value)">
                <option v-for="m in preset.ledModules" :key="m.id" :value="m.id">{{ m.spec }}</option>
              </select>
            </div>
          </div>
          <div class="field">
            <label>模组间距（mm）</label>
            <div class="ctl"><input type="number" v-model.number="project.led.moduleSpacingMm" min="20" step="10" /></div>
          </div>
          <div class="field">
            <label>单模组功率（W）</label>
            <div class="ctl"><input type="number" v-model.number="project.led.modulePowerW" min="0.05" step="0.01" /></div>
          </div>
          <div class="field">
            <label>单模组亮度（lm）</label>
            <div class="ctl"><input type="number" v-model.number="project.led.moduleLumen" min="5" step="5" /></div>
          </div>
          <div class="field">
            <label>安全系数</label>
            <div class="ctl">
              <input type="number" v-model.number="project.led.safetyFactor" min="1" max="2" step="0.05" />
              <span class="muted">默认 1.2</span>
            </div>
          </div>
          <div class="field">
            <label>电源效率</label>
            <div class="ctl">
              <input type="number" v-model.number="project.led.psuEfficiency" min="0.5" max="1" step="0.01" />
              <span class="muted">默认 0.85</span>
            </div>
          </div>

          <h3 style="margin-top: 14px">计算公式（可复算）</h3>
          <div class="formula">总布点长度 L = Σ 每个连通域的外轮廓周长（不含内孔）= {{ layout?.ledLengthMm ?? 0 }} mm
模组数 N = ceil(L / 模组间距) = ceil({{ led?.perimeterTotalMm ?? 0 }} / {{ project.led.moduleSpacingMm }}) = {{ led?.modules ?? 0 }}
额定功率 P = N × 单模组功率 × 安全系数 = {{ led?.modules ?? 0 }} × {{ project.led.modulePowerW }} × {{ project.led.safetyFactor }} = {{ led?.ratedW ?? 0 }} W
电源功率 = P / 电源效率 = {{ led?.ratedW ?? 0 }} / {{ project.led.psuEfficiency }} = {{ led?.recommendedW ?? 0 }} W
标准档位：{{ preset.psu.tiers.join(' / ') }} W 向上取</div>

          <ul class="notes" style="margin-top: 10px">
            <li>模组数向上取整会显式提示补足数量，不静默取整。</li>
            <li>电源按标准档位向上取；超出常用档位时提示多电源并联/分区供电。</li>
            <li>布点长度取外轮廓（内孔不计），与车间实际走线一致。</li>
          </ul>
        </section>

        <section>
          <div class="card">
            <header>
              <h2>计算结果</h2>
              <span class="hint">当前项目材料预设置</span>
            </header>
            <div v-if="led" class="metrics">
              <span class="k">总布点长度 L</span><span class="v">{{ led.perimeterTotalMm }} mm</span>
              <span class="k">理论布点数（小数）</span><span class="v">{{ led.exactModules }}</span>
              <span class="k">模组数量 N</span><span class="v">{{ led.modules }} 只</span>
              <span class="k">向上取整补足</span><span class="v">{{ led.extraModules }} 只</span>
              <span class="k">末段余长</span><span class="v">{{ led.spareMm }} mm</span>
              <span class="k">额定功率（含安全系数）</span><span class="v">{{ led.ratedW }} W</span>
              <span class="k">电源需求功率</span><span class="v">{{ led.recommendedW }} W</span>
              <span class="k">建议电源</span><span class="v">{{ led.suggestedPsu }}</span>
              <span class="k">总光通量（估算）</span><span class="v">{{ totalLumen }} lm</span>
            </div>
            <div class="banner info" v-if="led">{{ led.note }}</div>
            <div class="banner warn" v-if="grade">{{ grade }}</div>
            <div class="banner warn" v-if="led && led.psuCount > 1">
              需 {{ led.psuCount }} 台电源：建议按字/按区分区供电，每区单独回路，避免长距离压降。
            </div>
          </div>

          <div class="card" style="margin-top: 14px">
            <header>
              <h2>布点示意（按模组间距在外轮廓上布点）</h2>
              <span class="hint">黄色圆点 = 模组位置</span>
            </header>
            <PanelPreview
              v-if="layout"
              :project="project"
              :layout="layout"
              :show-led="true"
              :show-dims="true"
              :show-margins="false"
            />
          </div>

          <div class="card" style="margin-top: 14px">
            <header>
              <h2>逐字用量明细</h2>
              <span class="hint">模块数按每个连通域外轮廓分别向上取整</span>
            </header>
            <table>
              <thead>
                <tr>
                  <th>字符</th>
                  <th class="num">笔画块数</th>
                  <th class="num">外轮廓周长 mm</th>
                  <th class="num">模组数</th>
                  <th class="num">功率 W</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(r, i) in rows" :key="i">
                  <td>{{ r.char }}</td>
                  <td class="num">{{ r.blocks }}</td>
                  <td class="num">{{ r.outerPerimeterMm }}</td>
                  <td class="num">{{ r.modules }}</td>
                  <td class="num">{{ r.ratedW }}</td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <td>合计</td>
                  <td class="num">{{ rows.reduce((s, r) => s + r.blocks, 0) }}</td>
                  <td class="num">{{ led?.perimeterTotalMm ?? 0 }}</td>
                  <td class="num">{{ rows.reduce((s, r) => s + r.modules, 0) }}</td>
                  <td class="num">{{ rows.reduce((s, r) => s + r.ratedW, 0).toFixed(2) }}</td>
                </tr>
              </tfoot>
            </table>
            <p class="muted">
              逐字模组数之和可能略大于整体向上取整值（整排按总长度一次取整更省料），报价以总长度计算为准。
            </p>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>