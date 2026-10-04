/**
 * 本地存储（无后端）：项目、预设、字库偏好。
 * 只落 localStorage，不发起任何网络请求。
 */

import materialsData from '../data/materials.json'
import type { Preset } from './materials'
import { defaultProject, normalizeLayoutSettings } from './layout'
import type { Project } from './types'

const KEY_PROJECTS = 'app029.projects.v1'
const KEY_PRESET = 'app029.preset.v1'
const KEY_PREFS = 'app029.prefs.v1'

export interface Prefs {
  defaultFontId: string
  defaultWeight: number
  nightPreview: boolean
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 存储空间不足等异常：忽略写入失败，不影响当前会话使用
  }
}

/**
 * 打开存过的项目时补字段：
 * 老项目只有一个 marginRatio（左右同宽、按安装区比例），按「两边同宽的比例留边」接着用，
 * 比例值原样保留（口径改为 ×字号，见 normalizeLayoutSettings）。
 */
export function migrateProject(raw: Project): Project {
  if (raw?.layout?.settings) {
    normalizeLayoutSettings(raw.layout.settings)
  }
  return raw
}

function readProjects(): Project[] {
  return readJson<Project[]>(KEY_PROJECTS, []).map(migrateProject)
}

export function listProjects(): Project[] {
  const list = readProjects()
  return list.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getProject(id: string): Project | null {
  return listProjects().find((p) => p.id === id) ?? null
}

export function saveProject(p: Project): void {
  const list = listProjects()
  const idx = list.findIndex((x) => x.id === p.id)
  const next = { ...p, updatedAt: Date.now() }
  if (idx >= 0) list[idx] = next
  else list.unshift(next)
  writeJson(KEY_PROJECTS, list)
}

export function deleteProject(id: string): void {
  writeJson(
    KEY_PROJECTS,
    listProjects().filter((p) => p.id !== id)
  )
}

export function duplicateProject(id: string): Project | null {
  const src = getProject(id)
  if (!src) return null
  const copy: Project = JSON.parse(JSON.stringify(src))
  copy.id = newId()
  copy.name = `${src.name} 副本`
  copy.createdAt = Date.now()
  copy.updatedAt = Date.now()
  saveProject(copy)
  return copy
}

export function newId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function createProject(name: string, panel?: { wMm?: number; hMm?: number; frameMm?: number }): Project {
  const p = defaultProject(newId(), panel)
  p.name = name
  const prefs = loadPrefs()
  p.layout.settings.fontId = prefs.defaultFontId
  p.layout.settings.weight = prefs.defaultWeight
  saveProject(p)
  return p
}

function mergePreset(base: Preset, patch: Partial<Preset>): Preset {
  const out: Preset = JSON.parse(JSON.stringify(base))
  if (patch.process) out.process = { ...out.process, ...patch.process }
  if (patch.acrylicSheets) out.acrylicSheets = patch.acrylicSheets
  if (patch.ledModules) out.ledModules = patch.ledModules
  if (patch.psu) out.psu = { ...out.psu, ...patch.psu }
  if (patch.consumables) out.consumables = patch.consumables
  if (patch.labor) out.labor = patch.labor
  if (patch.panelMaterials) out.panelMaterials = patch.panelMaterials
  return out
}

export function defaultPresetDeep(): Preset {
  return JSON.parse(JSON.stringify(materialsData)) as Preset
}

export function loadPreset(): Preset {
  const saved = readJson<Partial<Preset> | null>(KEY_PRESET, null)
  if (!saved) return defaultPresetDeep()
  return mergePreset(defaultPresetDeep(), saved)
}

export function savePreset(preset: Preset): void {
  writeJson(KEY_PRESET, preset)
}

export function resetPreset(): Preset {
  const fresh = defaultPresetDeep()
  writeJson(KEY_PRESET, fresh)
  return fresh
}

export function loadPrefs(): Prefs {
  return readJson<Prefs>(KEY_PREFS, { defaultFontId: 'hei', defaultWeight: 400, nightPreview: false })
}

export function savePrefs(p: Partial<Prefs>): Prefs {
  const next = { ...loadPrefs(), ...p }
  writeJson(KEY_PREFS, next)
  return next
}