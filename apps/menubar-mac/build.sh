#!/usr/bin/env bash
# 构建 UsageAccumulator.app（菜单栏外壳）。
#
# 刻意不用 .xcodeproj：外壳就这么几个文件，swiftc + 手写 Info.plist 足够，
# 也省掉 Xcode 工程文件在仓库里制造的无谓 diff。
#
#   ./build.sh                      本机自用：探针指向本仓库源码，只编 arm64
#   ./build.sh --release 0.2.0      发布：不带仓库路径（运行时找全局安装的 ua-probe），
#                                   arm64 + x86_64 通用二进制，打成 build/UsageAccumulator-0.2.0-macos.dmg
set -euo pipefail

RELEASE=0
VERSION=""
if [ "${1:-}" = "--release" ]; then
  RELEASE=1
  VERSION="${2:?用法：./build.sh --release <x.y.z>}"
  VERSION="${VERSION#v}"
fi

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
# Release 包不带：构建机的仓库路径到了别人机器上不存在（见 ProbeSupervisor.globalInstallSpec）
if [ "$RELEASE" = 0 ]; then
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
fi

cp "$HERE/Resources/Info.plist" "$CONTENTS/Info.plist"
# 图标由 scripts/gen-icon.swift 生成，改图形才需要重跑
cp "$HERE/Resources/AppIcon.icns" "$CONTENTS/Resources/AppIcon.icns"
if [ -n "$VERSION" ]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$CONTENTS/Info.plist"
  # CFBundleVersion 要单调递增：x.y.z → x*10000 + y*100 + z
  IFS=. read -r MA MI PA <<<"${VERSION%%-*}"
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $((MA * 10000 + MI * 100 + PA))" "$CONTENTS/Info.plist"
fi

# ---- 编译 -------------------------------------------------------------------
compile() {
  swiftc -O \
    -target "$1-apple-macosx14.0" \
    -framework AppKit -framework WebKit -framework Security \
    -o "$2" \
    "$HERE"/Sources/*.swift
}
if [ "$RELEASE" = 1 ]; then
  compile arm64 "$OUT/UsageAccumulator-arm64"
  compile x86_64 "$OUT/UsageAccumulator-x86_64"
  lipo -create -output "$CONTENTS/MacOS/UsageAccumulator" "$OUT/UsageAccumulator-arm64" "$OUT/UsageAccumulator-x86_64"
  rm "$OUT/UsageAccumulator-arm64" "$OUT/UsageAccumulator-x86_64"
else
  compile arm64 "$CONTENTS/MacOS/UsageAccumulator"
fi

# ad-hoc 签名：个人自用足够，不走公证。没有它 Gatekeeper 每次都要拦。
codesign --force --sign - "$APP"

if [ "$RELEASE" = 1 ]; then
  # 镜像里放 App 和一个指向 /Applications 的替身，挂载后直接拖过去
  DMG="$OUT/UsageAccumulator-$VERSION-macos.dmg"
  STAGE="$OUT/dmg"
  rm -rf "$STAGE" "$DMG"
  mkdir -p "$STAGE"
  cp -R "$APP" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"
  hdiutil create -quiet -volname "UsageAccumulator $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO "$DMG"
  rm -rf "$STAGE"
  echo "✓ $DMG"
fi
echo "✓ $APP"
echo "  运行：open '$APP'"
