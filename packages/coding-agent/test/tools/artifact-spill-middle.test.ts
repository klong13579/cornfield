import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { ArtifactProtocolHandler } from "../../src/internal-urls/artifact-protocol";
import { InternalUrlRouter } from "../../src/internal-urls/router";
import type { ToolSession } from "../../src/sdk";
import { wrapToolWithMetaNotice } from "../../src/tools/output-meta";
import { ReadTool } from "../../src/tools/read";

function getResultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

/**
 * The result-spill wrapper keeps a head+tail view (middle elision) so a spilled
 * read still shows the beginning of the resource. Tail-only keeps the least
 * useful half of a document, which is how a skill read silently lost its
 * `## Phase 1` section.
 */
describe("large result spill", () => {
	let tmpDir: string;
	let artifactsDir: string;
	const rows = Array.from({ length: 400 }, (_, i) => `row-${i + 1}:${"x".repeat(30)}`);

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spill-middle-"));
		artifactsDir = path.join(tmpDir, "artifacts");
		await fs.mkdir(artifactsDir);
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	function makeSpillContext(saveArtifact: () => Promise<string | undefined>, headKb: number) {
		const settings = Settings.isolated({
			"read.defaultLimit": 3000,
			"tools.artifactSpillThreshold": 8,
			"tools.artifactTailBytes": 2,
			"tools.artifactTailLines": 500,
			"tools.artifactHeadBytes": headKb,
		});
		return {
			settings,
			sessionManager: { saveArtifact },
		} as unknown as Parameters<ReturnType<typeof wrapToolWithMetaNotice>["execute"]>[4];
	}

	it("keeps head and tail of a spilled read", async () => {
		const file = path.join(tmpDir, "big.txt");
		await Bun.write(file, rows.join("\n"));

		const session = {
			cwd: tmpDir,
			settings: Settings.isolated({ "read.defaultLimit": 3000 }),
		} as unknown as ToolSession;
		const tool = wrapToolWithMetaNotice(new ReadTool(session));

		const result = await tool.execute(
			"c1",
			{ path: "big.txt" },
			undefined,
			undefined,
			makeSpillContext(async () => "99", 2),
		);
		const text = getResultText(result);

		expect(text).toContain("row-1:");
		expect(text).toContain("row-400:");
		expect(text).not.toContain("row-200:");
		expect(text).toContain("ln elided");
		expect(text).toMatch(/and \d+-400 of 400/);
		expect(text).toContain("Read artifact://99 for full output");
	});

	it("falls back to tail-only when the head budget is zero", async () => {
		const file = path.join(tmpDir, "big.txt");
		await Bun.write(file, rows.join("\n"));

		const session = {
			cwd: tmpDir,
			settings: Settings.isolated({ "read.defaultLimit": 3000 }),
		} as unknown as ToolSession;
		const tool = wrapToolWithMetaNotice(new ReadTool(session));

		const result = await tool.execute(
			"c2",
			{ path: "big.txt" },
			undefined,
			undefined,
			makeSpillContext(async () => "99", 0),
		);
		const text = getResultText(result);

		expect(text).toContain("row-400:");
		expect(text).not.toContain("row-1:");
	});

	it("does not re-spill a read of an artifact", async () => {
		await Bun.write(path.join(artifactsDir, "5.bash.log"), rows.join("\n"));

		let saves = 0;
		const router = new InternalUrlRouter();
		router.register(new ArtifactProtocolHandler({ getArtifactsDir: () => artifactsDir }));

		const session = {
			cwd: tmpDir,
			settings: Settings.isolated({ "read.defaultLimit": 3000 }),
			internalRouter: router,
		} as unknown as ToolSession;
		const tool = wrapToolWithMetaNotice(new ReadTool(session));

		const result = await tool.execute(
			"c3",
			{ path: "artifact://5" },
			undefined,
			undefined,
			makeSpillContext(async () => {
				saves++;
				return "100";
			}, 2),
		);
		const text = getResultText(result);

		expect(saves).toBe(0);
		expect(text).not.toContain("Read artifact://100");
		expect(text).toContain("row-1:");
	});
});
