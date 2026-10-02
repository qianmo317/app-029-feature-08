<script setup lang="ts">
import { computed } from 'vue'
import type { NestingResult, SheetLayout } from '../logic/nesting'

const props = defineProps<{
  nesting: NestingResult
  sheetW: number
  sheetH: number
  active?: number
}>()

const sheets = computed<SheetLayout[]>(() => props.nesting.sheets)
const labelSize = computed(() => Math.max(props.sheetW, props.sheetH) * 0.022)
const viewBox = computed(() => `-10 -10 ${props.sheetW + 20} ${props.sheetH + 20}`)

function pieceW(p: { wMm: number }): number {
  return p.wMm
}
</script>

<template>
  <div class="grid" :style="{ gridTemplateColumns: sheets.length > 1 ? 'repeat(2, minmax(0,1fr))' : 'minmax(0,1fr)' }">
    <div v-for="s in sheets" :key="s.index">
      <svg class="sheet-svg" :viewBox="viewBox">
        <rect
          :x="0"
          :y="0"
          :width="sheetW"
          :height="sheetH"
          fill="#ffffff"
          stroke="#a9b4c6"
          :stroke-width="labelSize * 0.35"
        />
        <!-- 料层（一刀切到底的分层线） -->
        <line
          v-for="(sh, i) in s.shelves"
          :key="`sh${i}`"
          :x1="0"
          :y1="sh.y + sh.heightMm"
          :x2="sheetW"
          :y2="sh.y + sh.heightMm"
          stroke="#c8d2e2"
          :stroke-width="labelSize * 0.12"
          stroke-dasharray="8 6"
        />
        <g v-for="(p, i) in s.pieces" :key="`p${i}`">
          <rect
            :x="p.x"
            :y="p.y"
            :width="p.wMm"
            :height="p.hMm"
            :fill="p.rotated ? '#e8f1ff' : '#f2f7ee'"
            stroke="#3d6ea8"
            :stroke-width="labelSize * 0.16"
          />
          <text
            :x="p.x + pieceW(p) / 2"
            :y="p.y + p.hMm / 2"
            class="svg-label"
            text-anchor="middle"
            dominant-baseline="middle"
            :style="{ fontSize: Math.max(10, Math.min(p.wMm, p.hMm) * 0.28) + 'px' }"
          >
            {{ p.label }}
          </text>
        </g>
      </svg>
      <p class="muted">
        第 {{ s.index + 1 }} 张：{{ s.pieces.length }} 件，用板面积
        {{ (s.usedAreaMm2 / 1e6).toFixed(3) }}㎡ / {{ (s.sheetAreaMm2 / 1e6).toFixed(3) }}㎡，利用率
        {{ (s.utilization * 100).toFixed(1) }}%
      </p>
    </div>
  </div>
</template>