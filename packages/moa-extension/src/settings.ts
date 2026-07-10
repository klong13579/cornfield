import type { MoaSettings, MoaWorkerSlot } from "./types";

const RUNTIME_SETTINGS_ENV = "PI_MOA_SETTINGS_JSON";

export const DEFAULT_WORKER_SLOTS: ReadonlyArray<MoaWorkerSlot> = [
	{ name: "divergent", role: "Generate distinct candidate routes" },
	{ name: "grounded", role: "Evaluate constraints and implementation realism" },
	{ name: "critical", role: "Attack weaknesses, edge cases, and failure modes" },
];

export const DEFAULT_SETTINGS: MoaSettings = {
	discoveryEnabled: true,
	rewriteEnabled: true,
	workerCount: 3,
	workers: DEFAULT_WORKER_SLOTS.map(slot => ({ ...slot })),
	synthesisModel: undefined,
	synthesisThinking: undefined,
	plannerToolMode: "read-only",
	timeoutMs: 300_000,
	resumeContextBytes: 8_000,
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
			model: worker?.model?.trim() || undefined,
			thinking: worker?.thinking?.trim() || undefined,
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
	const mergedOverrides = {
		...loadRuntimeSettingsOverrides(),
		...overrides,
	};
	const workerCount = mergedOverrides.workerCount ?? DEFAULT_SETTINGS.workerCount;
	return {
		...DEFAULT_SETTINGS,
		...mergedOverrides,
		workerCount,
		workers: normalizeWorkerSlots(mergedOverrides.workers ?? DEFAULT_SETTINGS.workers, workerCount),
	};
}
