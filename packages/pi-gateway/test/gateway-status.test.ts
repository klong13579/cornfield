/**
 * Gateway status contract tests.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createAccountBridgeOptions, Gateway, getGatewayStatus } from "../src/gateway";

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

	test("account bridge options prefer account model over global model", () => {
		const options = createAccountBridgeOptions(
			{ model: "global-model", timeoutMs: 10_000 },
			{ appKey: "app", appSecret: "secret", model: "account-model", timeoutMs: 20_000 },
			"/tmp/agent",
		);

		expect(options.model).toBe("account-model");
		expect(options.timeoutMs).toBe(20_000);
		expect(options.cwd).toBe("/tmp/agent");
	});
});
