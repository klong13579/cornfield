/**
 * Configuration loading tests.
 */

import { describe, expect, it } from "bun:test";
import { getConfigPath, getDataDir, getDingTalkConfig, loadConfig } from "../src/config";

describe("config", () => {
	it("returns default config when file does not exist", async () => {
		const config = await loadConfig("/nonexistent/path.json");
		expect(config.channels).toEqual({});
		expect(config.agent?.ompPath).toBe("omp");
		expect(config.session?.idleTimeoutMinutes).toBe(240);
	});

	it("resolves config path in home directory", () => {
		const path = getConfigPath();
		expect(path).toContain(".omp/gateway.json");
	});

	it("resolves data dir", () => {
		const dir = getDataDir();
		expect(dir).toContain(".omp/gateway-data");
	});

	it("resolves DingTalk appSecret env references", () => {
		const previous = process.env.PI_GATEWAY_TEST_SECRET;
		process.env.PI_GATEWAY_TEST_SECRET = "resolved-secret";
		try {
			const config = getDingTalkConfig({
				channels: {
					dingtalk: { enabled: true, appKey: "app", appSecret: "$PI_GATEWAY_TEST_SECRET" },
				},
			});
			expect(config?.appSecret).toBe("resolved-secret");
		} finally {
			if (previous === undefined) {
				delete process.env.PI_GATEWAY_TEST_SECRET;
			} else {
				process.env.PI_GATEWAY_TEST_SECRET = previous;
			}
		}
	});

	it("rejects missing DingTalk appSecret env references", () => {
		const previous = process.env.PI_GATEWAY_MISSING_SECRET;
		delete process.env.PI_GATEWAY_MISSING_SECRET;
		try {
			const config = getDingTalkConfig({
				channels: {
					dingtalk: { enabled: true, appKey: "app", appSecret: "$PI_GATEWAY_MISSING_SECRET" },
				},
			});
			expect(config).toBeNull();
		} finally {
			if (previous !== undefined) process.env.PI_GATEWAY_MISSING_SECRET = previous;
		}
	});
});
