import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { UnifiedSkillRegistry } from "./registry";

describe("UnifiedSkillRegistry", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp("/tmp/registry-test-");
	});

	afterAll(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("returns empty array when directory does not exist", async () => {
		const registry = new UnifiedSkillRegistry();
		const skills = await registry.loadDir("/nonexistent/skills");
		expect(skills).toHaveLength(0);
	});

	test("loads flat markdown skills", async () => {
		const skillsDir = path.join(tempDir, "skills");
		await fs.mkdir(skillsDir, { recursive: true });

		await Bun.write(
			path.join(skillsDir, "git-workflow.md"),
			`---
name: "git-workflow"
version: "2.1"
source: "evolution"
confidence_score: 0.9
last_used_at: "2024-05-20T00:00:00Z"
status: "active"
---
Use rebase for local changes.
`,
		);

		const registry = new UnifiedSkillRegistry();
		const skills = await registry.loadDir(skillsDir);

		expect(skills).toHaveLength(1);
		expect(skills[0].name).toBe("git-workflow");
		expect(skills[0].source).toBe("evolution_extraction");
	});

	test("loads legacy subdirectory skills in the same directory", async () => {
		const skillsDir = path.join(tempDir, "skills");
		const skillDir = path.join(skillsDir, "python-debugging");
		await fs.mkdir(skillDir, { recursive: true });

		await Bun.write(
			path.join(skillDir, "SKILL.md"),
			`---
name: "python-debugging"
version: "1.0"
source: "memory"
confidence_score: 0.8
last_used_at: "2024-01-01T00:00:00Z"
status: "active"
---
Check type hints first.
`,
		);

		const registry = new UnifiedSkillRegistry();
		const skills = await registry.loadDir(skillsDir);

		expect(skills).toHaveLength(1);
		expect(skills[0].name).toBe("python-debugging");
		expect(skills[0].source).toBe("memory_consolidation");
	});

	test("loads skills without YAML frontmatter in subdirectories", async () => {
		const skillsDir = path.join(tempDir, "skills");
		const skillDir = path.join(skillsDir, "deploy-playbook");
		await fs.mkdir(skillDir, { recursive: true });
		await Bun.write(path.join(skillDir, "SKILL.md"), "Run checks before deploy.\n");

		const registry = new UnifiedSkillRegistry();
		const skills = await registry.loadDir(skillsDir);

		expect(skills).toHaveLength(1);
		expect(skills[0].name).toBe("deploy-playbook");
		expect(skills[0].content).toContain("Run checks before deploy");
	});

	test("merges flat and legacy by name: higher confidence wins", async () => {
		const skillsDir = path.join(tempDir, "skills");
		await fs.mkdir(skillsDir, { recursive: true });

		await Bun.write(
			path.join(skillsDir, "shared-skill.md"),
			`---
name: "shared-skill"
version: "2.0"
source: "evolution"
confidence_score: 0.9
last_used_at: "2024-01-01T00:00:00Z"
status: "active"
---
Flat evolution version.
`,
		);

		const memDir = path.join(skillsDir, "shared-skill");
		await fs.mkdir(memDir, { recursive: true });
		await Bun.write(
			path.join(memDir, "SKILL.md"),
			`---
name: "shared-skill"
version: "1.0"
source: "memory"
confidence_score: 0.5
last_used_at: "2024-01-01T00:00:00Z"
status: "active"
---
Legacy memory version.
`,
		);

		const registry = new UnifiedSkillRegistry();
		const skills = await registry.loadDir(skillsDir);

		expect(skills).toHaveLength(1);
		expect(skills[0].confidenceScore).toBe(0.9);
		expect(skills[0].content).toContain("Flat evolution version");
	});
});
