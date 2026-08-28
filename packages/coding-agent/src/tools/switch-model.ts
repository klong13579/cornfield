import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@cornfield/agent";
import type { Model } from "@cornfield/ai";
import { logger, prompt } from "@cornfield/utils";
import { type Static, Type } from "@sinclair/typebox";
import switchModelDescription from "../prompts/tools/switch-model.md" with { type: "text" };
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

/**
 * `switch_model` — change the LLM used by the current omp session.
 *
 * Resolves a fuzzy query against the configured model registry, then calls
 * `AgentSession.setModel(model, role)`. Intended for gateway agents that
 * need to honor user model-switch requests (e.g. "切换模型到 X" / "switch to X")
 * through the LLM rather than via gateway-side regex interception.
 */

const switchModelSchema = Type.Object({
	query: Type.String({
		description:
			"Model identifier. Accepts 'provider/modelId' (e.g. 'anthropic/claude-opus-4-5'), " +
			"'provider:modelId', bare 'modelId', bare 'provider', or a fuzzy substring matched " +
			"against provider, id, and display name.",
		examples: ["minimax-m3", "narwal-plan/minimax-m3", "claude-opus", "anthropic/claude-opus-4-5"],
	}),
	role: Type.Optional(
		Type.Union([Type.Literal("default"), Type.Literal("temporary")], {
			description:
				"Whether the switch persists to settings ('default') or is a one-shot override " +
				"that resets on next session start ('temporary'). Defaults to 'default'.",
		}),
	),
});

type SwitchModelParams = Static<typeof switchModelSchema>;

export interface SwitchModelToolDetails {
	previousModel: string | undefined;
	newModel: string;
	role: "default" | "temporary";
}

export class SwitchModelTool implements AgentTool<typeof switchModelSchema, SwitchModelToolDetails> {
	readonly name = "switch_model";
	readonly label = "SwitchModel";
	readonly description: string;
	readonly parameters = switchModelSchema;
	readonly strict = false;
	readonly intent = (args: Partial<SwitchModelParams>): string => {
		const q = typeof args.query === "string" ? args.query.trim() : "";
		const role = args.role === "temporary" ? "（临时）" : "";
		return q ? `Switching model to ${q}${role}` : "Switching model";
	};

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(switchModelDescription);
	}

	async execute(
		_toolCallId: string,
		params: SwitchModelParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SwitchModelToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SwitchModelToolDetails>> {
		const setModel = this.session.setModel;
		if (!setModel) {
			throw new ToolError("Model switching is not available in this session (no setModel binding).");
		}

		const models = this.collectAvailableModels();
		if (models.length === 0) {
			throw new ToolError(
				"No models available. Check provider configuration and API keys in " +
					"~/.omp/agent/config.yml and ~/.omp/agent/auth.db.",
			);
		}

		const match = resolveModel(models, params.query, this.session.settings.getRecommendedModels?.());
		if (!match) {
			const hint = models
				.slice(0, 10)
				.map(m => `\`${m.provider}/${m.id}\``)
				.join("、");
			throw new ToolError(
				`未找到匹配 "${params.query}" 的模型。可用示例：${hint}` +
					(models.length > 10 ? `（共 ${models.length} 个，更多请用 \`omp models list\`）` : ""),
			);
		}

		const role = params.role ?? "default";
		const previous = this.session.getActiveModelString?.();
		const newModelString = `${match.provider}/${match.id}`;

		logger.info("switch_model: applying", {
			from: previous,
			to: newModelString,
			role,
		});

		await setModel(match, role);

		const displaySuffix = match.name && match.name !== match.id ? `（${match.name}）` : "";
		const roleSuffix = role === "temporary" ? "（临时，仅本次会话）" : "";

		return {
			content: [
				{
					type: "text",
					text: `已切换模型：${newModelString}${displaySuffix}${roleSuffix}\n\n下一条消息起将使用新模型回复。`,
				},
			],
			details: { previousModel: previous, newModel: newModelString, role },
		};
	}

	/**
	 * Collect all available models. Prefer ToolSession.getAvailableModels when
	 * bound (it carries the session's view of "available" — i.e. models the
	 * session can actually call given the current auth/registry state). Fall
	 * back to the model registry on the session.
	 */
	private collectAvailableModels(): Model[] {
		const fromSession = this.session.getAvailableModels?.();
		if (fromSession && fromSession.length > 0) return fromSession;
		const registry = this.session.modelRegistry;
		return registry ? registry.getAvailable() : [];
	}
}

/**
 * Resolve a user-provided query against the available model registry.
 *
 * Match priority:
 * 1. Exact `provider/id` (slash or colon separator) — must match both fields
 * 2. Exact provider (matches any model under that provider, returns the first)
 * 3. Exact id (case-insensitive)
 * 4. Normalized substring — strip `-`, `_`, `.` from both query and model id
 *    so `kimi`, `kimi2.6`, `kimi k2.6` all match `kimi-k2.6`
 * 5. Display name substring (case-insensitive)
 *
 * Within each tier, models from `preferredKeys` ("provider/modelId") are picked
 * before other candidates while the rest keep their original order — mirroring
 * the model selector's "recommended models first" sorting. Pass the session's
 * `recommendedModels` config to honor it during llm-driven switches.
 *
 * Returns null if nothing matched. Caller surfaces the candidate list on miss.
 */
export function resolveModel(models: Model[], query: string, preferredKeys?: readonly string[]): Model | null {
	const q = query.trim().toLowerCase();
	if (!q) return null;

	const preferred = new Set(preferredKeys ?? []);

	// Pick from ordered candidates: preferred (recommended) models win; otherwise
	// the first candidate in original order is returned. Equivalent to the
	// previous `find` semantics when preferredKeys is empty/undefined.
	const pick = (candidates: Model[]): Model | null => {
		if (candidates.length === 0) return null;
		if (preferred.size === 0) return candidates[0];
		return candidates.find(m => preferred.has(`${m.provider}/${m.id}`)) ?? candidates[0];
	};

	// 1. exact provider/id (slash or colon)
	for (const sep of ["/", ":"]) {
		if (q.includes(sep)) {
			const [p, m] = q.split(sep, 2);
			const hit = pick(models.filter(x => x.provider.toLowerCase() === p && x.id.toLowerCase() === m));
			if (hit) return hit;
		}
	}

	// 2. exact provider (returns first model under that provider)
	const provHit = pick(models.filter(x => x.provider.toLowerCase() === q));
	if (provHit) return provHit;

	// 3. exact id
	const idHit = pick(models.filter(x => x.id.toLowerCase() === q));
	if (idHit) return idHit;

	// 4. normalized substring (strip - _ . and spaces)
	const normalized = q.replace(/[-_.]/g, "").replace(/\s+/g, "");
	if (normalized) {
		const subHit = pick(
			models.filter(x => {
				const mid = x.id.toLowerCase();
				const mprovider = x.provider.toLowerCase();
				const midNorm = mid.replace(/[-_.]/g, "");
				const mproviderNorm = mprovider.replace(/[-_.]/g, "");
				return (
					mid.includes(q) ||
					q.includes(mid) ||
					midNorm.includes(normalized) ||
					normalized.includes(midNorm) ||
					mprovider.includes(q) ||
					q.includes(mprovider) ||
					mproviderNorm.includes(normalized) ||
					normalized.includes(mproviderNorm)
				);
			}),
		);
		if (subHit) return subHit;
	}

	// 5. display name
	const nameHit = pick(models.filter(x => x.name?.toLowerCase().includes(q)));
	if (nameHit) return nameHit;

	return null;
}
