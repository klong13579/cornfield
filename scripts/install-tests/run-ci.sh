#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT_DIR="$(pwd)"
WORK_DIR="$(mktemp -d)"
TMP_WORK_DIR="$WORK_DIR/tmp"
mkdir -p "$TMP_WORK_DIR"
export TMPDIR="$TMP_WORK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

section() {
	echo ""
	echo "=== $1 ==="
}

smoke_cli() {
	local omp_bin="$1"
	local runtime_dir
	runtime_dir="$(mktemp -d "$WORK_DIR/compiled-runtime.XXXXXX")"
	XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$omp_bin" --version
	XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$omp_bin" --help >/dev/null
	XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$omp_bin" stats --summary >/dev/null
}

find_tarball() {
	local pattern="$1"
	local matches=()
	shopt -s nullglob
	matches=("$pattern")
	shopt -u nullglob

	if [ "${#matches[@]}" -ne 1 ]; then
		echo "Expected exactly one tarball matching: $pattern"
		exit 1
	fi

	echo "${matches[0]}"
}

section "Binary install smoke"
bun --cwd=packages/natives run build
bun --cwd=packages/coding-agent run build

BINARY_DIR="$WORK_DIR/binary-bin"
mkdir -p "$BINARY_DIR"
cp packages/coding-agent/dist/omp "$BINARY_DIR/omp"
smoke_cli "$BINARY_DIR/omp"

section "Source install smoke"
SOURCE_BUN_HOME="$WORK_DIR/bun-source"
(
	export BUN_INSTALL="$SOURCE_BUN_HOME"
	export PATH="$BUN_INSTALL/bin:$PATH"
	bun --cwd="$ROOT_DIR/packages/coding-agent" link
	smoke_cli "$BUN_INSTALL/bin/omp"
)

section "Tarball install smoke"
TARBALL_DIR="$WORK_DIR/tarballs"
mkdir -p "$TARBALL_DIR"
# The 7 npm-published packages plus the internal-only packages in their
# dependency closure (pi-wire / pi-client / omp-gateway / self-evolution /
# moa-extension are never published to npm — they ship inside binaries,
# the gateway, and the desktop app). Without an override for every
# @oh-my-pi/* dep, `bun add <tarball>` resolves the unpublished ones from
# the registry at the current version and 404s mid-release.
for pkg in utils natives ai agent tui stats coding-agent pi-wire pi-client omp-gateway self-evolution moa-extension cognitive-coordination; do
	(
		cd "$ROOT_DIR/packages/$pkg"
		bun pm pack --destination "$TARBALL_DIR" --quiet >/dev/null
	)
done

utils_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-utils-*.tgz)"
natives_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-natives-*.tgz)"
ai_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-ai-*.tgz)"
agent_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-agent-core-*.tgz)"
tui_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-tui-*.tgz)"
stats_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-omp-stats-*.tgz)"

coding_agent_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-coding-agent-*.tgz)"
wire_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-wire-*.tgz)"
client_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-client-*.tgz)"
gateway_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-omp-gateway-*.tgz)"
self_evolution_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-self-evolution-*.tgz)"
moa_extension_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-moa-extension-*.tgz)"
cognitive_coordination_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-cognitive-coordination-*.tgz)"

TARBALL_APP_DIR="$WORK_DIR/tarball-install"
mkdir -p "$TARBALL_APP_DIR"
(
	cd "$TARBALL_APP_DIR"
	bun init -y >/dev/null

	# Write overrides so bun resolves inter-package deps from tarballs, not the registry
	# (version 12.x.y hasn't been published yet when CI runs pre-release)
	node -e "
		const pkg = JSON.parse(require('fs').readFileSync('package.json', 'utf8'));
		pkg.overrides = {
			'@oh-my-pi/pi-utils': '$utils_tgz',
			'@oh-my-pi/pi-natives': '$natives_tgz',
			'@oh-my-pi/pi-ai': '$ai_tgz',
			'@oh-my-pi/pi-agent-core': '$agent_tgz',
			'@oh-my-pi/pi-tui': '$tui_tgz',
			'@oh-my-pi/omp-stats': '$stats_tgz',
			'@oh-my-pi/pi-coding-agent': '$coding_agent_tgz',
			'@oh-my-pi/pi-wire': '$wire_tgz',
			'@oh-my-pi/pi-client': '$client_tgz',
			'@oh-my-pi/omp-gateway': '$gateway_tgz',
			'@oh-my-pi/self-evolution': '$self_evolution_tgz',
			'@oh-my-pi/moa-extension': '$moa_extension_tgz',
			'@oh-my-pi/cognitive-coordination': '$cognitive_coordination_tgz'
		};
		require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2));
	"

	bun add "$utils_tgz" "$natives_tgz" "$ai_tgz" "$agent_tgz" "$tui_tgz" "$stats_tgz" "$coding_agent_tgz" "$wire_tgz" "$client_tgz" "$gateway_tgz" "$self_evolution_tgz" "$moa_extension_tgz" "$cognitive_coordination_tgz"
	smoke_cli ./node_modules/.bin/omp
)

echo ""
echo "All install method smoke tests passed"
