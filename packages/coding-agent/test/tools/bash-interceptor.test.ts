import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@cornfield/agent";
import { bashToolRenderer } from "@cornfield/coding-agent/tools/bash";
import { checkBashInterception } from "@cornfield/coding-agent/tools/bash-interceptor";
import type { BashInterceptorRule } from "../../src/config/settings-schema";
import type { ToolSession } from "../../src/tools";
import { BashTool } from "../../src/tools/bash";
import { createRenderSurface } from "../helpers/render-assert";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

function createSettings(rules: BashInterceptorRule[]) {
	return {
		get(key: string) {
			if (key === "bashInterceptor.enabled") return true;
			if (key === "async.enabled") return false;
			if (key === "bash.autoBackground.enabled") return false;
			if (key === "bash.autoBackground.thresholdMs") return 60_000;
			return undefined;
		},
		getBashInterceptorRules() {
			return rules;
		},
	};
}

function createBashTool(rules: BashInterceptorRule[]): BashTool {
	const session = { settings: createSettings(rules) } as unknown as ToolSession;
	return new BashTool(session);
}

/** A session whose cwd exists, so the tool can run the command it was given. */
async function createExecTool(rules: BashInterceptorRule[] = []): Promise<{ tool: BashTool; cwd: string }> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bash-cd-extraction-"));
	tempDirs.push(cwd);
	const session = { cwd, settings: createSettings(rules) } as unknown as ToolSession;
	return { tool: new BashTool(session), cwd };
}

function getResultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

describe("BashTool interception", () => {
	it("checks the original command before leading cd normalization", async () => {
		const tool = createBashTool([
			{
				pattern: "^\\s*cd\\s+",
				tool: "bash",
				message: "Do not hide directory changes in the command string.",
			},
		]);

		await expect(
			tool.execute("tool-call", { command: "cd packages/coding-agent && echo ok" }, undefined, undefined, {
				toolNames: ["bash"],
			} as AgentToolContext),
		).rejects.toThrow("Do not hide directory changes");
	});

	it("checks the cwd-normalized command after leading cd normalization", async () => {
		const tool = createBashTool([
			{
				pattern: "^\\s*cat\\s+",
				tool: "read",
				message: "Use read instead.",
			},
		]);

		await expect(
			tool.execute("tool-call", { command: "cd packages/coding-agent && cat package.json" }, undefined, undefined, {
				toolNames: ["read"],
			} as AgentToolContext),
		).rejects.toThrow("Use read instead");
	});

	it("quotes the original command when only the cd-normalized form matched", async () => {
		const command = "cd packages/coding-agent && cat package.json";
		const tool = createBashTool([{ pattern: "^\\s*cat\\s+", tool: "read", message: "Use read instead." }]);

		await expect(
			tool.execute("tool-call", { command }, undefined, undefined, { toolNames: ["read"] } as AgentToolContext),
		).rejects.toThrow(`Original command: ${command}`);
	});

	it("routes an escaped cd target into cwd", async () => {
		const { tool, cwd } = await createExecTool();
		const target = path.join(cwd, "dir with space");
		await fs.mkdir(target);

		// The escape is resolved by the extractor; an unresolved one reaches the shell
		// as a literal backslash, and the call fails on a directory that does not exist.
		const result = await tool.execute(
			"tool-call",
			{ command: `cd ${target.replace(/ /gu, "\\ ")} && pwd` },
			undefined,
			undefined,
			{ toolNames: [] as string[] } as AgentToolContext,
		);

		expect(getResultText(result)).toContain(target);
	});

	it("leaves a cd prefix the shell must interpret to the shell", async () => {
		const { tool, cwd } = await createExecTool();

		// `2>/dev/null` means this is not a bare `cd <path>`: absorbing it into cwd
		// pointed the call at a directory named `<cwd> 2>/dev/null`.
		const result = await tool.execute(
			"tool-call",
			{ command: `cd "${cwd}" 2>/dev/null && pwd` },
			undefined,
			undefined,
			{ toolNames: [] as string[] } as AgentToolContext,
		);

		expect(getResultText(result)).toContain(cwd);
	});
});

describe("bash interception rendering", () => {
	it("renders the blocked message with the original command", async () => {
		const surface = await createRenderSurface({ theme: "dark", width: 80 });
		const command = "ls && cat foo.txt";
		const interception = checkBashInterception(command, ["bash", "read", "grep", "glob", "edit", "write"]);
		expect(interception.block).toBe(true);
		const render = () =>
			bashToolRenderer.renderResult(
				{ content: [{ type: "text", text: interception.message ?? "" }], isError: true },
				{ expanded: false, isPartial: false },
				surface.theme,
				{ command },
			);

		const rendered = surface.expectStable(render);
		expect(rendered).toContain("Blocked:");
		expect(rendered).toContain(`Original command: ${command}`);
		surface.expectWithinWidth(render());
	});
});
