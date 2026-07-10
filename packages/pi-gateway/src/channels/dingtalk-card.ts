/**
 * AI Card streaming for DingTalk.
 *
 * v3 — OpenClaw blockList schema (`675cde2f-f526-40cb-b828-f5b2b57b8b77.schema`).
 * The card body is a structured object with top-level fields:
 *
 *   {
 *     content: <streaming markdown answer, raw>,
 *     blockList: [ { type, text, markdown, mediaId? }, ... ],
 *     quoteContent: <inbound message body>,
 *     statusLine: <model · effort · taskTime · tokens · dapi · agent>,
 *     copy_content: <clipboard text>,
 *     hasAction: false,
 *     version: 1
 *   }
 *
 * Block types follow the OpenClaw convention:
 *   0 = answer  (the main markdown body, type 0 / type 5 for headings)
 *   1 = think   (gray font, level2 token)
 *   2 = tool    (Exec: prefix, gray font)
 *   3 = image   (DingTalk mediaId, caption)
 *
 * Lifecycle: card is created in PROCESSING state, transitions to INPUTING
 * on the first streaming update, blockList is patched incrementally
 * (throttled) and the final flush on `finishAICard` switches to FINISHED
 * with the full blockList + chrome.
 *
 * Operational features:
 * - Global token bucket rate limiter (20 req/s, shared across sessions)
 * - 403 QpsLimit auto-backoff with retry
 * - Markdown formatting fixes for DingTalk rendering
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { DingTalkConfig } from "../types";

// ═══════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════

/**
 * OpenClaw v2 blockList template. Users who need to override the
 * template (e.g. their DingTalk tenant has a different schema) can set
 * `DINGTALK_CARD_TEMPLATE_ID` in the env to point at their own schema.
 */
const DEFAULT_AI_CARD_TEMPLATE_ID = "675cde2f-f526-40cb-b828-f5b2b57b8b77.schema";
const AI_CARD_TEMPLATE_ID = process.env.DINGTALK_CARD_TEMPLATE_ID ?? DEFAULT_AI_CARD_TEMPLATE_ID;

const CARD_API_MAX_QPS = 20;
const QPS_BACKOFF_MS = 2_000;

/**
 * HTTP statuses that should trigger a retry on the FINISHED card update.
 * DingTalk returns 500 + system.busy when overloaded; that path was previously
 * swallowed and left the card stuck in INPUTING (visible as a spinner).
 * 429/408/425 are explicit throttling, 5xx are transient backend issues,
 * 403 covers the QpsLimit case already handled below.
 */
const FINISHED_RETRYABLE_STATUSES = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
const FINISHED_MAX_RETRIES = 3;
const FINISHED_BASE_BACKOFF_MS = 500;

const AICardStatus = {
	PROCESSING: "1",
	INPUTING: "2",
	FINISHED: "3",
	EXECUTING: "4",
	FAILED: "5",
} as const;

const BlockType = {
	ANSWER: 0,
	THINK: 1,
	TOOL: 2,
	IMAGE: 3,
	/** Stop / abort block (type 4). The OpenClaw schema's ButtonGroup
	 * component is bound to `blockList[N].type === 4 && blockList[N].btns`;
	 * blocks of this type render their `btns` array as interactive
	 * controls. Used by the v3 long-task watcher to surface an abort
	 * affordance while a tool is still running. The action callback
	 * URL is configured by the gateway (Phase 2b: HTTP endpoint). */
	STOP: 4,
} as const;

/** Block-type constants exposed for downstream consumers (e.g. the
 * channel's `onLongTask` handler checks `block.type === BlockType.STOP`
 * to update the most recent stop block on a progress ping). */
export { BlockType };

type BlockTypeValue = (typeof BlockType)[keyof typeof BlockType];

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

/** A single entry in `cardData.blockList`. The OpenClaw schema renders
 * each block according to its `type`; `text` / `markdown` are the
 * alternate text representations (one of them is usually empty). */
export interface CardBlock {
	type: BlockTypeValue;
	text: string;
	markdown: string;
	mediaId?: string;
	/** Interactive buttons rendered by the schema's ButtonGroup component.
	 * Only blocks with `type === BlockType.STOP` (4) currently have the
	 * ButtonGroup bound to them; the schema is permissive and other
	 * block types can also carry `btns` if a future schema version
	 * changes the binding. */
	btns?: CardButton[];
}

/** A single interactive button inside a `CardBlock.btns` array. The
 * OpenClaw schema's ButtonGroup renders these as clickable controls.
 * `actionType` mirrors the schema's actionType taxonomy:
 *   - `call_back` — Stream mode: DingTalk delivers the click over the
 *     same authenticated WebSocket the SDK established, on the
 *     /v1.0/card/instances/callback topic (TOPIC_CARD). The body
 *     carries `outTrackId` + `cardPrivateData.params`. No HTTP
 *     callback URL is required.
 *   - `request`   — HTTP mode: DingTalk POSTs the click to a registered
 *     HTTP callback URL. NOT used by the gateway (we don't run an
 *     HTTP server); kept in the type for forward-compat / schema
 *     overrides.
 *   - `url`       — open `url` in a new view
 *   - `copy`      — copy a value to clipboard
 * The gateway currently only emits `call_back` buttons. */
export interface CardButton {
	text: string;
	actionType: "call_back" | "request" | "url" | "copy";
	requestPath?: string;
	params?: Record<string, string>;
	url?: string;
}

/** The full card data body written to `cardData.cardParamMap`. */
export interface CardData {
	/** The streaming answer text (raw, without chrome). */
	content: string;
	/** Structured blocks rendered in the card body. */
	blockList: CardBlock[];
	/** Original triggering message (top of card). */
	quoteContent: string;
	/** Footer status line (model · effort · taskTime · tokens · dapi · agent). */
	statusLine: string;
	/** String copied to clipboard when the user taps "copy". */
	copyContent: string;
	/** Whether the card exposes interactive action buttons. */
	hasAction: boolean;
	/** Schema version. */
	version: 1;
}

export interface AICardInstance {
	cardInstanceId: string;
	accessToken: string;
	tokenExpireTime: number;
	inputingStarted: boolean;
}

export type AICardTarget = { type: "user"; userId: string } | { type: "group"; openConversationId: string };

/** Optional initial chrome written at card creation time (PROCESSING state). */
export interface CreateCardOptions {
	/** Original triggering message (top of card). Empty string for none. */
	quoteContent?: string;
	/** Footer status line. Empty string for none. */
	statusLine?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// Global Token Bucket Rate Limiter
// ═══════════════════════════════════════════════════════════════════════

const cardRateLimiter = {
	tokens: CARD_API_MAX_QPS,
	lastRefillTime: Date.now(),
	backoffUntil: 0,
	_queueTail: Promise.resolve() as Promise<unknown>,

	refill(): void {
		const now = Date.now();
		const elapsedSeconds = (now - this.lastRefillTime) / 1000;
		if (elapsedSeconds > 0) {
			this.tokens = Math.min(CARD_API_MAX_QPS, this.tokens + elapsedSeconds * CARD_API_MAX_QPS);
			this.lastRefillTime = now;
		}
	},

	async waitForToken(): Promise<number> {
		const prev = this._queueTail;
		let release!: () => void;
		this._queueTail = new Promise<void>(resolve => {
			release = resolve;
		});
		try {
			await prev;
		} catch {
			// ignore prior errors
		}
		try {
			let totalWaitMs = 0;

			const now = Date.now();
			if (now < this.backoffUntil) {
				const backoffWaitMs = this.backoffUntil - now;
				await Bun.sleep(backoffWaitMs);
				totalWaitMs += backoffWaitMs;
			}

			this.refill();

			if (this.tokens < 1) {
				const waitMs = Math.ceil(((1 - this.tokens) / CARD_API_MAX_QPS) * 1000);
				await Bun.sleep(waitMs);
				totalWaitMs += waitMs;
				this.refill();
			}

			this.tokens -= 1;
			return totalWaitMs;
		} finally {
			release();
		}
	},

	triggerBackoff(): void {
		const backoffEnd = Date.now() + QPS_BACKOFF_MS;
		this.backoffUntil = backoffEnd;
		this.tokens = 0;
		this.lastRefillTime = backoffEnd;
	},
};

// ═══════════════════════════════════════════════════════════════════════
// QPS Limit Detection
// ═══════════════════════════════════════════════════════════════════════

function isQpsLimitError(err: unknown): boolean {
	const response = (err as any)?.response;
	if (response?.status !== 403) return false;
	return typeof response?.data?.code === "string" && response.data.code.includes("QpsLimit");
}

function isRetryableStatus(status: number): boolean {
	return FINISHED_RETRYABLE_STATUSES.has(status);
}

/**
 * Parse a DingTalk API response body for an error code.
 *
 * DingTalk sometimes returns HTTP 200 with a body like
 * `{"code":"system.busy","message":"system.busy","requestid":"..."}` to
 * signal failure. Callers that only check `resp.ok` will silently treat
 * these as success — which is the exact bug that hid `system.busy` from
 * `patchAICardBlocks` / `streamAICard` / `finishAICard` in the 7-10
 * long-task run (the user saw the bot's streamed text but none of the
 * blockList patches or the tool result rendered, while the log showed
 * 3 `patchAICardBlocks` events with zero error entries).
 *
 * Returns the parsed error details, or null if the body either is not
 * JSON or has no `code` field. The success-path responses observed in
 * the wild (card streaming, card patch, FINISHED switch) return `{}`
 * with no `code` field, so the absence of `code` is treated as success.
 *
 * `code === "ok"` / `code === "0"` are explicitly NOT treated as errors
 * even if a future DingTalk schema adds a code field to success bodies
 * (defensive against the inverse case).
 */
export function parseDingtalkError(body: string): { code: string; message: string; requestid?: string } | null {
	try {
		const json = JSON.parse(body);
		if (
			json &&
			typeof json === "object" &&
			typeof json.code === "string" &&
			json.code !== "ok" &&
			json.code !== "0"
		) {
			return {
				code: json.code,
				message: typeof json.message === "string" ? json.message : "",
				requestid: typeof json.requestid === "string" ? json.requestid : undefined,
			};
		}
	} catch {
		// Body is not JSON — the caller already checked resp.ok, so a
		// non-JSON 200 is treated as success here.
	}
	return null;
}

// ═══════════════════════════════════════════════════════════════════════
// Markdown Formatting
// ═══════════════════════════════════════════════════════════════════════

function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

function ensureTableBlankLines(text: string): string {
	const lines = normalizeLineEndings(text).split("\n");
	const result: string[] = [];

	const tableDividerRegex = /^\s*\|?\s*:?-+:?\s*(\|?\s*:?-+:?\s*)+\|?\s*$/;
	const tableRowRegex = /^\s*\|?.*\|.*\|?\s*$/;

	const isDivider = (line: string) =>
		line && typeof line === "string" && line.includes("|") && tableDividerRegex.test(line);

	for (let i = 0; i < lines.length; i++) {
		const currentLine = lines[i];
		const nextLine = lines[i + 1] ?? "";

		if (
			tableRowRegex.test(currentLine) &&
			isDivider(nextLine) &&
			i > 0 &&
			lines[i - 1].trim() !== "" &&
			!tableRowRegex.test(lines[i - 1])
		) {
			result.push("");
		}

		result.push(currentLine);
	}
	return result.join("\n");
}

export function fixNewlines(text: string): string {
	const normalized = normalizeLineEndings(text);
	const fencePattern = /^\s{0,3}```/;
	const markdownBlockStartPattern =
		/^(\s{0,3}(?:[-*+]|\d+[.)])[ ])|(\s{0,3}\|)|(\s{0,3}#{1,6}\s)|(\s{0,3}(?:[-*_])\s*(?:[-*_])\s*(?:[-*_]))/;
	const quotePattern = /^\s{0,3}>\s?/;

	// 1. Merge consecutive quote lines outside code blocks
	const mergedLines: string[] = [];
	let pendingQuoteLines: string[] = [];
	let inCodeBlock = false;

	const flushPendingQuoteLines = () => {
		if (pendingQuoteLines.length > 0) {
			mergedLines.push(pendingQuoteLines.join("<br>"));
			pendingQuoteLines = [];
		}
	};

	for (const line of normalized.split("\n")) {
		const isFence = fencePattern.test(line);
		if (inCodeBlock) {
			flushPendingQuoteLines();
			mergedLines.push(line);
			if (isFence) inCodeBlock = false;
			continue;
		}
		if (isFence) {
			flushPendingQuoteLines();
			mergedLines.push(line);
			inCodeBlock = true;
			continue;
		}
		if (quotePattern.test(line)) {
			if (pendingQuoteLines.length === 0) {
				pendingQuoteLines.push(line);
			} else {
				pendingQuoteLines.push(line.replace(quotePattern, ""));
			}
		} else {
			flushPendingQuoteLines();
			mergedLines.push(line);
		}
	}
	flushPendingQuoteLines();

	// 2. Process each line: code blocks keep \n, markdown block syntax keeps \n, others -> <br>
	const lines = mergedLines;
	inCodeBlock = false;
	const parts: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const currentLine = lines[i];
		const nextInCodeBlock: boolean = fencePattern.test(currentLine) ? !inCodeBlock : inCodeBlock;

		if (i < lines.length - 1) {
			const nextLine = lines[i + 1];
			const keepNewline =
				nextInCodeBlock ||
				currentLine === "" ||
				nextLine === "" ||
				fencePattern.test(nextLine) ||
				markdownBlockStartPattern.test(nextLine);
			parts.push(currentLine + (keepNewline ? "\n" : "<br>"));
		} else {
			parts.push(currentLine);
		}

		inCodeBlock = nextInCodeBlock;
	}

	return parts.join("");
}

function normalizeForCard(content: string): string {
	return fixNewlines(ensureTableBlankLines(content));
}

// ═══════════════════════════════════════════════════════════════════════
// Block Builders
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build an answer block (type 0). The OpenClaw schema renders the
 * `markdown` field as the main body; `text` is the plain-text fallback.
 */
export function buildAnswerBlock(text: string): CardBlock {
	const normalized = normalizeForCard(text);
	return { type: BlockType.ANSWER, text: text.trim(), markdown: normalized };
}

/**
 * Build a think block (type 1). Wraps the raw thinking in a gray
 * font tag so the schema renders it as a secondary style.
 */
export function buildThinkBlock(thinking: string): CardBlock {
	const trimmed = thinking.trim();
	const wrapped = `> <font sizeToken=common_h5_text_style__font_size colorTokenV2=common_level2_base_color>${trimmed}</font>`;
	return { type: BlockType.THINK, text: trimmed, markdown: wrapped };
}

/**
 * Build a tool block (type 2). The text follows the OpenClaw
 * `Exec: <name>(<args preview>)` convention; the markdown uses the
 * gray font tag.
 */
const TOOL_EMOJIS: Record<string, string> = {
	bash: "⚙️",
	read: "📄",
	edit: "✏️",
	write: "📝",
	search: "🔍",
	find: "📁",
	lsp: "🔗",
	ast_grep: "🔍",
	ast_edit: "✏️",
	grep: "🔍",
	dws: "📚",
	mcp: "🔌",
	web_search: "🌐",
	puppeteer: "🖱️",
	python: "🐍",
	task: "👥",
	debug: "🐛",
	notebook: "📓",
	recipe: "📦",
};

function getToolEmoji(name: string): string {
	// Match prefix for dws subcommands (dws doc search, dws chat send, etc.)
	if (name.startsWith("dws")) return "📚";
	return TOOL_EMOJIS[name] ?? "🔧";
}

export function buildToolBlock(
	call: { name: string; args: unknown },
	_resultText: string,
	isError: boolean,
): CardBlock {
	const argsPreview = formatToolArgs(call.args);
	const emoji = getToolEmoji(call.name);
	const execLabel = isError
		? `${emoji} ${call.name}(${argsPreview}) — error`
		: `${emoji} ${call.name}(${argsPreview})`;
	const wrapped = `> <font sizeToken=common_h5_text_style__font_size colorTokenV2=common_level2_base_color>${execLabel}</font>`;
	logger.info("[DingTalk] buildToolBlock", {
		toolName: call.name,
		emoji,
		isError,
	});
	return { type: BlockType.TOOL, text: `${execLabel}`, markdown: wrapped };
}

/**
 * Build an image block (type 3). Requires an already-uploaded DingTalk
 * mediaId; the channel layer is responsible for `uploadMedia` before
 * the block is appended to `blockList`.
 */
export function buildImageBlock(mediaId: string, caption: string): CardBlock {
	return {
		type: BlockType.IMAGE,
		text: caption,
		markdown: caption ? `# ${caption}` : "",
		mediaId,
	};
}

/**
 * Build a stop / abort block (type 4). The schema's ButtonGroup
 * component is bound to `blockList[N].type === 4 && blockList[N].btns`,
 * so this block renders its `btns` array as interactive controls.
 *
 * The gateway pushes one of these when the long-task watcher detects
 * a tool that has been running longer than `longTaskThresholdMs`. The
 * `requestPath` should be the gateway's action callback URL (set in
 * Phase 2b). Until the HTTP endpoint is wired, the button is visible
 * in the card but clicking it will fail at the DingTalk API level
 * (no callback URL registered) — acceptable for the v1 rollout.
 */
export function buildStopBlock(opts: {
	toolName: string;
	elapsedMs: number;
	/** Kept in the signature for back-compat with any caller that
	 *  passes a requestPath; the stop button always uses
	 *  `actionType: "call_back"` (Stream mode) so the value is
	 *  ignored. Marked optional so existing call sites compile. */
	requestPath?: string;
	sessionId: string;
	buttonText?: string;
}): CardBlock {
	const buttonText = opts.buttonText ?? "停止";
	const elapsedMin = Math.floor(opts.elapsedMs / 60_000);
	const body = `⏳ **${opts.toolName}** 已运行 ${elapsedMin} 分钟。点击下方按钮中止。`;
	return {
		type: BlockType.STOP,
		text: body,
		markdown: body,
		btns: [
			{
				text: buttonText,
				// Stream-mode callback: DingTalk delivers the click over
				// the WebSocket on /v1.0/card/instances/callback. The
				// channel's TOPIC_CARD listener picks it up, parses
				// outTrackId + cardPrivateData.params, and routes to
				// the gateway's ActionRegistry → bridge.abort().
				// Do NOT use `actionType: "request"` here — that mode
				// requires an HTTP callback URL, which the gateway
				// doesn't run.
				actionType: "call_back",
				params: {
					type: "stop",
					sessionId: opts.sessionId,
					toolName: opts.toolName,
				},
			},
		],
	};
}

function formatToolArgs(args: unknown): string {
	if (args == null) return "";
	if (typeof args === "string") return args.length > 60 ? `${args.slice(0, 60)}…` : args;
	try {
		const json = JSON.stringify(args);
		return json.length > 60 ? `${json.slice(0, 60)}…` : json;
	} catch {
		return String(args);
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Token Management
// ═══════════════════════════════════════════════════════════════════════

const DINGTALK_API = "https://api.dingtalk.com";

/**
 * Get DingTalk access token using appKey/appSecret.
 */
export async function getAccessToken(config: DingTalkConfig): Promise<string> {
	const resp = await fetch(`${DINGTALK_API}/v1.0/oauth2/accessToken`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ appKey: config.appKey, appSecret: config.appSecret }),
	});

	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`Failed to get access token: ${resp.status} ${text}`);
	}

	const data = (await resp.json()) as { accessToken: string; expireIn?: number };
	return data.accessToken;
}

async function ensureValidToken(card: AICardInstance, config: DingTalkConfig): Promise<string> {
	if (Date.now() > card.tokenExpireTime - 5 * 60 * 1000) {
		const newToken = await getAccessToken(config);
		card.accessToken = newToken;
		card.tokenExpireTime = Date.now() + 2 * 60 * 60 * 1000;
	}
	return card.accessToken;
}

// ═══════════════════════════════════════════════════════════════════════
// Build Deliver Body
// ═══════════════════════════════════════════════════════════════════════

function buildDeliverBody(cardInstanceId: string, target: AICardTarget, robotCode: string): unknown {
	const base = { outTrackId: cardInstanceId, userIdType: 1 };

	if (target.type === "group") {
		return {
			...base,
			openSpaceId: `dtv1.card//IM_GROUP.${target.openConversationId}`,
			imGroupOpenDeliverModel: { robotCode },
		};
	}

	return {
		...base,
		openSpaceId: `dtv1.card//IM_ROBOT.${target.userId}`,
		imRobotOpenDeliverModel: {
			spaceType: "IM_ROBOT",
			robotCode,
			extension: { dynamicSummary: "true" },
		},
	};
}

// ═══════════════════════════════════════════════════════════════════════
// cardParamMap helpers
// ═══════════════════════════════════════════════════════════════════════

export function cardParamMapFromData(data: Partial<CardData>, flowStatus: string): Record<string, string> {
	return {
		flowStatus,
		content: data.content ?? "",
		blockList: JSON.stringify(data.blockList ?? []),
		quoteContent: data.quoteContent ?? "",
		statusLine: data.statusLine ?? "",
		copy_content: data.copyContent ?? "",
		// Default to true: OpenClaw's 675cde2f schema gates the top
		// stop button (the red "中止" affordance) on `isTrue(hasAction)`.
		// Without this, the user sees only our type-4 block which the
		// schema renders as the fallback text "当前客户端环境不支
		// 持按钮组组件" with no clickable button. Only the explicit
		// `failAICard` path overrides this to hide the stop button
		// when the card has errored.
		hasAction: JSON.stringify(data.hasAction ?? true),
		version: JSON.stringify(data.version ?? 1),
		config: JSON.stringify({ autoLayout: true }),
	};
}

export function cardParamMapForStreamStart(content: string, blockList: CardBlock[]): Record<string, string> {
	return {
		flowStatus: AICardStatus.INPUTING,
		content: normalizeForCard(content),
		blockList: JSON.stringify(blockList),
		quoteContent: "",
		statusLine: "",
		copy_content: "",
		// Keep hasAction: true on transition to INPUTING. OpenClaw's
		// schema's top stop button (the red "中止" affordance) is
		// gated on `isTrue(hasAction)` and only renders when this
		// flag is true. Setting it false here was a bug — it hid
		// the only working stop button the schema offers, leaving
		// users with just our type-4 block which the schema renders
		// as the fallback text "当前客户端环境不支持按钮组组件".
		hasAction: JSON.stringify(true),
		version: JSON.stringify(1),
		config: JSON.stringify({ autoLayout: true }),
	};
}

// ═══════════════════════════════════════════════════════════════════════
// AI Card API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a card instance and deliver it to `target`. The card starts
 * in PROCESSING state with the chrome fields already populated
 * (quoteContent / statusLine show up immediately at the top / bottom
 * of the card body even before any answer text arrives).
 */
export async function createAICardForTarget(
	config: DingTalkConfig,
	target: AICardTarget,
	options: CreateCardOptions = {},
): Promise<AICardInstance | null> {
	const targetDesc = target.type === "group" ? `group ${target.openConversationId}` : `user ${target.userId}`;

	try {
		const token = await getAccessToken(config);
		const cardInstanceId = `card_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

		logger.debug("[AICard] Creating card", { target: targetDesc, cardInstanceId, templateId: AI_CARD_TEMPLATE_ID });

		const initialData: Partial<CardData> = {
			content: "",
			blockList: [],
			quoteContent: options.quoteContent ?? "",
			statusLine: options.statusLine ?? "",
			copyContent: "",
			// OpenClaw's 675cde2f schema gates the top stop button on
			// `hasAction: true` (visibility = isTrue(hasAction) on the
			// header's right column). Setting it false here hides the
			// ONLY actually-clickable stop affordance in this schema —
			// type-4 blocks in `blockList` are rendered as a fallback
			// "当前客户端环境不支持按钮组组件" message with no button.
			// Always expose the stop button so the user can interrupt
			// the agent at any time, not just after the long-task
			// watcher has fired.
			hasAction: true,
			version: 1,
		};

		// 1. Create card instance
		const createBody = {
			cardTemplateId: AI_CARD_TEMPLATE_ID,
			outTrackId: cardInstanceId,
			cardData: { cardParamMap: cardParamMapFromData(initialData, AICardStatus.PROCESSING) },
			callbackType: "STREAM",
			imGroupOpenSpaceModel: { supportForward: true },
			imRobotOpenSpaceModel: { supportForward: true },
		};
		const createResp = await fetch(`${DINGTALK_API}/v1.0/card/instances`, {
			method: "POST",
			headers: {
				"x-acs-dingtalk-access-token": token,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(createBody),
		});

		if (!createResp.ok) {
			const text = await createResp.text();
			logger.error("[AICard] Create instance failed", { status: createResp.status, body: text });
			return null;
		}
		// DingTalk may return HTTP 200 with body {"code":"system.busy",...}
		// to signal failure. Treat as creation failure so the channel
		// falls back to v1 markdown instead of returning a phantom
		// cardInstanceId that every subsequent patch silently no-ops.
		const createBodyText = await createResp.text();
		const createError = parseDingtalkError(createBodyText);
		if (createError) {
			logger.error("[AICard] Create instance failed (HTTP 200 with error body)", {
				code: createError.code,
				message: createError.message,
				requestid: createError.requestid,
			});
			return null;
		}

		// 2. Deliver card to target
		const robotCode = config.robotCode ?? config.appKey;
		const deliverBody = buildDeliverBody(cardInstanceId, target, robotCode);

		const deliverResp = await fetch(`${DINGTALK_API}/v1.0/card/instances/deliver`, {
			method: "POST",
			headers: {
				"x-acs-dingtalk-access-token": token,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(deliverBody),
		});

		if (!deliverResp.ok) {
			const text = await deliverResp.text();
			logger.error("[AICard] Deliver failed", { status: deliverResp.status, body: text });
			return null;
		}
		// Same body-code check on the deliver endpoint — a 200 with
		// `code: "invalid.user"` etc. means the card exists server-side
		// but never reached the user, so the channel must fall back.
		const deliverBodyText = await deliverResp.text();
		const deliverError = parseDingtalkError(deliverBodyText);
		if (deliverError) {
			logger.error("[AICard] Deliver failed (HTTP 200 with error body)", {
				code: deliverError.code,
				message: deliverError.message,
				requestid: deliverError.requestid,
			});
			return null;
		}

		return {
			cardInstanceId,
			accessToken: token,
			tokenExpireTime: Date.now() + 2 * 60 * 60 * 1000,
			inputingStarted: false,
		};
	} catch (err) {
		logger.error("[AICard] Create card failed", { target: targetDesc, error: String(err) });
		return null;
	}
}

/**
 * Stream a content update into the card. Switches the card from
 * PROCESSING to INPUTING on the first call (the `msgContent` -> `content`
 * rename is the schema v2 switch). Subsequent calls just update the
 * `content` field via the streaming endpoint.
 *
 * `blockList` is included in every call so the schema can render new
 * blocks as they appear. The streaming endpoint does not patch
 * blockList — only `content` — so a `blockList` change is a no-op here;
 * the channel must call `patchAICardBlocks` for blockList updates.
 */
export async function streamAICard(
	card: AICardInstance,
	content: string,
	_blockList: CardBlock[] = [],
	config?: DingTalkConfig,
): Promise<void> {
	if (!card) {
		logger.warn("[AICard] streamAICard received null card, skipping");
		return;
	}

	if (config) {
		await ensureValidToken(card, config);
	}

	if (!card.inputingStarted) {
		await cardRateLimiter.waitForToken();

		const statusBody = {
			outTrackId: card.cardInstanceId,
			cardData: { cardParamMap: cardParamMapForStreamStart(content, _blockList) },
		};

		try {
			const resp = await fetch(`${DINGTALK_API}/v1.0/card/instances`, {
				method: "PUT",
				headers: {
					"x-acs-dingtalk-access-token": card.accessToken,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(statusBody),
			});

			if (!resp.ok && resp.status === 403) {
				cardRateLimiter.triggerBackoff();
				await cardRateLimiter.waitForToken();
				const retryResp = await fetch(`${DINGTALK_API}/v1.0/card/instances`, {
					method: "PUT",
					headers: {
						"x-acs-dingtalk-access-token": card.accessToken,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(statusBody),
				});
				if (!retryResp.ok) {
					logger.error("[AICard] INPUTING switch failed after retry", { status: retryResp.status });
				} else {
					// Retry succeeded at HTTP level — still must check the
					// body for an error code (HTTP 200 + {"code":"..."}).
					const retryText = await retryResp.text();
					const retryError = parseDingtalkError(retryText);
					if (retryError) {
						logger.error("[AICard] INPUTING switch failed (HTTP 200 with error body)", {
							code: retryError.code,
							message: retryError.message,
							requestid: retryError.requestid,
						});
					}
				}
			} else if (!resp.ok) {
				const text = await resp.text();
				logger.error("[AICard] INPUTING switch failed", { status: resp.status, body: text });
			} else {
				// HTTP 200 success path — still must check the body. A
				// 200 + {"code":"system.busy"} leaves the card stuck
				// in PROCESSING (no INPUTING transition), which the user
				// sees as a card that never updates. Log and move on;
				// the next streaming delta will retry the transition.
				const text = await resp.text();
				const error = parseDingtalkError(text);
				if (error) {
					logger.error("[AICard] INPUTING switch failed (HTTP 200 with error body)", {
						code: error.code,
						message: error.message,
						requestid: error.requestid,
					});
				}
			}
		} catch (err) {
			logger.error("[AICard] INPUTING switch error", { error: String(err) });
		}

		card.inputingStarted = true;
	}

	const fixedContent = normalizeForCard(content);
	const streamContent = fixedContent.replace(/\n+$/, "");

	const body = {
		outTrackId: card.cardInstanceId,
		guid: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
		key: "content",
		content: streamContent,
		isFull: true,
		isFinalize: false,
		isError: false,
	};

	await cardRateLimiter.waitForToken();

	try {
		const resp = await fetch(`${DINGTALK_API}/v1.0/card/streaming`, {
			method: "PUT",
			headers: {
				"x-acs-dingtalk-access-token": card.accessToken,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});

		if (!resp.ok && resp.status === 403) {
			cardRateLimiter.triggerBackoff();
			await cardRateLimiter.waitForToken();
			body.guid = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
			const retryResp = await fetch(`${DINGTALK_API}/v1.0/card/streaming`, {
				method: "PUT",
				headers: {
					"x-acs-dingtalk-access-token": card.accessToken,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});
			if (!retryResp.ok) {
				logger.error("[AICard] streaming retry failed", { status: retryResp.status });
			} else {
				// Retry succeeded at HTTP level — still must check the
				// body for an error code.
				const retryText = await retryResp.text();
				const retryError = parseDingtalkError(retryText);
				if (retryError) {
					logger.warn("[AICard] streaming update failed (HTTP 200 with error body)", {
						code: retryError.code,
						message: retryError.message,
						requestid: retryError.requestid,
					});
				}
			}
		} else if (!resp.ok) {
			const text = await resp.text();
			logger.warn("[AICard] streaming update failed", { status: resp.status, body: text });
		} else {
			// HTTP 200 success path — still must check the body. The
			// streaming endpoint is throttled (one log per delta), so
			// a silent `system.busy` here would make the user see
			// stale text until the next delta lands.
			const text = await resp.text();
			const error = parseDingtalkError(text);
			if (error) {
				logger.warn("[AICard] streaming update failed (HTTP 200 with error body)", {
					code: error.code,
					message: error.message,
					requestid: error.requestid,
				});
			}
		}
	} catch (err) {
		if (isQpsLimitError(err)) {
			cardRateLimiter.triggerBackoff();
		}
		logger.error("[AICard] streaming error", { error: String(err) });
	}
}

/**
 * Patch the card's `blockList` (and any other cardData field) while
 * the card is still in INPUTING state. Use this for incremental block
 * pushes (think / tool / image) before the final flush.
 */
export async function patchAICardBlocks(
	card: AICardInstance,
	data: Partial<CardData>,
	config?: DingTalkConfig,
): Promise<void> {
	if (!card) return;
	if (config) {
		await ensureValidToken(card, config);
	}

	const body = {
		outTrackId: card.cardInstanceId,
		cardData: { cardParamMap: cardParamMapFromData(data, AICardStatus.INPUTING) },
		cardUpdateOptions: { updateCardDataByKey: true },
	};

	await cardRateLimiter.waitForToken();

	try {
		const resp = await fetch(`${DINGTALK_API}/v1.0/card/instances`, {
			method: "PUT",
			headers: {
				"x-acs-dingtalk-access-token": card.accessToken,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});

		if (!resp.ok && resp.status === 403) {
			cardRateLimiter.triggerBackoff();
			await cardRateLimiter.waitForToken();
			const retryResp = await fetch(`${DINGTALK_API}/v1.0/card/instances`, {
				method: "PUT",
				headers: {
					"x-acs-dingtalk-access-token": card.accessToken,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});
			if (!retryResp.ok) {
				logger.error("[AICard] block patch retry failed", { status: retryResp.status });
			} else {
				// Retry succeeded at HTTP level — still must check the
				// body for an error code.
				const retryText = await retryResp.text();
				const retryError = parseDingtalkError(retryText);
				if (retryError) {
					logger.warn("[AICard] block patch failed (HTTP 200 with error body)", {
						code: retryError.code,
						message: retryError.message,
						requestid: retryError.requestid,
					});
				}
			}
		} else if (!resp.ok) {
			const text = await resp.text();
			logger.warn("[AICard] block patch failed", { status: resp.status, body: text });
		} else {
			// HTTP 200 success path — still must check the body. The
			// 7-10 long-task run hit this exact case: 3 patchAICardBlocks
			// calls all returned HTTP 200 with `{"code":"system.busy",...}`
			// and were silently dropped, so the user saw the streamed
			// text but no blockList updates (no ping, no tool result).
			const text = await resp.text();
			const error = parseDingtalkError(text);
			if (error) {
				logger.warn("[AICard] block patch failed (HTTP 200 with error body)", {
					code: error.code,
					message: error.message,
					requestid: error.requestid,
				});
			}
		}
	} catch (err) {
		if (isQpsLimitError(err)) {
			cardRateLimiter.triggerBackoff();
		}
		logger.error("[AICard] block patch error", { error: String(err) });
	}
}

/**
 * Flush the final content + blockList + chrome to the card and switch
 * to FINISHED state. Called once on `agent_end`.
 *
 * Throws on permanent failure so the bridge can fall back to v1 markdown
 * (otherwise the card gets stuck in INPUTING and the user sees a spinner
 * after a 5xx / system.busy from DingTalk).
 */
export async function finishAICard(card: AICardInstance, data: CardData, config?: DingTalkConfig): Promise<void> {
	if (!card) return;

	if (config) {
		await ensureValidToken(card, config);
	}

	// First make sure the streaming endpoint has the final content
	// (in case the last text_delta was already flushed but the
	// finishAICard arrived before the next throttle tick).
	const fixedContent = normalizeForCard(data.content);
	await streamAICard(card, fixedContent, data.blockList, config);

	const body = {
		outTrackId: card.cardInstanceId,
		cardData: { cardParamMap: cardParamMapFromData({ ...data, content: fixedContent }, AICardStatus.FINISHED) },
		cardUpdateOptions: { updateCardDataByKey: true },
	};

	let lastStatus: number | undefined;
	let lastBody: string | undefined;

	for (let attempt = 0; attempt < FINISHED_MAX_RETRIES; attempt++) {
		await cardRateLimiter.waitForToken();
		try {
			const resp = await fetch(`${DINGTALK_API}/v1.0/card/instances`, {
				method: "PUT",
				headers: {
					"x-acs-dingtalk-access-token": card.accessToken,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});

			if (resp.ok) {
				// HTTP 200 — but DingTalk may still return a body with
				// `code: "system.busy"` etc. to signal a logical failure.
				// Without this check the bridge would skip the v1-markdown
				// fallback and leave the card stuck in INPUTING (visible
				// as a spinner). Treat body-code errors as transient
				// (same class as a 5xx) and let the retry loop run.
				const text = await resp.text();
				const error = parseDingtalkError(text);
				if (error) {
					lastStatus = 200;
					lastBody = text;
					const backoffMs = FINISHED_BASE_BACKOFF_MS * 2 ** attempt;
					logger.warn("[AICard] FINISHED retryable body-code error, retrying", {
						status: 200,
						code: error.code,
						message: error.message,
						requestid: error.requestid,
						attempt: attempt + 1,
						maxRetries: FINISHED_MAX_RETRIES,
						backoffMs,
					});
					cardRateLimiter.triggerBackoff();
					if (attempt < FINISHED_MAX_RETRIES - 1) {
						await Bun.sleep(backoffMs);
					}
					continue;
				}
				return;
			} else {
				lastStatus = resp.status;
				lastBody = await resp.text();

				if (!isRetryableStatus(resp.status)) {
					// Non-retryable (4xx business error) — abort immediately so
					// the bridge can decide whether to fall back to v1 markdown.
					logger.error("[AICard] FINISHED non-retryable failure", {
						status: resp.status,
						body: lastBody,
					});
					throw new Error(`FINISHED non-retryable failure: status=${resp.status} body=${lastBody}`);
				}

				// Retryable: trigger backoff and try again with exponential delay.
				cardRateLimiter.triggerBackoff();
				const backoffMs = FINISHED_BASE_BACKOFF_MS * 2 ** attempt; // 500, 1000, 2000
				logger.warn("[AICard] FINISHED retryable failure, retrying", {
					status: resp.status,
					attempt: attempt + 1,
					maxRetries: FINISHED_MAX_RETRIES,
					backoffMs,
					body: lastBody,
				});
				if (attempt < FINISHED_MAX_RETRIES - 1) {
					await Bun.sleep(backoffMs);
				}
			}
		} catch (err) {
			// Network errors and our own thrown non-retryable error propagate
			// so the bridge fallback path can run.
			if (err instanceof Error && err.message.startsWith("FINISHED non-retryable failure")) {
				throw err;
			}
			// Treat unknown network errors as retryable up to the cap.
			if (attempt < FINISHED_MAX_RETRIES - 1) {
				const backoffMs = FINISHED_BASE_BACKOFF_MS * 2 ** attempt;
				logger.warn("[AICard] FINISHED network error, retrying", {
					attempt: attempt + 1,
					maxRetries: FINISHED_MAX_RETRIES,
					backoffMs,
					error: String(err),
				});
				cardRateLimiter.triggerBackoff();
				await Bun.sleep(backoffMs);
				continue;
			}
			throw err;
		}
	}

	// Exhausted all retries — surface the last status so the bridge can fall back.
	const msg = `FINISHED update failed after ${FINISHED_MAX_RETRIES} retries: status=${lastStatus} body=${lastBody}`;
	logger.error("[AICard] " + msg);
	throw new Error(msg);
}

export async function failAICard(card: AICardInstance, content: string, config?: DingTalkConfig): Promise<void> {
	if (!card) return;

	if (config) {
		await ensureValidToken(card, config);
	}

	const fixedContent = normalizeForCard(content);

	const body = {
		outTrackId: card.cardInstanceId,
		cardData: {
			cardParamMap: {
				flowStatus: AICardStatus.FAILED,
				cardErrorMessage: fixedContent,
				content: "",
				blockList: JSON.stringify([]),
				quoteContent: "",
				statusLine: "",
				copy_content: "",
				hasAction: JSON.stringify(false),
				version: JSON.stringify(1),
				config: JSON.stringify({ autoLayout: true }),
			},
		},
		cardUpdateOptions: { updateCardDataByKey: true },
	};

	await cardRateLimiter.waitForToken();

	try {
		await fetch(`${DINGTALK_API}/v1.0/card/instances`, {
			method: "PUT",
			headers: {
				"x-acs-dingtalk-access-token": card.accessToken,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
	} catch (err) {
		logger.error("[AICard] FAILED update error", { error: String(err) });
	}
}
