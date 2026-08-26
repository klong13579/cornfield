#!/bin/bash
# OMP.app launcher —— 双击入口：
# 1. 幂等拉起 webapp 静态 server（5180，serve 打包进来的 dist）
# 2. 幂等拉起 sidecar `omp serve`（7891，webapp WS 数据通道）
# 3. exec zed 主程序壳模式（ZOMP_SHELL=1 → Agent/IDE 双视图）
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
RES="$DIR/../Resources"
WEBAPP_PORT="5180"
SIDECAR_PORT="7891"
ZED_DATA_DIR="$HOME/.zomp-data"

export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# --- 1. webapp 静态 server ---
if ! lsof -nP -iTCP:$WEBAPP_PORT -sTCP:LISTEN >/dev/null 2>&1; then
	"$DIR/serve-webapp" "$RES/webapp" "$WEBAPP_PORT" >/tmp/omp-webapp.log 2>&1 &
fi

# --- 2. sidecar（WS 数据通道） ---
if ! lsof -nP -iTCP:$SIDECAR_PORT -sTCP:LISTEN >/dev/null 2>&1; then
	OMP_BIN="$HOME/.local/bin/omp"
	if [ ! -x "$OMP_BIN" ]; then
		OMP_BIN="$(command -v omp)"
	fi
	if [ -n "${OMP_BIN:-}" ]; then
		"$OMP_BIN" serve --port "$SIDECAR_PORT" --host 127.0.0.1 >/tmp/omp-sidecar.log 2>&1 &
	fi
fi

# --- 3. 等待两通道就绪（最多 10s） ---
for _ in $(seq 1 20); do
	A=0; B=0
	lsof -nP -iTCP:$WEBAPP_PORT -sTCP:LISTEN >/dev/null 2>&1 && A=1
	lsof -nP -iTCP:$SIDECAR_PORT -sTCP:LISTEN >/dev/null 2>&1 && B=1
	[ "$A" = 1 ] && [ "$B" = 1 ] && break
	sleep 0.5
done

# --- 4. zed 主程序壳模式（Agent 视图指向本地 webapp） ---
export ZOMP_SHELL=1
export ZOMP_WEBAPP_URL="http://127.0.0.1:$WEBAPP_PORT"
exec "$DIR/zed" --user-data-dir="$ZED_DATA_DIR"