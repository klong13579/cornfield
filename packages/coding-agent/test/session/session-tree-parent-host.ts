#!/usr/bin/env bun
/**
 * A Session Tree parent host — a real, separate OS process that owns a ledger.
 *
 * Why this is a file and not an inline script: the E2E has to prove that a parent
 * that *dies* leaves a ledger a *different process* can pick up. That is only a
 * real test if the parent is really a process, so this is one, driven by argv:
 *
 *   delegate  — connect to the broker, delegate one Child Session, print its pid
 *               and stay alive (so the child stays alive), until it is killed
 *   reconcile — connect to the broker, reconcile the ledger at `--ledger`, print
 *               the plan as JSON, exit
 *
 * Everything it uses is the production path: `SessionTreeManager`, the real
 * registration probe, the real liveness probe on the real roster. It is not a
 * mock of a parent session; it is a parent session with a CLI instead of a TUI.
 */

import { IntercomClient } from "../../src/intercom-extension/broker/client";
import { createIntercomRegistrationProbe } from "../../src/intercom-extension/child-session-edge";
import { createIntercomLivenessProbe } from "../../src/intercom-extension/child-session-tree";
import { ChildSessionSupervisor } from "../../src/session/child-session-supervisor";
import { SessionManager } from "../../src/session/session-manager";
import { SessionTreeManager } from "../../src/session/session-tree-manager";
import { SessionLogTreeStore } from "../../src/session/session-tree-store";

function arg(name: string): string {
	const index = process.argv.indexOf(`--${name}`);
	const value = index === -1 ? undefined : process.argv[index + 1];
	if (value === undefined || value.trim() === "") {
		process.stderr.write(`missing --${name}\n`);
		process.exit(2);
	}
	return value;
}

const mode = process.argv[2];
const ledgerFile = arg("ledger");
const brokerId = arg("broker-id");
const parentId = arg("parent-id");
const cwd = arg("cwd");

const client = new IntercomClient();
await client.connect(
	{
		name: brokerId,
		cwd,
		model: "wp7-host",
		pid: process.pid,
		startedAt: Date.now(),
		lastActivity: Date.now(),
		status: "idle",
		runtimeFallbackAlias: false,
	},
	brokerId,
);

const manager = new SessionTreeManager({
	self: { sessionId: parentId, agentId: "default", intercomSessionId: parentId },
	supervisor: new ChildSessionSupervisor({
		maxConcurrent: 2,
		registration: createIntercomRegistrationProbe({ roster: client, parentId, timeoutMs: 120_000, pollMs: 250 }),
		restart: { maxRestarts: 0, baseBackoffMs: 10, maxBackoffMs: 10 },
		process: {
			readyTimeoutMs: 120_000,
			requestTimeoutMs: 60_000,
			abortTimeoutMs: 10_000,
			exitGraceMs: 20_000,
			termGraceMs: 5_000,
		},
	}),
	store: new SessionLogTreeStore(await SessionManager.open(ledgerFile)),
	liveness: createIntercomLivenessProbe({ roster: client, parentId }),
});

if (mode === "delegate") {
	const childId = arg("child-id");
	const binary = arg("binary");
	const { child, record } = await manager.delegate({
		sessionId: childId,
		cwd,
		command: { bin: binary, args: ["--mode", "wire-stdio"] },
		delegationRole: "wp7-host",
		objective: "read-only survey",
	});
	process.stdout.write(`${JSON.stringify({ childId, pid: child.transport.pid, runId: record.runId })}\n`);
	// Stay alive: the child is only alive while this process holds its stdin pipe.
	await new Promise(() => {});
} else if (mode === "reconcile") {
	const result = await manager.reconcile();
	process.stdout.write(
		`${JSON.stringify({
			applied: result.applied.map(decision => ({
				sessionId: decision.sessionId,
				disposition: decision.disposition,
				status: decision.status,
				reason: decision.reason,
			})),
			decisions: result.plan.decisions.map(decision => ({
				sessionId: decision.sessionId,
				disposition: decision.disposition,
				status: decision.status,
				reason: decision.reason,
			})),
			ledger: result.records.map(entry => ({ sessionId: entry.node.sessionId, status: entry.node.status })),
		})}\n`,
	);
	await client.disconnect();
	process.exit(0);
} else {
	process.stderr.write(`unknown mode "${mode}" — expected delegate or reconcile\n`);
	process.exit(2);
}
