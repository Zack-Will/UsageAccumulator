#!/usr/bin/env bash
# 构建 UsageAccumulator.app（菜单栏外壳）。
#
# 刻意不用 .xcodeproj：外壳就这么几个文件，swiftc + 手写 Info.plist 足够，
# 也省掉 Xcode 工程文件在仓库里制造的无谓 diff。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="$HERE/build"
APP="$OUT/UsageAccumulator.app"
CONTENTS="$APP/Contents"

rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources/renderer"

# ---- 渲染层：与 Electron 版共用同一份文件，不另起一套 ----------------------
cp "$REPO/apps/menubar/src/renderer/index.html" \
   "$REPO/apps/menubar/src/renderer/panel.css" \
   "$REPO/apps/menubar/src/renderer/panel.js" \
   "$CONTENTS/Resources/renderer/"
cp "$REPO/packages/ua-tokens/src/theme.css" "$CONTENTS/Resources/renderer/theme.css"

# ---- 探针启动参数 -----------------------------------------------------------
# 指向仓库里的 tsx + cli.ts，与现有 launchd plist 同一条命令。
# 想换成打包后的单文件，覆盖 ~/Library/Application Support/UsageAccumulator/probe-launch.json 即可。
TSX="$REPO/node_modules/.bin/tsx"
if [ ! -x "$TSX" ]; then
  echo "⚠ 找不到 $TSX —— 先在仓库根跑一次 pnpm install" >&2
fi
# tsx 是 shell 包装，内部 exec node。LaunchAgent 下 PATH 是最小集，
# 不显式给就会 `exec: node: not found`（2026-09-21 实测踩到）。
NODE_BIN="$(command -v node || echo /usr/local/bin/node)"
NODE_DIR="$(dirname "$NODE_BIN")"
cat > "$CONTENTS/Resources/probe-launch.json" <<JSON
{
  "command": ["$TSX", "$REPO/packages/ua-probe/src/cli.ts", "run"],
  "cwd": "$REPO",
  "env": { "PATH": "$NODE_DIR:/usr/bin:/bin:/usr/sbin:/sbin" }
}
JSON

cp "$HERE/Resources/Info.plist" "$CONTENTS/Info.plist"

# ---- 编译 -------------------------------------------------------------------
swiftc -O \
  -target arm64-apple-macosx14.0 \
  -framework AppKit -framework WebKit -framework Security \
  -o "$CONTENTS/MacOS/UsageAccumulator" \
  "$HERE"/Sources/*.swift

# ad-hoc 签名：个人自用足够，不走公证。没有它 Gatekeeper 每次都要拦。
codesign --force --sign - "$APP"

echo "✓ $APP"
echo "  运行：open '$APP'"
