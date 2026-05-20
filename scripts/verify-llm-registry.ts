#!/usr/bin/env bun
/**
 * Verify LLM access via ModelRegistry (same path as memory / self-evolution).
 */
import { completeSimple } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { extractSessionLearnings } from "@oh-my-pi/self-evolution/session-learner";
import type { SessionTrace } from "@oh-my-pi/self-evolution/types";
import { getDefaultAgentDir } from "@oh-my-pi/pi-utils";

const MOCK_PROMPT =
	"我希望 omp 在执行测试用例设计的时候就把边界条件考虑进去，不要每次都让我提醒";

async function main(): Promise<void> {
	const authStorage = await discoverAuthStorage();
	const registry = new ModelRegistry(authStorage);

	const preferred = registry.find("alibaba-coding-plan", "deepseek-v4-flash");
	const model = preferred ?? registry.getAvailable()[0];
	if (!model) {
		console.error("FAIL: no model in registry");
		process.exit(1);
	}

	const apiKey = await registry.getApiKey(model);
	if (!apiKey) {
		console.error("FAIL: modelRegistry.getApiKey returned empty", {
			provider: model.provider,
			id: model.id,
		});
		process.exit(1);
	}

	console.info("model:", `${model.provider}/${model.id}`);
	console.info("apiKey:", `${apiKey.slice(0, 8)}… (${apiKey.length} chars)`);

	const ping = await completeSimple(
		model,
		{
			systemPrompt: "Reply with exactly: pong",
			messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
		},
		{ apiKey, maxTokens: 16 },
	);

	if (ping.stopReason === "error") {
		console.error("FAIL: completeSimple ping", ping.errorMessage);
		process.exit(1);
	}
	const pingText = ping.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("")
		.trim();
	console.info("ping ok:", pingText.slice(0, 80));

	const trace: SessionTrace = {
		sessionId: "verify-llm-registry",
		cwd: process.cwd(),
		userPrompt: MOCK_PROMPT,
		startTime: Date.now(),
		endTime: Date.now(),
		entries: [{ type: "user_input", timestamp: Date.now(), content: MOCK_PROMPT }],
		toolCallCount: 0,
		errorCount: 0,
		hadRecovery: false,
		completedSuccessfully: true,
	};

	const auth = {
		getApiKey: () => registry.getApiKey(model),
	};

	const learnings = await extractSessionLearnings(trace, "verify-llm-registry", model, auth);
	console.info("SessionLearner count:", learnings.length);
	for (const l of learnings) {
		console.info(`  [${l.kind}] ${l.content.slice(0, 120)} (conf=${l.confidence})`);
	}

	if (learnings.length === 0) {
		console.error("WARN: SessionLearner returned 0 learnings (check logs for parse/empty response)");
		process.exit(1);
	}

	console.info("OK: registry key + SessionLearner LLM");
	authStorage.close();
}

await main();
