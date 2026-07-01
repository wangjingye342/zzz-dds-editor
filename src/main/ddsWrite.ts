// 把「直通 alpha」的 RGBA 像素包成一个未压缩的 DX10 DDS（DXGI R8G8B8A8_UNORM_SRGB）。
// 用作 texconv 的输入：避免经过会预乘 alpha 的 PNG/canvas，从而忠实保留 RGB 与 alpha；
// 标记为 _SRGB 使 texconv 输出 *_SRGB 时不做多余 gamma 转换（不会变淡 / 变深）。

const DDS_MAGIC = 0x20534444 // "DDS "
const HEADER = 128
const DXT10 = 20

export function rawRgbaToSrgbDds(rgba: Uint8Array, width: number, height: number): Buffer {
  const buf = Buffer.alloc(HEADER + DXT10 + rgba.length)
  buf.writeUInt32LE(DDS_MAGIC, 0)
  buf.writeUInt32LE(124, 4) // dwSize
  // flags: CAPS|HEIGHT|WIDTH|PIXELFORMAT|PITCH
  buf.writeUInt32LE(0x1 | 0x2 | 0x4 | 0x1000 | 0x8, 8)
  buf.writeUInt32LE(height, 12)
  buf.writeUInt32LE(width, 16)
  buf.writeUInt32LE(width * 4, 20) // pitch
  buf.writeUInt32LE(0, 24) // depth
  buf.writeUInt32LE(1, 28) // mipCount
  // ddspf
  buf.writeUInt32LE(32, 76) // ddspf.dwSize
  buf.writeUInt32LE(0x4, 80) // DDPF_FOURCC
  buf.write('DX10', 84, 'ascii') // fourCC
  buf.writeUInt32LE(0x1000, 108) // caps = TEXTURE
  // DDS_HEADER_DXT10
  buf.writeUInt32LE(29, HEADER) // DXGI_FORMAT_R8G8B8A8_UNORM_SRGB
  buf.writeUInt32LE(3, HEADER + 4) // D3D11_RESOURCE_DIMENSION_TEXTURE2D
  buf.writeUInt32LE(0, HEADER + 8) // miscFlag
  buf.writeUInt32LE(1, HEADER + 12) // arraySize
  buf.writeUInt32LE(0, HEADER + 16) // miscFlags2
  Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength).copy(buf, HEADER + DXT10)
  return buf
}
