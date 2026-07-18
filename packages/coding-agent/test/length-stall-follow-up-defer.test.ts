/**
 * Session-level follow-up deferral after progressless length.
 *
 * After a turn/run ends with progressless `length` (stall open or fused),
 * `#queueFollowUp` must leave the message queued and must NOT
 * `#scheduleAgentContinue` until the next user prompt / explicit continue.
 *
 * Distinct from Task 2 in-loop fuse@N: mid-run `getFollowUpMessages` may still
 * drive the outer loop until stallCount reaches N.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, getBundledModel } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

class MockAssistantStream extends AssistantMessageEventStream {}

function makeProgresslessLength(thinking: string): AssistantMessage {
	const base = createAssistantMessage("");
	return {
		...base,
		content: [{ type: "thinking", thinking }],
		stopReason: "length",
	};
}

function makeStop(text: string): AssistantMessage {
	return createAssistantMessage(text);
}

describe("length stall — session-level follow-up deferral", () => {
	let session: AgentSession;
	let tempDir: TempDir;
	let authStorage: AuthStorage | undefined;
	let callCount = 0;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-length-stall-follow-up-");
		callCount = 0;

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const settings = Settings.isolated({ "compaction.enabled": false });
		const sessionManager = SessionManager.inMemory(tempDir.path());

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
			},
			streamFn: () => {
				const idx = ++callCount;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (idx === 1) {
						const message = makeProgresslessLength("progressless length thinking");
						stream.push({ type: "start", partial: message });
						stream.push({ type: "done", reason: "length", message });
					} else {
						const message = makeStop(`continued after deferral (${idx})`);
						stream.push({ type: "start", partial: message });
						stream.push({ type: "done", reason: "stop", message });
					}
				});
				return stream;
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage?.close();
		authStorage = undefined;
		tempDir.removeSync();
	});

	it("after one progressless length, followUp stays queued and does not auto-continue", async () => {
		await session.prompt("Start a turn that hits progressless length.");
		await session.waitForIdle();

		expect(callCount).toBe(1);
		const last = session.getLastAssistantMessage();
		expect(last?.stopReason).toBe("length");
		expect(last?.content.some(c => c.type === "toolCall")).toBe(false);

		await session.followUp("async follow-up after progressless length");
		await session.waitForIdle();
		// Allow a tick for any incorrectly scheduled continue to fire.
		await Bun.sleep(50);
		await session.waitForIdle();

		// Must not start a new agent run until user prompt / explicit continue.
		expect(callCount).toBe(1);
		expect(session.getQueuedMessages().followUp).toEqual(["async follow-up after progressless length"]);
		expect(session.agent.hasQueuedMessages()).toBe(true);

		// Explicit continue delivers the deferred follow-up.
		await session.agent.continue();
		await session.waitForIdle();

		expect(callCount).toBe(2);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});
});
