import { promises as fs } from 'fs'
import { dialog } from 'electron'
import type { ProjectFile } from '../shared/types'

export async function saveProjectDialog(
  project: ProjectFile,
  currentPath: string | null
): Promise<string | null> {
  let target = currentPath
  if (!target) {
    const r = await dialog.showSaveDialog({
      title: '保存工程',
      defaultPath: 'untitled.zzzproj',
      filters: [{ name: 'ZZZ 工程文件', extensions: ['zzzproj'] }]
    })
    if (r.canceled || !r.filePath) return null
    target = r.filePath
  }
  await fs.writeFile(target, JSON.stringify(project, null, 2), 'utf-8')
  return target
}

export async function loadProjectDialog(): Promise<{ path: string; project: ProjectFile } | null> {
  const r = await dialog.showOpenDialog({
    title: '打开工程',
    filters: [{ name: 'ZZZ 工程文件', extensions: ['zzzproj'] }],
    properties: ['openFile']
  })
  if (r.canceled || r.filePaths.length === 0) return null
  const path = r.filePaths[0]
  const project: ProjectFile = JSON.parse(await fs.readFile(path, 'utf-8'))
  return { path, project }
}
