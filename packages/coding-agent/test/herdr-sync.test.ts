import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Subprocess } from "bun";
import { sanitizeAgentName, syncSessionTitleToHerdrPane } from "../src/utils/herdr-sync";

type SpawnOptions = Bun.SpawnOptions.SpawnOptions<
	Bun.SpawnOptions.Writable,
	Bun.SpawnOptions.Readable,
	Bun.SpawnOptions.Readable
>;

type SpawnCall = {
	cmd: string[];
};

const ENV_KEYS = ["HERDR_ENV", "HERDR_PANE_ID"] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map(k => [k, process.env[k]]));

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
	for (const key of ENV_KEYS) {
		const value = values[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function createFakeProcess(exitCode = 0, opts?: { kill?: () => void; hung?: boolean }): Subprocess {
	return {
		pid: 12345,
		stdout: new Response("").body!,
		stderr: new Response("").body!,
		exited: opts?.hung ? new Promise<number>(() => {}) : Promise.resolve(exitCode),
		kill: opts?.kill ?? (() => {}),
	} as Subprocess;
}

function createSpawnMock(calls: SpawnCall[], exitCode = 0, opts?: { kill?: () => void; hung?: boolean }) {
	function mockSpawn(options: SpawnOptions & { cmd: string[] }): Subprocess;
	function mockSpawn(cmd: string[], options?: SpawnOptions): Subprocess;
	function mockSpawn(first: string[] | (SpawnOptions & { cmd: string[] }), _second?: SpawnOptions): Subprocess {
		calls.push({ cmd: Array.isArray(first) ? first : first.cmd });
		return createFakeProcess(exitCode, opts);
	}

	return mockSpawn;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("sanitizeAgentName", () => {
	it("keeps valid simple names", () => {
		expect(sanitizeAgentName("t1")).toBe("t1");
		expect(sanitizeAgentName("omp-fronted")).toBe("omp-fronted");
	});

	it("lowercases and normalizes separators", () => {
		expect(sanitizeAgentName("My Session 1")).toBe("my-session-1");
		expect(sanitizeAgentName("OMP-TEST_2")).toBe("omp-test_2");
	});

	it("returns undefined when no legal name can be produced", () => {
		expect(sanitizeAgentName("完整链路验证")).toBeUndefined();
		expect(sanitizeAgentName("123abc")).toBeUndefined();
		expect(sanitizeAgentName("!!!")).toBeUndefined();
	});

	it("truncates to 32 characters", () => {
		const long = `a${"b".repeat(40)}`;
		const result = sanitizeAgentName(long);
		expect(result).toBeDefined();
		expect(result!.length).toBeLessThanOrEqual(32);
	});
});

describe("syncSessionTitleToHerdrPane", () => {
	it("skips without spawning when HERDR_ENV is not 1", async () => {
		const spawn = vi.spyOn(Bun, "spawn");
		setEnv({ HERDR_ENV: undefined, HERDR_PANE_ID: "w1:p1" });

		await syncSessionTitleToHerdrPane("my-session");

		expect(spawn).not.toHaveBeenCalled();
	});

	it("skips without spawning when HERDR_PANE_ID is missing", async () => {
		const spawn = vi.spyOn(Bun, "spawn");
		setEnv({ HERDR_ENV: "1", HERDR_PANE_ID: undefined });

		await syncSessionTitleToHerdrPane("my-session");

		expect(spawn).not.toHaveBeenCalled();
	});

	it("renames the agent with the legalized session title", async () => {
		const spawnCalls: SpawnCall[] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock(spawnCalls));
		setEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" });

		await syncSessionTitleToHerdrPane("omp-fronted");

		expect(spawnCalls).toEqual([{ cmd: ["herdr", "agent", "rename", "w1:p1", "omp-fronted"] }]);
	});

	it("clears the agent name when title cannot be legalized", async () => {
		const spawnCalls: SpawnCall[] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock(spawnCalls));
		setEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" });

		await syncSessionTitleToHerdrPane("完整链路验证");

		expect(spawnCalls).toEqual([{ cmd: ["herdr", "agent", "rename", "w1:p1", "--clear"] }]);
	});

	it("clears the agent name when the title is empty", async () => {
		const spawnCalls: SpawnCall[] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock(spawnCalls));
		setEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" });

		await syncSessionTitleToHerdrPane("");

		expect(spawnCalls).toEqual([{ cmd: ["herdr", "agent", "rename", "w1:p1", "--clear"] }]);
	});

	it("does not throw when herdr exits non-zero", async () => {
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock([], 1));
		setEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" });

		await expect(syncSessionTitleToHerdrPane("x")).resolves.toBeUndefined();
	});

	it("does not throw when spawning herdr fails", async () => {
		vi.spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("herdr not found");
		});
		setEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" });

		await expect(syncSessionTitleToHerdrPane("x")).resolves.toBeUndefined();
	});

	it("kills a hung herdr process after the timeout", async () => {
		const kill = vi.fn();
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock([], 0, { kill, hung: true }));
		vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
		setEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" });

		await syncSessionTitleToHerdrPane("x");

		expect(kill).toHaveBeenCalled();
	});
});
