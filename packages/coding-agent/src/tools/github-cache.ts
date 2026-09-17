/**
 * SQLite-backed cache for the `github` tool's view ops (`issue_view`,
 * `pr_view`, `pr_diff`), so a repeated read of the same issue or pull request
 * does not cost another `gh` round trip.
 *
 * Rows hold the *fetched* payload, not the rendered text. Rendering stays in
 * `gh.ts` and runs on every call, so a formatting change takes effect
 * immediately instead of hiding behind a row that is still within its TTL.
 *
 * Storage:
 *   One process-wide connection opens lazily on first use and stays open. Every
 *   helper swallows open/IO failures and degrades to "no cache" — a corrupt or
 *   unreadable cache file must never block a `gh` call.
 *
 * Freshness (per row, by `fetched_at`):
 *   age <= soft TTL              → cached payload is returned as-is.
 *   soft TTL < age <= hard TTL   → `issue` / `pr` are stateful and cheap to
 *                                  re-read, so they refresh synchronously and
 *                                  fall back to the cached payload when the
 *                                  live fetch fails; `pr-diff` is expensive
 *                                  (large diffs fall back to the per-file API)
 *                                  so it is served from cache immediately and
 *                                  refreshed in the background.
 *   age > hard TTL               → the row is dropped first, then fetched live,
 *                                  so a failed fetch cannot resurrect it.
 *   no row identity, cache disabled, or no credential fingerprint → fetch live.
 *
 * A failed fetch is never stored: one 500 must not freeze "nothing found" into
 * the cache for the rest of the retention window.
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getGithubCacheDbPath, logger } from "@cornfield/utils";
import type { Settings } from "../config/settings";
import { ToolAbortError } from "./tool-errors";

// ════════════════════════════════════════════════════════════════════════════
// Storage layer
// ════════════════════════════════════════════════════════════════════════════

/** The three view shapes the cache stores. */
export type CacheKind = "issue" | "pr" | "pr-diff";

/** Credential namespace used when a caller does not supply one. */
const DEFAULT_CACHE_AUTH_KEY = "default";

/** Upstream defaults: five minutes of trust, seven days of retention. */
const DEFAULT_SOFT_TTL_SEC = 300;
const DEFAULT_HARD_TTL_SEC = 604_800;

/**
 * Throttle for the per-lookup retention sweep. Every cached read issuing a
 * DELETE would be wasteful; once a minute caps the on-disk exposure window at
 * roughly `hardTtlMs + SWEEP_INTERVAL_MS`.
 */
const SWEEP_INTERVAL_MS = 60_000;

const GITHUB_HOST = "github.com";

/** Environment variables the GitHub CLI reads its token from, in its own priority order. */
const AUTH_KEY_TOKEN_ENV_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const;

export interface CachedView<T = unknown> {
	authKey: string;
	repo: string;
	kind: CacheKind;
	number: number;
	variant: string;
	includeComments: boolean;
	fetchedAt: number;
	payload: T;
}

interface Row {
	auth_key: string;
	repo: string;
	kind: CacheKind;
	number: number;
	variant: string;
	include_comments: number;
	fetched_at: number;
	payload: string;
}

/**
 * The cached connection, remembered together with the path it was opened for:
 * the config root can move at runtime (tests, `setAgentDir` in gateway/serve),
 * and a handle opened for the previous root would keep answering from the
 * previous file.
 */
let cachedDb: { path: string; db: Database } | null = null;
/** Path whose open already failed — retried only after a {@link resetForTests}. */
let failedOpenPath: string | null = null;

function ensureParentDir(filePath: string): void {
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	} catch (err) {
		logger.debug("github cache: failed to create private parent dir", { err: String(err) });
	}
}

function chmodIfExists(filePath: string, mode: number): void {
	try {
		fs.chmodSync(filePath, mode);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			logger.debug("github cache: chmod failed", { err: String(err), path: filePath });
		}
	}
}

/** The cache holds issue/PR bodies behind the credential fingerprint, so the
 * file and its WAL sidecars must not be world-readable. */
function protectDbFiles(dbPath: string): void {
	chmodIfExists(dbPath, 0o600);
	chmodIfExists(`${dbPath}-wal`, 0o600);
	chmodIfExists(`${dbPath}-shm`, 0o600);
}

function closeCachedDb(): void {
	const current = cachedDb;
	cachedDb = null;
	try {
		current?.db.close();
	} catch {
		// Closing failures are non-fatal.
	}
}

/**
 * Open (and cache) the view cache database. Returns null when the cache cannot
 * be opened — callers must then fall back to fetching live.
 */
export function openGithubCacheDb(): Database | null {
	const dbPath = getGithubCacheDbPath();
	if (cachedDb?.path === dbPath) return cachedDb.db;
	closeCachedDb();
	if (failedOpenPath === dbPath) return null;
	failedOpenPath = dbPath;

	try {
		ensureParentDir(dbPath);
		const db = new Database(dbPath);
		// Install the busy handler before any lock-taking statement, then switch
		// to WAL so concurrent agent processes can read while one writes.
		db.run("PRAGMA busy_timeout=5000");
		db.run("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
		// The cache is regenerable, so a table whose key predates the current
		// schema is dropped rather than migrated in place.
		const userVersion = (db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)
			?.user_version;
		if (userVersion !== undefined && userVersion < 1) {
			db.run("DROP TABLE IF EXISTS github_view_cache");
		}
		db.run(`
			CREATE TABLE IF NOT EXISTS github_view_cache (
				auth_key         TEXT    NOT NULL,
				repo             TEXT    NOT NULL,
				kind             TEXT    NOT NULL CHECK (kind IN ('issue','pr','pr-diff')),
				number           INTEGER NOT NULL,
				variant          TEXT    NOT NULL DEFAULT '',
				include_comments INTEGER NOT NULL,
				fetched_at       INTEGER NOT NULL,
				payload          TEXT    NOT NULL,
				PRIMARY KEY (auth_key, repo, kind, number, variant, include_comments)
			);
			CREATE INDEX IF NOT EXISTS idx_github_view_cache_fetched ON github_view_cache(fetched_at);
			PRAGMA user_version = 1;
		`);
		protectDbFiles(dbPath);
		cachedDb = { path: dbPath, db };
		return db;
	} catch (err) {
		logger.warn("github cache: failed to open DB; cache disabled", { err: String(err), path: dbPath });
		return null;
	}
}

function evictExpired(db: Database, hardTtlMs: number): void {
	try {
		db.prepare("DELETE FROM github_view_cache WHERE fetched_at < ?").run(Date.now() - hardTtlMs);
	} catch (err) {
		logger.debug("github cache: eviction failed", { err: String(err) });
	}
}

let lastSweepAt = 0;

/**
 * Enforce the *configured* hard TTL against on-disk rows: without this the
 * retention window would only be honored by whatever ran last.
 */
function sweepIfDue(hardTtlMs: number): void {
	const now = Date.now();
	if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
	const db = openGithubCacheDb();
	if (!db) return;
	lastSweepAt = now;
	evictExpired(db, hardTtlMs);
}

/** Drop the cached connection, credential memo and sweep throttle. */
export function resetGithubCacheForTests(): void {
	closeCachedDb();
	failedOpenPath = null;
	lastSweepAt = 0;
	authKeyMemo = undefined;
}

/** Repo rows for the same repository must not fork on how it was spelled: a
 * bare `owner/repo` means the host `gh` defaults to, so a prefix naming that
 * same host is dropped. A prefix naming *another* host is kept — under
 * `GH_HOST` a bare slug points somewhere else entirely. */
function normalizeRepoKey(repo: string): string {
	const trimmed = repo.trim().toLowerCase();
	const segments = trimmed.split("/");
	if (segments.length === 3 && segments[0] === defaultGhHost()) {
		return `${segments[1]}/${segments[2]}`;
	}
	return trimmed;
}

/** The host `gh` falls back to for a ref that names none. */
function defaultGhHost(): string {
	return (process.env.GH_HOST || GITHUB_HOST).toLowerCase();
}

export function getCached<T = unknown>(
	repo: string,
	kind: CacheKind,
	number: number,
	includeComments: boolean,
	authKey: string = DEFAULT_CACHE_AUTH_KEY,
	variant = "",
): CachedView<T> | null {
	const db = openGithubCacheDb();
	if (!db) return null;
	try {
		const row = db
			.prepare(
				"SELECT auth_key, repo, kind, number, variant, include_comments, fetched_at, payload FROM github_view_cache WHERE auth_key = ? AND repo = ? AND kind = ? AND number = ? AND variant = ? AND include_comments = ?",
			)
			.get(authKey, normalizeRepoKey(repo), kind, number, variant, includeComments ? 1 : 0) as Row | undefined;
		if (!row) return null;
		let payload: T;
		try {
			payload = JSON.parse(row.payload) as T;
		} catch (err) {
			logger.debug("github cache: corrupt payload row, ignoring", { err: String(err), repo, kind, number });
			return null;
		}
		return {
			authKey: row.auth_key,
			repo: row.repo,
			kind: row.kind,
			number: row.number,
			variant: row.variant,
			includeComments: row.include_comments === 1,
			fetchedAt: row.fetched_at,
			payload,
		};
	} catch (err) {
		logger.debug("github cache: read failed", { err: String(err) });
		return null;
	}
}

export interface PutCachedInput<T = unknown> {
	repo: string;
	kind: CacheKind;
	number: number;
	includeComments: boolean;
	authKey?: string;
	variant?: string;
	payload: T;
	fetchedAt?: number;
}

export function putCached<T = unknown>(input: PutCachedInput<T>): void {
	const db = openGithubCacheDb();
	if (!db) return;
	const payloadJson = JSON.stringify(input.payload);
	if (payloadJson === undefined) {
		logger.debug("github cache: payload is not JSON-serializable; row skipped", {
			repo: input.repo,
			kind: input.kind,
			number: input.number,
		});
		return;
	}

	try {
		db.prepare(
			"INSERT OR REPLACE INTO github_view_cache (auth_key, repo, kind, number, variant, include_comments, fetched_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			input.authKey ?? DEFAULT_CACHE_AUTH_KEY,
			normalizeRepoKey(input.repo),
			input.kind,
			input.number,
			input.variant ?? "",
			input.includeComments ? 1 : 0,
			input.fetchedAt ?? Date.now(),
			payloadJson,
		);
		protectDbFiles(getGithubCacheDbPath());
	} catch (err) {
		logger.debug("github cache: write failed", { err: String(err) });
	}
}

/** Narrow a delete to one request shape; omitted fields match every value. */
export interface InvalidateFilter {
	includeComments?: boolean;
	variant?: string;
}

/** Drop every cached row for one view. */
export function invalidate(
	repo: string,
	kind: CacheKind,
	number: number,
	filter: InvalidateFilter = {},
	authKey: string = DEFAULT_CACHE_AUTH_KEY,
): void {
	const db = openGithubCacheDb();
	if (!db) return;
	const clauses = ["auth_key = ?", "repo = ?", "kind = ?", "number = ?"];
	const params: (string | number)[] = [authKey, normalizeRepoKey(repo), kind, number];
	if (filter.includeComments !== undefined) {
		clauses.push("include_comments = ?");
		params.push(filter.includeComments ? 1 : 0);
	}
	if (filter.variant !== undefined) {
		clauses.push("variant = ?");
		params.push(filter.variant);
	}
	try {
		db.prepare(`DELETE FROM github_view_cache WHERE ${clauses.join(" AND ")}`).run(...params);
	} catch (err) {
		logger.debug("github cache: invalidate failed", { err: String(err) });
	}
}

/**
 * Drop every cached row for an issue/PR number, across kinds, credential
 * fingerprints and comment variants — for callers that know *what* changed but
 * not which narrowed request produced the row.
 */
export function invalidateAllForNumber(number: number, repo?: string): void {
	const db = openGithubCacheDb();
	if (!db) return;
	try {
		if (repo === undefined) {
			db.prepare("DELETE FROM github_view_cache WHERE number = ?").run(number);
		} else {
			db.prepare("DELETE FROM github_view_cache WHERE number = ? AND repo = ?").run(number, normalizeRepoKey(repo));
		}
	} catch (err) {
		logger.debug("github cache: invalidateAllForNumber failed", { err: String(err) });
	}
}

/** Drop every cached row for a repo, or all rows when the repo is unknown. */
export function invalidateAllForRepo(repo?: string): void {
	const db = openGithubCacheDb();
	if (!db) return;
	try {
		if (repo === undefined) {
			db.prepare("DELETE FROM github_view_cache").run();
		} else {
			db.prepare("DELETE FROM github_view_cache WHERE repo = ?").run(normalizeRepoKey(repo));
		}
	} catch (err) {
		logger.debug("github cache: invalidateAllForRepo failed", { err: String(err) });
	}
}

// ════════════════════════════════════════════════════════════════════════════
// Credential fingerprint
// ════════════════════════════════════════════════════════════════════════════

/**
 * Memo for {@link resolveGithubCacheAuthKey}. Recomputed only when the token
 * environment or the hosts.yml path/mtime changes, so the cost on the cache hot
 * path is four env reads plus one `stat` instead of a file read and a hash.
 */
let authKeyMemo: { envSig: string; hostsPath: string; hostsMtimeMs: number; value: string | undefined } | undefined;

function getGhConfigDir(): string {
	const override = process.env.GH_CONFIG_DIR;
	if (override) return override;
	const xdg = process.env.XDG_CONFIG_HOME;
	if (xdg) return path.join(xdg, "gh");
	return path.join(os.homedir(), ".config", "gh");
}

/** Length-prefixed join, so `["ab","c"]` and `["a","bc"]` cannot collide. */
function hashCacheIdentity(parts: string[]): string {
	return Bun.hash(parts.map(part => `${part.length}:${part}`).join("|")).toString(36);
}

/**
 * Best-effort local fingerprint of the active GitHub CLI credentials.
 *
 * A cache hit must not cross accounts, but probing `gh api user` before every
 * cached read would defeat the whole point of the cache. So rows are keyed by
 * the credential material the CLI itself consumes — the token environment
 * variables and/or hosts.yml — hashed, never stored verbatim. Returns undefined
 * when no credential source is visible, which tells the caller to bypass the
 * cache entirely rather than answer across accounts.
 */
export function resolveGithubCacheAuthKey(): string | undefined {
	const hostsPath = path.join(getGhConfigDir(), "hosts.yml");
	let envSig = "";
	for (const name of AUTH_KEY_TOKEN_ENV_VARS) {
		const value = process.env[name];
		if (value) envSig += `${name}=${value.length}:${value}\0`;
	}
	let hostsMtimeMs = -1;
	try {
		hostsMtimeMs = fs.statSync(hostsPath, { throwIfNoEntry: false })?.mtimeMs ?? -1;
	} catch (err) {
		logger.debug("github cache: failed to stat gh hosts config for cache identity", { err: String(err) });
	}
	if (
		authKeyMemo &&
		authKeyMemo.envSig === envSig &&
		authKeyMemo.hostsPath === hostsPath &&
		authKeyMemo.hostsMtimeMs === hostsMtimeMs
	) {
		return authKeyMemo.value;
	}

	const parts: string[] = [`host:${defaultGhHost()}`];
	let hasCredentialMaterial = false;
	for (const name of AUTH_KEY_TOKEN_ENV_VARS) {
		const value = process.env[name];
		if (!value) continue;
		hasCredentialMaterial = true;
		parts.push(`${name}:${value}`);
	}
	try {
		parts.push(`hosts:${fs.readFileSync(hostsPath, "utf8")}`);
		hasCredentialMaterial = true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			logger.debug("github cache: failed to read gh hosts config for cache identity", { err: String(err) });
		}
	}

	const value = hasCredentialMaterial ? `${defaultGhHost()}:${hashCacheIdentity(parts)}` : undefined;
	authKeyMemo = { envSig, hostsPath, hostsMtimeMs, value };
	return value;
}

// ════════════════════════════════════════════════════════════════════════════
// Cache-aware lookup
// ════════════════════════════════════════════════════════════════════════════

/**
 * Where a delivered payload came from.
 *
 * `disabled` and `bypassed` are both live fetches and differ only in the
 * reason: the feature is switched off, versus this particular call having no
 * safe row identity (no credential fingerprint, or no repo/number to key on).
 */
export type CacheStatus = "miss" | "fresh" | "refreshed" | "stale" | "disabled" | "bypassed";

export interface CacheLookupResult<T> {
	payload: T;
	status: CacheStatus;
	fetchedAt: number;
}

export interface CacheLookupOptions<T> {
	/** Row identity. A missing `repo` or `number` means the view cannot be cached. */
	repo: string | undefined;
	kind: CacheKind;
	number: number | undefined;
	/**
	 * The part of the request that changes the fetched bytes without changing
	 * the entity it is about (currently only `pr_diff`'s `nameOnly`/`exclude`).
	 * Without it a narrowed request would be answered by a differently narrowed
	 * row.
	 */
	variant?: string;
	includeComments: boolean;
	/** `undefined` fingerprints the ambient credentials; `null` bypasses the cache. */
	authKey?: string | null;
	fetchFresh: () => Promise<T>;
	settings: Settings;
}

export interface CacheTtl {
	softMs: number;
	hardMs: number;
	enabled: boolean;
}

export function resolveCacheTtl(settings: Settings): CacheTtl {
	const softSec = settings.get("github.cache.softTtlSec");
	const hardSec = settings.get("github.cache.hardTtlSec");
	const softMs = Math.max(0, Number.isFinite(softSec) ? softSec : DEFAULT_SOFT_TTL_SEC) * 1000;
	const hardMs = Math.max(0, Number.isFinite(hardSec) ? hardSec : DEFAULT_HARD_TTL_SEC) * 1000;
	return {
		softMs,
		// A hard TTL below the soft TTL would make every fresh row an immediate
		// expiry; the retention window is the outer bound, never the inner one.
		hardMs: Math.max(softMs, hardMs),
		enabled: settings.get("github.cache.enabled"),
	};
}

function storeResult<T>(
	authKey: string,
	repo: string,
	kind: CacheKind,
	number: number,
	variant: string,
	includeComments: boolean,
	payload: T,
	fetchedAt: number,
): void {
	putCached<T>({ authKey, repo, kind, number, variant, includeComments, payload, fetchedAt });
}

/**
 * In-flight background refreshes by row identity: N concurrent stale reads of
 * one row must spawn one `gh` subprocess, not N identical ones.
 */
const inflightRefreshes = new Set<string>();

function scheduleBackgroundRefresh<T>(
	fetchFresh: () => Promise<T>,
	store: (payload: T) => void,
	rowKey: string,
	describeRow: Record<string, unknown>,
): void {
	if (inflightRefreshes.has(rowKey)) return;
	inflightRefreshes.add(rowKey);
	void fetchFresh()
		.then(store)
		.catch(err => {
			// A refresh that failed leaves the served (stale) row in place; the
			// caller already returned, so there is nobody to tell but the log.
			logger.debug("github cache: background refresh failed", { err: String(err), ...describeRow });
		})
		.finally(() => {
			inflightRefreshes.delete(rowKey);
		});
}

/**
 * Return the view for a row identity, fetching it live when the cache cannot
 * answer. `fetchFresh` must either resolve with a payload that came from
 * GitHub or reject — a rejection is never stored.
 */
export async function getOrFetchView<T>(options: CacheLookupOptions<T>): Promise<CacheLookupResult<T>> {
	const ttl = resolveCacheTtl(options.settings);
	const { repo, number } = options;
	const variant = options.variant ?? "";
	const authKey = options.authKey === undefined ? resolveGithubCacheAuthKey() : options.authKey;

	const cacheable = authKey !== null && authKey !== undefined && repo !== undefined && number !== undefined;
	if (!ttl.enabled || !cacheable) {
		const status: CacheStatus = ttl.enabled ? "bypassed" : "disabled";
		return { payload: await options.fetchFresh(), status, fetchedAt: Date.now() };
	}

	sweepIfDue(ttl.hardMs);

	const cached = getCached<T>(repo, options.kind, number, options.includeComments, authKey, variant);
	if (cached) {
		const age = Date.now() - cached.fetchedAt;
		if (age > ttl.hardMs) {
			// Past the hard TTL: drop the row eagerly so the on-disk exposure window
			// is bounded even when the live fetch that follows fails.
			invalidate(repo, options.kind, number, { includeComments: options.includeComments, variant }, authKey);
		} else if (age <= ttl.softMs) {
			return { payload: cached.payload, status: "fresh", fetchedAt: cached.fetchedAt };
		} else if (options.kind === "pr-diff") {
			// Diffs are the expensive fetch (a large diff falls back to the per-file
			// API), so the caller keeps the stale copy while the row refreshes.
			const store = (payload: T) =>
				storeResult(authKey, repo, options.kind, number, variant, options.includeComments, payload, Date.now());
			const rowKey = [
				authKey,
				normalizeRepoKey(repo),
				options.kind,
				number,
				variant,
				options.includeComments ? 1 : 0,
			].join("|");
			scheduleBackgroundRefresh(options.fetchFresh, store, rowKey, { repo, kind: options.kind, number });
			return { payload: cached.payload, status: "stale", fetchedAt: cached.fetchedAt };
		} else {
			try {
				const payload = await options.fetchFresh();
				const fetchedAt = Date.now();
				storeResult(authKey, repo, options.kind, number, variant, options.includeComments, payload, fetchedAt);
				return { payload, status: "refreshed", fetchedAt };
			} catch (err) {
				if (err instanceof ToolAbortError) throw err;
				logger.debug("github cache: synchronous refresh failed; returning stale view", {
					err: String(err),
					repo,
					kind: options.kind,
					number,
				});
				return { payload: cached.payload, status: "stale", fetchedAt: cached.fetchedAt };
			}
		}
	}

	const payload = await options.fetchFresh();
	const fetchedAt = Date.now();
	storeResult(authKey, repo, options.kind, number, variant, options.includeComments, payload, fetchedAt);
	return { payload, status: "miss", fetchedAt };
}

function formatAge(ageMs: number): string {
	const ageSec = Math.max(0, Math.round(ageMs / 1000));
	if (ageSec < 60) return `${ageSec}s`;
	if (ageSec < 3600) return `${Math.round(ageSec / 60)}m`;
	return `${Math.round(ageSec / 3600)}h`;
}

/**
 * One-line marker telling the caller the view did not come from GitHub just
 * now, and why. Undefined for anything that was fetched live — a cached view
 * that reads as live data is the failure this exists to prevent.
 */
export function formatCacheNotice(status: CacheStatus, fetchedAt: number): string | undefined {
	if (status === "miss" || status === "refreshed" || status === "disabled" || status === "bypassed") {
		return undefined;
	}
	const age = formatAge(Date.now() - fetchedAt);
	if (status === "stale") {
		return `[Cached: fetched ${age} ago; live refresh failed or is still running]`;
	}
	return `[Cached: fetched ${age} ago]`;
}
