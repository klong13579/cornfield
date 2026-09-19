/**
 * `cornfield agent list|show|validate` print one document in a single write,
 * and every document's size is a function of user data: the number of
 * agentDirs under the root, the length of a workspace's AGENTS.md, the number
 * of MECE violations in its prompt files.
 *
 * With `console.log` each of them came back cut when stdout was a pipe —
 * `agent validate --json` wrote 1215695 bytes into a file and 196608 into a
 * pipe, exit code 0 — so `cornfield agent validate --json | jq` parsed a truncated
 * document.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PIPE_CAPACITY, runBothWays } from "./helpers/cli-pipe";

/** Enough agentDirs that the listing clears the pipe buffer. */
const DIRS = 400;
/** Enough hard constraints that `show` clears it. */
const CONSTRAINTS = 3000;
/** Enough placeholder lines that `validate` clears it. */
const PLACEHOLDERS = 2000;

let root = "";
let listRoot = "";
let agentRoot = "";
let fatDir = "";
let meceDir = "";

/** The always-on files `agent validate` requires before it reports a valid dir. */
async function writeSkeleton(dir: string, agentsMd: string, missionMd: string): Promise<void> {
	await fs.mkdir(path.join(dir, "knowledge"), { recursive: true });
	await fs.mkdir(path.join(dir, ".cornfield"), { recursive: true });
	await Bun.write(path.join(dir, "AGENTS.md"), agentsMd);
	await Bun.write(path.join(dir, "mission.md"), missionMd);
	await Bun.write(path.join(dir, "TOOLS.md"), "# Tools\n");
	await Bun.write(path.join(dir, "TODO.md"), "# TODO\n");
	await Bun.write(path.join(dir, "knowledge", "external-workspaces.md"), "# External workspaces\n");
	await Bun.write(path.join(dir, ".cornfield", "config.yml"), "modelRoutes: {}\n");
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "cornfield-agent-pipe-"));
	listRoot = path.join(root, "list-root");
	await fs.mkdir(listRoot, { recursive: true });
	for (let i = 0; i < DIRS; i++) {
		const dir = path.join(listRoot, `agent-with-a-longish-name-${String(i).padStart(4, "0")}`);
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(path.join(dir, "mission.md"), "# mission\n");
	}

	agentRoot = path.join(root, "agent-root");
	fatDir = path.join(agentRoot, "fat-agent");
	meceDir = path.join(agentRoot, "mece-agent");
	const constraints = Array.from(
		{ length: CONSTRAINTS },
		(_, i) => `- MUST NOT do thing number ${i} because of a long explanatory clause that keeps the line wide`,
	);
	await writeSkeleton(fatDir, `# AGENTS.md\n\n${constraints.join("\n")}\n`, "# mission\n");
	const placeholders = Array.from(
		{ length: PLACEHOLDERS },
		() => "<机器人名> 占位符残留内容用于触发 no-skeleton-placeholder 规则，行要足够长以撑大输出",
	);
	await writeSkeleton(meceDir, "# AGENTS.md\n", `# mission\n\n${placeholders.join("\n")}\n`);
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

/** The file leg's destination stays outside every directory the command scans. */
function outPath(name: string): string {
	return path.join(root, name);
}

function env(): Record<string, string> {
	// HOME and the config dir are both isolated so the command reads and writes
	// nothing outside the temp tree.
	return { HOME: path.join(root, "home"), CORNFIELD_AGENT_DIR: path.join(root, "config") };
}

describe("agent output through a pipe", () => {
	it("delivers the whole agent listing", async () => {
		const { piped, file } = await runBothWays({
			args: ["agent", "list", "--json", "--dir", listRoot],
			env: env(),
			outPath: outPath("list.json"),
		});

		// A payload that already fits in the pipe proves nothing, so its size is
		// asserted before the bytes are compared.
		expect(file.length).toBeGreaterThan(PIPE_CAPACITY);
		expect(piped).toBe(file);

		const summaries = JSON.parse(piped) as Array<{ name: string }>;
		expect(summaries.length).toBe(DIRS);
		expect(piped).toContain(`agent-with-a-longish-name-${String(DIRS - 1).padStart(4, "0")}`);
	});

	it("delivers the whole agent detail document, tail included", async () => {
		const { piped, file } = await runBothWays({
			args: ["agent", "show", "fat-agent", "--json", "--dir", agentRoot],
			env: env(),
			outPath: outPath("show.json"),
		});

		expect(file.length).toBeGreaterThan(PIPE_CAPACITY);
		expect(piped).toBe(file);

		const detail = JSON.parse(piped) as { hardConstraints: string[] };
		expect(detail.hardConstraints.length).toBe(CONSTRAINTS);
		// The last constraint sits in the bytes the pipe used to drop.
		expect(piped).toContain(`thing number ${CONSTRAINTS - 1} `);
	});

	it("delivers the whole validation report, tail included", async () => {
		const { piped, file } = await runBothWays({
			args: ["agent", "validate", "--dir", meceDir, "--json"],
			env: env(),
			outPath: outPath("validate.json"),
		});

		expect(file.length).toBeGreaterThan(PIPE_CAPACITY);
		expect(piped).toBe(file);

		const report = JSON.parse(piped) as { issues: unknown[]; valid: boolean };
		expect(report.valid).toBe(true);
		expect(report.issues.length).toBeGreaterThanOrEqual(PLACEHOLDERS);
		expect(piped).toContain("no-skeleton-placeholder");
	});
});
