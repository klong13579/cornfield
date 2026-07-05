/**
 * Gateway status contract tests.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createAccountBridgeOptions, Gateway } from "../src/gateway";
import { getGatewayStatus, isGatewayProcess } from "../src/gateway-daemon";

describe("Gateway status", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-status-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("getGatewayStatus reads PID from configured dataDir", async () => {
		await Bun.write(path.join(tmpDir, "gateway.pid"), String(process.pid));
		const status = await getGatewayStatus({ channels: {}, dataDir: tmpDir });

		expect(status.running).toBe(true);
		expect(status.pid).toBe(process.pid);
	});

	test("Gateway.getStatus includes account and queue fields", async () => {
		const gateway = new Gateway({ channels: {}, dataDir: tmpDir });
		const status = await gateway.getStatus();

		expect(status.running).toBe(false);
		expect(status.accounts).toEqual([]);
		expect(status.queues).toEqual([]);
		expect(status.bridges).toEqual([]);
	});

	test("reload swaps the gateway config while stopped", async () => {
		const nextDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-status-next-"));
		try {
			await Bun.write(path.join(nextDir, "gateway.pid"), String(process.pid));
			const gateway = new Gateway({ channels: {}, dataDir: tmpDir });

			await gateway.reload({ channels: {}, dataDir: nextDir });
			const status = await gateway.getStatus();

			expect(status.running).toBe(true);
		} finally {
			await fs.rm(nextDir, { recursive: true, force: true });
		}
	});

	test("account bridge options prefer account model over global model", async () => {
		const options = await createAccountBridgeOptions(
			{ model: "global-model", timeoutMs: 10_000 },
			"test-account",
			{ appKey: "app", appSecret: "secret", model: "account-model", timeoutMs: 20_000 },
			"/tmp/agent",
		);

		expect(options.model).toBe("account-model");
		expect(options.timeoutMs).toBe(20_000);
		expect(options.cwd).toBe("/tmp/agent");
	});
});

describe("isGatewayProcess", () => {
	test("returns false for a dead PID", async () => {
		// PID 1 on macOS is launchd; on Linux it's init. Either way, the
		// call below uses a PID we know is dead (way above any reasonable
		// system PID).
		expect(await isGatewayProcess(999_999_999)).toBe(false);
	});

	test("returns true for the current test process when launched via gateway --foreground", async () => {
		// The test runner is launched as `bun test ...` — its argv does NOT
		// contain both "gateway" and "--foreground", so this should return
		// false even though the PID is alive. This is exactly the recycled
		// PID scenario: PID is alive but process is not our gateway.
		expect(await isGatewayProcess(process.pid)).toBe(false);
	});

	test("returns true for a process whose argv contains `gateway` and `--foreground`", async () => {
		// `/usr/bin/yes <args>` is a real execve target: the kernel sees the
		// full argv, `ps -o args=` reports it verbatim, and `yes` itself just
		// spams lines forever while ignoring all args. This reproduces the
		// exact shape a real gateway process has, without needing the
		// gateway's own setup (DingTalk config, port binding, etc).
		const child = Bun.spawn({
			cmd: ["/usr/bin/yes", "gateway", "start", "--foreground"],
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		try {
			await Bun.sleep(50);
			expect(await isGatewayProcess(child.pid)).toBe(true);
		} finally {
			child.kill();
			await child.exited;
		}
	});
});
