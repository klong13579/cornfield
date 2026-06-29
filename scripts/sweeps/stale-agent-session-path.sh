#!/usr/bin/env bash
# scripts/sweeps/stale-agent-session-path.sh
#
# Clear `agent_session_path` in the scheduler executions table for any row
# whose referenced JSONL no longer exists on disk.
#
# Why this is needed: the gateway writes a `agent_session_path` after each
# cron run pointing at the session file. If the file is later deleted (by
# retention sweeps, manual cleanup, or the abandoned-bydate sweep), the row
# becomes a stale pointer. Nothing currently reads the column, but cleaning
# it up keeps the table honest and avoids future bugs when a feature does
# start to use it.
#
# Usage:
#   scripts/sweeps/stale-agent-session-path.sh [--db <path>] [--dry-run]
#
# Examples:
#   # default: targets the gateway-data scheduler DB
#   scripts/sweeps/stale-agent-session-path.sh
#
#   # explicit db path
#   scripts/sweeps/stale-agent-session-path.sh --db ~/.omp/scheduler.db
#
#   # preview only
#   scripts/sweeps/stale-agent-session-path.sh --dry-run
#
# Notes:
#   - The default --db path follows the gateway layout. The script falls
#     back to the legacy root DB if the gateway-data one is absent.
#   - Only rows with a non-null AND non-empty `agent_session_path` are
#     considered. Empty / null rows are left alone.
#   - For each candidate, the script checks `os.path.exists` semantics via
#     `[ -e "$path" ]`. If false, the row's `agent_session_path` is set to
#     NULL. All updates run in a single transaction for atomicity.
set -euo pipefail

usage() {
	cat <<'EOF'
Usage: stale-agent-session-path.sh [--db <path>] [--dry-run]

Options:
  --db <path>   Path to scheduler.db. Default: gateway-data scheduler, then legacy root.
  --dry-run     Print rows that would be cleared without writing.
  -h, --help    Show this help.
EOF
}

DB_PATH=""
DRY_RUN=0
while [ $# -gt 0 ]; do
	case "$1" in
	--db)
		DB_PATH="${2:?--db requires a value}"
		shift 2
		;;
	--dry-run)
		DRY_RUN=1
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		echo "error: unknown arg: $1" >&2
		usage >&2
		exit 2
		;;
	esac
done

# Resolve default DB: gateway-data first, then legacy root.
if [ -z "$DB_PATH" ]; then
	for cand in \
		"$HOME/.omp/gateway-data/scheduler/scheduler.db" \
		"$HOME/.omp/scheduler.db"; do
		if [ -s "$cand" ]; then
			DB_PATH="$cand"
			break
		fi
	done
fi

if [ -z "$DB_PATH" ] || [ ! -f "$DB_PATH" ]; then
	echo "error: no scheduler db found (tried gateway-data + root)" >&2
	exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
	echo "error: sqlite3 not in PATH" >&2
	exit 1
fi

# Confirm the table + column exist before touching anything.
HAS_TABLE=$(sqlite3 "$DB_PATH" "SELECT 1 FROM sqlite_master WHERE type='table' AND name='executions' LIMIT 1;")
if [ "$HAS_TABLE" != "1" ]; then
	echo "error: $DB_PATH has no `executions` table" >&2
	exit 1
fi
HAS_COL=$(sqlite3 "$DB_PATH" "SELECT 1 FROM pragma_table_info('executions') WHERE name='agent_session_path' LIMIT 1;")
if [ "$HAS_COL" != "1" ]; then
	echo "error: $DB_PATH executions table has no agent_session_path column" >&2
	exit 1
fi

echo "db: $DB_PATH"
if [ "$DRY_RUN" -eq 1 ]; then
	echo "(dry-run: nothing written)"
fi

# Iterate every non-empty path, check existence, build list of stale ids.
STALE_IDS=()
while IFS=$'\t' read -r exec_id path; do
	if [ -z "$exec_id" ] || [ -z "$path" ]; then
		continue
	fi
	if [ -e "$path" ]; then
		printf 'KEEP   %s  %s\n' "$exec_id" "$path"
	else
		printf 'STALE  %s  %s\n' "$exec_id" "$path"
		STALE_IDS+=("$exec_id")
	fi
done < <(sqlite3 -separator $'\t' "$DB_PATH" \
	"SELECT id, agent_session_path FROM executions
	 WHERE agent_session_path IS NOT NULL
	   AND agent_session_path != ''
	 ORDER BY started_at;")

if [ ${#STALE_IDS[@]} -eq 0 ]; then
	echo "no stale agent_session_path rows"
	exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
	echo "would clear: ${#STALE_IDS[@]} row(s)"
	exit 0
fi

# Clear them. Each sqlite3 invocation is a separate process, so we
# cannot wrap the loop in BEGIN/COMMIT across processes — the COMMIT
# would run in a different connection and report "no transaction".
# Instead, build a single multi-statement SQL string and feed it to
# one sqlite3 invocation. That keeps the updates in one transaction
# AND makes the cleared-count tracking reliable.
if [ ${#STALE_IDS[@]} -eq 0 ]; then
	echo "no stale agent_session_path rows"
	exit 0
fi

SQL="BEGIN;"
for id in "${STALE_IDS[@]}"; do
	escaped_id=${id//\'/\'\'}
	SQL="${SQL}UPDATE executions SET agent_session_path = NULL WHERE id = '$escaped_id';"
done
SQL="${SQL}COMMIT;"

if [ "$DRY_RUN" -eq 1 ]; then
	echo "would clear: ${#STALE_IDS[@]} row(s)"
	exit 0
fi

if sqlite3 "$DB_PATH" "$SQL"; then
	echo "cleared: ${#STALE_IDS[@]} of ${#STALE_IDS[@]}"
else
	echo "error: clear failed" >&2
	exit 1
fi

# Sanity check.
REMAIN=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM executions WHERE agent_session_path IS NOT NULL AND agent_session_path != '';")
echo "remaining non-null agent_session_path rows: $REMAIN"
