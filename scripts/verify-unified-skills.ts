#!/usr/bin/env bun
/**
 * Verify unified skill loading + context injection using real ~/.omp stores.
 */
import * as path from "node:path";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { createSelfEvolutionExtension } from "@oh-my-pi/self-evolution";
import { getUnifiedSkillsDir, ensureUnifiedSkillStorage } from "@oh-my-pi/self-evolution/skill-storage";
import { getMemoryRoot } from "@oh-my-pi/self-evolution/memory";
import { loadUnifiedSkillsForInjection } from "@oh-my-pi/self-evolution/unified-skills";
import { getEvolutionDb } from "@oh-my-pi/self-evolution/storage/db";
import { SqliteSkillStore } from "@oh-my-pi/self-evolution/storage/skills";

const cwd = path.resolve(import.meta.dir, "..");

async function main(): Promise<void> {
	const globalStore = true;
	const agentDir = getAgentDir();
	const memoryRoot = getMemoryRoot(agentDir, cwd);
	const skillsDir = getUnifiedSkillsDir(cwd, globalStore);

	await ensureUnifiedSkillStorage(cwd, memoryRoot, globalStore);

	const db = getEvolutionDb(cwd, globalStore);
	const store = new SqliteSkillStore(db);
	const loaded = await loadUnifiedSkillsForInjection(cwd, store, { globalStore });

	console.info("=== Unified skills verification ===");
	console.info(`skills_dir: ${skillsDir}`);
	console.info(`loaded_count: ${loaded.length}`);
	console.info(`sample_names: ${loaded
		.slice(0, 8)
		.map(s => s.name)
		.join(", ")}`);

	const authStorage = await AuthStorage.create();
	const modelRegistry = new ModelRegistry(authStorage);
	const sessionManager = SessionManager.inMemory(cwd);
	const runtime = new ExtensionRuntime();
	runtime.flagValues.set("self-evolution-global-store", true);
	runtime.flagValues.set("self-evolution-enable-prompt-injection", true);

	const eventBus = new EventBus();
	const ext = await loadExtensionFromFactory(createSelfEvolutionExtension, cwd, eventBus, runtime, "self-evolution");
	const runner = new ExtensionRunner([ext], runtime, cwd, sessionManager, modelRegistry);

	const extErrors: Array<{ extensionPath: string; event: string; error: string }> = [];
	runner.onError(e => extErrors.push(e));

	runner.initialize(
		{
			sendMessage: () => {},
			sendUserMessage: () => {},
			appendEntry: () => {},
			setLabel: () => {},
			getActiveTools: () => [],
			getAllTools: () => [],
			setActiveTools: async () => {},
			getCommands: () => [],
			setModel: async () => false,
			getThinkingLevel: () => undefined,
			setThinkingLevel: () => {},
			getSessionName: () => sessionManager.getSessionName(),
			setSessionName: async () => {},
		},
		{
			getModel: () => undefined,
			isIdle: () => true,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getSystemPrompt: () => "verify",
		},
	);

	const messages = [{ role: "user" as const, content: "help with boundary condition testing strategy", timestamp: Date.now() }];
	const after = await runner.emitContext(messages);

	const injected = after.find(
		m => m.role === "user" && typeof m.content === "string" && m.content.includes("[System Context]"),
	);
	const injectedText = injected && typeof injected.content === "string" ? injected.content : "";

	console.info(`context_injected: ${Boolean(injected)}`);
	console.info(`context_has_skills_layer: ${injectedText.includes("Relevant Skills") || injectedText.includes("Skills")}`);
	if (injectedText.length > 0) {
		console.info(`context_preview:\n${injectedText.slice(0, 600)}${injectedText.length > 600 ? "..." : ""}`);
	}

	authStorage.close();

	if (extErrors.length > 0) {
		console.error("extension_errors:", JSON.stringify(extErrors, null, 2));
		process.exit(1);
	}
	if (loaded.length === 0) {
		console.error("FAIL: no skills loaded from unified directory");
		process.exit(1);
	}
	if (!injected) {
		console.error("FAIL: context injection did not add [System Context] message");
		process.exit(1);
	}
	console.info("verify-unified-skills: ok");
}

await main();
