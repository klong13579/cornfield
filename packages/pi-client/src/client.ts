import type { ClientFrame, ServerFrame, WireCommand, WireServerEvent } from "@oh-my-pi/pi-wire";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@oh-my-pi/pi-wire";
import { PiDisconnectedError, PiHandshakeError, PiRequestTimeoutError, PiServerError } from "./errors";

/**
 * WebSocket-like ctor 接口——方便测试时注入 fake（避免依赖真 WS）。默认用 globalThis.WebSocket。
 * signature 与浏览器/Bun/Node ws 兼容子集。
 */
export interface PiWebSocketLike {
	readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	onopen: ((ev: unknown) => void) | null;
	onmessage: ((ev: { data: string | Buffer | ArrayBuffer }) => void) | null;
	onclose: ((ev: { code?: number; reason?: string }) => void) | null;
	onerror: ((ev: unknown) => void) | null;
}

export type PiWebSocketCtor = new (url: string) => PiWebSocketLike;

/** 连接状态机。 */
export type PiConnectionStatus = "disconnected" | "connecting" | "handshaking" | "open" | "closed";

/**
 * pi-client 对外事件——包含连接状态变化、推送事件、错误。
 *
 * 设计：service 层订阅 push 事件以与 session_snapshot 同步快照缓存（已内置）；
 * UI 层订阅 statusChange 展示连接指示器。
 */
export type PiClientEventKind =
	| { type: "status"; status: PiConnectionStatus; attempt?: number }
	| { type: "hello_ack"; connectionId: string; protocolVersion: number }
	| { type: "push"; event: WireServerEvent }
	| { type: "error"; error: Error };

export type PiClientListener = (event: PiClientEventKind) => void;
export type PiSnapshotListener<TSnapshot = unknown> = (sessionId: string, snapshot: TSnapshot) => void;

export interface PiClientOptions {
	url: string;
	token: string;
	/** 注入 WebSocket 实现。默认 globalThis.WebSocket (Bun/浏览器均存在)。测试下传入 fake。 */
	webSocketCtor?: PiWebSocketCtor;
	/** hello 握手使用的协议版本，默认为产品 = MULTIDEVICE_PROTOCOL_VERSION。 */
	protocolVersion?: number;
	/** 单个请求超时 (ms)，默认 30000。 */
	requestTimeoutMs?: number;
	/** 重连退避基础间隔 (ms)，默认 500。 */
	reconnectBaseMs?: number;
	/** 重连退避上限 (ms)，默认 30000。 */
	reconnectMaxMs?: number;
	/** 重连最大尝试次数（Infinity = 无限）。 */
	reconnectMaxAttempts?: number;
	/** true 时，断线后自动重连（默认 true）。close() 手动关闭后不重连。 */
	autoReconnect?: boolean;
	/** ID 生成器——默认递增数字。测试可注入确定型序列。 */
	nextRequestId?: () => string;
	/** 时钟抽象（方便单测控制 backoff）。默认真实 setTimeout/clearTimeout。 */
	clock?: {
		setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
		clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
	};
}

type PendingRequest = {
	commandType: string;
	resolve: (result: unknown) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

/**
 * pi-client——连 `omp serve` 的 WS 客户端。
 *
 * 职责划分：
 *   - 连接状态机（disconnected → connecting → handshaking → open）
 *   - hello 握手（版本 + token）
 *   - request/response 关联（id -> Promise + 超时）
 *   - 指数退避重连，重连后 subscribe 自动继续（监听器不变）
 *   - session_snapshot 缓存（权威源），progress 仅通知不归约
 *   - 断线时在途请求立即拒绝 (PiDisconnectedError)——fail fast
 *
 * 设计外部边界：不自动发送商业命令，不代入 hello 外的 frame；不内置长连接 heartbeat
 * （服务器层。 P3 可加上）。
 */
export class PiClient {
	readonly #url: string;
	readonly #token: string;
	readonly #webSocketCtor: PiWebSocketCtor;
	readonly #protocolVersion: number;
	readonly #requestTimeoutMs: number;
	readonly #reconnectBaseMs: number;
	readonly #reconnectMaxMs: number;
	readonly #reconnectMaxAttempts: number;
	readonly #autoReconnect: boolean;
	readonly #nextRequestId: () => string;
	readonly #clock: NonNullable<PiClientOptions["clock"]>;

	#ws?: PiWebSocketLike;
	#status: PiConnectionStatus = "disconnected";
	#pending = new Map<string, PendingRequest>();
	#listeners = new Set<PiClientListener>();
	#snapshotListeners = new Set<PiSnapshotListener>();
	#snapshots = new Map<string, unknown>();
	#reconnectAttempt = 0;
	#reconnectTimer?: ReturnType<typeof setTimeout>;
	#requestCounter = 0;
	/** 用户显式 close() 后，拒绝重连。 */
	#closedByUser = false;
	/** 当前 hello 握手的 promise——connect() 多次调用时去重。 */
	#connectingPromise?: Promise<void>;

	constructor(options: PiClientOptions) {
		this.#url = options.url;
		this.#token = options.token;
		const ctor = options.webSocketCtor ?? (globalThis as { WebSocket?: PiWebSocketCtor }).WebSocket;
		if (!ctor) {
			throw new Error("PiClient: no WebSocket implementation available (pass options.webSocketCtor)");
		}
		this.#webSocketCtor = ctor;
		this.#protocolVersion = options.protocolVersion ?? MULTIDEVICE_PROTOCOL_VERSION;
		this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
		this.#reconnectBaseMs = options.reconnectBaseMs ?? 500;
		this.#reconnectMaxMs = options.reconnectMaxMs ?? 30_000;
		this.#reconnectMaxAttempts = options.reconnectMaxAttempts ?? Number.POSITIVE_INFINITY;
		this.#autoReconnect = options.autoReconnect ?? true;
		this.#nextRequestId =
			options.nextRequestId ??
			(() => {
				this.#requestCounter += 1;
				return `req_${this.#requestCounter}`;
			});
		// 默认 clock 必须用符初化一层 arrow wrapper，保证浏览器下 `this` 仍是 window。
		// 直接存 { setTimeout, clearTimeout } 会在方法调用形态下报 `TypeError: Illegal invocation`
		// (Chrome/Firefox/Safari 都会拒)。Bun/Node 不校验 this 所以测试没发现——fe-dev P3 雷。
		this.#clock = options.clock ?? {
			setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
			clearTimeout: (h: ReturnType<typeof setTimeout>) => {
				clearTimeout(h);
			},
		};
	}

	// ── 公开 API ──

	get status(): PiConnectionStatus {
		return this.#status;
	}

	get reconnectAttempt(): number {
		return this.#reconnectAttempt;
	}

	/** 初次连接。resolve 于 hello_ack，reject 于握手失败。后续 close/重连不影响本 promise。 */
	connect(): Promise<void> {
		if (this.#status === "open") return Promise.resolve();
		if (this.#connectingPromise) return this.#connectingPromise;
		this.#closedByUser = false;
		return this.#openSocket();
	}

	/**
	 * 发送命令并等待响应。内部自己带 request id。
	 * 未连接：拒 PiDisconnectedError。服务端 ok:false：拒 PiServerError。超时：拒 PiRequestTimeoutError。
	 */
	request<TResult = unknown>(command: WireCommand): Promise<TResult> {
		if (this.#status !== "open" || !this.#ws) {
			return Promise.reject(
				new PiDisconnectedError(`Cannot send "${command.type}": not open (status=${this.#status})`),
			);
		}
		const id = this.#nextRequestId();
		const frame: ClientFrame = { type: "request", id, command: { ...command, id } };
		return new Promise<TResult>((resolve, reject) => {
			const timer = this.#clock.setTimeout(() => {
				const pending = this.#pending.get(id);
				if (!pending) return;
				this.#pending.delete(id);
				pending.reject(new PiRequestTimeoutError(command.type, this.#requestTimeoutMs));
			}, this.#requestTimeoutMs);
			this.#pending.set(id, {
				commandType: command.type,
				resolve: v => resolve(v as TResult),
				reject,
				timer,
			});
			try {
				this.#ws!.send(JSON.stringify(frame));
			} catch (err) {
				this.#pending.delete(id);
				this.#clock.clearTimeout(timer);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	/** 订阅所有 push 事件 + 状态变化。重连不影响监听器（保留）。 */
	subscribe(listener: PiClientListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** 仅订阅 session_snapshot。sessionId + snapshot 两个参数，方便 UI 层直接定位。 */
	subscribeSnapshot<TSnapshot = unknown>(listener: PiSnapshotListener<TSnapshot>): () => void {
		this.#snapshotListeners.add(listener as PiSnapshotListener);
		return () => this.#snapshotListeners.delete(listener as PiSnapshotListener);
	}

	/** 获取已缓存的会话快照（重连时避免 UI 闪白）。 */
	getCachedSnapshot<TSnapshot = unknown>(sessionId: string): TSnapshot | undefined {
		return this.#snapshots.get(sessionId) as TSnapshot | undefined;
	}

	/** 手动关闭，不重连。在途请求全部 reject。 */
	close(reason = "client closed"): void {
		this.#closedByUser = true;
		if (this.#reconnectTimer) {
			this.#clock.clearTimeout(this.#reconnectTimer);
			this.#reconnectTimer = undefined;
		}
		const ws = this.#ws;
		this.#ws = undefined;
		if (ws) {
			try {
				ws.close();
			} catch {
				// ignore close errors
			}
		}
		this.#rejectAllPending(new PiDisconnectedError(reason));
		this.#setStatus("closed");
	}

	// ── 内部：连接建立 + 握手 + 重连 ──

	#openSocket(): Promise<void> {
		this.#setStatus("connecting");
		let ws: PiWebSocketLike;
		try {
			ws = new this.#webSocketCtor(this.#url);
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			this.#emit({ type: "error", error });
			this.#setStatus("disconnected");
			return this.#scheduleReconnectOrReject(error);
		}
		this.#ws = ws;

		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#connectingPromise = promise;

		ws.onopen = () => {
			this.#setStatus("handshaking");
			const hello: ClientFrame = {
				type: "hello",
				version: this.#protocolVersion,
				token: this.#token,
			};
			try {
				ws.send(JSON.stringify(hello));
			} catch (err) {
				const error = err instanceof Error ? err : new Error(String(err));
				reject(error);
				try {
					ws.close();
				} catch {
					// ignore
				}
			}
		};

		ws.onmessage = ev => {
			this.#handleServerFrame(ev.data, resolve, reject);
		};

		ws.onclose = () => {
			this.#handleClose();
		};

		ws.onerror = ev => {
			const error = ev instanceof Error ? ev : new Error(typeof ev === "string" ? ev : "WebSocket transport error");
			this.#emit({ type: "error", error });
		};

		return promise.finally(() => {
			this.#connectingPromise = undefined;
		});
	}

	#handleServerFrame(
		raw: string | Buffer | ArrayBuffer,
		resolveOpen: () => void,
		rejectOpen: (err: Error) => void,
	): void {
		const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer);
		let frame: ServerFrame;
		try {
			frame = JSON.parse(text) as ServerFrame;
		} catch (err) {
			this.#emit({
				type: "error",
				error: new Error(`invalid_json from server: ${err instanceof Error ? err.message : String(err)}`),
			});
			return;
		}

		switch (frame.type) {
			case "hello_ack": {
				this.#reconnectAttempt = 0;
				this.#setStatus("open");
				this.#emit({ type: "hello_ack", connectionId: frame.connectionId, protocolVersion: frame.protocolVersion });
				resolveOpen();
				return;
			}
			case "hello_error": {
				const error = new PiHandshakeError(frame.error);
				this.#emit({ type: "error", error });
				rejectOpen(error);
				try {
					this.#ws?.close();
				} catch {
					// ignore
				}
				return;
			}
			case "response": {
				const pending = this.#pending.get(frame.id);
				if (!pending) return; // 无主响应（已超时/已断线拒绝），忽略
				this.#pending.delete(frame.id);
				this.#clock.clearTimeout(pending.timer);
				if (frame.ok) {
					pending.resolve(frame.result);
				} else {
					pending.reject(new PiServerError(pending.commandType, frame.error));
				}
				return;
			}
			case "push": {
				const event = frame.event;
				if (event.type === "session_snapshot") {
					this.#snapshots.set(event.sessionId, event.snapshot);
					for (const listener of this.#snapshotListeners) {
						listener(event.sessionId, event.snapshot);
					}
				}
				this.#emit({ type: "push", event });
				return;
			}
		}
	}

	#handleClose(): void {
		const wasOpen = this.#status === "open" || this.#status === "handshaking";
		this.#ws = undefined;
		this.#rejectAllPending(new PiDisconnectedError("WebSocket closed"));
		this.#setStatus("disconnected");
		if (this.#closedByUser || !this.#autoReconnect) return;
		if (!wasOpen && this.#reconnectAttempt >= this.#reconnectMaxAttempts) return;
		this.#scheduleReconnect();
	}

	#scheduleReconnect(): void {
		if (this.#reconnectTimer) return;
		if (this.#reconnectAttempt >= this.#reconnectMaxAttempts) return;
		const attempt = this.#reconnectAttempt;
		const delay = Math.min(this.#reconnectBaseMs * 2 ** attempt, this.#reconnectMaxMs);
		this.#reconnectAttempt += 1;
		this.#reconnectTimer = this.#clock.setTimeout(() => {
			this.#reconnectTimer = undefined;
			if (this.#closedByUser) return;
			void this.#openSocket().catch(() => {
				// 握手完成前失败（e.g. connect 抛错）已在 #scheduleReconnectOrReject 里计入下一轮
			});
		}, delay);
		this.#emit({ type: "status", status: "connecting", attempt: this.#reconnectAttempt });
	}

	/** 首次 connect() 同步抛错时的级联：若开启了自动重连，不 reject connect promise，而是排下一轮。 */
	#scheduleReconnectOrReject(error: Error): Promise<void> {
		if (this.#autoReconnect && !this.#closedByUser) {
			this.#scheduleReconnect();
			return Promise.resolve();
		}
		return Promise.reject(error);
	}

	#rejectAllPending(err: Error): void {
		if (this.#pending.size === 0) return;
		const pending = Array.from(this.#pending.values());
		this.#pending.clear();
		for (const p of pending) {
			this.#clock.clearTimeout(p.timer);
			p.reject(err);
		}
	}

	#setStatus(status: PiConnectionStatus): void {
		if (this.#status === status) return;
		this.#status = status;
		this.#emit({ type: "status", status });
	}

	#emit(event: PiClientEventKind): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch {
				// swallow listener errors——一个听众崩不能拖垮其他人
			}
		}
	}
}
