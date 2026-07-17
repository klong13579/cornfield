import { prompt } from "@oh-my-pi/pi-utils";
import workerPromptTemplate from "./prompts/worker.md" with { type: "text" };
import {
	DEFAULT_OUTPUT_SCHEMA,
	type MoaOutputSchema,
	type MoaPlan,
	type MoaPlanWorker,
	type MoaSettings,
	type MoaWorkerSlot,
} from "./types";

const READ_ONLY_TOOLS = ["read", "search", "find", "web_search", "ast_grep"] as const;

function plannerTools(settings: MoaSettings): readonly string[] | "all" {
	return settings.plannerToolMode === "all" ? "all" : READ_ONLY_TOOLS;
}

/**
 * Render an output schema as a markdown block for the worker prompt. Each
 * section becomes a bullet; required sections are tagged; list-type sections
 * show the item-field shape. Workers see this and know exactly which section
 * names to emit.
 */
export function renderOutputSchemaAsMarkdown(schema: MoaOutputSchema): string {
	const lines: string[] = [];
	for (const sec of schema.sections) {
		const req = sec.required ? "_(required)_" : "_(optional)_";
		const typeTag = `\`type: ${sec.type}\``;
		const item =
			sec.item && Object.keys(sec.item).length > 0
				? `  each item: \`${Object.entries(sec.item)
						.map(([k, v]) => `${k}: ${v}`)
						.join(" | ")}\``
				: "";
		lines.push(`- \`## ${sec.name}\` ${req} ${typeTag}${item}`);
	}
	return lines.join("\n");
}

/**
 * User-message wrapper for plan workers. The bare task alone causes models to
 * answer in freeform prose and omit schema headers (system-prompt-only
 * reminders are routinely ignored). Force the exact `## <name>` sequence as
 * the first lines of the reply.
 */
export function buildWorkerTaskMessage(task: string, schema: MoaOutputSchema): string {
	const headers = schema.sections.map(s => {
		const tag = s.required ? "required" : "optional";
		return `- \`## ${s.name}\` (${tag}, ${s.type})`;
	});
	const first = schema.sections[0]?.name;
	const firstLine = first
		? `Your FIRST line MUST be exactly \`## ${first}\` (no preamble, no Chinese title substitutes).`
		: "Emit only the schema section headers listed below.";
	return [
		"Complete this MoA worker assignment.",
		"",
		"## Task",
		task.trim(),
		"",
		"## Output contract (non-negotiable)",
		firstLine,
		"Then continue with the remaining schema headers in this exact order:",
		...headers,
		"",
		"Do not invent alternate headers (e.g. `## 设计`, `## Step 1`). The orchestrator parses by section name.",
	].join("\n");
}

/**
 * Build a single worker's prompt (no TCO yet — TCO is prepended at execution
 * time so all workers in a single run share the same context).
 */
function buildWorkerPrompt(
	worker: MoaWorkerSlot,
	task: string,
	schema: MoaOutputSchema = DEFAULT_OUTPUT_SCHEMA,
	researchGuidance = "",
): string {
	return prompt.render(workerPromptTemplate, {
		task,
		role: worker.role,
		worker_prompt: `Approach the task from the ${worker.name} angle.`,
		output_schema: renderOutputSchemaAsMarkdown(schema),
		research_guidance: researchGuidance || undefined,
	});
}

function buildWorkerPlans(
	task: string,
	settings: MoaSettings,
	schema: MoaOutputSchema = DEFAULT_OUTPUT_SCHEMA,
	researchGuidance = "",
): MoaPlanWorker[] {
	const tools = plannerTools(settings);
	return settings.workers.slice(0, settings.workerCount).map(worker => ({
		name: worker.name,
		role: worker.role,
		prompt: buildWorkerPrompt(worker, task, schema, researchGuidance),
		model: worker.model,
		thinking: worker.thinking,
		tools,
	}));
}

/**
 * Build a static plan from the task + settings. Discovery / rewrite
 * execution and TCO injection happen at execution time in `executor.ts`.
 *
 * `outputSchema` defaults to `DEFAULT_OUTPUT_SCHEMA`. After Discovery,
 * the executor rebinds prompts via `rebindWorkerPrompts` so the
 * Discovery-driven schema reaches workers without dropping plan slots.
 */
export function buildPlan(
	task: string,
	settings: MoaSettings,
	outputSchema: MoaOutputSchema = DEFAULT_OUTPUT_SCHEMA,
	researchGuidance = "",
): MoaPlan {
	const trimmedTask = task.trim();
	return {
		task: trimmedTask,
		workers: buildWorkerPlans(trimmedTask, settings, outputSchema, researchGuidance),
		synthesisModel: settings.synthesisModel,
		synthesisThinking: settings.synthesisThinking,
	};
}

/**
 * Re-render worker prompts against a (possibly Discovery-driven) schema
 * while preserving name / role / model / thinking / tools from the plan.
 */
export function rebindWorkerPrompts(
	workers: ReadonlyArray<MoaPlanWorker>,
	task: string,
	schema: MoaOutputSchema,
	researchGuidance = "",
): MoaPlanWorker[] {
	return workers.map(worker => ({
		...worker,
		prompt: buildWorkerPrompt(
			{ name: worker.name, role: worker.role, model: worker.model, thinking: worker.thinking },
			task,
			schema,
			researchGuidance,
		),
	}));
}
