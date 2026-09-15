import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import type { Skill } from "../../src/extensibility/skills";
import { InternalUrlRouter } from "../../src/internal-urls/router";
import { SkillProtocolHandler } from "../../src/internal-urls/skill-protocol";
import type { ToolSession } from "../../src/sdk";
import { ReadTool } from "../../src/tools/read";

function getResultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

/**
 * `skill://` reads carry `ignoreResultLimits` (a skill body is never byte-truncated),
 * which previously also discarded the caller's line window: `sel="1-5"` came back as
 * the whole file. These tests lock the window and the directory-listing form.
 */
describe("read skill:// resources", () => {
	let tmpDir: string;
	let skillDir: string;
	let router: InternalUrlRouter;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-skill-"));
		skillDir = path.join(tmpDir, "demo");
		await fs.mkdir(path.join(skillDir, "scripts"), { recursive: true });
		await Bun.write(
			path.join(skillDir, "SKILL.md"),
			Array.from({ length: 60 }, (_, i) => `alpha-${i + 1}`).join("\n"),
		);
		await Bun.write(path.join(skillDir, "USAGE.md"), "# usage\n");
		await Bun.write(path.join(skillDir, "scripts", "run.ts"), "export const run = 1;\n");

		const skill: Skill = {
			name: "demo",
			description: "demo skill",
			filePath: path.join(skillDir, "SKILL.md"),
			baseDir: skillDir,
			source: "test",
		};
		router = new InternalUrlRouter();
		router.register(new SkillProtocolHandler({ getSkills: () => [skill] }));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	function makeTool(): ReadTool {
		const session = {
			cwd: tmpDir,
			settings: Settings.isolated({ "read.defaultLimit": 3000 }),
			internalRouter: router,
		} as unknown as ToolSession;
		return new ReadTool(session);
	}

	function makeHashlineTool(): ReadTool {
		const session = {
			cwd: tmpDir,
			hasEditTool: true,
			settings: Settings.isolated({ "edit.mode": "hashline", readHashLines: true, "read.defaultLimit": 3000 }),
			internalRouter: router,
		} as unknown as ToolSession;
		return new ReadTool(session);
	}

	it("honors the line window instead of returning the whole skill body", async () => {
		const result = await makeTool().execute("c1", { path: "skill://demo", sel: "1-5" });
		const text = getResultText(result);

		expect(text).toContain("alpha-1");
		expect(text).toContain("alpha-5");
		expect(text).not.toContain("alpha-6");
		expect(text).not.toContain("alpha-60");
	});

	it("reads SKILL.md for a bare skill URL", async () => {
		const result = await makeTool().execute("c2", { path: "skill://demo" });
		const text = getResultText(result);

		expect(text).toContain("alpha-60");
	});

	it("lists the skill directory for a trailing-slash URL", async () => {
		const result = await makeTool().execute("c3", { path: "skill://demo/" });
		const text = getResultText(result);

		expect(text).toContain("SKILL.md");
		expect(text).toContain("USAGE.md");
		expect(text).toContain("scripts/");
		expect(text).not.toContain("alpha-1");
	});

	it("lists a subdirectory of the skill", async () => {
		const result = await makeTool().execute("c4", { path: "skill://demo/scripts/" });
		const text = getResultText(result);

		expect(text).toContain("run.ts");
	});

	// Anchors are an edit affordance. A skill has no edit path, so an anchor here
	// only invites an edit that must fail — but the line numbers stay, because the
	// caller re-reads by range with `sel`.
	it("does not mint edit anchors for a skill read in hashline mode", async () => {
		const result = await makeHashlineTool().execute("c5", { path: "skill://demo", sel: "1-3" });
		const text = getResultText(result);

		expect(text).not.toMatch(/^\d+[a-z0-9]{2}\|/m);
		expect(text).toMatch(/^1\|alpha-1$/m);
	});

	it("still mints edit anchors for a file read in hashline mode", async () => {
		const result = await makeHashlineTool().execute("c6", { path: "SKILL.md" });
		const text = getResultText(result);

		expect(text).toMatch(/^\d+[a-z0-9]{2}\|/m);
	});
});
