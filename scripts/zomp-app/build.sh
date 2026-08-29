#!/bin/bash
# CornField.app 构建脚本 —— 把当前代码打成可双击启动的客户端。
#
# 产物: ~/Applications/CornField.app
# 内容: zed 主程序壳（ZOMP_SHELL=1）+ webapp dist + 静态 server + launcher
#
# 用法: bun scripts/zomp-app/build.sh
#   1. 重新 build web-app dist（可选: SKIP_WEBAPP_BUILD=1 用现有 dist）
#   2. 重新 build zed release（可选: SKIP_ZED_BUILD=1 用现有 target/release/zed）
#   3. 编译 serve-webapp 独立二进制
#   4. 组装 CornField.app → ~/Applications/CornField.app
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$HOME/Applications/CornField.app"
DIST_DIR="$REPO_ROOT/packages/web-app/dist"
ZED_BIN="$REPO_ROOT/third_party/zed/target/release/zed"

echo "==> 1/4 web-app dist"
if [ "${SKIP_WEBAPP_BUILD:-0}" != "1" ]; then
	bun --cwd="$REPO_ROOT/packages/web-app" run build
else
	echo "    (skip, 用现有 dist)"
fi

echo "==> 2/4 zed release"
if [ "${SKIP_ZED_BUILD:-0}" != "1" ]; then
	(cd "$REPO_ROOT/third_party/zed" && cargo build -p zed --release)
else
	echo "    (skip, 用现有 target/release/zed)"
fi

echo "==> 3/4 serve-webapp 二进制"
bun build "$REPO_ROOT/scripts/zomp-app/serve-webapp.ts" --compile --outfile /tmp/cornfield-serve-webapp >/dev/null

echo "==> 4/4 组装 $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/webapp"

cp "$ZED_BIN" "$APP/Contents/MacOS/zed"
cp /tmp/cornfield-serve-webapp "$APP/Contents/MacOS/serve-webapp"
cp "$REPO_ROOT/scripts/zomp-app/launcher.sh" "$APP/Contents/MacOS/launcher"
chmod +x "$APP/Contents/MacOS/launcher" "$APP/Contents/MacOS/serve-webapp"

cp -R "$DIST_DIR/." "$APP/Contents/Resources/webapp/"

cp "$REPO_ROOT/scripts/zomp-app/Info.plist" "$APP/Contents/Info.plist"

echo "==> 完成: $APP"
echo "    双击 $APP 或执行: open $APP"