/**
 * DiffReviewStore —— 待审 diff 的内存队列（票 08）。
 *
 * 数据源：agent 改动（ACP 会话 diff artifact / 授权写前的 fs_diff）提交到本 store，
 * DiffReviewView 订阅后渲染。接受/拒绝/修改后接受均在此消费 wire fs_write 落地。
 */

export interface DiffReviewItem {
	id: string;
	/** agentDir 相对路径。 */
	path: string;
	/** 改动前内容（用于冲突检测）。 */
	before: string;
	/** 提议改动后的内容（接受/metadata 落地）。 */
	after: string;
	/** 可选说明（来自 agent 的改动意图）。 */
	description?: string;
}

type Listener = () => void;

export class DiffReviewStore {
	readonly #items: DiffReviewItem[] = [];
	readonly #listeners = new Set<Listener>();
	#seq = 0;

	get items(): readonly DiffReviewItem[] {
		return this.#items;
	}

	get size(): number {
		return this.#items.length;
	}

	submit(item: Omit<DiffReviewItem, "id">): string {
		const id = `diff_${++this.#seq}`;
		this.#items.push({ ...item, id });
		this.#emit();
		return id;
	}

	remove(id: string): void {
		const idx = this.#items.findIndex(i => i.id === id);
		if (idx < 0) return;
		this.#items.splice(idx, 1);
		this.#emit();
	}

	clear(): void {
		this.#items.length = 0;
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

/** 全局单例。 */
export const diffReviewStore = new DiffReviewStore();
