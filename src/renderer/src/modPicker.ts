import type { DdsEntry, ModScan, RecentRecord } from '@shared/types'
import { thumbRgbaToDataURL } from './ddsDecode'
import { progress } from './progress'

const thumbProgress = progress.refcount('生成贴图缩略图…')

// 「选择要编辑的贴图」与「最近记录」共用一个模态层（见 index.html #modal-overlay）。
// 每个 picker 自管理事件监听并在结束时清理，返回一个在用户选定 / 取消时 resolve 的 Promise。

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T

function els() {
  return {
    overlay: $('modal-overlay'),
    title: $('picker-title'),
    search: $<HTMLInputElement>('picker-search'),
    body: $('picker-body'),
    foot: $('picker-foot'),
    close: $<HTMLButtonElement>('picker-close')
  }
}

function openModal(): void {
  els().overlay.style.display = 'flex'
}
function closeModal(): void {
  const { overlay, body, search } = els()
  overlay.style.display = 'none'
  body.innerHTML = ''
  search.value = ''
}

// 缩略图缓存 —— 解码已搬到主进程，IPC 只回小 RGBA，可并行；不再需要串行队列。
const thumbCache = new Map<string, string>()
async function loadThumb(path: string): Promise<string> {
  const hit = thumbCache.get(path)
  if (hit) return hit
  thumbProgress.inc()
  try {
    const thumb = await window.api.readDdsThumb(path, 128)
    const url = thumbRgbaToDataURL(thumb)
    thumbCache.set(path, url)
    return url
  } catch {
    return ''
  } finally {
    thumbProgress.dec()
  }
}

/** 把若干一次性监听挂上模态层，返回统一的清理函数 */
function wireModal(onClose: () => void): () => void {
  const { overlay, close } = els()
  const onCloseClick = (): void => onClose()
  const onOverlay = (e: MouseEvent): void => {
    if (e.target === overlay) onClose()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') onClose()
  }
  close.addEventListener('click', onCloseClick)
  overlay.addEventListener('mousedown', onOverlay)
  window.addEventListener('keydown', onKey)
  return () => {
    close.removeEventListener('click', onCloseClick)
    overlay.removeEventListener('mousedown', onOverlay)
    window.removeEventListener('keydown', onKey)
  }
}

/** 从 mod 扫描结果里挑一张 DDS 来编辑（缩略图懒加载，已有记录的打角标） */
export function showDdsPicker(
  scan: ModScan,
  workspaceDir: string | null
): Promise<DdsEntry | null> {
  const { title, search, body, foot } = els()
  title.textContent = `选择要编辑的贴图 — ${scan.name}（${scan.files.length} 张）`
  foot.textContent = workspaceDir
    ? `编辑记录将保存到：${workspaceDir}\\${scan.name}`
    : '尚未设置工作目录，请先点右上角「工作目录」'
  search.placeholder = '搜索贴图（名称 / 子目录）…'
  body.className = 'picker-body grid'

  return new Promise<DdsEntry | null>((resolve) => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue
          const el = en.target as HTMLElement
          io.unobserve(el)
          const path = el.dataset.path
          if (!path) continue
          void loadThumb(path).then((url) => {
            const img = el.querySelector('img')
            if (img && url) img.src = url
          })
        }
      },
      { root: body, rootMargin: '120px' }
    )

    let done = false
    const finish = (result: DdsEntry | null): void => {
      if (done) return
      done = true
      io.disconnect()
      search.removeEventListener('input', render)
      cleanupModal()
      closeModal()
      resolve(result)
    }
    const cleanupModal = wireModal(() => finish(null))

    function buildCard(item: DdsEntry): HTMLElement {
      const div = document.createElement('div')
      div.className = 'lib-item picker-item'
      div.title = `${item.rel}\n${(item.size / 1024).toFixed(0)} KB`
      div.dataset.path = item.path

      const thumb = document.createElement('div')
      thumb.className = 'lib-thumb'
      const img = document.createElement('img')
      thumb.appendChild(img)
      if (item.hasRecord) {
        const badge = document.createElement('span')
        badge.className = 'badge badge-record'
        badge.textContent = '已有记录'
        thumb.appendChild(badge)
      }
      div.appendChild(thumb)

      const name = document.createElement('span')
      name.className = 'lib-name'
      name.textContent = item.name
      div.appendChild(name)

      div.addEventListener('click', () => finish(item))

      const cached = thumbCache.get(item.path)
      if (cached) img.src = cached
      else io.observe(div)
      return div
    }

    function render(): void {
      io.disconnect()
      body.innerHTML = ''
      const q = search.value.trim().toLowerCase()
      const list = q ? scan.files.filter((f) => f.rel.toLowerCase().includes(q)) : scan.files
      if (list.length === 0) {
        const hint = document.createElement('div')
        hint.className = 'lib-hint'
        hint.textContent = scan.files.length ? '无匹配贴图' : '该 mod 文件夹里没有找到 DDS 文件'
        body.appendChild(hint)
        return
      }
      for (const item of list) body.appendChild(buildCard(item))
    }

    search.addEventListener('input', render)
    openModal()
    render()
  })
}

/** 从「最近记录」里挑一条继续编辑 */
export function showRecentPicker(recents: RecentRecord[]): Promise<RecentRecord | null> {
  const { title, search, body, foot } = els()
  title.textContent = '最近编辑记录'
  foot.textContent = ''
  search.placeholder = '搜索记录…'
  body.className = 'picker-body list'

  return new Promise<RecentRecord | null>((resolve) => {
    let done = false
    const finish = (result: RecentRecord | null): void => {
      if (done) return
      done = true
      search.removeEventListener('input', render)
      cleanupModal()
      closeModal()
      resolve(result)
    }
    const cleanupModal = wireModal(() => finish(null))

    function render(): void {
      body.innerHTML = ''
      const q = search.value.trim().toLowerCase()
      const list = q
        ? recents.filter((r) => `${r.modName} ${r.ddsName}`.toLowerCase().includes(q))
        : recents
      if (list.length === 0) {
        const hint = document.createElement('div')
        hint.className = 'lib-hint'
        hint.textContent = recents.length ? '无匹配记录' : '还没有任何编辑记录'
        body.appendChild(hint)
        return
      }
      for (const r of list) {
        const row = document.createElement('div')
        row.className = 'recent-row'
        const main = document.createElement('div')
        main.className = 'recent-main'
        const t = document.createElement('div')
        t.className = 'recent-title'
        t.textContent = `${r.modName} / ${r.ddsName}`
        const sub = document.createElement('div')
        sub.className = 'recent-sub'
        sub.textContent = r.ddsPath
        main.append(t, sub)
        row.appendChild(main)
        row.addEventListener('click', () => finish(r))
        body.appendChild(row)
      }
    }

    search.addEventListener('input', render)
    openModal()
    render()
  })
}
