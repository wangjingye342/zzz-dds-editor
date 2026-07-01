import { Canvas, FabricImage, FabricObject, Circle, Point, Control, type TMat2D } from 'fabric'
import { renderPerspective, boundsOf, type Pt } from './perspective'
import type { LayerData, LayerSource } from '@shared/types'

/** 图层附带的业务元数据，挂在 fabric 对象的 zzz 字段上 */
export interface ZzzLayerMeta {
  id: string
  name: string
  kind: 'base' | 'overlay' | 'ctrl'
  /** overlay 来源文件路径（用于工程序列化重建） */
  sourcePath?: string
  /** 已提交的透视变形数据（用于工程序列化 / 再次编辑参考） */
  persp?: { corners: Pt[]; origDataURL: string; origW: number; origH: number }
}

function newId(): string {
  return 'l_' + (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2, 10))
}

function metaOf(obj: FabricObject): ZzzLayerMeta | undefined {
  return (obj as unknown as { zzz?: ZzzLayerMeta }).zzz
}

/** 透视编辑态的内部快照 */
interface PerspMode {
  obj: FabricImage
  srcCanvas: HTMLCanvasElement
  srcW: number
  srcH: number
  corners: Pt[]
  controls: FabricObject[]
  snapEl: HTMLImageElement | HTMLCanvasElement
  geom: {
    left: number
    top: number
    scaleX: number
    scaleY: number
    angle: number
    originX: string
    originY: string
    flipX: boolean
    flipY: boolean
  }
}

/** 两次点击放置态：第一次点击定中心，移动鼠标=右下角（定大小+角度），再点击固定 */
interface PlacementMode {
  img: FabricImage
  name: string
  sourcePath?: string
  /** 第一次点击的中心点（场景坐标）；null 表示还没点中心 */
  center: Pt | null
  /** 预览图是否已加入画布 */
  added: boolean
}

interface ScaleRotateStart {
  center: Point
  distance: number
  pointerAngle: number
  scaleX: number
  scaleY: number
  angle: number
}

/** 封装 fabric.Canvas：底图、叠加图层、坐标换算、合并导出 */
export class EditorCanvas {
  canvas: Canvas
  ddsW = 1024
  ddsH = 1024
  /** 当前缩放（场景像素 → 屏幕像素），可由滚轮/按钮放大缩小 */
  zoom = 1
  /** 适应窗口时的基准缩放，用作缩小下限参考 */
  fitZoom = 1
  onSelectionChange?: (obj: FabricObject | null) => void
  onLayersChange?: () => void
  onPerspChange?: (active: boolean) => void
  /** 视图缩放/平移变化（用于刷新缩放百分比显示） */
  onViewChange?: () => void
  /** 放置态变化：'idle' | 'center'（待点中心）| 'preview'（待点固定） */
  onPlacementStateChange?: (state: 'idle' | 'center' | 'preview') => void
  /** 放置完成（已成为正式图层） */
  onPlacementCommit?: (obj: FabricObject) => void
  /** 底图原始全分辨率（编辑用降采样预览，导出/重开用全分辨率重解码） */
  baseFullW = 0
  baseFullH = 0
  /** 底图来源 DDS 路径，用于导出/重开时重新取全分辨率像素 */
  basePath: string | null = null
  private perspMode: PerspMode | null = null
  private placement: PlacementMode | null = null
  private scaleRotateStarts = new WeakMap<FabricObject, ScaleRotateStart>()
  // 平移态
  private spaceDown = false
  private panning = false
  private panLast = { x: 0, y: 0 }

  constructor(el: HTMLCanvasElement) {
    this.canvas = new Canvas(el, {
      backgroundColor: 'transparent',
      preserveObjectStacking: true,
      selection: true,
      uniformScaling: false,
      // 让中键/右键也触发 mouse:down（默认 false），并屏蔽右键菜单——右键用于抓取平移
      fireMiddleClick: true,
      fireRightClick: true,
      stopContextMenu: true
    })
    this.canvas.on('selection:created', () => this.emitSel())
    this.canvas.on('selection:updated', () => this.emitSel())
    this.canvas.on('selection:cleared', () => this.emitSel())
    this.canvas.on('object:modified', () => this.onLayersChange?.())
    // 滚轮缩放到光标、中键/空格拖拽平移、两次点击放置
    this.canvas.on('mouse:wheel', (opt) => this.onWheel(opt))
    this.canvas.on('mouse:down', (opt) => this.onMouseDown(opt))
    this.canvas.on('mouse:move', (opt) => this.onMouseMove(opt))
    this.canvas.on('mouse:up', () => this.onMouseUp())
    // 画布区域禁用浏览器右键菜单：右键我们用作「抓取平移」
    ;(this.canvas as unknown as { wrapperEl?: HTMLElement }).wrapperEl?.addEventListener(
      'contextmenu',
      (e) => e.preventDefault()
    )
    window.addEventListener('keydown', (e) => this.onSpaceDown(e))
    window.addEventListener('keyup', (e) => this.onSpaceUp(e))
  }

  private emitSel(): void {
    this.onSelectionChange?.(this.canvas.getActiveObject() ?? null)
  }

  reset(): void {
    this.perspMode = null
    this.placement = null
    this.panning = false
    this.spaceDown = false
    this.basePath = null
    this.baseFullW = 0
    this.baseFullH = 0
    this.canvas.selection = true
    this.canvas.skipTargetFind = false
    this.canvas.defaultCursor = 'default'
    this.canvas.clear()
    this.canvas.backgroundColor = 'transparent'
  }

  setBaseSize(w: number, h: number): void {
    this.ddsW = w
    this.ddsH = h
  }

  private clampZoom(z: number): number {
    const min = Math.min(0.05, this.fitZoom)
    return Math.max(min, Math.min(40, z))
  }

  /**
   * 适应窗口：画布元素铺满容器，用 viewportTransform 把场景按比例居中。
   * 之后可用滚轮/按钮在此基础上自由放大缩小、平移查看局部。
   */
  fit(hostW: number, hostH: number): void {
    this.canvas.setDimensions({ width: Math.max(1, hostW), height: Math.max(1, hostH) })
    const pad = 24
    const z = Math.min((hostW - pad) / this.ddsW, (hostH - pad) / this.ddsH)
    this.fitZoom = z > 0 && isFinite(z) ? z : 1
    this.zoom = this.fitZoom
    const tx = (hostW - this.ddsW * this.zoom) / 2
    const ty = (hostH - this.ddsH * this.zoom) / 2
    this.canvas.setViewportTransform([this.zoom, 0, 0, this.zoom, tx, ty] as TMat2D)
    this.onViewChange?.()
    this.canvas.requestRenderAll()
  }

  /** 容器尺寸变化：只改可视区大小，保留当前缩放/平移 */
  resize(hostW: number, hostH: number): void {
    this.canvas.setDimensions({ width: Math.max(1, hostW), height: Math.max(1, hostH) })
    this.canvas.requestRenderAll()
  }

  /** 围绕画布中心按倍率缩放 */
  zoomByCenter(factor: number): void {
    if (this.perspMode) return
    const c = new Point(this.canvas.getWidth() / 2, this.canvas.getHeight() / 2)
    const z = this.clampZoom(this.zoom * factor)
    this.canvas.zoomToPoint(c, z)
    this.zoom = z
    this.onViewChange?.()
    this.canvas.requestRenderAll()
  }

  /** 1:1 实际像素 */
  zoomToActual(): void {
    if (this.perspMode) return
    const c = new Point(this.canvas.getWidth() / 2, this.canvas.getHeight() / 2)
    this.canvas.zoomToPoint(c, 1)
    this.zoom = 1
    this.onViewChange?.()
    this.canvas.requestRenderAll()
  }

  // ---------- 滚轮缩放 / 拖拽平移 ----------
  private onWheel(opt: { e: Event }): void {
    if (this.perspMode) return
    const e = opt.e as WheelEvent
    e.preventDefault()
    e.stopPropagation()
    const p = this.canvas.getViewportPoint(e)
    const z = this.clampZoom(this.zoom * (e.deltaY > 0 ? 0.9 : 1.1))
    this.canvas.zoomToPoint(new Point(p.x, p.y), z)
    this.zoom = z
    this.onViewChange?.()
    this.canvas.requestRenderAll()
  }

  private onSpaceDown(e: KeyboardEvent): void {
    if (e.code !== 'Space') return
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
    if (this.perspMode || this.placement) return
    e.preventDefault()
    if (this.spaceDown) return
    this.spaceDown = true
    this.canvas.defaultCursor = 'grab'
    this.canvas.selection = false
    this.canvas.skipTargetFind = true
  }
  private onSpaceUp(e: KeyboardEvent): void {
    if (e.code !== 'Space') return
    this.spaceDown = false
    if (!this.panning) {
      this.canvas.defaultCursor = 'default'
      this.canvas.selection = true
      this.canvas.skipTargetFind = false
    }
  }

  /**
   * 设置底图。el 是（可能已降采样的）预览像素，fullW/fullH 为原始全分辨率尺寸。
   * 画布逻辑坐标系采用原始全分辨率：底图按 fullW/previewW 放大铺满 0..fullW，
   * 于是所有图层变换都与分辨率无关，导出时只需把底图换回全分辨率即可精确重合成。
   */
  setBaseImage(
    el: HTMLCanvasElement | HTMLImageElement,
    fullW: number,
    fullH: number,
    basePath?: string
  ): FabricImage {
    this.setBaseSize(fullW, fullH)
    this.baseFullW = fullW
    this.baseFullH = fullH
    this.basePath = basePath ?? null
    const previewW = (el as HTMLCanvasElement).width || (el as HTMLImageElement).naturalWidth || fullW
    const previewH =
      (el as HTMLCanvasElement).height || (el as HTMLImageElement).naturalHeight || fullH
    const img = new FabricImage(el)
    img.set({
      left: 0,
      top: 0,
      originX: 'left',
      originY: 'top',
      scaleX: fullW / previewW,
      scaleY: fullH / previewH,
      selectable: false,
      evented: false
    })
    ;(img as unknown as { zzz: ZzzLayerMeta }).zzz = { id: 'base', name: '原贴图', kind: 'base' }
    this.canvas.add(img)
    this.canvas.sendObjectToBack(img)
    this.canvas.requestRenderAll()
    this.onLayersChange?.()
    return img
  }

  /** 在场景坐标 (sceneX, sceneY) 处添加一个叠加图层，居中放置 */
  async addOverlay(
    dataURL: string,
    sceneX: number,
    sceneY: number,
    name: string,
    sourcePath?: string,
    mirror = false
  ): Promise<FabricImage> {
    const img = await FabricImage.fromURL(dataURL)
    img.set({ left: sceneX, top: sceneY, originX: 'center', originY: 'center', flipX: mirror })
    const maxDim = Math.min(this.ddsW, this.ddsH) * 0.5
    const longest = Math.max(img.width ?? 1, img.height ?? 1)
    if (longest > maxDim) img.scale(maxDim / longest)
    ;(img as unknown as { zzz: ZzzLayerMeta }).zzz = {
      id: newId(),
      name,
      kind: 'overlay',
      sourcePath
    }
    this.installScaleRotateControls(img)
    this.canvas.add(img)
    this.canvas.setActiveObject(img)
    this.canvas.requestRenderAll()
    this.onLayersChange?.()
    return img
  }

  /** 屏幕(client)坐标 → 画布场景坐标（考虑缩放与平移） */
  screenToScene(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getElement().getBoundingClientRect()
    const vt = this.canvas.viewportTransform
    return { x: (clientX - rect.left - vt[4]) / vt[0], y: (clientY - rect.top - vt[5]) / vt[3] }
  }

  // ---------- 鼠标按下/移动/抬起：平移 + 两次点击放置 ----------
  private onMouseDown(opt: { e: Event; target?: FabricObject }): void {
    const e = opt.e as MouseEvent
    if (e.button === 2 && !this.placement) {
      const active = this.canvas.getActiveObject()
      if (active && opt.target === active && metaOf(active)?.kind === 'overlay') {
        this.canvas.discardActiveObject()
        this.emitSel()
        this.canvas.requestRenderAll()
        e.preventDefault()
        e.stopPropagation()
        return
      }
    }

    // 平移：中键、空格+左键，或右键（包括放置新贴图但还未固定时）
    const rightPan = e.button === 2
    if (e.button === 1 || (this.spaceDown && e.button === 0) || rightPan) {
      this.panning = true
      this.panLast = { x: e.clientX, y: e.clientY }
      this.canvas.selection = false
      this.canvas.skipTargetFind = true
      this.canvas.setCursor('grabbing')
      e.preventDefault()
      return
    }
    // 放置：左键。第一次点 = 中心；第二次点 = 固定
    if (this.placement && e.button === 0) {
      const pt = this.canvas.getScenePoint(e)
      if (!this.placement.center) {
        this.placement.center = { x: pt.x, y: pt.y }
        if (!this.placement.added) {
          this.canvas.add(this.placement.img)
          this.placement.added = true
        }
        this.placement.img.visible = true
        this.updatePlacementPreview(pt)
        this.onPlacementStateChange?.('preview')
      } else {
        this.commitPlacement()
      }
    }
  }

  private onMouseMove(opt: { e: Event }): void {
    const e = opt.e as MouseEvent
    if (this.panning) {
      this.canvas.relativePan(new Point(e.clientX - this.panLast.x, e.clientY - this.panLast.y))
      this.panLast = { x: e.clientX, y: e.clientY }
      this.onViewChange?.()
      return
    }
    if (this.placement && this.placement.center) {
      this.updatePlacementPreview(this.canvas.getScenePoint(e))
    }
  }

  private onMouseUp(): void {
    if (!this.panning) return
    this.panning = false
    const cur = this.spaceDown ? 'grab' : this.placement ? 'crosshair' : 'default'
    this.canvas.defaultCursor = cur
    this.canvas.setCursor(cur)
    if (!this.spaceDown && !this.placement) {
      this.canvas.selection = true
      this.canvas.skipTargetFind = false
    }
  }

  // ---------- 两次点击放置：中心点 + 右下角 → 大小与角度 ----------
  isPlacing(): boolean {
    return this.placement !== null
  }

  /** 选好素材后进入放置态：等待在背景上点第一下定中心 */
  async beginPlacement(
    dataURL: string,
    name: string,
    sourcePath?: string,
    mirror = false
  ): Promise<void> {
    if (this.perspMode) return
    this.cancelPlacement()
    const img = await FabricImage.fromURL(dataURL)
    img.set({
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false,
      opacity: 0.85,
      visible: false,
      flipX: mirror
    })
    this.placement = { img, name, sourcePath, center: null, added: false }
    this.canvas.discardActiveObject()
    this.canvas.selection = false
    this.canvas.skipTargetFind = true
    this.canvas.defaultCursor = 'crosshair'
    this.canvas.requestRenderAll()
    this.onPlacementStateChange?.('center')
  }

  /** 取消放置（Esc / 切换素材） */
  cancelPlacement(): void {
    const pm = this.placement
    if (!pm) return
    if (pm.added) this.canvas.remove(pm.img)
    this.placement = null
    this.canvas.selection = true
    this.canvas.skipTargetFind = false
    this.canvas.defaultCursor = 'default'
    this.canvas.requestRenderAll()
    this.onPlacementStateChange?.('idle')
  }

  /** 以中心点固定、右下角对准 corner（场景坐标）更新预览的大小与角度 */
  private updatePlacementPreview(corner: Pt): void {
    const pm = this.placement
    if (!pm || !pm.center) return
    const img = pm.img
    const w = img.width || 1
    const h = img.height || 1
    const dx = corner.x - pm.center.x
    const dy = corner.y - pm.center.y
    const halfDiag = 0.5 * Math.hypot(w, h)
    const s = Math.hypot(dx, dy) / halfDiag
    const angle = ((Math.atan2(dy, dx) - Math.atan2(h, w)) * 180) / Math.PI
    img.set({
      left: pm.center.x,
      top: pm.center.y,
      originX: 'center',
      originY: 'center',
      scaleX: s || 0.001,
      scaleY: s || 0.001,
      angle
    })
    img.setCoords()
    this.canvas.requestRenderAll()
  }

  /** 固定放置：把预览图转为正式可编辑的叠加图层 */
  private commitPlacement(): void {
    const pm = this.placement
    if (!pm) return
    pm.img.set({ selectable: true, evented: true, opacity: 1 })
    ;(pm.img as unknown as { zzz: ZzzLayerMeta }).zzz = {
      id: newId(),
      name: pm.name,
      kind: 'overlay',
      sourcePath: pm.sourcePath
    }
    this.installScaleRotateControls(pm.img)
    this.placement = null
    this.canvas.selection = true
    this.canvas.skipTargetFind = false
    this.canvas.defaultCursor = 'default'
    this.canvas.setActiveObject(pm.img)
    this.canvas.requestRenderAll()
    this.onPlacementStateChange?.('idle')
    this.onLayersChange?.()
    this.onPlacementCommit?.(pm.img)
  }

  /** 按绘制顺序返回所有图层（底层在前，排除透视控制点） */
  layers(): FabricObject[] {
    return this.canvas.getObjects().filter((o) => {
      const k = metaOf(o)?.kind
      return k === 'base' || k === 'overlay'
    })
  }

  metaOf = metaOf

  setActive(obj: FabricObject): void {
    this.canvas.setActiveObject(obj)
    this.canvas.requestRenderAll()
    // 程序化选中不会触发 fabric 的 selection 事件，手动回流以更新面板高亮
    this.onSelectionChange?.(obj)
  }

  private installScaleRotateControls(obj: FabricObject): void {
    const makeCorner = (x: number, y: number): Control =>
      new Control({
        x,
        y,
        cursorStyle: 'crosshair',
        actionName: 'scale-rotate',
        mouseDownHandler: (
          _eventData: unknown,
          transform: { target: FabricObject },
          px: number,
          py: number
        ) => {
          const target = transform.target
          const center = target.getCenterPoint()
          const dx = px - center.x
          const dy = py - center.y
          this.scaleRotateStarts.set(target, {
            center,
            distance: Math.max(1, Math.hypot(dx, dy)),
            pointerAngle: Math.atan2(dy, dx),
            scaleX: target.scaleX || 1,
            scaleY: target.scaleY || 1,
            angle: target.angle || 0
          })
          return false
        },
        actionHandler: (
          _eventData: unknown,
          transform: { target: FabricObject },
          px: number,
          py: number
        ) => {
          const target = transform.target
          let start = this.scaleRotateStarts.get(target)
          if (!start) {
            const center = target.getCenterPoint()
            const dx = px - center.x
            const dy = py - center.y
            start = {
              center,
              distance: Math.max(1, Math.hypot(dx, dy)),
              pointerAngle: Math.atan2(dy, dx),
              scaleX: target.scaleX || 1,
              scaleY: target.scaleY || 1,
              angle: target.angle || 0
            }
            this.scaleRotateStarts.set(target, start)
          }
          const dx = px - start.center.x
          const dy = py - start.center.y
          const factor = Math.max(0.01, Math.hypot(dx, dy) / start.distance)
          const angleDelta = ((Math.atan2(dy, dx) - start.pointerAngle) * 180) / Math.PI
          target.set({
            scaleX: start.scaleX * factor,
            scaleY: start.scaleY * factor,
            angle: start.angle + angleDelta
          })
          target.setPositionByOrigin(start.center, 'center', 'center')
          target.setCoords()
          this.canvas.requestRenderAll()
          return true
        },
        mouseUpHandler: (_eventData: unknown, transform: { target: FabricObject }) => {
          this.scaleRotateStarts.delete(transform.target)
          return false
        }
      })
    obj.controls = {
      ...obj.controls,
      tl: makeCorner(-0.5, -0.5),
      tr: makeCorner(0.5, -0.5),
      bl: makeCorner(-0.5, 0.5),
      br: makeCorner(0.5, 0.5)
    }
  }

  removeObject(obj: FabricObject): void {
    if (this.canvas.getActiveObject() === obj) this.canvas.discardActiveObject()
    this.canvas.remove(obj)
    this.canvas.requestRenderAll()
    this.onLayersChange?.()
  }

  /** 删除所有叠加图层（保留底图），用于「完全恢复最开始状态」 */
  removeAllOverlays(): void {
    if (this.perspMode) this.cancelPlacement()
    this.canvas.discardActiveObject()
    this.layers()
      .filter((o) => metaOf(o)?.kind === 'overlay')
      .forEach((o) => this.canvas.remove(o))
    this.canvas.requestRenderAll()
    this.onLayersChange?.()
  }

  raise(obj: FabricObject): void {
    this.canvas.bringObjectForward(obj)
    this.canvas.requestRenderAll()
    this.onLayersChange?.()
  }

  lower(obj: FabricObject): void {
    // 不要把图层降到 base 之下
    this.canvas.sendObjectBackwards(obj)
    const objs = this.canvas.getObjects()
    const baseIdx = objs.findIndex((o) => metaOf(o)?.kind === 'base')
    const objIdx = objs.indexOf(obj)
    if (baseIdx >= 0 && objIdx <= baseIdx) {
      this.canvas.bringObjectForward(obj)
    }
    this.canvas.requestRenderAll()
    this.onLayersChange?.()
  }

  setOpacity(obj: FabricObject, v: number): void {
    obj.set('opacity', v)
    this.canvas.requestRenderAll()
  }

  setVisible(obj: FabricObject, v: boolean): void {
    obj.set('visible', v)
    this.canvas.requestRenderAll()
  }

  // ---------- 四角自由透视变形 ----------

  isPerspActive(): boolean {
    return this.perspMode !== null
  }

  /** 对某叠加图层进入透视编辑态：以其当前像素为源，四角可自由拖拽 */
  enterPerspective(obj: FabricObject): void {
    if (!(obj instanceof FabricImage)) return
    if (this.perspMode) this.applyPerspective()

    const el = obj.getElement() as HTMLImageElement | HTMLCanvasElement
    const srcW = (el as HTMLImageElement).naturalWidth || el.width
    const srcH = (el as HTMLImageElement).naturalHeight || el.height
    const srcCanvas = document.createElement('canvas')
    srcCanvas.width = Math.max(1, srcW)
    srcCanvas.height = Math.max(1, srcH)
    srcCanvas.getContext('2d')!.drawImage(el, 0, 0, srcCanvas.width, srcCanvas.height)

    const geom = {
      left: obj.left ?? 0,
      top: obj.top ?? 0,
      scaleX: obj.scaleX ?? 1,
      scaleY: obj.scaleY ?? 1,
      angle: obj.angle ?? 0,
      originX: (obj.originX as string) ?? 'left',
      originY: (obj.originY as string) ?? 'top',
      flipX: obj.flipX ?? false,
      flipY: obj.flipY ?? false
    }
    // 以当前显示的四角（场景坐标，含已有缩放/旋转）作为透视初始角
    const corners: Pt[] = obj.getCoords().map((p) => ({ x: p.x, y: p.y }))

    obj.set({ selectable: false, evented: false })
    this.canvas.discardActiveObject()

    const controls = corners.map((p, i) => this.makeCtrl(p, i))
    controls.forEach((c) => this.canvas.add(c))

    this.perspMode = {
      obj,
      srcCanvas,
      srcW: srcCanvas.width,
      srcH: srcCanvas.height,
      corners,
      controls,
      snapEl: el,
      geom
    }
    this.renderPersp()
    this.onPerspChange?.(true)
  }

  private makeCtrl(p: Pt, idx: number): FabricObject {
    const z = this.zoom || 1
    const c = new Circle({
      left: p.x,
      top: p.y,
      radius: 7 / z,
      originX: 'center',
      originY: 'center',
      fill: '#4a9eff',
      stroke: '#ffffff',
      strokeWidth: 1.5 / z,
      hasControls: false,
      hasBorders: false,
      hoverCursor: 'grab',
      moveCursor: 'grabbing'
    })
    ;(c as unknown as { zzz: ZzzLayerMeta }).zzz = { id: 'ctrl_' + idx, name: '', kind: 'ctrl' }
    c.on('moving', () => {
      const pm = this.perspMode
      if (!pm) return
      pm.corners[idx] = { x: c.left ?? 0, y: c.top ?? 0 }
      this.renderPersp()
    })
    return c
  }

  private renderPersp(): void {
    const pm = this.perspMode
    if (!pm) return
    const b = boundsOf(pm.corners)
    const local = pm.corners.map((p) => ({ x: p.x - b.minX, y: p.y - b.minY }))
    const out = renderPerspective(pm.srcCanvas, pm.srcW, pm.srcH, local, 24)
    pm.obj.setElement(out)
    pm.obj.set({
      left: b.minX,
      top: b.minY,
      originX: 'left',
      originY: 'top',
      scaleX: 1,
      scaleY: 1,
      angle: 0
    })
    pm.obj.setCoords()
    this.canvas.requestRenderAll()
  }

  /** 提交透视：把当前透视结果烘焙为该图层像素并记录变形数据 */
  applyPerspective(): void {
    const pm = this.perspMode
    if (!pm) return
    pm.controls.forEach((c) => this.canvas.remove(c))
    pm.obj.set({ selectable: true, evented: true })
    const meta = metaOf(pm.obj)
    if (meta) {
      meta.persp = {
        corners: pm.corners.map((p) => ({ x: p.x, y: p.y })),
        origDataURL: pm.srcCanvas.toDataURL('image/png'),
        origW: pm.srcW,
        origH: pm.srcH
      }
    }
    this.perspMode = null
    this.canvas.setActiveObject(pm.obj)
    this.canvas.requestRenderAll()
    this.onPerspChange?.(false)
    this.onLayersChange?.()
  }

  /** 取消透视：恢复进入前的像素与几何 */
  cancelPerspective(): void {
    const pm = this.perspMode
    if (!pm) return
    pm.controls.forEach((c) => this.canvas.remove(c))
    pm.obj.setElement(pm.snapEl)
    pm.obj.set({
      left: pm.geom.left,
      top: pm.geom.top,
      scaleX: pm.geom.scaleX,
      scaleY: pm.geom.scaleY,
      angle: pm.geom.angle,
      originX: pm.geom.originX,
      originY: pm.geom.originY,
      flipX: pm.geom.flipX,
      flipY: pm.geom.flipY,
      selectable: true,
      evented: true
    })
    pm.obj.setCoords()
    this.perspMode = null
    this.canvas.setActiveObject(pm.obj)
    this.canvas.requestRenderAll()
    this.onPerspChange?.(false)
  }

  /** 合并所有图层（含底图）渲染成原始 DDS 分辨率的「直通 alpha」RGBA。
   *  baseFull 提供时：底图换成全分辨率「不透明」画布渲染（RGB 不被预乘破坏），
   *  再用 baseFull.alpha 贴回原始 alpha 通道，从而忠实保留底图颜色与 alpha。 */
  async exportMergedRgba(baseFull?: {
    el: HTMLCanvasElement | HTMLImageElement
    w: number
    h: number
    alpha?: Uint8Array | Uint8ClampedArray
  }): Promise<{ rgba: Uint8ClampedArray; width: number; height: number }> {
    if (this.perspMode) this.applyPerspective()
    this.canvas.discardActiveObject()

    // 临时把降采样底图换成全分辨率像素
    const base = this.layers().find((o) => metaOf(o)?.kind === 'base') as FabricImage | undefined
    let restoreBase: (() => void) | null = null
    if (base && baseFull) {
      const prevEl = base.getElement()
      const prevSX = base.scaleX ?? 1
      const prevSY = base.scaleY ?? 1
      base.setElement(baseFull.el)
      base.set({ scaleX: this.ddsW / baseFull.w, scaleY: this.ddsH / baseFull.h })
      base.setCoords()
      restoreBase = () => {
        base.setElement(prevEl)
        base.set({ scaleX: prevSX, scaleY: prevSY })
        base.setCoords()
      }
    }

    const prevVT = this.canvas.viewportTransform.slice() as TMat2D
    const prevW = this.canvas.getWidth()
    const prevH = this.canvas.getHeight()

    // 切到 1:1 全分辨率离屏渲染（无缩放无平移）
    this.canvas.setViewportTransform([1, 0, 0, 1, 0, 0] as TMat2D)
    this.canvas.setDimensions({ width: this.ddsW, height: this.ddsH })
    this.canvas.renderAll()
    const el = this.canvas.toCanvasElement()
    const ctx = el.getContext('2d', { willReadFrequently: true })!
    const id = ctx.getImageData(0, 0, el.width, el.height)

    // 贴回原始 alpha：底图不透明渲染保证 RGB 精确，这里再恢复底图的 alpha 数据通道
    const a = baseFull?.alpha
    if (a) {
      const d = id.data
      const n = Math.min(a.length, d.length >> 2)
      for (let i = 0; i < n; i++) d[(i << 2) + 3] = a[i]
    }

    // 恢复显示状态
    restoreBase?.()
    this.canvas.setViewportTransform(prevVT)
    this.canvas.setDimensions({ width: prevW, height: prevH })
    this.canvas.renderAll()
    return { rgba: id.data, width: el.width, height: el.height }
  }

  // ---------- 工程序列化（烘焙式：嵌入当前像素 + 几何） ----------

  private elementDataURL(obj: FabricImage): string {
    const el = obj.getElement() as HTMLImageElement | HTMLCanvasElement
    // 按「元素身份」记忆化：图层只在创建 / 透视烘焙 / 合并时换元素，平时只改变换。
    // 这样自动保存不必每次都把每个图层重新编码成 PNG（图层多时这是主要卡顿源）。
    const cache = obj as unknown as { __embedEl?: unknown; __embedURL?: string }
    if (cache.__embedEl === el && cache.__embedURL) return cache.__embedURL
    const w = (el as HTMLImageElement).naturalWidth || el.width
    const h = (el as HTMLImageElement).naturalHeight || el.height
    const c = document.createElement('canvas')
    c.width = Math.max(1, w)
    c.height = Math.max(1, h)
    c.getContext('2d')!.drawImage(el, 0, 0)
    const url = c.toDataURL('image/png')
    cache.__embedEl = el
    cache.__embedURL = url
    return url
  }

  /** 把当前所有图层导出为工程图层数据 */
  exportProjectLayers(): LayerData[] {
    if (this.perspMode) this.applyPerspective()
    const out: LayerData[] = []
    this.layers().forEach((obj, z) => {
      const meta = metaOf(obj)
      if (!meta || !(obj instanceof FabricImage)) return
      const isBase = meta.kind === 'base'
      // 底图体积大（可达 8K/64MB），存路径引用；叠加小图直接内嵌像素
      const source: LayerSource =
        isBase && this.basePath
          ? { type: 'ref', path: this.basePath }
          : { type: 'embed', data: this.elementDataURL(obj) }
      out.push({
        id: meta.id,
        name: meta.name,
        kind: isBase ? 'base' : 'overlay',
        source,
        transform: {
          left: obj.left ?? 0,
          top: obj.top ?? 0,
          scaleX: obj.scaleX ?? 1,
          scaleY: obj.scaleY ?? 1,
          angle: obj.angle ?? 0,
          skewX: obj.skewX ?? 0,
          skewY: obj.skewY ?? 0,
          originX: (obj.originX as string) ?? 'left',
          originY: (obj.originY as string) ?? 'top',
          flipX: obj.flipX ?? false,
          flipY: obj.flipY ?? false
        },
        perspective: null,
        opacity: obj.opacity ?? 1,
        blendMode: 'source-over',
        visible: obj.visible ?? true,
        z
      })
    })
    return out
  }

  /** 重建叠加图层（底图请先用 setBaseImage 设置好）。仅处理内嵌像素的 overlay。 */
  async loadOverlays(overlays: LayerData[]): Promise<void> {
    const sorted = overlays.slice().sort((a, b) => a.z - b.z)
    for (const ld of sorted) {
      if (ld.kind !== 'overlay') continue
      if (ld.source.type !== 'embed') {
        throw new Error('叠加图层缺少内嵌像素，无法重建')
      }
      const img = await FabricImage.fromURL(ld.source.data)
      const t = ld.transform
      img.set({
        left: t.left,
        top: t.top,
        originX: (t.originX ?? 'left') as 'left',
        originY: (t.originY ?? 'top') as 'top',
        scaleX: t.scaleX,
        scaleY: t.scaleY,
        angle: t.angle,
        skewX: t.skewX,
        skewY: t.skewY,
        flipX: t.flipX ?? false,
        flipY: t.flipY ?? false,
        opacity: ld.opacity,
        visible: ld.visible
      })
      ;(img as unknown as { zzz: ZzzLayerMeta }).zzz = {
        id: ld.id,
        name: ld.name,
        kind: 'overlay'
      }
      this.installScaleRotateControls(img)
      // 预置嵌入缓存：避免重开后第一次自动保存又把每个图层重新编码一遍
      ;(img as unknown as { __embedEl?: unknown; __embedURL?: string }).__embedEl = img.getElement()
      ;(img as unknown as { __embedURL?: string }).__embedURL = ld.source.data
      this.canvas.add(img)
    }
    this.canvas.requestRenderAll()
    this.onLayersChange?.()
  }

  /**
   * 一键合并所有叠加图层为单个全画布叠加层（底图保持独立 → 导出仍忠实 alpha）。
   * 图层数从 N 降到 1，渲染与自动保存都大幅变快。返回是否发生了合并。
   */
  async mergeOverlays(): Promise<boolean> {
    if (this.perspMode) this.applyPerspective()
    this.canvas.discardActiveObject()
    const overlays = this.layers().filter((o) => metaOf(o)?.kind === 'overlay')
    if (overlays.length < 2) return false

    // 只渲染叠加层：临时隐藏底图，1:1 全分辨率离屏渲染
    const base = this.layers().find((o) => metaOf(o)?.kind === 'base')
    const baseVisible = base ? base.visible : true
    if (base) base.set('visible', false)

    const prevVT = this.canvas.viewportTransform.slice() as TMat2D
    const prevW = this.canvas.getWidth()
    const prevH = this.canvas.getHeight()
    this.canvas.setViewportTransform([1, 0, 0, 1, 0, 0] as TMat2D)
    this.canvas.setDimensions({ width: this.ddsW, height: this.ddsH })
    this.canvas.renderAll()
    const mergedCanvas = this.canvas.toCanvasElement() // 仅叠加层，透明背景

    if (base) base.set('visible', baseVisible)
    this.canvas.setViewportTransform(prevVT)
    this.canvas.setDimensions({ width: prevW, height: prevH })

    overlays.forEach((o) => this.canvas.remove(o))
    const img = new FabricImage(mergedCanvas)
    img.set({ left: 0, top: 0, originX: 'left', originY: 'top', scaleX: 1, scaleY: 1 })
    ;(img as unknown as { zzz: ZzzLayerMeta }).zzz = { id: newId(), name: '合并图层', kind: 'overlay' }
    this.installScaleRotateControls(img)
    this.canvas.add(img)
    this.canvas.setActiveObject(img)
    this.canvas.requestRenderAll()
    this.onLayersChange?.()
    return true
  }
}
