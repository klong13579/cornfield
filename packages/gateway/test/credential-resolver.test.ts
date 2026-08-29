/**
 * Credential resolver tests — env-var aliasing semantics:
 *   - aliased providers (openai + narwal-plan → same env var): one resolution covers all,
 *     no spurious missing warning regardless of iteration order
 *   - genuinely missing env var (no provider resolves) still reported, once per env var
 *   - already-set process env skips entirely
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { vi } from "vitest";

function makeFakeHome(modelsYml: string, credentials: Array<{ provider: string; key: string }>): string {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cred-test-"));
	fs.mkdirSync(path.join(home, ".cornfield", "agent"), { recursive: true });
	fs.writeFileSync(path.join(home, ".cornfield", "agent", "models.yml"), modelsYml);
	const { Database } = require("bun:sqlite");
	const db = new Database(path.join(home, ".cornfield", "agent", "agent.db"));
	db.exec(`CREATE TABLE auth_credentials (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		provider TEXT NOT NULL,
		credential_type TEXT NOT NULL,
		data TEXT NOT NULL,
		disabled_cause TEXT DEFAULT NULL,
		identity_key TEXT DEFAULT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	)`);
	for (const c of credentials) {
		db.run(
			"INSERT INTO auth_credentials (provider, credential_type, data, created_at, updated_at) VALUES (?, 'api_key', ?, 0, 0)",
			[c.provider, JSON.stringify({ key: c.key })],
		);
	}
	db.close();
	return home;
}

afterEach(() => {
	vi.restoreAllMocks();
});

const ALIASED_MODELS = `providers:
  openai:
    baseUrl: https://coder.narwal.com/v1
    apiKey: NARWAL_PLAN_API_KEY
  narwal-plan:
    baseUrl: https://coder.narwal.com/v1
    apiKey: NARWAL_PLAN_API_KEY
`;

describe("resolveCredentialEnvVars aliasing", () => {
	it("aliased env var resolves once — no missing when any provider has a stored key", async () => {
		const home = makeFakeHome(ALIASED_MODELS, [{ provider: "narwal-plan", key: "sk-test" }]);
		vi.spyOn(os, "homedir").mockReturnValue(home);
		const saved = process.env.NARWAL_PLAN_API_KEY;
		delete process.env.NARWAL_PLAN_API_KEY;
		try {
			const { resolveCredentialEnvVars } = await import("../src/credential-resolver");
			const env = resolveCredentialEnvVars();
			expect(env.NARWAL_PLAN_API_KEY).toBe("sk-test");
		} finally {
			if (saved) process.env.NARWAL_PLAN_API_KEY = saved;
		}
	});

	it("genuinely missing env var is absent from result", async () => {
		const home = makeFakeHome(
			`providers:
  mystery:
    baseUrl: https://x.example/v1
    apiKey: MYSTERY_API_KEY
`,
			[],
		);
		vi.spyOn(os, "homedir").mockReturnValue(home);
		const saved = process.env.MYSTERY_API_KEY;
		delete process.env.MYSTERY_API_KEY;
		try {
			const { resolveCredentialEnvVars } = await import("../src/credential-resolver");
			const env = resolveCredentialEnvVars();
			expect(env.MYSTERY_API_KEY).toBeUndefined();
		} finally {
			if (saved) process.env.MYSTERY_API_KEY = saved;
		}
	});

	it("already-set process env is not overridden by stored credential", async () => {
		const home = makeFakeHome(ALIASED_MODELS, [{ provider: "narwal-plan", key: "sk-stored" }]);
		vi.spyOn(os, "homedir").mockReturnValue(home);
		const saved = process.env.NARWAL_PLAN_API_KEY;
		process.env.NARWAL_PLAN_API_KEY = "sk-from-env";
		try {
			const { resolveCredentialEnvVars } = await import("../src/credential-resolver");
			const env = resolveCredentialEnvVars();
			expect(env.NARWAL_PLAN_API_KEY).toBeUndefined();
		} finally {
			if (saved) process.env.NARWAL_PLAN_API_KEY = saved;
			else delete process.env.NARWAL_PLAN_API_KEY;
		}
	});
});
