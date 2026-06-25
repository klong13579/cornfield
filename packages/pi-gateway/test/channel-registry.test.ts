/**
 * Channel registry routing tests.
 */
import { describe, expect, test } from "bun:test";
import { ChannelRegistry } from "../src/channels/registry";
import type { Channel, ChannelCapabilities, ChannelConfig, InboundMessage, OutboundMessage } from "../src/types";

class FakeChannel implements Channel {
	readonly name: string;
	readonly capabilities: ChannelCapabilities = {
		inbound: true,
		outbound: true,
		richContent: false,
		groups: true,
		mentions: false,
		voice: false,
	};
	connected = false;
	sent: OutboundMessage[] = [];
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: written by onMessage; tests don't currently invoke it but the field is part of the Channel contract
	#handler?: (msg: InboundMessage) => Promise<void>;

	constructor(
		readonly id: string,
		name?: string,
	) {
		this.name = name ?? id;
	}

	async connect(_config: ChannelConfig): Promise<void> {
		this.connected = true;
	}

	async disconnect(): Promise<void> {
		this.connected = false;
	}

	isConnected(): boolean {
		return this.connected;
	}

	onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
		this.#handler = handler;
	}

	async sendMessage(msg: OutboundMessage): Promise<void> {
		this.sent.push(msg);
	}
}

describe("ChannelRegistry", () => {
	test("keeps account-specific channels with the same channel id", async () => {
		const registry = new ChannelRegistry();
		const ops = new FakeChannel("dingtalk", "ops");
		const hr = new FakeChannel("dingtalk", "hr");

		registry.register(ops, { enabled: true }, "dingtalk:ops");
		registry.register(hr, { enabled: true }, "dingtalk:hr");

		expect(registry.getAll()).toHaveLength(2);
		await registry.connectAll(async () => {});
		expect(ops.connected).toBe(true);
		expect(hr.connected).toBe(true);
	});

	test("routes outbound messages to the matching account channel", async () => {
		const registry = new ChannelRegistry();
		const ops = new FakeChannel("dingtalk", "ops");
		const hr = new FakeChannel("dingtalk", "hr");

		registry.register(ops, { enabled: true }, "dingtalk:ops");
		registry.register(hr, { enabled: true }, "dingtalk:hr");

		await registry.sendMessage({
			channelId: "dingtalk",
			accountId: "hr",
			conversationId: "conv1",
			content: { type: "text", text: "hello" },
		});

		expect(ops.sent).toHaveLength(0);
		expect(hr.sent).toHaveLength(1);
		expect(hr.sent[0]?.accountId).toBe("hr");
	});
});
