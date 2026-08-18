import { randomUUID } from "node:crypto";
import type { PermissionRequestPush } from "@oh-my-pi/pi-wire";

/**
 * PermissionGate —— 审批/澄清 pending 表（壳内验证 mode）。
 *
 * 参考 host-tool-bridge.ts 的 pending 模式：inject 建 pending → push 给连接（由
 * 上层广播），respond 按 requestId 决议；超时/清空时 resolve 哨兵值，防泄漏。
 *
 * 与 WS 传输解耦（不持有连接）：`inject` 产出 push + outcome promise，`respond`
 * 只做白名单校验 + 决议。将来 agent-core canUseTool 接上后复用同一类即可。
 */

export type PermissionKind = "approval" | "clarify";

export const PERMISSION_TIMEOUT_OUTCOME = "__timeout__";

export const APPROVAL_CHOICES = new Set(["deny", "once", "session", "always"]);

export const MOCK_APPROVAL = {
	command: "git push origin main --force-with-lease",
	description: "本会话已放行 2 条",
	patternKeys: ["git push --force*"],
};

export const MOCK_CLARIFY = {
	question: "要把 mock 里的深色主题一并迁移吗？",
	options: ["只迁亮色（V6 现状）", "亮色 + 深色都迁", "先亮色，深色进 backlog"],
};

function buildPermissionPush(requestId: string, kind: PermissionKind): PermissionRequestPush {
	if (kind === "approval") {
		return {
			type: "permission_request",
			requestId,
			kind: "approval",
			command: MOCK_APPROVAL.command,
			description: MOCK_APPROVAL.description,
			patternKeys: MOCK_APPROVAL.patternKeys,
		};
	}
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
	resolve: (choice: string) => void;
}

export type PermissionRespondResult = { ok: true } | { ok: false; error: string };

export class PermissionGate {
	readonly #pending = new Map<string, PendingPermission>();
	readonly #timeoutMs: number;

	constructor(timeoutMs = 60_000) {
		this.#timeoutMs = timeoutMs;
	}

	/** 注入一个请求；返回 push（上层广播）与 outcome（respond/timeout 时 settle 为 choice）。 */
	inject(kind: PermissionKind): { push: PermissionRequestPush; outcome: Promise<string> } {
		const requestId = randomUUID();
		const { promise, resolve } = Promise.withResolvers<string>();
		const timer = setTimeout(() => {
			if (this.#pending.delete(requestId)) resolve(PERMISSION_TIMEOUT_OUTCOME);
		}, this.#timeoutMs);
		this.#pending.set(requestId, {
			kind,
			resolve: choice => {
				clearTimeout(timer);
				resolve(choice);
			},
		});
		return { push: buildPermissionPush(requestId, kind), outcome: promise };
	}

	/**
	 * 决议一个 pending。approval 的 choice 必须命中白名单（deny|once|session|always），
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
