/**
 * The one place a session's intercom identity is derived.
 *
 * Identity belongs to a *process*, not to a machine: a session id is a claim by
 * one live process, and the broker refuses to hand that claim to a second one
 * (`broker-server.ts`, `register`). So the only thing that may pin an address
 * is the launcher, per process, through `PI_INTERCOM_STABLE_ID`.
 *
 * Nothing on disk may decide it. `config.json` is machine-global — a `stableId`
 * there would be read by every session on the machine, and every one of them
 * would register the same id: the newest registration used to displace the live
 * holder, leaving a parent unable to find a child that was still running. That
 * key is gone; a machine-wide file must not decide who a process is.
 *
 * Without a pinned address a session answers to its own session id, which is
 * what keeps a resumed session addressable.
 */

export const STABLE_INTERCOM_SESSION_ID_ENV = "PI_INTERCOM_STABLE_ID";

export function resolveIntercomSessionId(piSessionId: string): string {
	return process.env[STABLE_INTERCOM_SESSION_ID_ENV]?.trim() || piSessionId;
}
