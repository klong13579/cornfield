import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@cornfield/coding-agent/config/settings";
import { buildMemoryToolDeveloperInstructions, getMemoryRoot } from "../../src/memory/index";

describe("buildMemoryToolDeveloperInstructions", () => {
	it("uses memory:// URLs and does not expose raw memory root paths", async () => {
		// 隔离 HOME：记忆根现在只由 `settings.getCwd()`（配置/记忆的项目根）决定，
		// 不隔离就会把 memory_summary.md 写进真实的 ~/.cornfield/self-evolution。
		const savedHome = process.env.HOME;
		const isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "memory-instructions-home-"));
		process.env.HOME = isolatedHome;
		try {
			const settings = Settings.isolated({ "memories.enabled": true });
			const memoryRoot = getMemoryRoot(settings.getCwd());
			await fs.mkdir(memoryRoot, { recursive: true });
			await Bun.write(path.join(memoryRoot, "memory_summary.md"), "Use structured retries for flaky network calls.");

			const instructions = await buildMemoryToolDeveloperInstructions(settings);
			expect(instructions).toBeDefined();
			expect(instructions).toContain("memory://root/memory_summary.md");
			expect(instructions).toContain("memory://root/skills/<name>/SKILL.md");
			expect(instructions).not.toContain(memoryRoot);
		} finally {
			process.env.HOME = savedHome;
			await fs.rm(isolatedHome, { recursive: true, force: true });
		}
	});
});
