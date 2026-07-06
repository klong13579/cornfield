#!/usr/bin/env bash
# omp agent validate — deterministic checks runner
# Usage: bash validate.sh <agentDir> [--fix]
# Outputs structured results to stdout:  LEVEL:FILE:MESSAGE
set -euo pipefail

AGENT_DIR="${1:?Usage: validate.sh <agentDir> [--fix]}"
FIX="${2:-}"
PASS=0
FAIL=0
WARN=0

error()   { echo "ERROR:$1:$2";   ((FAIL++)) || true; }
warn()    { echo "WARN:$1:$2";    ((WARN++)) || true; }
pass()    { ((PASS++)) || true; }
fix_msg() { echo "FIXED:$1:$2"; }

# ---------- helpers ----------
file_contains()       { grep -qF -- "$1" "$2" 2>/dev/null; }
file_contains_re()    { grep -qE -- "$1" "$2" 2>/dev/null; }
file_matches()        { grep -nF -- "$1" "$2" 2>/dev/null || true; }
file_matches_re()     { grep -nE -- "$1" "$2" 2>/dev/null || true; }
strip_constraint()    { sed 's/^-[[:space:]]*\(MUST NOT\|NEVER\)[[:space:]]\+//i' <<< "$1" | xargs; }

# ── Always-on files ──────────────────────────────────────────────────
for f in AGENTS.md mission.md TOOLS.md TODO.md knowledge/external-workspaces.md; do
  [ -f "$AGENT_DIR/$f" ] && pass || error "$f" "Missing always-on file"
done

# ── Runtime deps ──────────────────────────────────────────────────────
[ -f "$AGENT_DIR/.omp/config.yml" ] && pass || error ".omp/config.yml" "Missing runtime hard dependency"
for f in prompt-includes.json .gitignore .omp/SYSTEM.md; do
  [ -f "$AGENT_DIR/$f" ] && pass || warn "$f" "Missing recommended runtime file"
done

# ── Format: prompt-includes.json ─────────────────────────────────────
JSON_FILE="$AGENT_DIR/prompt-includes.json"
if [ -f "$JSON_FILE" ]; then
  if python3 -c "
import json, sys
with open('$JSON_FILE') as f:
    d = json.load(f)
if not isinstance(d.get('files'), list):
    sys.exit(1)
" 2>/dev/null; then
    pass
  else
    error "prompt-includes.json" "Invalid JSON or missing top-level 'files' array"
  fi
fi

# ── Format: .omp/config.yml ──────────────────────────────────────────
YML_FILE="$AGENT_DIR/.omp/config.yml"
if [ -f "$YML_FILE" ]; then
  if python3 -c "import yaml" 2>/dev/null; then
    if python3 -c "
import sys, yaml
try:
    with open('$YML_FILE') as f:
        yaml.safe_load(f)
except Exception:
    sys.exit(1)
" 2>/dev/null; then
      pass
    else
      error ".omp/config.yml" "Invalid YAML"
    fi
  elif python3 -c "
import sys, json
try:
    with open('$YML_FILE') as f:
        json.load(f)
except Exception:
    sys.exit(1)
" 2>/dev/null; then
    pass
  elif [ -s "$YML_FILE" ]; then
    pass
  else
    warn ".omp/config.yml" "Empty file (skipped deep YAML validation — PyYAML not available)"
  fi
fi

# ── Helper: delete lines matching patterns from a file ────────────────
remove_lines_with() {
  local file="$1"; shift
  local tmp=$(mktemp)
  cp "$file" "$tmp"
  for pat; do
      grep -vF -- "$pat" "$tmp" > "${tmp}2" && mv "${tmp}2" "$tmp"
    done
  cat "$tmp"
  rm -f "$tmp" "${tmp}2"
}

insert_after_heading() {
  local file="$1" heading_re="$2" text="$3"
  awk -v heading="$heading_re" -v ins="$text" '
    $0 ~ heading && !inserted { print; print ""; print ins; inserted=1; next }
    { print }
    END { if (!inserted) print ins }
  ' "$file"
}

# ── MECE R1: No skeleton placeholder residue ─────────────────────────
R1_PATS=(
  '⚠️**请编辑本文件'
  '⚠️ **请编辑本文件'
  '<机器人名>'
  '> Append project-specific tools here'
  '- [ ] 任务'
  'YYYY-MM-DD HH:MM'
)
R1_FILES=(AGENTS.md mission.md TOOLS.md TODO.md .omp/SYSTEM.md knowledge/external-workspaces.md)
for f in "${R1_FILES[@]}"; do
  full="$AGENT_DIR/$f"
  [ -f "$full" ] || continue
  for pat in "${R1_PATS[@]}"; do
    while IFS=: read -r line_no match; do
      [ -z "$line_no" ] && continue
      warn "$f" "R1 skeleton placeholder (line $line_no): ${match:0:60}"
    done < <(file_matches "$pat" "$full")
  done
  if [ -n "$FIX" ]; then
    content=$(cat "$full")
    new=$(remove_lines_with "$full" "${R1_PATS[@]}")
    [ "$new" != "$content" ] && echo "$new" > "$full" && fix_msg "$f" "R1 removed skeleton placeholders"
  fi
done

# ── MECE R2: No tool list in mission.md ──────────────────────────────
MISSION="$AGENT_DIR/mission.md"
[ -f "$MISSION" ] || true
if [ -f "$MISSION" ]; then
  R2_RE='^-[[:space:]]+使用[[:space:]]+`(read|search|find|bash|write|edit|ast_grep|ast_edit|lsp|grep)`[[:space:]]'
  while IFS=: read -r line_no content; do
    [ -z "$line_no" ] && continue
    echo "$content" | grep -qiE 'TOOLS\.md|不重复工具|工具.*TOOLS' && continue
    warn "mission.md" "R2 tool list (line $line_no, belongs in TOOLS.md): ${content:0:60}"
  done < <(file_matches_re "$R2_RE" "$MISSION")
  if [ -n "$FIX" ]; then
    content=$(cat "$MISSION")
    filtered=$(grep -vE "$R2_RE" <<< "$content" || true)
    if ! grep -qi 'TOOLS\.md' <<< "$filtered"; then
      REF='- 工具使用规则见 `TOOLS.md`（always-on），此处不重复。'
      filtered=$(awk -v ref="$REF" '
        /^##[[:space:]]*工具/ { print; print ""; print ref; next }
        { print }
      ' <<< "$filtered")
    fi
    echo "$filtered" > "$MISSION" && fix_msg "mission.md" "R2 replaced tool list with TOOLS.md reference"
  fi
fi

# ── MECE R3: No hard constraint duplication in SYSTEM.md ──────────────
AGENTS_FILE="$AGENT_DIR/AGENTS.md"
SYSTEM_FILE="$AGENT_DIR/.omp/SYSTEM.md"
extract_hard_constraints() {
  awk '
    /^##.*[Hh]ard.*[Cc]onstraint/ { in_hard=1; next }
    in_hard && /^##/ { in_hard=0 }
    in_hard && /^-[[:space:]]*(MUST NOT|NEVER)[[:space:]]/ { print }
  ' "$1"
}
if [ -f "$AGENTS_FILE" ] && [ -f "$SYSTEM_FILE" ]; then
  HARD_LINES=$(extract_hard_constraints "$AGENTS_FILE")
  if [ -n "$HARD_LINES" ]; then
    while IFS= read -r agents_line; do
      [ -z "$agents_line" ] && continue
      ag_norm=$(strip_constraint "$agents_line")
      while IFS=: read -r line_no sys_line; do
        [ -z "$line_no" ] && continue
        sys_norm=$(strip_constraint "$sys_line")
        [ "$ag_norm" != "$sys_norm" ] && continue
        warn ".omp/SYSTEM.md" "R3 duplicates AGENTS.md hard constraint (line $line_no): ${sys_line:0:60}"
        if [ -n "$FIX" ]; then
          content=$(cat "$SYSTEM_FILE")
          filtered=$(grep -vF -- "$sys_line" <<< "$content" || true)
          if ! grep -qiE 'AGENTS\.md.*hard|hard.*AGENTS\.md|硬约束' <<< "$filtered"; then
            REF='> 硬约束见 `AGENTS.md`，此处不重复。'
            filtered=$(awk -v ref="$REF" '
              /^##[[:space:]]*安全/ { print; print ""; print ref; next }
              { print }
            ' <<< "$filtered")
          fi
          echo "$filtered" > "$SYSTEM_FILE" && fix_msg ".omp/SYSTEM.md" "R3 removed duplicated hard constraint"
        fi
      done < <(file_matches_re '^-[[:space:]]*(MUST NOT|NEVER)[[:space:]]' "$SYSTEM_FILE")
    done <<< "$HARD_LINES"
  fi
fi

# ── MECE R4: No alidocs URLs in mission.md ───────────────────────────
if [ -f "$MISSION" ]; then
  while IFS=: read -r line_no content; do
    [ -z "$line_no" ] && continue
    warn "mission.md" "R4 alidocs URL in mission.md (line $line_no, belongs in external-workspaces.md): ${content:0:60}"
  done < <(file_matches_re 'alidocs\.dingtalk\.com' "$MISSION")
  if [ -n "$FIX" ]; then
    content=$(cat "$MISSION")
    filtered=$(grep -v 'alidocs\.dingtalk\.com' <<< "$content" || true)
    if ! grep -qi 'external-workspaces\.md' <<< "$filtered"; then
      REF='> 完整数据源 URL 见 `knowledge/external-workspaces.md`。'
      filtered=$(awk -v ref="$REF" '
        /^##[[:space:]]*知识库/ { print; print ""; print ref; next }
        { print }
      ' <<< "$filtered")
    fi
    echo "$filtered" > "$MISSION" && fix_msg "mission.md" "R4 removed alidocs URLs, added external-workspaces.md reference"
  fi
fi

# ── MECE R5: No dws commands in TOOLS.md ──────────────────────────────
TOOLS_FILE="$AGENT_DIR/TOOLS.md"
if [ -f "$TOOLS_FILE" ]; then
  while IFS=: read -r line_no content; do
    [ -z "$line_no" ] && continue
    echo "$content" | grep -qiE 'MUST|NEVER' && continue
    warn "TOOLS.md" "R5 dws command in TOOLS.md (line $line_no, belongs in skill://dws): ${content:0:60}"
  done < <(file_matches_re '^[[:space:]-]*`?dws[[:space:]]+[a-zA-Z]+[[:space:]]+[a-zA-Z]+' "$TOOLS_FILE")
  if [ -n "$FIX" ]; then
    content=$(cat "$TOOLS_FILE")
    filtered=$(grep -vE '^[[:space:]-]*`?dws[[:space:]]+[a-zA-Z]+[[:space:]]+[a-zA-Z]+' <<< "$content" | grep -viE 'MUST|NEVER' || true)
    if ! grep -qi 'skill://dws' <<< "$filtered"; then
      REF='- 完整命令速查见 `skill://dws`。'
      filtered=$(awk -v ref="$REF" '
        /^###[[:space:]]*`dws`/ { print; print ""; print ref; next }
        { print }
      ' <<< "$filtered")
    fi
    echo "$filtered" > "$TOOLS_FILE" && fix_msg "TOOLS.md" "R5 removed dws commands, added skill://dws reference"
  fi
fi

# ── MECE R6: Skills path format in AGENTS.md ──────────────────────────
if [ -f "$AGENTS_FILE" ]; then
  if file_contains '.omp/skills/<name>.md' "$AGENTS_FILE"; then
    warn "AGENTS.md" "R6 uses old skills path format: .omp/skills/<name>.md (should be <name>/SKILL.md)"
    if [ -n "$FIX" ]; then
      sed -i '' 's|\.omp/skills/<name>\.md|.omp/skills/<name>/SKILL.md|g' "$AGENTS_FILE"
      fix_msg "AGENTS.md" "R6 fixed skills path format"
    fi
  fi
fi

# ── MECE R7: File Map accuracy ────────────────────────────────────────
if [ -f "$AGENTS_FILE" ]; then
  in_map=0
  while IFS= read -r line; do
    case "$line" in
      "## "*|"##	"*) in_map=0;;
    esac
    echo "$line" | grep -qi '^##.*[Ff]ile.*[Mm]ap' && { in_map=1; continue; } || true
    [ "$in_map" != 1 ] && continue
    map_path=$(echo "$line" | sed -n 's/^|[[:space:]]*`\([^`]\+\)`[[:space:]]*|.*/\1/p' 2>/dev/null || true)
    [ -z "$map_path" ] && continue
    echo "$map_path" | grep -q '[*<]' && continue
    echo "$map_path" | grep -qi '(optional\|可选)' && continue
    [ -e "$AGENT_DIR/$map_path" ] || warn "AGENTS.md" "R7 File Map lists \"$map_path\" but file does not exist"
  done < "$AGENTS_FILE"
fi

# ── MECE R8: No deprecated .agent/ directory ─────────────────────────
if [ -d "$AGENT_DIR/.agent" ]; then
  error ".agent/" "Deprecated directory exists (use .omp/ instead)"
  [ -n "$FIX" ] && rm -rf "$AGENT_DIR/.agent" && fix_msg ".agent/" "R8 removed deprecated directory"
fi
if [ -f "$AGENTS_FILE" ]; then
  while IFS=: read -r line_no content; do
    [ -z "$line_no" ] && continue
    warn "AGENTS.md" "R8 references deprecated .agent/ path (line $line_no): ${content:0:60}"
  done < <(file_matches_re '\.agent/' "$AGENTS_FILE")
  if [ -n "$FIX" ]; then
    sed -i '' 's|\.agent/|.omp/|g' "$AGENTS_FILE"
    fix_msg "AGENTS.md" "R8 replaced .agent/ references with .omp/"
  fi
fi

# ── Summary ────────────────────────────────────────────────────────────
echo "---"
echo "PASS:$PASS FAIL:$FAIL WARN:$WARN"
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
