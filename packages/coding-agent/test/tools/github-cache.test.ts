import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@cornfield/coding-agent/config/settings";
import {
	type CacheLookupOptions,
	formatCacheNotice,
	getCached,
	getOrFetchView,
	invalidate,
	invalidateAllForNumber,
	invalidateAllForRepo,
	putCached,
	resetGithubCacheForTests,
	resolveCacheTtl,
	resolveGithubCacheAuthKey,
} from "@cornfield/coding-agent/tools/github-cache";
import { getGithubCacheDbPath, setConfigRootDir } from "@cornfield/utils";

/** Row identity used by the behavior tests: explicit, so assertions never
 *  depend on this machine's real `gh` credentials. */
const TEST_AUTH_KEY = "test";
const CREDENTIAL_ENV_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
const OTHER_ENV_VARS = ["GH_CONFIG_DIR", "GH_HOST", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"];

/** A fixed instant, so ages are exact rather than "roughly now". */
const T0 = Date.parse("2026-09-16T00:00:00Z");
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

interface View {
	title: string;
}

const settings = Settings.isolated({ "github.enabled": true });

let configRoot: string;
let ghConfigDir: string;
let savedEnv: Record<string, string | undefined>;

function advance(ms: number): void {
	vi.advanceTimersByTime(ms);
}

/** Let the background-refresh promise settle without moving the clock. */
async function flushMicrotasks(rounds = 10): Promise<void> {
	for (let round = 0; round < rounds; round += 1) {
		await Promise.resolve();
	}
}

function issueOptions(
	fetchFresh: () => Promise<View>,
	overrides: Partial<CacheLookupOptions<View>> = {},
): CacheLookupOptions<View> {
	return {
		repo: "cli/cli",
		kind: "issue",
		number: 42,
		includeComments: true,
		authKey: TEST_AUTH_KEY,
		settings,
		fetchFresh,
		...overrides,
	};
}

/** A fresh fetcher that hands out `rev N` and counts its calls. */
function revisionFetcher(): { fetchFresh: () => Promise<View>; calls: () => number; fail: (value: boolean) => void } {
	let calls = 0;
	let failing = false;
	return {
		calls: () => calls,
		fail: (value: boolean) => {
			failing = value;
		},
		fetchFresh: async () => {
			calls += 1;
			if (failing) throw new Error("gh exploded");
			return { title: `rev ${calls}` };
		},
	};
}

beforeEach(async () => {
	configRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gh-cache-root-"));
	ghConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-cache-gh-"));
	savedEnv = {};
	for (const name of [...CREDENTIAL_ENV_VARS, ...OTHER_ENV_VARS]) {
		savedEnv[name] = process.env[name];
		delete process.env[name];
	}
	process.env.GH_CONFIG_DIR = ghConfigDir;
	process.env.GH_TOKEN = "token-a";
	setConfigRootDir(configRoot);
	resetGithubCacheForTests();
	vi.useFakeTimers({ now: T0 });
	// The cache must land under the temp root: an XDG override or a leaked
	// config root would write test rows into the user's real cache.
	expect(getGithubCacheDbPath().startsWith(configRoot)).toBe(true);
});

afterEach(async () => {
	vi.useRealTimers();
	resetGithubCacheForTests();
	setConfigRootDir(undefined);
	for (const [name, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	await fs.rm(configRoot, { recursive: true, force: true });
	await fs.rm(ghConfigDir, { recursive: true, force: true });
});

describe("github view cache", () => {
	it("fetches once and serves the stored view on the next call", async () => {
		const fetcher = revisionFetcher();
		const options = issueOptions(fetcher.fetchFresh);

		const first = await getOrFetchView(options);
		expect(first.status).toBe("miss");
		expect(first.payload.title).toBe("rev 1");
		expect(first.fetchedAt).toBe(T0);

		const second = await getOrFetchView(options);
		expect(second.status).toBe("fresh");
		expect(second.payload.title).toBe("rev 1");
		expect(second.fetchedAt).toBe(T0);
		expect(fetcher.calls()).toBe(1);
	});

	it("refreshes synchronously past the soft TTL", async () => {
		const fetcher = revisionFetcher();
		const options = issueOptions(fetcher.fetchFresh);
		await getOrFetchView(options);

		advance(300_001);

		const refreshed = await getOrFetchView(options);
		expect(refreshed.status).toBe("refreshed");
		expect(refreshed.payload.title).toBe("rev 2");
		// The refreshed row restarts the soft window.
		expect((await getOrFetchView(options)).status).toBe("fresh");
		expect(fetcher.calls()).toBe(2);
	});

	it("serves the stale view when the synchronous refresh fails", async () => {
		const fetcher = revisionFetcher();
		const options = issueOptions(fetcher.fetchFresh);
		await getOrFetchView(options);

		advance(300_001);
		fetcher.fail(true);
		const stale = await getOrFetchView(options);
		expect(stale.status).toBe("stale");
		expect(stale.payload.title).toBe("rev 1");
		expect(stale.fetchedAt).toBe(T0);

		// The failed refresh did not overwrite the row.
		fetcher.fail(false);
		const stored = getCached<View>("cli/cli", "issue", 42, true, TEST_AUTH_KEY);
		expect(stored?.payload.title).toBe("rev 1");
		expect(stored?.fetchedAt).toBe(T0);
		expect(fetcher.calls()).toBe(2);
	});

	it("drops the row past the hard TTL and fetches live", async () => {
		const fetcher = revisionFetcher();
		const options = issueOptions(fetcher.fetchFresh);
		await getOrFetchView(options);

		advance(604_800_000 + 1);

		const after = await getOrFetchView(options);
		expect(after.status).toBe("miss");
		expect(after.payload.title).toBe("rev 2");
		expect(getCached<View>("cli/cli", "issue", 42, true, TEST_AUTH_KEY)?.payload.title).toBe("rev 2");
	});

	it("does not fall back to a row it just expired past the hard TTL", async () => {
		const fetcher = revisionFetcher();
		const options = issueOptions(fetcher.fetchFresh);
		await getOrFetchView(options);

		advance(604_800_000 + 1);
		fetcher.fail(true);

		await expect(getOrFetchView(options)).rejects.toThrow("gh exploded");
		expect(getCached("cli/cli", "issue", 42, true, TEST_AUTH_KEY)).toBeNull();
	});

	it("never stores a failed fetch", async () => {
		const fetcher = revisionFetcher();
		const options = issueOptions(fetcher.fetchFresh);
		fetcher.fail(true);

		await expect(getOrFetchView(options)).rejects.toThrow("gh exploded");
		expect(getCached("cli/cli", "issue", 42, true, TEST_AUTH_KEY)).toBeNull();

		fetcher.fail(false);
		const recovered = await getOrFetchView(options);
		expect(recovered.status).toBe("miss");
		expect(recovered.payload.title).toBe("rev 2");
		expect(fetcher.calls()).toBe(2);
	});

	it("serves a stale diff immediately and refreshes it once in the background", async () => {
		let calls = 0;
		const fetchFresh = async (): Promise<string> => {
			calls += 1;
			return `diff ${calls}`;
		};
		const options: CacheLookupOptions<string> = {
			repo: "cli/cli",
			kind: "pr-diff",
			number: 7,
			includeComments: false,
			authKey: TEST_AUTH_KEY,
			settings,
			fetchFresh,
		};

		expect((await getOrFetchView(options)).payload).toBe("diff 1");
		advance(300_001);

		// Two concurrent stale reads must share one refresh, not spawn two.
		const [a, b] = await Promise.all([getOrFetchView(options), getOrFetchView(options)]);
		expect(a.status).toBe("stale");
		expect(b.status).toBe("stale");
		expect(a.payload).toBe("diff 1");

		await flushMicrotasks();
		expect(calls).toBe(2);

		const refreshed = await getOrFetchView(options);
		expect(refreshed.status).toBe("fresh");
		expect(refreshed.payload).toBe("diff 2");
	});

	it("keeps a failed background refresh from disturbing the served row", async () => {
		let calls = 0;
		let failing = false;
		const fetchFresh = async (): Promise<string> => {
			calls += 1;
			if (failing) throw new Error("gh exploded");
			return `diff ${calls}`;
		};
		const options: CacheLookupOptions<string> = {
			repo: "cli/cli",
			kind: "pr-diff",
			number: 7,
			includeComments: false,
			authKey: TEST_AUTH_KEY,
			settings,
			fetchFresh,
		};

		await getOrFetchView(options);
		advance(300_001);
		failing = true;

		const stale = await getOrFetchView(options);
		expect(stale.status).toBe("stale");
		expect(stale.payload).toBe("diff 1");

		await flushMicrotasks();
		expect(calls).toBe(2);
		expect(getCached<string>("cli/cli", "pr-diff", 7, false, TEST_AUTH_KEY)?.payload).toBe("diff 1");
	});

	it("fetches live and stores nothing when the cache is disabled", async () => {
		const disabled = Settings.isolated({ "github.enabled": true, "github.cache.enabled": false });
		const fetcher = revisionFetcher();
		const options = issueOptions(fetcher.fetchFresh, { settings: disabled });

		const first = await getOrFetchView(options);
		expect(first.status).toBe("disabled");
		expect(first.payload.title).toBe("rev 1");

		const second = await getOrFetchView(options);
		expect(second.status).toBe("disabled");
		expect(second.payload.title).toBe("rev 2");
		expect(getCached("cli/cli", "issue", 42, true, TEST_AUTH_KEY)).toBeNull();
	});

	it("bypasses the cache when no credential fingerprint is visible", async () => {
		delete process.env.GH_TOKEN;
		expect(resolveGithubCacheAuthKey()).toBeUndefined();

		const fetcher = revisionFetcher();
		const options = issueOptions(fetcher.fetchFresh, { authKey: undefined });

		expect((await getOrFetchView(options)).status).toBe("bypassed");
		expect((await getOrFetchView(options)).payload.title).toBe("rev 2");
		expect(fetcher.calls()).toBe(2);
		expect(getCached("cli/cli", "issue", 42, true)).toBeNull();
	});

	it("bypasses the cache when the request names no row identity", async () => {
		const fetcher = revisionFetcher();
		const options = issueOptions(fetcher.fetchFresh, { repo: undefined, number: undefined });

		expect((await getOrFetchView(options)).status).toBe("bypassed");
		expect((await getOrFetchView(options)).status).toBe("bypassed");
		expect(fetcher.calls()).toBe(2);
	});

	it("does not answer across a credential change", async () => {
		const fetcher = revisionFetcher();
		const options = issueOptions(fetcher.fetchFresh, { authKey: undefined });

		expect((await getOrFetchView(options)).payload.title).toBe("rev 1");

		process.env.GH_TOKEN = "token-b";
		const other = await getOrFetchView(options);
		expect(other.status).toBe("miss");
		expect(other.payload.title).toBe("rev 2");

		// The first account's row is still there, under its own fingerprint.
		process.env.GH_TOKEN = "token-a";
		const back = await getOrFetchView(options);
		expect(back.status).toBe("fresh");
		expect(back.payload.title).toBe("rev 1");
		expect(fetcher.calls()).toBe(2);
	});

	it("moves to a new fingerprint when gh's hosts.yml changes", async () => {
		delete process.env.GH_TOKEN;
		const hostsPath = path.join(ghConfigDir, "hosts.yml");
		const writeHosts = async (token: string, mtimeMs: number): Promise<void> => {
			await fs.writeFile(hostsPath, `github.com:\n    oauth_token: ${token}\n`);
			await fs.utimes(hostsPath, new Date(mtimeMs), new Date(mtimeMs));
		};

		await writeHosts("token-a", T0);
		const firstKey = resolveGithubCacheAuthKey();
		expect(firstKey).toBeDefined();

		const fetcher = revisionFetcher();
		const options = issueOptions(fetcher.fetchFresh, { authKey: undefined });
		expect((await getOrFetchView(options)).payload.title).toBe("rev 1");

		await writeHosts("token-b", T0 + MINUTE_MS);
		expect(resolveGithubCacheAuthKey()).not.toBe(firstKey);
		const rotated = await getOrFetchView(options);
		expect(rotated.status).toBe("miss");
		expect(rotated.payload.title).toBe("rev 2");

		await writeHosts("token-a", T0 + 2 * MINUTE_MS);
		expect(resolveGithubCacheAuthKey()).toBe(firstKey);
		expect((await getOrFetchView(options)).payload.title).toBe("rev 1");
		expect(fetcher.calls()).toBe(2);
	});

	it("keys comment and no-comment views separately", async () => {
		const fetcher = revisionFetcher();
		expect((await getOrFetchView(issueOptions(fetcher.fetchFresh, { includeComments: false }))).payload.title).toBe(
			"rev 1",
		);
		expect((await getOrFetchView(issueOptions(fetcher.fetchFresh, { includeComments: true }))).payload.title).toBe(
			"rev 2",
		);
		expect((await getOrFetchView(issueOptions(fetcher.fetchFresh, { includeComments: false }))).payload.title).toBe(
			"rev 1",
		);
		expect(fetcher.calls()).toBe(2);
	});

	it("keys pr_diff variants separately", async () => {
		let calls = 0;
		const fetchFresh = async (): Promise<string> => {
			calls += 1;
			return `diff ${calls}`;
		};
		const diffOptions = (variant: string): CacheLookupOptions<string> => ({
			repo: "cli/cli",
			kind: "pr-diff",
			number: 7,
			variant,
			includeComments: false,
			authKey: TEST_AUTH_KEY,
			settings,
			fetchFresh,
		});

		expect((await getOrFetchView(diffOptions(""))).payload).toBe("diff 1");
		expect((await getOrFetchView(diffOptions("name-only"))).payload).toBe("diff 2");
		expect((await getOrFetchView(diffOptions("name-only|exclude=docs/**"))).payload).toBe("diff 3");

		expect((await getOrFetchView(diffOptions("name-only"))).payload).toBe("diff 2");
		expect(calls).toBe(3);
	});

	it("treats a github.com-qualified slug as the same row", async () => {
		const fetcher = revisionFetcher();
		await getOrFetchView(issueOptions(fetcher.fetchFresh));

		const qualified = await getOrFetchView(issueOptions(fetcher.fetchFresh, { repo: "github.com/cli/cli" }));
		expect(qualified.status).toBe("fresh");
		expect(fetcher.calls()).toBe(1);
	});

	it("keeps rows for another host apart", async () => {
		const fetcher = revisionFetcher();
		await getOrFetchView(issueOptions(fetcher.fetchFresh));

		const other = await getOrFetchView(issueOptions(fetcher.fetchFresh, { repo: "ghe.example.com/cli/cli" }));
		expect(other.status).toBe("miss");
		expect(fetcher.calls()).toBe(2);
	});

	it("invalidates by row, by number and by repo", async () => {
		const fetcher = revisionFetcher();
		await getOrFetchView(issueOptions(fetcher.fetchFresh, { includeComments: false }));
		await getOrFetchView(issueOptions(fetcher.fetchFresh, { kind: "pr", number: 42 }));
		await getOrFetchView(issueOptions(fetcher.fetchFresh, { repo: "other/repo" }));

		invalidate("cli/cli", "issue", 42, { includeComments: false }, TEST_AUTH_KEY);
		expect(getCached("cli/cli", "issue", 42, false, TEST_AUTH_KEY)).toBeNull();
		expect(getCached("cli/cli", "pr", 42, true, TEST_AUTH_KEY)).not.toBeNull();

		invalidateAllForNumber(42, "other/repo");
		expect(getCached("other/repo", "issue", 42, true, TEST_AUTH_KEY)).toBeNull();
		expect(getCached("cli/cli", "pr", 42, true, TEST_AUTH_KEY)).not.toBeNull();

		invalidateAllForRepo();
		expect(getCached("cli/cli", "pr", 42, true, TEST_AUTH_KEY)).toBeNull();
	});

	it("sweeps rows past the configured retention on the next lookup", async () => {
		const tight = Settings.isolated({
			"github.enabled": true,
			"github.cache.softTtlSec": 0,
			"github.cache.hardTtlSec": 10,
		});
		const fetcher = revisionFetcher();
		await getOrFetchView(issueOptions(fetcher.fetchFresh, { number: 1, settings: tight }));
		await getOrFetchView(issueOptions(fetcher.fetchFresh, { number: 2, settings: tight }));

		advance(61_000);
		await getOrFetchView(issueOptions(fetcher.fetchFresh, { number: 3, settings: tight }));

		expect(getCached("cli/cli", "issue", 1, true, TEST_AUTH_KEY)).toBeNull();
		expect(getCached("cli/cli", "issue", 2, true, TEST_AUTH_KEY)).toBeNull();
	});

	it("keeps the cache file private and in WAL mode", async () => {
		const fetcher = revisionFetcher();
		await getOrFetchView(issueOptions(fetcher.fetchFresh));

		const dbPath = getGithubCacheDbPath();
		if (process.platform !== "win32") {
			expect((await fs.stat(dbPath)).mode & 0o777).toBe(0o600);
			expect((await fs.stat(`${dbPath}-wal`)).mode & 0o777).toBe(0o600);
		}

		const reader = new Database(dbPath, { readonly: true });
		try {
			// WAL is what lets a second agent process read while this one writes.
			expect(reader.prepare<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
		} finally {
			reader.close();
		}
	});

	it("keeps fetching live when the cache database cannot be opened", async () => {
		await fs.mkdir(getGithubCacheDbPath(), { recursive: true });
		resetGithubCacheForTests();

		const fetcher = revisionFetcher();
		const options = issueOptions(fetcher.fetchFresh);
		expect((await getOrFetchView(options)).payload.title).toBe("rev 1");
		expect((await getOrFetchView(options)).payload.title).toBe("rev 2");
		expect(fetcher.calls()).toBe(2);
	});

	it("skips a row whose payload cannot be serialized", () => {
		putCached<undefined>({
			repo: "cli/cli",
			kind: "issue",
			number: 42,
			includeComments: true,
			authKey: TEST_AUTH_KEY,
			payload: undefined,
		});
		expect(getCached("cli/cli", "issue", 42, true, TEST_AUTH_KEY)).toBeNull();
	});

	it("resolves the configured TTLs, never letting retention fall inside the soft window", () => {
		expect(resolveCacheTtl(Settings.isolated({}))).toEqual({
			softMs: 300_000,
			hardMs: 604_800_000,
			enabled: true,
		});
		expect(
			resolveCacheTtl(Settings.isolated({ "github.cache.softTtlSec": 60, "github.cache.hardTtlSec": 10 })),
		).toEqual({ softMs: 60_000, hardMs: 60_000, enabled: true });
		expect(resolveCacheTtl(Settings.isolated({ "github.cache.softTtlSec": -5 })).softMs).toBe(0);
		expect(resolveCacheTtl(Settings.isolated({ "github.cache.enabled": false })).enabled).toBe(false);
	});

	it("marks cached output, and says why a live refresh did not happen", () => {
		expect(formatCacheNotice("miss", T0)).toBeUndefined();
		expect(formatCacheNotice("refreshed", T0)).toBeUndefined();
		expect(formatCacheNotice("disabled", T0)).toBeUndefined();
		expect(formatCacheNotice("bypassed", T0)).toBeUndefined();

		expect(formatCacheNotice("fresh", Date.now())).toBe("[Cached: fetched 0s ago]");

		advance(4 * MINUTE_MS);
		expect(formatCacheNotice("fresh", T0)).toBe("[Cached: fetched 4m ago]");
		expect(formatCacheNotice("stale", T0)).toContain("live refresh failed or is still running");

		advance(2 * HOUR_MS);
		expect(formatCacheNotice("fresh", T0)).toBe("[Cached: fetched 2h ago]");
	});
});
