<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import PanelPreview from '../components/PanelPreview.vue'
import { findFont, fontState, listFonts } from '../logic/fontLoader'
import { round1, sideDesiredMm, textToItems } from '../logic/layout'
import { getProject } from '../logic/store'
import { loadPrefs, savePrefs } from '../logic/store'
import { useSession } from '../logic/useSession'
import type { CharMode, Project } from '../logic/types'

const route = useRoute()
const id = String(route.params.id)
const loaded = ref<Project | null>(getProject(id))
const session = useSession(loaded)
const overlays = ref({ blocks: true, minStroke: true, led: false })
const active = ref<number | null>(0)
const fontError = ref('')

const project = computed(() => loaded.value)
const layout = session.layout
const fonts = computed(() => listFonts())
const weightOptions = computed(() =>
  project.value ? findFont(project.value.layout.settings.fontId)?.weights.map((w) => w.weight) ?? [] : []
)

const text = computed({
  get: () => {
    const p = project.value
    if (!p) return ''
    const lines: string[] = []
    for (const it of p.layout.items) {
      while (lines.length <= it.line) lines.push('')
      lines[it.line] += it.char
    }
    return lines.join('\n')
  },
  set: (v: string) => {
    const p = project.value
    if (!p) return
    p.layout.items = textToItems(v.replace(/\r/g, ''), p.layout.items, p.layout.settings, layout.value?.sizeMm ?? p.layout.settings.baseSizeMm)
    if (active.value !== null && active.value >= p.layout.items.length) active.value = p.layout.items.length ? 0 : null
  }
})

const perfText = computed(() => (session.perfMs.value ? `${session.perfMs.value.toFixed(1)}ms` : '—'))
const fontStatus = computed(() => {
  void session.fontTick.value
  const p = project.value
  if (!p) return ''
  const st = fontState(p.layout.settings.fontId, p.layout.settings.weight)
  return st.message
})
const fontOk = session.fontOk

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  const p = project.value
  if (p) {
    try {
      await (await import('../logic/fontLoader')).ensureFont(p.layout.settings.fontId, p.layout.settings.weight)
      fontError.value = ''
    } catch (e) {
      fontError.value = e instanceof Error ? e.message : '该字体不可用'
    }
    active.value = p.layout.items.length ? 0 : null
  }
})
onUnmounted(() => window.removeEventListener('keydown', onKey))

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

function onKey(e: KeyboardEvent): void {
  if (isTypingTarget(e.target)) return
  const p = project.value
  if (!p || active.value === null) return
  const step = e.shiftKey ? 5 : 1
  const it = p.layout.items[active.value]
  if (!it) return
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const dir = e.key === 'ArrowLeft' ? -1 : 1
    it.trackMm = round1(it.trackMm + dir * step)
    it.trackTouched = true
    e.preventDefault()
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const dir = e.key === 'ArrowUp' ? -1 : 1
    it.offsetYMm = round1(it.offsetYMm + dir * step)
    e.preventDefault()
  }
}

function resetTrack(index: number): void {
  const p = project.value
  if (!p) return
  const it = p.layout.items[index]
  if (!it) return
  it.trackTouched = false
  it.trackMm = round1(p.layout.settings.trackRatio * (layout.value?.sizeMm ?? p.layout.settings.baseSizeMm))
}

function resetAllTracks(): void {
  const p = project.value
  if (!p) return
  for (const it of p.layout.items) {
    it.trackTouched = false
    it.trackMm = round1(p.layout.settings.trackRatio * (layout.value?.sizeMm ?? p.layout.settings.baseSizeMm))
    it.offsetYMm = 0
  }
}

function applySuggested(): void {
  const p = project.value
  const l = layout.value
  if (!p || !l || l.suggestedSizeMm === null) return
  session.autoFit.value = false
  p.layout.settings.baseSizeMm = l.suggestedSizeMm
}

function setAutoFit(v: boolean): void {
  session.autoFit.value = v
}

const activeGlyph = computed(() => {
  const l = layout.value
  if (!l || active.value === null) return null
  return l.glyphs[active.value] ?? null
})

const activeCharStat = computed(() => {
  const l = layout.value
  if (!l || active.value === null) return null
  return l.chars[active.value] ?? null
})

const gapList = computed(() => {
  const l = layout.value
  if (!l) return []
  return l.chars
    .map((c, i) => ({ i, char: c.char, gap: c.gapAfter, next: l.chars[i + 1]?.char ?? '' }))
    .filter((x) => x.gap !== null)
})

const nightPref = ref(loadPrefs().nightPreview)
watch(nightPref, (v) => savePrefs({ nightPreview: v }))

const leftDesiredMm = computed(() => {
  const l = layout.value
  const p = project.value
  if (!l || !p) return 0
  return sideDesiredMm(p.layout.settings.margins.left, l.sizeMm)
})
const rightDesiredMm = computed(() => {
  const l = layout.value
  const p = project.value
  if (!l || !p) return 0
  return sideDesiredMm(p.layout.settings.margins.right, l.sizeMm)
})

const previewKey = computed(() => `${layout.value?.sizeMm}-${session.fontTick.value}`)

function areaM2(w: number, h: number): string {
  return (w * h / 1e6).toFixed(4)
}
</script>

<template>
  <div class="page">
    <div v-if="!project" class="card">
      <h1>项目不存在</h1>
      <p class="muted">该门头项目可能已被删除。</p>
      <router-link to="/">返回项目列表</router-link>
    </div>

    <template v-else>
      <div class="banner bad" v-if="fontError">{{ fontError }}</div>
      <div class="banner info" v-else-if="!fontOk">字体状态：{{ fontStatus }}</div>

      <div class="split">
        <section class="card">
          <header>
            <h1>{{ project.name }}</h1>
            <span class="hint">排版编辑</span>
          </header>

          <div class="field">
            <label>门头 宽×高（mm）</label>
            <div class="ctl">
              <input type="number" v-model.number="project.layout.panel.wMm" min="200" step="10" />
              <span class="muted">×</span>
              <input type="number" v-model.number="project.layout.panel.hMm" min="100" step="10" />
            </div>
          </div>
          <div class="field">
            <label>边框 / 安装方式</label>
            <div class="ctl">
              <input type="number" v-model.number="project.layout.panel.frameMm" min="0" step="10" />
              <select v-model="project.layout.panel.mounting">
                <option value="wall">贴墙</option>
                <option value="board">挂板</option>
                <option value="freestanding">立牌</option>
              </select>
            </div>
          </div>
          <div class="field">
            <label>文字（多行）</label>
            <div class="ctl"></div>
          </div>
          <textarea v-model="text" rows="3"></textarea>
          <div class="field" style="margin-top: 8px">
            <label>字体</label>
            <div class="ctl">
              <select v-model="project.layout.settings.fontId">
                <option v-for="f in fonts" :key="f.id" :value="f.id">{{ f.label }}（{{ f.family }}）</option>
              </select>
            </div>
          </div>
          <div class="field">
            <label>字重</label>
            <div class="ctl">
              <select v-model.number="project.layout.settings.weight">
                <option v-for="w in weightOptions" :key="w" :value="w">{{ w }}</option>
              </select>
              <span class="muted" v-if="weightOptions.length < 2">该字体只有 1 个字重</span>
            </div>
          </div>
          <div class="field">
            <label>字号（mm）</label>
            <div class="ctl">
              <input
                type="number"
                :value="layout ? layout.sizeMm : project.layout.settings.baseSizeMm"
                min="10"
                step="10"
                :disabled="session.autoFit.value"
                @input="
                  (e) => {
                    session.autoFit.value = false
                    project!.layout.settings.baseSizeMm = Number((e.target as HTMLInputElement).value)
                  }
                "
              />
              <button :class="{ primary: session.autoFit.value }" @click="setAutoFit(!session.autoFit.value)">
                {{ session.autoFit.value ? '自动字号（按门头宽度）' : '手动字号' }}
              </button>
            </div>
          </div>
          <div class="field">
            <label>对齐</label>
            <div class="ctl">
              <select v-model="project.layout.settings.align">
                <option value="left">左对齐</option>
                <option value="center">居中</option>
                <option value="right">右对齐</option>
                <option value="justify">两端对齐</option>
              </select>
            </div>
          </div>
          <div class="field">
            <label>默认字距比例</label>
            <div class="ctl">
              <input type="number" v-model.number="project.layout.settings.trackRatio" min="0" max="1" step="0.01" />
              <span class="muted">={{ (project.layout.settings.trackRatio * (layout ? layout.sizeMm : 0)).toFixed(1) }}mm</span>
            </div>
          </div>
          <div class="field">
            <label>工艺下限（最细笔画 mm）</label>
            <div class="ctl"><input type="number" v-model.number="project.layout.settings.strokeLimitMm" min="1" step="1" /></div>
          </div>
          <div class="field">
            <label>左右留边（分开设置）</label>
            <div class="ctl"></div>
          </div>
          <div class="margin-cfg">
            <div class="margin-side" :class="{ keep: project.layout.settings.margins.keepSide === 'left' }">
              <div class="row" style="gap: 6px">
                <b>左侧</b>（立柱侧）
                <label class="muted"><input type="radio" value="left" v-model="project.layout.settings.margins.keepSide" /> 先保这边</label>
              </div>
              <div class="row" style="gap: 6px; margin-top: 4px">
                <select v-model="project.layout.settings.margins.left.mode">
                  <option value="ratio">按字号比例</option>
                  <option value="fixed">固定毫米</option>
                </select>
                <input
                  v-if="project.layout.settings.margins.left.mode === 'ratio'"
                  type="number"
                  v-model.number="project.layout.settings.margins.left.ratio"
                  min="0"
                  max="1"
                  step="0.01"
                />
                <input
                  v-else
                  type="number"
                  v-model.number="project.layout.settings.margins.left.fixedMm"
                  min="0"
                  step="5"
                />
                <span class="muted">{{ leftDesiredMm.toFixed(1) }}mm</span>
              </div>
              <div class="row" style="gap: 6px; margin-top: 4px">
                <span class="muted">让位下限</span>
                <input type="number" v-model.number="project.layout.settings.margins.left.minMm" min="0" step="5" />
                <span class="muted">mm</span>
              </div>
            </div>
            <div class="margin-side" :class="{ keep: project.layout.settings.margins.keepSide === 'right' }">
              <div class="row" style="gap: 6px">
                <b>右侧</b>（卷帘门侧）
                <label class="muted"><input type="radio" value="right" v-model="project.layout.settings.margins.keepSide" /> 先保这边</label>
              </div>
              <div class="row" style="gap: 6px; margin-top: 4px">
                <select v-model="project.layout.settings.margins.right.mode">
                  <option value="ratio">按字号比例</option>
                  <option value="fixed">固定毫米</option>
                </select>
                <input
                  v-if="project.layout.settings.margins.right.mode === 'ratio'"
                  type="number"
                  v-model.number="project.layout.settings.margins.right.ratio"
                  min="0"
                  max="1"
                  step="0.01"
                />
                <input
                  v-else
                  type="number"
                  v-model.number="project.layout.settings.margins.right.fixedMm"
                  min="0"
                  step="5"
                />
                <span class="muted">{{ rightDesiredMm.toFixed(1) }}mm</span>
              </div>
              <div class="row" style="gap: 6px; margin-top: 4px">
                <span class="muted">让位下限</span>
                <input type="number" v-model.number="project.layout.settings.margins.right.minMm" min="0" step="5" />
                <span class="muted">mm</span>
              </div>
            </div>
          </div>
          <p class="muted" style="margin: 4px 0 0">
            宽度不够时：先压「非保侧」留边到其下限，还不够才整体缩字号；保的一侧尽量不动。
          </p>

          <div class="row" style="margin-top: 8px">
            <label class="muted"><input type="checkbox" v-model="overlays.blocks" /> 笔画块着色</label>
            <label class="muted"><input type="checkbox" v-model="overlays.minStroke" /> 最细笔画位置</label>
            <label class="muted"><input type="checkbox" v-model="overlays.led" /> LED 布点</label>
            <label class="muted"><input type="checkbox" v-model="nightPref" /> 夜间发光预览</label>
          </div>
          <div class="row" style="margin-top: 6px">
            <button @click="resetAllTracks">重置逐字微调</button>
            <span class="muted">排版耗时 {{ perfText }}</span>
          </div>
        </section>

        <section>
          <div class="card">
            <header>
              <h2>预览（按真实比例）</h2>
              <span class="hint">超出安装区时边框变红</span>
            </header>
            <PanelPreview
              v-if="layout"
              :key="previewKey"
              :project="project"
              :layout="layout"
              :show-blocks="overlays.blocks"
              :show-min-stroke="overlays.minStroke"
              :show-led="overlays.led"
              :night="nightPref"
              :active-char="active"
            />
            <p v-else class="muted">字体加载中…</p>
          </div>

          <div class="grid cols-2" style="margin-top: 14px" v-if="layout">
            <div class="card">
              <header><h2>排版结果</h2></header>
              <div class="metrics">
                <span class="k">字号（反算）</span><span class="v">{{ layout.sizeMm }} mm</span>
                <span class="k">占宽 / 排版带宽 / 安装区宽</span>
                <span class="v" :class="{ bad: layout.overflowX }">
                  {{ layout.occupiedW }} / {{ layout.band.w.toFixed(1) }} / {{ layout.inner.w }} mm
                </span>
                <span class="k">占高 / 安装区高</span>
                <span class="v" :class="{ bad: layout.overflowY }">{{ layout.occupiedH }} / {{ layout.inner.h }} mm</span>
                <span class="k">左留边（实际 / 设定 / 下限）</span>
                <span class="v" :class="{ bad: layout.margins.leftSide.atLimit, warn: layout.margins.leftSide.compressed }">
                  {{ layout.margins.left }} / {{ layout.margins.leftSide.desired }} / {{ layout.margins.leftSide.minMm }} mm
                  <span v-if="layout.margins.leftSide.atLimit" class="tag">已压到下限</span>
                  <span v-else-if="layout.margins.leftSide.compressed" class="tag">让位中</span>
                </span>
                <span class="k">右留边（实际 / 设定 / 下限）</span>
                <span class="v" :class="{ bad: layout.margins.rightSide.atLimit, warn: layout.margins.rightSide.compressed }">
                  {{ layout.margins.right }} / {{ layout.margins.rightSide.desired }} / {{ layout.margins.rightSide.minMm }} mm
                  <span v-if="layout.margins.rightSide.atLimit" class="tag">已压到下限</span>
                  <span v-else-if="layout.margins.rightSide.compressed" class="tag">让位中</span>
                </span>
                <span class="k">左右留边差</span>
                <span class="v">{{ layout.margins.deltaX }} mm {{ layout.margins.symmetric ? '（对称）' : '（不对称，按配置）' }}</span>
                <span class="k">先保 / 先让</span>
                <span class="v">{{ project.layout.settings.margins.keepSide === 'left' ? '左 / 右' : '右 / 左' }}</span>
                <span class="k">上留边 / 下留边</span><span class="v">{{ layout.margins.top }} / {{ layout.margins.bottom }} mm</span>
                <span class="k">视觉间距极差</span>
                <span class="v" :class="{ bad: layout.gapSpread > 0.5 }">{{ layout.gapSpread }} mm</span>
                <template v-if="layout.justifyGapMm !== null">
                  <span class="k">两端对齐目标视觉间距</span>
                  <span class="v">{{ layout.justifyGapMm }} mm</span>
                </template>
                <span class="k">LED 布点长度</span><span class="v">{{ layout.ledLengthMm }} mm</span>
              </div>
              <div v-if="layout.fit" class="banner" :class="layout.fit.stage === 1 ? 'ok' : 'warn'" style="margin-top: 10px">
                {{ layout.fit.note }}
              </div>
              <div v-if="layout.overflowX || layout.overflowY" class="banner warn" style="margin-top: 10px">
                超出安装区：宽 +{{ layout.overflowXMm }}mm / 高 +{{ layout.overflowYMm }}mm。
                <template v-if="layout.suggestedSizeMm !== null">
                  建议字号 <b>{{ layout.suggestedSizeMm }}mm</b>
                  <button class="primary" style="margin-left: 8px" @click="applySuggested">采用建议字号</button>
                  <div v-if="layout.suggestedFit" style="margin-top: 4px">{{ layout.suggestedFit.note }}</div>
                </template>
              </div>
              <ul class="notes" v-if="layout.warnings.length" style="margin-top: 8px">
                <li v-for="(w, i) in layout.warnings.slice(0, 6)" :key="i">{{ w }}</li>
              </ul>
            </div>

            <div class="card">
              <header>
                <h2>视觉间距（轮廓最近距离）</h2>
                <span class="hint">选中字后：← → 调 1mm，Shift + ← → 调 5mm；↑ ↓ 调上下偏移</span>
              </header>
              <table>
                <thead>
                  <tr><th>相邻对</th><th class="num">视觉间距 mm</th><th class="num">包围盒间距</th><th class="num">偏差</th></tr>
                </thead>
                <tbody>
                  <tr v-for="g in gapList" :key="g.i">
                    <td>{{ g.char }} → {{ g.next }}</td>
                    <td class="num">{{ g.gap }}</td>
                    <td class="num">{{ round1((layout?.chars[g.i + 1]?.x ?? 0) - ((layout?.chars[g.i]?.x ?? 0) + (layout?.chars[g.i]?.inkW ?? 0))) }}</td>
                    <td class="num">
                      {{ round1((layout?.chars[g.i + 1]?.x ?? 0) - ((layout?.chars[g.i]?.x ?? 0) + (layout?.chars[g.i]?.inkW ?? 0)) - (g.gap ?? 0)) }}
                    </td>
                  </tr>
                </tbody>
              </table>
              <p class="muted">
                视觉间距按字形轮廓的最近距离计算（不是文本框宽度相减）；两端对齐时按视觉间距平均分配，因此各行间距极差≈0。
              </p>
            </div>
          </div>

          <div class="card" style="margin-top: 14px" v-if="layout">
            <header>
              <h2>逐字微调</h2>
              <span class="hint">{{ active === null ? '点选一个字' : `已选「${project.layout.items[active]?.char}」` }}</span>
            </header>
            <div class="char-tuner">
              <div
                v-for="(it, i) in project.layout.items"
                :key="i"
                class="char-cell"
                :class="{ active: active === i }"
                @click="active = i"
              >
                <div class="ch">{{ it.char }}</div>
                <div class="meta">
                  字距 {{ layout.chars[i]?.gapAfter ?? '—' }}mm<br />
                  偏移 {{ it.offsetYMm }}mm · {{ it.mode === 'solid' ? '实心' : '描边' }}
                </div>
                <div class="row" style="margin-top: 4px; gap: 4px">
                  <button style="padding: 1px 6px" @click.stop="resetTrack(i)">复位</button>
                  <button
                    style="padding: 1px 6px"
                    @click.stop="it.mode = (it.mode === 'solid' ? 'outline' : 'solid') as CharMode"
                  >
                    {{ it.mode === 'solid' ? '改描边' : '改实心' }}
                  </button>
                </div>
              </div>
            </div>
            <template v-if="active !== null && project.layout.items[active]">
              <div class="field" style="margin-top: 10px">
                <label>「{{ project.layout.items[active].char }}」字距（mm）</label>
                <div class="ctl">
                  <input
                    type="number"
                    v-model.number="project.layout.items[active].trackMm"
                    step="1"
                    @input="project.layout.items[active].trackTouched = true"
                  />
                  <button @click="project.layout.items[active].trackMm = round1(project.layout.items[active].trackMm - 5)">
                    −5
                  </button>
                  <button @click="project.layout.items[active].trackMm = round1(project.layout.items[active].trackMm - 1)">
                    −1
                  </button>
                  <button @click="project.layout.items[active].trackMm = round1(project.layout.items[active].trackMm + 1)">
                    +1
                  </button>
                  <button @click="project.layout.items[active].trackMm = round1(project.layout.items[active].trackMm + 5)">
                    +5
                  </button>
                  <span class="muted" v-if="!project.layout.items[active].trackTouched">跟随默认（改动后独立）</span>
                </div>
              </div>
              <div class="field">
                <label>上下偏移（mm）</label>
                <div class="ctl">
                  <input type="number" v-model.number="project.layout.items[active].offsetYMm" step="1" />
                  <span class="muted">正值向下</span>
                </div>
              </div>
            </template>
          </div>

          <div class="card" style="margin-top: 14px" v-if="layout && activeGlyph">
            <header>
              <h2>字形分析：「{{ activeGlyph.char }}」</h2>
              <span class="hint">{{ findFont(project.layout.settings.fontId)?.family }} · 字号 {{ layout.sizeMm }}mm</span>
            </header>
            <div class="grid cols-2">
              <div>
                <div class="metrics">
                  <span class="k">连通域（笔画块）数量</span><span class="v">{{ activeGlyph.strokeBlocks }}</span>
                  <span class="k">轮廓条数（含内孔）</span><span class="v">{{ activeGlyph.contours.length }}</span>
                  <span class="k">最细笔画</span>
                  <span class="v" :class="{ bad: activeGlyph.minStrokeMm < project.layout.settings.strokeLimitMm }">
                    {{ activeGlyph.minStrokeMm }} mm
                  </span>
                  <span class="k">墨迹外接矩形</span>
                  <span class="v">{{ activeGlyph.bboxMm.w }} × {{ activeGlyph.bboxMm.h }} mm</span>
                  <span class="k">外轮廓周长</span>
                  <span class="v">
                    {{ round1(activeGlyph.contours.filter((c) => !c.isHole).reduce((s, c) => s + c.perimeterMm, 0)) }} mm
                  </span>
                  <span class="k">外接矩形面积（拼版口径）</span>
                  <span class="v">{{ areaM2(activeGlyph.bboxMm.w, activeGlyph.bboxMm.h) }} ㎡</span>
                </div>
                <div class="banner warn" v-if="activeGlyph.warnings.length" style="margin-top: 8px">
                  <div v-for="(w, i) in activeGlyph.warnings" :key="i">{{ w }}</div>
                </div>
                <p class="muted">
                  笔画块数量决定需要几块亚克力/几段发光区；各轮廓周长决定 LED 布点长度；最细笔画低于工艺下限时必须加粗或换字体。
                </p>
              </div>
              <div>
                <table>
                  <thead>
                    <tr><th>#</th><th>类型</th><th class="num">面积 ㎡</th><th class="num">周长 mm</th><th class="num">所属块</th></tr>
                  </thead>
                  <tbody>
                    <tr v-for="(c, i) in activeGlyph.contours" :key="i">
                      <td>{{ i + 1 }}</td>
                      <td>{{ c.isHole ? '内孔' : '外轮廓' }}</td>
                      <td class="num">{{ (c.areaMm2 / 1e6).toFixed(4) }}</td>
                      <td class="num">{{ c.perimeterMm }}</td>
                      <td class="num">{{ c.blockIndex + 1 }}</td>
                    </tr>
                  </tbody>
                </table>
                <p class="muted" v-if="activeCharStat">
                  位置：x {{ round1(activeCharStat.x) }}mm，y {{ round1(activeCharStat.y) }}mm（面板坐标，原点左上）；
                  {{ activeCharStat.item.mode === 'solid' ? '实心面板字' : '描边/镂空字' }}
                </p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>