import type { PermissionRequestPush } from "@oh-my-pi/pi-wire";

/**
 * PermissionStore —— pending 审批/澄清请求（票 09）。
 *
 * wire permission_request push 驱动：ApprovalContribution 订阅 WireClient.onPush，
 * 把 kind=approval/clarify 的请求写入本 store；PermissionHost 订阅后渲染审批卡/
 * 澄清卡；决策经 permission_respond 回传 serve。
 */

type Listener = () => void;

export class PermissionStore {
	#pending: PermissionRequestPush | null = null;
	readonly #listeners = new Set<Listener>();

	get pending(): PermissionRequestPush | null {
		return this.#pending;
	}

	set(push: PermissionRequestPush): void {
		this.#pending = push;
		this.#emit();
	}

	clear(): void {
		this.#pending = null;
		this.#emit();
	}

	subscribe(listener: Listener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch {
				// 一个监听器崩不拖垮其它
			}
		}
	}
}

export const permissionStore = new PermissionStore();
