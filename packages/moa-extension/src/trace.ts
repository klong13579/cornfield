import type { MoaExecutionResult, MoaTraceDetails, MoaWorkerResult } from "./types";

function summarizeWorker(result: MoaWorkerResult): string {
	const status = result.ok ? "ok" : `failed${result.exitCode === null ? "" : ` (${result.exitCode})`}`;
	const body = result.output.trim() || result.stderr.trim() || "(no output)";
	return `### ${result.name} — ${status}\n${body}`;
}

export function buildSummary(result: MoaExecutionResult): string {
	const lines = [
		"## MOA Run",
		`- task: ${result.plan.task}`,
		`- workers: ${result.workers.filter(worker => worker.ok).length}/${result.workers.length} completed`,
	];
	if (result.synthesis) {
		lines.push("", "### synthesis", result.synthesis.output.trim() || "(no synthesis output)");
	}
	lines.push("", "### workers", ...result.workers.map(summarizeWorker));
	return lines.join("\n");
}

export function buildTraceDetails(result: MoaExecutionResult): MoaTraceDetails {
	return {
		task: result.plan.task,
		workerCount: result.workers.length,
		workers: result.workers.map(worker => ({
			name: worker.name,
			role: worker.role,
			ok: worker.ok,
			model: worker.model,
		})),
		summary: buildSummary(result),
	};
}
