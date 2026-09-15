import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { ArtifactProtocolHandler } from "../../src/internal-urls/artifact-protocol";
import { InternalUrlRouter } from "../../src/internal-urls/router";
import type { ToolSession } from "../../src/sdk";
import { FindTool } from "../../src/tools/find";

function getResultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

/**
 * An internal URL resolves to a backing filesystem path before globbing; a glob
 * pattern aimed at one is rejected rather than mangled into a filesystem path.
 */
describe("glob against internal URLs", () => {
	let tmpDir: string;
	let artifactsDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "glob-internal-"));
		artifactsDir = path.join(tmpDir, "artifacts");
		await fs.mkdir(artifactsDir);
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	function makeTool(): FindTool {
		const router = new InternalUrlRouter();
		router.register(new ArtifactProtocolHandler({ getArtifactsDir: () => artifactsDir }));
		const session = {
			cwd: tmpDir,
			settings: Settings.isolated({}),
			internalRouter: router,
		} as unknown as ToolSession;
		return new FindTool(session);
	}

	it("resolves an exact internal URL to its backing file", async () => {
		await Bun.write(path.join(artifactsDir, "5.bash.log"), "hello\n");

		const result = await makeTool().execute("c1", { pattern: "artifact://5" });
		const text = getResultText(result);

		expect(text).toContain("5.bash.log");
	});

	it("rejects a glob pattern aimed at an internal URL", () => {
		expect(makeTool().execute("c2", { pattern: "artifact://5/**" })).rejects.toThrow(
			"Glob patterns are not supported for internal URLs",
		);
	});

	it("still globs plain filesystem patterns", async () => {
		await Bun.write(path.join(tmpDir, "note.txt"), "hello\n");

		const result = await makeTool().execute("c3", { pattern: "*.txt" });
		const text = getResultText(result);

		expect(text).toContain("note.txt");
	});
});
