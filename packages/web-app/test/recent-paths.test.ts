import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	loadRecentPaths,
	parseRecentPaths,
	pushRecentPath,
	RECENT_PATH_KEYS,
	RECENT_PATH_LIMIT,
	rememberRecentPath,
} from "../src/lib/recent-paths";

/**
 * 「本机用过的路径」—— 路径输入框的候选来源。
 *
 * 它**不是**权威（权威是 serve 的 Project registry 与 agentDir 的 workspace.json），
 * 所以这里钉住的不是「记全了」，而是两条纪律：
 *   1. **坏存储不抛、不挡路**：没写过 / 坏 JSON / 形状不对 / 存储本身不可用，
 *      都是「没有候选」，而不是让 Project 声明面板或设置页打不开；
 *   2. **按用途分键**：Project root 与 sidecar 工作目录不是同一类路径，
 *      混在一个列表里会让 `<home>/workspace` 出现在项目根的候选里。
 */

function makeMemoryStorage(): Storage {
	const data = new Map<string, string>();
	return {
		get length(): number {
			return data.size;
		},
		clear(): void {
			data.clear();
		},
		getItem(key: string): string | null {
			return data.has(key) ? data.get(key)! : null;
		},
		key(index: number): string | null {
			return [...data.keys()][index] ?? null;
		},
		removeItem(key: string): void {
			data.delete(key);
		},
		setItem(key: string, value: string): void {
			data.set(key, String(value));
		},
	};
}

function setStorage(storage: Storage | undefined): void {
	if (storage === undefined) {
		delete (globalThis as { localStorage?: Storage }).localStorage;
		return;
	}
	(globalThis as { localStorage?: Storage }).localStorage = storage;
}

describe("pushRecentPath（纯函数）", () => {
	it("新路径进队首", () => {
		expect(pushRecentPath(["/a", "/b"], "/c")).toEqual(["/c", "/a", "/b"]);
	});

	it("已经有过的路径被提到队首，不产生第二份", () => {
		expect(pushRecentPath(["/a", "/b", "/c"], "/b")).toEqual(["/b", "/a", "/c"]);
	});

	it("空白输入不改动列表（空串与纯空格都不是一条路径）", () => {
		expect(pushRecentPath(["/a"], "")).toEqual(["/a"]);
		expect(pushRecentPath(["/a"], "   ")).toEqual(["/a"]);
	});

	it("落盘的路径是 trim 过的", () => {
		expect(pushRecentPath([], "  /a  ")).toEqual(["/a"]);
	});

	it("超过上限时丢掉最老的那几条", () => {
		const full = Array.from({ length: RECENT_PATH_LIMIT }, (_, i) => `/p${i}`);
		const next = pushRecentPath(full, "/new");
		expect(next).toHaveLength(RECENT_PATH_LIMIT);
		expect(next[0]).toBe("/new");
		expect(next).not.toContain(`/p${RECENT_PATH_LIMIT - 1}`);
	});

	it("不改动传入的数组（返回新数组）", () => {
		const list = ["/a", "/b"];
		pushRecentPath(list, "/c");
		expect(list).toEqual(["/a", "/b"]);
	});
});

describe("parseRecentPaths（存储原文 → 列表）", () => {
	it("没写过（null）是空列表", () => {
		expect(parseRecentPaths(null)).toEqual([]);
	});

	it("坏 JSON 是空列表，不抛", () => {
		expect(parseRecentPaths("{不是 JSON")).toEqual([]);
	});

	it("不是数组的形状一律是空列表", () => {
		expect(parseRecentPaths('{"a":1}')).toEqual([]);
		expect(parseRecentPaths('"a"')).toEqual([]);
		expect(parseRecentPaths("42")).toEqual([]);
	});

	it("剔除非字符串与空白项，其余保持顺序", () => {
		expect(parseRecentPaths('["/a", 7, null, "  ", "/b"]')).toEqual(["/a", "/b"]);
	});

	it("逐项 trim（候选会直接写进输入框，带尾空格就是一条错的路径）", () => {
		expect(parseRecentPaths('["  /a  "]')).toEqual(["/a"]);
	});

	it("重复项收敛成一份", () => {
		expect(parseRecentPaths('["/a", "/a", "/b"]')).toEqual(["/a", "/b"]);
	});

	it("超过上限时只取前若干条", () => {
		const raw = JSON.stringify(Array.from({ length: RECENT_PATH_LIMIT + 5 }, (_, i) => `/p${i}`));
		expect(parseRecentPaths(raw)).toHaveLength(RECENT_PATH_LIMIT);
	});
});

describe("存储读写", () => {
	beforeEach(() => setStorage(makeMemoryStorage()));
	afterEach(() => setStorage(undefined));

	it("记住之后读得回来，且落在按用途分的键上", () => {
		rememberRecentPath(RECENT_PATH_KEYS.projectRoot, "/Users/me/dtc");
		expect(loadRecentPaths(RECENT_PATH_KEYS.projectRoot)).toEqual(["/Users/me/dtc"]);
		expect(globalThis.localStorage.getItem(RECENT_PATH_KEYS.projectRoot)).toBe('["/Users/me/dtc"]');
	});

	it("两个用途各记各的（项目根不会出现在工作目录的候选里）", () => {
		rememberRecentPath(RECENT_PATH_KEYS.projectRoot, "/Users/me/proj");
		expect(loadRecentPaths(RECENT_PATH_KEYS.workspaceDir)).toEqual([]);
		rememberRecentPath(RECENT_PATH_KEYS.workspaceDir, "/Users/me/workspace");
		expect(loadRecentPaths(RECENT_PATH_KEYS.projectRoot)).toEqual(["/Users/me/proj"]);
		expect(loadRecentPaths(RECENT_PATH_KEYS.workspaceDir)).toEqual(["/Users/me/workspace"]);
	});

	it("remember 返回记完之后那一份（调用方不必再读一次）", () => {
		rememberRecentPath(RECENT_PATH_KEYS.projectRoot, "/a");
		expect(rememberRecentPath(RECENT_PATH_KEYS.projectRoot, "/b")).toEqual(["/b", "/a"]);
	});

	it("存储里的值坏了：读成空列表，下一次 remember 从零重建", () => {
		globalThis.localStorage.setItem(RECENT_PATH_KEYS.projectRoot, "{坏了");
		expect(loadRecentPaths(RECENT_PATH_KEYS.projectRoot)).toEqual([]);
		expect(rememberRecentPath(RECENT_PATH_KEYS.projectRoot, "/a")).toEqual(["/a"]);
		expect(loadRecentPaths(RECENT_PATH_KEYS.projectRoot)).toEqual(["/a"]);
	});

	it("没有 localStorage（SSR / 静态渲染）：读是空列表，写不抛且仍返回应当记下的那份", () => {
		setStorage(undefined);
		expect(loadRecentPaths(RECENT_PATH_KEYS.projectRoot)).toEqual([]);
		expect(rememberRecentPath(RECENT_PATH_KEYS.projectRoot, "/a")).toEqual(["/a"]);
	});

	it("存储不可用（隐私模式）：读是空列表，写不抛", () => {
		const boom = (): never => {
			throw new Error("SecurityError: storage disabled");
		};
		setStorage({ getItem: boom, setItem: boom } as unknown as Storage);
		expect(loadRecentPaths(RECENT_PATH_KEYS.projectRoot)).toEqual([]);
		expect(rememberRecentPath(RECENT_PATH_KEYS.projectRoot, "/a")).toEqual(["/a"]);
	});
});
