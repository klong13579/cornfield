#!/usr/bin/env bun
/**
 * Persist Alibaba Coding Plan API key to ~/.omp/agent/agent.db (same store omp uses).
 * Does not touch bailian-coding-plan credentials unless --remove-bailian is passed.
 *
 * Usage:
 *   ALIBABA_API_KEY=sk-sp-... bun packages/self-evolution/scripts/sync-alibaba-api-key-to-db.ts
 *   bun packages/self-evolution/scripts/sync-alibaba-api-key-to-db.ts --from-omp-pane omp-memory-verify
 */
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

function maskKey(key: string): string {
	if (key.length <= 12) return `${key.slice(0, 4)}…`;
	return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

async function readKeyFromOmpPane(session: string): Promise<string | undefined> {
	const panePid = await $`tmux list-panes -t ${session} -F '#{pane_pid}'`.quiet().nothrow().text();
	const pid = panePid.trim().split("\n")[0];
	if (!pid) return undefined;
	const envLines = await $`ps eww -p ${pid}`.quiet().nothrow().text();
	for (const token of envLines.split(" ")) {
		if (token.startsWith("ALIBABA_API_KEY=")) {
			return token.slice("ALIBABA_API_KEY=".length);
		}
	}
	return undefined;
}

const fromPaneIdx = process.argv.indexOf("--from-omp-pane");
const removeBailian = process.argv.includes("--remove-bailian");

let apiKey = process.env.ALIBABA_API_KEY?.trim() || process.env.ALIBABA_CODING_PLAN_API_KEY?.trim();
if (!apiKey && fromPaneIdx >= 0) {
	const session = process.argv[fromPaneIdx + 1] ?? "omp-memory-verify";
	apiKey = await readKeyFromOmpPane(session);
}

if (!apiKey) {
	console.error("Set ALIBABA_API_KEY or pass --from-omp-pane <tmux-session>");
	process.exit(1);
}

const agentDir = getAgentDir();
const authStorage = await discoverAuthStorage(agentDir);
const before = await authStorage.peekApiKey("alibaba-coding-plan");

await authStorage.set("alibaba-coding-plan", { type: "api_key", key: apiKey });

if (removeBailian) {
	await authStorage.remove("bailian-coding-plan");
}

const after = await authStorage.peekApiKey("alibaba-coding-plan");
console.log(
	JSON.stringify(
		{
			agentDb: `${agentDir}/agent.db`,
			provider: "alibaba-coding-plan",
			before: before ? maskKey(before) : null,
			after: after ? maskKey(after) : null,
			stored: maskKey(apiKey),
			removeBailian,
			note: "getApiKey still prefers ALIBABA_API_KEY env over DB for DashScope providers when env is set",
		},
		null,
		2,
	),
);
