/**
 * Smoke test: cron task completion -> DingTalk delivery.
 *
 * Exercises the real cronRun path end-to-end:
 *   1. Create a task with `deliver` + `deliverUser` in a temp DB.
 *   2. Mock global fetch to capture outbound DingTalk API calls
 *      (OAuth accessToken + batchSend oToMessages).
 *   3. Call cronRun; the task executes `echo`, then cronRun invokes
 *      sendToChannel -> sendViaOAuth -> two real fetch calls.
 *   4. Assert the captured requests prove the right DingTalk
 *      account was selected and the message body contains the
 *      task output.
 *
 * This is the second half of the user's two-part smoke-test ask.
 * The first half (DingTalk message -> cron task creation) has no
 * code path in the current implementation; see report above.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cronRun } from "../src/scheduler/cli-commands";
import { SchedulerDbStorage } from "../src/scheduler/storage";

let testDir: string;
let dbPath: string;
let storage: SchedulerDbStorage;
let originalFetch: typeof fetch;
let fetchCalls: Array<{
	url: string;
	method: string;
	body: unknown;
	headers: Record<string, string>;
}>;

function cleanup() {
	try {
		if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

function cleanupExecutionLog(slug: string) {
	const logDir = path.join(
		os.homedir(),
		".omp",
		"gateway-data",
		"scheduler",
		"logs",
		"by-task",
		slug,
	);
	try {
		fs.rmSync(logDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

beforeEach(() => {
	testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gateway-smoke-"));
	dbPath = path.join(testDir, "scheduler.db");
	storage = new SchedulerDbStorage(dbPath);

	// Mock fetch. We only care about two endpoints: the OAuth access
	// token endpoint and the batchSend oToMessages endpoint. Anything
	// else (e.g. an unrelated network call) is treated as success
	// with an empty body so the rest of cronRun doesn't error.
	originalFetch = globalThis.fetch;
	fetchCalls = [];
	globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const method = init?.method ?? "GET";
		const body = init?.body ? (JSON.parse(init.body as string) as unknown) : null;
		const headers: Record<string, string> = {};
		if (init?.headers) {
			for (const [k, v] of Object.entries(init.headers)) {
				headers[k.toLowerCase()] = String(v);
			}
		}
		fetchCalls.push({ url, method, body, headers });

		if (url.includes("accessToken")) {
			return new Response(JSON.stringify({ accessToken: "fake-token-smoke-test" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (url.includes("oToMessages") || url.includes("batchSend")) {
			return new Response(JSON.stringify({ processQueryKey: "fake-process-key" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		// Default: return success so anything else (e.g. heartbeat
		// or unrelated fetches) doesn't break the test.
		return new Response("{}", { status: 200 });
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	storage?.close();
	cleanup();
	cleanupExecutionLog("_t_smoke_outbound");
	cleanupExecutionLog("_t_smoke_independent");
});

function loadGatewayConfig(): {
	hr?: { appKey: string; appSecret: string; robotCode?: string };
	opencode?: { appKey: string; appSecret: string; robotCode?: string };
} {
	const gatewayPath = path.join(os.homedir(), ".omp", "gateway.json");
	if (!fs.existsSync(gatewayPath)) return {};
	try {
		const raw = JSON.parse(fs.readFileSync(gatewayPath, "utf8"));
		return raw.channels?.dingtalk?.accounts ?? {};
	} catch {
		return {};
	}
}

describe("cron task outbound delivery smoke test", () => {
	it("sends the completed task result to the DingTalk account named in `deliver`", async () => {
		const accounts = loadGatewayConfig();
		const hr = accounts.hr;
		if (!hr) {
			// The smoke test depends on the real gateway.json having an
			// `hr` account. Skip rather than fail on a machine without it.
			console.log("[skip] gateway.json has no `hr` account; cannot run outbound smoke test");
			return;
		}

		storage.addTask({
			name: "_t_smoke_outbound",
			cron: "0 0 1 1 *",
			command: "echo hello from smoke test",
			taskType: "shell",
			status: "active",
			deliver: "dingtalk:hr",
			deliverUser: "u_smoke_test",
			accountId: "hr",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
			timeoutMs: 30_000,
		});

		try {
			await cronRun("_t_smoke_outbound", storage);

			// (1) OAuth request used the hr account's appKey.
			const oauthCall = fetchCalls.find(c => c.url.includes("accessToken"));
			expect(oauthCall).toBeDefined();
			const oauthBody = oauthCall?.body as { appKey?: string; appSecret?: string } | null;
			expect(oauthBody?.appKey).toBe(hr.appKey);
			// appSecret may be a $ENVVAR reference; we just check it was passed.
			expect(typeof oauthBody?.appSecret).toBe("string");

			// (2) Message-send request was made to the DingTalk oToMessages
			// batchSend endpoint with the access token in the header.
			const sendCall = fetchCalls.find(
				c => c.url.includes("oToMessages") || c.url.includes("batchSend"),
			);
			expect(sendCall).toBeDefined();
			expect(sendCall?.headers["x-acs-dingtalk-access-token"]).toBe("fake-token-smoke-test");

			// (3) The message body contains the task output and the
			// configured deliverUser. The cronRun summary wraps the
			// output with a status prefix.
			const sendBody = sendCall?.body as {
				robotCode?: string;
				userIds?: string[];
				msgParam?: string;
			} | null;
			expect(sendBody?.userIds).toContain("u_smoke_test");
			const msgParam = JSON.parse(sendBody?.msgParam ?? "{}") as { content?: string };
			expect(msgParam.content).toContain("hello from smoke test");
		} finally {
			const task = storage.getTaskByName("_t_smoke_outbound");
			if (task) storage.deleteTask(task.id);
		}
	});

	it("`deliver` (not `accountId`) picks which DingTalk account sends the result", async () => {
		// This pins the contract: accountId controls where the task
		// runs (Bun.spawn cwd -> resolved agentDir); deliver controls
		// where the result is sent. They are independent fields.
		const accounts = loadGatewayConfig();
		const hr = accounts.hr;
		const opencode = accounts.opencode;
		if (!hr || !opencode) {
			console.log(
				"[skip] gateway.json missing `hr` or `opencode` account; cannot run independence smoke test",
			);
			return;
		}

		// Task runs in hr's agentDir (accountId: hr) but delivers
		// through the opencode account's DingTalk credentials.
		storage.addTask({
			name: "_t_smoke_independent",
			cron: "0 0 1 1 *",
			command: "echo independence test",
			taskType: "shell",
			status: "active",
			deliver: "dingtalk:opencode",
			deliverUser: "u_indep",
			accountId: "hr",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
			timeoutMs: 30_000,
		});

		try {
			await cronRun("_t_smoke_independent", storage);

			const oauthCall = fetchCalls.find(c => c.url.includes("accessToken"));
			expect(oauthCall).toBeDefined();
			const oauthBody = oauthCall?.body as { appKey?: string } | null;
			// The OAuth request must use the opencode account's appKey,
			// NOT hr's. If the code accidentally read accountId for
			// outbound routing, this assertion would fail.
			expect(oauthBody?.appKey).toBe(opencode.appKey);
			expect(oauthBody?.appKey).not.toBe(hr.appKey);

			const sendCall = fetchCalls.find(
				c => c.url.includes("oToMessages") || c.url.includes("batchSend"),
			);
			expect(sendCall).toBeDefined();
			const sendBody = sendCall?.body as { robotCode?: string } | null;
			// robotCode follows the deliver account, not the running account.
			expect(sendBody?.robotCode).toBe(opencode.robotCode ?? opencode.appKey);
		} finally {
			const task = storage.getTaskByName("_t_smoke_independent");
			if (task) storage.deleteTask(task.id);
		}
	});

	it("does not call DingTalk at all when `deliver` is unset (no accidental delivery)", async () => {
		// A task with no deliver/deliverUser must NOT touch the DingTalk
		// API. This is the default for all existing tasks; we just lock
		// it down so a future refactor can't accidentally start
		// delivering every task to the gateway's default DingTalk
		// account.
		storage.addTask({
			name: "_t_smoke_nodeliver",
			cron: "0 0 1 1 *",
			command: "echo no deliver",
			taskType: "shell",
			status: "active",
			accountId: "hr",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
			timeoutMs: 30_000,
		});

		try {
			await cronRun("_t_smoke_nodeliver", storage);

			const dingTalkCalls = fetchCalls.filter(
				c => c.url.includes("dingtalk.com") || c.url.includes("accessToken"),
			);
			expect(dingTalkCalls.length).toBe(0);
		} finally {
			const task = storage.getTaskByName("_t_smoke_nodeliver");
			if (task) storage.deleteTask(task.id);
		}
	});
});
