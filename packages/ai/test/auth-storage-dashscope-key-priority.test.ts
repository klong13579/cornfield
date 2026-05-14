import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { AuthCredentialStore, AuthStorage } from "../src/auth-storage";

describe("AuthStorage DashScope key resolution", () => {
	let tempDir = "";
	let dbPath = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-dashscope-key-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await AuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		authStorage = null;
		dbPath = "";
		delete process.env.ALIBABA_API_KEY;
		delete process.env.ALIBABA_CODING_PLAN_API_KEY;
		delete process.env.BAILIAN_CODING_PLAN_API_KEY;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("prefers ALIBABA_API_KEY over a persisted alibaba-coding-plan api_key", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");

		process.env.ALIBABA_API_KEY = "env-key-good";
		await authStorage.set("alibaba-coding-plan", { type: "api_key", key: "stored-key-bad" });

		expect(await authStorage.getApiKey("alibaba-coding-plan", "session-a")).toBe("env-key-good");
		expect(await authStorage.peekApiKey("alibaba-coding-plan")).toBe("env-key-good");
	});

	it("prefers fallback resolver over persisted alibaba-coding-plan api_key when env is unset", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");

		authStorage.setFallbackResolver(provider => (provider === "alibaba-coding-plan" ? "fallback-good" : undefined));
		await authStorage.set("alibaba-coding-plan", { type: "api_key", key: "stored-key-bad" });

		expect(await authStorage.getApiKey("alibaba-coding-plan", "session-b")).toBe("fallback-good");
		expect(await authStorage.peekApiKey("alibaba-coding-plan")).toBe("fallback-good");
	});

	it("prefers ALIBABA_API_KEY over a persisted bailian-coding-plan api_key", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");

		process.env.ALIBABA_API_KEY = "env-bailian-good";
		await authStorage.set("bailian-coding-plan", { type: "api_key", key: "stored-bailian-bad" });

		expect(await authStorage.getApiKey("bailian-coding-plan", "session-c")).toBe("env-bailian-good");
		expect(await authStorage.peekApiKey("bailian-coding-plan")).toBe("env-bailian-good");
	});

	it("still prefers persisted api_key for other providers when env is set", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");

		process.env.OPENAI_API_KEY = "env-openai";
		await authStorage.set("openai", { type: "api_key", key: "stored-openai" });

		expect(await authStorage.getApiKey("openai", "session-d")).toBe("stored-openai");
	});
});
