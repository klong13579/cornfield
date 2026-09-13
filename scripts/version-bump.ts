/**
 * Version-bump helpers shared by `scripts/release.ts` (manual, one-shot release)
 * and `scripts/auto-release.ts` (nightly cadence).
 *
 * Both must write the same version to the same files, and they used to carry a
 * copy of that logic each — the copies drifted. One of them shelled out to `sd`,
 * a `sed` replacement that developer machines have installed and GitHub's
 * runners do not: `bun: command not found: sd` took the nightly job down three
 * nights in a row. Everything that decides what a version bump touches, and how,
 * lives here so the two callers cannot disagree again.
 *
 * The edits are textual rather than JSON round-trips: the `package.json` files
 * in this repo disagree on indentation and trailing newline, and re-serializing
 * would rewrite formatting that has nothing to do with the version. Every
 * target is planned and validated before the first byte is written — an
 * unattended nightly bump that silently no-ops would tag a release carrying the
 * previous version.
 */
import * as path from "node:path";
import { Glob } from "bun";

const PACKAGE_JSON_GLOB = "packages/*/package.json";

/** Catalog entries under this scope are version-locked to the release. */
const CATALOG_PREFIX = "@cornfield/";

/**
 * `private: true` packages whose version still has to follow the release train.
 * The Electron shell decides whether an update is available from its
 * `package.json` version, so a frozen 0.0.0 would report "already up to date"
 * forever.
 */
const VERSION_LINKED_PRIVATE = new Set(["@cornfield/desktop"]);

const VERSION_FIELD = /"version"(\s*:\s*)"[^"]*"/;

export interface VersionBumpResult {
	/** Names of the packages whose `version` field was rewritten. */
	bumped: string[];
	/** Names of the `private` packages left untouched. */
	skipped: string[];
}

/** A validated rewrite, held back until every target of the bump has been planned. */
interface PlannedEdit {
	file: string;
	content: string;
}

/**
 * Write `version` everywhere a release version lives: every package manifest,
 * the `@cornfield/*` pins in the root `workspaces.catalog`, and the root
 * `Cargo.toml` `[workspace.package]`.
 *
 * Throws — with the tree still untouched — as soon as one target is not shaped
 * the way this expects, so a bump can never land half-applied.
 */
export async function bumpRepoVersions(repoRoot: string, version: string): Promise<VersionBumpResult> {
	const packages = await planPackageVersions(repoRoot, version);
	const edits: PlannedEdit[] = [
		...packages.edits,
		await planCatalogPins(path.join(repoRoot, "package.json"), version),
		await planCargoWorkspaceVersion(path.join(repoRoot, "Cargo.toml"), version),
	];
	for (const edit of edits) await Bun.write(edit.file, edit.content);
	return packages.result;
}

/**
 * The version the tree currently declares.
 *
 * Read from the `[workspace.package]` block, one of the three places a bump
 * writes — so it is exactly the version the next bump has to beat.
 */
export async function readRepoVersion(repoRoot: string): Promise<string> {
	const file = path.join(repoRoot, "Cargo.toml");
	return cargoWorkspaceVersion((await Bun.file(file).text()).split("\n"), file).version;
}

/** The strict `X.Y.Z` shape every version on the release train has. */
const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

function parseVersion(version: string): [number, number, number] {
	const match = RELEASE_VERSION.exec(version);
	if (!match) throw new Error(`Not a release version: "${version}"`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Compare two release versions: negative when `a` precedes `b`.
 *
 * Strict about `X.Y.Z` on purpose. This comparison is what an unattended
 * release decides "is this version ahead?" with; a tolerant parse would let
 * `1.1` and `1.1.0` land on opposite sides of the same gate depending on which
 * caller asked.
 */
export function compareVersions(a: string, b: string): number {
	const [aMajor, aMinor, aPatch] = parseVersion(a);
	const [bMajor, bMinor, bPatch] = parseVersion(b);
	if (aMajor !== bMajor) return aMajor - bMajor;
	if (aMinor !== bMinor) return aMinor - bMinor;
	return aPatch - bPatch;
}

async function planPackageVersions(
	repoRoot: string,
	version: string,
): Promise<{ edits: PlannedEdit[]; result: VersionBumpResult }> {
	const scanned = await Array.fromAsync(new Glob(PACKAGE_JSON_GLOB).scan(repoRoot));
	if (scanned.length === 0) throw new Error(`No ${PACKAGE_JSON_GLOB} under ${repoRoot}`);
	// `Glob.scan` yields paths relative to the working directory, not to `repoRoot`.
	const files = scanned.map((file) => path.resolve(repoRoot, file)).sort();

	const edits: PlannedEdit[] = [];
	const result: VersionBumpResult = { bumped: [], skipped: [] };
	for (const file of files) {
		const source = await Bun.file(file).text();
		const pkg = JSON.parse(source) as { name?: string; private?: boolean };
		if (!pkg.name) throw new Error(`${file}: no "name" field`);
		if (pkg.private && !VERSION_LINKED_PRIVATE.has(pkg.name)) {
			result.skipped.push(pkg.name);
			continue;
		}

		const content = replaceExactlyOnce(source, VERSION_FIELD, `"version"$1"${version}"`, `${file} "version" field`);
		const verification = JSON.parse(content) as { version?: string };
		if (verification.version !== version) {
			throw new Error(`${file}: version is "${verification.version}" after the bump, expected "${version}"`);
		}

		edits.push({ file, content });
		result.bumped.push(pkg.name);
	}
	return { edits, result };
}

async function planCatalogPins(file: string, version: string): Promise<PlannedEdit> {
	const source = await Bun.file(file).text();
	const pkg = JSON.parse(source) as { workspaces?: { catalog?: Record<string, string> } };
	const catalog = pkg.workspaces?.catalog;
	if (!catalog) throw new Error(`${file}: no workspaces.catalog section`);
	const pins = Object.keys(catalog).filter((name) => name.startsWith(CATALOG_PREFIX));
	if (pins.length === 0) throw new Error(`${file}: workspaces.catalog has no ${CATALOG_PREFIX}* entries`);

	// Only the catalog block — a package name can also appear elsewhere in the
	// same file (a dependency reference beside the catalog pin), and that one is
	// not ours to rewrite.
	const span = objectSpan(source, "catalog");
	let block = source.slice(span.start, span.end + 1);
	for (const name of pins) {
		const entry = new RegExp(`"${escapeRegExp(name)}"(\\s*:\\s*)"[^"]*"`);
		block = replaceExactlyOnce(block, entry, `"${name}"$1"${version}"`, `${file} catalog entry ${name}`);
	}
	const content = source.slice(0, span.start) + block + source.slice(span.end + 1);

	// The catalog also pins unrelated third-party ranges — those are not ours to
	// rewrite, so check the whole section rather than trusting the loop above.
	const updated = JSON.parse(content) as { workspaces: { catalog: Record<string, string> } };
	for (const [name, spec] of Object.entries(updated.workspaces.catalog)) {
		const expected = name.startsWith(CATALOG_PREFIX) ? version : catalog[name];
		if (spec !== expected) throw new Error(`${file}: catalog entry ${name} is "${spec}", expected "${expected}"`);
	}
	return { file, content };
}

async function planCargoWorkspaceVersion(file: string, version: string): Promise<PlannedEdit> {
	const lines = (await Bun.file(file).text()).split("\n");
	const { line } = cargoWorkspaceVersion(lines, file);
	const updated = [...lines];
	updated[line] = `version = "${version}"`;
	return { file, content: updated.join("\n") };
}

/**
 * Locate the single `version` entry of `[workspace.package]`.
 *
 * Returns the line it sits on as well as the value: the bump rewrites that
 * line, the nightly compares the next release against that value, and both have
 * to agree on which line they are talking about.
 */
function cargoWorkspaceVersion(lines: readonly string[], file: string): { line: number; version: string } {
	const header = lines.indexOf("[workspace.package]");
	if (header === -1) throw new Error(`${file}: no [workspace.package] section`);
	const nextSection = lines.findIndex((line, index) => index > header && line.startsWith("["));
	const sectionEnd = nextSection === -1 ? lines.length : nextSection;

	const versionLines: number[] = [];
	for (let i = header + 1; i < sectionEnd; i += 1) {
		if (/^version\s*=/.test(lines[i])) versionLines.push(i);
	}
	if (versionLines.length !== 1) {
		throw new Error(
			`${file}: expected exactly 1 version entry in [workspace.package], found ${versionLines.length}`,
		);
	}

	const line = versionLines[0];
	const value = lines[line].match(/^version\s*=\s*"([^"]+)"/);
	if (!value) throw new Error(`${file}:${line + 1}: version entry is not a quoted string`);
	return { line, version: value[1] };
}

/**
 * Text span of the object assigned to `"key"` in `source`.
 *
 * A plain index of the key is not enough for the callers here: the same name
 * can legitimately appear more than once in a manifest, and only one of those
 * occurrences is the block being rewritten. Strings are skipped while matching
 * braces, so a value containing braces cannot end the block early.
 */
function objectSpan(source: string, key: string): { start: number; end: number } {
	const keyText = `"${key}"`;
	const keyAt = source.indexOf(keyText);
	if (keyAt === -1) throw new Error(`no ${keyText} key`);
	if (source.indexOf(keyText, keyAt + keyText.length) !== -1) throw new Error(`more than one ${keyText} key`);

	const openAt = source.indexOf("{", keyAt + keyText.length);
	if (openAt === -1) throw new Error(`${keyText} is not assigned an object`);

	let depth = 0;
	let inString = false;
	for (let i = openAt; i < source.length; i += 1) {
		const char = source[i];
		if (inString) {
			if (char === "\\") i += 1;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) return { start: openAt, end: i };
		}
	}
	throw new Error(`unterminated object for ${keyText}`);
}

/**
 * Apply `re` to `source`, which must match exactly once.
 *
 * Zero matches means the file is not shaped the way this script assumes;
 * several means the pattern would rewrite something unrelated. Either way the
 * bump would be wrong, and guessing is worse than stopping.
 */
function replaceExactlyOnce(source: string, re: RegExp, replacement: string, context: string): string {
	const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
	const matches = source.match(global)?.length ?? 0;
	if (matches !== 1) throw new Error(`${context}: expected exactly 1 match, found ${matches}`);
	return source.replace(re, replacement);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
