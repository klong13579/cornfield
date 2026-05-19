#!/usr/bin/env bash
# Migrate global user-store OMP evolution + memory artifacts into <repo>/.omp/{memory,evolution,skills}
# and merge memory_* rows from ~/.omp/agent/agent.db into project evolution.db
set -euo pipefail

REPO_ROOT="${1:-$(pwd)}"
REPO_ROOT="$(cd "$REPO_ROOT" && pwd)"

encode_project_path() {
	local cwd="$1"
	python3 -c "import sys; p=sys.argv[1]; print('--' + p.lstrip('/').replace('/', '-').replace(':', '-') + '--')" "$cwd"
}

sqlite_opens() {
	local db="$1"
	[[ -f "$db" ]] || return 1
	sqlite3 "$db" "SELECT name FROM sqlite_master LIMIT 1;" >/dev/null 2>&1
}

copy_evolution_db_bundle() {
	local src_dir="$1" dest_db="$2"
	local src_db="${src_dir}/evolution.db"
	[[ -f "$src_db" ]] || return 1
	mkdir -p "$(dirname "$dest_db")"
	rm -f "$dest_db" "${dest_db}-shm" "${dest_db}-wal"
	cp "$src_db" "$dest_db"
	[[ -f "${src_db}-shm" ]] && cp "${src_db}-shm" "${dest_db}-shm"
	[[ -f "${src_db}-wal" ]] && cp "${src_db}-wal" "${dest_db}-wal"
	if sqlite_opens "$dest_db"; then
		sqlite3 "$dest_db" "PRAGMA wal_checkpoint(FULL);" >/dev/null 2>&1 || true
		return 0
	fi
	rm -f "$dest_db" "${dest_db}-shm" "${dest_db}-wal"
	return 1
}

try_recover_global_db() {
	local src_db="$1" dest_db="$2"
	local tmp_recovered
	tmp_recovered="$(mktemp -t evo-recovered.XXXXXX.db)"
	if sqlite3 "$src_db" ".recover" 2>/dev/null | sqlite3 "$tmp_recovered" 2>/dev/null; then
		if sqlite_opens "$tmp_recovered"; then
			sqlite3 "$tmp_recovered" ".backup '${dest_db}'"
			rm -f "$tmp_recovered"
			return 0
		fi
	fi
	rm -f "$tmp_recovered"
	return 1
}

ENCODED="$(encode_project_path "$REPO_ROOT")"
HOME_OMP="${HOME}/.omp"
LEGACY_GLOBAL="${HOME_OMP}/self-evolution"
LEGACY_MEM_FLAT="${HOME_OMP}/agent/memories/${ENCODED}"
LEGACY_MEM_STATE="${HOME_OMP}/agent/memories/state/${ENCODED}"
AGENT_DB="${HOME_OMP}/agent/agent.db"

PROJ_OMP="${REPO_ROOT}/.omp"
PROJ_MEMORY="${PROJ_OMP}/memory"
PROJ_EVOLUTION="${PROJ_OMP}/evolution"
PROJ_SKILLS="${PROJ_OMP}/skills"
DEST_DB="${PROJ_EVOLUTION}/evolution.db"

echo "Repo: ${REPO_ROOT}"
echo "Encoded global memory key: ${ENCODED}"

mkdir -p "$PROJ_MEMORY" "$PROJ_EVOLUTION" "$PROJ_SKILLS"

dir_empty() {
	local d="$1"
	[[ ! -d "$d" ]] && return 0
	[[ -z "$(ls -A "$d" 2>/dev/null)" ]]
}

copy_tree_if_empty() {
	local src="$1" dest="$2"
	if [[ ! -d "$src" ]]; then
		return 0
	fi
	if dir_empty "$dest"; then
		echo "  copy ${src} -> ${dest}"
		cp -R "${src}/." "${dest}/"
		return 0
	fi
	echo "  skip (dest not empty): ${dest}"
}

# 1) Memory markdown / rollouts
for LEGACY_MEM in "$LEGACY_MEM_FLAT" "$LEGACY_MEM_STATE"; do
	if [[ -d "$LEGACY_MEM" ]]; then
		copy_tree_if_empty "$LEGACY_MEM" "$PROJ_MEMORY"
		break
	fi
done

# 2) Global evolution.db (+ WAL) when project DB missing or unusable
need_db_copy=0
if [[ ! -f "$DEST_DB" ]]; then
	need_db_copy=1
elif ! sqlite_opens "$DEST_DB"; then
	echo "  remove corrupt project evolution.db"
	rm -f "$DEST_DB" "${DEST_DB}-shm" "${DEST_DB}-wal"
	need_db_copy=1
fi

if [[ "$need_db_copy" -eq 1 ]] && [[ -f "${LEGACY_GLOBAL}/evolution.db" ]]; then
	echo "  import evolution.db from ${LEGACY_GLOBAL}"
	if copy_evolution_db_bundle "$LEGACY_GLOBAL" "$DEST_DB"; then
		echo "  evolution.db bundle copied OK"
	elif try_recover_global_db "${LEGACY_GLOBAL}/evolution.db" "$DEST_DB"; then
		echo "  evolution.db recovered from corrupt global store (partial data possible)"
	else
		echo "  WARN: global evolution.db unreadable; will create fresh schema"
	fi
fi

# 3) Projections + logs into evolution/
for f in conventions.md system-diagnosis.md user_profile.md activity.log evolution_log.md; do
	if [[ -f "${LEGACY_GLOBAL}/${f}" ]]; then
		dest="${PROJ_EVOLUTION}/${f}"
		if [[ ! -f "$dest" ]] || [[ "${LEGACY_GLOBAL}/${f}" -nt "$dest" ]]; then
			echo "  copy ${f}"
			cp "${LEGACY_GLOBAL}/${f}" "$dest"
		fi
	fi
done

# 4) Old in-repo layout .omp/self-evolution/
OLD_PROJ="${PROJ_OMP}/self-evolution"
if [[ -d "$OLD_PROJ" ]]; then
	for f in conventions.md system-diagnosis.md user_profile.md evolution_log.md; do
		[[ -f "${OLD_PROJ}/${f}" ]] && cp "${OLD_PROJ}/${f}" "${PROJ_EVOLUTION}/${f}"
	done
	if [[ -f "${OLD_PROJ}/evolution.db" ]] && sqlite_opens "${OLD_PROJ}/evolution.db"; then
		if [[ ! -f "$DEST_DB" ]] || ! sqlite_opens "$DEST_DB"; then
			echo "  import evolution.db from in-repo .omp/self-evolution"
			copy_evolution_db_bundle "$OLD_PROJ" "$DEST_DB" || true
		fi
	fi
fi

# 5) Skills
if [[ -d "${LEGACY_GLOBAL}/skills" ]]; then
	echo "  merge skills from ${LEGACY_GLOBAL}/skills"
	mkdir -p "$PROJ_SKILLS"
	cp -Rn "${LEGACY_GLOBAL}/skills/." "$PROJ_SKILLS/" 2>/dev/null || cp -R "${LEGACY_GLOBAL}/skills/." "$PROJ_SKILLS/"
fi

# 6) Ensure schema (memory + evolution tables)
echo "  init schema via bun"
cd "${REPO_ROOT}"
if [[ -f "$DEST_DB" ]] && ! sqlite_opens "$DEST_DB"; then
	rm -f "$DEST_DB" "${DEST_DB}-shm" "${DEST_DB}-wal"
fi
REPO_ROOT="${REPO_ROOT}" bun -e "
import { getEvolutionDb, closeEvolutionDb } from './packages/self-evolution/src/storage/db.ts';
const cwd = process.env.REPO_ROOT!;
getEvolutionDb(cwd, false);
closeEvolutionDb(cwd, false);
"

# 7) Merge memory_* from agent.db into project evolution.db
if [[ -f "$AGENT_DB" ]] && [[ -f "$DEST_DB" ]] && sqlite_opens "$DEST_DB"; then
	echo "  merge memory tables from agent.db"
	sqlite3 "$DEST_DB" <<SQL
ATTACH DATABASE '${AGENT_DB}' AS agent_src;

INSERT OR IGNORE INTO threads SELECT * FROM agent_src.threads;
INSERT OR IGNORE INTO stage1_outputs SELECT * FROM agent_src.stage1_outputs;
INSERT OR REPLACE INTO jobs SELECT * FROM agent_src.jobs
  WHERE kind IN ('memory_stage1', 'memory_consolidate_global');
INSERT OR IGNORE INTO vector_embeddings SELECT * FROM agent_src.vector_embeddings;

DETACH DATABASE agent_src;
SQL
	THREADS="$(sqlite3 "$DEST_DB" "SELECT COUNT(*) FROM threads;" 2>/dev/null || echo 0)"
	echo "  threads in project db: ${THREADS}"
else
	echo "  skip agent.db merge (missing or unreadable dest db)"
fi

echo "Done."
echo "  memory:    ${PROJ_MEMORY}"
echo "  evolution: ${PROJ_EVOLUTION}"
echo "  skills:    ${PROJ_SKILLS}"
echo "  db:        ${DEST_DB}"
