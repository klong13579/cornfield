/**
 * Request audit log tests:
 *   - ok / error / aborted / fallback status derivation from AgentResponseMeta
 *   - classifyError mapping
 *   - appendRequestAudit writes one JSONL line into <agentDir>/logs/requests.jsonl
 *   - request truncation at 500 chars
 *   - group vs DM field shaping
 */
import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendRequestAudit, classifyError } from "../src/request-audit";
import type { AgentResponseMeta, InboundMessage } from "../src/types";

function meta(overrides: Partial<AgentResponseMeta> = {}): AgentResponseMeta {
	return {
		text: "ok",
		rawText: "ok",
		model: "qwen3.6-flash",
		provider: "narwal-plan",
		usage: null,
		agentDurationMs: 1000,
		taskDurationMs: 2000,
		effort: null,
		toolCalls: [],
		toolResults: [],
		error: null,
		aborted: false,
		isFallback: false,
		...overrides,
	};
}

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
	return {
		channelId: "dingtalk",
		userId: "601590212",
		userName: "彭梦龙",
		conversationId: "cidX",
		isGroup: false,
		content: { type: "text", text: "扫一下群消息" },
		timestamp: new Date(),
		...overrides,
	};
}

describe("classifyError", () => {
	it("maps repetitive tool calls", () => {
		expect(classifyError("Repetitive tool calls detected in the conversation history")).toBe(
			"repetitive_tool_calls",
		);
	});
	it("maps timeout", () => {
		expect(classifyError("Request timeout after 300s")).toBe("timeout");
	});
	it("maps unknown to generic", () => {
		expect(classifyError("something broke")).toBe("error");
	});
});

describe("appendRequestAudit", () => {
	let agentDir: string;
	const cleanup: string[] = [];

	afterAll(async () => {
		for (const p of cleanup) await fs.rm(p, { recursive: true, force: true });
	});

	async function readLog(dir: string): Promise<Array<Record<string, unknown>>> {
		const text = await fs.readFile(path.join(dir, "logs", "requests.jsonl"), "utf8");
		return text.trimEnd().split("\n").map(l => JSON.parse(l));
	}

	it("writes an ok entry for a successful DM request", async () => {
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-audit-"));
		cleanup.push(agentDir);
		await appendRequestAudit(agentDir, msg(), meta());
		const entries = await readLog(agentDir);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			sender: "彭梦龙",
			senderId: "601590212",
			request: "扫一下群消息",
			status: "ok",
			isGroup: false,
			conversationTitle: null,
		});
		expect(entries[0]).not.toHaveProperty("errorType");
	});

	it("writes error + errorType when the agent run failed", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-audit-"));
		cleanup.push(dir);
		await appendRequestAudit(
			dir,
			msg(),
			meta({ error: "Repetitive tool calls detected in the conversation history", isFallback: true }),
		);
		const entries = await readLog(dir);
		expect(entries[0]).toMatchObject({ status: "error", errorType: "repetitive_tool_calls" });
	});

	it("writes aborted status when the user aborted", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-audit-"));
		cleanup.push(dir);
		await appendRequestAudit(dir, msg(), meta({ aborted: true }));
		const entries = await readLog(dir);
		expect(entries[0]).toMatchObject({ status: "aborted" });
	});

	it("writes no_response for null meta", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-audit-"));
		cleanup.push(dir);
		await appendRequestAudit(dir, msg(), null);
		const entries = await readLog(dir);
		expect(entries[0]).toMatchObject({ status: "error", errorType: "no_response" });
	});

	it("captures group title for group requests and truncates long text", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-audit-"));
		cleanup.push(dir);
		const long = "长".repeat(800);
		await appendRequestAudit(
			dir,
			msg({ isGroup: true, conversationTitle: "机械臂性能", content: { type: "text", text: long } }),
			meta(),
		);
		const entries = await readLog(dir);
		expect(entries[0]).toMatchObject({
			isGroup: true,
			conversationTitle: "机械臂性能",
			status: "ok",
		});
		expect((entries[0].request as string).length).toBe(500);
	});
});
