import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	loadWorkingProjectId,
	parseWorkingProjectId,
	rememberWorkingProjectId,
	WORKING_PROJECT_KEY,
} from "../src/lib/working-project";

/**
 * 「工作上下文选中的 Project」在本机这个浏览器里记住的那一份（localStorage）。
 *
 * 它**不是**权威（权威是 serve 的 Project registry），所以这里钉住的不是「记全了」，
 * 而是三条纪律：
 *   1. **存的是 projectId**（不是 root）：归属的身份是 id，root 由存储归一；
 *   2. **坏存储不抛、不挡路**：没写过 / 存储本身不可用，都只是「没记过」——
 *      一个记不住偏好的副作用不该让工作台打不开；
 *   3. **选回「不指定」= 忘掉那条记录**：留一条永远不再成立的记录，下次恢复时就得靠校验去兜。
 *
 * 校验（记下的那个 Project 还在不在注册表里）**不在这里做** —— 这一层看不到注册表，那一次判定在
 * `SessionStore#loadProjects`。
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

/** 每次用例自己装、自己拆（仓库纪律：不留文件级的长命全局改动）。 */
function setStorage(storage: Storage | undefined): void {
	if (storage === undefined) {
		delete (globalThis as { localStorage?: Storage }).localStorage;
		return;
	}
	(globalThis as { localStorage?: Storage }).localStorage = storage;
}

function storageThatThrows(): Storage {
	const boom = (): never => {
		throw new Error("localStorage is not available in this context");
	};
	return {
		length: 0,
		clear: boom,
		getItem: boom,
		key: boom,
		removeItem: boom,
		setItem: boom,
	};
}

describe("parseWorkingProjectId（纯函数）", () => {
	it("没写过 → 空串（「没记过」），不是某个默认 id", () => {
		expect(parseWorkingProjectId(null)).toBe("");
		expect(parseWorkingProjectId("")).toBe("");
	});

	it("前后空格被去掉：带一个空格就是一条永远匹配不上的记录", () => {
		expect(parseWorkingProjectId("  dtc  ")).toBe("dtc");
		expect(parseWorkingProjectId("dtc")).toBe("dtc");
	});

	it("整串空白 = 没记过（与空串对它是一次事）", () => {
		expect(parseWorkingProjectId("   ")).toBe("");
	});
});

describe("loadWorkingProjectId / rememberWorkingProjectId", () => {
	let storage: Storage;

	beforeEach(() => {
		storage = makeMemoryStorage();
		setStorage(storage);
	});

	afterEach(() => {
		setStorage(undefined);
	});

	it("键是钉死的：存储里那条记录换名等于所有人的偏好一起丢", () => {
		expect(WORKING_PROJECT_KEY).toBe("cornfield:working-project");
	});

	it("记一条再读回来", () => {
		rememberWorkingProjectId("dtc");
		expect(loadWorkingProjectId()).toBe("dtc");
	});

	it("记的时候写的是 trim 过的值（读的人拿到的直接就能当 id 用）", () => {
		rememberWorkingProjectId("  dtc  ");
		expect(storage.getItem(WORKING_PROJECT_KEY)).toBe("dtc");
	});

	it("空串 = 忘掉那条记录（选回「不指定」不留在盘上）", () => {
		rememberWorkingProjectId("dtc");
		rememberWorkingProjectId("");
		expect(storage.getItem(WORKING_PROJECT_KEY)).toBeNull();
		expect(loadWorkingProjectId()).toBe("");
	});

	it("没写过：空串（不抛）", () => {
		expect(loadWorkingProjectId()).toBe("");
	});

	it("存储本身抛错：读回空串、写不抛 —— 都是「没记过」，不是错误", () => {
		setStorage(storageThatThrows());
		expect(loadWorkingProjectId()).toBe("");
		expect(() => rememberWorkingProjectId("dtc")).not.toThrow();
	});

	it("没有 localStorage（非浏览器环境 / 测试里没装）：也不抛", () => {
		setStorage(undefined);
		expect(loadWorkingProjectId()).toBe("");
		expect(() => rememberWorkingProjectId("dtc")).not.toThrow();
	});
});
