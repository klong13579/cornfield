/**
 * `cornfield plugin list --json` prints every installed plugin in a single
 * write; the count is whatever the user installed.
 *
 * With `console.log` a registry of 500 plugins came back cut — 213429 bytes
 * into a file, 65536 into a pipe, exit code 0 — so `plugin list --json | jq`
 * parsed a truncated registry.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PIPE_CAPACITY, runBothWays } from "./helpers/cli-pipe";

/** Enough installed plugins that the listing clears the pipe buffer. */
const PLUGINS = 500;

let root = "";
let registryPath = "";

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "cornfield-plugin-pipe-"));
	registryPath = path.join(root, "home", ".cornfield", "plugins", "installed_plugins.json");
	const plugins: Record<string, unknown[]> = {};
	for (let i = 0; i < PLUGINS; i++) {
		const id = `plugin-with-a-long-name-${String(i).padStart(4, "0")}@marketplace-with-a-long-name`;
		plugins[id] = [
			{
				scope: "user",
				installPath: path.join(root, "cache", "plugins", id, String(i)),
				version: "1.2.3",
				installedAt: "2026-01-01T00:00:00.000Z",
				lastUpdated: "2026-01-01T00:00:00.000Z",
			},
		];
	}
	await Bun.write(registryPath, `${JSON.stringify({ version: 2, plugins }, null, 2)}\n`);
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

/** The file leg's destination stays outside the plugin cache the command reads. */
function outPath(name: string): string {
	return path.join(root, name);
}

function env(): Record<string, string> {
	// A non-default agent dir keeps XDG redirection off, so the plugin registry
	// resolves under the temp HOME rather than a real one.
	return { HOME: path.join(root, "home"), CORNFIELD_AGENT_DIR: path.join(root, "config") };
}

describe("plugin output through a pipe", () => {
	it("delivers the whole plugin listing", async () => {
		const { piped, file } = await runBothWays({
			args: ["plugin", "list", "--json"],
			env: env(),
			outPath: outPath("list.json"),
		});

		// A payload that already fits in the pipe proves nothing, so its size is
		// asserted before the bytes are compared.
		expect(file.length).toBeGreaterThan(PIPE_CAPACITY);
		expect(piped).toBe(file);

		const listing = JSON.parse(piped) as { marketplace: Array<{ id: string }> };
		expect(listing.marketplace.length).toBe(PLUGINS);
		// The last entry sits in the bytes the pipe used to drop.
		expect(
			listing.marketplace.some(p =>
				p.id.startsWith(`plugin-with-a-long-name-${String(PLUGINS - 1).padStart(4, "0")}`),
			),
		).toBe(true);
	});
});
