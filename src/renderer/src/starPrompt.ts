// 启动求 Star 弹窗（见 index.html #star-overlay）。
// 每次启动时弹出，除非用户勾选「不再显示」或点过「去点 Star」（持久化在 settings.hideStarPrompt）。

const REPO_URL = 'https://github.com/wangjingye342/zzz-dds-editor'

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T

export function setupStarPrompt(): { maybeShow: (hidden: boolean) => void } {
  const overlay = $('star-overlay')
  const goBtn = $<HTMLButtonElement>('star-go')
  const laterBtn = $<HTMLButtonElement>('star-later')
  const xBtn = $<HTMLButtonElement>('star-x')
  const dontChk = $<HTMLInputElement>('star-dont-show')

  const isOpen = (): boolean => overlay.style.display !== 'none'
  const close = (): void => {
    // 关闭时若勾选了「不再显示」，持久化，之后不再打扰
    if (dontChk.checked) void window.api.updateSettings({ hideStarPrompt: true })
    overlay.style.display = 'none'
  }

  goBtn.addEventListener('click', () => {
    void window.api.openExternal(REPO_URL)
    // 已经引导去点 Star，视为已互动，之后不再弹出
    void window.api.updateSettings({ hideStarPrompt: true })
    overlay.style.display = 'none'
  })
  laterBtn.addEventListener('click', close)
  xBtn.addEventListener('click', close)
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close()
  })
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) close()
  })

  /** 启动时调用：hidden 为 true（用户已选择不再显示）则不弹 */
  function maybeShow(hidden: boolean): void {
    if (hidden) return
    overlay.style.display = 'flex'
  }

  return { maybeShow }
}
