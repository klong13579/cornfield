/**
 * Controller session wrapper over the repo's IntercomClient.
 *
 * Registers the stress program as a broker session (the "referee"/"driver"),
 * maintains a live roster, forwards broker events to a handler, and provides
 * an ask() primitive that resolves on the matching reply message.
 */

import { IntercomClient } from "../../../../packages/coding-agent/src/intercom-extension/broker/client";
import type {
	Message,
	MessageControl,
	MessageReceipt,
	SessionInfo,
	SessionRegistration,
} from "../../../../packages/coding-agent/src/intercom-extension/types";

export interface BrokerEventMap {
	message: { from: SessionInfo; message: Message };
	presence: SessionInfo;
	joined: SessionInfo;
	left: { sessionId: string };
	receipt: { from: SessionInfo; receipt: MessageReceipt };
	control: { from: SessionInfo; control: MessageControl };
	error: string;
	disconnected: Error;
}

export type BrokerEventHandler = (event: { type: keyof BrokerEventMap } & BrokerEventMap) => void;

export interface AskResult {
	askId: string;
	reply: Message;
	from: SessionInfo;
	rttMs: number;
}

export type AskRecord =
	| { kind: "ask_sent"; askId: string; to: string }
	| { kind: "ask_delivered"; askId: string; ok: boolean; reason?: string };

export type AskRecordHandler = (record: AskRecord) => void;

export class BrokerSession {
	readonly client = new IntercomClient();
	sessionId: string | null = null;
	readonly roster = new Map<string, SessionInfo>();

	private pendingAsks = new Map<string, { resolve: (r: AskResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	private handler: BrokerEventHandler | null = null;
	private detached = false;
	private attached = false;

	constructor(
		readonly registration: SessionRegistration,
		private readonly onEvent?: BrokerEventHandler,
		private readonly onAskRecord?: AskRecordHandler,
	) {}

	async connect(): Promise<void> {
		await this.client.connect(this.registration);
		this.sessionId = this.client.sessionId;
		this.attach();
		const roster = await this.client.listSessions({ timeoutMs: 5000 });
		for (const session of roster) this.roster.set(session.id, session);
	}

	private attach(): void {
		if (this.attached) return;
		this.attached = true;
		this.client.on("message", (from: SessionInfo, message: Message) => {
			if (message.replyTo) {
				this.resolveAsk(message.replyTo, { askId: message.replyTo, reply: message, from, rttMs: Date.now() - message.timestamp });
			}
			this.dispatch({ type: "message", from, message });
		});
		this.client.on("presence_update", (session: SessionInfo) => {
			this.roster.set(session.id, session);
			this.dispatch({ type: "presence", ...session });
		});
		this.client.on("session_joined", (session: SessionInfo) => {
			this.roster.set(session.id, session);
			this.dispatch({ type: "joined", ...session });
		});
		this.client.on("session_left", (sessionId: string) => {
			this.roster.delete(sessionId);
			this.dispatch({ type: "left", sessionId });
		});
		this.client.on("message_receipt", (from: SessionInfo, receipt: MessageReceipt) => {
			this.dispatch({ type: "receipt", from, receipt });
		});
		this.client.on("message_control", (from: SessionInfo, control: MessageControl) => {
			this.dispatch({ type: "control", from, control });
		});
		this.client.on("error", (error: Error) => {
			this.dispatch({ type: "error", error: error.message });
		});
		this.client.on("disconnected", (error: Error) => {
			this.dispatch({ type: "disconnected", error });
		});
	}

	private dispatch(event: { type: keyof BrokerEventMap } & BrokerEventMap): void {
		if (!this.detached) this.onEvent?.(event);
	}

	private resolveAsk(askId: string, result: AskResult): void {
		const pending = this.pendingAsks.get(askId);
		if (!pending) return;
		this.pendingAsks.delete(askId);
		clearTimeout(pending.timer);
		pending.resolve(result);
	}

	private rejectAsk(askId: string, error: Error): void {
		const pending = this.pendingAsks.get(askId);
		if (!pending) return;
		this.pendingAsks.delete(askId);
		clearTimeout(pending.timer);
		pending.reject(error);
	}

	/**
	 * Send a blocking ask to a session and wait for the matching reply.
	 * Resolves on the broker's delivered ack + the reply message matching
	 * replyTo === askId. Times out and sends cancelAsk otherwise.
	 */
	async ask(to: string, text: string, options: { timeoutMs?: number } = {}): Promise<AskResult> {
		const timeoutMs = options.timeoutMs ?? 120_000;
		const askId = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			// Register the pending ask BEFORE sending so an instant reply can never
			// race past the registration window.
			const timer = setTimeout(() => {
				this.pendingAsks.delete(askId);
				this.client.cancelAsk(askId);
				reject(new Error(`ask timeout after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pendingAsks.set(askId, { resolve, reject, timer });
			this.onAskRecord?.({ kind: "ask_sent", askId, to });
			this.client
				.send(to, { text, expectsReply: true, messageId: askId })
				.then(sent => {
					this.onAskRecord?.({ kind: "ask_delivered", askId, ok: sent.delivered, reason: sent.delivered ? undefined : sent.reason });
					if (!sent.delivered) {
						clearTimeout(timer);
						this.pendingAsks.delete(askId);
						reject(new Error(`delivery failed: ${sent.reason ?? "unknown reason"}`));
					}
				})
				.catch(error => {
					clearTimeout(timer);
					this.pendingAsks.delete(askId);
					reject(error instanceof Error ? error : new Error(String(error)));
				});
		});
	}

	/** Fire-and-forget informational send (no reply expected). */
	async notify(to: string, text: string): Promise<void> {
		await this.client.send(to, { text, expectsReply: false });
	}

	updatePresence(status: string, extra?: { model?: string; contextPct?: number | null; contextTokens?: number | null; contextWindow?: number | null }): void {
		this.client.updatePresence({ status, ...extra });
	}

	/**
	 * Drop the connection and re-register. Pending asks are rejected by the
	 * client's disconnect; brokers route subsequent messages to the new
	 * session id. Used by --drop-connection-at to test reconnect behavior.
	 */
	async dropAndReconnect(): Promise<void> {
		this.detached = false;
		await this.client.disconnect();
		this.sessionId = null;
		this.roster.clear();
		await this.client.connect(this.registration);
		this.sessionId = this.client.sessionId;
		const roster = await this.client.listSessions({ timeoutMs: 5000 });
		for (const session of roster) this.roster.set(session.id, session);
	}

	async disconnect(): Promise<void> {
		this.detached = true;
		for (const [askId, pending] of this.pendingAsks) {
			clearTimeout(pending.timer);
			pending.reject(new Error("controller disconnected"));
		}
		this.pendingAsks.clear();
		await this.client.disconnect();
	}
}