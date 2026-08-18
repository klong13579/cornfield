/**
 * pi-client error taxonomy.
 *
 * 区分 disconnect / timeout / server-error / handshake-error 四类，方便 UI 层针对性处理（重试 vs 报错 vs 开新会话）。
 */

/** 基类：所有 pi-client 抛出的错误都继承自此，方便 `err instanceof PiClientError` 统一拦截。 */
import type { WireErrorCode, WireErrorPayload } from "@oh-my-pi/pi-wire";

export class PiClientError extends Error {
	constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

/** 断线（未连上 / 在途中 WS 关闭）时，所有在途请求立即拒。fail fast 语义：绝不盲重试。 */
export class PiDisconnectedError extends PiClientError {
	constructor(message = "WebSocket disconnected before response arrived") {
		super(message);
	}
}

/** 请求超过 requestTimeoutMs 仍未回包。 */
export class PiRequestTimeoutError extends PiClientError {
	readonly timeoutMs: number;
	readonly command: string;
	constructor(command: string, timeoutMs: number) {
		super(`Request "${command}" timed out after ${timeoutMs}ms`);
		this.command = command;
		this.timeoutMs = timeoutMs;
	}
}

/** 服务端回 {ok:false, error}。保留 error 的原始文本。 */
export class PiServerError extends PiClientError {
	readonly command: string;
	/** 原始错误（协议批 B-4：string 或 { code, message }）。 */
	readonly serverError: string | WireErrorPayload;
	/** 结构化错误码（string 错误时为 undefined）。 */
	readonly code?: WireErrorCode;
	constructor(command: string, serverError: string | WireErrorPayload) {
		const detail = typeof serverError === "string" ? serverError : `[${serverError.code}] ${serverError.message}`;
		super(`Server rejected "${command}": ${detail}`);
		this.command = command;
		this.serverError = serverError;
		if (typeof serverError !== "string") {
			this.code = serverError.code;
		}
	}
}

/** hello 握手失败（版本不匹配/token 不对）。不重试——环境不对。 */
export class PiHandshakeError extends PiClientError {
	readonly serverError: string;
	constructor(serverError: string) {
		super(`Handshake failed: ${serverError}`);
		this.serverError = serverError;
	}
}
