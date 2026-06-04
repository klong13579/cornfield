#!/usr/bin/env bun
/**
 * Run SessionLearner once against a synthetic or stored trace (same LLM path as agent_end).
 *
 * Usage:
 *   bun packages/self-evolution/scripts/run-session-learner-once.ts [--cwd <repo>] [--session-id <id>]
 */
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { resolveEvolutionProjectionDir, DEFAULT_EVOLUTION_GLOBAL_STORE } from "../src/paths";
import { projectLearnings } from "../src/projection/learnings";
import { extractSessionLearnings } from "../src/session-learner";
import { closeEvolutionDb, getEvolutionDb, initSchema } from "../src/storage/db";
import { SqliteLearningStore } from "../src/storage/learnings";
import { SqliteSessionTraceStore } from "../src/storage/session-traces";
import type { SessionTrace } from "../src/types";
import type { BackgroundLlmAuth } from "../src/utils/llm";
const cwdIdx = process.argv.indexOf("--cwd");
const repoCwd = cwdIdx >= 0 ? (process.argv[cwdIdx + 1] ?? process.cwd()) : process.cwd();
// Default to user-level (globalStore = true), use --project-store to override to project-level
const globalStore = process.argv.includes("--project-store") ? false : DEFAULT_EVOLUTION_GLOBAL_STORE;
const sessionIdx = process.argv.indexOf("--session-id");
const sessionIdArg = sessionIdx >= 0 ? process.argv[sessionIdx + 1] : undefined;

const db = getEvolutionDb(repoCwd, globalStore);
initSchema(db);
const learningStore = new SqliteLearningStore(db);
const traceStore = new SqliteSessionTraceStore(db);

const before = await learningStore.listAll();
const beforeLlm = before.filter(l => l.source === "session_llm").length;

let trace: SessionTrace | undefined;
if (sessionIdArg) {
	const stored = await traceStore.getBySessionId(sessionIdArg);
	if (stored) trace = stored;
}
if (!trace) {
	const userPrompt =
		"请记住：本仓库跑 self-evolution 相关测试时只用 `bun test packages/self-evolution/test/escalation-detector.test.ts`，不要 `bun test` 全量。";
	const now = Date.now();
	trace = {
		sessionId: sessionIdArg ?? `sess_${now}`,
		cwd: repoCwd,
		userPrompt,
		startTime: now - 60_000,
		endTime: now,
		entries: [
			{
				type: "user_input",
				timestamp: now - 50_000,
				content: userPrompt,
			},
			{
				type: "assistant_message",
				timestamp: now - 40_000,
				content:
					"已记住。后续在 self-evolution 包内验证时，我会只跑 `bun test packages/self-evolution/test/escalation-detector.test.ts`，避免全量 `bun test`。",
			},
		],
		toolCallCount: 0,
		errorCount: 0,
		hadRecovery: false,
		completedSuccessfully: true,
		injectedLearningIds: before.filter(l => l.lifecycle === "active").map(l => l.id),
	};
}

const authStorage = await discoverAuthStorage(getAgentDir());
const registry = new ModelRegistry(authStorage);
const available = registry.getAvailable();
const model =
	available.find(m => m.provider === "alibaba-coding-plan" && m.id === "deepseek-v4-flash") ??
	available.find(m => m.provider === "alibaba-coding-plan");
if (!model) {
	console.error("No alibaba-coding-plan model available");
	closeEvolutionDb(repoCwd, globalStore);
	process.exit(1);
}

const apiKey = await registry.getApiKey(model);
if (!apiKey) {
	console.error("No API key for", model.provider);
	closeEvolutionDb(repoCwd, globalStore);
	process.exit(1);
}

const auth: BackgroundLlmAuth = {
	getApiKey: model => registry.getApiKey(model),
};
const episodeId = `ep_${trace.sessionId}`;
const extracted = await extractSessionLearnings(trace, episodeId, model, auth);

for (const l of extracted) {
	await learningStore.insert(l);
}
await learningStore.refreshLifecycles();

const outputDir = resolveEvolutionProjectionDir(repoCwd, globalStore);
await projectLearnings(db, { outputDir });

const after = await learningStore.listAll();
const afterLlm = after.filter(l => l.source === "session_llm");

console.log(
	JSON.stringify(
		{
			model: `${model.provider}/${model.id}`,
			traceSessionId: trace.sessionId,
			extracted: extracted.map(l => ({ id: l.id, kind: l.kind, content: l.content, confidence: l.confidence })),
			sessionLlmBefore: beforeLlm,
			sessionLlmAfter: afterLlm.length,
			newIds: afterLlm.filter(l => !before.some(b => b.id === l.id)).map(l => l.id),
		},
		null,
		2,
	),
);

closeEvolutionDb(repoCwd, globalStore);
