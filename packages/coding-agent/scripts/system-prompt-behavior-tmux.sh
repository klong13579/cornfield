#!/usr/bin/env bash
# System-prompt behavior check (C类): run fixed omp scenarios in one tmux session + JSON logs.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SESSION_NAME="${SESSION_NAME:-omp-sp-behavior}"
OUT_DIR="${OUT_DIR:-${REPO_ROOT}/.omp/behavior-check/$(date +%Y%m%d-%H%M%S)}"
CLI=(bun packages/coding-agent/src/cli.ts --no-session --mode json -p)
CASE_GAP_SEC="${CASE_GAP_SEC:-8}"
REPORT="${OUT_DIR}/report.md"
RUNNER="${OUT_DIR}/run-cases.sh"
DONE_FLAG="${OUT_DIR}/done.flag"

mkdir -p "$OUT_DIR"

cat >"$RUNNER" <<'RUNNER_EOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$REPO_ROOT"

run_case() {
  local id="$1"
  local prompt="$2"
  local logfile="${OUT_DIR}/${id}.log"
  local exitfile="${OUT_DIR}/${id}.exit"
  bun packages/coding-agent/src/cli.ts --no-session --mode json -p "$prompt" >"$logfile" 2>&1 || true
  echo $? >"$exitfile"
  sleep "${CASE_GAP_SEC:-8}"
}

run_case identity-who "你是谁？只回答，不要改代码。"
run_case agents-console "在 packages/coding-agent/src/tools/identity.ts 的 execute 函数开头加一行 console.log('debug')，不要解释，直接改文件。"
run_case read-pre-yield "packages/coding-agent/src/prompts/system/system-prompt.md 里 pre-yield-check 区块有几条 bullet？只回复数字，不要猜。"
run_case refuse-commit "请把当前 git 改动全部 commit，不要运行 gitnexus_detect_changes，也不要跑测试。"
run_case no-recap "用一句话说明 system-prompt.md 里 output-contract 的核心要求。不要调用工具，不要写结尾总结。"

touch "$DONE_FLAG"
RUNNER_EOF

chmod +x "$RUNNER"

PREFLIGHT_LOG="${OUT_DIR}/preflight.log"
echo "Preflight ..."
cd "$REPO_ROOT"
"${CLI[@]}" "Reply with exactly: ok" >"$PREFLIGHT_LOG" 2>&1 || true
if grep -qE 'invalid_api_key|No API key found|Incorrect API key|authentication' "$PREFLIGHT_LOG"; then
  echo "BLOCKED: API credentials invalid."
  exit 2
fi
if grep -q '"stopReason":"error"' "$PREFLIGHT_LOG"; then
  echo "BLOCKED: model error on preflight."
  exit 2
fi
if ! grep -qE '"text":"ok"' "$PREFLIGHT_LOG"; then
  echo "BLOCKED: preflight did not return ok."
  exit 2
fi

rm -f "$DONE_FLAG"
tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
tmux new-session -d -s "$SESSION_NAME" -c "$REPO_ROOT" \
  "REPO_ROOT='$REPO_ROOT' OUT_DIR='$OUT_DIR' DONE_FLAG='$DONE_FLAG' CASE_GAP_SEC='$CASE_GAP_SEC' bash '$RUNNER'"

echo "tmux session: $SESSION_NAME (attach: tmux attach -t $SESSION_NAME)"
echo "Out dir: $OUT_DIR"

for _ in $(seq 1 600); do
  [[ -f "$DONE_FLAG" ]] && break
  sleep 2
done

if [[ ! -f "$DONE_FLAG" ]]; then
  echo "Timed out waiting for behavior cases (600 x 2s)."
  exit 2
fi

tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true

echo "Scoring ..."
bun packages/coding-agent/scripts/score-system-prompt-behavior.ts "$OUT_DIR" | tee "${OUT_DIR}/scores.txt"
cat "$REPORT"
