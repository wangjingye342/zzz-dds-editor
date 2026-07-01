import type { LibraryItem } from '@shared/types'
import { thumbRgbaToDataURL } from './ddsDecode'
import { progress } from './progress'

const thumbProgress = progress.refcount('生成缩略图…')

/** 右侧「待插入贴图」素材库：缩略图、搜索、按使用频率排序、作为拖拽源 / 点击放置源 */
export class LibraryPanel {
  private items: LibraryItem[] = []
  private thumbCache = new Map<string, string>()
  private io: IntersectionObserver
  /** 点击某素材以进入「两次点击放置」模式 */
  onActivate?: (item: LibraryItem) => void
  /** 当前已激活（待放置）的素材路径，用于高亮 */
  private activePath: string | null = null

  constructor(
    private grid: HTMLElement,
    private search: HTMLInputElement
  ) {
    this.search.addEventListener('input', () => this.render())
    // 懒加载缩略图：滚动到可视区才解码；解码已转主进程小 mip + 小 RGBA，可并行
    this.io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue
          const el = en.target as HTMLElement
          this.io.unobserve(el)
          const item = this.items.find((i) => i.path === el.dataset.path)
          if (item) {
            void this.loadThumb(item).then((url) => {
              const img = el.querySelector('img')
              if (img && url) img.src = url
            })
          }
        }
      },
      { root: this.grid, rootMargin: '120px' }
    )
  }

  setItems(items: LibraryItem[]): void {
    this.items = items
    this.render()
  }

  /** 本地把某素材使用计数 +1 并重排（拖入后即时反馈，无需重扫文件夹） */
  bumpLocal(path: string): void {
    const it = this.items.find((i) => i.path === path)
    if (!it) return
    it.count += 1
    it.lastUsed = Date.now()
    this.items.sort(
      (a, b) => b.count - a.count || b.lastUsed - a.lastUsed || a.name.localeCompare(b.name)
    )
    this.render()
  }

  /** 高亮「待放置」的素材（null 清除）；只切类不重渲染，避免滚动位置丢失 */
  setActive(path: string | null): void {
    this.activePath = path
    for (const el of Array.from(this.grid.querySelectorAll<HTMLElement>('.lib-item'))) {
      el.classList.toggle('armed', el.dataset.path === path)
    }
  }
  clearActive(): void {
    this.setActive(null)
  }

  private filtered(): LibraryItem[] {
    const q = this.search.value.trim().toLowerCase()
    return q ? this.items.filter((i) => i.name.toLowerCase().includes(q)) : this.items
  }

  private render(): void {
    this.io.disconnect()
    this.grid.innerHTML = ''
    const list = this.filtered()
    if (list.length === 0) {
      const hint = document.createElement('div')
      hint.className = 'lib-hint'
      hint.textContent = this.items.length ? '无匹配素材' : '尚未选择素材文件夹'
      this.grid.appendChild(hint)
      return
    }
    for (const item of list) this.grid.appendChild(this.buildItem(item))
  }

  private buildItem(item: LibraryItem): HTMLElement {
    const div = document.createElement('div')
    div.className = 'lib-item'
    div.draggable = true
    div.title = `${item.name}\n使用 ${item.count} 次\n（拖到画布，或点击后在画布上两次点击放置）`
    div.dataset.path = item.path
    div.dataset.ext = item.ext
    if (item.path === this.activePath) div.classList.add('armed')

    // 方形预览框：图未解码出来前也由棋盘背景占位，保证整齐铺开、不塌陷堆叠
    const thumb = document.createElement('div')
    thumb.className = 'lib-thumb'
    const img = document.createElement('img')
    thumb.appendChild(img)
    if (item.count > 0) {
      const badge = document.createElement('span')
      badge.className = 'badge'
      badge.textContent = '×' + item.count
      thumb.appendChild(badge)
    }
    div.appendChild(thumb)

    const name = document.createElement('span')
    name.className = 'lib-name'
    name.textContent = item.name
    div.appendChild(name)

    div.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('application/x-zzz-asset', item.path)
      e.dataTransfer?.setData('text/plain', item.path)
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
    })
    // 点击（非拖拽）→ 进入两次点击放置模式
    div.addEventListener('click', () => this.onActivate?.(item))

    // 缓存命中直接用，否则交给 IntersectionObserver 懒加载
    const cached = this.thumbCache.get(item.path)
    if (cached) img.src = cached
    else this.io.observe(div)

    return div
  }

  private async loadThumb(item: LibraryItem): Promise<string> {
    const hit = this.thumbCache.get(item.path)
    if (hit) return hit
    thumbProgress.inc()
    try {
      let url: string
      if (item.ext === 'dds') {
        // 主进程只解码小 mip 并必要时下采样，IPC 只回 ~64KB 小 RGBA
        const thumb = await window.api.readDdsThumb(item.path, 128)
        url = thumbRgbaToDataURL(thumb)
      } else {
        const bytes = await window.api.readBinary(item.path)
        const mime = item.ext === 'jpg' ? 'image/jpeg' : `image/${item.ext}`
        url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }))
      }
      this.thumbCache.set(item.path, url)
      return url
    } catch {
      return ''
    } finally {
      thumbProgress.dec()
    }
  }
}
