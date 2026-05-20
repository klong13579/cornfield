#!/usr/bin/env bun
/**
 * Load createSelfEvolutionExtension with ExtensionRunner and emit lifecycle events
 * in an isolated cwd with a seeded evolution DB — validates hooks do not throw
 * (covers FTS retrieval + agent_end extractor init).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createSelfEvolutionExtension } from "@oh-my-pi/self-evolution";
import { initSchema } from "@oh-my-pi/self-evolution/storage/db";
import { SqliteEpisodeStore } from "@oh-my-pi/self-evolution/storage/episodes";
import type { Episode } from "@oh-my-pi/self-evolution/types";

async function main(): Promise<void> {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-se-smoke-"));
	const dbDir = path.join(tmp, ".omp", "self-evolution");
	fs.mkdirSync(dbDir, { recursive: true });
	const dbPath = path.join(dbDir, "evolution.db");
	const db = new Database(dbPath);
	initSchema(db);
	const epStore = new SqliteEpisodeStore(db);
	const episode: Episode = {
		id: "smoke-pre",
		sessionId: "s-pre",
		cwd: tmp,
		userPrompt: "prior /Users/smoke/./path.ts work",
		timestamp: Date.now(),
		durationMs: 100,
		toolCallCount: 1,
		errorCount: 0,
		hadRecovery: false,
		completedSuccessfully: true,
		summary: "baseline episode for FTS",
		toolsUsed: ["read"],
		filesModified: [path.join(tmp, "a.ts")],
	};
	await epStore.insert(episode);
	db.close();

	const authStorage = await AuthStorage.create(path.join(tmp, "auth.db"));
	const modelRegistry = new ModelRegistry(authStorage, path.join(tmp, "models.yml"));
	const sessionManager = SessionManager.inMemory(tmp);

	const runtime = new ExtensionRuntime();
	const eventBus = new EventBus();
	const ext = await loadExtensionFromFactory(createSelfEvolutionExtension, tmp, eventBus, runtime, "self-evolution");
	// Per-project DB only — avoid touching ~/.omp/self-evolution during smoke
	runtime.flagValues.set("self-evolution-project-store", true);

	const runner = new ExtensionRunner([ext], runtime, tmp, sessionManager, modelRegistry);
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
			getSystemPrompt: () => "sysprompt-smoke",
		},
	);

	const hostilePrompt =
		"check /Users/x/./y.tsx and /proj/sub/<special> refs with foo.bar notation";

	await runner.emitBeforeAgentStart(hostilePrompt, undefined, "sysprompt-smoke");
	await runner.emit({ type: "agent_start" });

	await runner.emit({
		type: "agent_end",
		messages: [],
	});

	await runner.emit({ type: "session_shutdown" });

	authStorage.close();

	if (extErrors.length > 0) {
		console.error(JSON.stringify(extErrors, null, 2));
		process.exit(1);
	}
	console.info("smoke-self-evolution-hooks: ok");
}

await main();
