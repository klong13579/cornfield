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
 * releases). On a change: bumps versions, finalizes CHANGELOGs, commits,
 * pushes main, tags v<next> and pushes the tag — the tag push runs the normal
 * full release pipeline (5-platform matrix → release_binary → release).
 *
 * Requires a PAT with `contents: write` in GH_TOKEN (repo secret
 * AUTO_RELEASE_TOKEN); GITHUB_TOKEN pushes do not re-trigger workflows.
 */
import * as path from "node:path";
import { $, Glob } from "bun";

const repoRoot = process.cwd();
const changelogGlob = new Glob("packages/*/CHANGELOG.md");
const packageJsonGlob = new Glob("packages/*/package.json");
const cargoTomlGlob = new Glob("crates/*/Cargo.toml");

const token = process.env.GH_TOKEN;
if (!token) {
	console.error("GH_TOKEN (PAT with contents: write) is required — push must re-trigger workflows.");
	process.exit(1);
}

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

// 3. Bump package versions (mirror of scripts/release.ts)
console.log(`Bumping package versions to ${nextVersion}…`);
const versionLinkedPrivate = new Set(["@cornfield/desktop"]);
const pkgJsonPaths = await Array.fromAsync(packageJsonGlob.scan(repoRoot));
const bumpPaths: string[] = [];
for (const p of pkgJsonPaths) {
	const pkg = (await Bun.file(p).json()) as { private?: boolean; name: string };
	if (pkg.private && !versionLinkedPrivate.has(pkg.name)) {
		console.log(`  Skipping ${pkg.name} (private)`);
		continue;
	}
	bumpPaths.push(p);
}
await $`sd '"version": "[^"]+"' ${`"version": "${nextVersion}"`} ${bumpPaths}`;

console.log("Updating root catalog @cornfield/* …");
const rootPkgPath = path.join(repoRoot, "package.json");
let rootPkgRaw = await Bun.file(rootPkgPath).text();
rootPkgRaw = rootPkgRaw.replace(/("@cornfield\/[^"]+":\s*)"[^"]+"/g, `$1"${nextVersion}"`);
await Bun.write(rootPkgPath, rootPkgRaw);

console.log("Updating Rust workspace version…");
const cargoTomlPath = path.join(repoRoot, "Cargo.toml");
let cargoRaw = await Bun.file(cargoTomlPath).text();
cargoRaw = cargoRaw.replace(/^version = "[^"]+"/m, `version = "${nextVersion}"`);
await Bun.write(cargoTomlPath, cargoRaw);

// 4. Regenerate lockfiles
console.log("Regenerating lockfiles…");
await $`rm -f bun.lock`.cwd(repoRoot);
await $`bun install`.cwd(repoRoot).quiet();
await $`cargo generate-lockfile`.cwd(repoRoot).quiet();

// 5. Changelogs
console.log("Finalizing CHANGELOGs…");
await updateChangelogsForRelease(nextVersion);

// 6. Commit + push main, then tag + push
console.log("Committing…");
await git(["add", "."]);
await git(["commit", "-m", `chore: auto bump version to ${nextVersion} (${isWeeklyMinor ? "weekly minor" : "daily patch"})`]);
await remoteWithToken();
await git(["push", "origin", "main"]);
console.log(`Tagging v${nextVersion}…`);
await git(["tag", `v${nextVersion}`]);
await git(["push", "origin", `v${nextVersion}`]);
console.log(`=== Auto-release v${nextVersion} pushed — tag CI will build & publish ===`);
