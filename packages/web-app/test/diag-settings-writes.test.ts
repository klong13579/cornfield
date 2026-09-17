import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveNextToken } from "../src/pages/settings/connection-config";
import { DEFAULT_SERVE_CONFIG, loadServeConfig, saveServeConfig } from "../src/state/pi-client-adapter";

/**
 * diag-settings-writes —— T5「设置页 真实态与写保护」回归。
 *
 * 最重判据：Token 覆盖（数据丢失）。修复前「保存并重连」把空 token 写进连接配置，
 * 重进页面后已存 token 被清空、断连失去鉴权。
 *
 * - 落盘路径：localStorage 键 `cornfield.serve.connection`（{wsUrl, token} JSON）。
 * - 回滚证据：每个写用例跑在局部内存 Storage 上，afterEach 恢复全局，不污染真实配置。
 */

const CONN_KEY = "cornfield.serve.connection";

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

function seedToken(length: number): string {
	return `t${"x".repeat(length - 1)}`;
}

describe("resolveNextToken（Token 保留规则）", () => {
	it("非空输入 trim 后返回新 token", () => {
		expect(resolveNextToken("  abc  ", "old")).toBe("abc");
	});

	it("空输入保留已存 token", () => {
		expect(resolveNextToken("", "old-token")).toBe("old-token");
	});

	it("纯空白输入保留已存 token", () => {
		expect(resolveNextToken("   ", "old-token")).toBe("old-token");
	});

	it("空输入且无已存 token 返回空串", () => {
		expect(resolveNextToken("", "")).toBe("");
	});
});

describe("连接配置落盘（localStorage 键 cornfield.serve.connection）", () => {
	beforeEach(() => {
		(globalThis as { localStorage?: Storage }).localStorage = makeMemoryStorage();
	});

	afterEach(() => {
		delete (globalThis as { localStorage?: Storage }).localStorage;
	});

	it("saveServeConfig 写入后 loadServeConfig 读回同一配置", () => {
		saveServeConfig({ wsUrl: "ws://127.0.0.1:1234/ws", token: "tok" });
		expect(loadServeConfig()).toEqual({ wsUrl: "ws://127.0.0.1:1234/ws", token: "tok" });
	});

	it("落盘路径为 localStorage 键 cornfield.serve.connection", () => {
		saveServeConfig({ wsUrl: "ws://127.0.0.1:1234/ws", token: "tok" });
		const raw = localStorage.getItem(CONN_KEY);
		expect(raw).not.toBeNull();
		expect(JSON.parse(raw as string)).toEqual({ wsUrl: "ws://127.0.0.1:1234/ws", token: "tok" });
	});

	it("未写入时 loadServeConfig 回默认配置", () => {
		expect(loadServeConfig()).toEqual(DEFAULT_SERVE_CONFIG);
	});

	it("保存并重连不丢 token：空输入合并已存 token 后落盘仍可读回", () => {
		const stored = seedToken(32);
		saveServeConfig({ wsUrl: "ws://127.0.0.1:7891/ws", token: stored });

		// 页面「保存并重连」的空 token 输入经 resolveNextToken 合并到已存值。
		const next = resolveNextToken("", loadServeConfig().token);
		saveServeConfig({ wsUrl: "ws://127.0.0.1:9999/ws", token: next });

		const reloaded = loadServeConfig();
		expect(reloaded.token.length).toBe(stored.length);
		expect(reloaded.token).toBe(stored);
	});
});
