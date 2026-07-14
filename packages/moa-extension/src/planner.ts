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

const READ_ONLY_TOOLS = ["read", "search", "find", "web_search"] as const;

function plannerTools(settings: MoaSettings): readonly string[] | "all" {
	return settings.plannerToolMode === "all" ? "all" : READ_ONLY_TOOLS;
}

/**
 * Render an output schema as a markdown block for the worker prompt. Each
 * section becomes a bullet; required sections are tagged; list-type sections
 * show the item-field shape. Workers see this and know exactly which section
 * names to emit.
 */
function renderOutputSchemaAsMarkdown(schema: MoaOutputSchema): string {
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
 * Build a single worker's prompt (no TCO yet — TCO is prepended at execution
 * time so all workers in a single run share the same context).
 */
function buildWorkerPrompt(
	worker: MoaWorkerSlot,
	task: string,
	schema: MoaOutputSchema = DEFAULT_OUTPUT_SCHEMA,
): string {
	return prompt.render(workerPromptTemplate, {
		task,
		role: worker.role,
		worker_prompt: `Approach the task from the ${worker.name} angle.`,
		output_schema: renderOutputSchemaAsMarkdown(schema),
	});
}

function buildWorkerPlans(
	task: string,
	settings: MoaSettings,
	schema: MoaOutputSchema = DEFAULT_OUTPUT_SCHEMA,
): MoaPlanWorker[] {
	const tools = plannerTools(settings);
	return settings.workers.slice(0, settings.workerCount).map(worker => ({
		name: worker.name,
		role: worker.role,
		prompt: buildWorkerPrompt(worker, task, schema),
		model: worker.model,
		thinking: worker.thinking,
		tools,
	}));
}

/**
 * Build a static plan from the task + settings. Discovery / rewrite
 * execution and TCO injection happen at execution time in `executor.ts`.
 *
 * `outputSchema` defaults to `DEFAULT_OUTPUT_SCHEMA`. PR2 will plumb the
 * Discovery LLM's schema through here; PR1 keeps the hardcoded default.
 */
export function buildPlan(
	task: string,
	settings: MoaSettings,
	outputSchema: MoaOutputSchema = DEFAULT_OUTPUT_SCHEMA,
): MoaPlan {
	const trimmedTask = task.trim();
	return {
		task: trimmedTask,
		workers: buildWorkerPlans(trimmedTask, settings, outputSchema),
		synthesisModel: settings.synthesisModel,
		synthesisThinking: settings.synthesisThinking,
	};
}
