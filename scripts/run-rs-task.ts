#!/usr/bin/env bun

import { $ } from "bun";
import * as path from "node:path";

const RUST_AFFECTING_FILE_NAMES = [
	"Cargo.toml",
	"Cargo.lock",
	"build.rs",
	"rust-toolchain",
	"rust-toolchain.toml",
	"clippy.toml",
	".clippy.toml",
	"rustfmt.toml",
	".rustfmt.toml",
] as const satisfies readonly string[];
type RustTaskName = "check:rs" | "fix:rs" | "fmt:rs" | "lint:rs" | "test:rs";

const RUST_TASK_NAMES: readonly RustTaskName[] = ["check:rs", "fix:rs", "fmt:rs", "lint:rs", "test:rs"];

/**
 * Commands for a Rust task, scoped to explicit workspace members.
 *
 * Why not the workspace-wide form (`fmt --all` / `clippy --workspace` /
 * `nextest run --workspace`): those FAIL inside a `git worktree` of this
 * repository. Cargo re-discovers the vendored crates under `crates/` and
 * resolves them against the MAIN checkout's workspace:
 *
 *   current package believes it's in a workspace when it's not:
 *   current:   <worktree>/crates/brush-builtins-vendored/Cargo.toml
 *   workspace: <main>/Cargo.toml
 *
 * Measured 2026-09-11 in two different worktrees, on a branch that does not
 * touch the root manifest; the same command passes in the main checkout.
 *
 * The per-member form is equivalent — a workspace-wide flag means "all
 * members", and this workspace's only member is `cornfield-natives`
 * (`members = ["crates/*"]` minus three `exclude` entries) — and it runs both
 * in the main checkout and in worktrees.
 */
function rustCommands(task: RustTaskName, members: readonly string[]): string[][] {
	const fmtCheck = members.map((name) => ["cargo", "fmt", "-p", name, "--", "--check"]);
	const clippyCheck = members.map((name) => ["cargo", "clippy", "-p", name, "--", "-D", "warnings"]);
	switch (task) {
		case "check:rs":
			return [...fmtCheck, ...clippyCheck];
		case "fmt:rs":
			return members.map((name) => ["cargo", "fmt", "-p", name]);
		case "lint:rs":
			return clippyCheck;
		case "fix:rs":
			return [
				...members.map((name) => ["cargo", "fmt", "-p", name]),
				...members.map((name) => [
					"cargo",
					"clippy",
					"-p",
					name,
					"--fix",
					"--allow-dirty",
					"--no-deps",
					"--allow-staged",
					"--allow-no-vcs",
				]),
			];
		case "test:rs":
			return members.map((name) => [
				"cargo",
				"nextest",
				"run",
				"-p",
				name,
				"--status-level=fail",
				"--final-status-level=fail",
			]);
	}
}

/**
 * Workspace member names. `--no-deps` keeps this cheap and worktree-safe
 * (it does not resolve the dependency graph, so it avoids the vendored-crate
 * workspace problem above).
 */
async function workspaceMemberNames(): Promise<string[] | null> {
	const result = await $`cargo metadata --no-deps --format-version 1`.cwd(repoRoot).quiet().nothrow();
	if (result.exitCode !== 0) return null;
	try {
		const parsed = JSON.parse(result.stdout.toString()) as { packages?: Array<{ name?: unknown }> };
		const names = (parsed.packages ?? [])
			.map((entry) => entry.name)
			.filter((name): name is string => typeof name === "string" && name !== "");
		return names.length > 0 ? names : null;
	} catch {
		return null;
	}
}

const repoRoot = path.join(import.meta.dir, "..");
const taskName = process.argv[2];

if (!isRustTaskName(taskName)) {
	console.error(`Unknown Rust task: ${taskName ?? "(missing)"}`);
	process.exit(1);
}

if (!(isCI() || (await hasRustAffectingChanges()))) {
	console.log(`Skipping ${taskName} (not in CI and no Rust-affecting changes were found).`);
	process.exit(0);
}

for (const command of await rustCommandsFor(taskName)) {
	console.log(`$ ${command.join(" ")}`);
	const exitCode = await runCommand(command);
	if (exitCode !== 0) {
		process.exit(exitCode);
	}
}

async function rustCommandsFor(task: RustTaskName): Promise<string[][]> {
	const members = await workspaceMemberNames();
	if (members === null) {
		console.error(
			"Failed to enumerate workspace members (cargo metadata --no-deps) — cannot run the Rust checks, refusing to report success.",
		);
		process.exit(1);
	}
	return rustCommands(task, members);
}

function isRustTaskName(value: string | undefined): value is RustTaskName {
	return value != null && (RUST_TASK_NAMES as readonly string[]).includes(value);
}

function isCI(): boolean {
	const value = Bun.env.CI;
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false";
}

async function hasRustAffectingChanges(): Promise<boolean> {
	const uncommitted = await uncommittedPaths();
	if (uncommitted === null) {
		console.warn(`Warning: failed to inspect git status. Running ${taskName} conservatively.`);
		return true;
	}
	if (uncommitted.some(isRustAffectingPath)) return true;

	// `git status` only sees the working tree. A change that was already COMMITTED
	// was therefore invisible here, and the Rust checks were skipped silently while
	// printing a green result (measured 2026-09-11: a worktree whose commit touched
	// crates/pi-natives/src/grep.rs reported "no Rust-affecting changes"). Diff the
	// branch against its base as well: a false run costs a minute, a false skip ships
	// broken Rust.
	const committed = await committedPathsSinceBase();
	if (committed === null) {
		console.warn(
			`Warning: no base ref (@{u}/origin/main/main) to diff against, so committed Rust changes cannot be ruled out. Running ${taskName} conservatively.`,
		);
		return true;
	}
	return committed.some(isRustAffectingPath);
}

async function uncommittedPaths(): Promise<string[] | null> {
	const result = await $`git status --porcelain -z`.cwd(repoRoot).quiet().nothrow();
	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString().trim();
		console.warn(`Warning: failed to inspect git status: ${stderr === "" ? `exit ${result.exitCode}` : stderr}.`);
		return null;
	}
	return getChangedPathsFromPorcelain(result.stdout);
}

async function resolveBaseRef(): Promise<string | null> {
	for (const ref of ["@{u}", "origin/HEAD", "origin/main", "main"]) {
		const probe = await $`git rev-parse --verify --quiet ${ref}`.cwd(repoRoot).quiet().nothrow();
		if (probe.exitCode === 0 && probe.stdout.toString().trim() !== "") return ref;
	}
	return null;
}

async function committedPathsSinceBase(): Promise<string[] | null> {
	const base = await resolveBaseRef();
	if (base === null) return null;
	const diff = await $`git diff --name-only -z ${`${base}...HEAD`}`.cwd(repoRoot).quiet().nothrow();
	if (diff.exitCode !== 0) return null;
	return new TextDecoder().decode(diff.stdout).split("\0").filter(Boolean);
}

function getChangedPathsFromPorcelain(buf: Uint8Array): string[] {
	const entries = new TextDecoder().decode(buf).split("\0").filter(Boolean);
	const changedPaths: string[] = [];

	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry.length < 4) continue;

		const status = entry.slice(0, 2);
		const changedPath = entry.slice(3);
		if (changedPath !== "") {
			changedPaths.push(changedPath);
		}

		if (status.includes("R") || status.includes("C")) {
			const renamedPath = entries[index + 1];
			if (renamedPath) {
				changedPaths.push(renamedPath);
				index += 1;
			}
		}
	}

	return changedPaths;
}

function isRustAffectingPath(changedPath: string): boolean {
	const normalized = changedPath.replace(/\\/g, "/");
	const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
	return (
		normalized.endsWith(".rs") ||
		normalized.startsWith(".cargo/") ||
		isOneOf(fileName, RUST_AFFECTING_FILE_NAMES)
	);
}

function isOneOf<T extends string>(value: string, values: readonly T[]): value is T {
	return values.some(entry => entry === value);
}

async function runCommand(command: readonly string[]): Promise<number> {
	const proc = Bun.spawn([...command], {
		cwd: repoRoot,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	return proc.exited;
}
