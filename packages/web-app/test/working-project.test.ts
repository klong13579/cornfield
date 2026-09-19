import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	loadWorkingProjects,
	parseWorkingProjects,
	saveWorkingProjects,
	WORKING_PROJECT_KEY,
} from "../src/lib/working-project";

/**
 * 「工作上下文选中的 Project」在本机这个浏览器里记住的那一份（localStorage）。
 *
 * 它**不是**权威（权威是 serve 的 Project registry），所以这里钉住的不是「记全了」，
 * 而是四条纪律：
 *   1. **按 Agent 存**（`agentId → projectId` 一张表）：不同 Agent 服务不同的项目，共用一格
 *      就会出现「改一个 Project，所有 Agent 都跟着变」；
 *   2. **存的是 projectId**（不是 root）：归属的身份是 id，root 由存储归一；
 *   3. **坏存储不抛、不挡路**：没写过 / 坏 JSON / 形状不对 / 存储本身不可用，都只是「没记过」；
 *   4. **旧形状自然作废**：一个「全局一格」的值（裸字符串）猜不出该给哪个 Agent，不读它。
 *
 * 校验（记下的那个 Project 还在不在名单里）**不在这里做** —— 这一层看不到注册表，那一次判定在
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
	return { length: 0, clear: boom, getItem: boom, key: boom, removeItem: boom, setItem: boom };
}

describe("parseWorkingProjects（纯函数）", () => {
	it("没写过 → 空表（「没记过」），不是某个默认值", () => {
		expect([...parseWorkingProjects(null)]).toEqual([]);
		expect([...parseWorkingProjects("")]).toEqual([]);
	});

	it("一张表按 Agent 读回来", () => {
		expect([...parseWorkingProjects('{"hr":"dtc","coding":"repo"}')]).toEqual([
			["hr", "dtc"],
			["coding", "repo"],
		]);
	});

	it("旧形状（裸字符串）不读：一个全局一格的值猜不出该给哪个 Agent", () => {
		expect([...parseWorkingProjects('"dtc"')]).toEqual([]);
	});

	it("坏 JSON / 不是对象的形状 → 空表（不抛）", () => {
		expect([...parseWorkingProjects("{oops")]).toEqual([]);
		expect([...parseWorkingProjects("[]")]).toEqual([]);
		expect([...parseWorkingProjects("null")]).toEqual([]);
		expect([...parseWorkingProjects("42")]).toEqual([]);
	});

	it("键与值都 trim；丢掉键为空 / 值不是字符串的项；**保留空串值**（显式不指定）", () => {
		expect([...parseWorkingProjects('{" hr ":" dtc ","":"x","y":"","z":7,"w":null}')]).toEqual([
			["hr", "dtc"],
			["y", ""],
		]);
	});
});

describe("loadWorkingProjects / saveWorkingProjects", () => {
	let storage: Storage;

	beforeEach(() => {
		storage = makeMemoryStorage();
		setStorage(storage);
	});

	afterEach(() => {
		setStorage(undefined);
	});

	it("键是钉死的：存储里那条记录换名等于所有人的绑定一起丢", () => {
		expect(WORKING_PROJECT_KEY).toBe("cornfield:working-project");
	});

	it("存一张表再读回来", () => {
		saveWorkingProjects(new Map([["hr", "dtc"]]));
		expect([...loadWorkingProjects()]).toEqual([["hr", "dtc"]]);
	});

	it("空表 = 忘掉那条记录（不是留一个空壳）", () => {
		saveWorkingProjects(new Map([["hr", "dtc"]]));
		saveWorkingProjects(new Map());
		expect(storage.getItem(WORKING_PROJECT_KEY)).toBeNull();
		expect([...loadWorkingProjects()]).toEqual([]);
	});

	it("没写过：空表（不抛）", () => {
		expect([...loadWorkingProjects()]).toEqual([]);
	});

	it("存储本身抛错：读回空表、写不抛 —— 都是「没记过」，不是错误", () => {
		setStorage(storageThatThrows());
		expect([...loadWorkingProjects()]).toEqual([]);
		expect(() => saveWorkingProjects(new Map([["hr", "dtc"]]))).not.toThrow();
	});

	it("没有 localStorage（非浏览器环境 / 测试里没装）：也不抛", () => {
		setStorage(undefined);
		expect([...loadWorkingProjects()]).toEqual([]);
		expect(() => saveWorkingProjects(new Map([["hr", "dtc"]]))).not.toThrow();
	});
});
