#!/usr/bin/env bun
/**
 * Release script for pi-mono
 *
 * Usage:
 *   bun scripts/release.ts <version>   Full release (version, changelog, commit, push, watch)
 *   bun scripts/release.ts watch       Watch CI for current commit
 *   bun scripts/release.ts <version> --skip-main-check   Skip the "latest main CI is green" gate (emergency only)
 *
 * Flow: bump → commit → push main → dispatch the release run → watch it.
 * The run builds the artifacts and creates the tag and the GitHub Release in
 * its last step (`softprops/action-gh-release`, with target_commitish pinned to
 * the commit the run built). Nothing is tagged or published unless the whole
 * run goes green — a strictly stronger gate than tagging first, at half the
 * wall time: the preflight dry run this script used to perform was the same
 * matrix, run a second time.
 *
 * Example: bun scripts/release.ts 3.10.0
 */

import { $, Glob } from "bun";
import { bumpRepoVersions } from "./version-bump";

const changelogGlob = new Glob("packages/*/CHANGELOG.md");
const cargoTomlGlob = new Glob("crates/*/Cargo.toml");

function git(args: readonly string[]) {
	return $`git -c core.fsmonitor=false -c core.untrackedCache=false ${args}`;
}

// =============================================================================
// Shared functions
// =============================================================================

async function watchCI(): Promise<boolean> {
	const commitSha = (await git(["rev-parse", "HEAD"]).text()).trim();
	console.log(`  Commit: ${commitSha.slice(0, 8)}`);

	while (true) {
		const runsOutput = await $`gh run list --commit ${commitSha} --json databaseId,status,conclusion,name`.text();
		const runs: Array<{ databaseId: number; status: string; conclusion: string | null; name: string }> =
			JSON.parse(runsOutput);

		if (runs.length === 0) {
			console.log("  Waiting for CI to start...");
			await Bun.sleep(3000);
			continue;
		}

		// Check job-level status for in-progress runs (fail fast on first job failure)
		const failedJobs: Array<{ workflow: string; job: string; jobId: number; conclusion: string }> = [];
		const inProgressRuns = runs.filter((r) => r.status === "in_progress" || r.status === "queued");

		for (const run of inProgressRuns) {
			const jobsOutput =
				await $`gh run view ${run.databaseId} --json jobs`.quiet().nothrow().text();
			try {
				const { jobs } = JSON.parse(jobsOutput) as {
					jobs: Array<{ name: string; databaseId: number; status: string; conclusion: string | null }>;
				};
				for (const job of jobs) {
					if (job.status === "completed" && job.conclusion !== "success" && job.conclusion !== "skipped" && job.conclusion !== "cancelled") {
						failedJobs.push({
							workflow: run.name,
							job: job.name,
							jobId: job.databaseId,
							conclusion: job.conclusion ?? "unknown",
						});
					}
				}
			} catch {
				// Ignore parse errors
			}
		}

		if (failedJobs.length > 0) {
			console.error("\nCI job failed:");
			for (const f of failedJobs) {
				console.error(`  - ${f.workflow} / ${f.job} (job ${f.jobId}): ${f.conclusion}`);
				// Tail the failed job's log
				const log = await $`gh run view --job ${f.jobId} --log-failed`.quiet().nothrow().text();
				if (log.trim()) {
					const lines = log.trimEnd().split("\n");
					const tail = lines.slice(-20).join("\n");
					console.error(`\n--- Last 20 lines of ${f.job} ---\n${tail}\n`);
				}
			}
			return false;
		}

		// Check workflow-level status
		const pending = runs.filter((r) => r.status !== "completed");
		const failed = runs.filter((r) => r.status === "completed" && r.conclusion !== "success" && r.conclusion !== "cancelled");
		const passed = runs.filter((r) => r.status === "completed" && r.conclusion === "success");

		console.log(`  ${passed.length} passed, ${pending.length} pending, ${failed.length} failed`);

		if (failed.length > 0) {
			console.error("\nCI failed:");
			for (const r of failed) {
				console.error(`  - ${r.name}: ${r.conclusion}`);
				// Fetch failed jobs and tail their logs
				const jobsOutput = await $`gh run view ${r.databaseId} --json jobs`.quiet().nothrow().text();
				try {
					const { jobs } = JSON.parse(jobsOutput) as {
						jobs: Array<{ name: string; databaseId: number; status: string; conclusion: string | null }>;
					};
					for (const job of jobs) {
						if (job.conclusion !== "success" && job.conclusion !== "skipped" && job.conclusion !== "cancelled") {
							const log = await $`gh run view --job ${job.databaseId} --log-failed`.quiet().nothrow().text();
							if (log.trim()) {
								const lines = log.trimEnd().split("\n");
								const tail = lines.slice(-20).join("\n");
								console.error(`\n--- Last 20 lines of ${job.name} (job ${job.databaseId}) ---\n${tail}\n`);
							}
						}
					}
				} catch {
					// Ignore parse errors
				}
			}
			return false;
		}

		if (pending.length === 0) {
			console.log("  All CI checks passed!\n");
			return true;
		}

		await Bun.sleep(5000);
	}
}

function hasUnreleasedContent(content: string): boolean {
	const unreleasedMatch = content.match(/## \[Unreleased\]\s*\n([\s\S]*?)(?=## \[\d|$)/);
	if (!unreleasedMatch) return false;
	const sectionContent = unreleasedMatch[1].trim();
	return sectionContent.length > 0;
}

function removeEmptyVersionEntries(content: string): string {
	// Remove version entries that have no content (just whitespace until next ## [ or EOF)
	return content.replace(/## \[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}\s*\n(?=## \[|\s*$)/g, "");
}

async function updateChangelogsForRelease(version: string): Promise<void> {
	const date = new Date().toISOString().split("T")[0];

	for await (const changelog of changelogGlob.scan(".")) {
		let content = await Bun.file(changelog).text();

		if (!content.includes("## [Unreleased]")) {
			console.log(`  Skipping ${changelog}: no [Unreleased] section`);
			continue;
		}

		// Only create version entry if [Unreleased] has content
		if (hasUnreleasedContent(content)) {
			content = content.replace("## [Unreleased]", `## [${version}] - ${date}`);
			content = content.replace(/^(# Changelog\n\n)/, `$1## [Unreleased]\n\n`);
		}

		// Clean up any existing empty version entries
		content = removeEmptyVersionEntries(content);

		await Bun.write(changelog, content);
		console.log(`  Updated ${changelog}`);
	}
}

// =============================================================================
// Subcommands
// =============================================================================

async function cmdWatch(): Promise<void> {
	console.log("\n=== Watching CI ===\n");
	const success = await watchCI();
	process.exit(success ? 0 : 1);
}

function parseVersion(v: string): [number, number, number] {
	const match = v.replace(/^v/, "").match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
	if (!match) throw new Error(`Invalid version: ${v}`);
	return [parseInt(match[1]), parseInt(match[2] ?? "0"), parseInt(match[3] ?? "0")];
}

function compareVersions(a: string, b: string): number {
	const [aMajor, aMinor, aPatch] = parseVersion(a);
	const [bMajor, bMinor, bPatch] = parseVersion(b);
	if (aMajor !== bMajor) return aMajor - bMajor;
	if (aMinor !== bMinor) return aMinor - bMinor;
	return aPatch - bPatch;
}

async function assertMainCiGreen(): Promise<void> {
	console.log("Checking latest main CI run...");
	const out = await $`gh run list --branch main --event push --limit 1 --json status,conclusion,databaseId`.quiet().nothrow().text();
	let run: { status: string; conclusion: string | null; databaseId: number } | undefined;
	try {
		const runs = JSON.parse(out) as Array<{ status: string; conclusion: string | null; databaseId: number }>;
		run = runs[0];
	} catch {
		run = undefined;
	}
	if (!run) {
		console.log("  No recent main push run found — continuing");
		return;
	}
	if (run.status !== "completed" || run.conclusion !== "success") {
		console.error(
			`Error: latest main CI run #${run.databaseId} is ${run.status}/${run.conclusion ?? "unknown"}.`,
		);
		console.error("  Release assumes a green main. Fix and re-run (or bypass with --skip-preflight).");
		process.exit(1);
	}
	console.log(`  main CI green (run #${run.databaseId})`);
}

async function commitIfDirty(message: string): Promise<void> {
	const changed = (await git(["status", "--porcelain"]).text()).trim();
	if (!changed) {
		console.log("  No changes to commit (already bumped on a previous attempt)");
		return;
	}
	await git(["add", "."]);
	await git(["commit", "-m", message]);
}

async function dispatchReleaseRun(version: string): Promise<boolean> {
	console.log(`Dispatching the release run for v${version}...`);
	const dispatch =
		await $`gh workflow run ci.yml --ref main -f trigger_release=true -f release_tag=v${version}`.quiet().nothrow();
	if (dispatch.exitCode !== 0) {
		console.error(
			`Failed to dispatch the release workflow (exit ${dispatch.exitCode}). Is gh authed with workflow scope?`,
		);
		return false;
	}
	console.log("  Dispatched — watching until the run finishes...");
	return watchCI();
}

async function cmdRelease(version: string, skipMainCheck: boolean): Promise<void> {
	console.log("\n=== Release Script ===\n");

	// 1. Pre-flight checks
	console.log("Pre-flight checks...");

	const branch = await git(["branch", "--show-current"]).text();
	if (branch.trim() !== "main") {
		console.error(`Error: Must be on main branch (currently on '${branch.trim()}')`);
		process.exit(1);
	}
	console.log("  On main branch");

	const status = await git(["status", "--porcelain"]).text();
	if (status.trim()) {
		console.error("Error: Uncommitted changes detected. Commit or stash first.");
		console.error(status);
		process.exit(1);
	}
	console.log("  Working directory clean");

	// Version tags only: bare `git describe --tags` returns whichever tag sits
	// closest on main's history, so a non-version tag (rollback anchors like
	// `pre-write-fix`) would win and compareVersions would throw on the name.
	const latestTag = (await git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"]).quiet().nothrow().text()).trim();
	if (!latestTag) {
		console.error("Error: no version tag (v*) reachable from HEAD — cannot determine the previous release.");
		process.exit(1);
	}
	if (compareVersions(version, latestTag) <= 0) {
		console.error(`Error: Version ${version} must be greater than latest tag ${latestTag}`);
		process.exit(1);
	}
	console.log(`  Version ${version} > ${latestTag}\n`);

	// 1b. Main must be green before we build a release on top of it
	if (!skipMainCheck) {
		await assertMainCiGreen();
	}

	// 2. Update package versions, root catalog pins and the Rust workspace version
	console.log(`Updating package versions to ${version}…`);
	const bump = await bumpRepoVersions(".", version);
	for (const name of bump.skipped) console.log(`  Skipping ${name} (private)`);

	// Verify
	console.log("  Verifying versions:");
	for (const name of bump.bumped) {
		console.log(`    ${name}: ${version}`);
	}
	console.log();

	// 3. Read the Rust workspace version back and list the crates inheriting it
	const cargoToml = await Bun.file("Cargo.toml").text();
	const versionMatch = cargoToml.match(/^\[workspace\.package\][\s\S]*?^version = "([^"]+)"/m);
	if (!versionMatch) {
		console.error("Error: [workspace.package] version not found in Cargo.toml");
		process.exit(1);
	}
	console.log(`  workspace: ${versionMatch[1]}`);

	// List crates using workspace version
	for await (const cargoPath of cargoTomlGlob.scan(".")) {
		const content = await Bun.file(cargoPath).text();
		if (content.includes("version.workspace = true")) {
			const nameMatch = content.match(/^name = "([^"]+)"/m);
			if (nameMatch) {
				console.log(`  ${nameMatch[1]}: ${version} (workspace)`);
			}
		}
	}
	console.log();

	// 4. Regenerate lockfiles
	console.log("Regenerating lockfiles...");
	await $`rm -f bun.lock`;
	await $`bun install`;
	await $`cargo generate-lockfile`;
	console.log();

	// 5. Update changelogs
	console.log("Updating CHANGELOGs...");
	await updateChangelogsForRelease(version);
	console.log();

	// 6. Run checks
	console.log("Running checks...");
	await $`bun run check`;
	console.log();

	// 7. Commit + push main. No tag yet: the release run creates it in its last
	//    step, pinned to this commit. A failure anywhere in the run therefore
	//    leaves no tag and no release behind to clean up.
	console.log("Committing version bump...");
	await commitIfDirty(`chore: bump version to ${version}`);
	console.log();

	console.log("Pushing main...");
	await git(["push", "origin", "main"]);
	console.log();

	// 8. Dispatch the release run against the commit just pushed. It builds the
	//    shipped artifacts, creates the tag and creates the GitHub Release — one
	//    pass, and nothing is published unless the whole run is green.
	const success = await dispatchReleaseRun(version);

	if (!success) {
		console.error(`\nRelease run failed — v${version} was not tagged or published.`);
		console.error("Fix on main, push, then re-run:");
		console.error(`  bun scripts/release.ts ${version}`);
		process.exit(1);
	}

	// 9. The tag is on the remote now (the release run created it). Fetch it so
	//    `git describe --tags` and the auto-release version guards see it.
	console.log("Fetching the release tag...");
	await $`git fetch --tags origin`.quiet().nothrow();
	console.log(`\n=== Released v${version} ===`);
}

// =============================================================================
// Main
// =============================================================================

const arg = process.argv[2];

if (!arg) {
	console.error("Usage:");
	console.error("  bun scripts/release.ts <version>   Full release (bump → push → release run → watch)");
	console.error("  bun scripts/release.ts watch       Watch CI for current commit");
	console.error("  bun scripts/release.ts <version> --skip-main-check   Emergency: skip the latest-main-CI-green gate");
	process.exit(1);
}

const skipMainCheck = process.argv.includes("--skip-main-check");

if (arg === "watch") {
	await cmdWatch();
} else if (/^\d+\.\d+\.\d+/.test(arg)) {
	await cmdRelease(arg, skipMainCheck);
} else {
	console.error(`Unknown command or invalid version: ${arg}`);
	console.error("Usage:");
	console.error("  bun scripts/release.ts <version>   Full release (bump → push → release run → watch)");
	console.error("  bun scripts/release.ts watch       Watch CI for current commit");
	console.error("  bun scripts/release.ts <version> --skip-main-check   Emergency: skip the latest-main-CI-green gate");
	process.exit(1);
}
