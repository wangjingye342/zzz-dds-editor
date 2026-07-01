import { promises as fs } from 'fs'
import { parseDDSHeader, decodeImage, formatSizes, type ImageInfo } from 'dds-ktx-parser'

// 用于「素材库 / 选贴图」面板缩略图：只解码一张 mip，不再把整张 DDS 走 IPC + 解码 mip0。
// 思路：DDS 一般自带 mipmap，128² 那一级直接就是缩略图大小，BC7 解码就是几十微秒。
// 没有 mip 链时回退到 mip0 + 最近邻下采样。

export interface DdsThumb {
  width: number
  height: number
  rgba: Uint8Array
}

function readMipCountAndDX10(buf: Buffer): { mipCount: number; isDX10: boolean } {
  const mipCount = Math.max(1, buf.readUInt32LE(28))
  const isDX10 = buf[84] === 0x44 && buf[85] === 0x58 && buf[86] === 0x31 && buf[87] === 0x30
  return { mipCount, isDX10 }
}

/** 按经典 + DX10 头自行推算指定 mip 的 (offset,length,dims)，绕过解析器 layers 不完整的情况 */
function deriveLayer(
  info: ImageInfo,
  isDX10: boolean,
  mipIndex: number
): { offset: number; length: number; shape: { width: number; height: number } } {
  const fz = formatSizes[info.format]
  if (!fz) throw new Error(`未知的 DDS 格式块尺寸：${info.format}`)
  const w0 = info.shape.width
  const h0 = info.shape.height
  let off = isDX10 ? 148 : 128
  for (let i = 0; i < mipIndex; i++) {
    const wi = Math.max(1, w0 >> i)
    const hi = Math.max(1, h0 >> i)
    off += Math.ceil(wi / fz.blockWidth) * Math.ceil(hi / fz.blockHeight) * fz.blockSize
  }
  const w = Math.max(1, w0 >> mipIndex)
  const h = Math.max(1, h0 >> mipIndex)
  const length = Math.ceil(w / fz.blockWidth) * Math.ceil(h / fz.blockHeight) * fz.blockSize
  return { offset: off, length, shape: { width: w, height: h } }
}

/** 选「最小的边仍 >= maxEdge」的最大 mip 索引（=尺寸最接近 maxEdge 但不小于它的那级） */
function pickMipIndex(w0: number, h0: number, mipCount: number, maxEdge: number): number {
  let pick = 0
  for (let i = 0; i < mipCount; i++) {
    const w = Math.max(1, w0 >> i)
    const h = Math.max(1, h0 >> i)
    if (Math.min(w, h) >= maxEdge) pick = i
    else break
  }
  return pick
}

/** 简易最近邻下采样：缩略图够用，CPU 极快（无 mip 链时兜底） */
function downsampleNearest(
  src: Uint8Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number
): Uint8Array {
  const dst = new Uint8Array(dw * dh * 4)
  const fx = sw / dw
  const fy = sh / dh
  for (let y = 0; y < dh; y++) {
    const sy = Math.floor(y * fy)
    for (let x = 0; x < dw; x++) {
      const sx = Math.floor(x * fx)
      const si = (sy * sw + sx) * 4
      const di = (y * dw + x) * 4
      dst[di] = src[si]
      dst[di + 1] = src[si + 1]
      dst[di + 2] = src[si + 2]
      dst[di + 3] = src[si + 3]
    }
  }
  return dst
}

export async function readDdsThumb(path: string, maxEdge = 128): Promise<DdsThumb> {
  const buf = await fs.readFile(path)
  const info = parseDDSHeader(buf)
  if (!info) throw new Error('无法解析该 DDS')
  const { mipCount, isDX10 } = readMipCountAndDX10(buf)
  const mipIndex = pickMipIndex(info.shape.width, info.shape.height, mipCount, maxEdge)
  const layer = deriveLayer(info, isDX10, mipIndex)
  const decoded = decodeImage(buf, info.format, layer)
  const src =
    decoded instanceof Uint8Array
      ? new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength)
      : new Uint8Array(decoded as ArrayBufferLike)

  let w = layer.shape.width
  let h = layer.shape.height
  let rgba = src
  // 没 mip 链 / mip 选下来仍远大于 maxEdge → 在主进程做一次廉价下采样，IPC 只回小图
  const longest = Math.max(w, h)
  if (longest > maxEdge * 2) {
    const scale = maxEdge / longest
    const dw = Math.max(1, Math.round(w * scale))
    const dh = Math.max(1, Math.round(h * scale))
    rgba = downsampleNearest(src, w, h, dw, dh)
    w = dw
    h = dh
  }
  return { width: w, height: h, rgba }
}
