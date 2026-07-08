// 模型库：把「模型库根目录」按 模型(子文件夹) → 多个 mod(压缩包/文件夹) 两级组织，
// 支持浏览、预览、一键打开。打开压缩包 mod 时先用内置 7z 解压到工作目录下的 _extracted/ 暂存，
// 再复用现有 scanModDds 流程（后续导出/记录/压缩 RAR 与原有 mod 完全一致）。

import { app } from 'electron'
import { promises as fs, existsSync } from 'fs'
import { join, basename, extname, dirname } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getSettings } from './settings'
import { scanModDds } from './records'
import type { ModItem, ModelGroup, ModelLibraryScan, ModScan } from '../shared/types'

const execFileAsync = promisify(execFile)

const ARCHIVE_EXTS = new Set(['.zip', '.rar', '.7z'])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp'])
const PREVIEW_HINT = /preview|thumb|thumbnail|cover|封面|预览|缩略/i

/** 定位随包 7z.exe（打包后在 resources/7zip，开发期在 resources/7zip） */
export function locate7z(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, '7zip', '7z.exe')]
    : [
        join(app.getAppPath(), 'resources', '7zip', '7z.exe'),
        join(process.cwd(), 'resources', '7zip', '7z.exe')
      ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

function sanitizeSegment(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '') || 'mod'
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** mod 项显示名：压缩包去扩展名，文件夹用名字 */
function displayName(entryPath: string, isDir: boolean): string {
  const b = basename(entryPath)
  return isDir ? b : b.slice(0, b.length - extname(b).length)
}

/** 找同名 sidecar 预览图：<dir>/<stem>.{png,jpg,...} */
async function findSidecarPreview(dir: string, stem: string): Promise<string | null> {
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.bmp']) {
    const p = join(dir, stem + ext)
    if (await exists(p)) return p
  }
  return null
}

/** 在文件夹里（浅层）找预览图：优先 preview.*，否则第一张图片 */
async function findFolderPreview(dir: string): Promise<string | null> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  const images = entries
    .filter((e) => e.isFile() && IMAGE_EXTS.has(extname(e.name).toLowerCase()))
    .map((e) => e.name)
  if (images.length === 0) {
    // 再往下探一层常见的单层包裹目录
    const subdirs = entries.filter((e) => e.isDirectory())
    for (const sd of subdirs.slice(0, 4)) {
      const hit = await findFolderPreview(join(dir, sd.name))
      if (hit) return hit
    }
    return null
  }
  const hinted = images.find((n) => PREVIEW_HINT.test(n))
  return join(dir, hinted ?? images.sort((a, b) => a.localeCompare(b))[0])
}

/** 文件夹里是否含有可编辑的 DDS（浅层判断，用于把「模型目录本身」识别成单个 mod） */
async function dirHasDds(dir: string, depth = 0): Promise<boolean> {
  if (depth > 3) return false
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase().endsWith('.dds')) return true
  }
  for (const e of entries) {
    if (e.isDirectory() && (await dirHasDds(join(dir, e.name), depth + 1))) return true
  }
  return false
}

/** 组装一个 mod 项（解析同名/文件夹内预览图；压缩包内预览留待按需提取） */
async function buildModItem(entryPath: string, isDir: boolean): Promise<ModItem> {
  const parent = dirname(entryPath)
  const name = displayName(entryPath, isDir)
  let size = 0
  if (!isDir) {
    try {
      size = (await fs.stat(entryPath)).size
    } catch {
      /* ignore */
    }
  }
  let previewPath = await findSidecarPreview(parent, name)
  if (!previewPath && isDir) previewPath = await findFolderPreview(entryPath)
  return { path: entryPath, name, kind: isDir ? 'folder' : 'archive', previewPath, size }
}

/** 列出一个模型目录下的所有 mod（压缩包文件 + 子文件夹；都没有则把该目录本身当一个 mod） */
async function scanModelDir(dir: string): Promise<ModItem[]> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const mods: ModItem[] = []
  for (const e of entries) {
    if (e.isFile() && ARCHIVE_EXTS.has(extname(e.name).toLowerCase())) {
      mods.push(await buildModItem(join(dir, e.name), false))
    } else if (e.isDirectory()) {
      mods.push(await buildModItem(join(dir, e.name), true))
    }
  }
  if (mods.length === 0 && (await dirHasDds(dir))) {
    mods.push(await buildModItem(dir, true))
  }
  mods.sort((a, b) => a.name.localeCompare(b.name))
  return mods
}

/** 扫描模型库根目录：每个子文件夹 = 一个模型；根目录下散放的压缩包归入「未分组」 */
export async function scanModelLibrary(): Promise<ModelLibraryScan | null> {
  const { modelLibraryDir } = await getSettings()
  if (!modelLibraryDir) return null
  let entries
  try {
    entries = await fs.readdir(modelLibraryDir, { withFileTypes: true })
  } catch {
    return { root: modelLibraryDir, models: [] }
  }

  const models: ModelGroup[] = []
  const looseArchives: ModItem[] = []
  for (const e of entries) {
    const full = join(modelLibraryDir, e.name)
    if (e.isDirectory()) {
      const mods = await scanModelDir(full)
      if (mods.length > 0) models.push({ name: e.name, dir: full, mods })
    } else if (e.isFile() && ARCHIVE_EXTS.has(extname(e.name).toLowerCase())) {
      looseArchives.push(await buildModItem(full, false))
    }
  }
  models.sort((a, b) => a.name.localeCompare(b.name))
  if (looseArchives.length > 0) {
    looseArchives.sort((a, b) => a.name.localeCompare(b.name))
    models.unshift({ name: '未分组', dir: modelLibraryDir, mods: looseArchives })
  }
  return { root: modelLibraryDir, models }
}

/** 简单字符串哈希（给预览缓存目录命名） */
function hashStr(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

/** 用 7z 列出压缩包条目，挑一张预览图，提取到临时缓存并返回其路径（无图或失败返回 null） */
export async function extractPreviewFromArchive(archivePath: string): Promise<string | null> {
  const sevenZip = locate7z()
  if (!sevenZip) return null
  let mtime = 0
  try {
    mtime = Math.floor((await fs.stat(archivePath)).mtimeMs)
  } catch {
    return null
  }
  const cacheDir = join(app.getPath('temp'), 'zzz-modlib-preview', hashStr(archivePath) + '_' + mtime)
  // 命中缓存
  if (await exists(cacheDir)) {
    try {
      const cached = (await fs.readdir(cacheDir)).find((n) =>
        IMAGE_EXTS.has(extname(n).toLowerCase())
      )
      if (cached) return join(cacheDir, cached)
    } catch {
      /* fallthrough to re-extract */
    }
  }

  // 列出条目，选出预览图
  let stdout = ''
  try {
    const r = await execFileAsync(sevenZip, ['l', '-slt', '-ba', '--', archivePath], {
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024
    })
    stdout = r.stdout
  } catch {
    return null
  }
  const paths: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^Path = (.+)$/.exec(line)
    if (m) paths.push(m[1])
  }
  const images = paths.filter((p) => IMAGE_EXTS.has(extname(p).toLowerCase()))
  if (images.length === 0) return null
  const depth = (p: string): number => p.split(/[\\/]/).length
  const chosen =
    images.find((p) => PREVIEW_HINT.test(basename(p))) ??
    images.sort((a, b) => depth(a) - depth(b) || a.length - b.length)[0]

  // 提取这一张（-e 平铺到缓存目录）
  try {
    await fs.mkdir(cacheDir, { recursive: true })
    await execFileAsync(
      sevenZip,
      ['e', '-y', '-bso0', '-bsp0', '-o' + cacheDir, '--', archivePath, chosen],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
    )
    const out = join(cacheDir, basename(chosen))
    return (await exists(out)) ? out : null
  } catch {
    return null
  }
}

/**
 * 打开模型库里的一个 mod：
 * - 文件夹：直接 scanModDds。
 * - 压缩包：用 7z 解压到 <workspace>/_extracted/<名字>/（已解压过则复用），再 scanModDds。
 */
export async function prepareModRootFromEntry(
  entryPath: string,
  kind: 'archive' | 'folder'
): Promise<ModScan> {
  if (kind === 'folder') {
    return scanModDds(entryPath)
  }
  const { workspaceDir } = await getSettings()
  if (!workspaceDir) throw new Error('尚未设置工作目录')
  const sevenZip = locate7z()
  if (!sevenZip) throw new Error('未找到内置 7z.exe，无法解压压缩包')
  const stem = basename(entryPath).slice(0, basename(entryPath).length - extname(entryPath).length)
  const staging = join(workspaceDir, '_extracted', sanitizeSegment(stem))

  // 已解压过（目录存在且非空）则复用，避免每次重复解压
  let reuse = false
  if (await exists(staging)) {
    try {
      reuse = (await fs.readdir(staging)).length > 0
    } catch {
      reuse = false
    }
  }
  if (!reuse) {
    await fs.mkdir(staging, { recursive: true })
    await execFileAsync(
      sevenZip,
      ['x', '-y', '-bso0', '-bsp0', '-o' + staging, '--', entryPath],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }
    )
  }
  const scan = await scanModDds(staging)
  if (scan.files.length === 0) {
    throw new Error('压缩包里没有找到 DDS 贴图：' + basename(entryPath))
  }
  return scan
}

/** 把一张外部图片拷成 mod 项的同名 sidecar 预览图，返回新预览图路径 */
export async function assignPreview(entryPath: string, imagePath: string): Promise<string> {
  const isDir = (await fs.stat(entryPath)).isDirectory()
  const parent = dirname(entryPath)
  const stem = displayName(entryPath, isDir)
  const ext = extname(imagePath).toLowerCase() || '.png'
  const dest = join(parent, stem + (IMAGE_EXTS.has(ext) ? ext : '.png'))
  await fs.copyFile(imagePath, dest)
  return dest
}
