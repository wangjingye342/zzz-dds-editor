// 主进程 / 渲染进程 / preload 共享的类型定义
// 覆盖：DDS 元信息、图层数据模型、工程文件 (.zzzproj)、IPC 契约

/** 原始 DDS 文件的关键元信息，导出时复用以保持格式一致 */
export interface DdsMeta {
  width: number
  height: number
  mipCount: number
  /** 是否带 DX10 扩展头 */
  isDX10: boolean
  /** DX10 扩展头里的 DXGI_FORMAT 数值（无 DX10 头则为 null） */
  dxgiFormat: number | null
  /** legacy FourCC，如 "DXT5"、"DX10"、"ATI2"；无则 null */
  fourCC: string | null
  /** 人类可读格式名，如 "BC7_UNORM"、"BC3_UNORM" */
  formatName: string
  /** texconv 的 -f 参数值，如 "BC7_UNORM" */
  texconvFormat: string
  /** DX10 miscFlags2 的 alpha mode 低 3 位（无则 null） */
  alphaMode: number | null
}

export interface LayerTransform {
  left: number
  top: number
  scaleX: number
  scaleY: number
  angle: number
  skewX: number
  skewY: number
  /** fabric 原点，缺省 'left'/'top'（用于精确还原叠加图层位置） */
  originX?: string
  originY?: string
  flipX?: boolean
  flipY?: boolean
}

export interface Vec2 {
  x: number
  y: number
}

/** 四角透视角点，坐标为相对源图尺寸归一化（0~1），保证缩放无关、可重建 */
export interface PerspectiveCorners {
  tl: Vec2
  tr: Vec2
  bl: Vec2
  br: Vec2
}

export type LayerSource =
  | { type: 'ref'; path: string } // 引用磁盘文件
  | { type: 'embed'; data: string } // 内嵌 dataURL（base64）

export interface LayerData {
  id: string
  name: string
  kind: 'base' | 'overlay'
  source: LayerSource
  transform: LayerTransform
  perspective: PerspectiveCorners | null
  opacity: number
  blendMode: string
  visible: boolean
  z: number
}

export interface ProjectTarget {
  /** 要覆盖的原 DDS 绝对路径 */
  ddsPath: string
  meta: DdsMeta
}

export interface ProjectFile {
  version: number
  app: 'zzz-dds-editor'
  target: ProjectTarget | null
  canvas: { width: number; height: number }
  layers: LayerData[]
  /** 工作目录记录标记：来自某个 mod 文件夹的默认保存记录（自带原图副本，可续编） */
  mod?: { name: string }
}

/** mod 文件夹里扫描到的一张待编辑 DDS */
export interface DdsEntry {
  /** 绝对路径 */
  path: string
  /** 相对 mod 根目录的路径（含子目录），用于记录镜像结构、避免重名碰撞 */
  rel: string
  /** 文件名 */
  name: string
  /** 字节大小 */
  size: number
  /** 工作目录里是否已存在该贴图的编辑记录 */
  hasRecord: boolean
}

/** 打开一个 mod 文件夹后的扫描结果 */
export interface ModScan {
  /** mod 根目录绝对路径 */
  root: string
  /** mod 文件夹名（= 工作目录里建的子目录名） */
  name: string
  files: DdsEntry[]
}

/** 工作目录里某条编辑记录的索引项（用于「最近记录」快速续编） */
export interface RecentRecord {
  /** .zzzproj 记录路径 */
  projPath: string
  /** mod 文件夹名 */
  modName: string
  /** 贴图名 */
  ddsName: string
  /** 导出要覆盖的原始 mod DDS 路径 */
  ddsPath: string
  /** 最近打开时间戳 */
  lastOpened: number
}

export interface AppSettings {
  /** 用户指定的工作目录（编辑记录保存根目录） */
  workspaceDir: string | null
  /** 导出的 mod 副本保存目录；原始 mod 文件夹不会被修改 */
  outputDir: string | null
  recent: RecentRecord[]
  /** 是否自动保存编辑记录（默认 true） */
  autoSave: boolean
  /** 默认导出格式 key（对应导出下拉框选项），默认 'bc7-srgb' */
  defaultExportFormat: string
  /** 记住的素材文件夹，启动时自动加载（null 表示不自动加载） */
  libraryDir: string | null
  /** 勾选后，点击/拖拽插入的新贴图自动水平镜像 */
  mirrorInsert: boolean
}

/** 为某张 mod DDS 准备/解析编辑记录的结果 */
export interface RecordPrep {
  /** 记录所在目录 <workspace>/<modName>/<相对子目录> */
  recordDir: string
  /** .zzzproj 记录路径 */
  projPath: string
  /** 原图副本路径（base 来源，永不被导出覆盖） */
  baseCopyPath: string
  /** 输出目录中的 mod 副本根目录 */
  outputModRoot: string
  /** 输出目录中的 DDS 副本路径；导出只覆盖这个文件 */
  outputDdsPath: string
  /** 已存在的工程（断点续编）；null 表示新建 */
  project: ProjectFile | null
}

export interface ArchiveResult {
  ok: boolean
  message: string
  archivePath?: string
}

export interface LibraryItem {
  path: string
  name: string
  ext: string
  count: number
  lastUsed: number
}

export type UsageMap = Record<string, { count: number; lastUsed: number }>

export interface ExportRequest {
  ddsPath: string
  meta: DdsMeta
  /** 合并后整张画布的「直通 alpha」RGBA 像素（每像素 4 字节，自上而下） */
  rgba: Uint8Array
  width: number
  height: number
  /** 覆盖前是否备份原文件为 .bak（仅首次） */
  backup: boolean
  /** 覆盖前把「被替换的当前贴图」另存到这里（记录目录里的 .prev.dds），用于「恢复上一次」 */
  prevBackupPath?: string
}

export interface ExportResult {
  ok: boolean
  message: string
  /** 成功写入的 DDS 路径 */
  outputPath?: string
  /** mac 开发期 fallback 输出的 PNG 路径 */
  fallbackPng?: string
  /** texconv stderr，便于排错 */
  stderr?: string
  /** 覆盖前原文件字节数 */
  originalSize?: number
  /** 原文件格式（人类可读，如 BC1_UNORM_SRGB） */
  originalFormat?: string
  /** 导出后文件字节数 */
  outputSize?: number
  /** 导出后实际格式（回读输出 DDS 头确认） */
  outputFormat?: string
}

/** preload 通过 contextBridge 暴露给渲染进程的 API */
export interface Api {
  openDdsDialog: (defaultPath?: string) => Promise<string | null>
  chooseFolder: () => Promise<string | null>
  readDdsMeta: (path: string) => Promise<DdsMeta>
  readBinary: (path: string) => Promise<Uint8Array>
  /** 主进程小 mip 解码 + 必要时下采样，返回小张 RGBA（缩略图用，毫秒级） */
  readDdsThumb: (path: string, maxEdge?: number) => Promise<{ width: number; height: number; rgba: Uint8Array }>
  scanLibrary: (folder: string) => Promise<LibraryItem[]>
  readUsage: () => Promise<UsageMap>
  bumpUsage: (path: string) => Promise<void>
  saveProjectDialog: (project: ProjectFile, currentPath: string | null) => Promise<string | null>
  loadProjectDialog: () => Promise<{ path: string; project: ProjectFile } | null>
  exportDds: (req: ExportRequest) => Promise<ExportResult>
  // ---- mod 文件夹输入 + 工作目录默认保存记录 ----
  getSettings: () => Promise<AppSettings>
  /** 局部更新设置并持久化，返回更新后的完整设置 */
  updateSettings: (partial: Partial<AppSettings>) => Promise<AppSettings>
  /** 在系统文件管理器中打开某个路径（设置面板里「打开目录」用） */
  openPath: (path: string) => Promise<void>
  /** 弹目录框选择工作目录并持久化，返回新目录（取消返回 null） */
  chooseWorkspace: () => Promise<string | null>
  /** 弹目录框选择输出目录并持久化，返回新目录（取消返回 null） */
  chooseOutputDir: () => Promise<string | null>
  /** 弹目录框选择 mod 文件夹并扫描其中 DDS（取消返回 null） */
  openModFolder: () => Promise<ModScan | null>
  /** 为某张 mod DDS 准备/解析编辑记录（存在则返回工程续编，否则建副本待新建） */
  prepareRecord: (modRoot: string, ddsPath: string) => Promise<RecordPrep>
  /** 把输出目录里的对应 mod 文件夹压缩成带时间戳的 RAR */
  archiveOutputMod: (modName: string) => Promise<ArchiveResult>
  /** 直接把工程写入指定路径（默认/自动保存，无弹窗） */
  saveProjectTo: (path: string, project: ProjectFile) => Promise<void>
  /** 读取指定路径的工程（用于「最近记录」直接续编） */
  readProjectFile: (path: string) => Promise<ProjectFile>
  /** 记一条「最近记录」 */
  addRecent: (rec: RecentRecord) => Promise<void>
  /** 取「最近记录」列表（按时间倒序） */
  getRecent: () => Promise<RecentRecord[]>
  /** 查询某记录的备份是否就绪（用于启用「恢复」按钮） */
  backupStatus: (projectPath: string) => Promise<{ hasPrev: boolean; hasOriginal: boolean }>
  /** 复制文件（恢复贴图用：把备份覆盖回导出目标） */
  restoreFile: (src: string, dest: string) => Promise<void>
  /** 弹原生确认框，返回是否确认（用于破坏性操作二次确认） */
  confirmDialog: (message: string, detail?: string) => Promise<boolean>
  /** 设置当前窗口是否始终置顶，返回实际状态 */
  setWindowAlwaysOnTop: (on: boolean) => Promise<boolean>
  platform: () => string
}

declare global {
  interface Window {
    api: Api
  }
}
