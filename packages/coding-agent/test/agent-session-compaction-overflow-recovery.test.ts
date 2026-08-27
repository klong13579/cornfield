/**
 * Regression test: overflow recovery must not dead-lock when a gateway swallows
 * the real overflow error.
 *
 * Production incident (2026-08-27, narwal-plan/deepseek-v4-flash-0731 via
 * coder.narwal.com): the session's real prompt tokens climbed past the 1M
 * context window. The gateway returned `400 openai_error
 * (type=bad_response_status_code)` — a generic shell that matches none of the
 * overflow error-text patterns — and the error turn itself carries zeroed
 * usage. Result: three consecutive 400s with no compaction, because
 * (a) the overflow check read usage only from the (error) turn itself, and
 * (b) the threshold check skipped error turns entirely.
 *
 * The fix: fall back to the last successful assistant usage for overflow
 * detection, and let error turns run the threshold check using the
 * usage+estimate hybrid. This test drives the exact event sequence:
 * successful toolUse turn (usage > window) → error turn (gateway shell) →
 * agent_end, and asserts overflow auto-compaction fires.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-ai/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getProjectAgentDir, TempDir, withTimeout } from "@oh-my-pi/pi-utils";

const runtimeSignalStoreKey = "__ompOverflowRecoverySignals";

type RuntimeSignalGlobal = typeof globalThis & { [runtimeSignalStoreKey]?: string[] };

function getRuntimeSignals(): string[] {
	const globalWithSignals = globalThis as RuntimeSignalGlobal;
	if (!globalWithSignals[runtimeSignalStoreKey]) {
		globalWithSignals[runtimeSignalStoreKey] = [];
	}
	return globalWithSignals[runtimeSignalStoreKey];
}

describe("AgentSession overflow recovery (gateway-swallowed errors)", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-overflow-recovery-");

		// Extension short-circuits compaction so the test makes no LLM calls.
		const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		const extensionPath = path.join(extensionsDir, "compaction-short-circuit.ts");
		fs.writeFileSync(
			extensionPath,
			[
				"export default function(pi) {",
				'\tpi.on("session_before_compact", async (event) => {',
				"\t\treturn {",
				"\t\t\tcompaction: {",
				'\t\t\t\tsummary: "compacted",',
				"\t\t\t\tshortSummary: undefined,",
				"\t\t\t\tfirstKeptEntryId: event.preparation.firstKeptEntryId,",
				"\t\t\t\ttokensBefore: event.preparation.tokensBefore,",
				"\t\t\t\tdetails: {},",
				"\t\t\t},",
				"\t\t};",
				"\t});",
				'\tpi.on("auto_compaction_start", async (event) => {',
				`\t\tconst signals = globalThis.${runtimeSignalStoreKey} ?? (globalThis.${runtimeSignalStoreKey} = []);`,
				'\t\tsignals.push("compaction:start:" + event.reason);',
				"\t});",
				'\tpi.on("auto_compaction_end", async (event) => {',
				`\t\tconst signals = globalThis.${runtimeSignalStoreKey} ?? (globalThis.${runtimeSignalStoreKey} = []);`,
				'\t\tsignals.push("compaction:end:" + (event.aborted ? "aborted" : "ok"));',
				"\t});",
				"}",
			].join("\n"),
		);

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		getRuntimeSignals().length = 0;

		const extensionsResult = await loadExtensions([extensionPath], tempDir.path());
		const extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected built-in anthropic model to exist");
		}

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
			},
		});

		sessionManager.appendMessage({
			role: "user",
			content: "hello",
			timestamp: Date.now(),
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.autoContinue": false,
				"contextPromotion.enabled": false,
			}),
			modelRegistry,
			extensionRunner,
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		getRuntimeSignals().length = 0;
		vi.restoreAllMocks();
	});

	it("compacts on overflow when the gateway swallows the error text (regression)", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const contextWindow = 200_000;

		// Mid-loop successful turn whose reported usage already exceeds the window.
		const successMsg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "working on it" }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: contextWindow + 10_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: contextWindow + 10_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1000,
		};

		// Final turn: gateway-swallowed 400 shell, zeroed usage.
		const errorMsg = {
			role: "assistant" as const,
			content: [],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "error" as const,
			errorMessage: "400 openai_error (type=bad_response_status_code param=bad_response_status_code)",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		session.agent.emitExternalEvent({ type: "message_end", message: successMsg });
		session.agent.emitExternalEvent({ type: "message_end", message: errorMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [errorMsg] });

		await withTimeout(compactionDone, 5000, "overflow compaction timed out");

		const runtimeSignals = getRuntimeSignals();
		expect(runtimeSignals).toContain("compaction:start:overflow");
		expect(runtimeSignals.some(signal => signal.startsWith("compaction:end:"))).toBe(true);
		expect(continueSpy).not.toHaveBeenCalled(); // autoContinue disabled
	});

	it("compacts on threshold when an error turn ends with oversized context (regression)", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		// Reported prompt usage crosses the default threshold
		// (window - max(15%, reserve)) but stays under the window.
		const threshold = Math.floor(200_000 * 0.85);

		const successMsg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "done" }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: threshold + 5_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: threshold + 5_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1000,
		};

		const errorMsg = {
			role: "assistant" as const,
			content: [],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "error" as const,
			errorMessage: "400 openai_error (type=bad_response_status_code param=bad_response_status_code)",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		session.agent.emitExternalEvent({ type: "message_end", message: successMsg });
		session.agent.emitExternalEvent({ type: "message_end", message: errorMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [errorMsg] });

		await withTimeout(compactionDone, 5000, "threshold compaction timed out");

		const runtimeSignals = getRuntimeSignals();
		expect(runtimeSignals).toContain("compaction:start:threshold");
		expect(continueSpy).not.toHaveBeenCalled();
	});
});
