import { promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { AppSettings, RecentRecord } from '../shared/types'

// 应用级设置（工作目录 + 最近记录）持久化在 userData/settings.json，
// 与 library.ts 的 usage.json 同一套读写写法。

const DEFAULTS: AppSettings = {
  workspaceDir: null,
  outputDir: null,
  recent: [],
  autoSave: true,
  defaultExportFormat: 'auto',
  libraryDir: null,
  mirrorInsert: false
}
const RECENT_LIMIT = 30

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export async function getSettings(): Promise<AppSettings> {
  try {
    const raw = JSON.parse(await fs.readFile(settingsPath(), 'utf-8'))
    return {
      workspaceDir: typeof raw.workspaceDir === 'string' ? raw.workspaceDir : null,
      outputDir: typeof raw.outputDir === 'string' ? raw.outputDir : null,
      recent: Array.isArray(raw.recent) ? raw.recent : [],
      autoSave: typeof raw.autoSave === 'boolean' ? raw.autoSave : DEFAULTS.autoSave,
      defaultExportFormat:
        typeof raw.defaultExportFormat === 'string'
          ? raw.defaultExportFormat
          : DEFAULTS.defaultExportFormat,
      libraryDir: typeof raw.libraryDir === 'string' ? raw.libraryDir : null,
      mirrorInsert: typeof raw.mirrorInsert === 'boolean' ? raw.mirrorInsert : DEFAULTS.mirrorInsert
    }
  } catch {
    return { ...DEFAULTS }
  }
}

async function writeSettings(s: AppSettings): Promise<void> {
  await fs.writeFile(settingsPath(), JSON.stringify(s, null, 2), 'utf-8')
}

/** 局部更新设置并持久化，返回更新后的完整设置 */
export async function updateSettings(partial: Partial<AppSettings>): Promise<AppSettings> {
  const next = { ...(await getSettings()), ...partial }
  await writeSettings(next)
  return next
}

export async function setWorkspaceDir(dir: string): Promise<void> {
  const s = await getSettings()
  s.workspaceDir = dir
  await writeSettings(s)
}

export async function setOutputDir(dir: string): Promise<void> {
  const s = await getSettings()
  s.outputDir = dir
  await writeSettings(s)
}

/** 记一条最近记录：按 projPath 去重，置顶，截断到上限 */
export async function addRecent(rec: RecentRecord): Promise<void> {
  const s = await getSettings()
  const rest = s.recent.filter((r) => r.projPath !== rec.projPath)
  s.recent = [rec, ...rest].slice(0, RECENT_LIMIT)
  await writeSettings(s)
}

export async function getRecent(): Promise<RecentRecord[]> {
  const s = await getSettings()
  return s.recent.slice().sort((a, b) => b.lastOpened - a.lastOpened)
}

