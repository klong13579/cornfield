import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 更新包版本门禁与陈旧缓存清理 —— 纯 node 实现（无 electron 依赖，可在 bun test 下直接单测）。
 *
 * 背景：`installUpdate` 原直接取 updater 缓存里 mtime 最新的 zip，不校验版本。陈旧 pending
 * （旧版下载残留）会永远点亮「重启更新」按钮，一旦点击就用旧包覆盖当前安装 —— 实测缓存遗留的
 * 1.1.0 zip 把健康的 1.1.1 应用覆盖成缺 logger.js 的坏包、启动即崩且无日志可查。这里提供：
 * zip 内版本读取、语义化版本比较、陈旧缓存清理。
 */

const EXEC_MAX_BUFFER = 4 * 1024 * 1024;
/** electron-builder mac zip 顶层为裸 .app 目录（`CornField.app/...`）。 */
const TOP_LEVEL_APP_INFO_PLIST = /^(?:\.\/)?[^/]+\.app\/Contents\/Info\.plist$/;

function execFileOut(file: string, args: string[]): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	childProcess.execFile(file, args, { encoding: "utf8", maxBuffer: EXEC_MAX_BUFFER }, (err, stdout) => {
		if (err) reject(err);
		else resolve(stdout);
	});
	return promise;
}

/**
 * 语义化版本比较（点分数字，如 "1.1.0" / "1.1.1"）。
 * @returns a < b → -1，a == b → 0，a > b → 1。缺段按 0 补（"1.1" == "1.1.0"）。
 * 非数字段（预发布标签等）退化到字典序比较——electron-builder 产物版本恒为纯数字点分，
 * 该路径仅作兜底，不做完整 semver 预发布优先级。
 */
export function compareVersions(a: string, b: string): number {
	const pa = a.trim().split(".");
	const pb = b.trim().split(".");
	const length = Math.max(pa.length, pb.length);
	for (let i = 0; i < length; i++) {
		const x = pa[i] ?? "0";
		const y = pb[i] ?? "0";
		const xn = Number.parseInt(x, 10);
		const yn = Number.parseInt(y, 10);
		if (Number.isNaN(xn) || Number.isNaN(yn)) {
			const c = x.localeCompare(y);
			if (c !== 0) return c < 0 ? -1 : 1;
		} else if (xn !== yn) {
			return xn < yn ? -1 : 1;
		}
	}
	return 0;
}

/** 单缓存目录下全部待装 zip（pending/ + 根），按目录内无序遍历。 */
export function listZipFilesIn(cacheDir: string): string[] {
	try {
		const files: string[] = [];
		for (const dir of [path.join(cacheDir, "pending"), cacheDir]) {
			for (const entry of fs.readdirSync(dir)) {
				if (entry.endsWith(".zip")) files.push(path.join(dir, entry));
			}
		}
		return files;
	} catch {
		// 目录不存在等：无候选。
		return [];
	}
}

/**
 * 读取更新 zip 内 .app 的 CFBundleShortVersionString。
 * @returns 解析失败（zip 损坏 / 结构不符 / 读不出版本）返回 null —— 调用方视为不可安装。
 */
export async function readVersionFromUpdateZip(zipPath: string): Promise<string | null> {
	try {
		const listing = await execFileOut("unzip", ["-Z1", zipPath]);
		const plistEntry = listing
			.split("\n")
			.map(line => line.trim())
			.find(line => TOP_LEVEL_APP_INFO_PLIST.test(line));
		if (plistEntry === undefined) return null;
		const content = await execFileOut("unzip", ["-p", zipPath, plistEntry]);
		const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(content);
		const version = match?.[1]?.trim();
		return version === undefined || version === "" ? null : version;
	} catch {
		return null;
	}
}

/**
 * 清理缓存目录里不在 keepPaths 中的残留 zip（历史下载），返回删除数。
 * 单个文件删除失败不影响其它（吞错）——清理是尽力而为，绝不反向影响下载/安装主流程。
 */
export async function cleanupStaleUpdateZips(
	cacheDirs: readonly string[],
	keepPaths: readonly string[],
): Promise<number> {
	const keep = new Set(keepPaths.map(p => path.resolve(p)));
	let removed = 0;
	for (const dir of cacheDirs) {
		for (const file of listZipFilesIn(dir)) {
			if (keep.has(path.resolve(file))) continue;
			try {
				fs.rmSync(file);
				removed++;
			} catch {
				// 文件被占用/权限：跳过。
			}
		}
	}
	return removed;
}
