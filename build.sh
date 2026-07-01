#!/usr/bin/env bash
# 一键构建：编译三端 + 打包成【安装版(setup)】和【便携版(portable)】两个 exe，
# 并复制到项目根目录为固定名（便携版.exe / 安装版.exe）。
# 用法（在项目根目录）：  bash build.sh
# 注意：重建前请先【关闭正在运行的编辑器】，否则同名根目录 exe 被占用无法更新。
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

echo "[2/3] 打包 (electron-builder · 安装版 setup + 便携版 portable → $OUT/)…"
node node_modules/electron-builder/cli.js --win --x64 -c.directories.output="$OUT"

echo "[3/3] 复制到根目录（清晰命名）…"
# 便携版 → ZZZ-DDS-Editor-便携版.exe
PORT="$(ls -t "$OUT"/*portable*.exe 2>/dev/null | head -1)"
# 安装版 → ZZZ-DDS-Editor-安装版.exe
SETUP="$(ls -t "$OUT"/*setup*.exe 2>/dev/null | head -1)"

fail=0
if [ -n "$PORT" ]; then
  if cp -f "$PORT" "ZZZ-DDS-Editor-便携版.exe"; then
    echo "  ✓ 便携版：ZZZ-DDS-Editor-便携版.exe  （来自 $PORT）"
  else
    echo "  ⚠ 便携版复制失败：根目录同名 exe 可能正在运行。（新构建仍在 $PORT）" >&2
    fail=1
  fi
else
  echo "  ⚠ 未找到 portable exe。" >&2
  fail=1
fi
if [ -n "$SETUP" ]; then
  if cp -f "$SETUP" "ZZZ-DDS-Editor-安装版.exe"; then
    echo "  ✓ 安装版：ZZZ-DDS-Editor-安装版.exe  （来自 $SETUP）"
  else
    echo "  ⚠ 安装版复制失败：根目录同名 exe 可能正在运行。（新构建仍在 $SETUP）" >&2
    fail=1
  fi
else
  echo "  ⚠ 未找到 setup exe。" >&2
  fail=1
fi

if [ "$fail" = "1" ]; then
  echo "构建产物已在 $OUT/，但复制到根目录时有问题（见上）。" >&2
  exit 1
fi
echo "完成 ✅  根目录已更新：ZZZ-DDS-Editor-便携版.exe + ZZZ-DDS-Editor-安装版.exe"

