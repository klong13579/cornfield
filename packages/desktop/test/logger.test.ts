import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initFileLogging } from "../src/logger.js";

/** 单测沙箱：每个用例独立 tempdir，用例内自行 init/restore（console patch 是进程级状态）。 */
function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "cornfield-logger-test-"));
}

function readLog(dir: string): string {
	return fs.readFileSync(path.join(dir, "main.log"), "utf8");
}

describe("initFileLogging", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

	function track(dir: string, restore: () => void): void {
		cleanups.push(() => {
			restore();
			fs.rmSync(dir, { recursive: true, force: true });
		});
	}

	test("console 输出镜像到文件且保留原始 stderr 行为", () => {
		const dir = makeTempDir();
		const errSpy = spyOn(console, "error");
		const restore = initFileLogging([dir]);
		track(dir, () => {
			restore();
			errSpy.mockRestore();
		});

		console.error("desktop: updater error", new Error("boom"));

		expect(errSpy).toHaveBeenCalledTimes(1); // 原始 stderr 行为保留
		const content = readLog(dir);
		expect(content).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2} \[error\] desktop: updater error/m,
		);
		expect(content).toContain("Error: boom"); // Error 展开为 stack/message
		expect(content).not.toMatch(/\n[^\d]/); // 单行：行首永远是时间戳
	});

	test("重复 init 幂等：不重复 patch、不重复落盘", () => {
		const dir = makeTempDir();
		const restore = initFileLogging([dir]);
		const second = initFileLogging([dir]);
		track(dir, restore);

		console.warn("once");
		second(); // 第二次 init 的 restore 应为 no-op
		console.warn("twice");

		const lines = readLog(dir)
			.trim()
			.split("\n")
			.filter(line => line.includes("once") || line.includes("twice"));
		expect(lines).toHaveLength(2); // 重复 init 不产生双份
	});

	test("超过 rotateBytes 轮转到 main.old.log，新内容继续写 main.log", () => {
		const dir = makeTempDir();
		const restore = initFileLogging([dir], { rotateBytes: 1024 });
		track(dir, restore);

		console.info("x".repeat(2048));
		console.info("after-rotate");

		expect(fs.existsSync(path.join(dir, "main.old.log"))).toBe(true);
		expect(readLog(dir)).toContain("after-rotate");
	});

	test("候选目录按序取第一个可写的", () => {
		const dir = makeTempDir();
		const blocked = path.join(dir, "blocked");
		fs.writeFileSync(blocked, "not a dir"); // 在文件下建目录必然失败
		const fallback = path.join(dir, "fallback");
		const restore = initFileLogging([path.join(blocked, "logs"), fallback]);
		track(fallback, restore);

		console.info("fell-back");
		expect(readLog(fallback)).toContain("fell-back");
	});

	test("null 终止候选：不落盘、不崩溃（仅 stderr 旧行为）", () => {
		const dir = makeTempDir();
		const restore = initFileLogging([null]);
		track(dir, restore);

		expect(() => console.error("should not throw")).not.toThrow();
		expect(fs.existsSync(path.join(dir, "main.log"))).toBe(false);
	});
});
