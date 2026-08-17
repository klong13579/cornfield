/**
 * Project-pane child metadata injection (`openProjectPane` with
 * `childMetadata`).
 *
 * When a parent omp spawns a child omp into a Herdr pane, the pane command
 * must carry PI_SUBAGENT_* env prefixes so the child registers with the
 * parent edge on the intercom broker, gets contact_supervisor, and
 * auto-reports completion. This test pins the exact command string shape
 * with a fake Herdr client.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ChildPaneMetadata, type HerdrResult, openProjectPane } from "../../src/intercom-extension/project-agent";

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-pane-meta-"));
	tmpDirs.push(dir);
	return dir;
}

function fakeHerdrClient(version = "0.7.6") {
	const calls: string[][] = [];
	const run = async <T>(args: string[]): Promise<HerdrResult<T>> => {
		calls.push(args);
		if (args[0] === "--version") {
			return { ok: true, data: { versionText: version } as T };
		}
		if (args[0] === "pane" && args[1] === "split") {
			return { ok: true, data: { pane: { pane_id: "pane-1" } } as T };
		}
		if (args[0] === "pane" && args[1] === "run") {
			return { ok: true, data: {} as T };
		}
		return { ok: true, data: {} as T };
	};
	return { calls, run };
}

afterEach(async () => {
	for (const dir of tmpDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("openProjectPane with childMetadata", () => {
	test("injects PI_SUBAGENT_* env prefixes into the pane command", async () => {
		const cwd = await makeTmpDir();
		const client = fakeHerdrClient();
		const previousBin = process.env.PI_INTERCOM_PI_BIN;
		process.env.PI_INTERCOM_PI_BIN = "/usr/local/bin/pi";

		const metadata: ChildPaneMetadata = {
			parentTarget: "parent-stable-id",
			parentSessionId: "parent-stable-id",
			runId: "run-123",
			agent: "project-pane",
			index: "1",
		};

		try {
			const launch = await openProjectPane({ cwd, client, childMetadata: metadata });
			expect(launch.paneId).toBe("pane-1");

			const runCall = client.calls.find(args => args[0] === "pane" && args[1] === "run");
			expect(runCall).toBeDefined();
			const command = runCall![3]!;
			expect(command).toContain("PI_SUBAGENT_ORCHESTRATOR_TARGET='parent-stable-id'");
			expect(command).toContain("PI_SUBAGENT_ORCHESTRATOR_SESSION_ID='parent-stable-id'");
			expect(command).toContain("PI_SUBAGENT_RUN_ID='run-123'");
			expect(command).toContain("PI_SUBAGENT_CHILD_AGENT='project-pane'");
			expect(command).toContain("PI_SUBAGENT_CHILD_INDEX='1'");
			// The binary stays shell-quoted and comes after the env prefixes.
			expect(command.endsWith("'/usr/local/bin/pi'")).toBe(true);
		} finally {
			if (previousBin === undefined) {
				delete process.env.PI_INTERCOM_PI_BIN;
			} else {
				process.env.PI_INTERCOM_PI_BIN = previousBin;
			}
		}
	});

	test("defaults apply when childMetadata fields are omitted", async () => {
		const cwd = await makeTmpDir();
		const client = fakeHerdrClient();
		const previousBin = process.env.PI_INTERCOM_PI_BIN;
		process.env.PI_INTERCOM_PI_BIN = "/usr/local/bin/pi";

		const metadata: ChildPaneMetadata = { parentTarget: "main" };

		try {
			await openProjectPane({ cwd, client, childMetadata: metadata });
			const runCall = client.calls.find(args => args[0] === "pane" && args[1] === "run");
			const command = runCall![3]!;
			expect(command).toContain("PI_SUBAGENT_ORCHESTRATOR_TARGET='main'");
			expect(command).toContain("PI_SUBAGENT_ORCHESTRATOR_SESSION_ID='main'");
			expect(command).toContain("PI_SUBAGENT_RUN_ID='pane-unknown'");
			expect(command).toContain("PI_SUBAGENT_CHILD_AGENT='project-pane'");
			expect(command).toContain("PI_SUBAGENT_CHILD_INDEX='0'");
		} finally {
			if (previousBin === undefined) {
				delete process.env.PI_INTERCOM_PI_BIN;
			} else {
				process.env.PI_INTERCOM_PI_BIN = previousBin;
			}
		}
	});

	test("without childMetadata the command is just the shell-quoted binary", async () => {
		const cwd = await makeTmpDir();
		const client = fakeHerdrClient();
		const previousBin = process.env.PI_INTERCOM_PI_BIN;
		process.env.PI_INTERCOM_PI_BIN = "/usr/local/bin/pi";

		try {
			await openProjectPane({ cwd, client });
			const runCall = client.calls.find(args => args[0] === "pane" && args[1] === "run");
			expect(runCall![3]).toBe("'/usr/local/bin/pi'");
		} finally {
			if (previousBin === undefined) {
				delete process.env.PI_INTERCOM_PI_BIN;
			} else {
				process.env.PI_INTERCOM_PI_BIN = previousBin;
			}
		}
	});

	test("values with spaces/quotes are shell-escaped", async () => {
		const cwd = await makeTmpDir();
		const client = fakeHerdrClient();
		const previousBin = process.env.PI_INTERCOM_PI_BIN;
		process.env.PI_INTERCOM_PI_BIN = "/usr/local/bin/pi";

		const metadata: ChildPaneMetadata = { parentTarget: "my parent", runId: "run 'escaped'" };

		try {
			await openProjectPane({ cwd, client, childMetadata: metadata });
			const runCall = client.calls.find(args => args[0] === "pane" && args[1] === "run");
			const command = runCall![3]!;
			expect(command).toContain("PI_SUBAGENT_ORCHESTRATOR_TARGET='my parent'");
			expect(command).toContain("PI_SUBAGENT_RUN_ID='run '\\''escaped'\\'''");
		} finally {
			if (previousBin === undefined) {
				delete process.env.PI_INTERCOM_PI_BIN;
			} else {
				process.env.PI_INTERCOM_PI_BIN = previousBin;
			}
		}
	});
});
