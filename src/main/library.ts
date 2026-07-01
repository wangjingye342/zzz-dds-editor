import { promises as fs } from 'fs'
import { join, extname, basename } from 'path'
import { app } from 'electron'
import type { LibraryItem, UsageMap } from '../shared/types'

const EXTS = new Set(['.png', '.dds'])

function usagePath(): string {
  return join(app.getPath('userData'), 'usage.json')
}

export async function readUsage(): Promise<UsageMap> {
  try {
    return JSON.parse(await fs.readFile(usagePath(), 'utf-8'))
  } catch {
    return {}
  }
}

async function writeUsage(map: UsageMap): Promise<void> {
  await fs.writeFile(usagePath(), JSON.stringify(map, null, 2), 'utf-8')
}

/** 某素材被拖入画布使用一次，计数 +1 */
export async function bumpUsage(path: string): Promise<void> {
  const map = await readUsage()
  const cur = map[path] || { count: 0, lastUsed: 0 }
  cur.count += 1
  cur.lastUsed = Date.now()
  map[path] = cur
  await writeUsage(map)
}

async function walk(dir: string, out: string[], depth: number): Promise<void> {
  if (depth > 6) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) await walk(full, out, depth + 1)
    else if (EXTS.has(extname(e.name).toLowerCase())) out.push(full)
  }
}

/** 扫描素材文件夹，返回按使用频率降序排序的素材列表 */
export async function scanLibrary(folder: string): Promise<LibraryItem[]> {
  const files: string[] = []
  await walk(folder, files, 0)
  const usage = await readUsage()
  const items: LibraryItem[] = files.map((f) => {
    const u = usage[f] || { count: 0, lastUsed: 0 }
    return {
      path: f,
      name: basename(f),
      ext: extname(f).slice(1).toLowerCase(),
      count: u.count,
      lastUsed: u.lastUsed
    }
  })
  // 用得越多越靠上；其次最近使用；最后按名称
  items.sort(
    (a, b) => b.count - a.count || b.lastUsed - a.lastUsed || a.name.localeCompare(b.name)
  )
  return items
}
