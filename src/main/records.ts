import { promises as fs, existsSync } from 'fs'
import { join, relative, dirname, basename, resolve, sep } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { ArchiveResult, DdsEntry, ModScan, ProjectFile, RecordPrep } from '../shared/types'
import { getSettings } from './settings'

const execFileAsync = promisify(execFile)

// 工作目录记录：把某张 mod DDS 的「分层、未合并、可续编」记录默认保存到
//   <workspace>/<modName>/<相对子目录>/<贴图名>.zzzproj
// 同目录再放一份原图副本 <贴图名>.dds 作为 base 来源（永不被导出覆盖），
// 保证「导出覆盖原 DDS 后仍能正确续编」。

/** 清理工作目录子目录名里的非法字符与首尾空格/点（仅用于我们新建的 modName 段） */
function sanitizeSegment(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '') || 'mod'
}

function stamp(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function sameOrInside(parent: string, child: string): boolean {
  const a = resolve(parent).replace(/[\\/]+$/, '').toLowerCase()
  const b = resolve(child).replace(/[\\/]+$/, '').toLowerCase()
  return b === a || b.startsWith(a + sep)
}

function outputPaths(outputDir: string, modName: string, modRoot: string, ddsPath: string): {
  outputModRoot: string
  outputDdsPath: string
} {
  const outputModRoot = join(outputDir, sanitizeSegment(modName))
  return { outputModRoot, outputDdsPath: join(outputModRoot, relative(modRoot, ddsPath)) }
}

export interface RecordPaths {
  recordDir: string
  projPath: string
  baseCopyPath: string
}

/** 由工作目录 / mod 名 / mod 根 / DDS 绝对路径推出记录三件套路径（镜像子目录结构） */
export function recordPaths(
  workspaceDir: string,
  modName: string,
  modRoot: string,
  ddsPath: string
): RecordPaths {
  const rel = relative(modRoot, ddsPath)
  const baseCopyPath = join(workspaceDir, sanitizeSegment(modName), rel)
  const projPath = baseCopyPath.replace(/\.dds$/i, '') + '.zzzproj'
  return { recordDir: dirname(baseCopyPath), projPath, baseCopyPath }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
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
    else if (e.name.toLowerCase().endsWith('.dds')) out.push(full)
  }
}

/** 扫描 mod 文件夹里的全部 DDS，并标注工作目录里是否已有对应记录 */
export async function scanModDds(folder: string): Promise<ModScan> {
  const files: string[] = []
  await walk(folder, files, 0)
  const modName = basename(folder)
  const { workspaceDir } = await getSettings()

  const entries: DdsEntry[] = []
  for (const f of files) {
    let size = 0
    try {
      size = (await fs.stat(f)).size
    } catch {
      // 文件可能在扫描间隙被移走，忽略大小
    }
    let hasRecord = false
    if (workspaceDir) {
      const { projPath } = recordPaths(workspaceDir, modName, folder, f)
      hasRecord = await exists(projPath)
    }
    entries.push({ path: f, rel: relative(folder, f), name: basename(f), size, hasRecord })
  }
  // 已有记录的排前面，其余按相对路径排序，便于快速找到在做的那张
  entries.sort(
    (a, b) => Number(b.hasRecord) - Number(a.hasRecord) || a.rel.localeCompare(b.rel)
  )
  return { root: folder, name: modName, files: entries }
}

/**
 * 为某张 mod DDS 准备/解析编辑记录。
 * 已存在 .zzzproj → 返回解析后的工程（断点续编）；
 * 否则确保记录目录与原图副本就位，project 返回 null（由渲染端建初始记录并保存）。
 */
export async function prepareRecord(modRoot: string, ddsPath: string): Promise<RecordPrep> {
  const { workspaceDir, outputDir } = await getSettings()
  if (!workspaceDir) throw new Error('尚未设置工作目录')
  if (!outputDir) throw new Error('尚未设置输出目录')
  const modName = basename(modRoot)
  const { recordDir, projPath, baseCopyPath } = recordPaths(workspaceDir, modName, modRoot, ddsPath)
  const { outputModRoot, outputDdsPath } = outputPaths(outputDir, modName, modRoot, ddsPath)
  if (sameOrInside(modRoot, outputModRoot)) {
    throw new Error('输出目录不能位于当前 mod 文件夹内部，否则会递归复制并破坏原始 mod')
  }
  if (sameOrInside(outputModRoot, modRoot)) {
    throw new Error('当前打开的 mod 已经位于输出目录的目标副本位置，请改为打开原始 mod 文件夹')
  }

  await fs.mkdir(outputDir, { recursive: true })
  await fs.cp(modRoot, outputModRoot, {
    recursive: true,
    force: false,
    errorOnExist: false
  })
  if (!(await exists(outputDdsPath))) {
    await fs.mkdir(dirname(outputDdsPath), { recursive: true })
    await fs.copyFile(ddsPath, outputDdsPath)
  }
  await fs.mkdir(recordDir, { recursive: true })

  if (await exists(projPath)) {
    const project: ProjectFile = JSON.parse(await fs.readFile(projPath, 'utf-8'))
    if (project.target) project.target.ddsPath = outputDdsPath
    return { recordDir, projPath, baseCopyPath, outputModRoot, outputDdsPath, project }
  }

  // 新建：拷一份原图副本作为 base 来源（已存在则不覆盖，保护历史原图）
  if (!(await exists(baseCopyPath))) {
    await fs.copyFile(ddsPath, baseCopyPath)
  }
  return { recordDir, projPath, baseCopyPath, outputModRoot, outputDdsPath, project: null }
}

function findRar(): string | null {
  const candidates = [
    'C:\\Program Files\\WinRAR\\Rar.exe',
    'C:\\Program Files (x86)\\WinRAR\\Rar.exe',
    'C:\\Program Files\\WinRAR\\WinRAR.exe',
    'C:\\Program Files (x86)\\WinRAR\\WinRAR.exe'
  ]
  const pathDirs = (process.env.PATH ?? '').split(';').filter(Boolean)
  for (const dir of pathDirs) {
    candidates.push(join(dir, 'Rar.exe'), join(dir, 'WinRAR.exe'))
  }
  return candidates.find((p) => {
    return existsSync(p)
  }) ?? null
}

export async function archiveOutputMod(modName: string): Promise<ArchiveResult> {
  const { outputDir } = await getSettings()
  if (!outputDir) return { ok: false, message: '尚未设置输出目录' }
  const folderName = sanitizeSegment(modName)
  const outputModRoot = join(outputDir, folderName)
  if (!(await exists(outputModRoot))) {
    return { ok: false, message: '输出目录中还没有对应的 mod 副本：' + outputModRoot }
  }
  const rar = findRar()
  if (!rar) {
    return { ok: false, message: '未找到 WinRAR/Rar.exe，请先安装 WinRAR 后再压缩' }
  }
  const archivePath = join(outputDir, `${folderName}_${stamp()}.rar`)
  try {
    await execFileAsync(rar, ['a', '-r', '-idq', archivePath, folderName], {
      cwd: outputDir,
      windowsHide: true
    })
    return { ok: true, message: 'RAR 压缩完成：' + archivePath, archivePath }
  } catch (err) {
    return {
      ok: false,
      message: 'RAR 压缩失败：' + (err instanceof Error ? err.message : String(err))
    }
  }
}

/** 把工程直接写入指定路径（默认/自动保存，无弹窗） */
export async function saveProjectTo(path: string, project: ProjectFile): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, JSON.stringify(project, null, 2), 'utf-8')
}

/** 读取指定路径的工程（用于「最近记录」直接续编） */
export async function readProjectFile(path: string): Promise<ProjectFile> {
  return JSON.parse(await fs.readFile(path, 'utf-8'))
}

/** 由 .zzzproj 路径推出备份三件套：原始(pristine) 与 上一次(prev) */
export function recordBackupPaths(projectPath: string): { pristinePath: string; prevPath: string } {
  const stem = projectPath.replace(/\.zzzproj$/i, '')
  return { pristinePath: stem + '.dds', prevPath: stem + '.prev.dds' }
}

/** 查询某记录的备份是否就绪 */
export async function backupStatus(
  projectPath: string
): Promise<{ hasPrev: boolean; hasOriginal: boolean }> {
  const { pristinePath, prevPath } = recordBackupPaths(projectPath)
  return { hasPrev: await exists(prevPath), hasOriginal: await exists(pristinePath) }
}

/** 复制文件（恢复贴图用）。src 不存在则抛错。 */
export async function restoreFile(src: string, dest: string): Promise<void> {
  if (!(await exists(src))) throw new Error('备份文件不存在：' + src)
  await fs.mkdir(dirname(dest), { recursive: true })
  await fs.copyFile(src, dest)
}
