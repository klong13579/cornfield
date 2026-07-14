/**
 * Task Context Object (TCO) — what the discovery stage produces and what
 * the worker / synthesis stages consume.
 *
 * The TCO is the unit of "what we already know" + "what we still need from
 * the user" + "what we assumed when the user did not answer". It replaces
 * the previous `discoveryPrompt` / `rewritePrompt` as the single handoff
 * between pre-execution stages and the worker fanout.
 *
 * Design rationale (see `docs/moa-input-fulfillment.md` §4.1):
 *   - `known_inputs` are facts the agent already has, sourced from user.md,
 *     moa.yml, cwd project files, or LLM-inferred values. Each carries a
 *     `source` so the synthesis stage can flag which inputs are weak
 *     (e.g. `llm_inferred` is weaker than `user_md`).
 *   - `missing_inputs` is the **only** place where the user gets asked. They
 *     are intentionally bounded (3-5 items) and each one must be answerable
 *     in a single round (no open-ended "describe your needs" questions).
 *   - `assumptions` is what we fall back to when the user skips a question
 *     or when the run is non-interactive (gateway / cron). The synthesis
 *     stage surfaces these so the user can correct them in a follow-up.
 *
 * The contract is generated per-task by the Discovery LLM, not hardcoded
 * per worker role. Different tasks produce different missing_inputs.
 */

export type TcoInputSource = "user" | "user_md" | "moa_yml" | "cwd" | "tool_call" | "llm_inferred";

export type TcoInputType = "text" | "number" | "list" | "confirm" | "select";

export type TcoAssumptionReason =
	| "user_skipped"
	| "user_skipped_required"
	| "non_interactive_fallback"
	| "llm_inferred"
	| "discovery_omitted";

import { DEFAULT_OUTPUT_SCHEMA, type MoaOutputSchema, type MoaOutputSchemaSection, type MoaSectionType } from "./types";

const VALID_SECTION_TYPES: ReadonlySet<MoaSectionType> = new Set<MoaSectionType>(["markdown", "list"]);

export interface TcoKnownInput {
	key: string;
	value: unknown;
	source: TcoInputSource;
	confidence?: number;
}

export interface TcoMissingInput {
	key: string;
	question: string;
	type: TcoInputType;
	options?: string[];
	required: boolean;
	why_critical: string;
	/** Optional default value suggested by the Discovery LLM. When the user
	 *  skips the question (or in non-interactive mode), the assumption
	 *  inherits this value rather than the type's empty fallback. */
	defaultValue?: unknown;
}

export interface TcoAssumption {
	key: string;
	value: unknown;
	reason: TcoAssumptionReason;
	note?: string;
}

export interface TaskContextObject {
	task_understanding: string;
	known_inputs: TcoKnownInput[];
	missing_inputs: TcoMissingInput[];
	assumptions: TcoAssumption[];
	/** Optional LLM debug info; not surfaced to workers. */
	debug?: { discovery_model?: string; discovery_duration_ms?: number };
}

export const TCO_MAX_MISSING_INPUTS_DEFAULT = 5;
export const TCO_ASK_TIMEOUT_MS_DEFAULT = 30_000;
export const TCO_DISCOVERY_TIMEOUT_MS_DEFAULT = 60_000;
export const TCO_REWRITE_TIMEOUT_MS_DEFAULT = 30_000;

// ----------------------------------------------------------------------------
// Discovery output parsing
// ----------------------------------------------------------------------------

/**
 * Tolerant JSON extractor for LLM output. Strips ```json fences, leading
 * prose, trailing prose. Returns the first top-level JSON object found.
 */
export function extractJsonObject(raw: string): unknown {
	if (!raw || typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	const candidates: string[] = [];
	// 1) direct parse
	candidates.push(trimmed);
	// 2) strip ```json / ``` fences
	const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/i);
	if (fenceMatch) candidates.push(fenceMatch[1]!.trim());
	// 3) first {...} block
	const braceMatch = trimmed.match(/\{[\s\S]*\}/);
	if (braceMatch) candidates.push(braceMatch[0]);
	for (const candidate of candidates) {
		try {
			return JSON.parse(candidate);
		} catch {
			// try next
		}
	}
	return undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

function clampMissingInputs(list: TcoMissingInput[], max: number): TcoMissingInput[] {
	if (list.length <= max) return list;
	// Keep all required, then fill optional up to cap. Stable order.
	const required = list.filter(item => item.required);
	const optional = list.filter(item => !item.required);
	const out = [...required];
	for (const item of optional) {
		if (out.length >= max) break;
		out.push(item);
	}
	return out.slice(0, max);
}

function normalizeKnownInput(value: unknown): TcoKnownInput | undefined {
	if (!isObject(value)) return undefined;
	const key = typeof value.key === "string" ? value.key.trim() : "";
	if (!key) return undefined;
	const source: TcoInputSource =
		typeof value.source === "string" && isInputSource(value.source) ? value.source : "llm_inferred";
	const confidence = typeof value.confidence === "number" ? value.confidence : undefined;
	return { key, value: value.value, source, confidence };
}

function isInputSource(s: string): s is TcoInputSource {
	return ["user", "user_md", "moa_yml", "cwd", "tool_call", "llm_inferred"].includes(s);
}

function normalizeMissingInput(value: unknown): TcoMissingInput | undefined {
	if (!isObject(value)) return undefined;
	const key = typeof value.key === "string" ? value.key.trim() : "";
	const question = typeof value.question === "string" ? value.question.trim() : "";
	if (!key || !question) return undefined;
	const type: TcoInputType =
		typeof value.type === "string" && ["text", "number", "list", "confirm", "select"].includes(value.type)
			? (value.type as TcoInputType)
			: "text";
	const options = Array.isArray(value.options)
		? value.options.filter((o): o is string => typeof o === "string")
		: undefined;
	const required = value.required === true;
	const why_critical = typeof value.why_critical === "string" ? value.why_critical.trim() : "";
	// Treat both undefined and explicit null as "no default". The Discovery
	// LLM may emit `"defaultValue": null` to indicate "no sensible default";
	// semantically that's the same as omitting the field.
	const defaultValue =
		value.defaultValue === undefined || value.defaultValue === null ? undefined : value.defaultValue;
	return { key, question, type, options, required, why_critical, defaultValue };
}

/**
 * Parse a Discovery LLM's raw output into a TCO + output_schema. Tolerant:
 * strips markdown fences, clamps missing_inputs to `max`, fills in sensible
 * defaults. Does NOT validate the TCO semantically — see `validateTco` for
 * that.
 *
 * PR2: also extracts `output_schema` (Discovery LLM emits a per-task section
 * description). Falls back to `DEFAULT_OUTPUT_SCHEMA` when the field is
 * missing, empty, or malformed — this is the design-locked fallback path
 * (`docs/moa-multi-round-design.md` §5.3, D8).
 */
export function parseDiscoveryOutput(
	raw: string,
	options: { maxMissingInputs?: number; defaultSchema?: MoaOutputSchema } = {},
): { tco: TaskContextObject; outputSchema: MoaOutputSchema } {
	const max = options.maxMissingInputs ?? TCO_MAX_MISSING_INPUTS_DEFAULT;
	const fallbackSchema = options.defaultSchema ?? DEFAULT_OUTPUT_SCHEMA;
	const parsed = extractJsonObject(raw);
	const obj = isObject(parsed) ? parsed : {};
	const task_understanding = typeof obj.task_understanding === "string" ? obj.task_understanding.trim() : "";
	const knownRaw = Array.isArray(obj.known_inputs) ? obj.known_inputs : [];
	const missingRaw = Array.isArray(obj.missing_inputs) ? obj.missing_inputs : [];
	const assumptionsRaw = Array.isArray(obj.assumptions) ? obj.assumptions : [];
	const known_inputs = knownRaw.map(normalizeKnownInput).filter((v): v is TcoKnownInput => !!v);
	const missing_inputs_raw = missingRaw.map(normalizeMissingInput).filter((v): v is TcoMissingInput => !!v);
	const missing_inputs = clampMissingInputs(missing_inputs_raw, max);
	const assumptions: TcoAssumption[] = assumptionsRaw
		.map(value => {
			if (!isObject(value)) return undefined as TcoAssumption | undefined;
			const key = typeof value.key === "string" ? value.key.trim() : "";
			if (!key) return undefined as TcoAssumption | undefined;
			const reason: TcoAssumptionReason =
				typeof value.reason === "string" ? (value.reason as TcoAssumptionReason) : "llm_inferred";
			const note = typeof value.note === "string" ? value.note : undefined;
			const out: TcoAssumption = { key, value: value.value, reason };
			if (note !== undefined) out.note = note;
			return out;
		})
		.filter((v): v is TcoAssumption => v !== undefined);
	const outputSchema = normalizeOutputSchema(obj.output_schema, fallbackSchema);
	return {
		tco: { task_understanding, known_inputs, missing_inputs, assumptions },
		outputSchema,
	};
}

/**
 * Extract & validate `output_schema` from a Discovery LLM JSON payload.
 * Returns `fallback` when the field is missing, empty, or invalid. Each
 * section is normalized: name lowercased + trimmed; type defaulted to
 * `markdown`; required defaulted to `false`. Unknown types are dropped
 * silently (the parser skips them at use-time).
 */
export function normalizeOutputSchema(value: unknown, fallback: MoaOutputSchema): MoaOutputSchema {
	if (!isObject(value)) return fallback;
	const sectionsRaw = Array.isArray(value.sections) ? value.sections : [];
	if (sectionsRaw.length === 0) return fallback;
	const seen = new Set<string>();
	const out: MoaOutputSchemaSection[] = [];
	for (const raw of sectionsRaw) {
		if (!isObject(raw)) continue;
		const name = typeof raw.name === "string" ? raw.name.trim().toLowerCase() : "";
		if (!name) continue;
		if (seen.has(name)) continue;
		seen.add(name);
		const type: MoaSectionType =
			typeof raw.type === "string" && VALID_SECTION_TYPES.has(raw.type as MoaSectionType)
				? (raw.type as MoaSectionType)
				: "markdown";
		const required = raw.required === true;
		const item = isObject(raw.item)
			? Object.fromEntries(Object.entries(raw.item).filter((e): e is [string, string] => typeof e[1] === "string"))
			: undefined;
		const section: MoaOutputSchemaSection = { name, type, required };
		if (item) section.item = item;
		out.push(section);
	}
	return out.length > 0 ? { sections: out } : fallback;
}

export interface TcoValidationResult {
	ok: boolean;
	errors: string[];
	warnings: string[];
}

export function validateTco(
	tco: TaskContextObject,
	maxMissingInputs: number = TCO_MAX_MISSING_INPUTS_DEFAULT,
): TcoValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	if (!tco.task_understanding) warnings.push("task_understanding is empty");
	if (tco.missing_inputs.length > maxMissingInputs) {
		errors.push(`missing_inputs length ${tco.missing_inputs.length} > max ${maxMissingInputs}`);
	}
	for (const m of tco.missing_inputs) {
		if (m.type === "select" && (!m.options || m.options.length === 0)) {
			errors.push(`missing_input ${m.key}: type=select but no options`);
		}
	}
	const seen = new Set<string>();
	for (const k of tco.known_inputs) {
		if (seen.has(k.key)) warnings.push(`known_inputs duplicate key: ${k.key}`);
		seen.add(k.key);
	}
	const seenMissing = new Set<string>();
	for (const m of tco.missing_inputs) {
		if (seenMissing.has(m.key)) errors.push(`missing_inputs duplicate key: ${m.key}`);
		seenMissing.add(m.key);
	}
	return { ok: errors.length === 0, errors, warnings };
}

// ----------------------------------------------------------------------------
// TCO → text rendering (for prompt injection)
// ----------------------------------------------------------------------------

/**
 * Render a TCO as a markdown block suitable for prepending to a worker /
 * rewrite / synthesis system prompt. Keeps the size bounded so the
 * injection does not blow the prompt budget.
 */
export function renderTcoForPrompt(tco: TaskContextObject, opts: { maxBytes?: number } = {}): string {
	const maxBytes = opts.maxBytes ?? 8_000;
	const lines: string[] = [];
	lines.push("## Task Context (from discovery stage)");
	if (tco.task_understanding) {
		lines.push("", "### Task understanding", tco.task_understanding);
	}
	if (tco.known_inputs.length > 0) {
		lines.push("", "### Known inputs");
		for (const k of tco.known_inputs) {
			const valueStr = formatValue(k.value);
			const conf = typeof k.confidence === "number" ? ` (confidence=${k.confidence.toFixed(2)})` : "";
			lines.push(`- \`${k.key}\` = ${valueStr}  _source=${k.source}${conf}_`);
		}
	}
	if (tco.assumptions.length > 0) {
		lines.push("", "### Assumptions (use as-is, do not re-question)");
		for (const a of tco.assumptions) {
			const valueStr = formatValue(a.value);
			lines.push(`- [assumed: \`${a.key}\` = ${valueStr}]  _reason=${a.reason}_`);
		}
	}
	const text = lines.join("\n");
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	return truncateUtf8ForInjection(text, maxBytes);
}

function formatValue(v: unknown): string {
	if (v === null || v === undefined) return "null";
	if (typeof v === "string") return v.length > 200 ? `"${v.slice(0, 200)}…"` : `"${v}"`;
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? "" : "s"}]`;
	try {
		const s = JSON.stringify(v);
		return s.length > 200 ? `${s.slice(0, 200)}…` : s;
	} catch {
		return "<unserializable>";
	}
}

function truncateUtf8ForInjection(s: string, maxBytes: number): string {
	if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
	const omit = `\n\n[truncated ${maxBytes} bytes budget]`;
	let low = 0;
	let high = s.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(s.slice(0, mid), "utf8") + Buffer.byteLength(omit, "utf8") <= maxBytes) low = mid;
		else high = mid - 1;
	}
	return s.slice(0, low) + omit;
}

// ----------------------------------------------------------------------------
// Empty TCO (fallback path)
// ----------------------------------------------------------------------------

/** Build a minimal empty TCO for fallback when discovery fails. */
export function emptyTco(task: string, note: string): TaskContextObject {
	return {
		task_understanding: task,
		known_inputs: [],
		missing_inputs: [],
		assumptions: [{ key: "discovery_status", value: "skipped", reason: "non_interactive_fallback", note }],
	};
}

// ----------------------------------------------------------------------------
// Context aggregation (reads user.md / moa.yml / cwd project files)
// ----------------------------------------------------------------------------

/**
 * Aggregate discovery context for the LLM. Reads:
 *   - ~/.omp/agent/user.md (if exists)
 *   - ~/.omp/agent/moa.yml (if exists)
 *   - cwd README / package.json / Cargo.toml (top-level only)
 *
 * Returns a bounded markdown block. Designed to be passed to the Discovery
 * LLM as a "here is what we already know" preamble so it can decide what is
 * still missing.
 */
export async function gatherDiscoveryContext(cwd: string, opts: { maxBytes?: number } = {}): Promise<string> {
	const maxBytes = opts.maxBytes ?? 4_000;
	const sections: string[] = [];

	const home = process.env.HOME ?? "";
	if (home) {
		const userMd = await readBounded(`${home}/.omp/agent/user.md`, 1500);
		if (userMd) sections.push(`### ~/.omp/agent/user.md\n${userMd}`);
		const moaYml = await readBounded(`${home}/.omp/agent/moa.yml`, 1500);
		if (moaYml) sections.push(`### ~/.omp/agent/moa.yml\n${moaYml}`);
	}
	if (cwd && cwd !== home) {
		const readme = await readBounded(`${cwd}/README.md`, 1500);
		if (readme) sections.push(`### ${cwd}/README.md\n${readme}`);
		const pkg = await readBounded(`${cwd}/package.json`, 800);
		if (pkg) sections.push(`### ${cwd}/package.json\n${pkg}`);
		const cargo = await readBounded(`${cwd}/Cargo.toml`, 800);
		if (cargo) sections.push(`### ${cwd}/Cargo.toml\n${cargo}`);
	}
	const out = sections.length > 0 ? `## Pre-gathered context\n\n${sections.join("\n\n")}` : "";
	if (Buffer.byteLength(out, "utf8") <= maxBytes) return out;
	return `${out.slice(0, maxBytes)}\n\n[truncated to ${maxBytes} bytes]`;
}

async function readBounded(path: string, maxBytes: number): Promise<string | undefined> {
	try {
		const file = Bun.file(path);
		if (!(await file.exists())) return undefined;
		const text = await file.text();
		if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
		return `${text.slice(0, maxBytes)}\n\n[truncated to ${maxBytes} bytes]`;
	} catch {
		return undefined;
	}
}
