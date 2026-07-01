// 右下角进度提示：把长操作包成 progress.run(label, fn)，自动显示/隐藏；
// 缩略图这种并发零碎任务用 progress.refcount(label).inc()/dec()，按 label 聚合一条。

interface Token {
  label: string
  cur?: { done: number; total: number }
}

class Progress {
  private stack: Token[] = []
  private counters = new Map<string, { n: number; token: Token }>()
  private el: HTMLElement | null = null
  private labelEl: HTMLElement | null = null
  private fillEl: HTMLElement | null = null

  /** 在 DOM ready 后调用一次：定位三块 DOM */
  init(el: HTMLElement, labelEl: HTMLElement, fillEl: HTMLElement): void {
    this.el = el
    this.labelEl = labelEl
    this.fillEl = fillEl
    this.render()
  }

  private render(): void {
    if (!this.el || !this.labelEl || !this.fillEl) return
    if (this.stack.length === 0) {
      this.el.hidden = true
      this.fillEl.style.width = '0%'
      this.el.classList.remove('indeterminate')
      this.labelEl.textContent = ''
      return
    }
    const top = this.stack[this.stack.length - 1]
    this.el.hidden = false
    if (top.cur && top.cur.total > 0) {
      this.el.classList.remove('indeterminate')
      const pct = Math.min(100, Math.round((top.cur.done / top.cur.total) * 100))
      this.fillEl.style.width = pct + '%'
      this.labelEl.textContent = `${top.label} · ${top.cur.done}/${top.cur.total}`
    } else {
      this.el.classList.add('indeterminate')
      this.fillEl.style.width = '100%'
      this.labelEl.textContent = top.label
    }
  }

  /** 包一个一次性的不确定进度操作 */
  async run<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const t: Token = { label }
    this.stack.push(t)
    this.render()
    try {
      return await fn()
    } finally {
      const i = this.stack.lastIndexOf(t)
      if (i >= 0) this.stack.splice(i, 1)
      this.render()
    }
  }

  /** 定量批处理：返回 step()/done() 句柄，bar 显示 N/M 百分比 */
  batch(label: string, total: number): { step: (n?: number) => void; done: () => void; setLabel: (l: string) => void } {
    const t: Token = { label, cur: { done: 0, total } }
    this.stack.push(t)
    this.render()
    let closed = false
    return {
      step: (n = 1) => {
        if (closed || !t.cur) return
        t.cur.done = Math.min(t.cur.total, t.cur.done + n)
        this.render()
      },
      setLabel: (l: string) => {
        t.label = l
        this.render()
      },
      done: () => {
        if (closed) return
        closed = true
        const i = this.stack.lastIndexOf(t)
        if (i >= 0) this.stack.splice(i, 1)
        this.render()
      }
    }
  }

  /** 按 label 聚合的引用计数：N 个并发同名任务只显示一条「label (N)」 */
  refcount(label: string): { inc: () => void; dec: () => void } {
    return {
      inc: () => {
        let c = this.counters.get(label)
        if (!c) {
          const token: Token = { label }
          this.stack.push(token)
          c = { n: 0, token }
          this.counters.set(label, c)
        }
        c.n++
        c.token.label = c.n > 1 ? `${label} (${c.n})` : label
        this.render()
      },
      dec: () => {
        const c = this.counters.get(label)
        if (!c) return
        c.n--
        if (c.n <= 0) {
          const i = this.stack.lastIndexOf(c.token)
          if (i >= 0) this.stack.splice(i, 1)
          this.counters.delete(label)
        } else {
          c.token.label = c.n > 1 ? `${label} (${c.n})` : label
        }
        this.render()
      }
    }
  }
}

export const progress = new Progress()
