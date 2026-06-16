/**
 * AI Card streaming for DingTalk.
 *
 * Supports creating AI Cards, streaming incremental content updates,
 * and finalizing with status transitions: PROCESSING -> INPUTING (token streaming) -> FINISHED/FAILED.
 *
 * Features:
 * - Global token bucket rate limiter (20 req/s, shared across sessions)
 * - 403 QpsLimit auto-backoff with retry
 * - Markdown formatting fixes for DingTalk rendering
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { DingTalkConfig } from "../types";

// ═══════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════

const AI_CARD_TEMPLATE_ID = "02fcf2f4-5e02-4a85-b672-46d1f715543e.schema";
const CARD_API_MAX_QPS = 20;
const QPS_BACKOFF_MS = 2_000;

const AICardStatus = {
	PROCESSING: "1",
	INPUTING: "2",
	FINISHED: "3",
	EXECUTING: "4",
	FAILED: "5",
} as const;

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

export interface AICardInstance {
	cardInstanceId: string;
	accessToken: string;
	tokenExpireTime: number;
	inputingStarted: boolean;
}

export type AICardTarget = { type: "user"; userId: string } | { type: "group"; openConversationId: string };

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
// AI Card API
// ═══════════════════════════════════════════════════════════════════════

export async function createAICardForTarget(
	config: DingTalkConfig,
	target: AICardTarget,
): Promise<AICardInstance | null> {
	const targetDesc = target.type === "group" ? `group ${target.openConversationId}` : `user ${target.userId}`;

	try {
		const token = await getAccessToken(config);
		const cardInstanceId = `card_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

		logger.debug("[AICard] Creating card", { target: targetDesc, cardInstanceId });

		// 1. Create card instance
		const createResp = await fetch(`${DINGTALK_API}/v1.0/card/instances`, {
			method: "POST",
			headers: {
				"x-acs-dingtalk-access-token": token,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				cardTemplateId: AI_CARD_TEMPLATE_ID,
				outTrackId: cardInstanceId,
				cardData: {
					cardParamMap: {
						config: JSON.stringify({ autoLayout: true }),
					},
				},
				callbackType: "STREAM",
				imGroupOpenSpaceModel: { supportForward: true },
				imRobotOpenSpaceModel: { supportForward: true },
			}),
		});

		if (!createResp.ok) {
			const text = await createResp.text();
			logger.error("[AICard] Create instance failed", { status: createResp.status, body: text });
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

export async function streamAICard(
	card: AICardInstance,
	content: string,
	finished: boolean = false,
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
			cardData: {
				cardParamMap: {
					flowStatus: AICardStatus.INPUTING,
					msgContent: normalizeForCard(content),
					staticMsgContent: "",
					sys_full_json_obj: JSON.stringify({ order: ["msgContent"] }),
					config: JSON.stringify({ autoLayout: true }),
				},
			},
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
				// QPS retry
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
				}
			} else if (!resp.ok) {
				const text = await resp.text();
				logger.error("[AICard] INPUTING switch failed", { status: resp.status, body: text });
			}
		} catch (err) {
			logger.error("[AICard] INPUTING switch error", { error: String(err) });
		}

		card.inputingStarted = true;
	}

	const fixedContent = normalizeForCard(content);
	const streamContent = finished ? fixedContent : fixedContent.replace(/\n+$/, "");

	const body = {
		outTrackId: card.cardInstanceId,
		guid: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
		key: "msgContent",
		content: streamContent,
		isFull: true,
		isFinalize: finished,
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
			}
		} else if (!resp.ok) {
			const text = await resp.text();
			logger.warn("[AICard] streaming update failed", { status: resp.status, body: text });
		}
	} catch (err) {
		if (isQpsLimitError(err)) {
			cardRateLimiter.triggerBackoff();
		}
		logger.error("[AICard] streaming error", { error: String(err) });
	}
}

export async function finishAICard(card: AICardInstance, content: string, config?: DingTalkConfig): Promise<void> {
	if (!card) return;

	if (config) {
		await ensureValidToken(card, config);
	}

	const fixedContent = normalizeForCard(content);
	await streamAICard(card, fixedContent, true, config);

	const body = {
		outTrackId: card.cardInstanceId,
		cardData: {
			cardParamMap: {
				flowStatus: AICardStatus.FINISHED,
				msgContent: fixedContent,
				staticMsgContent: "",
				sys_full_json_obj: JSON.stringify({ order: ["msgContent"] }),
				config: JSON.stringify({ autoLayout: true }),
			},
		},
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
				logger.error("[AICard] FINISHED retry failed", { status: retryResp.status });
			}
		} else if (!resp.ok) {
			const text = await resp.text();
			logger.warn("[AICard] FINISHED update failed", { status: resp.status, body: text });
		}
	} catch (err) {
		logger.error("[AICard] FINISHED error", { error: String(err) });
	}
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
