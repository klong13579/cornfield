#!/usr/bin/env bun
/**
 * Auto-release for the daily/weekly cadence.
 *
 * Runs from the `Nightly auto-release` workflow (schedule 18:00 UTC =
 * 02:00 Beijing). Version policy:
 *   - daily:   bump the PATCH of the latest v* tag (1.1.1 → 1.1.2 → …)
 *   - weekly:  on Beijing Sundays the bump is the MINOR (1.1.x → 1.2.0)
 *   - major:   manual only, via `bun scripts/release.ts <X>.0.0`
 *
 * Skips entirely when main has no commits beyond the latest v* tag (no empty
 * releases). Refuses to run when the tree already declares a version at or
 * beyond the one it computed — see step 2b.
 *
 * On a change: bumps versions, finalizes CHANGELOGs, commits, pushes main,
 * tags v<next> and pushes the tag — then starts the release workflow
 * explicitly (see step 7).
 *
 * GH_TOKEN is required for the two calls that talk back to GitHub: the push and
 * the `gh workflow run` that starts the release. The workflow supplies the
 * default GITHUB_TOKEN.
 *
 * The tag push alone is NOT enough to start a release: GITHUB_TOKEN pushes do
 * not trigger workflows, and this job runs on GITHUB_TOKEN. Measured
 * 2026-09-13 — the first night the job got this far — when v1.2.0 was tagged
 * and pushed, and the GitHub API reported zero workflow runs for that commit.
 * `workflow_dispatch` is the one event GitHub exempts from that rule, which is
 * the same reason `scripts/release.ts` dispatches its preflight instead of
 * waiting for a push.
 *
 * The commit it makes is attributed to the identity
 * `.github/workflows/nightly.yml` configures; a runner has none by default,
 * and assuming otherwise took the job down two nights in a row.
 */
import { $, Glob } from "bun";
import { bumpRepoVersions, compareVersions, readRepoVersion } from "./version-bump";

const repoRoot = process.cwd();
const isDryRun = process.argv.includes("--dry-run");
const changelogGlob = new Glob("packages/*/CHANGELOG.md");

const token = process.env.GH_TOKEN;

function git(args: readonly string[]) {
	return $`git -c core.fsmonitor=false ${args}`;
}

async function remoteWithToken(): Promise<void> {
	const origin = (await git(["remote", "get-url", "origin"]).quiet().text()).trim();
	const authed = origin.includes("x-access-token:") || origin.includes("@");
	if (!authed) {
		const withToken = origin.replace("https://", `https://x-access-token:${token}@`);
		await git(["remote", "set-url", "origin", withToken]);
	}
}

function parseVersion(v: string): [number, number, number] {
	const m = v.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
	if (!m) throw new Error(`Invalid version tag: ${v}`);
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function hasUnreleasedContent(content: string): boolean {
	const unreleasedMatch = content.match(/## \[Unreleased\]\s*\n([\s\S]*?)(?=## \[\d|$)/);
	if (!unreleasedMatch) return false;
	return unreleasedMatch[1].trim().length > 0;
}

function removeEmptyVersionEntries(content: string): string {
	return content.replace(/## \[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}\s*\n(?=## \[|\s*$)/g, "");
}

async function updateChangelogsForRelease(version: string): Promise<void> {
	const date = new Date().toISOString().split("T")[0];
	for await (const changelog of changelogGlob.scan(repoRoot)) {
		let content = await Bun.file(changelog).text();
		if (!content.includes("## [Unreleased]")) continue;
		if (hasUnreleasedContent(content)) {
			content = content.replace("## [Unreleased]", `## [${version}] - ${date}`);
			content = content.replace(/^(# Changelog\n\n)/, `$1## [Unreleased]\n\n`);
		}
		content = removeEmptyVersionEntries(content);
		await Bun.write(changelog, content);
		console.log(`  Updated ${pathOf(changelog)}`);
	}
}

function pathOf(p: string): string {
	return p.replace(`${repoRoot}/`, "");
}

// ── main ────────────────────────────────────────────────────────────────────
console.log("=== Auto-release ===\n");

// 1. Latest v* tag and whether main has moved past it
const describe = await git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"]).quiet().nothrow().text();
if (!describe.trim()) {
	console.log("No version tag yet — skipping (seed manually with `bun scripts/release.ts`).");
	process.exit(0);
}
const latestTag = describe.trim();
const head = (await git(["rev-parse", "HEAD"]).text()).trim();
const tagCommit = (await git(["rev-list", "-n", "1", latestTag]).text()).trim();
if (head === tagCommit) {
	console.log(`main is at ${latestTag} — no new commits, skipping auto-release.`);
	process.exit(0);
}
const aheadCount = (await git(["rev-list", "--count", `${latestTag}..HEAD`]).text()).trim();
console.log(`  latest tag: ${latestTag} | main is ${aheadCount} commits ahead`);

// 2. Beijing weekday — Sunday bumps the minor, other days the patch
const bjDow = (await $`TZ=Asia/Shanghai date +%u`.text()).trim(); // 1=Mon … 7=Sun
const isWeeklyMinor = bjDow === "7";
const [major, minor, patch] = parseVersion(latestTag);
const nextVersion = isWeeklyMinor ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
console.log(`  cadence: ${isWeeklyMinor ? "weekly (minor)" : "daily (patch)"} → next: v${nextVersion}`);

// 2b. The tag says what shipped; the tree says what is staged. They part ways
//     when a manual release bumps the tree and dies before tagging it — exactly
//     what v1.1.4's first attempt did (2026-09-12: preflight failure, tree at
//     1.1.4, latest tag still v1.1.1). Measuring only against the tag would then
//     walk every version file backwards and tag a release labelled lower than
//     its own source. Refuse, and name both ways out.
const declaredVersion = await readRepoVersion(repoRoot);
if (compareVersions(nextVersion, declaredVersion) <= 0) {
	console.error(
		`Error: next version v${nextVersion} (from tag ${latestTag}) is not ahead of the v${declaredVersion} the tree declares.`,
	);
	console.error("  A manual release bumped the tree without tagging the bumped commit.");
	console.error(`  Recover by tagging it (git tag v${declaredVersion} && git push origin v${declaredVersion}),`);
	console.error("  or by reverting the bump on main. Both need a human — this script cannot pick.");
	process.exit(1);
}

// 3. Bump package versions, root catalog pins and the Rust workspace version
//    (shared with scripts/release.ts — see scripts/version-bump.ts)
console.log(`Bumping package versions to ${nextVersion}…`);
const bump = await bumpRepoVersions(repoRoot, nextVersion);
for (const name of bump.skipped) console.log(`  Skipping ${name} (private)`);
console.log(`  Bumped ${bump.bumped.length} packages, root catalog and Cargo.toml`);

// 4. Regenerate lockfiles
console.log("Regenerating lockfiles…");
await $`rm -f bun.lock`.cwd(repoRoot);
await $`bun install`.cwd(repoRoot).quiet();
await $`cargo generate-lockfile`.cwd(repoRoot).quiet();

// 5. Changelogs
console.log("Finalizing CHANGELOGs…");
await updateChangelogsForRelease(nextVersion);

// 6. Commit + push main, then tag + push
if (isDryRun) {
	console.log(`DRY-RUN: would commit, push main and tag v${nextVersion} — leaving working tree modified for inspection.`);
	process.exit(0);
}
if (!token) {
	console.error("GH_TOKEN is required — it authenticates both the push and the release dispatch.");
	process.exit(1);
}
console.log("Committing…");
await git(["add", "."]);
await git(["commit", "-m", `chore: auto bump version to ${nextVersion} (${isWeeklyMinor ? "weekly minor" : "daily patch"})`]);
await remoteWithToken();
await git(["push", "origin", "main"]);
console.log(`Tagging v${nextVersion}…`);
await git(["tag", `v${nextVersion}`]);
await git(["push", "origin", `v${nextVersion}`]);

// 7. Start the release run. The tag exists now, but nothing is building it —
//    see the header for why the push cannot do this. `release_tag` is what the
//    release job names the GitHub Release after, and `check_latest_tag`
//    short-circuits to "is_latest" for a trigger_release dispatch, so the rest
//    of the matrix runs against this commit exactly as a tag push would have.
//    A failure here leaves a tag with no Release, which a human can recover by
//    re-running the same dispatch — so it is loud, and it is the last step.
console.log(`Dispatching the release workflow for v${nextVersion}…`);
await $`gh workflow run ci.yml --ref main -f trigger_release=true -f release_tag=v${nextVersion}`;
console.log(`=== Auto-release v${nextVersion}: main pushed, tag pushed, release run dispatched ===`);
