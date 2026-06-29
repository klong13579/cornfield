#!/usr/bin/env bash
# scripts/sweeps/empty-cron-dirs.sh
#
# Delete empty `cron_<id>/` artifact directories under an agent's sessions
# directory. These are sibling dirs that the cron lifecycle created next to
# `cron_<id>.jsonl` files (the artifact sidecar convention) but were never
# populated. Safe to remove: empty dirs have no DB references and no content.
#
# Usage:
#   scripts/sweeps/empty-cron-dirs.sh --agent-dir <path> [--dry-run]
#
# Examples:
#   scripts/sweeps/empty-cron-dirs.sh --agent-dir ~/.omp/agents/hr
#   scripts/sweeps/empty-cron-dirs.sh --agent-dir ~/.omp/agents/hr --dry-run
#
# Notes:
#   - Only matches the strict `cron_*` glob under `<agentDir>/sessions/`.
#     Real interactive session dirs (named `cron_<id>/` would never exist)
#     and any unrelated sibling dirs are left alone.
#   - Skips dirs that contain anything (JSONL, files, etc.) — even non-empty
#     `cron_<id>/` siblings of valid runs are left untouched.
#   - Emits one line per action: target path + reason.
set -euo pipefail

usage() {
	cat <<'EOF'
Usage: empty-cron-dirs.sh --agent-dir <path> [--dry-run]

Options:
  --agent-dir <path>   Agent directory (containing a `sessions/` subdir).
  --dry-run            Print actions without deleting.
  -h, --help           Show this help.
EOF
}

AGENT_DIR=""
DRY_RUN=0
while [ $# -gt 0 ]; do
	case "$1" in
	--agent-dir)
		AGENT_DIR="${2:?--agent-dir requires a value}"
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

if [ -z "$AGENT_DIR" ]; then
	echo "error: --agent-dir is required" >&2
	usage >&2
	exit 2
fi

SESSIONS_DIR="$AGENT_DIR/sessions"
if [ ! -d "$SESSIONS_DIR" ]; then
	echo "error: sessions dir not found: $SESSIONS_DIR" >&2
	exit 1
fi

# Find all `cron_*` dirs that are directly under sessions/ and are empty.
# -mindepth 1 + -maxdepth 1 limits to the immediate children of sessions/.
# -empty excludes any non-empty dirs.
# Use a here-string + while loop instead of `mapfile` for bash 3.2 compat.
TARGETS=()
while IFS= read -r line; do
	TARGETS+=("$line")
done < <(find "$SESSIONS_DIR" -mindepth 1 -maxdepth 1 -type d -name "cron_*" -empty | sort)

if [ ${#TARGETS[@]} -eq 0 ]; then
	echo "no empty cron_* dirs under $SESSIONS_DIR"
	exit 0
fi

echo "found ${#TARGETS[@]} empty cron_* dirs under $SESSIONS_DIR"
if [ "$DRY_RUN" -eq 1 ]; then
	echo "(dry-run: nothing deleted)"
fi

DELETED=0
for d in "${TARGETS[@]}"; do
	if [ "$DRY_RUN" -eq 1 ]; then
		printf 'would rmdir  %s\n' "$d"
	else
		if rmdir "$d" 2>/dev/null; then
			printf 'rmdir        %s\n' "$d"
			DELETED=$((DELETED + 1))
		else
			printf 'SKIP (not empty?)  %s\n' "$d" >&2
		fi
	fi
done

if [ "$DRY_RUN" -eq 0 ]; then
	echo "deleted: $DELETED"
fi
