/**
 * `AgentSession.refreshModelScope` = the "unfreeze" half of open-time model freshness.
 *
 * The scope is resolved once at session start (`main.ts`), so a session that started
 * before a model appeared — or before an `enabledModels` pattern was widened — keeps the
 * old list for its whole lifetime. The model selector re-resolves through this method
 * after refreshing discovery.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@cornfield/agent";
import { getBundledModel } from "@cornfield/ai";
import { ModelRegistry } from "@cornfield/coding-agent/config/model-registry";
import { Settings } from "@cornfield/coding-agent/config/settings";
import { AgentSession } from "@cornfield/coding-agent/session/agent-session";
import { AuthStorage } from "@cornfield/coding-agent/session/auth-storage";
import { SessionManager } from "@cornfield/coding-agent/session/session-manager";
import { Snowflake } from "@cornfield/utils";

describe("AgentSession.refreshModelScope", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let tempDir: string | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	async function createSession(options: {
		modelPatterns?: string[];
		modelPatternsFromSettings?: boolean;
		enabledModels?: string[];
	}): Promise<AgentSession> {
		tempDir = path.join(os.tmpdir(), `cornfield-scope-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
		});
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const settings = Settings.isolated({ enabledModels: options.enabledModels ?? [] });

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			scopedModels: [],
			modelPatterns: options.modelPatterns,
			modelPatternsFromSettings: options.modelPatternsFromSettings,
		});
		return session;
	}

	it("re-resolves the scope from the session's patterns", async () => {
		const created = await createSession({ modelPatterns: ["anthropic/claude-sonnet*"] });
		expect(created.scopedModels).toHaveLength(0);

		await created.refreshModelScope();

		expect(created.scopedModels.map(scoped => scoped.model.id)).toContain("claude-sonnet-4-5");
	});

	it("re-reads enabledModels when the patterns came from settings", async () => {
		// The session was started with a stale pattern; the setting now points elsewhere and
		// must win without a restart.
		const created = await createSession({
			modelPatterns: ["anthropic/claude-haiku*"],
			modelPatternsFromSettings: true,
			enabledModels: ["anthropic/claude-sonnet*"],
		});

		await created.refreshModelScope();

		const ids = created.scopedModels.map(scoped => scoped.model.id);
		expect(ids).toContain("claude-sonnet-4-5");
		expect(ids).not.toContain("claude-haiku-4-5");
	});

	it("is a no-op when the session runs without patterns", async () => {
		const created = await createSession({});

		await created.refreshModelScope();

		expect(created.scopedModels).toHaveLength(0);
	});
});
