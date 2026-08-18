import type { PiWebSocketCtor, PiWebSocketLike } from "../src/client";

/**
 * FakeWebSocket — 完全可控制的 WS mock，十分适合单测：
 *   - 不开 socket，不开 timer
 *   - `.open()` 手动触发服务器 open
 *   - `.recv(text)` 手动推送一帧给客户端
 *   - `.close()` 触发客户端 onclose
 *   - `.sent` 收集客户端发送的帧
 *   - 多个实例共享 `openSockets` 列表，方便断开/重连时获取第 N 个
 */
export class FakeWebSocket implements PiWebSocketLike {
	static all: FakeWebSocket[] = [];
	readonly url: string;
	readyState = 0; // 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
	sent: string[] = [];
	onopen: ((ev: unknown) => void) | null = null;
	onmessage: ((ev: { data: string | Buffer | ArrayBuffer }) => void) | null = null;
	onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
	onerror: ((ev: unknown) => void) | null = null;

	constructor(url: string) {
		this.url = url;
		FakeWebSocket.all.push(this);
	}

	send(data: string): void {
		if (this.readyState !== 1) throw new Error("FakeWebSocket: not open");
		this.sent.push(data);
	}

	close(): void {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.onclose?.({});
	}

	// ── 测试控制入口 ──

	open(): void {
		this.readyState = 1;
		this.onopen?.({});
	}

	recv(text: string): void {
		this.onmessage?.({ data: text });
	}

	remoteClose(): void {
		this.readyState = 3;
		this.onclose?.({});
	}

	static reset(): void {
		FakeWebSocket.all = [];
	}
}

export const FakeWebSocketCtor: PiWebSocketCtor = FakeWebSocket as unknown as PiWebSocketCtor;

/**
 * FakeClock — 手动控制的 setTimeout。advance(ms) 推进时间。
 */
export class FakeClock {
	#now = 0;
	#timers: Array<{ id: number; fireAt: number; fn: () => void; cancelled: boolean }> = [];
	#nextId = 1;

	readonly api = {
		setTimeout: (fn: () => void, ms: number): number => {
			const id = this.#nextId++;
			this.#timers.push({ id, fireAt: this.#now + Math.max(0, ms), fn, cancelled: false });
			return id;
		},
		clearTimeout: (id: number): void => {
			const t = this.#timers.find(t => t.id === id);
			if (t) t.cancelled = true;
		},
	} as unknown as {
		setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
		clearTimeout: (h: ReturnType<typeof setTimeout>) => void;
	};

	get now(): number {
		return this.#now;
	}

	/** 推进时间 ms。触发区间内所有 timer（按 fireAt 升序）。 */
	advance(ms: number): void {
		const target = this.#now + ms;
		while (true) {
			const next = this.#timers
				.filter(t => !t.cancelled && t.fireAt <= target)
				.sort((a, b) => a.fireAt - b.fireAt)[0];
			if (!next) break;
			this.#now = next.fireAt;
			next.cancelled = true;
			next.fn();
		}
		this.#now = target;
	}

	get pendingCount(): number {
		return this.#timers.filter(t => !t.cancelled).length;
	}
}

/** 小工具：flush 微任务队（等 promise then callback）。 */
export async function tick(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
