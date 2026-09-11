/**
 * `xd://` protocol handler — Tool device documentation (ADR-0003).
 *
 * `xd://` (no host) lists every device mounted in the session.
 * `xd://<tool>` returns the device manual: capability summary, full LLM
 * description, and the wire schema the model must satisfy when executing the
 * device through the write transport.
 *
 * Execution itself goes through the write tool's virtual-path dispatch table
 * (`write xd://<tool>` with JSON arguments) — this handler is read-only
 * documentation transport.
 */
import type { AgentTool } from "@cornfield/agent";
import { normalizeToolName } from "../tools/builtin-names";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

type Tool = AgentTool<any, any, any>;

export interface XdevProtocolOptions {
	/** Live view of the session's mounted devices. */
	getDevices: () => Map<string, Tool>;
}

function firstLine(text: string): string {
	return text.split("\n")[0]!.trim();
}

function deviceSummary(tool: Tool): string {
	return firstLine(tool.summary ?? tool.description ?? "");
}

function renderDeviceDoc(tool: Tool): string {
	const lines: string[] = [
		`# xd://${tool.name}`,
		"",
		deviceSummary(tool) || "Mounted tool device.",
		"",
		"## Usage",
		"",
		"This tool is mounted as an `xd://` device, not exposed as a direct tool call.",
		`- Inspect: \`read\` with path \`xd://${tool.name}\` returns this manual.`,
		`- Execute: \`write\` with path \`xd://${tool.name}\` and \`content\` set to the JSON arguments below.`,
		"",
		"## Description",
		"",
		tool.description ?? "(no description)",
		"",
		"## Wire schema",
		"",
		"```json",
		JSON.stringify(tool.parameters, null, 2),
		"```",
	];
	return lines.join("\n");
}

function renderCatalog(devices: Map<string, Tool>): string {
	const lines: string[] = [
		"# Mounted devices (xd://)",
		"",
		"Tools mounted as devices instead of direct tool calls.",
		"- `read xd://` — this catalog.",
		"- `read xd://<name>` — one device's manual and wire schema.",
		"- `write` with path `xd://<name>` and JSON content — execute the device.",
		"",
	];
	if (devices.size === 0) {
		lines.push("No devices are mounted in this session.");
	} else {
		for (const [name, tool] of devices) {
			lines.push(`- \`xd://${name}\` — ${deviceSummary(tool) || "Mounted tool device."}`);
		}
	}
	return lines.join("\n");
}

export class XdevProtocolHandler implements ProtocolHandler {
	readonly scheme = "xd";

	constructor(private readonly options: XdevProtocolOptions) {}

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const devices = this.options.getDevices();
		const rawName = url.rawHost.replace(/^\/+|\/+$/g, "");

		if (!rawName) {
			const content = renderCatalog(devices);
			return { url: "xd://", content, contentType: "text/markdown", size: content.length };
		}

		const name = normalizeToolName(rawName);
		const tool = devices.get(name);
		if (!tool) {
			const available = devices.size > 0 ? Array.from(devices.keys()).join(", ") : "none";
			throw new Error(
				`Unknown xd device: ${name}\nMounted devices: ${available}\nUse \`read\` with path \`xd://\` for the catalog.`,
			);
		}

		const url_ = `xd://${name}`;
		const content = renderDeviceDoc(tool);
		return { url: url_, content, contentType: "text/markdown", size: content.length };
	}
}
