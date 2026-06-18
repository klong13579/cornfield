/**
 * Gateway status contract tests.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Gateway, getGatewayStatus } from "../src/gateway";

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
	});
});
