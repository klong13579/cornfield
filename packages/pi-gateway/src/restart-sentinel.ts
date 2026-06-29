/**
 * Restart sentinel — persists active session state across gateway restarts.
 *
 * When the gateway shuts down (graceful or crash), it writes a sentinel file
 * containing the currently active session's info. On startup, the gateway reads
 * the sentinel and resumes the conversation, so the agent can acknowledge the
 * restart and continue where it left off.
 *
 * The sentinel is a single JSON file at `~/.omp/gateway-data/restart-pending.json`.
 * It is written before shutdown and cleared after successful recovery.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { getDataDir } from "./config";
import type { GatewayConfig } from "./types";

const SENTINEL_FILENAME = "restart-pending.json";

export interface RestartSentinel {
	/** The conversation ID from the IM platform (e.g. DingTalk conversationId). */
	conversationId: string;
	/** The account ID for multi-account routing. */
	accountId: string;
	/** The gateway agent session path (e.g. ~/.omp/agents/<accountId>/sessions/<safeId>.jsonl). */
	ompSessionPath: string;
	/** The message to send to the agent after restart to resume the conversation. */
	continuationMessage: string;
	/** Timestamp when the sentinel was written. */
	timestamp: number;
}

const DEFAULT_CONTINUATION_MESSAGE =
	"[System] The gateway was restarted. Your previous conversation was interrupted. " +
	"Please acknowledge the restart and summarize what you were working on.";

function getSentinelPath(config?: GatewayConfig): string {
	return path.join(getDataDir(config), SENTINEL_FILENAME);
}

/**
 * Write a restart sentinel before gateway shutdown.
 *
 * Called during `gateway.stop()` to capture the currently active session.
 * The sentinel is read on the next startup to resume the conversation.
 */
export async function writeRestartSentinel(
	params: {
		conversationId: string;
		accountId: string;
		ompSessionPath: string;
		continuationMessage?: string;
	},
	config?: GatewayConfig,
): Promise<void> {
	const sentinel: RestartSentinel = {
		conversationId: params.conversationId,
		accountId: params.accountId,
		ompSessionPath: params.ompSessionPath,
		continuationMessage: params.continuationMessage ?? DEFAULT_CONTINUATION_MESSAGE,
		timestamp: Date.now(),
	};

	const sentinelPath = getSentinelPath(config);

	try {
		await fs.mkdir(path.dirname(sentinelPath), { recursive: true });
		await Bun.write(sentinelPath, JSON.stringify(sentinel, null, 2));
		logger.debug("Restart sentinel written", {
			sentinelPath,
			conversationId: sentinel.conversationId,
			accountId: sentinel.accountId,
		});
	} catch (err) {
		logger.warn("Failed to write restart sentinel", {
			sentinelPath,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Read the restart sentinel on gateway startup.
 *
 * Returns `null` if no sentinel exists or if it is stale (older than 1 hour).
 * The sentinel is cleared after successful recovery by `clearRestartSentinel()`.
 */
export async function readRestartSentinel(config?: GatewayConfig): Promise<RestartSentinel | null> {
	const sentinelPath = getSentinelPath(config);

	try {
		const raw = await Bun.file(sentinelPath).text();
		const sentinel = JSON.parse(raw) as RestartSentinel;

		// Validate required fields
		if (
			!sentinel.conversationId ||
			!sentinel.accountId ||
			!sentinel.ompSessionPath ||
			!sentinel.timestamp
		) {
			logger.warn("Restart sentinel is malformed, clearing", { sentinelPath });
			await clearRestartSentinel(config);
			return null;
		}

		// Check staleness (1 hour TTL)
		const ageMs = Date.now() - sentinel.timestamp;
		const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
		if (ageMs > MAX_AGE_MS) {
			logger.warn("Restart sentinel is stale, clearing", {
				sentinelPath,
				ageMs,
				maxAgeMs: MAX_AGE_MS,
			});
			await clearRestartSentinel(config);
			return null;
		}

		logger.debug("Restart sentinel read", {
			sentinelPath,
			conversationId: sentinel.conversationId,
			accountId: sentinel.accountId,
			ageMs,
		});

		return sentinel;
	} catch (err) {
		if (isEnoent(err)) {
			// No sentinel — normal startup
			return null;
		}
		logger.warn("Failed to read restart sentinel", {
			sentinelPath,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/**
 * Clear the restart sentinel after successful recovery.
 *
 * Called after the gateway has resumed the conversation and the agent has
 * acknowledged the restart. Prevents duplicate recovery on subsequent startups.
 */
export async function clearRestartSentinel(config?: GatewayConfig): Promise<void> {
	const sentinelPath = getSentinelPath(config);

	try {
		await fs.unlink(sentinelPath);
		logger.debug("Restart sentinel cleared", { sentinelPath });
	} catch (err) {
		if (isEnoent(err)) {
			// Already cleared — no-op
			return;
		}
		logger.warn("Failed to clear restart sentinel", {
			sentinelPath,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
