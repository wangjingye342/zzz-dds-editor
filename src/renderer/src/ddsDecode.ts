// DDS 解码：用 dds-ktx-parser 把 DDS 字节解码成 RGBA，并转为可供 fabric 使用的 dataURL。
// 仅用于「预览/编辑显示」，跨平台纯 JS；最终导出的 DDS 编码走主进程的 texconv。
// 注意：dds-ktx-parser 内部依赖 Node Buffer（见 polyfill.ts 注入的全局 Buffer）。
import {
  parseDDSHeader,
  decodeImage,
  formatSizes,
  type ImageInfo,
  type LayerInfo
} from 'dds-ktx-parser'
import { Buffer } from 'buffer'

export interface DecodedImage {
  width: number
  height: number
  rgba: Uint8Array
}

/**
 * 有些工具（如 Pillow）写出的 DDS mipCount=0（表示仅主图），
 * 此时 parseDDSHeader 给出的 layers 为空，decodeImage 会因拿不到层而崩。
 * 这里在 layers 为空时按格式块大小补出第 0 层。
 */
function ensureLayer(buf: Buffer, info: ImageInfo): LayerInfo {
  if (info.layers[0]) return info.layers[0]
  const fz = formatSizes[info.format]
  if (!fz) throw new Error(`未知的 DDS 格式块尺寸：${info.format}`)
  const bx = Math.ceil(info.shape.width / fz.blockWidth)
  const by = Math.ceil(info.shape.height / fz.blockHeight)
  // fourCC=='DX10' 时头部多 20 字节扩展头（经典头 128，DX10 头 148）
  const isDX10 = buf[84] === 0x44 && buf[85] === 0x58 && buf[86] === 0x31 && buf[87] === 0x30
  return { offset: isDX10 ? 148 : 128, length: bx * by * fz.blockSize, shape: info.shape }
}

/** 解码 DDS 第 0 级 mip 为 RGBA 像素 */
export function decodeDds(bytes: Uint8Array): DecodedImage {
  const buf = Buffer.from(bytes)
  const info = parseDDSHeader(buf)
  if (!info) throw new Error('无法解析该 DDS（可能不是受支持的 BC1–BC7 格式）')
  const out = decodeImage(buf, info.format, ensureLayer(buf, info))
  const rgba =
    out instanceof Uint8Array
      ? new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
      : new Uint8Array(out as ArrayBufferLike)
  return { width: info.shape.width, height: info.shape.height, rgba }
}

/** RGBA 像素 → 一张同尺寸 canvas */
function rgbaToCanvas(img: DecodedImage): HTMLCanvasElement {
  const cvs = document.createElement('canvas')
  cvs.width = img.width
  cvs.height = img.height
  const clamped = new Uint8ClampedArray(
    img.rgba.buffer as ArrayBuffer,
    img.rgba.byteOffset,
    img.rgba.byteLength
  )
  cvs.getContext('2d')!.putImageData(new ImageData(clamped, img.width, img.height), 0, 0)
  return cvs
}

/** RGBA 像素 → canvas → PNG dataURL */
export function rgbaToDataURL(img: DecodedImage): string {
  return rgbaToCanvas(img).toDataURL('image/png')
}

/** 生成缩略图 dataURL（最长边不超过 maxSize） */
export function rgbaToThumb(img: DecodedImage, maxSize = 128): string {
  const scale = Math.min(1, maxSize / Math.max(img.width, img.height))
  const tw = Math.max(1, Math.round(img.width * scale))
  const th = Math.max(1, Math.round(img.height * scale))
  const src = rgbaToCanvas(img)
  const dst = document.createElement('canvas')
  dst.width = tw
  dst.height = th
  const dctx = dst.getContext('2d')!
  dctx.imageSmoothingQuality = 'high'
  dctx.drawImage(src, 0, 0, tw, th)
  return dst.toDataURL('image/png')
}

/** 主进程小 mip 解码后回传的小 RGBA → PNG dataURL（缩略图用，毫秒级） */
export function thumbRgbaToDataURL(img: { width: number; height: number; rgba: Uint8Array }): string {
  const cvs = document.createElement('canvas')
  cvs.width = img.width
  cvs.height = img.height
  const clamped = new Uint8ClampedArray(
    img.rgba.buffer as ArrayBuffer,
    img.rgba.byteOffset,
    img.rgba.byteLength
  )
  cvs.getContext('2d')!.putImageData(new ImageData(clamped, img.width, img.height), 0, 0)
  return cvs.toDataURL('image/png')
}

/** 便捷：直接把 DDS 字节解码为 PNG dataURL */
export function ddsToDataURL(bytes: Uint8Array): { dataURL: string; width: number; height: number } {
  const dec = decodeDds(bytes)
  return { dataURL: rgbaToDataURL(dec), width: dec.width, height: dec.height }
}

/**
 * 解码 DDS 并（必要时）降采样为预览 canvas，同时返回原始全分辨率尺寸。
 * 用于 8K 等超大底图：编辑时只用降采样预览（省内存、不卡），导出时再用全分辨率重合成。
 */
export function ddsToPreviewCanvas(
  bytes: Uint8Array,
  maxEdge = 4096
): { canvas: HTMLCanvasElement; fullW: number; fullH: number; previewW: number; previewH: number } {
  const dec = decodeDds(bytes)
  const src = rgbaToCanvas(dec)
  const scale = Math.min(1, maxEdge / Math.max(dec.width, dec.height))
  if (scale >= 1) {
    return {
      canvas: src,
      fullW: dec.width,
      fullH: dec.height,
      previewW: dec.width,
      previewH: dec.height
    }
  }
  const tw = Math.max(1, Math.round(dec.width * scale))
  const th = Math.max(1, Math.round(dec.height * scale))
  const dst = document.createElement('canvas')
  dst.width = tw
  dst.height = th
  const dctx = dst.getContext('2d')!
  dctx.imageSmoothingQuality = 'high'
  dctx.drawImage(src, 0, 0, tw, th)
  return { canvas: dst, fullW: dec.width, fullH: dec.height, previewW: tw, previewH: th }
}

/** 解码 DDS 为全分辨率 canvas（用于导出合成） */
export function ddsToFullCanvas(bytes: Uint8Array): {
  canvas: HTMLCanvasElement
  width: number
  height: number
} {
  const dec = decodeDds(bytes)
  return { canvas: rgbaToCanvas(dec), width: dec.width, height: dec.height }
}

/**
 * 导出专用：把底图解成「不透明 RGB 画布」+ 单独的原始 alpha 通道。
 * 画布强制 alpha=255 → canvas 预乘不会破坏 RGB（透明区也保留真实颜色）；
 * 原始 alpha 单独返回，导出时再贴回，从而忠实保留底图的 alpha 数据通道。
 */
export function ddsToOpaqueCanvasWithAlpha(bytes: Uint8Array): {
  canvas: HTMLCanvasElement
  alpha: Uint8Array
  width: number
  height: number
} {
  const dec = decodeDds(bytes)
  const n = dec.width * dec.height
  const alpha = new Uint8Array(n)
  const opaque = new Uint8ClampedArray(n * 4)
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    opaque[p] = dec.rgba[p]
    opaque[p + 1] = dec.rgba[p + 1]
    opaque[p + 2] = dec.rgba[p + 2]
    opaque[p + 3] = 255
    alpha[i] = dec.rgba[p + 3]
  }
  const cvs = document.createElement('canvas')
  cvs.width = dec.width
  cvs.height = dec.height
  cvs.getContext('2d')!.putImageData(new ImageData(opaque, dec.width, dec.height), 0, 0)
  return { canvas: cvs, alpha, width: dec.width, height: dec.height }
}
