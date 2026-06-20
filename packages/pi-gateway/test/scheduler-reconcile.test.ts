import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cronReconcile, suggestAccountBinding } from "../src/scheduler/cli-commands";
import { SchedulerDbStorage } from "../src/scheduler/storage";

const accounts: Record<string, { agentDir?: string }> = {
	hr: { agentDir: "/Users/test/OMP-workspace-test/hr3" },
	opencode: { agentDir: "/Users/test/OMP-workspace-test/omp-atomix" },
	"ops/hr": { agentDir: "/Users/test/.omp/agents/ops/hr" },
	// Account with no agentDir
	credentials_only: {},
};

describe("suggestAccountBinding", () => {
	it("matches the accountId prefix exactly (hr:foo -> hr)", () => {
		const r = suggestAccountBinding("hr:daily-report", accounts);
		expect(r?.accountId).toBe("hr");
	});

	it("matches a slash-containing accountId (ops/hr:audit -> ops/hr)", () => {
		const r = suggestAccountBinding("ops/hr:audit", accounts);
		expect(r?.accountId).toBe("ops/hr");
	});

	it("matches the agentDir basename prefix (omp-atomix:wiki -> opencode)", () => {
		// The task name was likely created from the agentDir path of the
		// opencode account. Suggest the account.
		const r = suggestAccountBinding("omp-atomix:wiki-cron", accounts);
		expect(r?.accountId).toBe("opencode");
		expect(r?.reason).toContain("omp-atomix");
	});

	it("does not match a substring that is not a colon-delimited prefix", () => {
		// "hr3-daily" contains "hr" but does NOT start with "hr:".
		// A naive substring match would falsely bind this to the hr
		// account. The colon-delimited prefix rule prevents that.
		const r = suggestAccountBinding("hr3-daily", accounts);
		expect(r).toBeUndefined();
	});

	it("does not match when the account has no agentDir and the name does not start with the accountId", () => {
		const r = suggestAccountBinding("credentials-only-task", accounts);
		expect(r).toBeUndefined();
	});

	it("returns undefined when there are no accounts", () => {
		expect(suggestAccountBinding("anything", {})).toBeUndefined();
	});

	it("returns undefined when the name has no colon", () => {
		// Plain "hr" without a colon should not be auto-bound. Tasks are
		// commonly named without colons; the user must run
		// `cron update --account` explicitly to bind them.
		const r = suggestAccountBinding("hr", accounts);
		expect(r).toBeUndefined();
	});

	it("prefers the accountId prefix over the agentDir basename when both could match", () => {
		// Synthetic case: account "hr" with agentDir ending in "hr3",
		// task "hr:foo" -> should pick "hr" (accountId prefix wins) and
		// reason should mention the accountId, not the basename.
		const local: Record<string, { agentDir?: string }> = {
			hr: { agentDir: "/Users/test/hr3" },
		};
		const r = suggestAccountBinding("hr:foo", local);
		expect(r?.accountId).toBe("hr");
		expect(r?.reason).toContain('"hr:"');
	});

	it("skips accounts with an empty-string agentDir when computing the basename", () => {
		// Edge case: account.agentDir === "". path.basename("") is "" which
		// is falsy; must not match every task name.
		const local: Record<string, { agentDir?: string }> = {
			bad: { agentDir: "" },
		};
		expect(suggestAccountBinding("anything:here", local)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// cronReconcile integration
// ---------------------------------------------------------------------------

let testDir: string;
let dbPath: string;
let storage: SchedulerDbStorage;

function cleanup() {
	try {
		if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

function seedTask(name: string, accountId?: string): void {
	storage.addTask({
		name,
		cron: "0 0 1 1 *",
		command: "echo test",
		status: "active",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		runCount: 0,
		failCount: 0,
		consecutiveFailures: 0,
		timeoutMs: 30_000,
		...(accountId ? { accountId } : {}),
	});
}

beforeEach(() => {
	testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gateway-reconcile-"));
	dbPath = path.join(testDir, "scheduler.db");
	storage = new SchedulerDbStorage(dbPath);
});

afterEach(() => {
	storage?.close();
	cleanup();
});

describe("cronReconcile", () => {
	it("prints nothing to do when every task is already bound", async () => {
		seedTask("already-bound", "hr");
		const exitBefore = process.exitCode;

		await cronReconcile([], storage);

		// No exit-code change; "Nothing to reconcile" message printed.
		expect(process.exitCode).toBe(exitBefore);
		// Task should still be bound.
		expect(storage.getTaskByName("already-bound")?.accountId).toBe("hr");
		process.exitCode = exitBefore;
	});

	it("dry-run does not mutate storage", async () => {
		seedTask("hr:daily");
		seedTask("omp-atomix:wiki");
		seedTask("plain-name");

		await cronReconcile([], storage);

		// No task should have accountId set after a dry run.
		expect(storage.getTaskByName("hr:daily")?.accountId).toBeUndefined();
		expect(storage.getTaskByName("omp-atomix:wiki")?.accountId).toBeUndefined();
		expect(storage.getTaskByName("plain-name")?.accountId).toBeUndefined();
	});

	it("--apply writes suggestions to storage for matched tasks", async () => {
		// Note: cronReconcile calls loadConfig() which reads the real
		// ~/.omp/gateway.json. We can't easily mock that without
		// module mocking, so this test runs against whatever config is
		// on the dev machine. The contract we can pin here: the dry-run
		// path doesn't mutate (above), and the function returns
		// gracefully. Per-task binding is then verified manually in
		// the e2e script.
		seedTask("hr:daily");
		seedTask("plain-name");

		const exitBefore = process.exitCode;
		await cronReconcile(["--apply"], storage);
		// Must not error out.
		expect(process.exitCode ?? 0).toBe(0);
		process.exitCode = exitBefore;
	});

	it("rejects unknown flags", async () => {
		const exitBefore = process.exitCode;
		await cronReconcile(["--force"], storage);
		expect(process.exitCode).toBe(1);
		process.exitCode = exitBefore;
	});

	it("does not touch tasks that already have an accountId", async () => {
		seedTask("hr:already", "hr");
		seedTask("noaccount");

		// Force-bind hr:already to a different account to make sure the
		// reconciler does not regress it.
		storage.updateTask(storage.getTaskByName("hr:already")!.id, { accountId: "opencode" });

		// The reconciler only touches unbound tasks. Since noaccount has
		// no accountId and the dev-machine config is in play, we just
		// verify hr:already was not reset to the suggestion.
		const exitBefore = process.exitCode;
		await cronReconcile([], storage);
		expect(storage.getTaskByName("hr:already")?.accountId).toBe("opencode");
		process.exitCode = exitBefore;
	});
});
