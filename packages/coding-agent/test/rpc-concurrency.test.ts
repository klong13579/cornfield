/**
 * RPC concurrency tests — session isolation and parallel execution.
 *
 * Requires a real omp --mode rpc process with API key.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { e2eApiKey } from "./utilities";

describe.skipIf(!e2eApiKey("ANTHROPIC_API_KEY"))("RPC concurrency", () => {
	let sessionDirA: string;
	let sessionDirB: string;
	let tempDirs: string[];

	beforeEach(() => {
		sessionDirA = path.join(os.tmpdir(), `omp-rpc-conc-a-${Snowflake.next()}`);
		sessionDirB = path.join(os.tmpdir(), `omp-rpc-conc-b-${Snowflake.next()}`);
		tempDirs = [sessionDirA, sessionDirB];
	});

	afterEach(() => {
		for (const dir of tempDirs) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {}
		}
	});

	test("two sessions maintain isolated context", async () => {
		// Two separate RPC clients with different session directories
		using clientA = new RpcClient({
			cliPath: path.join(import.meta.dir, "..", "dist", "cli.js"),
			cwd: path.join(import.meta.dir, ".."),
			env: { PI_CODING_AGENT_DIR: sessionDirA },
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		});

		using clientB = new RpcClient({
			cliPath: path.join(import.meta.dir, "..", "dist", "cli.js"),
			cwd: path.join(import.meta.dir, ".."),
			env: { PI_CODING_AGENT_DIR: sessionDirB },
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		});

		await clientA.start();
		await clientB.start();

		// Give clientA context about "张三"
		await clientA.promptAndWait('Please remember: my name is 张三. Just say "ok".');

		// Give clientB context about "李四"
		await clientB.promptAndWait('Please remember: my name is 李四. Just say "ok".');

		// Verify clientA remembers 张三, not 李四
		const eventsA = await clientA.promptAndWait("What is my name? Reply with just the name.");
		const textA = extractLastAssistantText(eventsA);
		expect(textA).toMatch(/张三/);

		// Verify clientB remembers 李四, not 张三
		const eventsB = await clientB.promptAndWait("What is my name? Reply with just the name.");
		const textB = extractLastAssistantText(eventsB);
		expect(textB).toMatch(/李四/);
	}, 180000);

	test("message count reflects interaction history", async () => {
		using client = new RpcClient({
			cliPath: path.join(import.meta.dir, "..", "dist", "cli.js"),
			cwd: path.join(import.meta.dir, ".."),
			env: { PI_CODING_AGENT_DIR: path.join(os.tmpdir(), `omp-rpc-msgcnt-${Snowflake.next()}`) },
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		});

		await client.start();

		const initialState = await client.getState();
		expect(initialState.messageCount).toBe(0);

		await client.promptAndWait('Just say "hi".');
		const afterState = await client.getState();
		expect(afterState.messageCount).toBeGreaterThan(0);
	}, 120000);

	test("newSession resets message count", async () => {
		using client = new RpcClient({
			cliPath: path.join(import.meta.dir, "..", "dist", "cli.js"),
			cwd: path.join(import.meta.dir, ".."),
			env: { PI_CODING_AGENT_DIR: path.join(os.tmpdir(), `omp-rpc-reset-${Snowflake.next()}`) },
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		});

		await client.start();

		// Build up some messages
		await client.promptAndWait('Just say "hello".');
		const beforeState = await client.getState();
		expect(beforeState.messageCount).toBeGreaterThan(0);

		// Start new session
		await client.newSession();

		const afterState = await client.getState();
		expect(afterState.messageCount).toBe(0);
	}, 120000);
});

/**
 * Extract the text content from the last assistant message in event stream.
 */
function extractLastAssistantText(
	events: Array<{ type: string; message?: { role?: string; content?: Array<{ type: string; text?: string }> } }>,
): string {
	const assistantMessages = events.filter(e => e.type === "message_end" && e.message?.role === "assistant");
	const last = assistantMessages[assistantMessages.length - 1];
	if (!last?.message?.content) return "";
	const textContent = last.message.content.find(c => c.type === "text");
	return textContent?.text ?? "";
}
