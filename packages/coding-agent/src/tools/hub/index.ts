/**
 * Hub tool — read-only, work-aware agent roster.
 *
 * Complements `irc` (messaging) and `job` (async-job control): lists every
 * live peer in this process with what it is currently doing (activity gist,
 * freshness), and exposes one peer's identity/history in detail. It never
 * sends, kills, or revives agents — operational actions stay in `irc`/`job`
 * or with a human operator.
 *
 * Ported from the upstream hub tool (2026-08) with the messaging/job/launch
 * ops removed: messaging already lives in `irc`, job control in `job`, and
 * the daemon-broker launch subsystem is not part of this workspace.
 */

import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { formatAge } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import hubDescription from "../../prompts/tools/hub.md" with { type: "text" };
import type { AgentRef, AgentRegistry } from "../../registry/agent-registry";
import type { ToolSession } from "..";
import { type HubDetails, type HubPeerDetail, type HubPeerInfo, sortPeersByRecency } from "./types";

const hubSchema = Type.Object({
	op: Type.Optional(
		Type.Union(
			[
				Type.Literal("list", { description: "List all live peers with activity" }),
				Type.Literal("show", { description: "Show one peer's identity and history in detail" }),
			],
			{ description: "Hub operation (default: list)" },
		),
	),
	id: Type.Optional(
		Type.String({
			description: 'Peer agent id for op="show" (e.g. "0-Main", "0-AuthLoader")',
			examples: ["0-Main"],
		}),
	),
});

type HubParams = Static<typeof hubSchema>;

export class HubTool implements AgentTool<typeof hubSchema, HubDetails> {
	readonly name = "hub";
	readonly label = "Hub";
	readonly description: string;
	readonly parameters = hubSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {
		this.description = hubDescription;
	}

	static createIf(session: ToolSession): HubTool | null {
		if (!session.agentRegistry || !session.getAgentId) return null;
		return new HubTool(session);
	}

	async execute(_toolCallId: string, params: HubParams): Promise<AgentToolResult<HubDetails>> {
		const registry = this.session.agentRegistry;
		const senderId = this.session.getAgentId?.() ?? null;
		if (!registry) {
			return errorResult("Hub is unavailable in this session.", { op: (params.op ?? "list") as "list", count: 0 });
		}
		if (!senderId) {
			return errorResult("Hub is unavailable: caller has no agent id.", {
				op: (params.op ?? "list") as "list",
				count: 0,
			});
		}

		const op = params.op ?? "list";

		if (op === "list") {
			return this.#executeList(registry, senderId);
		}

		const id = params.id?.trim();
		if (!id) {
			return errorResult('`id` is required for op="show".', { op, from: senderId, count: 0 });
		}
		return this.#executeShow(registry, senderId, id);
	}

	#executeList(registry: AgentRegistry, senderId: string): AgentToolResult<HubDetails> {
		const refs = sortPeersByRecency(registry.listVisibleTo(senderId));
		const peers: HubPeerInfo[] = refs.map(toPeerInfo);

		const lines: string[] = [];
		if (peers.length === 0) {
			lines.push("No other live agents.");
		} else {
			lines.push(`${peers.length} live agent(s), newest activity first:`);
			lines.push("");
			for (const peer of peers) {
				const age = peer.lastActivity ? formatAge((Date.now() - peer.lastActivity) / 1000) : "n/a";
				const statusTag = peer.status === "running" ? "▶ running" : `○ ${peer.status}`;
				if (peer.activity) {
					lines.push(`- ${peer.id} [${peer.displayName} · ${statusTag} · ${age}] — ${peer.activity}`);
				} else {
					lines.push(`- ${peer.id} [${peer.displayName} · ${statusTag} · ${age}]`);
				}
			}
			lines.push("");
			lines.push("Message a peer with irc op=send; wait/cancel background work with job poll/cancel.");
		}

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { op: "list", from: senderId, count: peers.length, peers },
		};
	}

	#executeShow(registry: AgentRegistry, senderId: string, id: string): AgentToolResult<HubDetails> {
		const ref = registry.get(id);
		if (!ref || ref.id === senderId || (ref.status !== "running" && ref.status !== "idle")) {
			return {
				content: [{ type: "text", text: `Unknown or unavailable peer: ${id}` }],
				details: { op: "show", from: senderId, count: 0, unknown: [id] },
			};
		}

		const peer: HubPeerDetail = {
			...toPeerInfo(ref),
			createdAt: ref.createdAt,
		};
		if (ref.history) {
			peer.history = {
				agent: ref.history.agent,
				modelRole: ref.history.modelRole,
				resolvedModel: ref.history.resolvedModel,
				metrics: ref.history.metrics,
				outputPath: ref.history.outputPath,
				patchPath: ref.history.patchPath,
				branchName: ref.history.branchName,
			};
		}

		const lines: string[] = [`# ${peer.id}`, ""];
		lines.push(`- displayName: ${peer.displayName}`);
		lines.push(`- kind: ${peer.kind}`);
		lines.push(`- status: ${peer.status}`);
		if (peer.parentId) lines.push(`- parent: ${peer.parentId}`);
		if (peer.activity) lines.push(`- activity: ${peer.activity}`);
		if (peer.lastActivity) {
			lines.push(`- last activity: ${formatAge((Date.now() - peer.lastActivity) / 1000)} ago`);
		}
		if (peer.sessionFile) lines.push(`- session: ${peer.sessionFile}`);
		if (peer.history?.modelRole) lines.push(`- model role: ${peer.history.modelRole}`);
		if (peer.history?.resolvedModel) lines.push(`- model: ${peer.history.resolvedModel}`);
		if (peer.history?.metrics) {
			const m = peer.history.metrics;
			lines.push(
				`- tokens: ${m.tokens} · requests: ${m.requests} · tools: ${m.tools} · cost: $${m.cost.toFixed(4)} · duration: ${m.durationMs}ms`,
			);
		}
		if (peer.history?.outputPath) lines.push(`- output artifact: ${peer.history.outputPath}`);

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { op: "show", from: senderId, count: 1, peer },
		};
	}
}

function toPeerInfo(ref: AgentRef): HubPeerInfo {
	return {
		id: ref.id,
		displayName: ref.displayName,
		kind: ref.kind,
		status: ref.status,
		...(ref.parentId ? { parentId: ref.parentId } : {}),
		...(ref.activity ? { activity: ref.activity } : {}),
		lastActivity: ref.lastActivity,
		sessionFile: ref.sessionFile,
	};
}

function errorResult(text: string, details: HubDetails): AgentToolResult<HubDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}
