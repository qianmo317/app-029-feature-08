import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  { path: '/', name: 'home', component: () => import('../views/HomeView.vue') },
  { path: '/edit/:id', name: 'edit', component: () => import('../views/EditView.vue') },
  { path: '/light/:id', name: 'light', component: () => import('../views/LightView.vue') },
  { path: '/materials/:id', name: 'materials', component: () => import('../views/MaterialsView.vue') },
  { path: '/quote/:id', name: 'quote', component: () => import('../views/QuoteView.vue') },
  { path: '/fonts', name: 'fonts', component: () => import('../views/FontsView.vue') },
  { path: '/presets', name: 'presets', component: () => import('../views/PresetsView.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/' }
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 })
})