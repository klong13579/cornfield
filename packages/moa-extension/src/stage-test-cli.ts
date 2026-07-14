/**
 * Pure CLI helpers for the MoA stage-test harness (testable without LLM).
 */
import * as path from "node:path";
import { requireArtifacts, type LoadedStageRun, type StageName } from "./stage-artifacts";

const STAGES = new Set<StageName>(["all", "discovery", "ask", "rewrite", "workers", "synthesis"]);

export interface StageTestCliArgs {
	stage: StageName;
	task?: string;
	from?: string;
	out: string;
	rounds?: number;
	continueOnFail: boolean;
	help: boolean;
}

export type AtomicStage = Exclude<StageName, "all">;

export function stageTestUsage(): string {
	return [
		"MoA stage-test harness",
		"",
		"  bun packages/moa-extension/scripts/stage-test.ts \\",
		"    --stage all|discovery|ask|rewrite|workers|synthesis \\",
		"    --task \"...\" \\",
		"    [--from tmp/moa-stage/<id>] \\",
		"    [--out tmp/moa-stage] \\",
		"    [--rounds N] \\",
		"    [--continue-on-fail]",
		"",
		"Artifacts are written under <out>/<timestamp>/.",
	].join("\n");
}

export function parseStageTestArgs(argv: string[], cwd: string = process.cwd()): StageTestCliArgs {
	const out: StageTestCliArgs = {
		stage: "all",
		out: path.join(cwd, "tmp/moa-stage"),
		continueOnFail: false,
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		const next = () => {
			const v = argv[++i];
			if (v === undefined) throw new Error(`Missing value after ${a}`);
			return v;
		};
		if (a === "--help" || a === "-h") out.help = true;
		else if (a === "--stage") {
			const v = next() as StageName;
			if (!STAGES.has(v)) throw new Error(`Invalid --stage: ${v}`);
			out.stage = v;
		} else if (a === "--task") out.task = next();
		else if (a === "--from") out.from = path.resolve(cwd, next());
		else if (a === "--out") out.out = path.resolve(cwd, next());
		else if (a === "--rounds") {
			const n = Number(next());
			if (!Number.isFinite(n)) throw new Error("Invalid --rounds (expected a number)");
			out.rounds = n;
		} else if (a === "--continue-on-fail") out.continueOnFail = true;
		else throw new Error(`Unknown argument: ${a}`);
	}
	return out;
}

export function resolveStageTestTask(args: StageTestCliArgs, prior: LoadedStageRun | undefined): string {
	return (args.task?.trim() || prior?.meta?.task || prior?.plan?.task || "").trim();
}

export function planStageSequence(stage: StageName): AtomicStage[] {
	if (stage === "all") return ["discovery", "ask", "rewrite", "workers", "synthesis"];
	return [stage];
}

export interface StagePrerequisiteInput {
	stage: StageName;
	task: string;
	hasTco: boolean;
	hasSurviving: boolean;
	hasFrom?: boolean;
	fromDir?: string;
}

export type StagePrerequisiteResult = { ok: true } | { ok: false; exitCode: number; message: string };

/**
 * Validate CLI args + loaded prior artifacts before creating a new run dir
 * or spending LLM tokens.
 */
export function validateStagePrerequisites(input: StagePrerequisiteInput): StagePrerequisiteResult {
	const { stage, task, hasTco, hasSurviving, hasFrom = false, fromDir } = input;

	if (!task && (stage === "discovery" || stage === "all")) {
		return { ok: false, exitCode: 2, message: "Missing --task (required for discovery/all)" };
	}
	if (!task) {
		return {
			ok: false,
			exitCode: 2,
			message: "Missing --task (or --from with meta.json / plan.json task)",
		};
	}

	const needsTco = stage === "rewrite" || stage === "workers" || stage === "ask";
	if (needsTco && !hasTco) {
		if (stage === "ask") {
			// ask may auto-run discovery when no --from; only require artifacts when --from is set
			if (hasFrom && fromDir) {
				try {
					requireArtifacts(fromDir, ["tco.json"]);
				} catch (err) {
					return {
						ok: false,
						exitCode: 2,
						message: err instanceof Error ? err.message : String(err),
					};
				}
			}
			return { ok: true };
		}
		if (!hasFrom) {
			return {
				ok: false,
				exitCode: 2,
				message:
					stage === "rewrite"
						? "rewrite needs --from with tco.json or run discovery first via --stage all"
						: "workers needs --from with tco.json",
			};
		}
		if (fromDir) {
			try {
				requireArtifacts(fromDir, ["tco.json"]);
			} catch (err) {
				return {
					ok: false,
					exitCode: 2,
					message: err instanceof Error ? err.message : String(err),
				};
			}
		}
	}

	if (stage === "synthesis" && !hasSurviving) {
		if (!hasFrom) {
			return { ok: false, exitCode: 2, message: "synthesis needs --from with workers.json" };
		}
		if (fromDir) {
			try {
				requireArtifacts(fromDir, ["workers.json"]);
			} catch (err) {
				return {
					ok: false,
					exitCode: 2,
					message: err instanceof Error ? err.message : String(err),
				};
			}
		}
	}

	return { ok: true };
}
