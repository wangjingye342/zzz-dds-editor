import { ipcMain, dialog, app, shell, BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import { join, basename, dirname } from 'path'
import { readDdsMeta } from './ddsHeader'
import { readDdsThumb } from './ddsThumb'
import { runTexconv, locateTexconv } from './texconv'
import { rawRgbaToSrgbDds } from './ddsWrite'
import { scanLibrary, readUsage, bumpUsage } from './library'
import { saveProjectDialog, loadProjectDialog } from './project'
import { getSettings, setWorkspaceDir, setOutputDir, updateSettings, addRecent, getRecent } from './settings'
import {
  scanModDds,
  prepareRecord,
  archiveOutputMod,
  saveProjectTo,
  readProjectFile,
  backupStatus,
  restoreFile
} from './records'
import type { ExportRequest, ExportResult, ProjectFile, RecentRecord, AppSettings } from '../shared/types'

export function registerIpc(): void {
  ipcMain.handle('dialog:openDds', async (_e, defaultPath?: string) => {
    const r = await dialog.showOpenDialog({
      title: '打开 DDS 贴图',
      defaultPath: defaultPath || undefined,
      filters: [{ name: 'DDS 贴图', extensions: ['dds'] }],
      properties: ['openFile']
    })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  ipcMain.handle('dialog:chooseFolder', async () => {
    const r = await dialog.showOpenDialog({
      title: '选择素材文件夹',
      properties: ['openDirectory']
    })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  // ---- 工作目录 + mod 文件夹输入 + 默认保存记录 ----
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:update', (_e, partial: Partial<AppSettings>) => updateSettings(partial))
  ipcMain.handle('shell:openPath', (_e, p: string) => shell.openPath(p))
  ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(url))

  ipcMain.handle('settings:chooseWorkspace', async () => {
    const r = await dialog.showOpenDialog({
      title: '选择工作目录（编辑记录保存到这里）',
      properties: ['openDirectory', 'createDirectory']
    })
    if (r.canceled || r.filePaths.length === 0) return null
    await setWorkspaceDir(r.filePaths[0])
    return r.filePaths[0]
  })

  ipcMain.handle('settings:chooseOutputDir', async () => {
    const r = await dialog.showOpenDialog({
      title: '选择输出目录（mod 副本和压缩包保存到这里）',
      properties: ['openDirectory', 'createDirectory']
    })
    if (r.canceled || r.filePaths.length === 0) return null
    await setOutputDir(r.filePaths[0])
    return r.filePaths[0]
  })

  ipcMain.handle('mod:open', async () => {
    const r = await dialog.showOpenDialog({
      title: '选择 Mod 文件夹（自动查找其中的 DDS）',
      properties: ['openDirectory']
    })
    if (r.canceled || r.filePaths.length === 0) return null
    return scanModDds(r.filePaths[0])
  })

  ipcMain.handle('record:prepare', (_e, modRoot: string, ddsPath: string) =>
    prepareRecord(modRoot, ddsPath)
  )
  ipcMain.handle('record:archiveOutputMod', (_e, modName: string) => archiveOutputMod(modName))
  ipcMain.handle('project:saveTo', (_e, path: string, project: ProjectFile) =>
    saveProjectTo(path, project)
  )
  ipcMain.handle('project:read', (_e, path: string) => readProjectFile(path))
  ipcMain.handle('record:addRecent', (_e, rec: RecentRecord) => addRecent(rec))
  ipcMain.handle('record:listRecent', () => getRecent())
  ipcMain.handle('record:backupStatus', (_e, projectPath: string) => backupStatus(projectPath))
  ipcMain.handle('file:restore', (_e, src: string, dest: string) => restoreFile(src, dest))
  ipcMain.handle('ui:confirm', async (_e, message: string, detail?: string) => {
    const r = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['取消', '确定'],
      defaultId: 0,
      cancelId: 0,
      message,
      detail
    })
    return r.response === 1
  })

  ipcMain.handle('window:setAlwaysOnTop', (e, on: boolean) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return false
    win.setAlwaysOnTop(on, 'screen-saver')
    return win.isAlwaysOnTop()
  })


  ipcMain.handle('dds:readMeta', (_e, path: string) => readDdsMeta(path))
  ipcMain.handle('dds:thumb', (_e, path: string, maxEdge?: number) =>
    readDdsThumb(path, maxEdge)
  )

  ipcMain.handle('file:readBinary', async (_e, path: string) => {
    const buf = await fs.readFile(path)
    return new Uint8Array(buf)
  })

  ipcMain.handle('library:scan', (_e, folder: string) => scanLibrary(folder))
  ipcMain.handle('usage:read', () => readUsage())
  ipcMain.handle('usage:bump', (_e, path: string) => bumpUsage(path))

  ipcMain.handle('project:save', (_e, project, currentPath) =>
    saveProjectDialog(project, currentPath)
  )
  ipcMain.handle('project:load', () => loadProjectDialog())

  ipcMain.handle('dds:export', async (_e, req: ExportRequest): Promise<ExportResult> => {
    const tmpDir = app.getPath('temp')
    const stamp = Date.now()
    const inDds = join(tmpDir, `zzzmerge_${stamp}.dds`)
    await fs.writeFile(inDds, rawRgbaToSrgbDds(req.rgba, req.width, req.height))

    // 非 Windows（开发机）：texconv.exe 跑不了，回退把合成结果存为未压缩 DDS
    if (process.platform !== 'win32') {
      const preview = join(
        dirname(req.ddsPath),
        basename(req.ddsPath).replace(/\.dds$/i, '') + '_preview.dds'
      )
      await fs.copyFile(inDds, preview)
      return {
        ok: false,
        message: 'DDS 编码仅 Windows 可用；已在原文件目录输出未压缩 DDS 预览。',
        fallbackPng: preview
      }
    }

    if (!locateTexconv()) {
      return {
        ok: false,
        message: '未找到 texconv.exe，请将其放入 resources/texconv/ 目录后重试。'
      }
    }

    try {
      const outDir = join(tmpDir, `zzzout_${stamp}`)
      await fs.mkdir(outDir, { recursive: true })
      const res = await runTexconv(inDds, {
        format: req.meta.texconvFormat,
        mipCount: req.meta.mipCount,
        outDir,
        dx10: req.meta.isDX10
      })
      if (res.code !== 0) {
        return { ok: false, message: 'texconv 编码失败', stderr: res.stderr || res.stdout }
      }
      const outDds = join(outDir, basename(inDds).replace(/\.dds$/i, '.dds'))

      // 覆盖前：记录原文件大小（用于报告 体积变化），并做备份
      let originalSize: number | undefined
      try {
        originalSize = (await fs.stat(req.ddsPath)).size
      } catch {
        /* 原文件可能不存在 */
      }
      // 把「将被替换的当前贴图」存为 .prev.dds（每次导出更新），用于「恢复上一次」
      if (req.prevBackupPath) {
        try {
          await fs.access(req.ddsPath)
          await fs.mkdir(dirname(req.prevBackupPath), { recursive: true })
          await fs.copyFile(req.ddsPath, req.prevBackupPath)
        } catch {
          /* 原文件不存在则跳过 */
        }
      }
      if (req.backup) {
        const bak = req.ddsPath + '.bak'
        try {
          await fs.access(bak)
        } catch {
          await fs.copyFile(req.ddsPath, bak)
        }
      }
      await fs.copyFile(outDds, req.ddsPath)

      // 回读输出 DDS 头，确认实际格式 + 体积，回报给渲染端
      let outputSize: number | undefined
      let outputFormat: string | undefined
      try {
        outputSize = (await fs.stat(req.ddsPath)).size
        outputFormat = (await readDdsMeta(req.ddsPath)).formatName
      } catch {
        /* 读取失败不影响导出本身 */
      }
      return {
        ok: true,
        message: '导出成功，已覆盖原 DDS。',
        outputPath: req.ddsPath,
        originalSize,
        originalFormat: req.meta.formatName,
        outputSize,
        outputFormat
      }
    } catch (err) {
      return { ok: false, message: '导出异常：' + (err instanceof Error ? err.message : String(err)) }
    }
  })
}
