import { contextBridge, ipcRenderer } from 'electron'
import type { Api, ProjectFile, ExportRequest, RecentRecord } from '../shared/types'

const api: Api = {
  openDdsDialog: (defaultPath?: string) => ipcRenderer.invoke('dialog:openDds', defaultPath),
  chooseFolder: () => ipcRenderer.invoke('dialog:chooseFolder'),
  readDdsMeta: (path: string) => ipcRenderer.invoke('dds:readMeta', path),
  readBinary: (path: string) => ipcRenderer.invoke('file:readBinary', path),
  readDdsThumb: (path: string, maxEdge?: number) => ipcRenderer.invoke('dds:thumb', path, maxEdge),
  scanLibrary: (folder: string) => ipcRenderer.invoke('library:scan', folder),
  readUsage: () => ipcRenderer.invoke('usage:read'),
  bumpUsage: (path: string) => ipcRenderer.invoke('usage:bump', path),
  saveProjectDialog: (project: ProjectFile, currentPath: string | null) =>
    ipcRenderer.invoke('project:save', project, currentPath),
  loadProjectDialog: () => ipcRenderer.invoke('project:load'),
  exportDds: (req: ExportRequest) => ipcRenderer.invoke('dds:export', req),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (partial) => ipcRenderer.invoke('settings:update', partial),
  openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  chooseWorkspace: () => ipcRenderer.invoke('settings:chooseWorkspace'),
  chooseOutputDir: () => ipcRenderer.invoke('settings:chooseOutputDir'),
  chooseModelLibrary: () => ipcRenderer.invoke('settings:chooseModelLibrary'),
  scanModelLibrary: () => ipcRenderer.invoke('modlib:scan'),
  modlibExtractPreview: (archivePath: string) =>
    ipcRenderer.invoke('modlib:extractPreview', archivePath),
  modlibPrepareMod: (entryPath: string, kind: 'archive' | 'folder') =>
    ipcRenderer.invoke('modlib:prepareMod', entryPath, kind),
  modlibAssignPreview: (entryPath: string) => ipcRenderer.invoke('modlib:assignPreview', entryPath),
  openModFolder: () => ipcRenderer.invoke('mod:open'),
  prepareRecord: (modRoot: string, ddsPath: string) =>
    ipcRenderer.invoke('record:prepare', modRoot, ddsPath),
  archiveOutputMod: (modName: string) => ipcRenderer.invoke('record:archiveOutputMod', modName),
  saveProjectTo: (path: string, project: ProjectFile) =>
    ipcRenderer.invoke('project:saveTo', path, project),
  readProjectFile: (path: string) => ipcRenderer.invoke('project:read', path),
  addRecent: (rec: RecentRecord) => ipcRenderer.invoke('record:addRecent', rec),
  getRecent: () => ipcRenderer.invoke('record:listRecent'),
  backupStatus: (projectPath: string) => ipcRenderer.invoke('record:backupStatus', projectPath),
  restoreFile: (src: string, dest: string) => ipcRenderer.invoke('file:restore', src, dest),
  confirmDialog: (message: string, detail?: string) =>
    ipcRenderer.invoke('ui:confirm', message, detail),
  setWindowAlwaysOnTop: (on: boolean) => ipcRenderer.invoke('window:setAlwaysOnTop', on),
  platform: () => process.platform
}

contextBridge.exposeInMainWorld('api', api)
