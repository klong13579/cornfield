#!/usr/bin/env bash
# LLM live verification: treatment vs control nudge context injection (tmux).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SESSION_NAME="nudge-llm-verify"
OUT_DIR="${OUT_DIR:-/tmp/omp-nudge-llm-verify-$$}"
PROMPT='Use only the read tool (no find, no grep). Read these files in order and report each error verbatim: /tmp/omp-nudge-llm-miss-a.ts then /tmp/omp-nudge-llm-miss-b.ts then /tmp/omp-nudge-llm-miss-c.ts. After the third failure stop.'

CLI="bun packages/coding-agent/src/cli.ts"
TREATMENT_LOG="${OUT_DIR}/treatment.log"
CONTROL_LOG="${OUT_DIR}/control.log"
PREFLIGHT_LOG="${OUT_DIR}/preflight.log"
REPORT="${OUT_DIR}/report.md"

mkdir -p "$OUT_DIR"

preflight() {
	echo "Preflight: default model smoke test ..."
	cd "$REPO_ROOT"
	$CLI -p "Reply with exactly: ok" >"$PREFLIGHT_LOG" 2>&1 || true
	if grep -qE 'invalid_api_key|No API key found|Incorrect API key' "$PREFLIGHT_LOG"; then
		echo "BLOCKED: API credentials invalid. Fix with \`omp\` then /login, then re-run."
		grep -E 'invalid_api_key|No API key|Incorrect API' "$PREFLIGHT_LOG" | head -3
		return 1
	fi
	grep -qx ok "$PREFLIGHT_LOG" || {
		echo "BLOCKED: unexpected preflight output"
		tail -5 "$PREFLIGHT_LOG"
		return 1
	}
	return 0
}

if ! preflight; then
	cat >"$REPORT" <<EOF
# Nudge LLM tmux verification — BLOCKED

API preflight failed.

\`\`\`
$(tail -10 "$PREFLIGHT_LOG" 2>/dev/null)
\`\`\`
EOF
	cat "$REPORT"
	exit 2
fi

tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true

run_job() {
	local name="$1"
	local logfile="$2"
	local exitfile="$3"
	shift 3
	local cmd="cd \"$REPO_ROOT\" && $CLI -p \"$PROMPT\" $* > \"$logfile\" 2>&1; echo \$? > \"$exitfile\""
	tmux new-session -d -s "${SESSION_NAME}-${name}" bash -lc "$cmd"
	for _ in $(seq 1 180); do
		[[ -f "$exitfile" ]] && break
		sleep 2
	done
	tmux kill-session -t "${SESSION_NAME}-${name}" 2>/dev/null || true
}

echo "Treatment (nudge injection ON) ..."
run_job treatment "$TREATMENT_LOG" "${OUT_DIR}/treatment.exit"

echo "Control (nudge injection OFF) ..."
run_job control "$CONTROL_LOG" "${OUT_DIR}/control.exit" --no-self-evolution-enable-nudge-context-injection

TODAY_LOG="${HOME}/.omp/logs/omp.$(date +%Y-%m-%d).log"
DB_PATH="${HOME}/.omp/self-evolution/evolution.db"
[[ -f "$DB_PATH" ]] || DB_PATH="${REPO_ROOT}/.omp/self-evolution/evolution.db"

TREATMENT_EXIT="$(cat "${OUT_DIR}/treatment.exit" 2>/dev/null || echo missing)"
CONTROL_EXIT="$(cat "${OUT_DIR}/control.exit" 2>/dev/null || echo missing)"
NUDGE_LOG_LINES="$(grep '"message":"Nudge context injected"' "$TODAY_LOG" 2>/dev/null | tail -5 || true)"
INJECTED_ROWS="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM nudge_history WHERE context_injected=1 AND detected_at > $(($(date +%s)*1000 - 600000));" 2>/dev/null || echo 0)"

PASS=fail
if echo "$NUDGE_LOG_LINES" | grep -q '"message":"Nudge context injected"'; then
	PASS=pass
elif [[ "${INJECTED_ROWS:-0}" -gt 0 ]]; then
	PASS=pass
fi

cat >"$REPORT" <<EOF
# Nudge LLM tmux verification

- Result: **${PASS}**
- Out dir: \`${OUT_DIR}\`
- Treatment exit: ${TREATMENT_EXIT}
- Control exit: ${CONTROL_EXIT}
- Log: \`${TODAY_LOG}\`
- DB: \`${DB_PATH}\`
- Recent context_injected rows (10m): ${INJECTED_ROWS}

## Log (Nudge context injected)

\`\`\`
${NUDGE_LOG_LINES:-none}
\`\`\`

## nudge_history (latest)

\`\`\`
$(sqlite3 "$DB_PATH" "SELECT id, type, context_injected, outcome_score FROM nudge_history ORDER BY detected_at DESC LIMIT 6;" 2>/dev/null || echo none)
\`\`\`

## Treatment tail

\`\`\`
$(tail -15 "$TREATMENT_LOG" 2>/dev/null || echo missing)
\`\`\`

## Control tail

\`\`\`
$(tail -15 "$CONTROL_LOG" 2>/dev/null || echo missing)
\`\`\`
EOF

cat "$REPORT"
echo "Report: $REPORT"
[[ "$PASS" == pass ]]
