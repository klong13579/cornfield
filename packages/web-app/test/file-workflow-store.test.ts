import { beforeEach, describe, expect, test } from "bun:test";
import type { FsDiffResult, FsReadResult, FsWriteResult, PiClient } from "../src/lib/pi-client-api";
import { FsConflictError } from "../src/lib/pi-client-api";
import type { FileWorkflowSessionView } from "../src/state/file-workflow-store";
import { FileWorkflowStore } from "../src/state/file-workflow-store";

/**
 * 文件工作流 store 的行为测试。
 *
 * 这里驱动的是**真的 store**（打开/编辑/保存/冲突/归属判定全部走真代码），替身只有两侧的
 * 边界：一个内存「服务端」（按 fs_read/fs_write 的真实契约做 CAS）和一个会话视图源。
 * 假客户端必须实现 PiClient 里对应的完整签名（fsRead/fsWrite/fsDiff），不是手挑几个字段的
 * 残缺替身——契约一改，这里要跟着红。
 */

/** 触发所有在途 promise 链（store 的方法是「发起即返回」，测试靠它对齐时序）。 */
const settle = (): Promise<void> => Bun.sleep(0);

/** 服务端的内容身份令牌（与 wire-server 同为文件字节的 sha256）。 */
function versionOf(content: string): string {
	return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

/** 服务端 fs_read 的字节预算（与 wire-server 的 FS_MAX_READ_BYTES 同值）。 */
const READ_MAX_BYTES = 128 * 1024;

/** 内存「serve」：文件表 + 与线上同语义的 fs_read / fs_write(CAS) / fs_diff。 */
class FakeServe {
	readonly files = new Map<string, string>();
	readonly reads: string[] = [];
	readonly writes: { path: string; content: string; expectedVersion: string }[] = [];
	/** 落盘前改写内容（模拟 lsp.formatOnWrite）：返回 undefined 表示不改。 */
	normalize: ((content: string) => string | undefined) | null = null;
	/** 下一次 fs_read 抛错（探测失败用）。 */
	failNextRead = false;

	seed(path: string, content: string): void {
		this.files.set(path, content);
	}

	#read(path: string): FsReadResult {
		const content = this.files.get(path);
		if (content === undefined) throw new Error(`no such file: ${path}`);
		// 截断按**字节**判、且 UTF-8 安全（与 serve 的真实语义一致：按字符判会让多字节文本漏报）。
		// 替身若与线上语义不一致，这里测出来的就是幻觉——这条边界正是要测的东西。
		const bytes = new TextEncoder().encode(content);
		const truncated = bytes.byteLength > READ_MAX_BYTES;
		return {
			text: truncated
				? new TextDecoder("utf-8").decode(bytes.subarray(0, READ_MAX_BYTES), { stream: true })
				: content,
			truncated,
			version: versionOf(content),
		};
	}

	async fsRead(_sessionId: string, path: string): Promise<FsReadResult> {
		this.reads.push(path);
		if (this.failNextRead) {
			this.failNextRead = false;
			throw new Error("read failed");
		}
		return this.#read(path);
	}

	async fsWrite(_sessionId: string, path: string, content: string, expectedVersion: string): Promise<FsWriteResult> {
		this.writes.push({ path, content, expectedVersion });
		const current = this.files.has(path) ? versionOf(this.files.get(path) ?? "") : "";
		if (current !== expectedVersion) {
			// 与适配层同一个判决对象：服务端拒写 → 调用方拿到 FsConflictError
			throw new FsConflictError(`fs_conflict: expected ${expectedVersion}, actual ${current}`);
		}
		const normalized = this.normalize?.(content);
		const finalContent = normalized ?? content;
		this.files.set(path, finalContent);
		return {
			path,
			bytesWritten: Buffer.byteLength(finalContent, "utf8"),
			version: versionOf(finalContent),
			normalized: finalContent !== content,
		};
	}

	async fsDiff(before: string, after: string): Promise<FsDiffResult> {
		return { diff: `@@ -1,${before.length} +1,${after.length} @@\n-1|${before}\n+1|${after}` };
	}
}

/** 会话视图源（结构上等价于 SessionStore 对外的 getSnapshot/subscribe）。 */
class FakeSessions {
	view: FileWorkflowSessionView = {
		activeAgentId: "default",
		sessionId: "default",
		sessionFile: "/sessions/a.jsonl",
		isStreaming: false,
		agents: [],
	};
	#listeners = new Set<() => void>();

	getSnapshot(): FileWorkflowSessionView {
		return this.view;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** 改视图并像真 store 一样广播。 */
	update(patch: Partial<FileWorkflowSessionView>): void {
		this.view = { ...this.view, ...patch };
		for (const listener of this.#listeners) listener();
	}
}

let serve: FakeServe;
let sessions: FakeSessions;
let store: FileWorkflowStore;

const client = (): Pick<PiClient, "fsRead" | "fsWrite" | "fsDiff"> => serve;

beforeEach(() => {
	serve = new FakeServe();
	sessions = new FakeSessions();
	store = new FileWorkflowStore();
	store.init({ client: client(), sessions });
});

function open(path = "src/a.ts", agentId = "default"): void {
	store.requestOpen(agentId, path);
}

describe("打开与编辑", () => {
	test("打开文件：base/草稿/身份都来自磁盘，非脏", async () => {
		serve.seed("src/a.ts", "one\ntwo\n");
		open();
		await settle();
		const openFile = store.getSnapshot().open;
		expect(openFile?.path).toBe("src/a.ts");
		expect(openFile?.agentId).toBe("default");
		expect(openFile?.baseText).toBe("one\ntwo\n");
		expect(openFile?.draft).toBe("one\ntwo\n");
		expect(openFile?.baseVersion).toBe(versionOf("one\ntwo\n"));
		expect(openFile?.dirty).toBe(false);
		expect(openFile?.readOnly).toBe(false);
		expect(openFile?.loading).toBe(false);
	});

	test("读不到文件：错误摆在编辑器上，不是空文件", async () => {
		open("missing.ts");
		await settle();
		const openFile = store.getSnapshot().open;
		expect(openFile?.error).toContain("no such file");
		expect(openFile?.loading).toBe(false);
	});

	test("编辑 → 脏；撤销 → 回到 base", async () => {
		serve.seed("src/a.ts", "one\n");
		open();
		await settle();
		store.edit("one\ntwo\n");
		expect(store.getSnapshot().open?.dirty).toBe(true);
		store.revertDraft();
		expect(store.getSnapshot().open?.dirty).toBe(false);
		expect(store.getSnapshot().open?.draft).toBe("one\n");
	});

	test("截断文件（>128KB）：只读降级，base 不是全文", async () => {
		serve.seed("big.log", `${"x".repeat(200 * 1024)}`);
		open("big.log");
		await settle();
		const openFile = store.getSnapshot().open;
		expect(openFile?.readOnly).toBe(true);
		expect(openFile?.baseText.length).toBe(READ_MAX_BYTES);
		// 只读时保存是空操作：拿半份内容写回去就是把文件截断
		store.edit("trimmed");
		store.save();
		await settle();
		expect(serve.writes).toHaveLength(0);
	});

	test("多字节文本按字节降级：字符数不到 128K 但磁盘超限 → 仍只读", async () => {
		// 45000 个汉字 = 135000 字节（> 128KiB），而 text.length 只有 45000
		serve.seed("cjk.txt", "中".repeat(45_000));
		open("cjk.txt");
		await settle();
		const openFile = store.getSnapshot().open;
		expect(openFile?.readOnly).toBe(true);
		// 只读降级一旦漏报，用户就能拿半份内容写回、把文件真截断
		store.edit("改过的内容");
		store.save();
		await settle();
		expect(serve.writes).toHaveLength(0);
	});
});

describe("保存（CAS）", () => {
	test("保存带上打开时读到的 version，成功后 base 推进到服务端回传的新版本", async () => {
		serve.seed("src/a.ts", "one\n");
		open();
		await settle();
		store.edit("one\ntwo\n");
		store.save();
		await settle();
		expect(serve.writes).toEqual([{ path: "src/a.ts", content: "one\ntwo\n", expectedVersion: versionOf("one\n") }]);
		const openFile = store.getSnapshot().open;
		expect(openFile?.baseText).toBe("one\ntwo\n");
		expect(openFile?.baseVersion).toBe(versionOf("one\ntwo\n"));
		expect(openFile?.dirty).toBe(false);
		expect(serve.files.get("src/a.ts")).toBe("one\ntwo\n");
	});

	test("外部改写抢先：保存被拒（冲突），草稿保留、磁盘不动、给出磁盘版本", async () => {
		serve.seed("src/a.ts", "mine-v1\n");
		open();
		await settle();
		store.edit("mine-v2\n");
		// Agent/别人在这个窗口里改了盘：base 就此过期
		serve.seed("src/a.ts", "external\n");
		store.save();
		await settle();
		const openFile = store.getSnapshot().open;
		expect(openFile?.conflict?.diskText).toBe("external\n");
		expect(openFile?.conflict?.diskVersion).toBe(versionOf("external\n"));
		expect(openFile?.conflict?.detail.startsWith("fs_conflict:")).toBe(true);
		expect(openFile?.draft).toBe("mine-v2\n");
		expect(openFile?.dirty).toBe(true);
		expect(serve.files.get("src/a.ts")).toBe("external\n");
	});

	test("冲突后「保留磁盘版本」：base 与草稿都换成盘上的那一份", async () => {
		serve.seed("src/a.ts", "mine-v1\n");
		open();
		await settle();
		store.edit("mine-v2\n");
		serve.seed("src/a.ts", "external\n");
		store.save();
		await settle();
		store.acceptDisk();
		const openFile = store.getSnapshot().open;
		expect(openFile?.conflict).toBeNull();
		expect(openFile?.draft).toBe("external\n");
		expect(openFile?.baseVersion).toBe(versionOf("external\n"));
		expect(openFile?.dirty).toBe(false);
	});

	test("冲突后「用我的覆盖」：以磁盘版本为基线重写，我的内容落盘", async () => {
		serve.seed("src/a.ts", "mine-v1\n");
		open();
		await settle();
		store.edit("mine-v2\n");
		serve.seed("src/a.ts", "external\n");
		store.save();
		await settle();
		store.overwriteWithDraft();
		await settle();
		expect(serve.writes.at(-1)).toEqual({
			path: "src/a.ts",
			content: "mine-v2\n",
			expectedVersion: versionOf("external\n"),
		});
		const openFile = store.getSnapshot().open;
		expect(openFile?.conflict).toBeNull();
		expect(openFile?.dirty).toBe(false);
		expect(openFile?.baseVersion).toBe(versionOf("mine-v2\n"));
	});

	test("写盘期间用户又改了：base 推进，但草稿仍是未保存", async () => {
		serve.seed("src/a.ts", "one\n");
		open();
		await settle();
		store.edit("two\n");
		store.save();
		// 还没 settle：模拟写完之前用户又敲了一版
		store.edit("three\n");
		await settle();
		const openFile = store.getSnapshot().open;
		expect(openFile?.baseText).toBe("two\n");
		expect(openFile?.draft).toBe("three\n");
		expect(openFile?.dirty).toBe(true);
	});

	test("服务端改写了落盘内容（格式化）：编辑器同步到盘上的那一份", async () => {
		serve.seed("src/a.ts", "one\n");
		open();
		await settle();
		serve.normalize = () => "one;\n";
		store.edit("one\n// touched\n");
		store.save();
		await settle();
		const openFile = store.getSnapshot().open;
		expect(openFile?.baseText).toBe("one;\n");
		expect(openFile?.draft).toBe("one;\n");
		expect(openFile?.dirty).toBe(false);
		expect(serve.files.get("src/a.ts")).toBe("one;\n");
	});

	test("有草稿时「重新加载」不丢草稿（数据层拒绝，不只靠按钮禁用）", async () => {
		serve.seed("src/a.ts", "one\n");
		open();
		await settle();
		store.edit("my work\n");
		serve.seed("src/a.ts", "from disk\n");
		store.reload();
		await settle();
		const openFile = store.getSnapshot().open;
		expect(openFile?.draft).toBe("my work\n");
		expect(openFile?.baseVersion).toBe(versionOf("one\n"));
	});

	test("没有改动时「重新加载」采纳磁盘新版", async () => {
		serve.seed("src/a.ts", "one\n");
		open();
		await settle();
		serve.seed("src/a.ts", "from disk\n");
		store.reload();
		await settle();
		expect(store.getSnapshot().open?.draft).toBe("from disk\n");
	});

	test("没有改动时保存不发写请求", async () => {
		serve.seed("src/a.ts", "one\n");
		open();
		await settle();
		store.save();
		await settle();
		expect(serve.writes).toHaveLength(0);
	});
});

describe("外部改写探测（回合结束）", () => {
	test("Agent 回合结束时探测：非脏直接采纳磁盘新版", async () => {
		serve.seed("src/a.ts", "one\n");
		open();
		await settle();
		serve.seed("src/a.ts", "one\ntwo\n");
		await store.checkExternal();
		const openFile = store.getSnapshot().open;
		expect(openFile?.baseText).toBe("one\ntwo\n");
		expect(openFile?.draft).toBe("one\ntwo\n");
		expect(openFile?.externalUpdate).toBe(true);
		expect(openFile?.dirty).toBe(false);
	});

	test("脏草稿时不静默换掉：进入冲突态，草稿原样留着", async () => {
		serve.seed("src/a.ts", "one\n");
		open();
		await settle();
		store.edit("my work\n");
		serve.seed("src/a.ts", "agent version\n");
		await store.checkExternal();
		const openFile = store.getSnapshot().open;
		expect(openFile?.draft).toBe("my work\n");
		expect(openFile?.conflict?.diskText).toBe("agent version\n");
		expect(openFile?.externalUpdate).toBe(false);
	});

	test("磁盘没变时不打扰（不置 externalUpdate）", async () => {
		serve.seed("src/a.ts", "one\n");
		open();
		await settle();
		await store.checkExternal();
		expect(store.getSnapshot().open?.externalUpdate).toBe(false);
	});

	test("会话流式 true→false 触发探测（Agent 可能刚写过我的文件）", async () => {
		serve.seed("src/a.ts", "one\n");
		open();
		await settle();
		const readsBefore = serve.reads.length;
		serve.seed("src/a.ts", "written by agent\n");
		sessions.update({ isStreaming: true });
		sessions.update({ isStreaming: false });
		await settle();
		expect(serve.reads.length).toBeGreaterThan(readsBefore);
		expect(store.getSnapshot().open?.draft).toBe("written by agent\n");
	});

	test("探测失败不把编辑器变成错误态", async () => {
		serve.seed("src/a.ts", "one\n");
		open();
		await settle();
		serve.failNextRead = true;
		await store.checkExternal();
		expect(store.getSnapshot().open?.error).toBeNull();
		expect(store.getSnapshot().open?.draft).toBe("one\n");
	});
});

describe("未保存时换文件", () => {
	test("脏草稿换文件先挂起，草稿与当前文件都不动", async () => {
		serve.seed("src/a.ts", "a\n");
		serve.seed("src/b.ts", "b\n");
		open("src/a.ts");
		await settle();
		store.edit("a-edited\n");
		store.requestOpen("default", "src/b.ts");
		await settle();
		expect(store.getSnapshot().pendingOpen).toEqual({ agentId: "default", path: "src/b.ts" });
		expect(store.getSnapshot().open?.path).toBe("src/a.ts");
		expect(store.getSnapshot().open?.draft).toBe("a-edited\n");
	});

	test("取消：挂起清掉，仍在原文件上", async () => {
		serve.seed("src/a.ts", "a\n");
		serve.seed("src/b.ts", "b\n");
		open("src/a.ts");
		await settle();
		store.edit("a-edited\n");
		store.requestOpen("default", "src/b.ts");
		store.cancelPendingOpen();
		await settle();
		expect(store.getSnapshot().pendingOpen).toBeNull();
		expect(store.getSnapshot().open?.path).toBe("src/a.ts");
	});

	test("确认放弃：打开新文件（草稿随之消失）", async () => {
		serve.seed("src/a.ts", "a\n");
		serve.seed("src/b.ts", "b\n");
		open("src/a.ts");
		await settle();
		store.edit("a-edited\n");
		store.requestOpen("default", "src/b.ts");
		store.confirmPendingOpen();
		await settle();
		const openFile = store.getSnapshot().open;
		expect(openFile?.path).toBe("src/b.ts");
		expect(openFile?.draft).toBe("b\n");
		expect(store.getSnapshot().pendingOpen).toBeNull();
	});

	test("迟到响应落不了地：A 的读回来时已经打开 B", async () => {
		serve.seed("src/a.ts", "a\n");
		serve.seed("src/b.ts", "b\n");
		store.requestOpen("default", "src/a.ts");
		store.requestOpen("default", "src/b.ts"); // A 的响应还在路上
		await settle();
		expect(store.getSnapshot().open?.path).toBe("src/b.ts");
		expect(store.getSnapshot().open?.draft).toBe("b\n");
	});
});

describe("会话归属", () => {
	test("换会话（非脏）：打开的文件夹闭", async () => {
		serve.seed("src/a.ts", "a\n");
		open();
		await settle();
		sessions.update({ sessionFile: "/sessions/b.jsonl" });
		expect(store.getSnapshot().open).toBeNull();
		expect(store.getSnapshot().identity).toBe("default|/sessions/b.jsonl");
	});

	test("换 Agent：打开的文件夹闭（路径相对另一个 agentDir 解析）", async () => {
		serve.seed("src/a.ts", "a\n");
		open();
		await settle();
		sessions.update({ activeAgentId: "hr", sessionId: "hr" });
		expect(store.getSnapshot().open).toBeNull();
	});

	test("换会话（脏）：草稿不静默丢，标成孤立并拒绝保存", async () => {
		serve.seed("src/a.ts", "a\n");
		open();
		await settle();
		store.edit("my work\n");
		sessions.update({ sessionFile: "/sessions/b.jsonl" });
		const openFile = store.getSnapshot().open;
		expect(openFile?.orphaned).toBe(true);
		expect(openFile?.draft).toBe("my work\n");
		expect(openFile?.dirty).toBe(true);
		store.save();
		await settle();
		expect(serve.writes).toHaveLength(0);
		store.discardOrphan();
		expect(store.getSnapshot().open).toBeNull();
	});

	test("换会话清空选区引用（引用不能活着离开它所属的会话）", async () => {
		serve.seed("src/a.ts", "a\n");
		open();
		await settle();
		store.addSelectionFromOffsets("src/a.ts", "a\n", 0, 1);
		expect(store.getSnapshot().contextItems).toHaveLength(1);
		sessions.update({ sessionFile: "/sessions/b.jsonl" });
		expect(store.getSnapshot().contextItems).toEqual([]);
	});
});

describe("选区与文件上下文项", () => {
	test("空/纯空白选区不产生引用", () => {
		expect(store.addSelectionFromOffsets("src/a.ts", "abc\n", 1, 1)).toBe(false);
		expect(store.addSelectionFromOffsets("src/a.ts", "a   \nb\n", 1, 4)).toBe(false);
		expect(store.getSnapshot().contextItems).toEqual([]);
	});

	test("选区引用带路径、原文与 1-based 行范围；重复添加去重", () => {
		const doc = "line1\nline2\nline3\n";
		expect(store.addSelectionFromOffsets("src/a.ts", doc, 6, 11)).toBe(true); // line2
		const items = store.getSnapshot().contextItems;
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			kind: "selection",
			path: "src/a.ts",
			text: "line2",
			lineStart: 2,
			lineEnd: 2,
		});
		store.addSelectionFromOffsets("src/a.ts", doc, 6, 11);
		expect(store.getSnapshot().contextItems).toHaveLength(1);
	});

	test("文件条目按路径去重；移除与清空", () => {
		store.addFileContext("src/a.ts");
		store.addFileContext("src/a.ts");
		store.addFileContext("src/b.ts");
		expect(store.getSnapshot().contextItems.map(i => i.path)).toEqual(["src/a.ts", "src/b.ts"]);
		const first = store.getSnapshot().contextItems[0]?.id ?? "";
		store.removeContextItem(first);
		expect(store.getSnapshot().contextItems.map(i => i.path)).toEqual(["src/b.ts"]);
		store.clearContextItems();
		expect(store.getSnapshot().contextItems).toEqual([]);
	});
});

describe("Diff 审阅", () => {
	test("草稿差异走 fs_diff(before=base, after=草稿)", async () => {
		serve.seed("src/a.ts", "one\n");
		open();
		await settle();
		store.edit("two\n");
		await store.openDraftDiff();
		const diff = store.getSnapshot().diff;
		expect(diff?.title).toContain("未保存修改");
		expect(diff?.text).toContain("-1|one");
		expect(diff?.text).toContain("+1|two");
		expect(diff?.loading).toBe(false);
		store.closeDiff();
		expect(store.getSnapshot().diff).toBeNull();
	});

	test("冲突差异走 fs_diff(before=base, after=磁盘版本)", async () => {
		serve.seed("src/a.ts", "one\n");
		open();
		await settle();
		store.edit("mine\n");
		serve.seed("src/a.ts", "theirs\n");
		store.save();
		await settle();
		await store.openConflictDiff();
		const diff = store.getSnapshot().diff;
		expect(diff?.title).toContain("磁盘上的版本");
		expect(diff?.text).toContain("theirs");
	});

	test("打开另一个文件会清掉上一份 diff", async () => {
		serve.seed("src/a.ts", "one\n");
		serve.seed("src/b.ts", "b\n");
		open("src/a.ts");
		await settle();
		store.edit("two\n");
		await store.openDraftDiff();
		// 有未保存修改 → 换文件要用户先确认（确认后才真的换，diff 也随之清掉）
		open("src/b.ts");
		store.confirmPendingOpen();
		await settle();
		expect(store.getSnapshot().diff).toBeNull();
		expect(store.getSnapshot().open?.path).toBe("src/b.ts");
	});
});

describe("订阅", () => {
	test("状态变化会通知订阅者；退订后不再通知", async () => {
		let calls = 0;
		const unsubscribe = store.subscribe(() => {
			calls += 1;
		});
		serve.seed("src/a.ts", "one\n");
		open();
		await settle();
		expect(calls).toBeGreaterThan(0);
		const seen = calls;
		unsubscribe();
		store.edit("x");
		expect(calls).toBe(seen);
	});
});
