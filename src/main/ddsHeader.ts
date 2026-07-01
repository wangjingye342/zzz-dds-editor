import { promises as fs } from 'fs'
import type { DdsMeta } from '../shared/types'

const DDS_MAGIC = 0x20534444 // "DDS " (little-endian)
const DDPF_FOURCC = 0x4

// DXGI_FORMAT 数值 → texconv 可识别的格式名
const DXGI_TO_NAME: Record<number, string> = {
  28: 'R8G8B8A8_UNORM',
  29: 'R8G8B8A8_UNORM_SRGB',
  87: 'B8G8R8A8_UNORM',
  91: 'B8G8R8A8_UNORM_SRGB',
  71: 'BC1_UNORM',
  72: 'BC1_UNORM_SRGB',
  74: 'BC2_UNORM',
  75: 'BC2_UNORM_SRGB',
  77: 'BC3_UNORM',
  78: 'BC3_UNORM_SRGB',
  80: 'BC4_UNORM',
  81: 'BC4_SNORM',
  83: 'BC5_UNORM',
  84: 'BC5_SNORM',
  95: 'BC6H_UF16',
  96: 'BC6H_SF16',
  98: 'BC7_UNORM',
  99: 'BC7_UNORM_SRGB'
}

// legacy FourCC（无 DX10 扩展头时）→ 格式名
const FOURCC_TO_NAME: Record<string, string> = {
  DXT1: 'BC1_UNORM',
  DXT3: 'BC2_UNORM',
  DXT5: 'BC3_UNORM',
  ATI1: 'BC4_UNORM',
  BC4U: 'BC4_UNORM',
  ATI2: 'BC5_UNORM',
  BC5U: 'BC5_UNORM'
}

function readFourCC(view: DataView, offset: number): string {
  let s = ''
  for (let i = 0; i < 4; i++) {
    const c = view.getUint8(offset + i)
    if (c === 0) break
    s += String.fromCharCode(c)
  }
  return s
}

/**
 * 纯 JS 解析 DDS 文件头，提取导出时需要复用的格式/尺寸/mipmap 信息。
 * 头部布局参考 Microsoft DDS programming guide。
 */
export async function readDdsMeta(path: string): Promise<DdsMeta> {
  const buf = await fs.readFile(path)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

  if (view.getUint32(0, true) !== DDS_MAGIC) {
    throw new Error('不是有效的 DDS 文件（magic 不匹配）')
  }

  const height = view.getUint32(12, true)
  const width = view.getUint32(16, true)
  let mipCount = view.getUint32(28, true)
  if (mipCount === 0) mipCount = 1

  const pfFlags = view.getUint32(80, true)
  const fourCC = readFourCC(view, 84)

  let isDX10 = false
  let dxgiFormat: number | null = null
  let alphaMode: number | null = null
  let formatName = '未知'

  if (pfFlags & DDPF_FOURCC && fourCC === 'DX10') {
    isDX10 = true
    dxgiFormat = view.getUint32(128, true) // DDS_HEADER_DXT10.dxgiFormat
    alphaMode = view.getUint32(144, true) & 0x7 // miscFlags2 低 3 位
    formatName = DXGI_TO_NAME[dxgiFormat] || `DXGI_${dxgiFormat}`
  } else if (pfFlags & DDPF_FOURCC) {
    formatName = FOURCC_TO_NAME[fourCC] || fourCC || '未知'
  } else {
    formatName = 'R8G8B8A8_UNORM' // 未压缩，按 RGBA8 处理
  }

  const texconvFormat =
    (dxgiFormat != null ? DXGI_TO_NAME[dxgiFormat] : undefined) ||
    FOURCC_TO_NAME[fourCC] ||
    (formatName.startsWith('DXGI_') ? 'R8G8B8A8_UNORM' : formatName)

  return {
    width,
    height,
    mipCount,
    isDX10,
    dxgiFormat,
    fourCC: fourCC || null,
    formatName,
    texconvFormat,
    alphaMode
  }
}
