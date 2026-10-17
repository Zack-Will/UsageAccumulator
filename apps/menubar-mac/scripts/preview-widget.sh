#!/usr/bin/env bash
# 小部件设计预览：假数据 × 三档 × 深浅色，出图到 build/widget-preview/。
# 与小部件共用同一份视图和规则（Widget/QuotaViews.swift、QuotaModel.swift）。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$HERE/build/widget-preview"
mkdir -p "$OUT"
swiftc -O -target arm64-apple-macosx14.0 \
  -framework AppKit -framework SwiftUI \
  -o "$OUT/preview" \
  "$HERE"/Shared/*.swift "$HERE/Sources/Types.swift" \
  "$HERE/Widget/QuotaModel.swift" "$HERE/Widget/Theme.swift" "$HERE/Widget/QuotaViews.swift" \
  "$HERE/Widget/Preview/main.swift"
UA_FONT_DIR="$HERE/Resources/Fonts" "$OUT/preview" "$OUT"
