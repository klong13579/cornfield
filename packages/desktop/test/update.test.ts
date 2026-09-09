import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupStaleUpdateZips, compareVersions, listZipFilesIn, readVersionFromUpdateZip } from "../src/update.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cornfield-update-test-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

function writeFile(rel: string, content: string, base: string): void {
	const file = path.join(base, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

const MINI_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>1.1.1</string></dict></plist>`;

/** 造一个 electron-builder 风格的 mac 更新 zip（顶层裸 .app 目录）。 */
function makeMacUpdateZip(dir: string, name: string, plistBody: string = MINI_PLIST): string {
	const appRoot = path.join(dir, "staging");
	writeFile(path.join("CornField.app", "Contents", "Info.plist"), plistBody, appRoot);
	const out = path.join(dir, name);
	execFileSync("/usr/bin/zip", ["-q", "-r", out, "CornField.app"], { cwd: appRoot });
	return out;
}

describe("compareVersions", () => {
	test("相等与基本新旧", () => {
		expect(compareVersions("1.1.1", "1.1.1")).toBe(0);
		expect(compareVersions("1.1.1", "1.1.0")).toBe(1);
		expect(compareVersions("1.1.0", "1.1.1")).toBe(-1);
		expect(compareVersions("1.0.0", "1.1.0")).toBe(-1);
	});

	test("多段数字按数值不比字典序（1.1.10 > 1.1.9）", () => {
		expect(compareVersions("1.1.10", "1.1.9")).toBe(1);
		expect(compareVersions("1.2.0", "1.10.0")).toBe(-1);
	});

	test("缺段按 0 补齐", () => {
		expect(compareVersions("1.1", "1.1.0")).toBe(0);
		expect(compareVersions("1.1", "1.1.1")).toBe(-1);
		expect(compareVersions("2", "1.9.9")).toBe(1);
	});
});

describe("readVersionFromUpdateZip", () => {
	test("真实 mac 更新 zip 读出 CFBundleShortVersionString", async () => {
		const dir = makeTempDir("read");
		const zip = makeMacUpdateZip(dir, "CornField-1.1.1-arm64.zip");
		expect(await readVersionFromUpdateZip(zip)).toBe("1.1.1");
	});

	test("zip 内没有顶层 .app/Contents/Info.plist → null", async () => {
		const dir = makeTempDir("noapp");
		const zip = path.join(dir, "plain.zip");
		writeFile("README.txt", "not an app", dir);
		execFileSync("/usr/bin/zip", ["-q", "-r", zip, "README.txt"], { cwd: dir });
		expect(await readVersionFromUpdateZip(zip)).toBeNull();
	});

	test("损坏文件 → null 不抛", async () => {
		const dir = makeTempDir("corrupt");
		const bad = path.join(dir, "broken.zip");
		fs.writeFileSync(bad, "this is definitely not a zip archive");
		expect(await readVersionFromUpdateZip(bad)).toBeNull();
	});

	test("Info.plist 缺版本 key → null", async () => {
		const dir = makeTempDir("nover");
		const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleName</key><string>CornField</string></dict></plist>`;
		const zip = makeMacUpdateZip(dir, "no-version.zip", plist);
		expect(await readVersionFromUpdateZip(zip)).toBeNull();
	});
});

describe("listZipFilesIn", () => {
	test("收集 pending/ 与根目录的 *.zip，忽略非 zip", () => {
		const dir = makeTempDir("list");
		writeFile("pending/CornField-1.1.0-arm64.zip", "x", dir);
		writeFile("pending/update-info.json", "{}", dir);
		writeFile("update.zip", "x", dir);
		writeFile("notes.txt", "x", dir);

		const files = listZipFilesIn(dir)
			.map(f => path.relative(dir, f))
			.sort();
		expect(files).toEqual(["pending/CornField-1.1.0-arm64.zip", "update.zip"]);
	});

	test("目录不存在 → 空数组", () => {
		expect(listZipFilesIn("/nonexistent/cache-dir")).toEqual([]);
	});
});

describe("cleanupStaleUpdateZips", () => {
	test("删除 keepPaths 之外的残留 zip，保留 keep", async () => {
		const cacheA = makeTempDir("cacheA");
		const cacheB = makeTempDir("cacheB");
		writeFile("pending/CornField-1.1.0-arm64.zip", "old pending", cacheA);
		writeFile("update.zip", "old root", cacheA);
		writeFile("pending/CornField-1.1.1-arm64.zip", "keep me", cacheB);
		writeFile("stray.zip", "stray legacy", cacheB);
		const keep = path.join(cacheB, "pending", "CornField-1.1.1-arm64.zip");

		const removed = await cleanupStaleUpdateZips([cacheA, cacheB], [keep]);

		expect(removed).toBe(3);
		expect(fs.existsSync(keep)).toBe(true);
		expect(fs.existsSync(path.join(cacheA, "pending", "CornField-1.1.0-arm64.zip"))).toBe(false);
		expect(fs.existsSync(path.join(cacheA, "update.zip"))).toBe(false);
		expect(fs.existsSync(path.join(cacheB, "stray.zip"))).toBe(false);
	});

	test("keep 在候选中时不受影响；无 zip 时返回 0", async () => {
		const dir = makeTempDir("empty");
		expect(await cleanupStaleUpdateZips([dir], [path.join(dir, "pending", "x.zip")])).toBe(0);
	});
});
