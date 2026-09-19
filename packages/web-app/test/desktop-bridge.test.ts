import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type DesktopApi, desktopApi, directoryPicker } from "../src/lib/desktop-bridge";
import type { PickDirectoryResult } from "../src/lib/path-picker";

/**
 * 桌面壳桥的取值判定 —— 「有没有壳」是画不画那些控件的唯一依据。
 *
 * 网页直开（`cornfield serve` + 浏览器）时 `window` 上没有 `api`：调用方据此**不画**
 * 依赖壳的控件。判错一边的后果是具体的：假阳性会画出一个点了没反应的按钮（用户以为坏了），
 * 假阴性会让有壳的用户看不到本来能用的功能。
 *
 * 这里的 `window` 是每次用例自己装、自己拆的：仓库纪律是不留文件级的长命全局改动。
 */

type WindowShim = { window?: unknown };

function installWindow(api: unknown | undefined): void {
	if (api === undefined) {
		(globalThis as WindowShim).window = {};
		return;
	}
	(globalThis as WindowShim).window = { api };
}

/** 把桥写成真实使用里最容易被漏掉的那种形状：方法用 `this` 读自己身上的字段。 */
function selfReadingBridge(prefix: string): { pickDirectory: (defaultPath?: string) => PickDirectoryResult } {
	return {
		prefix,
		pickDirectory(this: { prefix: string }, defaultPath?: string): PickDirectoryResult {
			return { canceled: false, path: `${this.prefix}:${defaultPath ?? "<none>"}` };
		},
	};
}

describe("desktopApi", () => {
	afterEach(() => {
		delete (globalThis as WindowShim).window;
	});

	it("没有 window（SSR / 静态渲染）时是 undefined", () => {
		delete (globalThis as WindowShim).window;
		expect(desktopApi()).toBeUndefined();
	});

	it("有 window 但没有 api（网页直开）时是 undefined", () => {
		installWindow(undefined);
		expect(desktopApi()).toBeUndefined();
	});

	it("每次调用重读 window：换了/拆了壳，下一次取值跟着变", () => {
		const api: DesktopApi = { sidecar: { setWorkspaceDir: () => undefined } };
		installWindow(api);
		expect(desktopApi()).toBe(api);

		delete (globalThis as WindowShim).window;
		expect(desktopApi()).toBeUndefined();

		installWindow(api);
		expect(desktopApi()).toBe(api);
	});
});

describe("directoryPicker", () => {
	beforeEach(() => {
		delete (globalThis as WindowShim).window;
	});
	afterEach(() => {
		delete (globalThis as WindowShim).window;
	});

	it("没有壳 → undefined（调用方据此不画浏览按钮）", () => {
		expect(directoryPicker()).toBeUndefined();
		installWindow(undefined);
		expect(directoryPicker()).toBeUndefined();
	});

	it("旧壳只有 sidecar、没有 dialog → undefined", () => {
		installWindow({ sidecar: { setWorkspaceDir: () => undefined } });
		expect(directoryPicker()).toBeUndefined();
	});

	it("dialog 在但 pickDirectory 不是函数 → undefined（不拿一个非函数当按钮的回调）", () => {
		installWindow({ dialog: { pickDirectory: "nope" } });
		expect(directoryPicker()).toBeUndefined();
	});

	it("有 pickDirectory：转发起点、结果原样、且调用方拿到的是 Promise", async () => {
		const calls: Array<string | undefined> = [];
		installWindow({
			dialog: {
				pickDirectory: (defaultPath?: string): PickDirectoryResult => {
					calls.push(defaultPath);
					return { canceled: false, path: "/Users/me/dtc" };
				},
			},
		});
		const pick = directoryPicker();
		expect(pick).toBeDefined();

		const pending = pick?.("/Users/me");
		expect(pending).toBeInstanceOf(Promise);
		expect(await pending).toEqual({ canceled: false, path: "/Users/me/dtc" });
		expect(calls).toEqual(["/Users/me"]);
	});

	it("取消的形状原样传回（canceled 不被改写成空路径）", async () => {
		installWindow({ dialog: { pickDirectory: (): PickDirectoryResult => ({ canceled: true }) } });
		expect(await directoryPicker()?.()).toEqual({ canceled: true });
	});

	it("保留接收者：用 this 读自己字段的实现照样对", async () => {
		installWindow({ dialog: selfReadingBridge("/picked") });
		expect(await directoryPicker()?.("/start")).toEqual({ canceled: false, path: "/picked:/start" });
		expect(await directoryPicker()?.()).toEqual({ canceled: false, path: "/picked:<none>" });
	});
});
