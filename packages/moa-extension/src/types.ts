export type MoaPlannerToolMode = "all" | "read-only";

export type MoaStage = "discovery" | "rewrite" | "worker" | "synthesis";

export interface MoaWorkerSlot {
	name: string;
	role: string;
	model?: string;
	thinking?: string;
}

export interface MoaSettings {
	discoveryEnabled: boolean;
	rewriteEnabled: boolean;
	workerCount: number;
	workers: MoaWorkerSlot[];
	synthesisModel?: string;
	synthesisThinking?: string;
	plannerToolMode: MoaPlannerToolMode;
	timeoutMs: number;
	resumeContextBytes: number;
}

export interface MoaPlanWorker {
	name: string;
	role: string;
	prompt: string;
	model?: string;
	thinking?: string;
	tools: readonly string[] | "all";
}

export interface MoaPlan {
	task: string;
	discoveryPrompt?: string;
	rewritePrompt?: string;
	workers: MoaPlanWorker[];
	synthesisModel?: string;
	synthesisThinking?: string;
}

export interface MoaWorkerResult {
	name: string;
	role: string;
	ok: boolean;
	output: string;
	stderr: string;
	exitCode: number | null;
	model?: string;
}

export interface MoaExecutionResult {
	plan: MoaPlan;
	discovery?: MoaWorkerResult;
	rewrite?: MoaWorkerResult;
	workers: MoaWorkerResult[];
	synthesis?: MoaWorkerResult;
}

export interface MoaTraceDetails {
	task: string;
	workerCount: number;
	workers: Array<Pick<MoaWorkerResult, "name" | "role" | "ok" | "model">>;
	summary: string;
}
