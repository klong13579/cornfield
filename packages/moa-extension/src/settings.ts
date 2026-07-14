import {
	TCO_ASK_TIMEOUT_MS_DEFAULT,
	TCO_DISCOVERY_TIMEOUT_MS_DEFAULT,
	TCO_MAX_MISSING_INPUTS_DEFAULT,
	TCO_REWRITE_TIMEOUT_MS_DEFAULT,
} from "./tco";
import type { MoaSettings, MoaWorkerExecutionMode, MoaWorkerSlot } from "./types";

const RUNTIME_SETTINGS_ENV = "PI_MOA_SETTINGS_JSON";

/**
 * Cost-lite default model layout.
 *
 * Three heterogeneous proposers from three different families (diversity > strength,
 * per the Together MoA paper 2024) plus one higher-order synthesis model. Users
 * who want a different mix should override via `PI_MOA_SETTINGS_JSON` — see
 * README §"Default model selection" for the rationale and override recipe.
 */
export const DEFAULT_WORKER_MODELS = {
	divergent: "narwal-plan/qwen3.5-flash",
	grounded: "alibaba-coding-plan/deepseek-v4-pro",
	critical: "alibaba-coding-plan/kimi-k2.6",
} as const;

export const DEFAULT_SYNTHESIS_MODEL = "narwal-plan/deepseek-v4-pro-202606";

export const DEFAULT_WORKER_SLOTS: ReadonlyArray<MoaWorkerSlot> = [
	{
		name: "divergent",
		role: "Generate distinct candidate routes and alternate framings",
		model: DEFAULT_WORKER_MODELS.divergent,
	},
	{
		name: "grounded",
		role: "Evaluate constraints, costs, and implementation realism",
		model: DEFAULT_WORKER_MODELS.grounded,
	},
	{
		name: "critical",
		role: "Attack weaknesses, edge cases, and failure modes",
		model: DEFAULT_WORKER_MODELS.critical,
	},
];

export const DEFAULT_SETTINGS: MoaSettings = {
	workerExecutionMode: "subprocess",
	discoveryEnabled: true,
	rewriteEnabled: true,
	workerCount: 3,
	workers: DEFAULT_WORKER_SLOTS.map(slot => ({ ...slot })),
	synthesisModel: DEFAULT_SYNTHESIS_MODEL,
	synthesisThinking: undefined,
	plannerToolMode: "read-only",
	timeoutMs: 300_000,
	resumeContextBytes: 8_000,
	discoveryTimeoutMs: TCO_DISCOVERY_TIMEOUT_MS_DEFAULT,
	rewriteTimeoutMs: TCO_REWRITE_TIMEOUT_MS_DEFAULT,
	maxMissingInputs: TCO_MAX_MISSING_INPUTS_DEFAULT,
	askTimeoutMs: TCO_ASK_TIMEOUT_MS_DEFAULT,
	askEnabled: true,
	tcoInjectMaxBytes: 8_000,
	// Multi-round (PR2). TUI gets 1 round by default; gateway/cron force 0 in executor.
	maxRounds: 1,
	maxQuestionsPerRound: 5,
	qualityMinScore: 40,
};

export function normalizeWorkerSlots(
	workers: ReadonlyArray<MoaWorkerSlot> | undefined,
	count: number,
): MoaWorkerSlot[] {
	const normalizedCount = Math.max(1, count);
	return Array.from({ length: normalizedCount }, (_, index) => {
		const fallback = DEFAULT_WORKER_SLOTS[index] ?? {
			name: `worker-${index + 1}`,
			role: "Contribute an additional planning perspective",
		};
		const worker = workers?.[index];
		return {
			name: worker?.name?.trim() || fallback.name,
			role: worker?.role?.trim() || fallback.role,
			model: worker?.model?.trim() || fallback.model,
			thinking: worker?.thinking?.trim() || fallback.thinking,
		};
	});
}

function loadRuntimeSettingsOverrides(): Partial<MoaSettings> {
	const raw = Bun.env[RUNTIME_SETTINGS_ENV]?.trim();
	if (!raw) return {};
	const parsed = Bun.JSON5.parse(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${RUNTIME_SETTINGS_ENV} must be a JSON5 object`);
	}
	return parsed as Partial<MoaSettings>;
}

export function resolveSettings(overrides: Partial<MoaSettings> = {}): MoaSettings {
	// Priority: PI_MOA_SETTINGS_JSON env var > moa.yml config file > built-in
	// defaults. Config-file `overrides` come from `loadMoaConfigOverrides` which
	// already merges project > global. Env is the most specific one-off override
	// (used by tests and CI), so it MUST come last in the spread to win.
	const mergedOverrides = {
		...overrides,
		...loadRuntimeSettingsOverrides(),
	};
	const workerCount = mergedOverrides.workerCount ?? DEFAULT_SETTINGS.workerCount;
	// Clamp multi-round to non-negative ints. Gateway/cron forces maxRounds=0
	// in executor (hasUI=false) — this only guards against user typos.
	const maxRounds = Math.max(0, Math.floor(mergedOverrides.maxRounds ?? DEFAULT_SETTINGS.maxRounds));
	const maxQuestionsPerRound = Math.max(
		0,
		Math.floor(mergedOverrides.maxQuestionsPerRound ?? DEFAULT_SETTINGS.maxQuestionsPerRound),
	);
	const qualityMinScore = Math.max(
		0,
		Math.min(100, Math.floor(mergedOverrides.qualityMinScore ?? DEFAULT_SETTINGS.qualityMinScore)),
	);
	// Normalize workerExecutionMode: only valid values pass through.
	const rawMode = mergedOverrides.workerExecutionMode;
	const workerExecutionMode: "subprocess" | "in-process" =
		rawMode === "subprocess" || rawMode === "in-process" ? rawMode : DEFAULT_SETTINGS.workerExecutionMode;
	if (rawMode !== undefined && rawMode !== "subprocess" && rawMode !== "in-process") {
		console.warn(`[moa] invalid workerExecutionMode: "${rawMode}"; falling back to "${workerExecutionMode}"`);
	}
	return {
		...DEFAULT_SETTINGS,
		...mergedOverrides,
		workerCount,
		workers: normalizeWorkerSlots(mergedOverrides.workers ?? DEFAULT_SETTINGS.workers, workerCount),
		maxRounds,
		maxQuestionsPerRound,
		qualityMinScore,
		workerExecutionMode,
	};
}
