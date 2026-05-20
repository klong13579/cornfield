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
