#!/usr/bin/env bash
# 一键构建：编译三端 + 打包成单文件 portable exe，并复制到项目根目录为固定名。
# 用法（在项目根目录）：  bash build.sh
# 注意：重建前请先【关闭正在运行的 ZZZ-DDS-Editor.exe】，否则根目录 exe 被占用无法更新。
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# 定位 Node（含 npm）。优先用 PATH 里的 node；
# 若你的 node 不在 PATH，运行时用环境变量 NODE_DIR 指向其所在目录即可：
#   NODE_DIR="/c/你的路径/node-v22.x-win-x64" bash build.sh
if [ -n "$NODE_DIR" ] && [ -x "$NODE_DIR/node.exe" ]; then
  export PATH="$NODE_DIR:$PATH"
fi
if ! command -v node >/dev/null 2>&1; then
  echo "未找到 node。请安装 Node.js（推荐 v18+），或用 NODE_DIR 指向便携版目录后重试。" >&2
  exit 1
fi

# 用一个干净的输出目录，避免与「正在运行的旧 exe」文件名冲突而被锁
OUT="release"
rm -rf "$OUT" 2>/dev/null || true

echo "[1/3] 编译 (electron-vite build)…"
node node_modules/electron-vite/bin/electron-vite.js build

echo "[2/3] 打包 (electron-builder · portable 单文件 exe → $OUT/)…"
node node_modules/electron-builder/cli.js --win --x64 -c.directories.output="$OUT"

echo "[3/3] 复制 exe 到根目录…"
EXE="$(ls -t "$OUT"/*portable*.exe 2>/dev/null | head -1)"
if [ -z "$EXE" ]; then
  echo "未找到 portable exe，构建可能失败。" >&2
  exit 1
fi
if ! cp -f "$EXE" "ZZZ-DDS-Editor.exe"; then
  echo "复制失败：根目录 ZZZ-DDS-Editor.exe 可能正在运行，请关闭后重试。" >&2
  echo "（新构建仍在 $EXE）" >&2
  exit 1
fi
echo "完成 ✅  根目录已更新：ZZZ-DDS-Editor.exe  （来自 $EXE）"
