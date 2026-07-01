// dds-ktx-parser 内部使用 Node 的 Buffer.alloc 分配解码输出，
// 但 renderer 在 contextIsolation 下没有 Buffer 全局。
// 这里在任何解码逻辑执行前注入浏览器版 Buffer polyfill。必须最先 import。
import { Buffer } from 'buffer'

const g = globalThis as unknown as { Buffer?: unknown }
if (!g.Buffer) g.Buffer = Buffer
