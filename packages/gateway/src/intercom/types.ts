export const EXTENSION_BUS_FEATURE = "extension-bus-v1";

export interface SessionInfo {
	id: string;
	name?: string;
	/** True only when the extension synthesized name for an unnamed runtime. */
	runtimeFallbackAlias?: boolean;
	cwd: string;
	model: string;
	pid: number;
	startedAt: number;
	lastActivity: number;
	status?: string;
	peerUid?: number;
	trustedLocal?: boolean;
	/** Live context-window usage, pushed via presence from the source session's
	 *  getContextUsage(). contextPct is 0..100 (rounded); contextTokens /
	 *  contextWindow are raw token counts. All optional: unknown right after a
	 *  compaction (before the next assistant response), when no model is selected,
	 *  or on older clients that never report it. */
	contextPct?: number;
	contextTokens?: number;
	contextWindow?: number;
	/** Parent session target declared at registration — the orchestrator that
	 *  spawned this session. Holds the parent's session id, stable id, or name as
	 *  supplied by the child (typically via PI_SUBAGENT_ORCHESTRATOR_* env vars).
	 *  Parents match children by their own id/name. Optional: peer sessions have
	 *  no parent. */
	parentId?: string;
}

export interface Message {
	id: string;
	timestamp: number;
	senderSequence?: number;
	brokerReceivedAt?: number;
	brokerDeliveredAt?: number;
	receiverReceivedAt?: number;
	injectedAt?: number;
	supersedes?: string;
	retryOf?: string;
	replyTo?: string;
	expectsReply?: boolean;
	content: {
		text: string;
		attachments?: Attachment[];
	};
}

export interface Attachment {
	type: "file" | "snippet" | "context";
	name: string;
	content: string;
	language?: string;
	/** Absolute path of a file the receiver should read for full content (long payloads).
	 *  When set, content holds only a one-line summary — see the Large Payload
	 *  convention in the pi-intercom skill. */
	path?: string;
}

export interface HistoryEntry {
	from: { id: string; name?: string; cwd: string; runtimeFallbackAlias?: boolean };
	to: { id: string; name?: string; cwd: string; runtimeFallbackAlias?: boolean };
	message: Message;
	at: number;
	queued: boolean;
}

export type MessageReceiptStatus =
	| "receiver_received"
	| "queued"
	| "injected"
	| "acknowledged"
	| "expired"
	| "cancelled"
	| "superseded"
	| "cancellation_requested";

export interface MessageReceipt {
	messageId: string;
	status: MessageReceiptStatus;
	timestamp: number;
	detail?: string;
}

export type MessageControlAction = "cancel" | "supersede";

export interface MessageControl {
	messageId: string;
	action: MessageControlAction;
	timestamp: number;
	supersededBy?: string;
	detail?: string;
}

export interface ExtensionCapability {
	namespace: string;
	ownerEligible: boolean;
}

export type SessionRegistration = Omit<SessionInfo, "id" | "peerUid" | "trustedLocal"> & {
	extensions?: ExtensionCapability[];
};

export type ClientMessage =
	| { type: "register"; session: SessionRegistration; sessionId?: string; stateId?: string }
	| { type: "unregister" }
	| { type: "extension_capabilities_update"; extensions: ExtensionCapability[] }
	| { type: "list"; requestId: string }
	| { type: "send"; to: string; message: Message }
	| { type: "message_receipt"; receipt: MessageReceipt }
	| { type: "cancel_message"; messageId: string }
	| { type: "cancel_ask"; messageId: string }
	| {
			type: "presence";
			name?: string;
			runtimeFallbackAlias?: boolean;
			status?: string;
			model?: string;
			contextPct?: number | null;
			contextTokens?: number | null;
			contextWindow?: number | null;
	  }
	| {
			type: "history";
			requestId: string;
			limit?: number;
			since?: number;
			direction?: "in" | "out" | "both";
	  }
	| {
			type: "extension_publish";
			namespace: string;
			audience: "owner" | "capable";
			ownerEpoch?: string;
			ownerOnly?: boolean;
			payload: unknown;
	  }
	| {
			type: "extension_state_commit";
			namespace: string;
			ownerEpoch: string;
			expectedRevision: number;
			payload: unknown;
	  };

export type BrokerMessage =
	| { type: "registered"; sessionId: string; features?: string[] }
	| { type: "sessions"; requestId: string; sessions: SessionInfo[] }
	| { type: "message"; from: SessionInfo; message: Message }
	| { type: "presence_update"; session: SessionInfo }
	| { type: "session_joined"; session: SessionInfo }
	| { type: "session_left"; sessionId: string }
	| { type: "error"; error: string }
	| { type: "delivered"; messageId: string }
	| { type: "delivery_failed"; messageId: string; reason: string }
	| { type: "message_receipt"; from: SessionInfo; receipt: MessageReceipt }
	| { type: "message_control"; from: SessionInfo; control: MessageControl }
	| { type: "history"; requestId: string; entries: HistoryEntry[] }
	| { type: "extension_owner"; namespace: string; ownerId?: string; ownerEpoch?: string }
	| {
			type: "extension_message";
			namespace: string;
			fromSessionId: string;
			ownerId?: string;
			ownerEpoch?: string;
			payload: unknown;
	  }
	| {
			type: "extension_state";
			namespace: string;
			revision: number;
			payload: unknown;
	  }
	| {
			type: "extension_state_result";
			namespace: string;
			committed: boolean;
			revision: number;
			reason?: string;
	  };
