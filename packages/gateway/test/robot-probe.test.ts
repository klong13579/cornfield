/**
 * Robot probe ingest tests — upsert semantics of ingestProbeResult:
 *   - new group → session created, robot-context refreshed
 *   - existing session with title drift → title updated
 *   - existing session already correct → no change (idempotent)
 */
import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RobotContextWriter } from "../src/robot-context";
import { ingestProbeResult, type ProbeResult } from "../src/robot-probe";
import { SQLiteSessionStore } from "../src/session-store";

function fakeResult(byRobot: Record<string, Array<{ title: string; conversationId: string }>>): ProbeResult {
	return {
		byRobot: new Map(Object.entries(byRobot)),
		scanned: 3,
		failures: 0,
		tokenAccount: "hr",
	};
}

describe("ingestProbeResult", () => {
	const dbPath = path.join(os.tmpdir(), `omp-robot-probe-test-${Date.now()}.db`);
	let store: SQLiteSessionStore;

	afterAll(async () => {
		store.close();
		await fs.rm(dbPath, { force: true });
	});

	it("creates sessions for new groups and refreshes robot-context.md", async () => {
		store = new SQLiteSessionStore(dbPath);
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agentdir-"));
		try {
			const writer = new RobotContextWriter({
				store,
				agentDirs: new Map([["me", agentDir]]),
				robotMeta: new Map([["me", { robotCode: "dingXXX", robotName: "hermeskk" }]]),
			});

			const written = await ingestProbeResult(
				store,
				writer,
				fakeResult({ dingXXX: [{ title: "机械臂性能", conversationId: "cidA" }] }),
				new Map([["dingXXX", "me"]]),
			);

			expect(written.get("me")).toBe(1);
			const got = await store.getSession("dingtalk", "me", "cidA");
			expect(got?.conversationTitle).toBe("机械臂性能");
			expect(got?.isGroup).toBe(true);
			const md = await fs.readFile(path.join(agentDir, "robot-context.md"), "utf8");
			expect(md).toContain("机械臂性能");
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("updates title drift on an existing session", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agentdir-"));
		try {
			const writer = new RobotContextWriter({
				store,
				agentDirs: new Map([["me", agentDir]]),
				robotMeta: new Map([["me", { robotCode: "dingXXX", robotName: "hermeskk" }]]),
			});
			// probe reports the same cid with a NEW title (group renamed)
			const written = await ingestProbeResult(
				store,
				writer,
				fakeResult({ dingXXX: [{ title: "机械臂性能（改名）", conversationId: "cidA" }] }),
				new Map([["dingXXX", "me"]]),
			);
			expect(written.get("me")).toBe(1);
			const got = await store.getSession("dingtalk", "me", "cidA");
			expect(got?.conversationTitle).toBe("机械臂性能（改名）");
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("is idempotent when nothing changed", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agentdir-"));
		try {
			const writer = new RobotContextWriter({
				store,
				agentDirs: new Map([["me", agentDir]]),
				robotMeta: new Map([["me", { robotCode: "dingXXX", robotName: "hermeskk" }]]),
			});
			const written = await ingestProbeResult(
				store,
				writer,
				fakeResult({ dingXXX: [{ title: "机械臂性能（改名）", conversationId: "cidA" }] }),
				new Map([["dingXXX", "me"]]),
			);
			expect(written.size).toBe(0);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("ignores robots that are not gateway accounts", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agentdir-"));
		try {
			const writer = new RobotContextWriter({
				store,
				agentDirs: new Map([["me", agentDir]]),
				robotMeta: new Map([["me", { robotCode: "dingXXX" }]]),
			});
			const written = await ingestProbeResult(
				store,
				writer,
				fakeResult({ dingUNKNOWN: [{ title: "别的机器人的群", conversationId: "cidZ" }] }),
				new Map([["dingXXX", "me"]]),
			);
			expect(written.size).toBe(0);
			const got = await store.getSession("dingtalk", "me", "cidZ");
			expect(got).toBeNull();
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});
});
