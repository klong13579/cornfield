/**
 * Skill hot-reload e2e test.
 *
 * Verifies the full chain: file change → SkillWatcher debounce →
 * discoverSkills re-run → session.reloadSkills → system prompt rebuild.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";

describe("skill hot-reload", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-skill-hotreload-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rebuilds system prompt when SKILL.md changes", async () => {
		const skillDir = path.join(tempDir, ".omp", "skills", "my-test-skill");
		fs.mkdirSync(skillDir, { recursive: true });

		const initialContent = `---
name: my-test-skill
description: A test skill v1
---

This is the original skill content version 1.
`;
		fs.writeFileSync(path.join(skillDir, "SKILL.md"), initialContent);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"skills.enabled": true,
				"skills.enablePiProject": true,
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			toolNames: ["read"],
		});

		// Verify initial system prompt contains the skill
		const initialPrompt = session.systemPrompt;
		expect(initialPrompt).toContain("my-test-skill");
		expect(initialPrompt).toContain("A test skill v1");

		// Modify the skill file
		const updatedContent = `---
name: my-test-skill
description: A test skill v2 - UPDATED
---

This is the updated skill content version 2.
`;
		fs.writeFileSync(path.join(skillDir, "SKILL.md"), updatedContent);

		// Wait for debounce (500ms) + async reload
		await Bun.sleep(1500);

		// Verify system prompt was rebuilt with new content
		const updatedPrompt = session.systemPrompt;
		expect(updatedPrompt).toContain("my-test-skill");
		expect(updatedPrompt).toContain("A test skill v2 - UPDATED");

		// The prompt should actually be different from the initial one
		expect(updatedPrompt).not.toBe(initialPrompt);

		await session.dispose();
	});

	it("does not reload when skills are explicitly provided (no watcher)", async () => {
		const skillDir = path.join(tempDir, ".omp", "skills", "static-skill");
		fs.mkdirSync(skillDir, { recursive: true });

		fs.writeFileSync(
			path.join(skillDir, "SKILL.md"),
			`---
name: static-skill
description: Static skill v1
---

Static skill content.
`,
		);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			toolNames: ["read"],
			skills: [
				{
					name: "static-skill",
					description: "Static skill v1",
					filePath: path.join(skillDir, "SKILL.md"),
					baseDir: skillDir,
					source: "native:user",
					content: "Static skill content.",
				},
			],
		});

		const initialPrompt = session.systemPrompt;
		expect(initialPrompt).toContain("Static skill v1");

		// Modify the file — should NOT trigger reload since skills were explicitly provided
		fs.writeFileSync(
			path.join(skillDir, "SKILL.md"),
			`---
name: static-skill
description: Static skill v2
---

Updated static content.
`,
		);

		await Bun.sleep(1500);

		// Prompt should NOT have changed
		expect(session.systemPrompt).toBe(initialPrompt);

		await session.dispose();
	});
});
