import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type * as piCodingAgent from "@oh-my-pi/pi-coding-agent";
import type { AgentDefinition, AuthStorage, ModelRegistry, Settings, SingleResult } from "@oh-my-pi/pi-coding-agent";
import { prompt } from "@oh-my-pi/pi-utils";
import synthesisPromptTemplate from "./prompts/synthesis.md" with { type: "text" };
import type { MoaExecutionResult, MoaPlan, MoaPlanWorker, MoaWorkerResult } from "./types";

type RunSubprocess = typeof piCodingAgent.runSubprocess;

export interface ExecutePlanOptions {
	cwd: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settings: Settings;
	runSubprocess: RunSubprocess;
	signal?: AbortSignal;
}

function toThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
	return value as ThinkingLevel | undefined;
}

function createWorkerAgent(worker: MoaPlanWorker): AgentDefinition {
	return {
		name: worker.name,
		description: `MOA worker: ${worker.role}`,
		systemPrompt: worker.prompt,
		tools: worker.tools === "all" ? undefined : [...worker.tools],
		model: worker.model ? [worker.model] : undefined,
		thinkingLevel: toThinkingLevel(worker.thinking),
		source: "project",
	};
}

function createSynthesisAgent(plan: MoaPlan, workerOutputs: string): AgentDefinition {
	return {
		name: "synthesis",
		description: "Choose and justify the final MOA recommendation",
		systemPrompt: prompt.render(synthesisPromptTemplate, {
			task: plan.task,
			discovery_brief: undefined,
			worker_outputs: workerOutputs,
		}),
		tools: ["__none__"],
		model: plan.synthesisModel ? [plan.synthesisModel] : undefined,
		thinkingLevel: toThinkingLevel(plan.synthesisThinking),
		source: "project",
	};
}

function mapSingleResult(result: SingleResult, role: string, model?: string): MoaWorkerResult {
	return {
		name: result.agent,
		role,
		ok: result.exitCode === 0 && result.output.trim().length > 0,
		output: result.output,
		stderr: result.stderr,
		exitCode: result.exitCode,
		model,
	};
}

function mapExecutionError(name: string, role: string, error: unknown, model?: string): MoaWorkerResult {
	const message = error instanceof Error ? error.message : String(error);
	return {
		name,
		role,
		ok: false,
		output: "",
		stderr: message,
		exitCode: null,
		model,
	};
}

function buildWorkerDigest(result: MoaWorkerResult): string {
	const status = result.ok ? "ok" : `failed${result.exitCode === null ? "" : ` (${result.exitCode})`}`;
	const sections = [`## ${result.name}`, `- role: ${result.role}`, `- status: ${status}`];
	if (result.output.trim()) {
		sections.push("", "### output", result.output.trim());
	}
	if (result.stderr.trim()) {
		sections.push("", "### stderr", result.stderr.trim());
	}
	if (!result.output.trim() && !result.stderr.trim()) {
		sections.push("", "(no output)");
	}
	return sections.join("\n");
}

async function runWorker(
	plan: MoaPlan,
	worker: MoaPlanWorker,
	index: number,
	options: ExecutePlanOptions,
): Promise<MoaWorkerResult> {
	try {
		const result = await options.runSubprocess({
			cwd: options.cwd,
			agent: createWorkerAgent(worker),
			task: plan.task,
			index,
			id: `moa-worker-${index + 1}-${worker.name}`,
			modelOverride: worker.model,
			thinkingLevel: toThinkingLevel(worker.thinking),
			signal: options.signal,
			authStorage: options.authStorage,
			modelRegistry: options.modelRegistry,
			settings: options.settings,
			enableLsp: worker.tools === "all",
		});
		return mapSingleResult(result, worker.role, worker.model);
	} catch (error) {
		return mapExecutionError(worker.name, worker.role, error, worker.model);
	}
}

async function runSynthesis(
	plan: MoaPlan,
	workers: MoaWorkerResult[],
	options: ExecutePlanOptions,
): Promise<MoaWorkerResult> {
	const workerOutputs = workers.map(buildWorkerDigest).join("\n\n");
	try {
		const result = await options.runSubprocess({
			cwd: options.cwd,
			agent: createSynthesisAgent(plan, workerOutputs),
			task: plan.task,
			index: plan.workers.length,
			id: "moa-synthesis",
			modelOverride: plan.synthesisModel,
			thinkingLevel: toThinkingLevel(plan.synthesisThinking),
			signal: options.signal,
			authStorage: options.authStorage,
			modelRegistry: options.modelRegistry,
			settings: options.settings,
			enableLsp: false,
		});
		return mapSingleResult(result, "Choose and justify the final recommendation", plan.synthesisModel);
	} catch (error) {
		return mapExecutionError("synthesis", "Choose and justify the final recommendation", error, plan.synthesisModel);
	}
}

export async function executePlan(plan: MoaPlan, options: ExecutePlanOptions): Promise<MoaExecutionResult> {
	const workers = await Promise.all(plan.workers.map((worker, index) => runWorker(plan, worker, index, options)));
	const synthesis = await runSynthesis(plan, workers, options);
	return {
		plan,
		workers,
		synthesis,
	};
}
