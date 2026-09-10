/**
 * Release-target selection shared by the CI release scripts
 * (`scripts/ci-release-build-binaries.ts`, `scripts/ci-release-build-archives.ts`).
 *
 * `ci.yml` owns the shipped target set: each job that needs it exports
 * `RELEASE_TARGETS`, so "what we publish" is answered in one place that a
 * reviewer reads, not by whichever platform entries happen to exist in a
 * script. The scripts keep the ability to build every platform they know
 * about — the selection is what narrows that to the release surface.
 *
 * One copy of this logic on purpose. Two copies is how the version-bump logic
 * in `release.ts` / `auto-release.ts` drifted until one of them broke the
 * nightly job (see `scripts/version-bump.ts`).
 */

/** Targets named by `--targets a,b`, `--targets=a,b`, or `Bun.env[envVar]`; `null` means "everything". */
export function parseRequestedTargets(envVar: string): Set<string> | null {
	const flagIndex = process.argv.findIndex((arg) => arg === "--targets");
	const flagValue =
		flagIndex >= 0
			? process.argv[flagIndex + 1]
			: (process.argv.find((arg) => arg.startsWith("--targets="))?.split("=", 2)[1] ?? Bun.env[envVar]);

	if (!flagValue) return null;

	return new Set(
		flagValue
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean),
	);
}

/**
 * Narrow `targets` to the requested ids, or return all of them when nothing was
 * requested.
 *
 * An unknown id throws — a typo in `ci.yml` has to fail the release job, not
 * quietly publish a smaller platform set than the config claims. An empty
 * selection throws for the same reason.
 */
export function selectReleaseTargets<T extends { id: string }>(
	targets: readonly T[],
	requested: Set<string> | null,
): T[] {
	if (requested) {
		const unknown = [...requested].filter((id) => !targets.some((target) => target.id === id));
		if (unknown.length > 0) throw new Error(`Unknown release target(s): ${unknown.join(", ")}`);
	}

	const selected = requested ? targets.filter((target) => requested.has(target.id)) : [...targets];
	if (selected.length === 0) throw new Error("No release targets selected.");
	return selected;
}
