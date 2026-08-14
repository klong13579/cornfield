import { beforeEach, describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";
import type { HubDetails } from "@oh-my-pi/pi-coding-agent/tools/hub/types";

const fakeSession = {} as AgentSession;

function makeToolSession(registry: AgentRegistry, agentId: string): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		agentRegistry: registry,
		getAgentId: () => agentId,
	} as ToolSession;
}

function toolText(res: { content: Array<{ type: string; text?: string }> }): string {
	return (res.content.find(c => c.type === "text") as { text: string } | undefined)?.text ?? "";
}

describe("HubTool", () => {
	let registry: AgentRegistry;

	beforeEach(() => {
		registry = new AgentRegistry();
	});

	test("createIf returns null without a registry or agent id", () => {
		const session = makeToolSession(registry, "0-Main");
		session.agentRegistry = undefined;
		expect(HubTool.createIf(session)).toBeNull();
		const session2 = makeToolSession(registry, "0-Main");
		session2.getAgentId = undefined;
		expect(HubTool.createIf(session2)).toBeNull();
	});

	test("list is empty when no peers", async () => {
		const tool = HubTool.createIf(makeToolSession(registry, "0-Main"))!;
		const res = await tool.execute("id", {});
		const details = res.details as HubDetails;
		expect(details.op).toBe("list");
		expect(details.count).toBe(0);
		expect(toolText(res)).toContain("No other live agents");
	});

	test("list shows peers with activity and recency sort", async () => {
		const a = registry.register({ id: "a", displayName: "A", kind: "sub", session: fakeSession });
		const b = registry.register({ id: "b", displayName: "B", kind: "sub", session: fakeSession });
		registry.setActivity("b", "running the build");
		// bump a's activity so it becomes most recent
		await Bun.sleep(2);
		registry.setActivity("a", "thinking");

		const tool = HubTool.createIf(makeToolSession(registry, "0-Main"))!;
		const res = await tool.execute("id", {});
		const details = res.details as HubDetails;
		expect(details.count).toBe(2);
		// recency: a was active after b
		expect(details.peers?.[0].id).toBe("a");
		expect(details.peers?.[0].activity).toBe("thinking");
		expect(details.peers?.[1].activity).toBe("running the build");
		expect(toolText(res)).toContain("running the build");
		// main itself is excluded
		expect(details.peers?.some(p => p.id === "0-Main")).toBe(false);
	});

	test("list excludes parked/aborted and advisor refs", async () => {
		registry.register({ id: "a", displayName: "A", kind: "sub", session: fakeSession });
		registry.register({ id: "parked", displayName: "P", kind: "sub", session: fakeSession });
		registry.setStatus("parked", "parked");
		registry.register({ id: "adv", displayName: "Adv", kind: "advisor", session: fakeSession });

		const tool = HubTool.createIf(makeToolSession(registry, "0-Main"))!;
		const res = await tool.execute("id", {});
		expect((res.details as HubDetails).peers?.map(p => p.id)).toEqual(["a"]);
	});

	test("show returns detail for a live peer", async () => {
		const ref = registry.register({
			id: "a",
			displayName: "A",
			kind: "sub",
			parentId: "0-Main",
			session: fakeSession,
			sessionFile: "/tmp/sess.jsonl",
		});
		registry.setHistory("a", { modelRole: "smol", resolvedModel: "deepseek-v4-flash" });
		registry.setActivity("a", "writing tests");
		void ref;

		const tool = HubTool.createIf(makeToolSession(registry, "0-Main"))!;
		const res = await tool.execute("id", { op: "show", id: "a" });
		const details = res.details as HubDetails;
		expect(details.peer?.id).toBe("a");
		expect(details.peer?.parentId).toBe("0-Main");
		expect(details.peer?.history?.modelRole).toBe("smol");
		expect(details.peer?.history?.resolvedModel).toBe("deepseek-v4-flash");
		expect(toolText(res)).toContain("# a");
	});

	test("show reports unknown/unavailable peers", async () => {
		const tool = HubTool.createIf(makeToolSession(registry, "0-Main"))!;
		// never registered
		let res = await tool.execute("id", { op: "show", id: "ghost" });
		expect((res.details as HubDetails).unknown).toEqual(["ghost"]);
		// parked
		registry.register({ id: "p", displayName: "P", kind: "sub", session: fakeSession });
		registry.setStatus("p", "parked");
		res = await tool.execute("id", { op: "show", id: "p" });
		expect((res.details as HubDetails).unknown).toEqual(["p"]);
		// self
		registry.register({ id: "0-Main", displayName: "Main", kind: "main", session: fakeSession });
		res = await tool.execute("id", { op: "show", id: "0-Main" });
		expect((res.details as HubDetails).unknown).toEqual(["0-Main"]);
	});

	test("show without id errors", async () => {
		const tool = HubTool.createIf(makeToolSession(registry, "0-Main"))!;
		const res = await tool.execute("id", { op: "show" });
		expect(toolText(res)).toContain("`id` is required");
	});
});
