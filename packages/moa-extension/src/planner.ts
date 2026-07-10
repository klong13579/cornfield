import { prompt } from "@oh-my-pi/pi-utils";
import discoveryPromptTemplate from "./prompts/discovery.md" with { type: "text" };
import rewritePromptTemplate from "./prompts/rewrite.md" with { type: "text" };
import workerPromptTemplate from "./prompts/worker.md" with { type: "text" };
import type { MoaPlan, MoaPlanWorker, MoaSettings } from "./types";

const READ_ONLY_TOOLS = ["read", "search", "find", "web_search"] as const;

function plannerTools(settings: MoaSettings): readonly string[] | "all" {
	return settings.plannerToolMode === "all" ? "all" : READ_ONLY_TOOLS;
}

function buildWorkerPlans(task: string, settings: MoaSettings): MoaPlanWorker[] {
	const tools = plannerTools(settings);
	return settings.workers.slice(0, settings.workerCount).map(worker => ({
		name: worker.name,
		role: worker.role,
		prompt: prompt.render(workerPromptTemplate, {
			task,
			role: worker.role,
			worker_prompt: `Approach the task from the ${worker.name} angle.`,
		}),
		model: worker.model,
		thinking: worker.thinking,
		tools,
	}));
}

export function buildPlan(task: string, settings: MoaSettings): MoaPlan {
	const trimmedTask = task.trim();
	return {
		task: trimmedTask,
		discoveryPrompt: settings.discoveryEnabled
			? prompt.render(discoveryPromptTemplate, { task: trimmedTask })
			: undefined,
		rewritePrompt: settings.rewriteEnabled ? prompt.render(rewritePromptTemplate, { task: trimmedTask }) : undefined,
		workers: buildWorkerPlans(trimmedTask, settings),
		synthesisModel: settings.synthesisModel,
		synthesisThinking: settings.synthesisThinking,
	};
}
