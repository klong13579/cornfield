#!/usr/bin/env bash
# scripts/sweeps/abandoned-bydate.sh
#
# Delete abandoned by-date interactive session JSONLs and their empty
# artifact sidecar dirs under the OMP default sessions tree.
#
# Background: before the cron-session storage refactor, gateway cron runs
# (and legacy interactive OMP runs) leaked session files into the OMP
# default path:
#
#   ~/.omp/agent/sessions/<encoded-cwd>/by-date/<YYYY-MM-DD>/<HHMMSS>__<8hex>.jsonl
#
# The refactor moved all per-agent sessions under:
#
#   <agentDir>/sessions/<encoded-cwd>/by-date/...
#   <agentDir>/sessions/cron_<ts>.jsonl
#
# Files in the OLD location are dead weight: cron-service now uses
# findAgentSessionPath(agentDir, ...) which only scans the new tree.
# The DB's `executions.agent_session_path` for any old runs becomes stale
# on delete; that is acceptable per the explicit "no migration" decision
# recorded in the cron-session diagnosis doc.
#
# Usage:
#   scripts/sweeps/abandoned-bydate.sh --root <dir> [--date YYYY-MM-DD] [--dry-run]
#
# Examples:
#   # delete everything under ~/.omp/agent/sessions/<encoded-cwd>/by-date/
#   scripts/sweeps/abandoned-bydate.sh --root ~/.omp/agent/sessions/-Desktop-Narwal-OMP-workspace-test-hr3
#
#   # only one day
#   scripts/sweeps/abandoned-bydate.sh --root ~/.omp/agent/sessions/-Desktop-Narwal-OMP-workspace-test-hr3 --date 2026-06-30
#
#   # preview only
#   scripts/sweeps/abandoned-bydate.sh --root ~/.omp/agent/sessions/-Desktop-Narwal-OMP-workspace-test-hr3 --dry-run
#
# Notes:
#   - `--root` must be the encoded-cwd directory (the immediate parent of `by-date/`).
#   - The script is intentionally narrow: it only touches the `by-date/` subtree
#     and never deletes the top-level UUID-style sessions (those are pre-by-date
#     interactive sessions and may still be in active use).
#   - For each day-dir under by-date/, it deletes every `*.jsonl` and every
#     empty sibling dir. Non-empty artifact dirs are left alone (defensive:
#     a non-empty sidecar implies the run had real artifacts worth keeping).
set -euo pipefail

usage() {
	cat <<'EOF'
Usage: abandoned-bydate.sh --root <encoded-cwd-dir> [--date YYYY-MM-DD] [--dry-run]

Options:
  --root <path>        Encoded-cwd directory (parent of `by-date/`).
  --date YYYY-MM-DD    Restrict to a single day subdir; default = all days.
  --dry-run            Print actions without deleting.
  -h, --help           Show this help.
EOF
}

ROOT=""
DATE_FILTER=""
DRY_RUN=0
while [ $# -gt 0 ]; do
	case "$1" in
	--root)
		ROOT="${2:?--root requires a value}"
		shift 2
		;;
	--date)
		DATE_FILTER="${2:?--date requires a value}"
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

if [ -z "$ROOT" ]; then
	echo "error: --root is required" >&2
	usage >&2
	exit 2
fi

BY_DATE="$ROOT/by-date"
if [ ! -d "$BY_DATE" ]; then
	echo "error: by-date dir not found: $BY_DATE" >&2
	exit 1
fi

# Resolve target day dirs.
if [ -n "$DATE_FILTER" ]; then
	DAY_DIR="$BY_DATE/$DATE_FILTER"
	if [ ! -d "$DAY_DIR" ]; then
		echo "error: day dir not found: $DAY_DIR" >&2
		exit 1
	fi
	DAY_DIRS=("$DAY_DIR")
else
	DAY_DIRS=()
	while IFS= read -r line; do
		DAY_DIRS+=("$line")
	done < <(find "$BY_DATE" -mindepth 1 -maxdepth 1 -type d | sort)
fi

if [ ${#DAY_DIRS[@]} -eq 0 ]; then
	echo "no day dirs under $BY_DATE"
	exit 0
fi

echo "scanning ${#DAY_DIRS[@]} day dir(s) under $BY_DATE"
if [ "$DRY_RUN" -eq 1 ]; then
	echo "(dry-run: nothing deleted)"
fi

JSONL_DELETED=0
DIR_DELETED=0
for day in "${DAY_DIRS[@]}"; do
	# Delete JSONL files.
	while IFS= read -r -d '' f; do
		if [ "$DRY_RUN" -eq 1 ]; then
			printf 'would rm    %s\n' "$f"
		else
			if rm -f -- "$f"; then
				printf 'rm          %s\n' "$f"
				JSONL_DELETED=$((JSONL_DELETED + 1))
			fi
		fi
	done < <(find "$day" -maxdepth 1 -type f -name "*.jsonl" -print0)

	# Delete empty sidecar artifact dirs (siblings of the JSONLs).
	while IFS= read -r -d '' d; do
		if [ "$DRY_RUN" -eq 1 ]; then
			printf 'would rmdir %s\n' "$d"
		else
			if rmdir "$d" 2>/dev/null; then
				printf 'rmdir       %s\n' "$d"
				DIR_DELETED=$((DIR_DELETED + 1))
			else
				printf 'SKIP (not empty)  %s\n' "$d" >&2
			fi
		fi
	done < <(find "$day" -mindepth 1 -maxdepth 1 -type d -empty -print0)

	# If the day dir itself is now empty and we're not in --date filter mode,
	# try to remove it. (Skip for --date mode to keep the day's shell.)
	if [ -z "$DATE_FILTER" ] && [ -d "$day" ] && [ -z "$(ls -A "$day" 2>/dev/null || true)" ]; then
		if [ "$DRY_RUN" -eq 1 ]; then
			printf 'would rmdir %s\n' "$day"
		else
			if rmdir "$day" 2>/dev/null; then
				printf 'rmdir       %s (empty day dir)\n' "$day"
				DIR_DELETED=$((DIR_DELETED + 1))
			fi
		fi
	fi
done

if [ "$DRY_RUN" -eq 0 ]; then
	echo "deleted: $JSONL_DELETED jsonl, $DIR_DELETED empty dir(s)"
fi
