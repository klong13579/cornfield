/**
 * dingtalk_attachment host tool — unit tests.
 *
 * Tests the handler directly (no RPC, no real DingTalk API) by:
 *   - Building the handler via `createDingtalkAttachmentToolDefinitions()`
 *   - Calling `handler.handle(args)` with stubbed dependencies
 *   - Asserting on the returned `HostToolResultBody`
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentBridge } from "../src/agent-bridge";
import { DingTalkChannel } from "../src/channels/dingtalk";
import type { AICardTarget } from "../src/channels/dingtalk-card";
import type { ChannelRegistry } from "../src/channels/registry";
import { createDingtalkAttachmentToolDefinitions } from "../src/dingtalk-attachment-tool";
import type { InboundMessage } from "../src/types";

const TMP = path.join(os.tmpdir(), `omp-test-attachment-${process.pid}-${Date.now()}`);

function ensureTmp(): string {
	fs.mkdirSync(TMP, { recursive: true, mode: 0o700 });
	return TMP;
}

function tmpFile(contents = "hello"): string {
	ensureTmp();
	const p = path.join(TMP, `file-${Math.random().toString(36).slice(2)}.md`);
	fs.writeFileSync(p, contents, "utf-8");
	return p;
}

function tmpMissingFile(): string {
	ensureTmp();
	return path.join(TMP, `does-not-exist-${Math.random().toString(36).slice(2)}.md`);
}

function stubAttachmentBridge(activeChat: InboundMessage | undefined): AgentBridge {
	return {
		getActiveChatContext: () => activeChat,
	} as unknown as AgentBridge;
}

class TestRegistry {
	#channel: object | undefined;

	constructor(channel?: object) {
		this.#channel = channel;
	}

	get(_key: string): object | undefined {
		return this.#channel;
	}
}

const DM_MSG: InboundMessage = {
	channelId: "dingtalk",
	userId: "u123",
	conversationId: "dm-u123",
	isGroup: false,
	content: { type: "text", text: "test" },
};

const GROUP_MSG: InboundMessage = {
	channelId: "dingtalk",
	userId: "u456",
	conversationId: "conv-grp-789",
	isGroup: true,
	conversationTitle: "algo-team",
	content: { type: "text", text: "test" },
};

function asText(body: { content: Array<{ type: string; text: string }>; isError?: boolean }): {
	text: string;
	isError: boolean;
} {
	return { text: body.content.map(c => c.text).join(""), isError: body.isError === true };
}

afterEach(() => {
	vi.restoreAllMocks();
	try {
		fs.rmSync(TMP, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

describe("dingtalk_attachment host tool — factory", () => {
	const registry = new TestRegistry() as unknown as ChannelRegistry;

	it("registers exactly one tool named 'dingtalk_attachment'", () => {
		const tools = createDingtalkAttachmentToolDefinitions({
			getBridge: () => stubAttachmentBridge(DM_MSG),
			registry,
			accountId: "default",
		});
		expect(tools).toHaveLength(1);
		expect(tools[0]!.definition.name).toBe("dingtalk_attachment");
	});

	it("definition has filePath as a parameter property", () => {
		const tools = createDingtalkAttachmentToolDefinitions({
			getBridge: () => stubAttachmentBridge(DM_MSG),
			registry,
			accountId: "default",
		});
		const params = tools[0]!.definition.parameters as Record<string, unknown>;
		const props = (params as { properties?: Record<string, unknown> })?.properties;
		expect(props).toBeDefined();
		expect(props).toHaveProperty("filePath");
		expect(props).toHaveProperty("originalName");
	});

	it("description mentions trigger phrases '直接附件发我看看'", () => {
		const tools = createDingtalkAttachmentToolDefinitions({
			getBridge: () => stubAttachmentBridge(DM_MSG),
			registry,
			accountId: "default",
		});
		expect(tools[0]!.definition.description).toContain("直接附件发我看看");
	});
});

describe("dingtalk_attachment host tool — parameter validation", () => {
	const registry = new TestRegistry() as unknown as ChannelRegistry;

	it("returns error when filePath is missing", async () => {
		const tools = createDingtalkAttachmentToolDefinitions({
			getBridge: () => stubAttachmentBridge(DM_MSG),
			registry,
			accountId: "default",
		});
		const result = await tools[0]!.handle({});
		const { text, isError } = asText(result);
		expect(isError).toBe(true);
		expect(text).toContain("Missing required parameter");
		expect(text).toContain("filePath");
	});

	it("returns error when filePath is not a string", async () => {
		const tools = createDingtalkAttachmentToolDefinitions({
			getBridge: () => stubAttachmentBridge(DM_MSG),
			registry,
			accountId: "default",
		});
		const result = await tools[0]!.handle({ filePath: 42 });
		const { text, isError } = asText(result);
		expect(isError).toBe(true);
		expect(text).toContain("Missing required parameter");
	});

	it("returns error when filePath is empty string", async () => {
		const tools = createDingtalkAttachmentToolDefinitions({
			getBridge: () => stubAttachmentBridge(DM_MSG),
			registry,
			accountId: "default",
		});
		const result = await tools[0]!.handle({ filePath: "" });
		const { text, isError } = asText(result);
		expect(isError).toBe(true);
		expect(text).toContain("Missing required parameter");
	});
});

describe("dingtalk_attachment host tool — file existence", () => {
	const registry = new TestRegistry() as unknown as ChannelRegistry;

	it("returns error when file does not exist", async () => {
		const tools = createDingtalkAttachmentToolDefinitions({
			getBridge: () => stubAttachmentBridge(DM_MSG),
			registry,
			accountId: "default",
		});
		const missing = tmpMissingFile();
		const result = await tools[0]!.handle({ filePath: missing });
		const { text, isError } = asText(result);
		expect(isError).toBe(true);
		expect(text).toContain("not found");
	});

	it("returns error when file path is a directory", async () => {
		const tools = createDingtalkAttachmentToolDefinitions({
			getBridge: () => stubAttachmentBridge(DM_MSG),
			registry,
			accountId: "default",
		});
		const result = await tools[0]!.handle({ filePath: TMP });
		const { isError } = asText(result);
		expect(isError).toBe(true);
	});
});

describe("dingtalk_attachment host tool — active chat context", () => {
	const registry = new TestRegistry() as unknown as ChannelRegistry;

	it("returns error when no active conversation exists", async () => {
		const existing = tmpFile();
		const tools = createDingtalkAttachmentToolDefinitions({
			getBridge: () => stubAttachmentBridge(undefined),
			registry,
			accountId: "default",
		});
		const result = await tools[0]!.handle({ filePath: existing });
		const { text, isError } = asText(result);
		expect(isError).toBe(true);
		expect(text).toContain("No active conversation");
	});
});

describe("dingtalk_attachment host tool — channel resolution", () => {
	it("returns error when dingtalk channel is not in registry", async () => {
		const existing = tmpFile();
		const tools = createDingtalkAttachmentToolDefinitions({
			getBridge: () => stubAttachmentBridge(DM_MSG),
			registry: new TestRegistry() as unknown as ChannelRegistry,
			accountId: "default",
		});
		const result = await tools[0]!.handle({ filePath: existing });
		const { text, isError } = asText(result);
		expect(isError).toBe(true);
		expect(text).toContain("DingTalk channel not found");
	});
});

describe("dingtalk_attachment host tool — success path (DM)", () => {
	let spy: ReturnType<typeof vi.spyOn>;
	const registry = new TestRegistry(new DingTalkChannel()) as unknown as ChannelRegistry;

	beforeEach(() => {
		spy = vi.spyOn(DingTalkChannel.prototype, "sendFile").mockResolvedValue();
	});

	afterEach(() => {
		spy.mockRestore();
	});

	it("sends file to the current DM conversation", async () => {
		const existing = tmpFile();
		const tools = createDingtalkAttachmentToolDefinitions({
			getBridge: () => stubAttachmentBridge(DM_MSG),
			registry,
			accountId: "default",
		});

		const result = await tools[0]!.handle({ filePath: existing });

		expect(asText(result).isError).toBe(false);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith({ type: "user", userId: "u123" } satisfies AICardTarget, existing, undefined);
	});

	it("passes originalName when provided", async () => {
		const existing = tmpFile();
		const tools = createDingtalkAttachmentToolDefinitions({
			getBridge: () => stubAttachmentBridge(DM_MSG),
			registry,
			accountId: "default",
		});

		const result = await tools[0]!.handle({
			filePath: existing,
			originalName: "my-paper.md",
		});

		expect(asText(result).isError).toBe(false);
		expect(spy).toHaveBeenCalledWith(
			{ type: "user", userId: "u123" } satisfies AICardTarget,
			existing,
			"my-paper.md",
		);
	});
});

describe("dingtalk_attachment host tool — success path (group)", () => {
	let spy: ReturnType<typeof vi.spyOn>;
	const registry = new TestRegistry(new DingTalkChannel()) as unknown as ChannelRegistry;

	beforeEach(() => {
		spy = vi.spyOn(DingTalkChannel.prototype, "sendFile").mockResolvedValue();
	});

	afterEach(() => {
		spy.mockRestore();
	});

	it("sends file to the current group conversation", async () => {
		const existing = tmpFile();
		const tools = createDingtalkAttachmentToolDefinitions({
			getBridge: () => stubAttachmentBridge(GROUP_MSG),
			registry,
			accountId: "algo",
		});

		const result = await tools[0]!.handle({ filePath: existing });

		expect(asText(result).isError).toBe(false);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith(
			{ type: "group", openConversationId: "conv-grp-789" } satisfies AICardTarget,
			existing,
			undefined,
		);
	});
});
