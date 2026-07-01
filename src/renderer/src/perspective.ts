/**
 * 四角自由透视变形（Photoshop「自由变换-扭曲」式）。
 *
 * 纯数据驱动：一个图层的变形 = 四个角点坐标。渲染时用 homography
 * 把源图重采样到这四个角围成的四边形里，逐三角形仿射贴图近似真透视。
 *
 * 坐标约定：corners = [tl, tr, br, bl]，对应单位正方形
 *   p0=(0,0)左上  p1=(1,0)右上  p2=(1,1)右下  p3=(0,1)左下
 * u 向右增大、v 向下增大，与图像像素方向一致。
 */
export interface Pt {
  x: number
  y: number
}

/**
 * 单位正方形 (0,0)(1,0)(1,1)(0,1) → 任意四边形 q 的 homography 系数。
 * 返回 [a,b,c,d,e,f,g,h,1]，投影：x=(a·u+b·v+c)/(g·u+h·v+1)，y 同理。
 * 采用 Heckbert 闭式解，无需解线性方程组。
 */
export function squareToQuad(q: Pt[]): number[] {
  const [p0, p1, p2, p3] = q
  const dx1 = p1.x - p2.x
  const dx2 = p3.x - p2.x
  const dx3 = p0.x - p1.x + p2.x - p3.x
  const dy1 = p1.y - p2.y
  const dy2 = p3.y - p2.y
  const dy3 = p0.y - p1.y + p2.y - p3.y

  let a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    // 仿射退化（平行四边形）
    a = p1.x - p0.x
    b = p2.x - p1.x
    c = p0.x
    d = p1.y - p0.y
    e = p2.y - p1.y
    f = p0.y
    g = 0
    h = 0
  } else {
    const den = dx1 * dy2 - dx2 * dy1
    g = (dx3 * dy2 - dx2 * dy3) / den
    h = (dx1 * dy3 - dx3 * dy1) / den
    a = p1.x - p0.x + g * p1.x
    b = p3.x - p0.x + h * p3.x
    c = p0.x
    d = p1.y - p0.y + g * p1.y
    e = p3.y - p0.y + h * p3.y
    f = p0.y
  }
  return [a, b, c, d, e, f, g, h, 1]
}

/** 用 homography H 把单位坐标 (u,v) 投影到四边形内的点 */
export function projectUV(H: number[], u: number, v: number): Pt {
  const w = H[6] * u + H[7] * v + H[8]
  return { x: (H[0] * u + H[1] * v + H[2]) / w, y: (H[3] * u + H[4] * v + H[5]) / w }
}

/** 四个点的轴对齐包围盒 */
export function boundsOf(pts: Pt[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

/**
 * 把源三角 (s0,s1,s2) 的纹理仿射贴到目标三角 (d0,d1,d2)。
 * canvas transform(a,b,c,d,e,f)：x'=a·x+c·y+e, y'=b·x+d·y+f。
 */
function drawTriangle(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  s0: Pt,
  s1: Pt,
  s2: Pt,
  d0: Pt,
  d1: Pt,
  d2: Pt
): void {
  const x1 = s1.x - s0.x
  const x2 = s2.x - s0.x
  const y1 = s1.y - s0.y
  const y2 = s2.y - s0.y
  const det = x1 * y2 - x2 * y1
  if (Math.abs(det) < 1e-9) return

  const X1 = d1.x - d0.x
  const X2 = d2.x - d0.x
  const Y1 = d1.y - d0.y
  const Y2 = d2.y - d0.y
  const a = (X1 * y2 - X2 * y1) / det
  const c = (X2 * x1 - X1 * x2) / det
  const b = (Y1 * y2 - Y2 * y1) / det
  const d = (Y2 * x1 - Y1 * x2) / det
  const e = d0.x - a * s0.x - c * s0.y
  const f = d0.y - b * s0.x - d * s0.y

  ctx.save()
  ctx.beginPath()
  // 目标三角略向外扩 0.5px，遮住相邻三角间的抗锯齿缝隙
  expandTriangle(ctx, d0, d1, d2, 0.5)
  ctx.clip()
  ctx.transform(a, b, c, d, e, f)
  ctx.drawImage(img, 0, 0)
  ctx.restore()
}

/** 以三角形重心为中心，把三顶点向外推 grow 像素后描成裁剪路径 */
function expandTriangle(
  ctx: CanvasRenderingContext2D,
  d0: Pt,
  d1: Pt,
  d2: Pt,
  grow: number
): void {
  const cx = (d0.x + d1.x + d2.x) / 3
  const cy = (d0.y + d1.y + d2.y) / 3
  const push = (p: Pt): Pt => {
    const dx = p.x - cx
    const dy = p.y - cy
    const len = Math.hypot(dx, dy) || 1
    return { x: p.x + (dx / len) * grow, y: p.y + (dy / len) * grow }
  }
  const e0 = push(d0)
  const e1 = push(d1)
  const e2 = push(d2)
  ctx.moveTo(e0.x, e0.y)
  ctx.lineTo(e1.x, e1.y)
  ctx.lineTo(e2.x, e2.y)
  ctx.closePath()
}

/**
 * 把源图按四角透视渲染到一张新 canvas。
 * @param corners 四角目标坐标（输出 canvas 局部坐标系，调用方需保证已平移到非负区间）
 * @param subdiv  网格细分数，越大越接近真实透视（默认 24）
 */
export function renderPerspective(
  img: CanvasImageSource,
  srcW: number,
  srcH: number,
  corners: Pt[],
  subdiv = 24
): HTMLCanvasElement {
  const H = squareToQuad(corners)
  const b = boundsOf(corners)
  const out = document.createElement('canvas')
  out.width = Math.max(1, Math.ceil(b.maxX))
  out.height = Math.max(1, Math.ceil(b.maxY))
  const ctx = out.getContext('2d')!
  ctx.imageSmoothingEnabled = true

  const n = Math.max(1, Math.floor(subdiv))
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const u0 = i / n
      const u1 = (i + 1) / n
      const v0 = j / n
      const v1 = (j + 1) / n
      // 源四点（图像像素坐标）
      const s00 = { x: u0 * srcW, y: v0 * srcH }
      const s10 = { x: u1 * srcW, y: v0 * srcH }
      const s11 = { x: u1 * srcW, y: v1 * srcH }
      const s01 = { x: u0 * srcW, y: v1 * srcH }
      // 目标四点（透视投影）
      const d00 = projectUV(H, u0, v0)
      const d10 = projectUV(H, u1, v0)
      const d11 = projectUV(H, u1, v1)
      const d01 = projectUV(H, u0, v1)
      drawTriangle(ctx, img, s00, s10, s11, d00, d10, d11)
      drawTriangle(ctx, img, s00, s11, s01, d00, d11, d01)
    }
  }
  return out
}
