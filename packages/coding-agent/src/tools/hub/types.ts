/**
 * Shared types for the local `hub` tool — the read-only agent-roster surface.
 *
 * Deliberately narrower than the upstream hub (which also covers peer
 * messaging via an IrcBus, async-job control, and daemon-broker process
 * supervision): messaging is already covered by `irc`, job control by `job`,
 * and launch supervision is a separate subsystem not ported. This tool covers
 * what nothing else does — a work-aware roster with activity and identity.
 */

/** One roster row: an alive peer (running | idle) plus its activity gist. */
export interface HubPeerInfo {
	id: string;
	displayName: string;
	kind: string;
	status: string;
	parentId?: string;
	/** Short gist of what the peer is currently doing (running only). */
	activity?: string;
	/** Unix ms of last recorded activity (status change or work heartbeat). */
	lastActivity?: number;
	sessionFile?: string | null;
}

/** Detail view for a single peer (`op: "show"`). */
export interface HubPeerDetail extends HubPeerInfo {
	createdAt: number;
	/** Persisted identity/telemetry restored after the live session is gone. */
	history?: {
		agent?: string;
		modelRole?: string;
		resolvedModel?: string;
		metrics?: {
			tokens: number;
			requests: number;
			tools: number;
			cost: number;
			durationMs: number;
		};
		outputPath?: string;
		patchPath?: string;
		branchName?: string;
	};
}

export interface HubDetails {
	op: "list" | "show";
	from?: string;
	count: number;
	peers?: HubPeerInfo[];
	/** The requested peer detail, when `op: "show"` resolved a live ref. */
	peer?: HubPeerDetail;
	unknown?: string[];
}

/** Authoritative peer face for the roster, sorted by recency of activity. */
export function sortPeersByRecency<T extends { lastActivity?: number }>(peers: T[]): T[] {
	return [...peers].sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
}
