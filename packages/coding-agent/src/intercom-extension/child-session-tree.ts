/**
 * The intercom side of the Session Tree: the two adapters the parent needs.
 *
 * The ledger itself (`../session/session-tree-store`) and the manager
 * (`../session/session-tree-manager`) know nothing about brokers, sockets or the
 * intercom message shape. This module is the only place that does:
 *
 *   - `createIntercomLivenessProbe` — "which pids does the broker still show
 *     registered as children of this session", the input reconcile needs after a
 *     restart,
 *   - `attachChildSessionReports` — route inbound child reports into the manager.
 *
 * Liveness is deliberately not "best effort". A roster read that fails must
 * propagate: an empty answer means "nothing is alive", and reconcile turns that
 * into `failed` for every non-terminal child. A broker that is briefly
 * unreachable would then terminalize a whole tree of live children. Failing loud
 * costs one retry; guessing costs the ledger's truth.
 */

import { logger } from "@cornfield/utils";
import { hasChildSessionReportTag } from "../session/child-session-report";
import type { ChildSessionLivenessProbe } from "../session/session-tree-manager";
import type { ChildSessionRoster } from "./child-session-edge";
import type { Message, SessionInfo } from "./types";

const DEFAULT_ROSTER_TIMEOUT_MS = 5_000;

export interface IntercomLivenessProbeOptions {
	/** The parent's own intercom client (or any reader of the same roster). */
	roster: ChildSessionRoster;
	/** The exact value children register as their `parentId`. */
	parentId: string;
	/** Budget for one roster read. Defaults to 5s. */
	timeoutMs?: number;
}

/**
 * Pids the broker shows as children of this parent.
 *
 * Matching is on `parentId` only: the caller compares pids against the ones it
 * recorded per child. Names and session ids are not used — both can be reused by
 * something that is not this child.
 */
export function createIntercomLivenessProbe(options: IntercomLivenessProbeOptions): ChildSessionLivenessProbe {
	const timeoutMs = options.timeoutMs ?? DEFAULT_ROSTER_TIMEOUT_MS;
	return {
		async liveChildPids(): Promise<ReadonlySet<number>> {
			const sessions = await options.roster.listSessions({ timeoutMs });
			const pids = new Set<number>();
			for (const session of sessions) {
				if (session.parentId === options.parentId) pids.add(session.pid);
			}
			return pids;
		},
	};
}

/** The manager, structurally — this module does not need to know what it does with a report. */
export interface ChildSessionReportSink {
	applyReport(from: { pid: number }, text: string): Promise<unknown>;
}

/** The read side of an intercom client this module needs. Satisfied by `IntercomClient`. */
export interface ChildSessionReportSource {
	on(event: "message", handler: (from: SessionInfo, message: Message) => void): unknown;
	off?(event: "message", handler: (from: SessionInfo, message: Message) => void): unknown;
}

/**
 * Feed inbound child reports to the manager.
 *
 * Only messages that *claim* to be a report are handed over: the manager would
 * otherwise have to inspect every message a peer sends. A sink failure is logged,
 * never propagated into the client's event loop — one malformed report must not
 * take down the session's message handling.
 */
export function attachChildSessionReports(
	source: ChildSessionReportSource,
	sink: ChildSessionReportSink,
	options: { onError?: (error: unknown) => void } = {},
): () => void {
	const handler = (from: SessionInfo, message: Message): void => {
		const text = message.content?.text;
		if (typeof text !== "string" || !hasChildSessionReportTag(text)) return;
		void sink.applyReport({ pid: from.pid }, text).catch(error => {
			if (options.onError) {
				options.onError(error);
				return;
			}
			logger.warn("Child session report could not be ingested", {
				from: from.id,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	};
	source.on("message", handler);
	return () => source.off?.("message", handler);
}
