import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: '/',
  build: {
    target: 'es2018',
    assetsDir: 'assets',
    // 字体体积较大，避免被内联成 base64（哈希资源走 immutable 缓存）
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 1500
  },
  server: {
    port: 8109,
    strictPort: false
  }
})