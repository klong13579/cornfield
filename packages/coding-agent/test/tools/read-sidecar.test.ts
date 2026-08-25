import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolSession } from "../../src/sdk";
import { ReadTool } from "../../src/tools/read";

/**
 * End-to-end sidecar verification: reading a large file truncates the model
 * view but persists the full collected content as a session artifact with a
 * visible page-fault reference.
 */
function makeSession(artifactDir: string): ToolSession {
	let next = 0;
	return {
		cwd: artifactDir,
		settings: {
			get: (key: string) => {
				switch (key) {
					case "read.defaultLimit":
						return 3000;
					case "images.autoResize":
					case "inspect_image.enabled":
					case "fetch.enabled":
						return false;
					default:
						return undefined;
				}
			},
		} as unknown as ToolSession["settings"],
		internalRouter: {
			canHandle: () => false,
			resolve: () => {
				throw new Error("unexpected internal URL");
			},
		},
		hasEditTool: true,
		allocateOutputArtifact: async toolType => {
			const id = String(next++);
			return { id, path: path.join(artifactDir, `${id}.${toolType}.log`) };
		},
	} as unknown as ToolSession;
}

describe("read large-file sidecar", () => {
	it("persists full collected content and shows an artifact reference when truncated", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-read-sidecar-"));
		try {
			// ~10k lines x 40 bytes = 400KB; default read limit is 3000 lines/50KB -> truncated
			const file = path.join(dir, "big.txt");
			const line = "x".repeat(39);
			const content = Array.from({ length: 10000 }, (_, i) => `${i}:${line}`).join("\n");
			await fs.writeFile(file, content);

			const tool = new ReadTool(makeSession(dir));
			const result = await tool.execute("call-1", { path: "big.txt" });

			const text = result.content
				.filter(b => b.type === "text")
				.map(b => b.text)
				.join("\n");
			// truncated view + page-fault reference visible to the model
			expect(text).toContain("Read artifact://");
			expect(text).toContain("for full output");

			const details = result.details as { truncation?: { artifactId?: string; truncated?: boolean } };
			const artifactId = details?.truncation?.artifactId;
			expect(artifactId).toBeDefined();
			expect(details?.truncation?.truncated).toBe(true);

			// artifact file holds the full collected content (the 3000 collected lines,
			// not the unread tail of the file), recoverable by reading it
			const artifactFile = path.join(dir, `${artifactId}.read.log`);
			const artifactText = await fs.readFile(artifactFile, "utf-8");
			expect(artifactText.length).toBeGreaterThan(32 * 1024);
			expect(artifactText.startsWith("0:")).toBe(true);
			expect(artifactText).toContain("2999:");
			expect(artifactText).not.toContain("9999:");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("does not persist small files", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-read-sidecar-"));
		try {
			const file = path.join(dir, "small.txt");
			await fs.writeFile(file, "hello world\n");
			const tool = new ReadTool(makeSession(dir));
			const result = await tool.execute("call-2", { path: "small.txt" });
			const text = result.content
				.filter(b => b.type === "text")
				.map(b => b.text)
				.join("\n");
			expect(text).not.toContain("Read artifact://");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
