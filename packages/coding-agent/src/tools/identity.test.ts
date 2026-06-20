import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setAgentDir, setConfigRootDir } from "@oh-my-pi/pi-utils";
import type { ToolSession } from ".";
import { IdentityTool } from "./identity";

/**
 * Isolation: `setConfigRootDir(tempDir)` repoints `getConfigRootDir()` (where user.md lives)
 * at a per-test temp directory; `setAgentDir` is also redirected for any agentDir access.
 * Restored in afterEach. No long-lived HOME / env mutation leaks across files.
 */
let tmpDir: string;
let originalAgentDir: string;
let originalEnv: string | undefined;

function makeTool(): IdentityTool {
	const session = { cwd: tmpDir } as unknown as ToolSession;
	return new IdentityTool(session);
}

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "identity-test-"));
	originalAgentDir = (await import("@oh-my-pi/pi-utils")).getAgentDir();
	originalEnv = process.env.PI_CODING_AGENT_DIR;

	setConfigRootDir(tmpDir);
	setAgentDir(tmpDir);
});

afterEach(async () => {
	setAgentDir(originalAgentDir);
	if (originalEnv === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = originalEnv;
	}
	setConfigRootDir(undefined);
	await fs.rm(tmpDir, { recursive: true, force: true });
	mock.restore();
});

describe("identity tool — whoisme", () => {
	test("returns empty template when user.md is absent", async () => {
		const tool = makeTool();
		const result = await tool.execute("call-1", { action: "whoisme" });
		const text = result.content[0];
		expect(text?.type).toBe("text");
		expect((text as { text: string }).text).toContain("No user persona found");
		// Template advertises the canonical sections.
		expect((text as { text: string }).text).toContain("## basics");
	});

	test("returns full content when user.md exists", async () => {
		const userMd = path.join(tmpDir, "user.md");
		await Bun.write(userMd, "# User\n\n## basics\n- name: Alice\n");
		const tool = makeTool();
		const result = await tool.execute("call-1", { action: "whoisme" });
		expect((result.content[0] as { text: string }).text).toContain("Alice");
	});
});

describe("identity tool — update_persona", () => {
	test("creates user.md and writes a section when absent", async () => {
		const tool = makeTool();
		const result = await tool.execute("call-1", {
			action: "update_persona",
			section: "basics",
			data: { name: "彭梦龙", role: "GM" },
		});
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain('Updated section "basics"');

		const written = await Bun.file(path.join(tmpDir, "user.md")).text();
		expect(written).toContain("## basics");
		expect(written).toContain("- name: 彭梦龙");
		expect(written).toContain("- role: GM");
	});

	test("appends to an existing section, preserving other sections", async () => {
		const userMd = path.join(tmpDir, "user.md");
		await Bun.write(userMd, "# User\n\n## basics\n- name: Alice\n\n## career\n- company: Acme\n");
		const tool = makeTool();
		await tool.execute("call-1", {
			action: "update_persona",
			section: "basics",
			data: { timezone: "Asia/Shanghai" },
		});
		const written = await Bun.file(userMd).text();
		// Existing basics bullet preserved.
		expect(written).toContain("- name: Alice");
		// New bullet merged.
		expect(written).toContain("- timezone: Asia/Shanghai");
		// Other section untouched.
		expect(written).toContain("## career");
		expect(written).toContain("- company: Acme");
	});

	test("inserts a new section in canonical order", async () => {
		const userMd = path.join(tmpDir, "user.md");
		await Bun.write(userMd, "# User\n\n## preferences\n- lang: zh\n");
		const tool = makeTool();
		await tool.execute("call-1", {
			action: "update_persona",
			section: "basics", // basics comes before preferences canonically
			data: { name: "Bob" },
		});
		const written = await Bun.file(userMd).text();
		const basicsIdx = written.indexOf("## basics");
		const prefIdx = written.indexOf("## preferences");
		expect(basicsIdx).toBeGreaterThan(-1);
		expect(prefIdx).toBeGreaterThan(-1);
		expect(basicsIdx).toBeLessThan(prefIdx);
	});

	test("rejects an invalid section name", async () => {
		const tool = makeTool();
		expect(async () => {
			await tool.execute("call-1", {
				action: "update_persona",
				section: "bio",
				data: { name: "X" },
			});
		}).toThrow("Invalid section");
	});

	test("rejects empty data", async () => {
		const tool = makeTool();
		expect(async () => {
			await tool.execute("call-1", {
				action: "update_persona",
				section: "basics",
				data: {},
			});
		}).toThrow("data is required");
	});

	test("merges by key instead of duplicating", async () => {
		const userMd = path.join(tmpDir, "user.md");
		await Bun.write(userMd, "# User\n\n## basics\n- name: Alice\n- role: Engineer\n");
		const tool = makeTool();
		// Update an existing key (name) and add a new key (timezone).
		await tool.execute("call-1", {
			action: "update_persona",
			section: "basics",
			data: { name: "Bob", timezone: "UTC" },
		});
		const written = await Bun.file(userMd).text();
		const nameMatches = written.match(/- name: (.*)/g);
		expect(nameMatches).toEqual(["- name: Bob"]);
		expect(written).toContain("- role: Engineer");
		expect(written).toContain("- timezone: UTC");
	});

	test("deduplicates pre-existing duplicate keys", async () => {
		const userMd = path.join(tmpDir, "user.md");
		// Simulate a file that already has a duplicate key (e.g. from a prior append).
		await Bun.write(userMd, "# User\n\n## basics\n- name: Alice\n- name: Bob\n");
		const tool = makeTool();
		await tool.execute("call-1", {
			action: "update_persona",
			section: "basics",
			data: { name: "Carol" },
		});
		const written = await Bun.file(userMd).text();
		const nameMatches = written.match(/- name: (.*)/g);
		expect(nameMatches).toEqual(["- name: Carol"]);
	});
});

describe("identity tool — whoisme roundtrip", () => {
	test("whoisme returns what update_persona wrote", async () => {
		const tool = makeTool();
		await tool.execute("call-1", {
			action: "update_persona",
			section: "career",
			data: { company: "Narwal", focus: "robots" },
		});
		const result = await tool.execute("call-2", { action: "whoisme" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("## career");
		expect(text).toContain("- company: Narwal");
		expect(text).toContain("- focus: robots");
	});
});

describe("identity tool — whoRu", () => {
	test("returns operational identity with cwd and version", async () => {
		const tool = makeTool();
		const result = await tool.execute("call-1", { action: "whoRu" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Oh My Pi (OMP) coding agent");
		expect(text).toContain(`working directory: ${tmpDir}`);
		expect(text).toMatch(/version: \d+\.\d+\.\d+/);
	});
});
