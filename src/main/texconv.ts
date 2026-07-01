import { spawn } from 'child_process'
import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'

/** 定位捆绑的 texconv.exe（打包后在 resources/texconv，dev 在项目 resources/texconv） */
export function locateTexconv(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'texconv', 'texconv.exe')]
    : [
        join(app.getAppPath(), 'resources', 'texconv', 'texconv.exe'),
        join(process.cwd(), 'resources', 'texconv', 'texconv.exe')
      ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

export interface TexconvOptions {
  /** DXGI 格式名，如 BC7_UNORM */
  format: string
  mipCount: number
  outDir: string
  /** 强制写 DX10 扩展头（BC7 等需要） */
  dx10?: boolean
  /** 关闭 GPU 编码，使用软件编码器 */
  nogpu?: boolean
}

export interface TexconvResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * 调用 texconv 把 PNG 编码成指定格式的 DDS。
 * 输出文件为 outDir/<input basename>.dds。
 */
export function runTexconv(inputPng: string, opts: TexconvOptions): Promise<TexconvResult> {
  const exe = locateTexconv()
  if (!exe) return Promise.reject(new Error('未找到 texconv.exe'))

  const args = ['-nologo', '-y', '-f', opts.format, '-m', String(opts.mipCount), '-o', opts.outDir]
  if (opts.dx10) args.push('-dx10')
  if ((opts.format.startsWith('BC7') || opts.format.startsWith('BC6')) && opts.nogpu) {
    args.push('-nogpu')
  }
  args.push(inputPng)

  return new Promise<TexconvResult>((resolve, reject) => {
    const p = spawn(exe, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => (stdout += d.toString()))
    p.stderr.on('data', (d) => (stderr += d.toString()))
    p.on('error', reject)
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}
