import type { ModItem, ModelGroup, ModScan } from '@shared/types'
import { progress } from './progress'

// 模型库面板（见 index.html #modellib-overlay）：左侧模型列表、右侧该模型的 mod 预览卡片网格。
// 点卡片「打开」→ 主进程解压/扫描得到 ModScan → 交回给 handlers.openScan 复用现有选贴图/编辑流程。

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T

const previewProgress = progress.refcount('生成 mod 预览图…')

export interface ModLibraryHandlers {
  /** 拿到某个 mod 的 ModScan 后，复用现有「选贴图 + 打开编辑」流程 */
  openScan: (scan: ModScan) => Promise<void>
  /** 状态栏提示 */
  setStatus: (msg: string, kind?: '' | 'ok' | 'err') => void
}

export function setupModLibraryPanel(handlers: ModLibraryHandlers): { open: () => Promise<void> } {
  const overlay = $('modellib-overlay')
  const closeBtn = $<HTMLButtonElement>('modellib-close')
  const chooseBtn = $<HTMLButtonElement>('ml-choose')
  const refreshBtn = $<HTMLButtonElement>('ml-refresh')
  const modelsEl = $('ml-models')
  const modsEl = $('ml-mods')
  const footEl = $('ml-foot')

  // 预览图 blob URL 缓存（按 mod 项路径）
  const previewCache = new Map<string, string>()
  let models: ModelGroup[] = []
  let activeModel = 0
  let io: IntersectionObserver | null = null

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

  async function loadPreview(item: ModItem): Promise<string> {
    const hit = previewCache.get(item.path)
    if (hit) return hit
    previewProgress.inc()
    try {
      let imgPath = item.previewPath
      if (!imgPath && item.kind === 'archive') {
        imgPath = await window.api.modlibExtractPreview(item.path)
      }
      if (!imgPath) return ''
      const bytes = await window.api.readBinary(imgPath)
      const ext = imgPath.slice(imgPath.lastIndexOf('.') + 1).toLowerCase()
      const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
      const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }))
      previewCache.set(item.path, url)
      return url
    } catch {
      return ''
    } finally {
      previewProgress.dec()
    }
  }

  async function openMod(item: ModItem): Promise<void> {
    try {
      const scan = await progress.run(
        item.kind === 'archive' ? `解压并扫描：${item.name}` : `扫描：${item.name}`,
        () => window.api.modlibPrepareMod(item.path, item.kind)
      )
      hide()
      await handlers.openScan(scan)
    } catch (e) {
      handlers.setStatus('打开失败：' + (e as Error).message, 'err')
    }
  }

  async function assignPreview(item: ModItem): Promise<void> {
    const p = await window.api.modlibAssignPreview(item.path)
    if (!p) return
    item.previewPath = p
    previewCache.delete(item.path)
    renderMods()
  }

  function buildCard(item: ModItem): HTMLElement {
    const card = document.createElement('div')
    card.className = 'ml-card'
    card.dataset.path = item.path

    const thumb = document.createElement('div')
    thumb.className = 'ml-thumb'
    const img = document.createElement('img')
    thumb.appendChild(img)
    const kindBadge = document.createElement('span')
    kindBadge.className = 'badge ml-kind'
    kindBadge.textContent = item.kind === 'archive' ? '压缩包' : '文件夹'
    thumb.appendChild(kindBadge)
    card.appendChild(thumb)

    const name = document.createElement('div')
    name.className = 'ml-name'
    name.textContent = item.name
    name.title = item.path
    card.appendChild(name)

    const actions = document.createElement('div')
    actions.className = 'ml-actions'
    const openBtn = document.createElement('button')
    openBtn.className = 'mini primary'
    openBtn.textContent = '打开'
    openBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      void openMod(item)
    })
    const prevBtn = document.createElement('button')
    prevBtn.className = 'mini'
    prevBtn.textContent = '指定预览图'
    prevBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      void assignPreview(item)
    })
    actions.append(openBtn, prevBtn)
    card.appendChild(actions)

    // 双击卡片也可打开
    card.addEventListener('dblclick', () => void openMod(item))

    const cached = previewCache.get(item.path)
    if (cached) img.src = cached
    else if (io) io.observe(card)
    return card
  }

  function renderMods(): void {
    if (io) io.disconnect()
    modsEl.innerHTML = ''
    const group = models[activeModel]
    if (!group || group.mods.length === 0) {
      const hint = document.createElement('div')
      hint.className = 'lib-hint'
      hint.textContent = group ? '这个模型下没有找到 mod（压缩包或子文件夹）' : ''
      modsEl.appendChild(hint)
      return
    }
    for (const item of group.mods) modsEl.appendChild(buildCard(item))
  }

  function renderModels(): void {
    modelsEl.innerHTML = ''
    if (models.length === 0) {
      const hint = document.createElement('div')
      hint.className = 'lib-hint'
      hint.textContent = '模型库为空，或尚未设置模型库目录'
      modelsEl.appendChild(hint)
      return
    }
    models.forEach((m, i) => {
      const row = document.createElement('div')
      row.className = 'ml-model' + (i === activeModel ? ' active' : '')
      const nm = document.createElement('span')
      nm.className = 'ml-model-name'
      nm.textContent = m.name
      const cnt = document.createElement('span')
      cnt.className = 'ml-model-count'
      cnt.textContent = String(m.mods.length)
      row.append(nm, cnt)
      row.addEventListener('click', () => {
        activeModel = i
        renderModels()
        renderMods()
      })
      modelsEl.appendChild(row)
    })
  }

  async function reload(): Promise<void> {
    footEl.textContent = '正在扫描模型库…'
    let scan
    try {
      scan = await progress.run('扫描模型库…', () => window.api.scanModelLibrary())
    } catch (e) {
      footEl.textContent = '扫描失败：' + (e as Error).message
      return
    }
    if (!scan) {
      models = []
      activeModel = 0
      renderModels()
      renderMods()
      footEl.textContent = '尚未设置模型库目录，点右上角「选择模型库目录」'
      return
    }
    models = scan.models
    activeModel = 0
    io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue
          const el = en.target as HTMLElement
          io!.unobserve(el)
          const path = el.dataset.path
          const item = models[activeModel]?.mods.find((m) => m.path === path)
          if (!item) continue
          void loadPreview(item).then((url) => {
            const image = el.querySelector('img')
            if (image && url) image.src = url
          })
        }
      },
      { root: modsEl, rootMargin: '150px' }
    )
    renderModels()
    renderMods()
    const total = models.reduce((n, m) => n + m.mods.length, 0)
    footEl.textContent = `模型库：${scan.root}　·　${models.length} 个模型 / ${total} 个 mod`
  }

  chooseBtn.addEventListener('click', async () => {
    const dir = await window.api.chooseModelLibrary()
    if (!dir) return
    await reload()
  })
  refreshBtn.addEventListener('click', () => void reload())

  async function open(): Promise<void> {
    overlay.style.display = 'flex'
    await reload()
  }

  return { open }
}
