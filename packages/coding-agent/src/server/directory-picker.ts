/**
 * serve 侧的目录选择器 —— 让**跑 serve 的那台机器**上的人选一个目录。
 *
 * 为什么必须有这一条：Project root 与（桌面壳的）工作目录都要求一个**绝对路径**，而浏览器拿不到
 * 绝对路径 —— `<input type="file" webkitdirectory>` 只给 `webkitRelativePath`（相对路径），
 * 浏览器出于指纹安全不暴露真实路径。所以网页直开时，「选一个目录」只能由真正拥有那个文件系统的
 * 进程来做：serve 弹出系统选择器，把用户亲手选中的那一个路径带回去。
 *
 * 边界（与 `fs_*` 那条会话工作面是两件事，不要混）：
 *   - 这里**不读目录内容**，没有任何列举目录的能力经过它；
 *   - 不受 workspace roots 约束：用户要选的目录本来就在工作面之外，那正是要选它的原因。
 *
 * 三种结果分开说（见 `PickDirectoryDto`）：选中 / 取消 / 弹不出来。最后一种**抛**，由命令回
 * ok:false —— 「人根本没被问到」不得降级成「人取消了」。
 *
 * 平台：目前只实现了 macOS。其它平台回一句原文原因，不拿一个假的成功糊过去 —— 手打绝对路径
 * 仍然可用（这正是选择器不可用时的那条退路）。
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { isEnoent } from "@cornfield/utils";
import type { PickDirectoryDto } from "@cornfield/wire";

/**
 * AppleScript 里的提示语用 ASCII 英文：`-e` 的字面量按 locale 解码，非 UTF-8 的 locale 下中文会
 * 变成乱码；而这段提示唯一要传达的信息是「这个弹窗来自 cornfield，它在 serve 那台机器上」——
 * 一个 ASCII 句子在任何 locale 下都读得懂，一段可能乱码的中文做不到。
 */
const PICK_PROMPT = "cornfield: choose a folder on this machine";

/**
 * AppleScript 源。**没有一处字符串插值**：起始目录从 argv 里取（见 `appleScriptArgs` 的注释），
 * 用户给的路径永远不会变成脚本代码的一部分。
 *
 * 三个防御点，各自对应一件已经见过出事的事：
 *   - 只认以 `/` 开头的 argv 项 —— 参数怎么摆（有没有 `--`、会不会多出一个 programfile）不影响
 *     结果，认不出就退到「不指定起始目录」，而不是拿一个 "--" 去当路径；
 *   - 取消（-128）在脚本里就地接住并回一句 `CANCELED`，不靠 stderr 的文案判 —— 那句文案会随
 *     系统语言变，-128 这个号不会；
 *   - 其它错误照旧往外抛，由命令回 ok:false + osascript 原文。
 */
const APPLE_SCRIPT = [
	"on run argv",
	'\tset startDir to ""',
	"\trepeat with i from 1 to (count of argv)",
	"\t\tset candidate to (item i of argv) as text",
	'\t\tif candidate starts with "/" then',
	"\t\t\tset startDir to candidate",
	"\t\t\texit repeat",
	"\t\tend if",
	"\tend repeat",
	"\ttry",
	'\t\tif startDir is "" then',
	`\t\t\tset picked to choose folder with prompt "${PICK_PROMPT}"`,
	"\t\telse",
	`\t\t\tset picked to choose folder with prompt "${PICK_PROMPT}" default location (POSIX file startDir)`,
	"\t\tend if",
	'\t\treturn "PICKED" & (POSIX path of picked)',
	"\ton error number -128",
	'\t\treturn "CANCELED"',
	"\tend try",
	"end run",
].join("\n");

/** 选择器在哪些平台上能弹（其余平台回原文原因，不假装成功）。 */
export function directoryPickerSupported(platform: string = process.platform): boolean {
	return platform === "darwin";
}

/**
 * osascript 的 argv。
 *
 * 起始目录走 argv 而不是拼进脚本：它来自调用方（`defaultPath`），拼进脚本就是把一个外部字符串
 * 变成可执行的 AppleScript。
 */
export function appleScriptArgs(startDir: string): string[] {
	return ["-e", APPLE_SCRIPT, "--", startDir];
}

/**
 * 起始目录：只有它**确实是一个存在的目录**时才用它，否则退到 home。
 *
 * 与桌面壳同一个判据（`packages/desktop/src/main.ts` 的 `pickerStartDir`）：指向不存在的目录时
 * 系统选择器的行为随平台而异，与其把那个不确定性交给 AppleScript，不如在这里定死。
 * `~/` 要展开：设置页的工作目录就允许写成 `~/workspace`。
 */
export async function pickerStartDir(defaultPath?: string): Promise<string> {
	const raw = defaultPath?.trim() ?? "";
	if (raw !== "") {
		const expanded = raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : path.resolve(raw);
		try {
			const stat = await fs.stat(expanded);
			if (stat.isDirectory()) return expanded;
		} catch (err) {
			// 不存在 / 读不到都只是「这个建议不成立」，不是错误：退到 home。
			if (!isEnoent(err)) throw err;
		}
	}
	return os.homedir();
}

/**
 * osascript 的输出 → 答复。纯函数：三种结果的判定全靠它，所以它必须能脱开进程单独验。
 *
 * 只有两种情况算成功（`PICKED` / `CANCELED`）；其余一律抛，并把 osascript 的原文带上 ——
 * 「弹出失败了」与「人选了取消」在下游是完全不同的两件事，不能在这里揉成一个。
 */
export function parsePickerResult(input: { stdout: string; stderr: string; exitCode: number }): PickDirectoryDto {
	const out = input.stdout.trim();
	if (out === "CANCELED") return { canceled: true };

	if (out.startsWith("PICKED")) {
		const picked = out.slice("PICKED".length).trim();
		// 说了选好却没给路径：这不是一次成功的选择，不能拿空串顶替（空 root 会被 serve 解析成它的 cwd）。
		if (picked === "") throw new Error("osascript reported a pick but returned no path.");
		// `choose folder` 的 POSIX path 带尾斜杠（`/a/b/`），归一掉：声明出去的就是屏幕上那个目录。
		return { canceled: false, path: path.normalize(picked) };
	}

	const detail = input.stderr.trim() || out || "no output";
	throw new Error(`osascript could not show the folder picker (exit ${input.exitCode}): ${detail}`);
}

/**
 * 弹一次系统目录选择框。人取消 → `canceled:true`；弹不出来 → 抛（由命令回 ok:false）。
 *
 * 这个调用**没有超时**：要多久由按下去的那个人决定。调用方（wire 客户端）为此把这条命令的请求
 * 超时放宽到分钟级，见 `web-app` 的 `PICK_DIRECTORY_TIMEOUT_MS`。
 */
export async function pickDirectory(defaultPath?: string): Promise<PickDirectoryDto> {
	if (!directoryPickerSupported()) {
		throw new Error(
			`the folder picker is not implemented on ${process.platform}; ` +
				"type an absolute path instead (this platform has no system picker wired to serve).",
		);
	}

	const proc = Bun.spawn(["osascript", ...appleScriptArgs(await pickerStartDir(defaultPath))], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return parsePickerResult({ stdout, stderr, exitCode });
}
