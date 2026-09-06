#!/usr/bin/env bash
# zig cc wrapper for aarch64-unknown-linux-gnu cross builds.
#
# Used as CC/CXX (and as the Rust linker via
# CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER) when cross-compiling the
# pi-natives addon for linux-arm64 on a host that only has zig installed —
# no aarch64 gcc toolchain required. Zig provides the glibc sysroot.
#
# cc-rs always passes a clang-style `--target=<triple>` to CC (e.g.
# `--target=aarch64-unknown-linux-gnu`), but zig cc cannot parse the "unknown"
# vendor — it wants its own triple syntax (`aarch64-linux-gnu`). So drop any
# `--target=...` argument and always inject the zig-form target instead. Rust
# linker invocations carry no `--target` and get the same injection.
#
# Usage from build-native-linux-arm64.ts; this file is not meant to be called
# directly.
set -euo pipefail
args=()
for a in "$@"; do
	case "$a" in
		--target=*) : ;;
		*) args+=("$a") ;;
	esac
done
exec zig cc -target aarch64-linux-gnu "${args[@]}"
