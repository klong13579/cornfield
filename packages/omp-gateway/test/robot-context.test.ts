/**
 * Robot context tests.
 *
 *   - SQLiteSessionStore conversation meta: conversationTitle / isGroup /
 *     userName write-through + boolean normalization + legacy schema migration.
 *   - renderRobotContext: identity, group table, DM table.
 *   - RobotContextWriter.refresh: writes robot-context.md, registers it in
 *     prompt-includes.json (repairs double-encoded JSON), idempotent re-run.
 */
import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { RobotContextWriter, renderRobotContext } from "../src/robot-context";
import { SQLiteSessionStore } from "../src/session-store";

const LEGACY_SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  account_id TEXT NOT NULL DEFAULT '__default__',
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_message_id TEXT,
  omp_session_path TEXT,
  session_webhook TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  UNIQUE(channel_id, account_id, conversation_id)
);`;

describe("SQLiteSessionStore conversation meta", () => {
	const dbPath = path.join(os.tmpdir(), `omp-robot-context-test-${Date.now()}.db`);
	let store: SQLiteSessionStore;

	afterAll(async () => {
		store.close();
		await fs.rm(dbPath, { force: true });
	});

	it("migrates a legacy schema without the new columns", () => {
		const db = new Database(dbPath);
		db.exec(LEGACY_SCHEMA);
		db.close();
		// Opening the store runs online migrations
		store = new SQLiteSessionStore(dbPath);
	});

	it("persists and round-trips conversation meta", async () => {
		await store.createSession({
			channelId: "dingtalk",
			accountId: "acc1",
			userId: "u1",
			conversationId: "cidG1",
			conversationTitle: "atomix 软件沟通群",
			isGroup: true,
			userName: "Magnum",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			status: "active",
		});

		const got = await store.getSession("dingtalk", "acc1", "cidG1");
		expect(got?.conversationTitle).toBe("atomix 软件沟通群");
		expect(got?.isGroup).toBe(true);
		expect(got?.userName).toBe("Magnum");
	});

	it("updates conversation meta via updateSession COALESCE", async () => {
		const s = await store.getSession("dingtalk", "acc1", "cidG1");
		expect(s).not.toBeNull();
		await store.updateSession(s!.id, { conversationTitle: "改名后的群", userName: "别人" });
		const got = await store.getSession("dingtalk", "acc1", "cidG1");
		expect(got?.conversationTitle).toBe("改名后的群");
		expect(got?.userName).toBe("别人");
		// isGroup untouched by partial update
		expect(got?.isGroup).toBe(true);
	});

	it("normalizes isGroup 0 to false", async () => {
		await store.createSession({
			channelId: "dingtalk",
			accountId: "acc1",
			userId: "u2",
			conversationId: "cidD1",
			conversationTitle: "安娜",
			isGroup: false,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			status: "active",
		});
		const got = await store.getSession("dingtalk", "acc1", "cidD1");
		expect(got?.isGroup).toBe(false);
	});
});

describe("renderRobotContext", () => {
	it("renders identity, groups, and DMs", () => {
		const md = renderRobotContext(
			"me",
			{ robotCode: "dingXXX", robotName: "hermeskk" },
			[
				{
					id: "1",
					channelId: "dingtalk",
					accountId: "me",
					userId: "u1",
					conversationId: "cidG1",
					conversationTitle: "高管群",
					isGroup: true,
					userName: "Magnum",
					createdAt: 0,
					updatedAt: 1780000000000,
					status: "active",
				},
				{
					id: "2",
					channelId: "dingtalk",
					accountId: "me",
					userId: "601590212",
					conversationId: "cidD1",
					conversationTitle: "彭梦龙",
					isGroup: false,
					userName: "Magnum",
					createdAt: 0,
					updatedAt: 1780000000000,
					status: "active",
				},
			],
		);
		expect(md).toContain("hermeskk (dingXXX)");
		expect(md).toContain("高管群");
		expect(md).toContain("cidG1");
		expect(md).toContain("彭梦龙");
		expect(md).toContain("601590212");
		expect(md).toContain("dws chat message list");
	});

	it("handles empty session list", () => {
		const md = renderRobotContext("me", {}, []);
		expect(md).toContain("unknown");
		expect(md).toContain("暂无已知群会话");
	});
});

describe("RobotContextWriter.refresh", () => {
	it("writes robot-context.md and registers it in prompt-includes.json (repairs double-encoded JSON), idempotently", async () => {
		const dbPath = path.join(os.tmpdir(), `omp-robot-writer-test-${Date.now()}.db`);
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agentdir-"));
		try {
			const store = new SQLiteSessionStore(dbPath);
			// Double-encoded prompt-includes.json (real-world shape found in mcode agentDir)
			await fs.writeFile(
				path.join(agentDir, "prompt-includes.json"),
				JSON.stringify(JSON.stringify({ files: ["AGENTS.md", "TODO.md"] })),
			);

			await store.createSession({
				channelId: "dingtalk",
				accountId: "me",
				userId: "u1",
				conversationId: "cidG1",
				conversationTitle: "测试群",
				isGroup: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				status: "active",
			});

			const writer = new RobotContextWriter({
				store,
				agentDirs: new Map([["me", agentDir]]),
				robotMeta: new Map([["me", { robotCode: "dingXXX", robotName: "M-Test" }]]),
			});
			await writer.refresh("me");

			const md = await fs.readFile(path.join(agentDir, "robot-context.md"), "utf8");
			expect(md).toContain("M-Test");
			expect(md).toContain("测试群");

			const includes = JSON.parse(await fs.readFile(path.join(agentDir, "prompt-includes.json"), "utf8"));
			expect(Array.isArray(includes.files)).toBe(true);
			expect(includes.files).toContain("robot-context.md");
			expect(includes.files).toContain("AGENTS.md");

			// Second run must not rewrite identical content
			const stat1 = await fs.stat(path.join(agentDir, "robot-context.md"));
			await Bun.sleep(10);
			await writer.refresh("me");
			const stat2 = await fs.stat(path.join(agentDir, "robot-context.md"));
			expect(stat2.mtimeMs).toBe(stat1.mtimeMs);

			store.close();
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
			await fs.rm(dbPath, { force: true });
		}
	});
});
