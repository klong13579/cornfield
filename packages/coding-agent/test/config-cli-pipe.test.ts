/**
 * `cornfield config list|get` print one document in a single write, and that
 * document is user data — an array setting is as large as the user made it.
 *
 * With `console.log`, a config whose `enabledModels` array crosses the pipe
 * buffer came back cut: `config get enabledModels --json` wrote 236086 bytes
 * into a file and 65536 into a pipe, exit code 0, so `config get … | jq`
 * silently parsed a truncated array.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PIPE_CAPACITY, runBothWays } from "./helpers/cli-pipe";

/** Enough entries that every document below clears the pipe buffer. */
const ENTRIES = 4000;
const LAST_ENTRY = `seed-provider/model-with-a-long-identifier-${String(ENTRIES - 1).padStart(5, "0")}`;

let root = "";
/** The client dir: the default Agent's global config is read from `<client dir>/config.yml`. */
let clientDir = "";

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "cornfield-config-pipe-"));
	clientDir = path.join(root, "agent");
	await fs.mkdir(clientDir, { recursive: true });
	const list = Array.from(
		{ length: ENTRIES },
		(_, i) => `  - seed-provider/model-with-a-long-identifier-${String(i).padStart(5, "0")}`,
	);
	await Bun.write(path.join(clientDir, "config.yml"), `enabledModels:\n${list.join("\n")}\n`);
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

/** The file leg's destination lives outside the config dir the command reads. */
function outPath(name: string): string {
	return path.join(root, name);
}

/**
 * Point both roots at the temp tree: `CORNFIELD_CONFIG_DIR` names the config root,
 * `CORNFIELD_CLIENT_DIR` the client dir the default Agent's global config is read
 * from. `CORNFIELD_AGENT_DIR` — which this fixture used to set — names neither root
 * any more, so the command fell back to the developer's own `~/.cornfield` and the
 * document came out far below the pipe buffer: the three size assertions above then
 * failed against a document this fixture never produced.
 */
function env(): Record<string, string> {
	return { CORNFIELD_CONFIG_DIR: root, CORNFIELD_CLIENT_DIR: clientDir };
}

describe("config output through a pipe", () => {
	it("delivers the whole settings document", async () => {
		const { piped, file } = await runBothWays({
			args: ["config", "list", "--json"],
			env: env(),
			outPath: outPath("list.json"),
		});

		// A payload that already fits in the pipe proves nothing, so its size is
		// asserted before the bytes are compared.
		expect(file.length).toBeGreaterThan(PIPE_CAPACITY);
		expect(piped).toBe(file);

		const settings = JSON.parse(piped) as { enabledModels: { value: string[] } };
		expect(settings.enabledModels.value.length).toBe(ENTRIES);
	});

	it("delivers the whole JSON value document, tail included", async () => {
		const { piped, file } = await runBothWays({
			args: ["config", "get", "enabledModels", "--json"],
			env: env(),
			outPath: outPath("get.json"),
		});

		expect(file.length).toBeGreaterThan(PIPE_CAPACITY);
		expect(piped).toBe(file);

		const parsed = JSON.parse(piped) as { value: string[] };
		expect(parsed.value.length).toBe(ENTRIES);
		// The last entry sits in the bytes the pipe used to drop.
		expect(piped).toContain(LAST_ENTRY);
	});

	it("delivers the whole plain value, tail included", async () => {
		const { piped, file } = await runBothWays({
			args: ["config", "get", "enabledModels"],
			env: env(),
			outPath: outPath("get.txt"),
		});

		expect(file.length).toBeGreaterThan(PIPE_CAPACITY);
		expect(piped).toBe(file);
		expect(piped).toContain(LAST_ENTRY);
	});

	it("keeps small output on stdout too", async () => {
		const { piped, file } = await runBothWays({
			args: ["config", "get", "stt.modelName"],
			env: env(),
			outPath: outPath("model.txt"),
		});

		expect(piped).toBe(file);
		expect(piped.endsWith("\n")).toBe(true);
	});
});
