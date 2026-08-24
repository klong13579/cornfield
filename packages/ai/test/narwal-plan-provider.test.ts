import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { AuthCredentialStore, AuthStorage } from "../src/auth-storage";
import { getBundledModels, getBundledProviders } from "../src/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { NARWAL_PLAN_STATIC_MODELS } from "../src/provider-models/narwal-plan";
import { narwalPlanModelManagerOptions } from "../src/provider-models/openai-compat";
import { getEnvApiKey } from "../src/stream";
import { getOAuthProviders } from "../src/utils/oauth";
import { loginNarwalPlan } from "../src/utils/oauth/narwal-plan";

const originalNarwalApiKey = Bun.env.NARWAL_PLAN_API_KEY;
const originalFetch = global.fetch;

afterEach(() => {
	if (originalNarwalApiKey === undefined) {
		delete Bun.env.NARWAL_PLAN_API_KEY;
	} else {
		Bun.env.NARWAL_PLAN_API_KEY = originalNarwalApiKey;
	}
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("narwal-plan provider support", () => {
	it("resolves NARWAL_PLAN_API_KEY from environment", () => {
		Bun.env.NARWAL_PLAN_API_KEY = "narwal-test-key";
		expect(getEnvApiKey("narwal-plan")).toBe("narwal-test-key");
	});

	it("registers built-in descriptor and default model", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "narwal-plan");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("minimax-m3");
		expect(descriptor?.createModelManagerOptions).toBeDefined();
		expect(descriptor?.catalogDiscovery?.label).toBe("Narwal Plan");
		expect(descriptor?.catalogDiscovery?.envVars).toContain("NARWAL_PLAN_API_KEY");
		expect(DEFAULT_MODEL_PER_PROVIDER["narwal-plan"]).toBe("minimax-m3");
	});

	it("registers narwal-plan in OAuth provider selector", () => {
		const provider = getOAuthProviders().find(item => item.id === "narwal-plan");
		expect(provider?.name).toBe("Narwal Plan");
	});

	it("bundles narwal-plan models with verified metadata", () => {
		expect(getBundledProviders()).toContain("narwal-plan");
		const models = getBundledModels("narwal-plan") as {
			id: string;
			contextWindow?: number;
			maxTokens?: number;
			reasoning?: boolean;
			thinking?: { mode?: string };
		}[];
		expect(models.length).toBeGreaterThan(0);

		const minimaxM3 = models.find(m => m.id === "minimax-m3");
		expect(minimaxM3).toBeDefined();
		expect(minimaxM3?.contextWindow).toBe(1_000_000);
		expect(minimaxM3?.maxTokens).toBe(131_072);
		expect(minimaxM3?.reasoning).toBe(true);
		expect(minimaxM3?.thinking?.mode).toBe("effort");
	});

	it("builds model manager options with narwal defaults", () => {
		const options = narwalPlanModelManagerOptions();
		expect(options.providerId).toBe("narwal-plan");
		expect(options.fetchDynamicModels).toBeDefined();
		expect(options.staticModels?.length).toBe(NARWAL_PLAN_STATIC_MODELS.length);
		expect(NARWAL_PLAN_STATIC_MODELS.length).toBeGreaterThan(30);
	});
});

describe("narwal-plan login", () => {
	it("validates the pasted API key against the chat completions endpoint", async () => {
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			expect(url).toBe("https://coder.narwal.com/v1/chat/completions");
			expect(init?.method).toBe("POST");
			expect(init?.headers).toEqual({
				"Content-Type": "application/json",
				Authorization: "Bearer sk-narwal-test",
			});
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const apiKey = await loginNarwalPlan({
			onAuth: () => {},
			onPrompt: async () => "sk-narwal-test",
		});

		expect(apiKey).toBe("sk-narwal-test");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("surfaces validation errors from the gateway", async () => {
		global.fetch = vi.fn(
			async () => new Response('{"error":"invalid_api_key"}', { status: 401 }),
		) as unknown as typeof fetch;

		await expect(
			loginNarwalPlan({
				onAuth: () => {},
				onPrompt: async () => "sk-narwal-test",
			}),
		).rejects.toThrow("Narwal Plan API key validation failed (401)");
	});

	it("persists the key via AuthStorage.login and resolves it with getApiKey", async () => {
		global.fetch = vi.fn(
			async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
		) as unknown as typeof fetch;

		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-narwal-login-"));
		const dbPath = path.join(tempDir, "agent.db");
		const store = await AuthCredentialStore.open(dbPath);
		const authStorage = new AuthStorage(store);
		try {
			await authStorage.login("narwal-plan", {
				onAuth: () => {},
				onPrompt: async () => "sk-narwal-test",
			});

			const credentials = store.listAuthCredentials("narwal-plan");
			expect(credentials).toHaveLength(1);
			const [stored] = credentials;
			expect(stored?.credential.type).toBe("api_key");
			if (stored?.credential.type !== "api_key") {
				throw new Error("expected stored api-key credential");
			}
			expect(stored.credential.key).toBe("sk-narwal-test");

			const db = new Database(dbPath, { readonly: true });
			try {
				const row = db
					.prepare("SELECT COUNT(*) AS count FROM auth_credentials WHERE provider = ?")
					.get("narwal-plan") as { count?: number };
				expect(row.count).toBe(1);
			} finally {
				db.close();
			}
			expect(await authStorage.getApiKey("narwal-plan", "session-narwal")).toBe("sk-narwal-test");
		} finally {
			store.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
