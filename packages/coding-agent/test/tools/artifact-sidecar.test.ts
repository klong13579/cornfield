import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ARTIFACT_SIDECAR_MIN_BYTES,
	persistToolOutputArtifact,
	type ArtifactAllocator,
} from "../../src/tools/output-meta";

function makeAllocator(dir: string, enabled = true): ArtifactAllocator {
	let next = 0;
	return {
		allocateOutputArtifact: async toolType => {
			if (!enabled) return { id: undefined, path: undefined };
			const id = String(next++);
			return { id, path: path.join(dir, `${id}.${toolType}.log`) };
		},
	};
}

describe("persistToolOutputArtifact", () => {
	it("returns undefined for content below the threshold", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidecar-"));
		try {
			const allocator = makeAllocator(dir);
			const id = await persistToolOutputArtifact(allocator, "read", "small");
			expect(id).toBeUndefined();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("persists full content above the threshold and returns the id", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidecar-"));
		try {
			const allocator = makeAllocator(dir);
			const big = "x".repeat(ARTIFACT_SIDECAR_MIN_BYTES + 1);
			const id = await persistToolOutputArtifact(allocator, "search", big);
			expect(id).toBeDefined();
			const files = await fs.readdir(dir);
			expect(files).toHaveLength(1);
			expect(files[0]).toMatch(/^0\.search\.log$/);
			expect(await fs.readFile(path.join(dir, files[0]!), "utf-8")).toBe(big);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("returns undefined when no artifact store is available", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidecar-"));
		try {
			const allocator = makeAllocator(dir, false);
			const big = "x".repeat(ARTIFACT_SIDECAR_MIN_BYTES + 1);
			const id = await persistToolOutputArtifact(allocator, "read", big);
			expect(id).toBeUndefined();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("does not throw when the write fails", async () => {
		const allocator: ArtifactAllocator = {
			allocateOutputArtifact: async () => ({ id: "1", path: "/nonexistent-dir/x.log" }),
		};
		const id = await persistToolOutputArtifact(allocator, "read", "y".repeat(ARTIFACT_SIDECAR_MIN_BYTES + 1));
		expect(id).toBeUndefined();
	});
});
