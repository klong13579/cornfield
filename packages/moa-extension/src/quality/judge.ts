import { spawnMoaWorker } from "../subprocess";
import type { MoaOutputSchema, MoaWorkerResult, ParsedWorkerOutput } from "../types";
import judgePromptTemplate from "./prompts/judge.md" with { type: "text" };

export function shouldJudge(input: {
	enabled: boolean;
	contractHardFail: boolean;
	heuristicScore: number;
	minScore: number;
	grayMargin: number;
}): boolean {
	if (!input.enabled || input.contractHardFail) {
		return false;
	}
	if (input.heuristicScore < input.minScore) {
		return true;
	}
	if (input.heuristicScore <= input.minScore + input.grayMargin) {
		return true;
	}
	return false;
}

export interface JudgeFnArgs {
	result: MoaWorkerResult;
	parsed: ParsedWorkerOutput;
	schema: MoaOutputSchema;
	heuristicScore: number;
	roleKey: string;
	task?: string;
	signal?: AbortSignal;
}

export interface JudgeResult {
	score: number;
	rationale?: string;
}

const ROLE_FOCUS: Record<string, string> = {
	divergent: "breadth and alternate routes",
	grounded: "constraints and executability",
	critical: "risks and assumptions quality",
	fallback: "overall plan quality",
};

function resolveRoleFocus(roleKey: string): string {
	return ROLE_FOCUS[roleKey] ?? ROLE_FOCUS.fallback!;
}

function renderJudgePrompt(template: string, vars: Record<string, string>): string {
	let out = template;
	for (const [key, value] of Object.entries(vars)) {
		out = out.replaceAll(`{{${key}}}`, value);
	}
	return out;
}

function extractJsonPayload(text: string): string {
	const trimmed = text.trim();
	const fenced = /^```(?:json)?\s*([\s\S]*?)```$/m.exec(trimmed);
	return (fenced?.[1] ?? trimmed).trim();
}

export function parseJudgeResponse(text: string): JudgeResult {
	const jsonStr = extractJsonPayload(text);
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonStr);
	} catch {
		throw new Error("judge response is not valid JSON");
	}
	if (!parsed || typeof parsed !== "object" || !("score" in parsed)) {
		throw new Error("judge response missing score field");
	}
	const raw = (parsed as { score: unknown }).score;
	const score = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isFinite(score)) {
		throw new Error("judge score is not a number");
	}
	const rationale =
		typeof (parsed as { rationale?: unknown }).rationale === "string"
			? (parsed as { rationale: string }).rationale
			: undefined;
	return { score, rationale };
}

export function createSpawnJudgeFn(deps: {
	cwd: string;
	model: string;
	timeoutMs: number;
	spawn?: typeof spawnMoaWorker;
}): (args: JudgeFnArgs) => Promise<JudgeResult> {
	const spawn = deps.spawn ?? spawnMoaWorker;
	return async (args: JudgeFnArgs) => {
		const { result, parsed, heuristicScore, roleKey, task, signal } = args;
		const systemPrompt = renderJudgePrompt(judgePromptTemplate, {
			task: task ?? "",
			role: result.role,
			role_focus: resolveRoleFocus(roleKey),
			plan: parsed.sections.plan ?? "(missing)",
			open_questions: parsed.sections.open_questions ?? "(missing)",
			assumptions: parsed.sections.assumptions ?? "(missing)",
			heuristic_score: String(heuristicScore),
		});
		const output = await spawn({
			cwd: deps.cwd,
			model: deps.model,
			tools: "none",
			systemPrompt,
			task: "Score the worker output. Reply with JSON only.",
			timeoutMs: deps.timeoutMs,
			signal,
		});
		if (!output.ok) {
			throw new Error(output.stderr.trim() || "judge spawn failed");
		}
		return parseJudgeResponse(output.output);
	};
}
