import './polyfill'
import './style.css'
import { EditorCanvas } from './editor'
import { LibraryPanel } from './library'
import { setupLayersPanel } from './layersPanel'
import { showDdsPicker, showRecentPicker } from './modPicker'
import { setupSettingsPanel } from './settingsPanel'
import { ddsToDataURL, ddsToPreviewCanvas, ddsToOpaqueCanvasWithAlpha } from './ddsDecode'
import { progress } from './progress'
import type { DdsMeta, ProjectFile, DdsEntry, ModScan, RecentRecord } from '@shared/types'

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T

progress.init($('progress'), $('progress-label'), $('progress-fill'))

interface AppState {
  target: { ddsPath: string; meta: DdsMeta } | null
  baseSourceBytes: Uint8Array | null
  /** 当前记录/工程的保存路径；非 null 时启用自动保存与静默保存 */
  projectPath: string | null
  /** 当前 mod 根目录（仅 mod 流程；最近记录续编时可能为 null） */
  modRoot: string | null
  /** mod 文件夹名（写进工程 mod 字段，用于续编/导出判定与最近记录） */
  modName: string | null
  /** 是否为工作目录记录：base 自带原图副本，导出不写 .bak、保存走默认位置 */
  isRecord: boolean
}
const state: AppState = {
  target: null,
  baseSourceBytes: null,
  projectPath: null,
  modRoot: null,
  modName: null,
  isRecord: false
}
let workspaceDir: string | null = null
let outputDir: string | null = null
let autoSaveEnabled = true
let mirrorInsert = false
const exportSelect = $<HTMLSelectElement>('export-format')
const mirrorCheckbox = $<HTMLInputElement>('mirror-insert')
const btnRestorePrev = $<HTMLButtonElement>('btn-restore-prev')
const btnRestoreOrig = $<HTMLButtonElement>('btn-restore-orig')
const btnMergeLayers = $<HTMLButtonElement>('btn-merge-layers')
const btnArchiveMod = $<HTMLButtonElement>('btn-archive-mod')
const btnAlwaysOnTop = $<HTMLButtonElement>('btn-always-on-top')

const canvasEl = $<HTMLCanvasElement>('fabric-canvas')
const host = $('canvas-host')
const empty = $('canvas-empty')
const statusEl = $('status')
const infoText = $('canvas-info-text')

const editor = new EditorCanvas(canvasEl)
const btnPersp = $<HTMLButtonElement>('btn-perspective')
const btnPerspCancel = $<HTMLButtonElement>('btn-persp-cancel')

// 图层面板 + 回调编排：结构/选区变化时刷新面板与透视按钮；结构变化与图层属性改动触发自动保存
const layers = setupLayersPanel(editor, $('layer-list'), $('layer-props'), scheduleAutosave)
editor.onLayersChange = () => {
  layers.render()
  refreshPerspBtn()
  refreshMergeBtn()
  scheduleAutosave()
}
editor.onSelectionChange = () => {
  layers.render()
  refreshPerspBtn()
}
editor.onPerspChange = (active) => applyPerspUI(active)
editor.onViewChange = () => setInfo()
editor.onPlacementStateChange = (st) => {
  if (st === 'center') setStatus('放置：在背景上点一下确定【中心点】（Esc 取消）')
  else if (st === 'preview')
    setStatus('放置：移动鼠标调整大小 / 角度，再点一下【固定】（此处为右下角；Esc 取消）')
  else library.clearActive()
}
editor.onPlacementCommit = (obj) => {
  const meta = editor.metaOf(obj)
  if (meta?.sourcePath) {
    void window.api.bumpUsage(meta.sourcePath)
    library.bumpLocal(meta.sourcePath)
  }
  library.clearActive()
  setStatus('已放置图层：' + (meta?.name ?? ''), 'ok')
}
layers.render()

function setStatus(msg: string, kind: '' | 'ok' | 'err' = ''): void {
  statusEl.textContent = msg
  statusEl.className = 'status-bar ' + kind
}

function setInfo(): void {
  if (!state.target) {
    infoText.textContent = ''
    return
  }
  const m = state.target.meta
  infoText.textContent = `${m.formatName} · ${m.width}×${m.height} · mip ${m.mipCount} · 缩放 ${(editor.zoom * 100).toFixed(0)}%`
}

/** 把二进制按扩展名解码成可显示的 dataURL */
async function bytesToDataURL(bytes: Uint8Array, ext: string): Promise<string> {
  if (ext === 'dds') return ddsToDataURL(bytes).dataURL
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime })
  return await new Promise<string>((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result as string)
    fr.onerror = () => reject(fr.error)
    fr.readAsDataURL(blob)
  })
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}
function extOf(p: string): string {
  return (p.split('.').pop() ?? '').toLowerCase()
}
/** 目录名（去掉最后一段） */
function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i > 0 ? p.slice(0, i) : p
}
/** file 是否位于 dir 目录内部（Windows 不区分大小写、统一斜杠） */
function isInsideDir(dir: string, file: string): boolean {
  const norm = (s: string): string => s.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(file).startsWith(norm(dir) + '/')
}

/** 从 dataURL 异步加载为 <img>（用于内嵌底图的小工程） */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const im = new Image()
    im.onload = () => resolve(im)
    im.onerror = () => reject(new Error('图片加载失败'))
    im.src = src
  })
}

// ---------- 自适应缩放 ----------
const ro = new ResizeObserver(() => {
  if (state.target) {
    editor.resize(host.clientWidth, host.clientHeight) // 只改可视区，保留当前缩放/平移
    setInfo()
  }
})
ro.observe(host)

// ---------- 自动保存（默认保存到记录路径） ----------
let autosaveTimer: number | null = null
function scheduleAutosave(): void {
  if (!state.projectPath || !autoSaveEnabled) return // 需有默认记录路径且开启自动保存
  if (autosaveTimer !== null) clearTimeout(autosaveTimer)
  autosaveTimer = window.setTimeout(() => {
    autosaveTimer = null
    void doAutosave(false)
  }, 800)
}
async function doAutosave(initial: boolean): Promise<void> {
  if (!state.projectPath || !state.target) return
  if (editor.isPerspActive()) {
    // 透视编辑中先不落盘，避免提前烘焙；提交后会再次触发
    scheduleAutosave()
    return
  }
  try {
    await window.api.saveProjectTo(state.projectPath, buildProject())
    if (!initial) setStatus('已自动保存 · ' + new Date().toLocaleTimeString(), 'ok')
  } catch (e) {
    setStatus('自动保存失败：' + (e as Error).message, 'err')
  }
}

/** 切换到另一张贴图前，把当前这张的编辑立即落盘，避免防抖未触发时丢失改动 */
async function flushPendingSave(): Promise<void> {
  if (autosaveTimer !== null) {
    clearTimeout(autosaveTimer)
    autosaveTimer = null
  }
  if (state.projectPath && state.target) {
    try {
      await window.api.saveProjectTo(state.projectPath, buildProject())
    } catch {
      /* 落盘失败不阻塞切换 */
    }
  }
}

/** 组装当前编辑状态为工程数据（mod 流程附带 mod 名标记） */
function buildProject(): ProjectFile {
  if (editor.isPerspActive()) editor.applyPerspective()
  const p: ProjectFile = {
    version: 1,
    app: 'zzz-dds-editor',
    target: state.target,
    canvas: { width: editor.ddsW, height: editor.ddsH },
    layers: editor.exportProjectLayers()
  }
  if (state.modName) p.mod = { name: state.modName }
  return p
}

// ---------- 设置（工作目录 / 默认导出格式 / 自动保存 / 素材文件夹） ----------
const settings = setupSettingsPanel({
  onWorkspaceChange: (dir) => {
    workspaceDir = dir
    reflectWorkspace()
    setStatus('工作目录已设为：' + dir, 'ok')
  },
  onOutputChange: (dir) => {
    outputDir = dir
    reflectWorkspace()
    setStatus('输出目录已设为：' + dir, 'ok')
  },
  onExportFormatChange: (fmt) => {
    exportSelect.value = fmt
  },
  onAutoSaveChange: (on) => {
    autoSaveEnabled = on
    setStatus(on ? '已开启自动保存' : '已关闭自动保存（改用手动「保存记录」）', 'ok')
  },
  onLibraryChange: (dir) => {
    if (dir) void loadLibrary(dir, false)
    else {
      library.setItems([])
      setStatus('已清除素材文件夹')
    }
  }
})
$('btn-settings').addEventListener('click', () => void settings.open())
btnAlwaysOnTop.addEventListener('click', () => void toggleAlwaysOnTop())

let alwaysOnTop = false
async function toggleAlwaysOnTop(): Promise<void> {
  try {
    const next = !alwaysOnTop
    alwaysOnTop = await window.api.setWindowAlwaysOnTop(next)
    btnAlwaysOnTop.classList.toggle('primary', alwaysOnTop)
    btnAlwaysOnTop.classList.toggle('ghost', !alwaysOnTop)
    btnAlwaysOnTop.textContent = alwaysOnTop ? '已置顶' : '窗口置顶'
    btnAlwaysOnTop.title = alwaysOnTop
      ? '当前窗口会保持在其他普通窗口前面，点击取消'
      : '让程序窗口保持在其他普通窗口前面'
    setStatus(alwaysOnTop ? '已开启窗口置顶' : '已取消窗口置顶', 'ok')
  } catch (e) {
    setStatus('切换窗口置顶失败：' + (e as Error).message, 'err')
  }
}

/** 启动时读取设置：工作目录、自动保存、默认导出格式、素材文件夹自动加载 */
async function initApp(): Promise<void> {
  try {
    const s = await window.api.getSettings()
    workspaceDir = s.workspaceDir
    outputDir = s.outputDir
    autoSaveEnabled = s.autoSave
    if (s.defaultExportFormat) exportSelect.value = s.defaultExportFormat
    mirrorInsert = s.mirrorInsert
    mirrorCheckbox.checked = s.mirrorInsert
    if (s.libraryDir) await loadLibrary(s.libraryDir, false)
  } catch {
    /* 读取失败按默认处理 */
  }
  reflectWorkspace()
}
function reflectWorkspace(): void {
  const btn = $<HTMLButtonElement>('btn-settings')
  const missing: string[] = []
  if (!workspaceDir) missing.push('工作目录')
  if (!outputDir) missing.push('输出目录')
  btn.title =
    missing.length === 0
      ? `设置（工作目录：${workspaceDir}；输出目录：${outputDir}）`
      : `未设置${missing.join('、')}，点此设置`
  btn.classList.toggle('attn', missing.length > 0) // 未设目录时描边提醒
}
/** 确保已设工作目录，未设则引导用户选择；返回是否就绪 */
async function ensureWorkspace(): Promise<boolean> {
  if (workspaceDir) return true
  const dir = await window.api.chooseWorkspace()
  if (!dir) return false
  workspaceDir = dir
  reflectWorkspace()
  return true
}

/** 确保已设输出目录，未设则引导用户选择；返回是否就绪 */
async function ensureOutputDir(): Promise<boolean> {
  if (outputDir) return true
  const dir = await window.api.chooseOutputDir()
  if (!dir) return false
  outputDir = dir
  reflectWorkspace()
  return true
}

// ---------- 打开 Mod 文件夹 → 选贴图 → 续编/新建记录 ----------
$('btn-open-mod').addEventListener('click', openMod)
async function openMod(): Promise<void> {
  if (!(await ensureWorkspace())) {
    setStatus('已取消：需要先设置一个工作目录用于保存编辑记录', 'err')
    return
  }
  if (!(await ensureOutputDir())) {
    setStatus('已取消：需要先设置一个输出目录用于保存 mod 副本', 'err')
    return
  }
  setStatus('正在扫描 mod 文件夹…')
  const scan = await progress.run('扫描 mod 文件夹中的 DDS…', () =>
    window.api.openModFolder()
  )
  if (!scan) {
    setStatus('已取消')
    return
  }
  if (scan.files.length === 0) {
    setStatus(`「${scan.name}」里没有找到 DDS 文件`, 'err')
    return
  }
  const entry = await showDdsPicker(scan, workspaceDir)
  if (!entry) {
    setStatus('已取消选择贴图')
    return
  }
  await openModDds(scan, entry)
}

async function openModDds(scan: ModScan, entry: DdsEntry): Promise<void> {
  await flushPendingSave() // 切换前先保存当前这张，避免丢失且不与新记录混淆
  setStatus('正在准备编辑记录…')
  try {
    const prep = await progress.run(`准备编辑记录：${entry.name}`, () =>
      window.api.prepareRecord(scan.root, entry.path)
    )
    if (prep.project) {
      // 续编已有记录
      await progress.run(`载入记录：${entry.name}`, () =>
        loadProjectIntoEditor(prep.project!, prep.projPath)
      )
      state.modRoot = scan.root
      state.modName = scan.name
      state.isRecord = true
      setStatus(`已续编记录：${scan.name} / ${entry.name}`, 'ok')
    } else {
      // 新建记录：base 取工作目录里的原图副本；导出目标是 mod 里的原始 DDS
      resetRecordState()
      await progress.run(`解码底图：${entry.name}`, async () => {
        const meta = await window.api.readDdsMeta(prep.outputDdsPath)
        const bytes = await window.api.readBinary(prep.baseCopyPath)
        state.baseSourceBytes = bytes
        const { canvas, fullW, fullH } = ddsToPreviewCanvas(bytes)
        editor.reset()
        editor.setBaseImage(canvas, fullW || meta.width, fullH || meta.height, prep.baseCopyPath)
        editor.fit(host.clientWidth, host.clientHeight)
        state.target = { ddsPath: prep.outputDdsPath, meta }
        state.projectPath = prep.projPath
        state.modRoot = scan.root
        state.modName = scan.name
        state.isRecord = true
        empty.style.display = 'none'
        setInfo()
        await doAutosave(true) // 立即落盘初始记录
      })
      setStatus(`已新建记录：${scan.name} / ${entry.name}`, 'ok')
    }
    await recordRecent(entry.name)
    await refreshRestoreButtons()
    refreshArchiveBtn()
  } catch (e) {
    setStatus('打开失败：' + (e as Error).message, 'err')
  }
}

/** 把当前记录写进「最近记录」索引 */
async function recordRecent(ddsName: string): Promise<void> {
  if (!state.projectPath || !state.modName || !state.target) return
  try {
    await window.api.addRecent({
      projPath: state.projectPath,
      modName: state.modName,
      ddsName,
      ddsPath: state.target.ddsPath,
      lastOpened: Date.now()
    })
  } catch {
    /* 最近记录是便利功能，失败不影响主流程 */
  }
}

// ---------- 最近记录 ----------
$('btn-recent').addEventListener('click', openRecent)
async function openRecent(): Promise<void> {
  let recents: RecentRecord[] = []
  try {
    recents = await window.api.getRecent()
  } catch {
    /* 无最近记录 */
  }
  const rec = await showRecentPicker(recents)
  if (!rec) return
  await flushPendingSave()
  setStatus('正在打开记录…')
  try {
    const project = await progress.run(`打开记录：${rec.ddsName}`, () =>
      window.api.readProjectFile(rec.projPath)
    )
    await progress.run(`重建图层：${rec.ddsName}`, () =>
      loadProjectIntoEditor(project, rec.projPath)
    )
    state.modName = rec.modName
    state.modRoot = null
    state.isRecord = true
    refreshArchiveBtn()
    await window.api.addRecent({ ...rec, lastOpened: Date.now() })
    setStatus(`已打开记录：${rec.modName} / ${rec.ddsName}`, 'ok')
  } catch (e) {
    setStatus('打开记录失败（文件可能已移动）：' + (e as Error).message, 'err')
  }
}

// ---------- 打开同一 mod 里的另一张 DDS（各自独立记录，同一 mod 目录下） ----------
$('btn-open-dds').addEventListener('click', openDds)
async function openDds(): Promise<void> {
  // 与 mod 流程一致：需要工作目录 + 输出目录，保证新贴图的记录/输出与前一张同处一个 mod
  if (!(await ensureWorkspace())) {
    setStatus('已取消：需要先设置工作目录', 'err')
    return
  }
  if (!(await ensureOutputDir())) {
    setStatus('已取消：需要先设置输出目录', 'err')
    return
  }
  // 默认定位到当前 mod 文件夹，方便直接挑同一 mod 里的另一张
  const defaultDir = state.modRoot ?? (state.target ? dirnameOf(state.target.ddsPath) : undefined)
  const path = await window.api.openDdsDialog(defaultDir ?? undefined)
  if (!path) return
  // 归属判定：在当前 mod 内 → 用同一个 mod 根（同一 <工作目录>/<mod名> 与 <输出目录>/<mod名>）；
  // 否则以该文件所在文件夹作为它自己的 mod 根。
  const root = state.modRoot && isInsideDir(state.modRoot, path) ? state.modRoot : dirnameOf(path)
  await openModDds(
    { root, name: basename(root), files: [] },
    { path, rel: '', name: basename(path), size: 0, hasRecord: false }
  )
}

/** 清空当前记录/工程上下文（在重建底图前调用，防止误自动保存到旧记录） */
function resetRecordState(): void {
  if (autosaveTimer !== null) {
    clearTimeout(autosaveTimer)
    autosaveTimer = null
  }
  state.target = null
  state.baseSourceBytes = null
  state.projectPath = null
  state.modRoot = null
  state.modName = null
  state.isRecord = false
  btnRestorePrev.disabled = true
  btnRestoreOrig.disabled = true
  refreshArchiveBtn()
}

// ---------- 素材库 ----------
const library = new LibraryPanel($('library-grid'), $<HTMLInputElement>('library-search'))
// 点击素材 → 进入两次点击放置模式（拖拽仍可用）
library.onActivate = (item) => void armPlacement(item)
// 镜像插入开关：持久化，影响拖拽 / 两次点击放置
mirrorCheckbox.addEventListener('change', () => {
  mirrorInsert = mirrorCheckbox.checked
  void window.api.updateSettings({ mirrorInsert })
})
async function armPlacement(item: { path: string; name: string; ext: string }): Promise<void> {
  if (!state.target) {
    setStatus('请先打开要编辑的贴图', 'err')
    return
  }
  try {
    const bytes = await window.api.readBinary(item.path)
    const dataURL = await bytesToDataURL(bytes, item.ext)
    await editor.beginPlacement(dataURL, item.name, item.path, mirrorInsert)
    library.setActive(item.path)
  } catch (e) {
    setStatus('载入贴图失败：' + (e as Error).message, 'err')
  }
}
$('btn-choose-folder').addEventListener('click', chooseFolder)
async function chooseFolder(): Promise<void> {
  const folder = await window.api.chooseFolder()
  if (!folder) return
  await loadLibrary(folder, true) // 手动选择 → 记住为默认素材文件夹（启动自动加载）
}
/** 扫描并加载素材文件夹；persist 时记为启动自动加载目录 */
async function loadLibrary(folder: string, persist: boolean): Promise<void> {
  setStatus('正在扫描素材…')
  try {
    const items = await progress.run('扫描素材文件夹…', () => window.api.scanLibrary(folder))
    library.setItems(items)
    if (persist) await window.api.updateSettings({ libraryDir: folder })
    setStatus(`素材文件夹已加载，共 ${items.length} 个文件`, 'ok')
  } catch (e) {
    setStatus('扫描失败：' + (e as Error).message, 'err')
  }
}

// ---------- 拖拽到画布 → 新图层 ----------
host.addEventListener('dragover', (e) => {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  host.classList.add('drag-over')
})
host.addEventListener('dragleave', (e) => {
  if (!host.contains(e.relatedTarget as Node)) host.classList.remove('drag-over')
})
host.addEventListener('drop', onDrop)
async function onDrop(e: DragEvent): Promise<void> {
  e.preventDefault()
  host.classList.remove('drag-over')
  const path =
    e.dataTransfer?.getData('application/x-zzz-asset') || e.dataTransfer?.getData('text/plain')
  if (!path) return
  if (!state.target) {
    setStatus('请先打开要编辑的贴图，再拖入素材', 'err')
    return
  }
  try {
    const bytes = await window.api.readBinary(path)
    const dataURL = await bytesToDataURL(bytes, extOf(path))
    const pt = editor.screenToScene(e.clientX, e.clientY)
    await editor.addOverlay(dataURL, pt.x, pt.y, basename(path), path, mirrorInsert)
    await window.api.bumpUsage(path)
    library.bumpLocal(path)
    setStatus('已添加图层：' + basename(path), 'ok')
  } catch (e2) {
    setStatus('添加失败：' + (e2 as Error).message, 'err')
  }
}

// ---------- 缩放 / 平移控制 ----------
$('btn-zoom-in').addEventListener('click', () => editor.zoomByCenter(1.25))
$('btn-zoom-out').addEventListener('click', () => editor.zoomByCenter(0.8))
$('btn-zoom-fit').addEventListener('click', () => editor.fit(host.clientWidth, host.clientHeight))
$('btn-zoom-1').addEventListener('click', () => editor.zoomToActual())
// Esc 取消正在进行的放置
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && editor.isPlacing()) {
    editor.cancelPlacement()
    setStatus('已取消放置')
  }
})

// ---------- 导出 DDS（覆盖原文件） ----------
/** 导出格式预设：颜色方式 → texconv 格式名 + 是否写 DX10 扩展头。auto 表示沿用原图。 */
const EXPORT_PRESETS: Record<string, { texconvFormat: string; isDX10: boolean } | null> = {
  'bc7-srgb': { texconvFormat: 'BC7_UNORM_SRGB', isDX10: true },
  'bc7-linear': { texconvFormat: 'BC7_UNORM', isDX10: true },
  'bc3-srgb': { texconvFormat: 'BC3_UNORM_SRGB', isDX10: true },
  'bc1-srgb': { texconvFormat: 'BC1_UNORM_SRGB', isDX10: true },
  'bc5-linear': { texconvFormat: 'BC5_UNORM', isDX10: true },
  auto: null
}
$('btn-export').addEventListener('click', exportDds)
btnArchiveMod.addEventListener('click', () => void archiveCurrentMod())
// 工具栏切换导出格式时记住为默认（与设置面板共用同一存储值）
exportSelect.addEventListener('change', () => {
  void window.api.updateSettings({ defaultExportFormat: exportSelect.value })
})
async function exportDds(): Promise<void> {
  if (!state.target) {
    setStatus('请先打开贴图', 'err')
    return
  }
  setStatus('正在合并图层并编码…')
  const bar = progress.batch('准备导出…', 3)
  try {
    // 导出前重新解码全分辨率底图（不透明 RGB + 原始 alpha），保证清晰度且不丢颜色/alpha
    bar.setLabel('全分辨率重解码底图')
    let baseFull:
      | { el: HTMLCanvasElement; w: number; h: number; alpha: Uint8Array }
      | undefined
    if (state.baseSourceBytes) {
      const baseBytes = state.baseSourceBytes
      const full = ddsToOpaqueCanvasWithAlpha(baseBytes)
      baseFull = { el: full.canvas, w: full.width, h: full.height, alpha: full.alpha }
    }
    bar.step()
    bar.setLabel('合并图层')
    const merged = await editor.exportMergedRgba(baseFull)
    const rgba = new Uint8Array(merged.rgba.buffer, merged.rgba.byteOffset, merged.rgba.byteLength)
    bar.step()
    // 按用户选择的颜色方式覆盖导出格式；auto 则沿用原图格式
    const preset = EXPORT_PRESETS[exportSelect.value] ?? null
    const meta = preset ? { ...state.target.meta, ...preset } : state.target.meta
    bar.setLabel('texconv 编码为 DDS')
    const res = await window.api.exportDds({
      ddsPath: state.target.ddsPath,
      meta,
      rgba,
      width: merged.width,
      height: merged.height,
      // 工作目录记录已自带原图副本，无需在 mod 目录再写 .bak；单文件流程仍备份
      backup: !state.isRecord,
      // 记录流程：覆盖前把当前贴图存为 .prev.dds，供「恢复上一次」
      prevBackupPath: state.projectPath ? prevBackupPathOf(state.projectPath) : undefined
    })
    bar.step()
    if (res.ok) await refreshRestoreButtons()
    if (res.ok && res.outputSize != null) {
      const kb = (n: number): string =>
        n >= 1024 * 1024 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB'
      let msg = `导出成功 · ${res.outputFormat ?? ''} ${kb(res.outputSize)}`
      if (res.originalSize != null) {
        msg += ` ← 原 ${res.originalFormat ?? ''} ${kb(res.originalSize)}`
      }
      // 明显变大且不是「跟随原图」时，提示如何保持原大小
      if (res.originalSize != null && res.outputSize > res.originalSize * 1.1 && exportSelect.value !== 'auto') {
        msg += ' · 想保持原大小请选「跟随原图格式」'
      }
      setStatus(msg, 'ok')
    } else {
      setStatus(res.message, res.ok ? 'ok' : 'err')
    }
  } catch (e) {
    setStatus('导出失败：' + (e as Error).message, 'err')
  } finally {
    bar.done()
  }
}

function refreshArchiveBtn(): void {
  btnArchiveMod.disabled = !state.modName || !state.isRecord
  btnArchiveMod.title =
    state.modName && state.isRecord
      ? '把输出目录中的当前 mod 副本压缩成带时间戳的 RAR'
      : '打开 mod 文件夹并建立记录后可压缩输出副本'
}

async function archiveCurrentMod(): Promise<void> {
  if (!state.modName || !state.isRecord) {
    setStatus('请先打开一个 mod 文件夹记录', 'err')
    return
  }
  setStatus('正在压缩输出目录中的 mod 副本…')
  try {
    const res = await progress.run('正在生成 RAR 压缩包…', () =>
      window.api.archiveOutputMod(state.modName!)
    )
    if (res.ok) {
      setStatus('压缩完成：' + (res.archivePath ? basename(res.archivePath) : state.modName), 'ok')
    } else {
      setStatus(res.message, 'err')
    }
  } catch (e) {
    setStatus('压缩失败：' + (e as Error).message, 'err')
  }
}

// ---------- 恢复：上一次 / 完全恢复原始 ----------
/** 由 .zzzproj 路径推出备份路径（与主进程 records.ts 保持一致） */
function prevBackupPathOf(projectPath: string): string {
  return projectPath.replace(/\.zzzproj$/i, '') + '.prev.dds'
}
function pristinePathOf(projectPath: string): string {
  return projectPath.replace(/\.zzzproj$/i, '') + '.dds'
}

/** 根据备份是否就绪，启用/禁用两个恢复按钮 */
async function refreshRestoreButtons(): Promise<void> {
  if (!state.projectPath || !state.target) {
    btnRestorePrev.disabled = true
    btnRestoreOrig.disabled = true
    return
  }
  try {
    const st = await window.api.backupStatus(state.projectPath)
    btnRestorePrev.disabled = !st.hasPrev
    btnRestoreOrig.disabled = !st.hasOriginal
  } catch {
    btnRestorePrev.disabled = true
    btnRestoreOrig.disabled = true
  }
}

btnRestorePrev.addEventListener('click', async () => {
  if (!state.projectPath || !state.target) return
  try {
    await window.api.restoreFile(prevBackupPathOf(state.projectPath), state.target.ddsPath)
    setStatus('已恢复为上一次导出前的贴图（mod 文件已还原）', 'ok')
  } catch (e) {
    setStatus('恢复失败：' + (e as Error).message, 'err')
  }
})

btnRestoreOrig.addEventListener('click', async () => {
  if (!state.projectPath || !state.target) return
  const ok = await window.api.confirmDialog(
    '完全恢复到最开始的状态？',
    '将把 mod 里的贴图还原为最初的原始版本，并清空当前所有叠加图层。此操作不可撤销。'
  )
  if (!ok) return
  try {
    await window.api.restoreFile(pristinePathOf(state.projectPath), state.target.ddsPath)
    editor.removeAllOverlays() // 清空图层（底图本就是原始副本），随后自动保存空记录
    setStatus('已完全恢复为最初的原始贴图，并清空所有图层', 'ok')
  } catch (e) {
    setStatus('恢复失败：' + (e as Error).message, 'err')
  }
})

// ---------- 四角透视变形 ----------
btnPersp.addEventListener('click', () => {
  if (editor.isPerspActive()) {
    editor.applyPerspective()
    setStatus('已应用透视变形', 'ok')
  } else {
    const obj = editor.canvas.getActiveObject()
    if (obj && editor.metaOf(obj)?.kind === 'overlay') editor.enterPerspective(obj)
  }
})
btnPerspCancel.addEventListener('click', () => {
  editor.cancelPerspective()
  setStatus('已取消透视变形')
})

// ---------- 一键合并所有图层 ----------
btnMergeLayers.addEventListener('click', () => void mergeLayers())
async function mergeLayers(): Promise<void> {
  const n = editor.layers().filter((o) => editor.metaOf(o)?.kind === 'overlay').length
  if (n < 2) return
  await progress.run(`合并 ${n} 个图层…`, async () => {
    const ok = await editor.mergeOverlays()
    if (ok) setStatus(`已合并 ${n} 个图层为 1 个，编辑更流畅`, 'ok')
  })
}

/** 叠加图层 ≥2 才允许合并 */
function refreshMergeBtn(): void {
  const n = editor.layers().filter((o) => editor.metaOf(o)?.kind === 'overlay').length
  btnMergeLayers.disabled = n < 2
  btnMergeLayers.title =
    n < 2 ? '至少有两个叠加图层时可合并' : `把这 ${n} 个叠加图层合并为一个（提速）`
}

/** 选中叠加图层时才允许进入透视（透视态中不改动按钮，由 applyPerspUI 接管） */
function refreshPerspBtn(): void {
  if (editor.isPerspActive()) return
  const obj = editor.canvas.getActiveObject()
  const isOverlay = !!obj && editor.metaOf(obj)?.kind === 'overlay'
  btnPersp.disabled = !isOverlay
  btnPersp.title = isOverlay ? '对选中图层做四角透视变形' : '先选中一个叠加图层'
}

/** 进出透视态时切换工具栏与全局锁定 */
function applyPerspUI(active: boolean): void {
  lockUI(active)
  if (active) {
    btnPersp.textContent = '完成变形'
    btnPersp.classList.add('primary')
    btnPersp.disabled = false
    btnPerspCancel.style.display = ''
    setStatus('透视编辑中：拖动四角调整，然后点「完成变形」')
  } else {
    btnPersp.textContent = '四角变形'
    btnPersp.classList.remove('primary')
    btnPerspCancel.style.display = 'none'
    refreshPerspBtn()
  }
}

/** 透视编辑期间锁定可能干扰的全局操作 */
function lockUI(lock: boolean): void {
  ;[
    'btn-open-mod',
    'btn-recent',
    'btn-open-dds',
    'btn-export',
    'btn-archive-mod',
    'btn-save-proj',
    'btn-open-proj',
    'btn-choose-folder',
    'btn-settings'
  ].forEach((id) => {
    $<HTMLButtonElement>(id).disabled = lock
  })
}

// ---------- 保存记录（默认位置静默保存；单文件流程弹窗另存） ----------
$('btn-save-proj').addEventListener('click', saveProject)
async function saveProject(): Promise<void> {
  if (!state.target) {
    setStatus('请先打开贴图再保存', 'err')
    return
  }
  if (editor.isPerspActive()) editor.applyPerspective()
  setStatus('正在保存记录…')
  try {
    const project = buildProject()
    if (state.projectPath) {
      await window.api.saveProjectTo(state.projectPath, project)
      setStatus('记录已保存：' + basename(state.projectPath), 'ok')
    } else {
      const saved = await window.api.saveProjectDialog(project, null)
      if (!saved) {
        setStatus('已取消保存')
        return
      }
      state.projectPath = saved
      setStatus('工程已保存：' + basename(saved), 'ok')
    }
  } catch (e) {
    setStatus('保存失败：' + (e as Error).message, 'err')
  }
}

// ---------- 打开工程（手动弹窗，兼容旧 .zzzproj） ----------
$('btn-open-proj').addEventListener('click', openProject)
async function openProject(): Promise<void> {
  const r = await window.api.loadProjectDialog()
  if (!r) return
  await flushPendingSave()
  setStatus('正在打开工程…')
  try {
    await loadProjectIntoEditor(r.project, r.path)
    setStatus('已打开工程：' + basename(r.path), 'ok')
  } catch (e) {
    setStatus('打开工程失败：' + (e as Error).message, 'err')
  }
}

/** 把一个工程载入编辑器并同步状态（续编/打开工程/最近记录共用） */
async function loadProjectIntoEditor(p: ProjectFile, path: string): Promise<void> {
  if (p.app !== 'zzz-dds-editor' || !Array.isArray(p.layers)) {
    throw new Error('不是有效的工程文件')
  }
  resetRecordState() // 先清空，重建底图/图层时不会误自动保存到旧路径
  editor.reset()
  const base = p.layers.find((l) => l.kind === 'base')
  if (base && base.source.type === 'ref') {
    const bytes = await window.api.readBinary(base.source.path)
    state.baseSourceBytes = bytes
    const { canvas, fullW, fullH } = ddsToPreviewCanvas(bytes)
    editor.setBaseImage(canvas, fullW, fullH, base.source.path)
  } else if (base && base.source.type === 'embed') {
    const el = await loadImage(base.source.data)
    state.baseSourceBytes = null
    editor.setBaseImage(el, el.naturalWidth, el.naturalHeight)
  } else {
    state.baseSourceBytes = null
    editor.setBaseSize(p.canvas.width, p.canvas.height)
  }
  await editor.loadOverlays(p.layers.filter((l) => l.kind === 'overlay'))
  // 重建完成后再绑定记录上下文，启用后续自动保存
  state.target = p.target
  state.projectPath = path
  state.modName = p.mod?.name ?? null
  state.isRecord = !!p.mod
  empty.style.display = 'none'
  editor.fit(host.clientWidth, host.clientHeight)
  setInfo()
  await refreshRestoreButtons()
  refreshArchiveBtn()
}

void initApp()
setStatus('就绪：点击「打开 Mod 文件夹」开始，编辑会自动保存到工作目录')


