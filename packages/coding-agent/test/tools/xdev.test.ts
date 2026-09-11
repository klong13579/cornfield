import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@cornfield/coding-agent/config/settings";
import { XdevProtocolHandler } from "@cornfield/coding-agent/internal-urls/xd-protocol";
import type { ToolSession } from "@cornfield/coding-agent/tools";
import { createTools, WriteTool } from "@cornfield/coding-agent/tools";
import { normalizeToolName } from "@cornfield/coding-agent/tools/builtin-names";
import { buildXdevDeviceCatalog, splitToolsForXdev, xdevMountingActive } from "@cornfield/coding-agent/tools/xdev";
import { Type } from "@sinclair/typebox";

function createTestSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

describe("normalizeToolName", () => {
	it("maps legacy aliases to the same canonical tool", () => {
		expect(normalizeToolName("find")).toBe("glob");
		expect(normalizeToolName("search")).toBe("grep");
		expect(normalizeToolName("todo_write")).toBe("todo");
	});

	it("leaves canonical names, plugin, and MCP names untouched", () => {
		expect(normalizeToolName("glob")).toBe("glob");
		expect(normalizeToolName("grep")).toBe("grep");
		expect(normalizeToolName("todo")).toBe("todo");
		expect(normalizeToolName("mcp__exa__search")).toBe("mcp__exa__search");
		expect(normalizeToolName("my-plugin:tool")).toBe("my-plugin:tool");
	});
});

describe("splitToolsForXdev", () => {
	function fakeTool(name: string, loadMode?: string) {
		return {
			name,
			loadMode,
			description: `${name} description`,
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
		} as any;
	}

	it("keeps essential and internal tools top-level and mounts discoverable tools", () => {
		const split = splitToolsForXdev([
			fakeTool("read"),
			fakeTool("bash", "essential"),
			fakeTool("resolve", "internal"),
			fakeTool("notebook", "discoverable"),
			fakeTool("python"),
		]);
		const topNames = split.topLevel.map(t => t.name).sort();
		expect(topNames).toContain("read");
		expect(topNames).toContain("bash");
		expect(topNames).toContain("resolve");
		expect(split.devices.has("python")).toBe(true);
		expect(split.devices.has("notebook")).toBe(true);
	});

	it("never puts the same tool in both sets", () => {
		const tools = [fakeTool("read"), fakeTool("notebook", "discoverable"), fakeTool("web_search")];
		const split = splitToolsForXdev(tools);
		const topNames = new Set(split.topLevel.map(t => t.name));
		for (const name of split.devices.keys()) {
			expect(topNames.has(name)).toBe(false);
		}
		for (const tool of tools) {
			const inTop = topNames.has(tool.name);
			const inDevices = split.devices.has(tool.name);
			expect(inTop !== inDevices).toBe(true);
		}
	});

	it("honors XDEV_KEEP_TOP_LEVEL for prompt-coupled discoverable tools", () => {
		const split = splitToolsForXdev([fakeTool("web_search"), fakeTool("search_tool_bm25")]);
		expect(split.topLevel.map(t => t.name).sort()).toEqual(["search_tool_bm25", "web_search"]);
		expect(split.devices.size).toBe(0);
	});
});

describe("xdevMountingActive", () => {
	it("is off when tools.xdev is disabled", () => {
		const settings = Settings.isolated({ "tools.xdev": false });
		expect(xdevMountingActive(settings, false)).toBe(false);
	});

	it("is off when the agent explicitly requested tools", () => {
		const settings = Settings.isolated({ "tools.xdev": true });
		expect(xdevMountingActive(settings, true)).toBe(false);
	});

	it("is off under the bun test runtime even with the switch on (environment boundary)", () => {
		const settings = Settings.isolated({ "tools.xdev": true });
		expect(xdevMountingActive(settings, false)).toBe(false);
	});
});

describe("createTools with mounting", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function mockNonTestRuntime() {
		vi.spyOn(await import("@cornfield/utils"), "isBunTestRuntime").mockReturnValue(false);
	}

	it("mounts discoverable tools as devices when xdev is on and no tool list is requested", async () => {
		await mockNonTestRuntime();
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		const session = createTestSession({ settings: Settings.isolated({ "tools.xdev": true }) });
		const tools = await createTools(session);
		const names = new Set(tools.map(t => t.name));
		const devices = session.xdevDevices!;
		expect(devices.size).toBeGreaterThan(0);
		for (const name of devices.keys()) {
			expect(names.has(name)).toBe(false);
		}
		expect(names.has("read")).toBe(true);
		expect(devices.has("read")).toBe(false);
		expect(devices.has("write")).toBe(false);
		expect(names.has("web_search")).toBe(true);
	});

	it("gives every mounted device a non-empty, single-line summary", async () => {
		await mockNonTestRuntime();
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		const session = createTestSession({ settings: Settings.isolated({ "tools.xdev": true }) });
		await createTools(session);
		const devices = session.xdevDevices!;
		expect(devices.size).toBeGreaterThan(0);
		const blank: string[] = [];
		const multiline: string[] = [];
		for (const [name, tool] of devices) {
			const summary = (tool.summary ?? "").trim();
			if (summary.length === 0) {
				blank.push(name);
			} else if (summary.includes("\n")) {
				multiline.push(name);
			}
		}
		// `buildXdevDeviceCatalog` silently falls back to the description's first
		// line, so a device with no declared summary ships description prose into
		// the system-prompt catalog and nothing fails. These are that assertion.
		expect(blank).toEqual([]);
		expect(multiline).toEqual([]);
		const fellBackToDescription = buildXdevDeviceCatalog(devices)
			.entries.filter(entry => entry.summary !== (devices.get(entry.name)?.summary ?? "").trim())
			.map(entry => entry.name);
		expect(fellBackToDescription).toEqual([]);
	});

	it("keeps top-level exposure identical to pre-xdev behavior when the switch is off", async () => {
		await mockNonTestRuntime();
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		const session = createTestSession({ settings: Settings.isolated({ "tools.xdev": false }) });
		const tools = await createTools(session);
		expect(session.xdevDevices).toBeUndefined();
		// every builtin essential/discoverable tool remains directly callable
		const names = tools.map(t => t.name);
		for (const name of ["read", "write", "edit", "glob", "grep", "bash", "task", "todo", "notebook"]) {
			expect(names).toContain(name);
		}
	});

	it("keeps explicitly requested tools top-level even with xdev on", async () => {
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		const session = createTestSession({ settings: Settings.isolated({ "tools.xdev": true }) });
		const tools = await createTools(session, ["read", "notebook"]);
		const names = tools.map(t => t.name);
		expect(names).toEqual(["read", "notebook", "exit_plan_mode", "identity"]);
		expect(session.xdevDevices).toBeUndefined();
	});
});

describe("XdevProtocolHandler", () => {
	function fakeTool(name: string, description: string) {
		return {
			name,
			description,
			parameters: Type.Object({ value: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
		} as any;
	}

	it("lists mounted devices for the bare xd:// URL", async () => {
		const handler = new XdevProtocolHandler({
			getDevices: () => new Map([["notebook", fakeTool("notebook", "Run notebooks")]]),
		});
		const resource = await handler.resolve({ rawHost: "" } as any);
		expect(resource.contentType).toBe("text/markdown");
		expect(resource.content).toContain("xd://notebook");
	});

	it("returns a device manual with the wire schema", async () => {
		const handler = new XdevProtocolHandler({
			getDevices: () => new Map([["notebook", fakeTool("notebook", "Run notebooks")]]),
		});
		const resource = await handler.resolve({ rawHost: "notebook" } as any);
		expect(resource.content).toContain("Wire schema");
		expect(resource.content).toContain('"value"');
	});

	it("rejects unknown devices with the mounted catalog", async () => {
		const handler = new XdevProtocolHandler({
			getDevices: () => new Map([["notebook", fakeTool("notebook", "Run notebooks")]]),
		});
		await expect(handler.resolve({ rawHost: "nope" } as any)).rejects.toThrow("Unknown xd device: nope");
	});
});

describe("write xd:// transport", () => {
	function deviceTool(name: string) {
		const schema = Type.Object({ value: Type.String() });
		return {
			name,
			description: `${name} device`,
			parameters: schema,
			execute: async (_id: string, args: any) => ({
				content: [{ type: "text", text: `executed ${name} with ${args.value}` }],
				details: {},
			}),
		} as any;
	}

	async function writeWithDevices(devices: Map<string, any>): Promise<WriteTool> {
		const session = createTestSession({ settings: Settings.isolated() });
		session.xdevDevices = devices;
		return new WriteTool(session);
	}

	it("executes a mounted device whose JSON content matches the wire schema", async () => {
		const write = await writeWithDevices(new Map([["list_models", deviceTool("list_models")]]));
		const result = await write.execute("t1", { path: "xd://list_models", content: JSON.stringify({ value: "glm" }) });
		expect((result.content[0] as any).text).toBe("executed list_models with glm");
	});

	it("rejects content that fails the device wire schema", async () => {
		const write = await writeWithDevices(new Map([["list_models", deviceTool("list_models")]]));
		await expect(
			write.execute("t2", { path: "xd://list_models", content: JSON.stringify({ wrong: 1 }) }),
		).rejects.toThrow("wire schema");
	});

	it("rejects non-JSON content and unknown devices", async () => {
		const write = await writeWithDevices(new Map([["list_models", deviceTool("list_models")]]));
		await expect(write.execute("t3", { path: "xd://list_models", content: "{ not json" })).rejects.toThrow(
			"must be valid JSON",
		);
		await expect(write.execute("t4", { path: "xd://nope", content: "{}" })).rejects.toThrow(
			"Unknown xd device: nope",
		);
	});
});

describe("buildXdevDeviceCatalog", () => {
	it("caps entries by budget and reports the truncated remainder", () => {
		const devices = new Map<string, any>();
		for (let i = 0; i < 500; i++) {
			devices.set(`tool_${i}`, { name: `tool_${i}`, description: "x".repeat(50) });
		}
		const catalog = buildXdevDeviceCatalog(devices);
		expect(catalog.entries.length).toBeLessThan(500);
		expect(catalog.entries.length + catalog.truncated).toBe(500);
	});
});
