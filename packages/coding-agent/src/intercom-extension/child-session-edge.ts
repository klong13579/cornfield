/**
 * The intercom side of a supervised Child Session: observing its parent edge.
 *
 * A child process declares its parent only through the `PI_SUBAGENT_*` env
 * (`./child-session-metadata.ts`) and the child-side registration in
 * `./index.ts` turns that into `parentId` on the broker. Nothing in the spawn
 * path proves the edge landed — the child could have started with a stale env,
 * or registered under a different parent, and the supervisor would report a
 * healthy child that its parent can never see or address.
 *
 * This module closes that gap for `ChildSessionSupervisor`: it watches the
 * broker roster until the freshly spawned process appears as a child of this
 * session, and refuses to report the child as started before that.
 *
 * The match is on `pid`, not on the edge name: siblings of one parent all
 * register with the same `parentId`, so only the process handle identifies
 * which of them this incarnation is.
 */

import { logger } from "@cornfield/utils";
import type { ChildSessionRegistrationProbe } from "../session/child-session-supervisor";
import type { SessionInfo } from "./types";

const DEFAULT_REGISTRATION_TIMEOUT_MS = 60_000;
const DEFAULT_REGISTRATION_POLL_MS = 250;
const ROSTER_REQUEST_TIMEOUT_MS = 5_000;

/** The read side of the broker this probe needs — satisfied by `IntercomClient`. */
export interface ChildSessionRoster {
	listSessions(options?: { timeoutMs?: number }): Promise<SessionInfo[]>;
}

export interface ChildSessionEdgeOptions {
	roster: ChildSessionRoster;
	/**
	 * The parent's intercom session id — the exact value a child registers as its
	 * `parentId`. For a session connected to the broker this is
	 * `PI_INTERCOM_SESSION_ID` / the intercom session id, not the display name.
	 */
	parentId: string;
	/** Budget for the edge to appear. Defaults to 60s. */
	timeoutMs?: number;
	/** Roster poll interval. Defaults to 250ms. */
	pollMs?: number;
}

/**
 * A child registered a parent edge, but not the one it was launched with.
 *
 * Reported immediately rather than polled to the timeout: a child registers once,
 * so a wrong `parentId` is not a slow registration — it is the wrong edge, and
 * the parent will never see this child.
 */
export class ChildSessionEdgeMismatchError extends Error {
	readonly pid: number;
	readonly expectedParentId: string;
	readonly actualParentId: string | undefined;

	constructor(input: {
		sessionId: string;
		pid: number;
		expectedParentId: string;
		actualParentId: string | undefined;
	}) {
		super(
			`Child session "${input.sessionId}" (pid ${input.pid}) registered with parentId ${JSON.stringify(input.actualParentId)} instead of ${JSON.stringify(input.expectedParentId)}`,
		);
		this.name = "ChildSessionEdgeMismatchError";
		this.pid = input.pid;
		this.expectedParentId = input.expectedParentId;
		this.actualParentId = input.actualParentId;
	}
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise(resolvePromise => {
		if (signal.aborted) {
			resolvePromise();
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolvePromise();
		}, ms);
		timer.unref?.();
		const onAbort = () => {
			clearTimeout(timer);
			resolvePromise();
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Build the probe that waits for a child's parent edge to land on the broker.
 *
 * `roster` is the parent's own intercom client: the probe reads the same roster
 * the parent would use to address its children, so "registered" means exactly
 * "the parent can see and reach this child".
 */
export function createIntercomRegistrationProbe(options: ChildSessionEdgeOptions): ChildSessionRegistrationProbe {
	const timeoutMs = options.timeoutMs ?? DEFAULT_REGISTRATION_TIMEOUT_MS;
	const pollMs = options.pollMs ?? DEFAULT_REGISTRATION_POLL_MS;

	return {
		async awaitRegistration({ sessionId, pid, signal }): Promise<void> {
			const deadline = Date.now() + timeoutMs;
			let lastRosterError: Error | undefined;

			while (Date.now() < deadline && !signal.aborted) {
				try {
					const sessions = await options.roster.listSessions({
						timeoutMs: Math.min(ROSTER_REQUEST_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
					});
					const registered = sessions.find(session => session.pid === pid);
					if (registered) {
						if (registered.parentId === options.parentId) return;
						throw new ChildSessionEdgeMismatchError({
							sessionId,
							pid,
							expectedParentId: options.parentId,
							actualParentId: registered.parentId,
						});
					}
				} catch (error) {
					if (error instanceof ChildSessionEdgeMismatchError) throw error;
					lastRosterError = error instanceof Error ? error : new Error(String(error));
					logger.debug("Child session registration poll failed", {
						sessionId,
						pid,
						error: lastRosterError.message,
					});
				}
				await sleep(pollMs, signal);
			}

			if (signal.aborted) {
				throw new Error(`Waiting for child session "${sessionId}" to register was cancelled`);
			}
			throw new Error(
				`Child session "${sessionId}" (pid ${pid}) did not register as a child of "${options.parentId}" within ${timeoutMs}ms${lastRosterError ? `: ${lastRosterError.message}` : ""}`,
			);
		},
	};
}
