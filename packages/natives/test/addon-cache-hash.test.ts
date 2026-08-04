/**
 * Regression: the extracted-addon cache must be keyed by content hash, not
 * just version. On 2026-08-05 a same-version rebuild embedded a fixed audio
 * addon, but the compiled binary kept loading the stale addon extracted from
 * a July-14 build (~/.omp/natives/14.5.12/) — the microphone silently
 * delivered nothing in compiled mode while source runs (fresh addon) worked.
 */
import { describe, expect, it } from "bun:test";
import { decideAddonCacheAction } from "../native/loader-state";

describe("decideAddonCacheAction", () => {
	it("extracts when no cached addon exists", () => {
		expect(decideAddonCacheAction({ exists: false, marker: null, expectedHash: "abc" })).toBe("extract");
	});

	it("reuses the cache when the marker matches the embedded hash", () => {
		expect(decideAddonCacheAction({ exists: true, marker: "abc", expectedHash: "abc" })).toBe("reuse");
	});

	it("extracts when the marker mismatches (same-version rebuild, changed addon content)", () => {
		expect(decideAddonCacheAction({ exists: true, marker: "stale-hash", expectedHash: "new-hash" })).toBe("extract");
	});

	it("extracts when a pre-hash cache entry has no marker (one-time migration)", () => {
		expect(decideAddonCacheAction({ exists: true, marker: null, expectedHash: "abc" })).toBe("extract");
	});

	it("keeps legacy version-keyed behavior when the manifest carries no hash", () => {
		expect(decideAddonCacheAction({ exists: true, marker: null, expectedHash: null })).toBe("reuse");
		expect(decideAddonCacheAction({ exists: true, marker: "abc", expectedHash: undefined })).toBe("reuse");
	});
});
