/**
 * The supervisor against the REAL `cornfield` binary (E2E=1).
 *
 * `child-session-process.test.ts` proves the lifecycle against a real *process*
 * running a fake child program. This file proves the other half of the claim —
 * that the process the supervisor spawns is an actual Cornfield child session —
 * by booting `cornfield --mode wire-stdio` and driving it over the wire.
 *
 * Gated behind E2E=1 (the same opt-in as the real-provider suites): it boots the
 * full SDK, which reads the user's agent config and can probe local model
 * endpoints, so it is slow and environment-dependent by nature.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ChildSessionProcess } from "../../src/session/child-session-process";

const isE2E = process.env.E2E === "1";

function resolveCornfieldBinary(): string | undefined {
	const explicit = process.env.CORNFIELD_BINARY?.trim();
	if (explicit) return explicit;
	const installed = path.join(os.homedir(), ".local", "bin", "cornfield");
	try {
		fs.accessSync(installed, fs.constants.X_OK);
		return installed;
	} catch {
		return Bun.which("cornfield") ?? undefined;
	}
}

const binary = isE2E ? resolveCornfieldBinary() : undefined;
const describeE2E = binary ? describe : describe.skip;

describeE2E("ChildSessionProcess against the real cornfield binary", () => {
	test("boots a real wire-stdio child, answers over the wire, and stops gracefully", async () => {
		const cwd = fileURLToPath(new URL("../../../..", import.meta.url));
		const child = new ChildSessionProcess({
			sessionId: "e2e-child",
			cwd,
			command: { bin: binary!, args: ["--mode", "wire-stdio"] },
			readyTimeoutMs: 180_000,
			requestTimeoutMs: 60_000,
			abortTimeoutMs: 10_000,
			exitGraceMs: 15_000,
			termGraceMs: 5_000,
		});
		const events: string[] = [];
		child.subscribe(event => events.push(event.type));

		await child.start();
		expect(child.state).toBe("ready");
		expect(child.pid).not.toBe(process.pid);

		const state = await child.request<{ sessionId: string; messageCount: number }>({ type: "get_state" });
		expect(typeof state.sessionId).toBe("string");

		await child.stop();

		expect(child.state).toBe("exited");
		expect(events).toContain("ready");
		expect(events).toContain("exited");
	}, 300_000);
});
