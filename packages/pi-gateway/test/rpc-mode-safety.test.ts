/**
 * RPC mode uncaught-error safety.
 *
 * Plan v2 Fix A: `runRpcMode` installs handlers at entry so any
 * uncaughtException or unhandledRejection produces an immediate
 * `process.exit(1)` rather than a silent subprocess death. The
 * bridge detects OMP death via `proc.exited` exit code, so any
 * non-1 exit would be misread as a clean shutdown.
 *
 * The handlers themselves are pure process-global registrations
 * (process.on), so we verify the contract by exercising the same
 * pattern under a real bun subprocess. This proves the runtime
 * behaviour the production code depends on: when an unhandled
 * error fires, the process exits with code 1.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

let tmpDir: string;

const SCRIPT_TEMPLATE = `#!/usr/bin/env bun
// Mirror of the handlers installed by runRpcMode at entry. We
// duplicate the pattern here (instead of importing runRpcMode)
// because the real entry point requires an AgentSession and
// side-effects on stdout — out of scope for this safety test.
process.on("uncaughtException", err => {
  console.error("[rpc-mode] uncaughtException, exiting", err.message);
  process.exit(1);
});
process.on("unhandledRejection", reason => {
  console.error("[rpc-mode] unhandledRejection, exiting", reason instanceof Error ? reason.message : String(reason));
  process.exit(1);
});

// Stay alive until the parent tells us to fire the trigger.
const marker = process.argv[2];
setTimeout(() => {
  if (marker === "uncaught") {
    setImmediate(() => {
      throw new Error("synthetic uncaught");
    });
  } else if (marker === "rejection") {
    Promise.reject(new Error("synthetic rejection"));
  }
  // Keep the loop alive briefly so the handlers can fire.
  setTimeout(() => {
    console.log("still alive after trigger");
  }, 200);
}, 30);
`;

async function writeTriggerScript(marker: "uncaught" | "rejection"): Promise<string> {
	const p = path.join(tmpDir, `trigger-${marker}.bun`);
	await Bun.write(p, SCRIPT_TEMPLATE);
	await fs.chmod(p, 0o755);
	return p;
}

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-rpc-safety-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

async function runScript(scriptPath: string, marker: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn([process.execPath, scriptPath, marker], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

describe("rpc-mode uncaught-error safety", () => {
	test("uncaughtException handler exits the process with code 1", async () => {
		const scriptPath = await writeTriggerScript("uncaught");
		const { exitCode, stderr } = await runScript(scriptPath, "uncaught");
		expect(exitCode).toBe(1);
		expect(stderr).toContain("uncaughtException");
		expect(stderr).toContain("synthetic uncaught");
	});

	test("unhandledRejection handler exits the process with code 1", async () => {
		const scriptPath = await writeTriggerScript("rejection");
		const { exitCode, stderr } = await runScript(scriptPath, "rejection");
		expect(exitCode).toBe(1);
		expect(stderr).toContain("unhandledRejection");
		expect(stderr).toContain("synthetic rejection");
	});

	test("process without the handler would silently die — sanity check the runtime", async () => {
		// A bare bun script that throws on next tick with no handlers
		// should NOT exit cleanly with code 1. The runtime default
		// behaviour is to log + exit non-zero, but the *value* is
		// unstable. This test documents the contrast: we rely on the
		// explicit handler in rpc-mode.ts to get a deterministic 1.
		const baseline = path.join(tmpDir, "baseline.bun");
		await Bun.write(
			baseline,
			`#!/usr/bin/env bun
setImmediate(() => { throw new Error("baseline"); });
`,
		);
		await fs.chmod(baseline, 0o755);
		const { exitCode } = await runScript(baseline, "x");
		// Either non-zero (preferred) or 1 — we just want a defined
		// exit, and we want to know it's NOT 0.
		expect(exitCode).not.toBe(0);
	});
});
