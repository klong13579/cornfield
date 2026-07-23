/**
 * Quick SSRF check test — run with: bun test packages/coding-agent/test/ssrf-check.test.ts
 */
import { test, expect } from "bun:test";
import { checkUrlSsrf } from "../src/web/scrapers/types";

const testCases = [
	// Should be blocked
	{ url: "http://127.0.0.1:9999", expectBlock: true },
	{ url: "http://127.0.0.1", expectBlock: true },
	{ url: "http://192.168.1.1", expectBlock: true },
	{ url: "http://10.0.0.5", expectBlock: true },
	{ url: "http://172.16.0.1", expectBlock: true },
	{ url: "http://169.254.169.254", expectBlock: true },
	{ url: "http://100.64.0.1", expectBlock: true },
	{ url: "http://0.0.0.0", expectBlock: true },
	{ url: "http://metadata.google.internal", expectBlock: true },
	{ url: "http://metadata.tencentyun.com", expectBlock: true },

	// Should be allowed
	{ url: "https://example.com", expectBlock: false },
	{ url: "https://github.com", expectBlock: false },
	{ url: "https://8.8.8.8", expectBlock: false },
	{ url: "https://1.1.1.1", expectBlock: false },
];

for (const tc of testCases) {
	test(`${tc.expectBlock ? "blocks" : "allows"} ${tc.url}`, async () => {
		const result = await checkUrlSsrf(tc.url);
		if (tc.expectBlock) {
			expect(result).not.toBeNull();
			expect(result).toContain("blocked for security");
		} else {
			expect(result).toBeNull();
		}
	});
}
