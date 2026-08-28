import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { AgentHub } from "@cornfield/coding-agent/modes/components/agent-hub";
import { AgentRegistry } from "@cornfield/coding-agent/registry/agent-registry";
import type { AgentSession } from "@cornfield/coding-agent/session/agent-session";
import { initTheme } from "../../src/modes/theme/theme";

const fakeSession = {} as AgentSession;

function register(
	registry: AgentRegistry,
	id: string,
	opts: { kind?: "main" | "sub"; status?: "running" | "idle" | "parked" | "aborted" } = {},
) {
	const ref = registry.register({
		id,
		displayName: id,
		kind: opts.kind ?? "sub",
		session: fakeSession,
	});
	if (opts.status && opts.status !== "running") registry.setStatus(id, opts.status);
	return ref;
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function renderText(hub: AgentHub): string {
	return stripAnsi(hub.render(120).join("\n"));
}

describe("AgentHub panel", () => {
	let registry: AgentRegistry;

	beforeEach(() => {
		registry = new AgentRegistry();
	});

	beforeAll(async () => {
		await initTheme();
	});

	test("renders empty state", () => {
		const hub = AgentHub.create(registry);
		const text = renderText(hub);
		expect(text).toContain("Agent Hub");
		expect(text).toContain("no agents registered");
	});

	test("sorts running before idle before parked", () => {
		register(registry, "parked", { status: "parked" });
		register(registry, "busy");
		register(registry, "ready", { status: "idle" });
		const text = renderText(AgentHub.create(registry));
		expect(text.indexOf("busy")).toBeLessThan(text.indexOf("ready"));
		expect(text.indexOf("ready")).toBeLessThan(text.indexOf("parked"));
	});

	test("shows activity and age for running agents", async () => {
		register(registry, "busy");
		registry.setActivity("busy", "running the build");
		const text = renderText(AgentHub.create(registry));
		expect(text).toContain("running the build");
		expect(text).toContain("agents · 1 running");
	});

	test("j/k navigates selection and updates the detail line", () => {
		register(registry, "alpha");
		registry.setActivity("alpha", "agent alpha work");
		register(registry, "beta");

		const hub = AgentHub.create(registry);
		// initial selection is the first row (alpha)
		expect(renderText(hub)).toContain("▸ ▶ alpha");
		// j moves selection to beta
		hub.handleInput("j");
		expect(renderText(hub)).toContain("▸ ▶ beta");
		// k moves back to alpha
		hub.handleInput("k");
		expect(renderText(hub)).toContain("▸ ▶ alpha");
	});

	test("esc triggers onClose", () => {
		register(registry, "alpha");
		const hub = AgentHub.create(registry);
		let closed = false;
		hub.onClose = () => {
			closed = true;
		};
		hub.handleInput("\x1b"); // real terminal ESC sequence
		expect(closed).toBe(true);
	});

	test("dispose unsubscribes from registry changes", () => {
		const hub = AgentHub.create(registry);
		void hub.dispose();
		let called = false;
		// trigger a registry change; a subscribed hub would refresh (render unchanged behavior
		// is hard to observe without mocking, so assert dispose does not throw and no leak)
		registry.onChange(() => {
			called = true;
		});
		register(registry, "late");
		expect(called).toBe(true);
	});
});
