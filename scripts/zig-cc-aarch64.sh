#!/usr/bin/env bash
# zig cc wrapper for aarch64-unknown-linux-gnu cross builds.
#
# Used as CC/CXX (and as the Rust linker via
# CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER) when cross-compiling the
# pi-natives addon for linux-arm64 on a host that only has zig installed —
# no aarch64 gcc toolchain required. Zig provides the glibc sysroot.
#
# Usage from build-native-linux-arm64.ts; this file is not meant to be called
# directly.
set -euo pipefail
exec zig cc -target aarch64-linux-gnu "$@"
