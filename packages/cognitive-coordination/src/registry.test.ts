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

	test("returns empty array when directories do not exist", async () => {
		const registry = new UnifiedSkillRegistry();
		const skills = await registry.load("/nonexistent/memory", "/nonexistent/evolution");
		expect(skills).toHaveLength(0);
	});

	test("loads memory skills from subdirectories", async () => {
		const memoryRoot = path.join(tempDir, "memory");
		const skillDir = path.join(memoryRoot, "skills", "python-debugging");
		await fs.mkdir(skillDir, { recursive: true });

		await Bun.write(
			path.join(skillDir, "SKILL.md"),
			`---
name: "python-debugging"
version: "1.0"
source: "memory"
confidenceScore: 0.8
lastUsedAt: "2024-01-01T00:00:00Z"
status: "active"
---
Check type hints first.
`,
		);

		const registry = new UnifiedSkillRegistry();
		const skills = await registry.load(memoryRoot, "/nonexistent/evolution");

		expect(skills).toHaveLength(1);
		expect(skills[0].name).toBe("python-debugging");
		expect(skills[0].source).toBe("memory_consolidation");
		expect(skills[0].content).toContain("Check type hints first");
	});

	test("loads evolution skills from flat files", async () => {
		const evolutionRoot = path.join(tempDir, "evolution");
		const skillsDir = path.join(evolutionRoot, "skills");
		await fs.mkdir(skillsDir, { recursive: true });

		await Bun.write(
			path.join(skillsDir, "git-workflow.md"),
			`---
name: "git-workflow"
version: "2.1"
source: "evolution"
confidenceScore: 0.9
lastUsedAt: "2024-05-20T00:00:00Z"
status: "active"
---
Use rebase for local changes.
`,
		);

		const registry = new UnifiedSkillRegistry();
		const skills = await registry.load("/nonexistent/memory", evolutionRoot);

		expect(skills).toHaveLength(1);
		expect(skills[0].name).toBe("git-workflow");
		expect(skills[0].source).toBe("evolution_extraction");
	});

	test("merges skills by name: higher confidence wins", async () => {
		const memoryRoot = path.join(tempDir, "memory");
		const evolutionRoot = path.join(tempDir, "evolution");

		// Memory skill with lower confidence
		const memDir = path.join(memoryRoot, "skills", "shared-skill");
		await fs.mkdir(memDir, { recursive: true });
		await Bun.write(
			path.join(memDir, "SKILL.md"),
			`---
name: "shared-skill"
version: "1.0"
source: "memory"
confidenceScore: 0.5
lastUsedAt: "2024-01-01T00:00:00Z"
status: "active"
---
Memory version.
`,
		);

		// Evolution skill with higher confidence
		const evoDir = path.join(evolutionRoot, "skills");
		await fs.mkdir(evoDir, { recursive: true });
		await Bun.write(
			path.join(evoDir, "shared-skill.md"),
			`---
name: "shared-skill"
version: "1.0"
source: "evolution"
confidenceScore: 0.9
lastUsedAt: "2024-01-01T00:00:00Z"
status: "active"
---
Evolution version.
`,
		);

		const registry = new UnifiedSkillRegistry();
		const skills = await registry.load(memoryRoot, evolutionRoot);

		expect(skills).toHaveLength(1);
		expect(skills[0].confidenceScore).toBe(0.9);
		expect(skills[0].source).toBe("evolution_extraction");
	});

	test("merges skills by name: evolution wins on tie", async () => {
		const memoryRoot = path.join(tempDir, "memory");
		const evolutionRoot = path.join(tempDir, "evolution");

		// Memory skill
		const memDir = path.join(memoryRoot, "skills", "tie-skill");
		await fs.mkdir(memDir, { recursive: true });
		await Bun.write(
			path.join(memDir, "SKILL.md"),
			`---
name: "tie-skill"
version: "1.0"
source: "memory"
confidenceScore: 0.7
lastUsedAt: "2024-01-01T00:00:00Z"
status: "active"
---
Memory version.
`,
		);

		// Evolution skill with same confidence
		const evoDir = path.join(evolutionRoot, "skills");
		await fs.mkdir(evoDir, { recursive: true });
		await Bun.write(
			path.join(evoDir, "tie-skill.md"),
			`---
name: "tie-skill"
version: "2.0"
source: "evolution"
confidenceScore: 0.7
lastUsedAt: "2024-01-01T00:00:00Z"
status: "active"
---
Evolution version.
`,
		);

		const registry = new UnifiedSkillRegistry();
		const skills = await registry.load(memoryRoot, evolutionRoot);

		expect(skills).toHaveLength(1);
		expect(skills[0].source).toBe("evolution_extraction");
		expect(skills[0].version).toBe("2.0");
	});
});
