#!/usr/bin/env bash
#
# 打 Chrome 插件离线包：dist/readloop-extension-<version>.zip
#
# 用法：
#   bash scripts/pack-extension.sh
#
# 包内容 = extension/ 下的运行时代码（排除 tools/ 冒烟脚本、.DS_Store、__MACOSX）。
# 用户拿到 zip 后解压，在 chrome://extensions 里 Load unpacked 选解压目录即可。
# 仓库里不提交 zip（dist/ 已 gitignore）；发布走 GitHub Release 挂这个文件。

set -euo pipefail

cd "$(dirname "$0")/.."

EXTENSION_DIR="extension"
OUT_DIR="dist"

VERSION="$(node -e "console.log(JSON.parse(require('fs').readFileSync('${EXTENSION_DIR}/manifest.json','utf8')).version)")"
ZIP_PATH="${OUT_DIR}/readloop-extension-${VERSION}.zip"

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/readloop-extension-*.zip

echo "==> 打包 ${EXTENSION_DIR} → ${ZIP_PATH}（version ${VERSION}）"
(
  cd "$EXTENSION_DIR"
  zip -qr "../${ZIP_PATH}" . \
    -x 'tools/*' \
    -x '*.DS_Store' \
    -x '__MACOSX/*'
)

# 自检：版本一致、运行时文件齐全、测试脚本没混进去
PACKED_VERSION="$(unzip -p "$ZIP_PATH" manifest.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).version))")"
if [[ "$PACKED_VERSION" != "$VERSION" ]]; then
  echo "❌ 包内 manifest 版本 ${PACKED_VERSION} 与 ${VERSION} 不一致"
  exit 1
fi
for required in manifest.json src/background.js src/content-script.js src/sidepanel/index.html src/sidepanel/main.js src/sidepanel/styles.css src/lib/api.js src/lib/feishu.js src/lib/storage.js assets/icons/icon-128.png; do
  if ! unzip -l "$ZIP_PATH" "$required" >/dev/null 2>&1; then
    echo "❌ 包内缺少 ${required}"
    exit 1
  fi
done
if unzip -l "$ZIP_PATH" | grep -q "tools/"; then
  echo "❌ 包内混进了 tools/（冒烟脚本不该分发）"
  exit 1
fi

FILE_COUNT="$(unzip -l "$ZIP_PATH" | tail -1 | awk '{print $2}')"
SIZE="$(du -h "$ZIP_PATH" | cut -f1)"
echo "✅ 打包完成：${ZIP_PATH}（${SIZE}，${FILE_COUNT} 个文件）"
echo "   发布：gh release create extension-v${VERSION} ${ZIP_PATH} --title \"ReadLoop Chrome Extension v${VERSION}\""
