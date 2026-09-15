import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir, setAgentDir } from "@cornfield/utils";
import { runConfigCommand } from "../src/cli/config-cli";
import { _resetSettingsForTest } from "../src/config/settings";

let testAgentDir = "";
const originalAgentDir = process.env.CORNFIELD_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

beforeEach(async () => {
	_resetSettingsForTest();
	testAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-config-cli-"));
	setAgentDir(testAgentDir);
});

afterEach(async () => {
	vi.restoreAllMocks();
	_resetSettingsForTest();
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.CORNFIELD_AGENT_DIR;
	}
	await fs.rm(testAgentDir, { recursive: true, force: true });
});

/**
 * Capture everything the command writes to stdout.
 *
 * `config` writes through `@cornfield/utils/cli`'s `writeStdout`, not
 * `console.log`: a single `console.log` payload larger than the pipe buffer is
 * cut when stdout is a pipe, so the command has no other exit. The logger's
 * console transport writes to the same stream, which is why the documents are
 * picked by shape rather than counted as raw chunks.
 */
function captureStdout(): string[] {
	const chunks: string[] = [];
	const decoder = new TextDecoder();
	vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
		chunks.push(typeof chunk === "string" ? chunk : decoder.decode(chunk));
		return true;
	}) as typeof process.stdout.write);
	return chunks;
}

/** The JSON documents written to stdout, in order. */
function jsonDocuments(chunks: string[]): string[] {
	return chunks.map(chunk => chunk.trim()).filter(chunk => chunk.startsWith("{") && chunk.endsWith("}"));
}

describe("config CLI schema coverage", () => {
	it("lists non-UI schema settings in JSON output", async () => {
		const stdout = captureStdout();

		await runConfigCommand({ action: "list", flags: { json: true } });

		const documents = jsonDocuments(stdout);
		expect(documents.length).toBe(1);
		const parsed = JSON.parse(documents[0]) as Record<string, { type: string; description: string }>;

		expect(parsed.enabledModels).toBeDefined();
		expect(parsed.enabledModels.type).toBe("array");
		expect(parsed.enabledModels.description).toBe("");
	});

	it("gets non-UI schema settings by key", async () => {
		const stdout = captureStdout();

		await runConfigCommand({ action: "get", key: "enabledModels", flags: { json: true } });

		const documents = jsonDocuments(stdout);
		expect(documents.length).toBe(1);
		const parsed = JSON.parse(documents[0]) as {
			key: string;
			type: string;
			description: string;
		};

		expect(parsed.key).toBe("enabledModels");
		expect(parsed.type).toBe("array");
		expect(parsed.description).toBe("");
	});

	it("renders record settings as JSON and with record type in text output", async () => {
		const stdout = captureStdout();

		await runConfigCommand({ action: "list", flags: {} });

		const lines = stdout.join("").split("\n");
		const plainLines = lines.map(line => Bun.stripANSI(line));
		const modelRoutesLine = plainLines.find(line => line.includes("modelRoutes ="));
		expect(modelRoutesLine).toBeDefined();
		const plainModelRoutesLine = String(modelRoutesLine);
		expect(plainModelRoutesLine).toContain("modelRoutes =");
		expect(plainModelRoutesLine).toContain("(record)");
		expect(plainModelRoutesLine).toContain("{");
		expect(plainModelRoutesLine).toContain("}");
		expect(plainModelRoutesLine).not.toContain("[object Object]");
	});

	it("sets and gets record settings as JSON objects", async () => {
		const stdout = captureStdout();
		const recordValue = '{"default":{"primary":"claude-opus-4-6","fallbacks":[]}}';

		await runConfigCommand({ action: "set", key: "modelRoutes", value: recordValue, flags: { json: true } });
		await runConfigCommand({ action: "get", key: "modelRoutes", flags: { json: true } });

		const payload = jsonDocuments(stdout).at(-1);
		expect(typeof payload).toBe("string");
		const parsed = JSON.parse(String(payload)) as { key: string; value: unknown; type: string };
		expect(parsed.key).toBe("modelRoutes");
		expect(parsed.type).toBe("record");
		expect(parsed.value).toEqual({ default: { primary: "claude-opus-4-6", fallbacks: [] } });
	});

	it("sets and gets array settings as JSON arrays", async () => {
		const stdout = captureStdout();
		const arrayValue = '["claude-opus-4-6","gpt-5.3-codex"]';

		await runConfigCommand({ action: "set", key: "enabledModels", value: arrayValue, flags: { json: true } });
		await runConfigCommand({ action: "get", key: "enabledModels", flags: { json: true } });

		const payload = jsonDocuments(stdout).at(-1);
		expect(typeof payload).toBe("string");
		const parsed = JSON.parse(String(payload)) as { key: string; value: unknown; type: string };
		expect(parsed.key).toBe("enabledModels");
		expect(parsed.type).toBe("array");
		expect(parsed.value).toEqual(["claude-opus-4-6", "gpt-5.3-codex"]);
	});
	it("sets numeric idle compaction settings from CLI values", async () => {
		const stdout = captureStdout();
		await runConfigCommand({
			action: "set",
			key: "compaction.idleThresholdTokens",
			value: "300000",
			flags: { json: true },
		});
		await runConfigCommand({
			action: "set",
			key: "compaction.idleTimeoutSeconds",
			value: "600",
			flags: { json: true },
		});
		await runConfigCommand({ action: "get", key: "compaction.idleThresholdTokens", flags: { json: true } });
		await runConfigCommand({ action: "get", key: "compaction.idleTimeoutSeconds", flags: { json: true } });

		const documents = jsonDocuments(stdout);
		const thresholdPayload = documents.at(-2);
		const timeoutPayload = documents.at(-1);
		expect(typeof thresholdPayload).toBe("string");
		expect(typeof timeoutPayload).toBe("string");
		expect(JSON.parse(String(thresholdPayload))).toMatchObject({
			key: "compaction.idleThresholdTokens",
			type: "number",
			value: 300000,
		});
		expect(JSON.parse(String(timeoutPayload))).toMatchObject({
			key: "compaction.idleTimeoutSeconds",
			type: "number",
			value: 600,
		});
	});
});
