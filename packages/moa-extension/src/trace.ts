import type { TaskContextObject, TcoAssumption } from "./tco";
import {
	MOA_ARCHIVE_CHUNK_BYTES,
	MOA_ARCHIVE_ENTRY_TYPE,
	MOA_ARCHIVE_SCHEMA,
	type MoaArchiveChunk,
	type MoaArchiveInput,
	type MoaArchiveManifest,
	type MoaDispatchLogEntry,
	type MoaExecutionResult,
	type MoaTraceDetails,
	type MoaWorkerResult,
} from "./types";

// =============================================================================
// Archive: full sub-agent transcripts persisted as non-context `custom` entries.
//
// The archive is the durable, auditable record of everything the workers and
// synthesis produced. It is stored as session `custom` entries
// (MOA_ARCHIVE_ENTRY_TYPE) which the session-manager's context builder never
// feeds to the LLM, so it can be full-fidelity without inflating context.
// The transcript is chunked only to keep individual session lines reasonable;
// chunking is byte-exact and reversible, never a semantic truncation.
// =============================================================================

function truncateUtf8(input: string, maxBytes: number): string {
	const bytes = Buffer.byteLength(input, "utf8");
	if (bytes <= maxBytes) return input;
	let low = 0;
	let high = input.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(input.slice(0, mid), "utf8") <= maxBytes) low = mid;
		else high = mid - 1;
	}
	const omitted = bytes - Buffer.byteLength(input.slice(0, low), "utf8");
	return `${input.slice(0, low)}\n\n[moa truncated ${omitted} bytes]`;
}

/**
 * Splits a string into chunks no larger than maxBytes (UTF-8), never splitting
 * a multi-byte code point. join(chunkUtf8(s, n)) === s for any s.
 */
export function chunkUtf8(input: string, maxBytes: number): string[] {
	if (maxBytes <= 0 || Buffer.byteLength(input, "utf8") <= maxBytes) return [input];
	const chunks: string[] = [];
	let rest = input;
	while (Buffer.byteLength(rest, "utf8") > maxBytes) {
		let low = 0;
		let high = rest.length;
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			if (Buffer.byteLength(rest.slice(0, mid), "utf8") <= maxBytes) low = mid;
			else high = mid - 1;
		}
		const cut = Math.max(1, low);
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	if (rest.length > 0) chunks.push(rest);
	return chunks;
}

/** Stable, sortable run id, e.g. moa-20260712-164530-a1b2c3. */
export function createMoaRunId(now: Date = new Date()): string {
	const stamp = now.toISOString().replace(/[-:T]/g, "").replace(/\..*$/, "");
	const rand = Math.random().toString(36).slice(2, 8);
	return `moa-${stamp.slice(0, 8)}-${stamp.slice(8, 14)}-${rand}`;
}

function workerStatus(result: MoaWorkerResult): string {
	return result.ok ? "ok" : `failed${result.exitCode === null ? "" : ` (${result.exitCode})`}`;
}

function archiveSection(label: string, result: MoaWorkerResult): string {
	const status = workerStatus(result);
	const body = result.output.trim() || "(no output)";
	const stderr = result.stderr.trim() ? `\n\n### stderr\n${result.stderr.trim()}` : "";
	const modelLine = result.model ? `\n\nModel: ${result.model}` : "";
	return [`## ${label} — ${status}`, body, modelLine, stderr].filter(Boolean).join("\n");
}

/** Renders the full, untruncated transcript for a moa run as markdown. */
export function buildMoaArchive(
	input: MoaArchiveInput & {
		tco?: TaskContextObject;
		discovery?: MoaWorkerResult;
		rewrite?: MoaWorkerResult;
		dispatchLog?: MoaDispatchLogEntry[];
	},
): string {
	const createdAt = input.createdAt ?? new Date().toISOString();
	const completedWorkers = input.workers.filter(result => result.ok).length;
	const dispatchSection = renderDispatchLogSection(input.dispatchLog);
	return [
		`# moa run ${input.runId}`,
		[`- created: ${createdAt}`, `- workers: ${completedWorkers}/${input.workers.length} completed`].join("\n"),
		`## Original request\n${input.task.trim() || "(empty)"}`,
		input.tco ? `\n## Task Context (TCO)\n\`\`\`json\n${JSON.stringify(input.tco, null, 2)}\n\`\`\`` : "",
		input.discovery ? archiveSection("Discovery", input.discovery) : "",
		input.rewrite ? archiveSection("Rewrite", input.rewrite) : "",
		dispatchSection,
		...input.workers.map((result, index) => archiveSection(`Worker ${index + 1}: ${result.name}`, result)),
		input.synthesis ? `## Synthesis\n${input.synthesis.output.trim() || "(no synthesis output)"}` : "",
	]
		.filter(Boolean)
		.join("\n\n");
}

function renderDispatchLogSection(entries: MoaDispatchLogEntry[] | undefined): string {
	if (!entries || entries.length === 0) return "";
	const lines: string[] = ["## Dispatch log"];
	lines.push("| worker | round | started | duration_ms | exit | ok | quality | dropped | retry |");
	lines.push("| --- | ---: | --- | ---: | ---: | :---: | ---: | :---: | ---: |");
	for (const e of entries) {
		const dropped = e.qualityDropped ? "yes" : "";
		const quality = typeof e.qualityScore === "number" ? String(e.qualityScore) : "";
		const round = String(e.round);
		const started = e.startedAt;
		const duration = String(e.durationMs);
		const exit = e.exitCode === null ? "—" : String(e.exitCode);
		const ok = e.ok ? "yes" : "no";
		const retry = String(e.retryCount);
		lines.push(
			`| ${e.workerName} | ${round} | ${started} | ${duration} | ${exit} | ${ok} | ${quality} | ${dropped} | ${retry} |`,
		);
	}
	return lines.join("\n");
}

/**
 * Build a dispatch log from a flat list of worker results. Single-round
 * helper: assigns round=1 to every entry. PR2 multi-round executor builds
 * the log itself with the correct round numbers.
 */
export function buildDispatchLogFromResults(
	workers: ReadonlyArray<MoaWorkerResult>,
	options: { startedAt?: string; now?: () => Date } = {},
): MoaDispatchLogEntry[] {
	const now = options.now ?? (() => new Date());
	return workers.map(w => {
		const entry: MoaDispatchLogEntry = {
			workerName: w.name,
			round: 1,
			startedAt: options.startedAt ?? now().toISOString(),
			durationMs: 0,
			exitCode: w.exitCode,
			ok: w.ok,
			retryCount: 0,
		};
		if (w.model !== undefined) entry.model = w.model;
		if (w.qualityScore !== undefined) entry.qualityScore = w.qualityScore;
		if (w.qualityDropped) entry.qualityDropped = true;
		return entry;
	});
}

/** Builds the manifest + chunk payloads for persisting a run's full archive. */
export function buildMoaArchiveEntries(input: {
	runId: string;
	createdAt?: string;
	task: string;
	workers: MoaWorkerResult[];
	synthesis?: MoaWorkerResult;
	discovery?: MoaWorkerResult;
	rewrite?: MoaWorkerResult;
	tco?: TaskContextObject;
	dispatchLog?: MoaDispatchLogEntry[];
}): {
	manifest: MoaArchiveManifest;
	chunks: MoaArchiveChunk[];
} {
	const createdAt = input.createdAt ?? new Date().toISOString();
	const transcript = buildMoaArchive({ ...input, createdAt });
	const pieces = chunkUtf8(transcript, MOA_ARCHIVE_CHUNK_BYTES);
	const chunks: MoaArchiveChunk[] = pieces.map((content, index) => ({
		schema: MOA_ARCHIVE_SCHEMA,
		kind: "chunk",
		runId: input.runId,
		index,
		total: pieces.length,
		content,
	}));
	const manifest: MoaArchiveManifest = {
		schema: MOA_ARCHIVE_SCHEMA,
		kind: "manifest",
		runId: input.runId,
		createdAt,
		task: input.task.trim(),
		workerCount: input.workers.length,
		completedWorkers: input.workers.filter(result => result.ok).length,
		chunks: pieces.length,
		bytes: Buffer.byteLength(transcript, "utf8"),
	};
	if (input.dispatchLog && input.dispatchLog.length > 0) {
		manifest.dispatchLog = input.dispatchLog;
	}
	return { manifest, chunks };
}

function isArchiveEntry(entry: unknown): entry is MoaArchiveManifest | MoaArchiveChunk {
	if (!entry || typeof entry !== "object") return false;
	const candidate = entry as { type?: unknown; customType?: unknown; details?: unknown };
	if (candidate.type !== "custom_message" || candidate.customType !== MOA_ARCHIVE_ENTRY_TYPE) return false;
	const data = candidate.details as Partial<MoaArchiveManifest | MoaArchiveChunk> | undefined;
	if (!data || typeof data !== "object") return false;
	if (data.schema !== MOA_ARCHIVE_SCHEMA) return false;
	return data.kind === "manifest" || data.kind === "chunk";
}

/**
 * Rebuilds a run's full transcript from session entries. Without runId, returns
 * the most recent archived run. Returns undefined if no complete archive exists.
 */
export function reconstructMoaArchive(
	entries: unknown[],
	runId?: string,
): { manifest: MoaArchiveManifest; content: string } | undefined {
	const manifests: MoaArchiveManifest[] = [];
	const chunksByRun = new Map<string, MoaArchiveChunk[]>();
	for (const entry of entries) {
		if (!isArchiveEntry(entry)) continue;
		const data = entry.details as MoaArchiveManifest | MoaArchiveChunk;
		if (data.kind === "manifest") {
			manifests.push(data);
		} else {
			const list = chunksByRun.get(data.runId) ?? [];
			list.push(data);
			chunksByRun.set(data.runId, list);
		}
	}
	const manifest = runId
		? [...manifests].reverse().find(item => item.runId === runId)
		: manifests[manifests.length - 1];
	if (!manifest) return undefined;
	const chunks = (chunksByRun.get(manifest.runId) ?? []).slice().sort((a, b) => a.index - b.index);
	if (chunks.length === 0) return undefined;
	const content = chunks.map(chunk => chunk.content).join("");
	return { manifest, content };
}

export function listMoaArchiveRuns(entries: unknown[]): MoaArchiveManifest[] {
	const manifests: MoaArchiveManifest[] = [];
	for (const entry of entries) {
		if (!isArchiveEntry(entry)) continue;
		const data = entry.details as MoaArchiveManifest | MoaArchiveChunk;
		if (data.kind === "manifest") manifests.push(data);
	}
	return manifests;
}

// =============================================================================
// Visible handoff: what subsequent LLM turns see in the `moa-result` content.
//
// Deliberately bounded. The full transcript is in the archive; the handoff is
// the user-visible summary that goes into the custom_message content field.
// =============================================================================

/**
 * Builds the model-visible handoff stored in custom_message.content.
 *
 * This is deliberately bounded by maxBytes: it is what resumed and subsequent
 * turns see. The full, untruncated sub-agent transcript is archived separately
 * via buildMoaArchiveEntries and is kept out of LLM context.
 */
export function buildMoaHandoff(input: {
	runId: string;
	archiveChunks: number;
	archiveBytes: number;
	workers: MoaWorkerResult[];
	synthesis?: MoaWorkerResult;
	task: string;
	maxBytes: number;
	tco?: TaskContextObject;
}): string {
	const completed = input.workers.filter(worker => worker.ok).length;
	const total = input.workers.length;
	const headline = `∪ moa transcript: ${completed}/${total} workers completed.`;
	const pointer =
		input.archiveChunks > 0
			? `Full untruncated transcript archived in this pi session (run ${input.runId}, ${input.archiveChunks} chunk(s), ${input.archiveBytes} bytes). Run \`/moa transcript ${input.runId}\` for the complete archive.`
			: "Worker transcripts are kept out of context.";

	if (input.maxBytes <= 0 || input.workers.length === 0) {
		return `${headline}\n\n${pointer}`;
	}

	const tcoSummary = renderTcoSummary(input.tco);
	const sections: string[] = [];
	if (tcoSummary) sections.push(tcoSummary);
	sections.push(`### ${input.task.trim() || "(empty task)"}`);
	for (const [index, result] of input.workers.entries()) {
		const status = result.ok ? "ok" : `failed (${result.exitCode ?? "—"})`;
		const body = result.output.trim() || "(no output)";
		sections.push(`### worker ${index + 1}: ${result.name} — ${status}\n${body}`);
	}
	if (input.synthesis) {
		const body = input.synthesis.output.trim() || "(no synthesis output)";
		sections.push(`### synthesis\n${body}`);
	}
	const truncated = truncateUtf8(sections.join("\n\n"), input.maxBytes);
	return `${headline}\n\n${pointer}\n\n## Worker conclusions\n${truncated}`;
}

function renderTcoSummary(tco: TaskContextObject | undefined): string {
	if (!tco) return "";
	const parts: string[] = [];
	if (tco.task_understanding) parts.push(`**TCO**: ${tco.task_understanding}`);
	if (tco.known_inputs.length > 0) {
		const items = tco.known_inputs
			.slice(0, 6)
			.map(k => `${k.key}=${shortValue(k.value)}`)
			.join(", ");
		parts.push(`**Known**: ${items}${tco.known_inputs.length > 6 ? "…" : ""}`);
	}
	if (tco.missing_inputs.length > 0) {
		const items = tco.missing_inputs.map(m => `${m.key}${m.required ? "*" : ""}`).join(", ");
		parts.push(`**Asked**: ${items}`);
	}
	if (tco.assumptions.length > 0) {
		const items = tco.assumptions
			.slice(0, 6)
			.map((a: TcoAssumption) => `${a.key}=${shortValue(a.value)} (${a.reason})`)
			.join(", ");
		parts.push(`**Assumed**: ${items}${tco.assumptions.length > 6 ? "…" : ""}`);
	}
	return parts.join("\n");
}

function shortValue(v: unknown): string {
	if (v === null || v === undefined) return "null";
	if (typeof v === "string") return v.length > 30 ? `"${v.slice(0, 30)}…"` : `"${v}"`;
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	if (Array.isArray(v)) return `[${v.length}]`;
	return "<obj>";
}

/**
 * @deprecated Prefer buildMoaHandoff for new code paths. Kept for callers that
 * still want a single unbounded string (e.g. tests, e2e fixtures).
 */
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

function summarizeWorker(result: MoaWorkerResult): string {
	const status = result.ok ? "ok" : `failed${result.exitCode === null ? "" : ` (${result.exitCode})`}`;
	const body = result.output.trim() || result.stderr.trim() || "(no output)";
	return `### ${result.name} — ${status}\n${body}`;
}

/**
 * @deprecated Use the runId / archive metadata on MoaTraceDetails instead. Kept
 * so existing renderers that read `summary` keep working.
 */
export function buildTraceDetails(
	result: MoaExecutionResult,
	archive: { runId: string; archiveChunks: number; archiveBytes: number } = {
		runId: "",
		archiveChunks: 0,
		archiveBytes: 0,
	},
): MoaTraceDetails {
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
		synthesisModel: result.synthesis?.model,
		runId: archive.runId,
		archiveChunks: archive.archiveChunks,
		archiveBytes: archive.archiveBytes,
	};
}
