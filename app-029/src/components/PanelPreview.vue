<script setup lang="ts">
import { computed } from 'vue'
import type { LayoutResult } from '../logic/layout'
import { ledDots } from '../logic/led'
import type { Project } from '../logic/types'

const props = withDefaults(
  defineProps<{
    project: Project
    layout: LayoutResult
    showDims?: boolean
    showMargins?: boolean
    showBlocks?: boolean
    showMinStroke?: boolean
    showLed?: boolean
    night?: boolean
    activeChar?: number | null
  }>(),
  {
    showDims: true,
    showMargins: true,
    showBlocks: false,
    showMinStroke: false,
    showLed: false,
    night: false,
    activeChar: null
  }
)

const panel = computed(() => props.project.layout.panel)
const pad = computed(() => Math.max(panel.value.wMm, panel.value.hMm) * 0.07)
const viewBox = computed(
  () => `${-pad.value} ${-pad.value} ${panel.value.wMm + pad.value * 2} ${panel.value.hMm + pad.value * 2}`
)
const labelSize = computed(() => Math.max(panel.value.wMm, panel.value.hMm) * 0.019)
const dimOffset = computed(() => pad.value * 0.45)

const blockColors = ['#1f6feb', '#e8710a', '#17864a', '#9c27b0', '#00838f', '#c62828', '#5d4037', '#3f51b5', '#827717']

interface GlyphGroup {
  index: number
  char: string
  x: number
  y: number
  scale: number
  bx0: number
  by0: number
  mode: string
  missing: boolean
  pathData: string
  blocks: Array<{ index: number; d: string; color: string }>
  minStroke: number
  minStrokePoint: { x: number; y: number } | null
  outline: boolean
}

const glyphs = computed<GlyphGroup[]>(() =>
  props.layout.chars.map((c, i) => {
    const k = c.geom.inkW > 0 ? c.inkW / c.geom.inkW : 0
    const byBlock = new Map<number, string[]>()
    for (const r of c.geom.rings) {
      const arr = byBlock.get(r.block) ?? []
      arr.push(r.pathData)
      byBlock.set(r.block, arr)
    }
    const blocks = [...byBlock.entries()].map(([index, d]) => ({
      index,
      d: d.join(''),
      color: blockColors[index % blockColors.length]
    }))
    return {
      index: i,
      char: c.char,
      x: c.x,
      y: c.y,
      scale: k,
      bx0: c.geom.bbox.x0,
      by0: c.geom.bbox.y0,
      mode: c.item.mode,
      missing: c.missing,
      pathData: c.geom.pathData,
      blocks,
      minStroke: c.geom.minStroke * k,
      minStrokePoint: c.geom.minStrokePoint
        ? { x: c.x + (c.geom.minStrokePoint.x - c.geom.bbox.x0) * k, y: c.y + (c.geom.minStrokePoint.y - c.geom.bbox.y0) * k }
        : null,
      outline: c.item.mode === 'outline'
    }
  })
)

const dots = computed(() => (props.showLed ? ledDots(props.layout.chars, props.project.led.moduleSpacingMm) : []))
const strokeMm = computed(() => Math.max(4, props.layout.sizeMm * 0.02))
const overflow = computed(() => props.layout.overflowX || props.layout.overflowY)
const markerR = computed(() => Math.max(panel.value.hMm, panel.value.wMm) * 0.012)
</script>

<template>
  <div class="preview-wrap" :class="{ dark: night }">
    <svg class="panel-svg" :viewBox="viewBox" preserveAspectRatio="xMidYMid meet">
      <defs>
        <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur :stdDeviation="layout.sizeMm * 0.05" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <!-- 门头底板 -->
      <rect
        :x="0"
        :y="0"
        :width="panel.wMm"
        :height="panel.hMm"
        rx="6"
        :fill="night ? '#123054' : '#dfe6f1'"
        :stroke="overflow ? '#c62828' : '#a9b4c6'"
        :stroke-width="overflow ? labelSize * 0.28 : labelSize * 0.14"
      />
      <!-- 有效安装区（扣除铝塑板边框） -->
      <rect
        :x="layout.inner.x"
        :y="layout.inner.y"
        :width="layout.inner.w"
        :height="layout.inner.h"
        rx="2"
        fill="none"
        :stroke="overflow ? '#c62828' : '#8b93a3'"
        :stroke-width="labelSize * 0.1"
        :stroke-dasharray="`${labelSize * 0.5} ${labelSize * 0.3}`"
      />

      <!-- 字形 -->
      <g
        v-for="g in glyphs"
        :key="g.index"
        :transform="`translate(${g.x} ${g.y}) scale(${g.scale}) translate(${-g.bx0} ${-g.by0})`"
      >
        <template v-if="!g.missing && g.pathData">
          <template v-if="showBlocks">
            <path
              v-for="b in g.blocks"
              :key="b.index"
              :d="b.d"
              :fill="night ? 'rgba(190,220,255,0.75)' : b.color"
              fill-rule="evenodd"
              :opacity="activeChar === null || activeChar === g.index ? 0.92 : 0.28"
            />
          </template>
          <template v-else>
            <path
              :d="g.pathData"
              :fill="g.outline ? (night ? '#8fd0ff' : '#1d2433') : night ? '#eaf6ff' : '#1d2433'"
              fill-rule="evenodd"
              :stroke="g.outline ? (night ? '#cbe9ff' : '#1d2433') : 'none'"
              :stroke-width="g.outline ? strokeMm / Math.max(1e-6, g.scale) : 0"
              :filter="night ? 'url(#glow)' : undefined"
              :opacity="activeChar === null || activeChar === g.index ? 1 : 0.35"
            />
          </template>
        </template>
      </g>

      <!-- 最细笔画位置 -->
      <g v-if="showMinStroke">
        <g v-for="g in glyphs" :key="`ms${g.index}`">
          <template v-if="g.minStrokePoint">
            <circle
              :cx="g.minStrokePoint.x"
              :cy="g.minStrokePoint.y"
              :r="markerR"
              fill="none"
              stroke="#c62828"
              :stroke-width="labelSize * 0.1"
            />
            <line
              :x1="g.minStrokePoint.x - markerR * 1.8"
              :y1="g.minStrokePoint.y"
              :x2="g.minStrokePoint.x + markerR * 1.8"
              :y2="g.minStrokePoint.y"
              stroke="#c62828"
              :stroke-width="labelSize * 0.08"
            />
            <line
              :x1="g.minStrokePoint.x"
              :y1="g.minStrokePoint.y - markerR * 1.8"
              :x2="g.minStrokePoint.x"
              :y2="g.minStrokePoint.y + markerR * 1.8"
              stroke="#c62828"
              :stroke-width="labelSize * 0.08"
            />
          </template>
        </g>
      </g>

      <!-- LED 布点 -->
      <circle
        v-for="(d, i) in dots"
        :key="`d${i}`"
        :cx="d.x"
        :cy="d.y"
        :r="markerR * 0.55"
        :fill="night ? '#ffd166' : '#e8710a'"
        :opacity="0.9"
      />

      <!-- 留边指示 -->
      <g v-if="showMargins && layout.chars.length">
        <line
          :x1="layout.inner.x"
          :y1="-dimOffset * 0.5"
          :x2="layout.inner.x"
          :y2="panel.hMm + dimOffset * 0.5"
          stroke="#1f6feb"
          :stroke-width="labelSize * 0.07"
          stroke-dasharray="6 4"
        />
        <line
          :x1="layout.inner.x + layout.inner.w"
          :y1="-dimOffset * 0.5"
          :x2="layout.inner.x + layout.inner.w"
          :y2="panel.hMm + dimOffset * 0.5"
          stroke="#1f6feb"
          :stroke-width="labelSize * 0.07"
          stroke-dasharray="6 4"
        />
        <text
          :x="layout.inkLeft / 2 + layout.inner.x / 2"
          :y="-dimOffset * 0.15"
          class="svg-label"
          text-anchor="middle"
          :style="{ fontSize: labelSize + 'px' }"
        >
          留边 {{ layout.margins.left }}mm
        </text>
        <text
          :x="(layout.inkRight + layout.inner.x + layout.inner.w) / 2"
          :y="-dimOffset * 0.15"
          class="svg-label"
          text-anchor="middle"
          :style="{ fontSize: labelSize + 'px' }"
        >
          留边 {{ layout.margins.right }}mm
        </text>
      </g>

      <!-- 尺寸标注 -->
      <g v-if="showDims">
        <line :x1="0" :y1="panel.hMm + dimOffset" :x2="panel.wMm" :y2="panel.hMm + dimOffset" stroke="#5b6577" :stroke-width="labelSize * 0.06" />
        <line :x1="0" :y1="panel.hMm + dimOffset * 0.7" :x2="0" :y2="panel.hMm + dimOffset * 1.3" stroke="#5b6577" :stroke-width="labelSize * 0.06" />
        <line
          :x1="panel.wMm"
          :y1="panel.hMm + dimOffset * 0.7"
          :x2="panel.wMm"
          :y2="panel.hMm + dimOffset * 1.3"
          stroke="#5b6577"
          :stroke-width="labelSize * 0.06"
        />
        <text :x="panel.wMm / 2" :y="panel.hMm + dimOffset * 1.5" class="svg-label" text-anchor="middle" :style="{ fontSize: labelSize + 'px' }">
          门头 {{ panel.wMm }} × {{ panel.hMm }}mm
        </text>

        <line :x1="panel.wMm + dimOffset" :y1="0" :x2="panel.wMm + dimOffset" :y2="panel.hMm" stroke="#5b6577" :stroke-width="labelSize * 0.06" />
        <text
          :x="panel.wMm + dimOffset * 1.1"
          :y="panel.hMm / 2"
          class="svg-label"
          :style="{ fontSize: labelSize + 'px' }"
          :transform="`rotate(90 ${panel.wMm + dimOffset * 1.1} ${panel.hMm / 2})`"
          text-anchor="middle"
        >
          占高 {{ layout.occupiedH }}mm
        </text>
        <text
          :x="panel.wMm / 2"
          :y="panel.hMm + dimOffset * 2.6"
          class="svg-label strong"
          text-anchor="middle"
          :style="{ fontSize: labelSize + 'px' }"
        >
          占宽 {{ layout.occupiedW }}mm / 安装区 {{ layout.inner.w }} × {{ layout.inner.h }}mm（边框 {{ panel.frameMm }}mm）
        </text>
        <text
          v-if="overflow"
          :x="panel.wMm / 2"
          :y="-dimOffset * 0.5"
          class="svg-label bad"
          text-anchor="middle"
          :style="{ fontSize: labelSize * 1.15 + 'px' }"
        >
          超出安装区：宽 +{{ layout.overflowXMm }}mm / 高 +{{ layout.overflowYMm }}mm
        </text>
      </g>
    </svg>
  </div>
</template>