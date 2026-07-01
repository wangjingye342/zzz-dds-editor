// 设置面板（见 index.html #settings-overlay）：工作目录、默认导出格式、自动保存、素材文件夹。
// 监听只在初始化时绑定一次；open() 时从主进程读最新设置回填控件再显示。

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T

export interface SettingsHooks {
  /** 工作目录选择后（已持久化） */
  onWorkspaceChange: (dir: string) => void
  /** 输出目录选择后（已持久化） */
  onOutputChange: (dir: string) => void
  /** 默认导出格式变化（已持久化） */
  onExportFormatChange: (fmt: string) => void
  /** 自动保存开关变化（已持久化） */
  onAutoSaveChange: (on: boolean) => void
  /** 素材文件夹变化（已持久化）：dir 为 null 表示清除 */
  onLibraryChange: (dir: string | null) => void
}

export function setupSettingsPanel(hooks: SettingsHooks): { open: () => Promise<void> } {
  const overlay = $('settings-overlay')
  const closeBtn = $<HTMLButtonElement>('settings-close')
  const wsPath = $('set-workspace-path')
  const wsChoose = $<HTMLButtonElement>('set-workspace-choose')
  const wsOpen = $<HTMLButtonElement>('set-workspace-open')
  const outPath = $('set-output-path')
  const outChoose = $<HTMLButtonElement>('set-output-choose')
  const outOpen = $<HTMLButtonElement>('set-output-open')
  const exportSel = $<HTMLSelectElement>('set-export-format')
  const autosaveChk = $<HTMLInputElement>('set-autosave')
  const libPath = $('set-library-path')
  const libChoose = $<HTMLButtonElement>('set-library-choose')
  const libClear = $<HTMLButtonElement>('set-library-clear')

  let curWorkspace: string | null = null
  let curOutput: string | null = null

  function showPath(el: HTMLElement, p: string | null): void {
    el.textContent = p ?? '未设置'
    el.classList.toggle('unset', !p)
  }
  const isOpen = (): boolean => overlay.style.display !== 'none'
  const hide = (): void => {
    overlay.style.display = 'none'
  }

  closeBtn.addEventListener('click', hide)
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) hide()
  })
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) hide()
  })

  wsChoose.addEventListener('click', async () => {
    const dir = await window.api.chooseWorkspace()
    if (!dir) return
    curWorkspace = dir
    showPath(wsPath, dir)
    hooks.onWorkspaceChange(dir)
  })
  wsOpen.addEventListener('click', () => {
    if (curWorkspace) void window.api.openPath(curWorkspace)
  })

  outChoose.addEventListener('click', async () => {
    const dir = await window.api.chooseOutputDir()
    if (!dir) return
    curOutput = dir
    showPath(outPath, dir)
    hooks.onOutputChange(dir)
  })
  outOpen.addEventListener('click', () => {
    if (curOutput) void window.api.openPath(curOutput)
  })

  exportSel.addEventListener('change', () => {
    void window.api.updateSettings({ defaultExportFormat: exportSel.value })
    hooks.onExportFormatChange(exportSel.value)
  })

  autosaveChk.addEventListener('change', () => {
    void window.api.updateSettings({ autoSave: autosaveChk.checked })
    hooks.onAutoSaveChange(autosaveChk.checked)
  })

  libChoose.addEventListener('click', async () => {
    const dir = await window.api.chooseFolder()
    if (!dir) return
    showPath(libPath, dir)
    await window.api.updateSettings({ libraryDir: dir })
    hooks.onLibraryChange(dir)
  })
  libClear.addEventListener('click', async () => {
    showPath(libPath, null)
    await window.api.updateSettings({ libraryDir: null })
    hooks.onLibraryChange(null)
  })

  async function open(): Promise<void> {
    const s = await window.api.getSettings()
    curWorkspace = s.workspaceDir
    curOutput = s.outputDir
    showPath(wsPath, s.workspaceDir)
    showPath(outPath, s.outputDir)
    showPath(libPath, s.libraryDir)
    exportSel.value = s.defaultExportFormat
    autosaveChk.checked = s.autoSave
    overlay.style.display = 'flex'
  }

  return { open }
}
