/**
 * session-index 的 sessionId 去重（直接调 indexSessions，真临时目录 + 真 JSONL 文件）。
 *
 * 背景：default agent 的 sessions 目录里，同一个会话会落两份文件 ——
 * `<HHMMSS>__<8hex>.jsonl` 与 `<HHMMSS>__<8hex>.client-side.jsonl`，两份的 header.id 相同
 * （实测有逐字节相同的）。listJsonlFiles 递归扫所有 .jsonl，不去重就会把同一个会话索引成两条：
 * records 页/用量页重复、侧栏会话列表因为 React key 撞车会留下没被移除的陈旧行。
 *
 * 覆盖四条：双胞胎只留一条且留非 client-side 的、不同 id 都留、entryCount 大的优先、
 * limit 在去重之后生效（去重晚于截断时双胞胎会白吃 one 个名额）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { indexSessions, type SessionIndexSource } from "../src/server/session-index";

/** 本文件用过的临时根，afterEach 统一清理。 */
const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(tempRoots.map(root => fs.rm(root, { recursive: true, force: true })));
	tempRoots.length = 0;
});

/** 造一个真临时 sessions 根（用例结束自动删）。 */
async function makeRoot(prefix = "omp-session-index-"): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

function sourceFor(root: string): SessionIndexSource {
	return { agentId: "default", agentName: "default", sessionsRoot: root, source: "cli" };
}

/** 一条 entry 行（与 session-manager 落盘结构同构）。 */
function entryLine(type: string, extra: Record<string, unknown>): string {
	return JSON.stringify({
		type,
		id: Math.random().toString(36).slice(2, 10),
		parentId: null,
		timestamp: new Date().toISOString(),
		...extra,
	});
}

/** 一份会话 JSONL 的完整内容：header + `messages` 条 assistant 消息（entryCount = messages + 1）。 */
function sessionContent(id: string, startIso: string, messages: number, cwd: string): string {
	const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: startIso, cwd })];
	for (let i = 0; i < messages; i += 1) {
		lines.push(
			entryLine("message", {
				message: {
					role: "assistant",
					content: [{ type: "text", text: `ok${i}` }],
					stopReason: "stop",
					timestamp: Date.now(),
				},
			}),
		);
	}
	return `${lines.join("\n")}\n`;
}

async function writeSession(root: string, fileName: string, content: string): Promise<string> {
	const file = path.join(root, fileName);
	await Bun.write(file, content);
	return file;
}

const PAIR_ID = "11111111-0000-7000-0000-000000000001";

describe("sessionId 去重", () => {
	test("(a) 同一 id 的 .jsonl + .client-side.jsonl 双胞胎 → 只留非 client-side 的那份", async () => {
		const root = await makeRoot();
		// 实测形态：两份文件逐字节相同（同一个 header.id、同样的行数）
		const content = sessionContent(PAIR_ID, "2026-09-17T11:13:25.000Z", 3, root);
		const plain = await writeSession(root, "191325__122e9e7c.jsonl", content);
		const clientSide = await writeSession(root, "191325__122e9e7c.client-side.jsonl", content);
		expect(await Bun.file(clientSide).text()).toBe(await Bun.file(plain).text());

		const entries = await indexSessions([sourceFor(root)]);

		expect(entries.length).toBe(1);
		expect(entries[0]!.sessionId).toBe(PAIR_ID);
		// 留下的是 agent 自己写的日志，不是旁路产物。
		// 注意不能靠字典序凑巧：".client-side.jsonl" 的 "c" 比 ".jsonl" 的 "j" 小，
		// 纯按 sessionFile 排序反而会挑中 client-side 那份。
		expect(entries[0]!.sessionFile).toBe(plain);
	});

	test("(a2) 只有 client-side 一份时它照常被索引（证明上一条是去重的功劳，不是文件被跳过）", async () => {
		const root = await makeRoot();
		const clientSide = await writeSession(
			root,
			"191325__122e9e7c.client-side.jsonl",
			sessionContent(PAIR_ID, "2026-09-17T11:13:25.000Z", 3, root),
		);

		const entries = await indexSessions([sourceFor(root)]);

		expect(entries.length).toBe(1);
		expect(entries[0]!.sessionFile).toBe(clientSide);
	});

	test("(b) 两个不同 sessionId 的会话 → 两条都保留", async () => {
		const root = await makeRoot();
		const first = "22222222-0000-7000-0000-000000000002";
		const second = "33333333-0000-7000-0000-000000000003";
		await writeSession(root, "100000__aaaa1111.jsonl", sessionContent(first, "2026-09-17T10:00:00.000Z", 2, root));
		await writeSession(root, "110000__bbbb2222.jsonl", sessionContent(second, "2026-09-17T11:00:00.000Z", 2, root));

		const entries = await indexSessions([sourceFor(root)]);

		expect(entries.length).toBe(2);
		// startTime 倒序
		expect(entries.map(e => e.sessionId)).toEqual([second, first]);
	});

	test("(c) entryCount 不同 → 留 entryCount 大的那条", async () => {
		const root = await makeRoot();
		// 文件名与身份无关：同一个 header.id 可以从两个文件里读出来
		const small = await writeSession(
			root,
			"100000__aaaa1111.jsonl",
			sessionContent(PAIR_ID, "2026-09-17T10:00:00.000Z", 1, root), // entryCount = 2
		);
		const big = await writeSession(
			root,
			"100000__aaaa1111-copy.jsonl",
			sessionContent(PAIR_ID, "2026-09-17T10:00:00.000Z", 5, root), // entryCount = 6
		);

		const entries = await indexSessions([sourceFor(root)]);

		expect(entries.length).toBe(1);
		expect(entries[0]!.sessionFile).toBe(big);
		expect(entries[0]!.entryCount).toBe(6);
		expect(entries[0]!.fileSizeBytes).toBeGreaterThan(await Bun.file(small).size);
	});

	test("(c2) entryCount 优先于「非 client-side 优先」：client-side 更全时留它", async () => {
		const root = await makeRoot();
		const plain = await writeSession(
			root,
			"191325__122e9e7c.jsonl",
			sessionContent(PAIR_ID, "2026-09-17T11:13:25.000Z", 1, root), // entryCount = 2
		);
		const fuller = await writeSession(
			root,
			"191325__122e9e7c.client-side.jsonl",
			sessionContent(PAIR_ID, "2026-09-17T11:13:25.000Z", 4, root), // entryCount = 5
		);

		const entries = await indexSessions([sourceFor(root)]);

		expect(entries.length).toBe(1);
		expect(entries[0]!.sessionFile).toBe(fuller);
		expect(entries[0]!.sessionFile).not.toBe(plain);
		expect(entries[0]!.entryCount).toBe(5);
	});
});

describe("limit 在去重之后生效", () => {
	test("(d) limit=2 + 1 对双胞胎 + 2 个别的会话 → 恰好 2 条（去重腾出的名额不浪费）", async () => {
		// 两个源：indexSessions 会先按 mtime 取**每源** cappedLimit 个文件，单源塞 4 个文件时
		// limit=2 只会解析 2 个，喂不进合并阶段；拆成两个源才是「输入含 4 条候选」。
		const pairRoot = await makeRoot();
		const otherRoot = await makeRoot();
		const twin = sessionContent(PAIR_ID, "2026-09-17T12:00:00.000Z", 3, pairRoot);
		await writeSession(pairRoot, "120000__cccc3333.jsonl", twin);
		await writeSession(pairRoot, "120000__cccc3333.client-side.jsonl", twin);
		const otherOld = "44444444-0000-7000-0000-000000000004";
		const otherNew = "55555555-0000-7000-0000-000000000005";
		await writeSession(
			otherRoot,
			"110000__dddd4444.jsonl",
			sessionContent(otherOld, "2026-09-17T10:00:00.000Z", 3, otherRoot),
		);
		await writeSession(
			otherRoot,
			"110000__eeee5555.jsonl",
			sessionContent(otherNew, "2026-09-17T11:00:00.000Z", 3, otherRoot),
		);

		const entries = await indexSessions([sourceFor(pairRoot), sourceFor(otherRoot)], 2);

		// 若去重发生在 slice 之后：4 条候选按 startTime 倒序 → 前 2 条正是双胞胎 → 去重后只剩 1 条。
		expect(entries.map(e => e.sessionId)).toEqual([PAIR_ID, otherNew]);
	});
});
