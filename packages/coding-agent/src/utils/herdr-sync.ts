import { logger } from "@cornfield/utils";

/** 超过此时长仍未退出则终止 herdr 进程，防止同步调用挂死。 */
const HERDR_SYNC_TIMEOUT_MS = 5_000;

/**
 * 将 omp session 名转换为 herdr agent name（左下角 agents 面板显示的名字）。
 *
 * herdr 规则：小写字母开头，仅含小写字母/数字/'-'/'_'，1-32 字符。
 * 无法生成合法名（如全中文标题）时返回 undefined，调用方跳过 agent rename。
 */
export function sanitizeAgentName(title: string): string | undefined {
	const converted = title
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
	return /^[a-z][a-z0-9_-]{0,31}$/.test(converted) ? converted : undefined;
}

/** 执行一次 herdr CLI 调用：超时 kill、失败仅 warn，绝不抛出。 */
async function runHerdr(args: string[], logReason: string): Promise<void> {
	try {
		const proc = Bun.spawn(["herdr", ...args], { stdout: "pipe", stderr: "pipe" });
		await Promise.race([proc.exited, Bun.sleep(HERDR_SYNC_TIMEOUT_MS).then(() => proc.kill())]);
		if (proc.exitCode !== 0) {
			logger.warn(`herdr ${logReason} failed`, { args, exitCode: proc.exitCode });
		}
	} catch (err) {
		logger.warn(`herdr ${logReason} skipped`, { err });
	}
}

/**
 * 将 omp session 名同步到 herdr 的 agent name（左下角 agents 面板显示的名字）。
 *
 * 仅在 herdr 环境（HERDR_ENV=1 且 HERDR_PANE_ID 存在）下生效；
 * 其他环境直接返回，不产生任何副作用。同步失败只记录 warn 日志，
 * 绝不抛出异常或阻塞调用方 —— 它是 /rename 的附属动作，不能影响改名本身。
 */
export async function syncSessionTitleToHerdrPane(title: string | undefined): Promise<void> {
	const paneId = process.env.HERDR_PANE_ID;
	if (process.env.HERDR_ENV !== "1" || !paneId) return;

	// title 无法合规化（空 / 全中文 / 数字开头等）时清除 agent name，退回显示 kind，避免残留旧名误导。
	const agentName = title ? sanitizeAgentName(title) : undefined;
	const args = agentName ? ["agent", "rename", paneId, agentName] : ["agent", "rename", paneId, "--clear"];
	await runHerdr(args, "agent rename");
}
