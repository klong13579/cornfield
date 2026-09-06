import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 壳主进程文件日志：把 console.* 同步镜像到磁盘文件。
 *
 * 背景：GUI 方式启动（Finder/Dock）时 stderr 被系统丢弃，主进程里的 console.error/warn
 * （updater 错误、sidecar 异常、加载失败）全部无迹可查，排障只能靠猜。
 *
 * 设计：
 * - 不依赖 electron 模块（目录由调用方解析后传入），可在 bun test 下直接单测；
 * - 候选目录按序取第一个可写的，null 表示终止候选（仅 stderr，保持旧行为）；
 * - 同步 append（GUI 壳日志量极小），保序且崩溃前已写入的内容不丢；
 * - 单文件超限后整体挪到 main.old.log（保留一代），轮转失败不影响继续追加；
 * - console 镜像保留原 stderr 行为（终端启动调试仍能看到输出）；
 * - Error 展开为单行（stack 换行折叠为 " | "），保证日志按行可 tail/grep。
 */

const LOG_FILE_NAME = "main.log";
/** 单文件上限：超过后整体轮转到 main.old.log（保留一代）。 */
const DEFAULT_ROTATE_BYTES = 5 * 1024 * 1024;

type Level = "debug" | "info" | "warn" | "error";

let logFilePath: string | null = null;
let rotateBytes = DEFAULT_ROTATE_BYTES;

/** console 方法 → 日志级别的映射（log 归入 info）。 */
const CONSOLE_MAPPINGS: ReadonlyArray<{ method: "log" | "debug" | "info" | "warn" | "error"; level: Level }> = [
	{ method: "log", level: "info" },
	{ method: "debug", level: "debug" },
	{ method: "info", level: "info" },
	{ method: "warn", level: "warn" },
	{ method: "error", level: "error" },
];

export interface FileLoggingOptions {
	/** 单文件上限字节数（测试用小值触发轮转）。 */
	rotateBytes?: number;
}

/**
 * 初始化文件日志：在 dirs 中取第一个可写的目录，monkey-patch console.*
 * 把每次输出同步追加到 `<dir>/main.log`。
 *
 * @returns 还原函数（恢复原始 console、重置初始化状态）；重复调用本函数是幂等的，
 *          只有第一次初始化生效，后续调用返回 no-op。
 */
export function initFileLogging(dirs: ReadonlyArray<string | null>, options: FileLoggingOptions = {}): () => void {
	if (logFilePath !== null) {
		return () => {};
	}
	rotateBytes = options.rotateBytes ?? DEFAULT_ROTATE_BYTES;
	logFilePath = pickWritable(dirs);
	if (logFilePath === null) {
		return () => {};
	}
	const restoreFns: Array<() => void> = [];
	for (const { method, level } of CONSOLE_MAPPINGS) {
		const original = console[method];
		console[method] = (...args: unknown[]): void => {
			original(...args);
			write(level, args);
		};
		restoreFns.push(() => {
			console[method] = original;
		});
	}
	return () => {
		for (const restore of restoreFns.reverse()) restore();
		logFilePath = null;
	};
}

/**
 * electron-updater Logger 兼容面（builder-util-runtime 的 Logger 结构等形，避免依赖其传递类型）。
 * 用法：configureUpdater 里 `autoUpdater.logger = updaterLogger`，让 updater 内部的
 * feed 检查 / 下载 / 校验日志进文件；文件日志未初始化时退回 console（旧行为）。
 */
export const updaterLogger = {
	debug: (message?: unknown): void => logOrConsole("debug", [message]),
	info: (message?: unknown): void => logOrConsole("info", [message]),
	warn: (message?: unknown): void => logOrConsole("warn", [message]),
	error: (message?: unknown): void => logOrConsole("error", [message]),
};

/** 逐候选取第一个可写目录；显式 null = 终止候选（仅 stderr）。 */
function pickWritable(dirs: ReadonlyArray<string | null>): string | null {
	for (const dir of dirs) {
		if (dir === null) return null;
		try {
			fs.mkdirSync(dir, { recursive: true });
			return path.join(dir, LOG_FILE_NAME);
		} catch {
			// 目录建不出来（EACCES 等）：试下一个候选。
		}
	}
	return null;
}

function logOrConsole(level: Level, args: readonly unknown[]): void {
	if (logFilePath === null) {
		console[level](...args);
		return;
	}
	write(level, args);
}

function write(level: Level, args: readonly unknown[]): void {
	if (logFilePath === null) return;
	const text = args
		.map(stringify)
		.join(" ")
		.replace(/\r?\n\s*/g, " | ");
	append(`${timestamp()} [${level}] ${text}`);
}

function append(line: string): void {
	if (logFilePath === null) return;
	try {
		rotateIfNeeded();
		fs.appendFileSync(logFilePath, `${line}\n`);
	} catch {
		// 写日志失败绝不反向影响主流程（stderr 已有原件）。
	}
}

function rotateIfNeeded(): void {
	if (logFilePath === null) return;
	try {
		const stat = fs.statSync(logFilePath);
		if (stat.size < rotateBytes) return;
		const oldPath = path.join(path.dirname(logFilePath), "main.old.log");
		fs.rmSync(oldPath, { force: true });
		fs.renameSync(logFilePath, oldPath);
	} catch {
		// stat/rename 失败（文件不存在等）：按无需轮转处理。
	}
}

/** Error 展开为单行（stack 保留，换行折叠），其余值 JSON 化，保证日志按行可 tail/grep。 */
function stringify(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
	if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") {
		return String(value);
	}
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value); // BigInt / 循环引用等 JSON 化失败的值。
	}
}

/** 本地时区 ISO 时间戳（与 coding-agent logger 的 +08:00 风格一致）。 */
function timestamp(): string {
	const d = new Date();
	const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
	const offsetMinutes = -d.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const hours = pad(Math.floor(Math.abs(offsetMinutes) / 60));
	const minutes = pad(Math.abs(offsetMinutes) % 60);
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
		`T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
		`${sign}${hours}:${minutes}`
	);
}
