import { randomUUID } from "node:crypto";
import type { CanUseToolContext } from "@cornfield/agent";
import type { PermissionRequestPush } from "@cornfield/wire";

/**
 * PermissionGate —— 审批/澄清 pending 表。
 *
 * 复用 host-tool-bridge.ts 的 pending 模式：inject/requestApproval 建 pending →
 * push 给连接（由上层广播），respond 按 requestId 决议；超时/清空时 resolve 哨兵值，防泄漏。
 *
 * 与 WS 传输解耦（不持有连接）：`inject`/`requestApproval` 产出 push + outcome promise，
 * `respond` 只做白名单校验 + 决议。
 *
 * 挂起语义（P2-W1-4）：
 *   - 超时默认：拒绝（outcome settle 为 PERMISSION_TIMEOUT_OUTCOME）；
 *   - abort：由 agent-core 的 canUseTool 三方竞速拒绝，这里的 pending 靠自身超时/clearAll 自清理；
 *   - 多端：上层广播 push 给全部连接，谁先 respond 谁赢。
 *
 * 放行范围（P2-W1-4 拍板）：once=本次放行；session=本 serve 进程内精确命令放行（内存）。
 * always 持久化 allowlist 从本卡剔除（模糊 pattern 派生/匹配是安全雷区）。
 */

export type PermissionKind = "approval" | "clarify";

export const PERMISSION_TIMEOUT_OUTCOME = "__timeout__";

export const APPROVAL_CHOICES = new Set(["deny", "once", "session"]);

export const MOCK_APPROVAL = {
	command: "git push origin main --force-with-lease",
	description: "本会话已放行 2 条",
	patternKeys: ["git push --force*"],
};

export const MOCK_CLARIFY = {
	question: "要把 mock 里的深色主题一并迁移吗？",
	options: ["只迁亮色（V6 现状）", "亮色 + 深色都迁", "先亮色，深色进 backlog"],
};

function buildApprovalPush(
	requestId: string,
	command: string,
	description: string,
	patternKeys: string[],
): PermissionRequestPush {
	return {
		type: "permission_request",
		requestId,
		kind: "approval",
		command,
		description,
		patternKeys,
	};
}

function buildClarifyPush(requestId: string): PermissionRequestPush {
	return {
		type: "permission_request",
		requestId,
		kind: "clarify",
		question: MOCK_CLARIFY.question,
		options: MOCK_CLARIFY.options,
	};
}

interface PendingPermission {
	kind: PermissionKind;
	command?: string;
	resolve: (choice: string) => void;
}

export type PermissionRespondResult = { ok: true } | { ok: false; error: string };

/** 精确匹配用：trim + 折叠空白，session allowlist 的 key。 */
function normalizeCommand(command: string): string {
	return command.trim().replace(/\s+/g, " ");
}

export class PermissionGate {
	readonly #pending = new Map<string, PendingPermission>();
	readonly #sessionAllowlist = new Set<string>();
	readonly #timeoutMs: number;

	constructor(timeoutMs = 120_000) {
		this.#timeoutMs = timeoutMs;
	}

	/** 测试通道：注入一个 mock 审批/澄清请求（不接 agent-core）。 */
	inject(kind: PermissionKind): { requestId: string; push: PermissionRequestPush; outcome: Promise<string> } {
		if (kind === "approval") {
			return this.#requestApproval(MOCK_APPROVAL.command, MOCK_APPROVAL.description, MOCK_APPROVAL.patternKeys);
		}
		return this.#requestClarify();
	}

	/** 真实审批源：bash 命令审批。`command` 在 respond("session") 时入内存 allowlist。 */
	requestApproval(
		command: string,
		description: string,
	): { requestId: string; push: PermissionRequestPush; outcome: Promise<string> } {
		return this.#requestApproval(command, description, []);
	}

	/** 该精确命令是否已在本 serve 进程内被放行过。 */
	isSessionApproved(command: string): boolean {
		return this.#sessionAllowlist.has(normalizeCommand(command));
	}

	#requestApproval(
		command: string,
		description: string,
		patternKeys: string[],
	): { requestId: string; push: PermissionRequestPush; outcome: Promise<string> } {
		const requestId = randomUUID();
		const { promise, resolve } = Promise.withResolvers<string>();
		const timer = setTimeout(() => {
			if (this.#pending.delete(requestId)) resolve(PERMISSION_TIMEOUT_OUTCOME);
		}, this.#timeoutMs);
		this.#pending.set(requestId, {
			kind: "approval",
			command,
			resolve: choice => {
				clearTimeout(timer);
				resolve(choice);
			},
		});
		return { requestId, push: buildApprovalPush(requestId, command, description, patternKeys), outcome: promise };
	}

	#requestClarify(): { requestId: string; push: PermissionRequestPush; outcome: Promise<string> } {
		const requestId = randomUUID();
		const { promise, resolve } = Promise.withResolvers<string>();
		const timer = setTimeout(() => {
			if (this.#pending.delete(requestId)) resolve(PERMISSION_TIMEOUT_OUTCOME);
		}, this.#timeoutMs);
		this.#pending.set(requestId, {
			kind: "clarify",
			resolve: choice => {
				clearTimeout(timer);
				resolve(choice);
			},
		});
		return { requestId, push: buildClarifyPush(requestId), outcome: promise };
	}

	/**
	 * 决议一个 pending。approval 的 choice 必须命中白名单（deny|once|session），
	 * clarify 为任意 option 文本。未知 requestId 或脏值返回 error，不消耗 pending。
	 */
	respond(requestId: string, choice: string): PermissionRespondResult {
		const pending = this.#pending.get(requestId);
		if (!pending) {
			return { ok: false, error: `unknown or expired permission request: ${requestId}` };
		}
		if (pending.kind === "approval" && !APPROVAL_CHOICES.has(choice)) {
			return { ok: false, error: `invalid choice: ${choice}` };
		}
		this.#pending.delete(requestId);
		if (pending.kind === "approval" && choice === "session" && pending.command) {
			this.#sessionAllowlist.add(normalizeCommand(pending.command));
		}
		pending.resolve(choice);
		return { ok: true };
	}

	/** 连接全断时清空所有 pending（resolve 哨兵值）。 */
	clearAll(): void {
		for (const pending of this.#pending.values()) {
			pending.resolve(PERMISSION_TIMEOUT_OUTCOME);
		}
		this.#pending.clear();
	}
}

/**
 * 构造 serve 侧 canUseTool 钩子：只给 bash 上闸门，其余工具直接放行（零变化）。
 * bash 命中 session allowlist 直接放行；否则 requestApproval → 广播 push → 等 respond。
 * once/session → 放行；deny/超时/断开 → 拒绝。
 */
export function createApprovalCanUseTool(
	gate: PermissionGate,
	broadcast: (push: PermissionRequestPush) => void,
): (ctx: CanUseToolContext) => Promise<boolean> {
	return async ctx => {
		if (ctx.name !== "bash") return true;
		const command = typeof ctx.args?.command === "string" ? ctx.args.command : JSON.stringify(ctx.args);
		if (gate.isSessionApproved(command)) return true;
		const { push, outcome } = gate.requestApproval(command, ctx.name);
		broadcast(push);
		const choice = await outcome;
		return choice === "once" || choice === "session";
	};
}
