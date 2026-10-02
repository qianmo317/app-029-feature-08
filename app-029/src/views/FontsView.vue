<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import testchars from '../data/testchars.json'
import { FONT_CHARSET_NOTE, ensureFont, fontState, getGlyphGeom, listFonts, registerLocalFont } from '../logic/fontLoader'
import { loadPrefs, savePrefs } from '../logic/store'

const prefs = ref(loadPrefs())
const tick = ref(0)
const uploadMsg = ref('')
const busy = ref(false)

const fonts = computed(() => listFonts())
const testList = computed(() => (testchars as unknown as { chars: Array<{ char: string }> }).chars.map((c) => c.char))

interface FontCard {
  id: string
  label: string
  family: string
  feature: string
  license: string
  source: string
  local: boolean
  weights: Array<{ weight: number; file: string; glyphs: number; state: string; message: string }>
  coverage: number
  missingChars: string[]
  samplePaths: Array<{ char: string; d: string; x0: number; y0: number; ok: boolean }>
}

const cards = computed<FontCard[]>(() => {
  void tick.value
  return fonts.value.map((f) => {
    const weights = f.weights.map((w) => {
      const st = fontState(f.id, w.weight)
      return { weight: w.weight, file: w.file, glyphs: 0, state: st.state, message: st.message }
    })
    let coverage = 0
    const missingChars: string[] = []
    for (const ch of testList.value) {
      const g = getGlyphGeom(f.id, f.weights[0]?.weight ?? 400, ch)
      if (g && !g.missing) coverage++
      else missingChars.push(ch)
    }
    const samplePaths = testList.value.slice(0, 8).map((ch) => {
      const g = getGlyphGeom(f.id, f.weights[0]?.weight ?? 400, ch)
      if (!g || g.missing || !g.pathData) return { char: ch, d: '', x0: 0, y0: 0, ok: false }
      return { char: ch, d: g.pathData, x0: g.bbox.x0, y0: g.bbox.y0, ok: true }
    })
    return {
      id: f.id,
      label: f.label,
      family: f.family,
      feature: f.feature,
      license: f.license,
      source: f.source,
      local: !!f.local,
      weights,
      coverage,
      missingChars,
      samplePaths
    }
  })
})

onMounted(async () => {
  busy.value = true
  for (const f of listFonts()) {
    for (const w of f.weights) {
      try {
        await ensureFont(f.id, w.weight)
      } catch {
        // 「该字体不可用」会显示在卡片上
      }
    }
  }
  busy.value = false
  tick.value++
})

async function onUpload(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  uploadMsg.value = ''
  try {
    const buf = await file.arrayBuffer()
    const f = await registerLocalFont(file.name, buf)
    uploadMsg.value = `已登记「${f.family}」，仅当前浏览器会话可用；如需长期使用请把字体放入 public/fonts 并在 src/data/fonts.json 中登记。`
  } catch (err) {
    uploadMsg.value = err instanceof Error ? err.message : '该字体不可用'
  } finally {
    input.value = ''
    tick.value++
  }
}

function setDefault(fontId: string, weight: number): void {
  prefs.value = savePrefs({ defaultFontId: fontId, defaultWeight: weight })
}
</script>

<template>
  <div class="page">
    <section class="card">
      <header>
        <h1>本地字库管理</h1>
        <span class="hint">{{ busy ? '正在解析字体…' : `共 ${fonts.length} 项` }}</span>
      </header>
      <div class="banner info">{{ FONT_CHARSET_NOTE }}</div>
      <p class="muted">
        字体随应用一起打包（public/fonts），运行期只读取同源静态文件，断网可用；解析失败会明确提示「该字体不可用」，不会静默退化。
        默认字体：{{ prefs.defaultFontId }} / 字重 {{ prefs.defaultWeight }}。
      </p>
      <div class="row" style="margin-top: 8px">
        <label class="muted">上传本地字体（TTF/OTF，仅当前会话）：</label>
        <input type="file" accept=".ttf,.otf,font/ttf,font/otf" @change="onUpload" />
      </div>
      <div class="banner warn" v-if="uploadMsg" style="margin-top: 8px">{{ uploadMsg }}</div>
      <ul class="notes" style="margin-top: 8px">
        <li>授权：{{ fonts.map((f) => `${f.label}=${f.license}`).join('；') }}</li>
        <li>字重：黑体/宋体各提供 Regular 与 Bold 两个真实字重；楷体/圆体/艺术体为单字重（界面会标注）。</li>
      </ul>
    </section>

    <div class="grid cols-2" style="margin-top: 14px">
      <section v-for="c in cards" :key="c.id" class="card">
        <header>
          <h2>{{ c.label }} · {{ c.family }}</h2>
          <span class="tag" :class="c.weights.some((w) => w.state === 'error') ? 'bad' : 'ok'">
            {{ c.weights.map((w) => (w.state === 'ready' ? '已解析' : w.state === 'error' ? '不可用' : w.state)).join(' / ') }}
          </span>
        </header>
        <p class="muted">{{ c.feature }}</p>
        <div class="kv-list">
          <span class="muted">字重</span><span class="mono">{{ c.weights.map((w) => w.weight).join(' / ') }}</span>
          <span class="muted">字体文件</span><span class="mono">{{ c.weights.map((w) => w.file).join('、') }}</span>
          <span class="muted">授权 / 来源</span><span>{{ c.license }} · {{ c.source }}</span>
          <span class="muted">测试字覆盖</span><span class="mono">{{ c.coverage }} / {{ testList.length }}</span>
        </div>
        <svg viewBox="-60 -1080 8900 1450" class="sheet-svg" style="height: 120px; margin-top: 8px">
          <g v-for="(s, i) in c.samplePaths" :key="i" :transform="`translate(${i * 1100} 0)`">
            <path v-if="s.ok" :d="s.d" fill="#1d2433" fill-rule="evenodd" />
            <text v-else x="500" y="0" text-anchor="middle" style="font-size: 480px; fill: #c62828">缺</text>
          </g>
        </svg>
        <p class="muted" v-if="c.missingChars.length">字库缺少：{{ c.missingChars.join('') }}（使用时会明确提示，不会静默退化）</p>
        <div class="row" style="margin-top: 6px">
          <button
            v-for="w in c.weights"
            :key="w.weight"
            :class="{ primary: prefs.defaultFontId === c.id && prefs.defaultWeight === w.weight }"
            @click="setDefault(c.id, w.weight)"
          >
            设为默认 {{ w.weight }}
          </button>
          <span class="muted" v-if="c.local">本地上传字体：仅当前会话有效</span>
        </div>
      </section>
    </div>
  </div>
</template>