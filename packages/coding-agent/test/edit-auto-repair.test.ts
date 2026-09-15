import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Model } from "@cornfield/ai";
import { Settings } from "@cornfield/coding-agent/config/settings";
import {
	computeRepairRegion,
	type EditParseRegression,
	EditValidationError,
	editToolRenderer,
	validateEditedFile,
	withValidationNote,
} from "@cornfield/coding-agent/edit";
import type { ToolSession } from "@cornfield/coding-agent/tools";
import { isEnoent } from "@cornfield/utils";
import { createRenderSurface } from "./helpers/render-assert";

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

let dir: string;
let agentDir: string;

const autoRepairOverrides = {
	"edit.autoRepair.enabled": true,
	"edit.autoRepair.maxAttempts": 2,
	"edit.autoRepair.modelRole": "smol",
	modelRoutes: { smol: { primary: "smol-model" } },
};

const hardeningOverrides = {
	"edit.validate.enabled": true,
	"edit.autoRepair.enabled": true,
	"edit.autoRepair.maxAttempts": 1,
	"edit.autoRepair.modelRole": "smol",
	modelRoutes: { smol: { primary: "smol-model" } },
};

function makeSession(overrides: Record<string, unknown>): ToolSession {
	const settings = Settings.isolated(
		{
			"edit.validate.enabled": true,
			"edit.autoRepair.enabled": false,
			...overrides,
		},
		{ agentDir },
	);
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

/** Corpus records written so far, oldest first; `[]` when nothing was recorded. */
async function readCorpus(fileName = "edit-blackbox.jsonl"): Promise<EditParseRegression[]> {
	try {
		const text = await fs.readFile(path.join(agentDir, fileName), "utf8");
		return text
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as EditParseRegression);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
}

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-autorepair-"));
	agentDir = path.join(dir, "agent-dir");
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

describe("defaults", () => {
	test("edit.autoRepair.enabled defaults to true", () => {
		const settings = Settings.isolated({});
		expect(settings.get("edit.autoRepair.enabled")).toBe(true);
	});

	test("edit.blackbox.enabled defaults to false", () => {
		const settings = Settings.isolated({});
		expect(settings.get("edit.blackbox.enabled")).toBe(false);
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

	test("does not call the model when auto-repair is disabled", async () => {
		const file = path.join(dir, "a.ts");
		const original = "const total = 5;\n";
		await fs.writeFile(file, "const total = ;\n");

		let calls = 0;
		const complete = async (): Promise<AssistantMessage> => {
			calls += 1;
			return assistantText("const total = 0;");
		};
		const session = makeSession({ ...autoRepairOverrides, "edit.autoRepair.enabled": false });

		await expect(
			validateEditedFile({ session, absolutePath: file, displayPath: "a.ts", originalContent: original, complete }),
		).rejects.toBeInstanceOf(EditValidationError);
		expect(calls).toBe(0);
		await expect(fs.readFile(file, "utf8")).resolves.toBe(original);
	});
});

describe("edit auto-repair adoption hardening", () => {
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

	test("rejects a candidate that restores a line the edit deleted", async () => {
		const file = path.join(dir, "a.ts");
		const original = "class A {\n\tm() {\n\t\treturn 1;\n\t}\n}\n";
		const broken = "class A {\n\tm() {\n\t\treturn 1;\n}\n";
		await fs.writeFile(file, broken);

		// The culprit hunk is the deleted line, so the editable span is empty and
		// the model's only way to "fix" the file is to put that line back.
		const complete = async (): Promise<AssistantMessage> => assistantText("\t}");
		const session = makeSession(hardeningOverrides);

		await expect(
			validateEditedFile({ session, absolutePath: file, displayPath: "a.ts", originalContent: original, complete }),
		).rejects.toBeInstanceOf(EditValidationError);
		await expect(fs.readFile(file, "utf8")).resolves.toBe(original);
	});

	test("realigns a candidate that echoed a context line without its indentation", async () => {
		const file = path.join(dir, "a.ts");
		const original = "function f() {\n\tconst a = 1;\n\tconst b = 2;\n\tconst c = 3;\n}\n";
		const broken = "function f() {\n\tconst a = (1;\n\tconst b = 2;\n\tconst c = ;\n}\n";
		await fs.writeFile(file, broken);

		// The middle line is unchanged context the model echoed back without its tab.
		const complete = async (): Promise<AssistantMessage> =>
			assistantText("\tconst a = 0;\nconst b = 2;\n\tconst c = 3;");
		const session = makeSession(autoRepairOverrides);

		await expect(
			validateEditedFile({ session, absolutePath: file, displayPath: "a.ts", originalContent: original, complete }),
		).resolves.toMatchObject({ outcome: "repaired" });
		await expect(fs.readFile(file, "utf8")).resolves.toBe(
			"function f() {\n\tconst a = 0;\n\tconst b = 2;\n\tconst c = 3;\n}\n",
		);
	});
});

describe("repair localization", () => {
	const TS_PATH = "/tmp/edit-repair-localization.ts";

	test("isolates the minimal hunk instead of the span between first and last change", () => {
		const prev = ["export function f() {", "  return 1;", "}", "", "export const x = 1;", ""].join("\n");
		const next = ["export function f() {", "  return 2;", "}", "", "export const x = ;", ""].join("\n");

		const region = computeRepairRegion({ path: TS_PATH, prev, next, maxRegionLines: 150 });

		expect(region).toBeDefined();
		// Lines 2 and 5 both changed; only line 5 is the breakage.
		expect(region!.editStartLine).toBe(5);
		expect(region!.editEndLine).toBe(5);
		expect(region!.revertedText).toBe("export const x = 1;");
		expect(region!.language).toBe("typescript");
		// Context is carried for the model but never rewritten: BEFORE and AFTER
		// differ on the culprit line alone.
		expect(region!.brokenText.split("\n")[4]).toBe("export const x = ;");
		expect(region!.referenceText.split("\n")[4]).toBe("export const x = 1;");
		expect(region!.brokenText.split("\n")[1]).toBe(region!.referenceText.split("\n")[1]);
	});

	test("isolates a pair of hunks when neither alone restores the parse", () => {
		const prev = "function f() {\n\tconst a = 1;\n\tconst b = 2;\n\tconst c = 3;\n}\n";
		const next = "function f() {\n\tconst a = (1;\n\tconst b = 2;\n\tconst c = ;\n}\n";

		const region = computeRepairRegion({ path: TS_PATH, prev, next, maxRegionLines: 150 });

		expect(region).toBeDefined();
		expect(region!.editStartLine).toBe(2);
		expect(region!.editEndLine).toBe(4);
		expect(region!.revertedText).toBe("\tconst a = 1;\n\tconst b = 2;\n\tconst c = 3;");
	});

	test("declines a region larger than the configured limit", () => {
		const prev = "function f() {\n\tconst a = 1;\n\tconst b = 2;\n\tconst c = 3;\n}\n";
		const next = "function f() {\n\tconst a = (1;\n\tconst b = 2;\n\tconst c = ;\n}\n";

		expect(computeRepairRegion({ path: TS_PATH, prev, next, maxRegionLines: 2 })).toBeUndefined();
	});

	test("declines when the pre-image itself does not parse", () => {
		const prev = "const a = ;\n";
		const next = "const a = );\n";

		expect(computeRepairRegion({ path: TS_PATH, prev, next, maxRegionLines: 150 })).toBeUndefined();
	});
});

describe("parse regression corpus", () => {
	test("records before, after, path and adoption when enabled", async () => {
		const file = path.join(dir, "a.ts");
		const original = "const total = 5;\n";
		const broken = "const total = ;\n";
		await fs.writeFile(file, broken);

		const complete = async (): Promise<AssistantMessage> => assistantText("const total = 0;");
		const session = makeSession({ ...autoRepairOverrides, "edit.blackbox.enabled": true });

		await validateEditedFile({
			session,
			absolutePath: file,
			displayPath: "a.ts",
			originalContent: original,
			complete,
		});

		const records = await readCorpus();
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			path: "a.ts",
			language: "typescript",
			before: original,
			after: broken,
			adopted: true,
		});
		expect(Number.isNaN(Date.parse(records[0].timestamp))).toBe(false);
	});

	test("records the rollback too, with adopted false", async () => {
		const file = path.join(dir, "a.ts");
		const original = "const total = 5;\n";
		const broken = "const total = ;\n";
		await fs.writeFile(file, broken);

		const session = makeSession({ "edit.blackbox.enabled": true });

		await expect(
			validateEditedFile({ session, absolutePath: file, displayPath: "a.ts", originalContent: original }),
		).rejects.toBeInstanceOf(EditValidationError);

		const records = await readCorpus();
		expect(records).toHaveLength(1);
		expect(records[0].adopted).toBe(false);
		expect(records[0].after).toBe(broken);
	});

	test("writes nothing when disabled", async () => {
		const file = path.join(dir, "a.ts");
		await fs.writeFile(file, "const total = ;\n");

		const session = makeSession({});
		await expect(
			validateEditedFile({
				session,
				absolutePath: file,
				displayPath: "a.ts",
				originalContent: "const total = 5;\n",
			}),
		).rejects.toBeInstanceOf(EditValidationError);

		await expect(readCorpus()).resolves.toEqual([]);
	});

	test("rotates the corpus once it reaches the configured size", async () => {
		const file = path.join(dir, "a.ts");
		const original = "const total = 5;\n";
		const session = makeSession({
			"edit.autoRepair.enabled": false,
			"edit.blackbox.enabled": true,
			"edit.blackbox.maxBytes": 16,
		});

		for (const broken of ["const total = ;\n", "const total = );\n"]) {
			await fs.writeFile(file, broken);
			await expect(
				validateEditedFile({ session, absolutePath: file, displayPath: "a.ts", originalContent: original }),
			).rejects.toBeInstanceOf(EditValidationError);
		}

		const current = await readCorpus();
		const rotated = await readCorpus("edit-blackbox.jsonl.1");
		expect(current).toHaveLength(1);
		expect(current[0].after).toBe("const total = );\n");
		expect(rotated).toHaveLength(1);
		expect(rotated[0].after).toBe("const total = ;\n");
	});
});

describe("repair result rendering", () => {
	test("renders the adopted repair note within the render width", async () => {
		const surface = await createRenderSurface();
		const file = path.join(dir, "a.ts");
		const original = "const total = 5;\n";
		await fs.writeFile(file, "const total = ;\n");

		const complete = async (): Promise<AssistantMessage> => assistantText("const total = 0;");
		const session = makeSession(autoRepairOverrides);
		const outcome = await validateEditedFile({
			session,
			absolutePath: file,
			displayPath: "a.ts",
			originalContent: original,
			complete,
		});
		expect(outcome.outcome).toBe("repaired");

		const note = outcome.note ?? "";
		const renderResult = () =>
			editToolRenderer.renderResult(
				{
					content: [{ type: "text", text: note }],
					details: { diff: "", diagnostics: withValidationNote(undefined, note) },
				},
				{ expanded: false, isPartial: false },
				surface.theme,
				{ path: "a.ts" },
			);

		const text = surface.expectStable(renderResult);
		expect(text).toContain("auto-repair adopted a parseable fix");
		surface.expectWithinWidth(renderResult());
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
