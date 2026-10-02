<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { listFonts } from './logic/fontLoader'
import { loadPreset } from './logic/store'

const route = useRoute()
const projectId = computed(() => (typeof route.params.id === 'string' ? route.params.id : ''))
const presetVersion = ref(loadPreset().version)
onMounted(() => {
  presetVersion.value = loadPreset().version
})
const fontCount = computed(() => listFonts().length)
</script>

<template>
  <div class="layout-shell">
    <header class="topbar no-print">
      <div class="brand">招牌字排版与材料清单<small>Signage Letter Layout</small></div>
      <nav>
        <router-link to="/">新建门头</router-link>
        <router-link v-if="projectId" :to="`/edit/${projectId}`">排版编辑</router-link>
        <router-link v-if="projectId" :to="`/light/${projectId}`">LED 与电源</router-link>
        <router-link v-if="projectId" :to="`/materials/${projectId}`">材料与拼版</router-link>
        <router-link v-if="projectId" :to="`/quote/${projectId}`">报价单</router-link>
        <router-link to="/fonts">本地字库</router-link>
        <router-link to="/presets">材质与工艺</router-link>
      </nav>
      <div class="spacer"></div>
      <div class="proj">本地字体 {{ fontCount }} 项 · 预设置版本 {{ presetVersion }} · 数据全部本地存储</div>
    </header>
    <main>
      <router-view :key="route.fullPath" />
    </main>
  </div>
</template>