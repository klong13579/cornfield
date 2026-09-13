import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Model } from "@cornfield/ai";
import { Settings } from "@cornfield/coding-agent/config/settings";
import { EditValidationError, validateEditedFile } from "@cornfield/coding-agent/edit";
import type { ToolSession } from "@cornfield/coding-agent/tools";

const smolModel = {
	id: "smol-model",
	name: "smol-model",
	api: "openai-completions",
	provider: "test",
	baseUrl: "https://example.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4096,
} as Model;

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "test",
		model: "smol-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeSession(overrides: Record<string, unknown>): ToolSession {
	const settings = Settings.isolated({
		"edit.validate.enabled": true,
		"edit.autoRepair.enabled": false,
		...overrides,
	});
	return {
		cwd: os.tmpdir(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		settings,
		modelRegistry: {
			getAvailable: () => [smolModel],
			getApiKey: async () => "test-key",
		} as unknown as ToolSession["modelRegistry"],
	};
}

let dir: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-autorepair-"));
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

describe("defaults", () => {
	test("edit.autoRepair.enabled defaults to true", () => {
		const settings = Settings.isolated({});
		expect(settings.get("edit.autoRepair.enabled")).toBe(true);
	});
});

describe("edit post-write validation", () => {
	test("rolls back a broken edit and reports the damage site", async () => {
		const file = path.join(dir, "a.ts");
		const original = "const a = 1;\nconst b = 2;\n";
		const broken = "const a = 1;\nconst = 2;\n";
		await fs.writeFile(file, broken);

		const session = makeSession({});
		await expect(
			validateEditedFile({ session, absolutePath: file, displayPath: "a.ts", originalContent: original }),
		).rejects.toBeInstanceOf(EditValidationError);

		await expect(fs.readFile(file, "utf8")).resolves.toBe(original);
	});

	test("reports the first changed line in the validation error", async () => {
		const file = path.join(dir, "a.ts");
		const original = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
		const broken = "const a = 1;\nconst b = 2;\nconst = 3;\n";
		await fs.writeFile(file, broken);

		const session = makeSession({});
		try {
			await validateEditedFile({ session, absolutePath: file, displayPath: "a.ts", originalContent: original });
			throw new Error("expected validation to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(EditValidationError);
			expect((err as EditValidationError).badLine).toBe(3);
			expect((err as Error).message).toContain("a.ts");
			expect((err as Error).message).toContain("typescript");
		}
	});

	test("does nothing when validation is disabled", async () => {
		const file = path.join(dir, "a.ts");
		const broken = "const a = 1;\nconst = 2;\n";
		await fs.writeFile(file, broken);

		const session = makeSession({ "edit.validate.enabled": false });
		await expect(
			validateEditedFile({
				session,
				absolutePath: file,
				displayPath: "a.ts",
				originalContent: "const a = 1;\nconst b = 2;\n",
			}),
		).resolves.toEqual({ outcome: "clean" });
		await expect(fs.readFile(file, "utf8")).resolves.toBe(broken);
	});
});

describe("edit auto-repair", () => {
	const autoRepairOverrides = {
		"edit.autoRepair.enabled": true,
		"edit.autoRepair.maxAttempts": 2,
		"edit.autoRepair.modelRole": "smol",
		modelRoutes: { smol: { primary: "smol-model" } },
	};

	test("adopts a parseable, non-undo repair", async () => {
		const file = path.join(dir, "a.ts");
		const original = "const total = 5;\n";
		const broken = "const total = ;\n";
		await fs.writeFile(file, broken);

		const complete = async (): Promise<AssistantMessage> => assistantText("const total = 0;");
		const session = makeSession(autoRepairOverrides);

		await expect(
			validateEditedFile({ session, absolutePath: file, displayPath: "a.ts", originalContent: original, complete }),
		).resolves.toMatchObject({ outcome: "repaired", note: expect.any(String) });
		await expect(fs.readFile(file, "utf8")).resolves.toBe("const total = 0;\n");
	});

	test("rejects a verbatim undo and rolls back", async () => {
		const file = path.join(dir, "a.ts");
		const original = "const total = 5;\n";
		const broken = "const total = ;\n";
		await fs.writeFile(file, broken);

		const complete = async (): Promise<AssistantMessage> => assistantText("const total = 5;");
		const session = makeSession(autoRepairOverrides);

		await expect(
			validateEditedFile({ session, absolutePath: file, displayPath: "a.ts", originalContent: original, complete }),
		).rejects.toBeInstanceOf(EditValidationError);
		await expect(fs.readFile(file, "utf8")).resolves.toBe(original);
	});

	test("rejects a still-broken repair and rolls back", async () => {
		const file = path.join(dir, "a.ts");
		const original = "const total = 5;\n";
		const broken = "const total = ;\n";
		await fs.writeFile(file, broken);

		const complete = async (): Promise<AssistantMessage> => assistantText("const total = ;");
		const session = makeSession(autoRepairOverrides);

		await expect(
			validateEditedFile({ session, absolutePath: file, displayPath: "a.ts", originalContent: original, complete }),
		).rejects.toBeInstanceOf(EditValidationError);
		await expect(fs.readFile(file, "utf8")).resolves.toBe(original);
	});
});

describe("edit auto-repair adoption hardening", () => {
	const hardeningOverrides = {
		"edit.validate.enabled": true,
		"edit.autoRepair.enabled": true,
		"edit.autoRepair.maxAttempts": 1,
		"edit.autoRepair.modelRole": "smol",
		modelRoutes: { smol: { primary: "smol-model" } },
	};

	test("rolls back an unclosed-brace edit without auto-repair", async () => {
		const file = path.join(dir, "a.ts");
		const original = "function foo() {\n  return 1;\n}\n";
		const broken = "function foo() {\n  return 1;\n";
		await fs.writeFile(file, broken);

		const session = makeSession({});
		await expect(
			validateEditedFile({ session, absolutePath: file, displayPath: "a.ts", originalContent: original }),
		).rejects.toBeInstanceOf(EditValidationError);
		await expect(fs.readFile(file, "utf8")).resolves.toBe(original);
	});

	test("rejects a whitespace-only undo candidate and rolls back", async () => {
		const file = path.join(dir, "a.ts");
		const original = "const total = 5;\n";
		const broken = "const total = ;\n";
		await fs.writeFile(file, broken);

		const complete = async (): Promise<AssistantMessage> => assistantText("const total =  5;");
		const session = makeSession(hardeningOverrides);

		await expect(
			validateEditedFile({ session, absolutePath: file, displayPath: "a.ts", originalContent: original, complete }),
		).rejects.toBeInstanceOf(EditValidationError);
		await expect(fs.readFile(file, "utf8")).resolves.toBe(original);
	});

	test("rejects a candidate that dropped every inserted line", async () => {
		const file = path.join(dir, "a.ts");
		const original = "const a = 1;\n";
		const broken = "const a = 1;\nconst b = {\n";
		await fs.writeFile(file, broken);

		const complete = async (): Promise<AssistantMessage> => assistantText("const c = 3;");
		const session = makeSession(hardeningOverrides);

		await expect(
			validateEditedFile({ session, absolutePath: file, displayPath: "a.ts", originalContent: original, complete }),
		).rejects.toBeInstanceOf(EditValidationError);
		await expect(fs.readFile(file, "utf8")).resolves.toBe(original);
	});

	test("adopts a repair that keeps the inserted line", async () => {
		const file = path.join(dir, "a.ts");
		const original = "const a = 1;\n";
		const broken = "const a = 1;\nconst b = {\n";
		await fs.writeFile(file, broken);

		const complete = async (): Promise<AssistantMessage> => assistantText("const b = { x: 1 };");
		const session = makeSession(hardeningOverrides);

		await expect(
			validateEditedFile({ session, absolutePath: file, displayPath: "a.ts", originalContent: original, complete }),
		).resolves.toMatchObject({ outcome: "repaired", note: expect.any(String) });
		await expect(fs.readFile(file, "utf8")).resolves.toBe("const a = 1;\nconst b = { x: 1 };\n");
	});
});

describe("format prompt size", () => {
	test("six format prompts stay under 150 lines total", async () => {
		const promptsDir = path.join(import.meta.dir, "..", "src", "prompts", "tools");
		const names = ["atom.md", "patch.md", "hashline.md", "apply-patch.md", "replace.md", "vim.md"];
		let total = 0;
		for (const name of names) {
			const content = await fs.readFile(path.join(promptsDir, name), "utf8");
			total += content.split("\n").length;
		}
		expect(total).toBeLessThan(150);
	});
});
