import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { registerIpc } from './ipc'

/** 应用图标路径（打包后在 resources，开发期在 build/） */
function iconFile(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'app-icon.png')
    : join(process.cwd(), 'build', 'icon.png')
}

/**
 * 启动画面：主进程一就绪就立刻出现，覆盖「渲染进程加载 + 初始化」这段空白期，
 * 让用户知道「已经点开了、正在启动」。用内联 HTML（data URL）加载，瞬时显示、
 * 不依赖任何打包产物。等主窗口 ready-to-show 时销毁。
 */
function createSplash(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 340,
    height: 210,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    center: true,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    title: 'ZZZ DDS 贴图编辑器',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  splash.removeMenu()

  // 尝试嵌入真实应用图标；失败则用渐变占位块
  let logoHtml =
    '<div class="logo"><svg viewBox="0 0 24 24" width="30" height="30">' +
    '<path fill="#fff" d="M21 3H3a1 1 0 00-1 1v16a1 1 0 001 1h18a1 1 0 001-1V4a1 1 0 00-1-1zm-1 15l-5-5-3 3-2-2-4 4V5h14v13z"/>' +
    '<circle cx="8" cy="8.5" r="1.6" fill="#fff"/></svg></div>'
  try {
    const p = iconFile()
    if (existsSync(p)) {
      const b64 = readFileSync(p).toString('base64')
      logoHtml = `<img class="logo-img" src="data:image/png;base64,${b64}" alt="" />`
    }
  } catch {
    /* 用占位块 */
  }

  const html = `<!doctype html><html><head><meta charset="utf-8" />
<style>
  html,body{margin:0;height:100%;background:transparent;overflow:hidden;
    font-family:"Microsoft YaHei","Segoe UI",-apple-system,sans-serif;
    user-select:none;-webkit-user-select:none;cursor:default}
  .card{position:absolute;inset:0;border-radius:16px;
    background:linear-gradient(160deg,#26282d 0%,#1a1b1f 100%);
    border:1px solid #3a3d44;box-shadow:0 20px 60px rgba(0,0,0,.55);
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    gap:14px;-webkit-app-region:drag}
  .logo,.logo-img{width:58px;height:58px;border-radius:15px;box-shadow:0 8px 22px rgba(74,158,255,.35)}
  .logo{display:flex;align-items:center;justify-content:center;
    background:linear-gradient(145deg,#4a9eff,#2f6fbf);color:#fff}
  .logo-img{object-fit:cover}
  .title{font-size:16px;font-weight:700;color:#eef0f3;letter-spacing:.6px}
  .sub{font-size:12px;color:#9da0a6;margin-top:-6px}
  .bar{position:relative;width:220px;height:4px;border-radius:2px;
    background:rgba(255,255,255,.08);overflow:hidden}
  .bar::before{content:"";position:absolute;left:0;top:0;height:100%;width:38%;border-radius:2px;
    background:linear-gradient(90deg,transparent,#4a9eff 55%,#7cc0ff,transparent);
    animation:slide 1.15s cubic-bezier(.65,0,.35,1) infinite}
  @keyframes slide{0%{transform:translateX(-110%)}100%{transform:translateX(360%)}}
</style></head>
<body><div class="card">
  ${logoHtml}
  <div class="title">ZZZ DDS 贴图编辑器</div>
  <div class="sub">正在启动，请稍候…</div>
  <div class="bar"></div>
</div></body></html>`

  splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  splash.once('ready-to-show', () => splash.show())
  return splash
}

function createWindow(splash: BrowserWindow | null): void {
  const iconPath = iconFile()
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    backgroundColor: '#1e1f22',
    title: 'ZZZ DDS 贴图编辑器',
    icon: existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 主窗口首帧就绪：显示主窗口并销毁启动画面
  const reveal = (): void => {
    if (win.isDestroyed()) return
    win.show()
    win.focus()
    if (splash && !splash.isDestroyed()) splash.destroy()
  }
  win.on('ready-to-show', reveal)
  // 兜底：万一 ready-to-show 因异常未触发，最多 20s 后强制显示，避免卡在启动画面
  const failsafe = setTimeout(reveal, 20000)
  win.on('ready-to-show', () => clearTimeout(failsafe))
  win.on('closed', () => clearTimeout(failsafe))

  // 开发期诊断：把渲染进程崩溃/加载失败转发到主进程终端
  win.webContents.on('render-process-gone', (_e, d) => console.error('[renderer-gone]', d.reason))
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[did-fail-load]', code, desc)
    reveal() // 加载失败也别把用户永远留在启动画面
  })

  // 一次性自检：ZZZ_SELFTEST=1 时在真实渲染进程里跑通解码链（验证 Buffer polyfill + fabric 模块）
  if (process.env.ZZZ_SELFTEST) {
    win.webContents.on('did-finish-load', async () => {
      const testPath = join(process.cwd(), 'test-assets', 'test_bc3.dds')
      try {
        const result = await win.webContents.executeJavaScript(
          `(async () => {
            const out = { bufferType: typeof globalThis.Buffer }
            try {
              const dec = await import('/src/ddsDecode.ts')
              const bytes = await window.api.readBinary(${JSON.stringify(testPath)})
              const img = dec.decodeDds(bytes)
              out.decode = { w: img.width, h: img.height, len: img.rgba.length }
              const ed = await import('/src/editor.ts')
              out.editorClass = typeof ed.EditorCanvas
            } catch (e) { out.error = String((e && e.message) || e) }
            return out
          })()`
        )
        console.log('[SELFTEST]', JSON.stringify(result))
      } catch (e) {
        console.error('[SELFTEST] failed:', (e as Error).message)
      }
    })
  }

  // electron-vite 在 dev 模式注入 renderer 的开发服务器地址
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerIpc()
  const splash = createSplash()
  createWindow(splash)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(null)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
