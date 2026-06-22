/**
 * Core types for the IM Gateway.
 *
 * The gateway sits between messaging platforms (DingTalk, Feishu, WeChat)
 * and the OMP agent, routing messages bidirectionally.
 */

// ═══════════════════════════════════════════════════════════════════════
// Message Types
// ═══════════════════════════════════════════════════════════════════════

export type MessageContent =
	| { type: "text"; text: string }
	| { type: "markdown"; markdown: string }
	| { type: "image"; url: string; filename?: string }
	| { type: "file"; url: string; filename: string; size?: number }
	| { type: "voice"; url: string; duration?: number; text?: string }
	| { type: "video"; url: string; filename: string; size?: number; duration?: number; videoType?: string };

export interface InboundMessage {
	channelId: string;
	userId: string;
	userName?: string;
	conversationId: string;
	conversationTitle?: string;
	isGroup: boolean;
	content: MessageContent;
	timestamp: Date;
	raw?: unknown;
	/** Webhook URL from DingTalk for reply — set by DingTalk channel */
	sessionWebhook?: string;
	messageId?: string;
	/** Account identifier for multi-account channel routing */
	accountId?: string;
}

export interface OutboundMessage {
	channelId: string;
	conversationId: string;
	content: MessageContent;
	replyTo?: string;
	mentions?: string[];
	/** If set, update an existing message instead of creating new one */
	messageId?: string;
	/** Webhook URL for DingTalk reply via sessionWebhook HTTP POST */
	sessionWebhook?: string;
	/** Account identifier for account-specific outbound routing */
	accountId?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// Channel Interface
// ═══════════════════════════════════════════════════════════════════════

export interface ChannelCapabilities {
	inbound: boolean;
	outbound: boolean;
	richContent: boolean;
	groups: boolean;
	mentions: boolean;
	voice: boolean;
}

export interface ChannelConfig {
	enabled: boolean;
	allowedUsers?: string[];
	allowedGroups?: string[];
	[key: string]: unknown;
}

export interface Channel {
	readonly id: string;
	readonly name: string;
	readonly capabilities: ChannelCapabilities;

	connect(config: ChannelConfig): Promise<void>;
	disconnect(): Promise<void>;
	isConnected(): boolean;
	/**
	 * Optional deep health snapshot for diagnostics (`gateway doctor`).
	 * Channels that track richer connection metrics expose them here;
	 * channels that only know connected/disconnected may omit this.
	 */
	getHealth?(): ChannelHealth;

	onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
	sendMessage(msg: OutboundMessage): Promise<void>;
	/**
	 * Optional: build a channel-specific reply from agent metadata.
	 * Returning null falls back to a plain text message built by the gateway.
	 * Channels that want richer visuals (status line, quote content, tool
	 * summary, AI cards) implement this; channels that just want the raw
	 * agent text omit it.
	 */
	formatReply?(
		meta: AgentResponseMeta,
		inbound: InboundMessage,
		context: ReplyFormatterContext,
	): OutboundMessage | null;
	/**
	 * Optional: stream the agent response into a platform-native card with
	 * an animated PROCESSING → INPUTING → FINISHED state machine. The card
	 * replaces the "thinking..." placeholder: the user sees a card with
	 * PROCESSING state immediately, content streams in via
	 * `onTextDelta` → INPUTING with throttled updates, and the run finishes
	 * with FINISHED on `agent_end`. Returns null when the platform
	 * doesn't support cards or card creation failed — the gateway falls
	 * back to `formatReply` (or plain text) in that case.
	 *
	 * `submit` is a thin wrapper around `SessionManager.enqueueWithMeta`
	 * pre-bound to this conversation; pass `handlers` to subscribe to
	 * streaming events (text / thinking deltas) while the prompt runs.
	 * The full `AgentResponseMeta` is returned by `submit` so the card
	 * can render the final formatted chrome (status line, tool summary,
	 * etc.) at FINISHED time.
	 */
	streamCard?(
		inbound: InboundMessage,
		session: import("./types").SessionRecord,
		context: ReplyFormatterContext,
		submit: (
			handlers?: import("./types").ForwardStreamHandlers,
		) => Promise<AgentResponseMeta | null>,
	): Promise<OutboundMessage | null>;
}

/**
 * Context passed to a channel's `formatReply`. Captures the per-account
 * display details that don't live on the `AgentResponseMeta` itself.
 */
export interface ReplyFormatterContext {
	/** Account id for the inbound message (used as a fallback "agent" label). */
	accountId: string;
	/** Per-account agent name (preferred over accountId for the "agent" field). */
	agentName: string | null;
	/**
	 * Count of platform API calls made during this turn (status line "dapi" field).
	 * Channels that don't track this can pass 0; the formatter still renders
	 * a placeholder.
	 */
	dapiCalls: number;
}

// ═════════════════════════════════════════════════════════════════════════
// Agent Response Metadata
// ═════════════════════════════════════════════════════════════════════════

/**
 * Structured metadata about an agent run, produced by `AgentBridge.forwardWithMeta`.
 * Used by channel `formatReply` implementations to render richer replies than
 * a single text blob — status lines, tool summaries, quote content, etc.
 *
 * Every field is best-effort: the bridge populates whatever the agent actually
 * emitted. `null` / empty arrays mean "agent did not report this field", not
 * "the run failed".
 */
export interface AgentResponseMeta {
	/** Cleaned, length-capped markdown text (think blocks stripped). */
	text: string;
	/** Raw assistant text after think strip, before length cap. */
	rawText: string;
	/** Model id (e.g. "claude-sonnet-4-5") — null if not reported. */
	model: string | null;
	/** Provider name (e.g. "anthropic") — null if not reported. */
	provider: string | null;
	/** Token usage breakdown — null if not reported. */
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	} | null;
	/** Agent's reported request duration in ms (model-side). */
	agentDurationMs: number | null;
	/** Gateway-measured end-to-end duration in ms (queue + RPC + cleanup). */
	taskDurationMs: number;
	/** Reasoning effort string (e.g. "low" / "medium" / "high"). */
	effort: string | null;
	/** Tool calls in invocation order. */
	toolCalls: ReadonlyArray<AgentResponseToolCall>;
	/** Tool results in arrival order. */
	toolResults: ReadonlyArray<AgentResponseToolResult>;
	/** Error message if the run failed / fell back to a canned string. */
	error: string | null;
	/** True if the user aborted the run (`/stop`, esc, etc). */
	aborted: boolean;
	/**
	 * True when `text` is a bridge-generated fallback ("系统繁忙", "系统正在恢复中", …)
	 * rather than a real agent response. Callers should suppress status-line chrome
	 * for fallback strings so error messages stay readable.
	 */
	isFallback: boolean;
}

export interface AgentResponseToolCall {
	id: string;
	name: string;
	args: unknown;
}

export interface AgentResponseToolResult {
	id: string;
	name: string;
	isError: boolean;
}

/**
 * Streaming callbacks fired by `AgentBridge.forwardWithMeta` as RPC events
 * arrive during a prompt run. Re-exported here so the `Channel` interface
 * (and any platform channel implementation) can type its `streamCard`
 * parameter without importing from `@oh-my-pi/pi-agent-bridge` directly.
 *
 * See `packages/pi-gateway/src/agent-bridge.ts` for the authoritative
 * definition.
 */
export type ForwardStreamHandlers = import("./agent-bridge").ForwardStreamHandlers;

/** Deep connection health for a single channel instance. */
export interface ChannelHealth {
	connected: boolean;
	/** True if the initial connect() threw and was never recovered. */
	connectionFailed: boolean;
	/** WebSocket readyState (0=CONNECTING,1=OPEN,2=CLOSING,3=CLOSED), if applicable. */
	socketReadyState?: number;
	/** Number of reconnect attempts since the last successful connection. */
	reconnectAttempts: number;
	/** Epoch ms when the current connection was established (0 if never). */
	connectionEstablishedAt: number;
	/** Epoch ms of the last socket-available signal (pong/data), 0 if never. */
	lastSocketAvailableAt: number;
	/** Total inbound messages received from the platform. */
	receivedCount: number;
	/**
	 * Inbound messages that reached a terminal non-error state: either
	 * deduplicated (duplicate delivery) or fully handled. The gap
	 * `receivedCount - processedCount` is the drop count (parse failures,
	 * empty/unsupported payloads).
	 */
	processedCount: number;
}

// ═══════════════════════════════════════════════════════════════════════
// Session Types
// ═══════════════════════════════════════════════════════════════════════

export interface SessionRecord {
	id: string;
	channelId: string;
	accountId: string;
	userId: string;
	conversationId: string;
	createdAt: number;
	updatedAt: number;
	lastMessageId?: string;
	ompSessionPath?: string;
	sessionWebhook?: string;
	status: "active" | "idle" | "closed";
}

export interface SessionStore {
	getSession(channelId: string, accountId: string, conversationId: string): Promise<SessionRecord | null>;
	createSession(session: Omit<SessionRecord, "id">): Promise<SessionRecord>;
	updateSession(id: string, updates: Partial<SessionRecord>): Promise<void>;
	closeSession(id: string): Promise<void>;
	getActiveSessions(channelId?: string): Promise<SessionRecord[]>;
}

// ═══════════════════════════════════════════════════════════════════════
// Gateway Config
// ═══════════════════════════════════════════════════════════════════════

export interface AgentConfig {
	ompPath?: string;
	model?: string;
	/** Timeout per agent prompt in ms (default: 300000) */
	timeoutMs?: number;
	maxConcurrentSessions?: number;
	maxCrashRetries?: number;
	crashBackoffMs?: number;
}
export interface SessionConfig {
	idleTimeoutMinutes?: number;
	resetPolicy?: "none" | "daily" | "idle";
	dailyResetHour?: number;
}

export interface HeartbeatConfig {
	enabled?: boolean;
	every?: string;
	prompt?: string;
	deliver?: string;
}

export interface CronConfig {
	enabled?: boolean;
	tickIntervalMs?: number;
	maxConcurrentRuns?: number;
	heartbeat?: HeartbeatConfig;
}

export interface GatewayConfig {
	channels: Record<string, ChannelConfig>;
	agent?: AgentConfig;
	session?: SessionConfig;
	cron?: CronConfig;
	dataDir?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// DingTalk Specific
// ═══════════════════════════════════════════════════════════════════════

export type PermissionPolicy = "open" | "allowlist" | "closed";

/**
 * Per-account DingTalk configuration for multi-agent setups.
 * Each account represents one DingTalk robot with its own credentials.
 */
export interface DingtalkAccountConfig {
	appKey: string;
	appSecret: string;
	robotCode?: string;
	/** Optional agent workspace directory for this specific account */
	agentDir?: string;
	/** Optional model override for this account */
	model?: string;
	/** Optional per-account timeout in ms (overrides agent.timeoutMs) */
	timeoutMs?: number;
}

export interface DingTalkConfig extends ChannelConfig {
	appKey?: string;
	appSecret?: string;
	robotCode?: string;
	/** Multi-agent support: named map of accounts for multiple robots */
	accounts?: Record<string, DingtalkAccountConfig>;
	/** DM permission policy: open | allowlist | closed */
	dmPolicy?: PermissionPolicy;
	/** Group permission policy: open | allowlist | closed */
	groupPolicy?: PermissionPolicy;
}

export interface DingTalkRawMessage {
	conversationId: string;
	atUsers: Array<{ dingtalkId: string; staffId?: string }>;
	chatbotCorpId: string;
	chatbotUserId: string;
	msgId: string;
	senderNick: string;
	isAdmin: boolean;
	senderStaffId: string;
	sessionWebhookExpiredTime: number;
	createAt: number;
	senderCorpId: string;
	conversationType: "1" | "2";
	senderId: string;
	conversationTitle: string;
	isInAtList: boolean;
	sessionWebhook: string;
	text?: { content: string };
	content?: string;
	msgtype: string;
	robotCode: string;
}
