import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { registerIpc } from './ipc'

function createWindow(): void {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'app-icon.png')
    : join(process.cwd(), 'build', 'icon.png')
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
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

  win.on('ready-to-show', () => win.show())

  // 开发期诊断：把渲染进程崩溃/加载失败转发到主进程终端
  win.webContents.on('render-process-gone', (_e, d) => console.error('[renderer-gone]', d.reason))
  win.webContents.on('did-fail-load', (_e, code, desc) => console.error('[did-fail-load]', code, desc))

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
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
