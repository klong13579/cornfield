/**
 * Pure assembly of a subagent run's `yield` calls into the payload the parent
 * consumes.
 *
 * A run reports its result either as one terminal submission ("last yield wins",
 * the historical behavior) or as incremental sections that accumulate under the
 * labels the output schema declares. The fold lives here — apart from the
 * executor — so it can be tested without the subprocess runtime's dependency
 * graph and so every reader of a run's yields assembles them the same way.
 */
import { dereferenceJsonSchema } from "@cornfield/ai/utils/schema";
import { isRecord } from "@cornfield/utils";
import { buildOutputValidator } from "../tools/output-schema-validator";

/** One yield call as the assembly sees it (structurally the executor's `YieldItem`). */
export interface AssembledYieldItem {
	data?: unknown;
	status?: "success" | "aborted";
	error?: string;
	type?: string | string[];
}

/** Outcome of folding a run's yield calls into one payload. */
export interface AssembledYieldResult {
	data: unknown;
	/** True when the folded payload carries nothing a consumer could use. */
	missingData: boolean;
	/** Status of the terminal submission, when the run made one. */
	terminalStatus?: "success" | "aborted";
	terminalError?: string;
}

/**
 * True when `type` names incremental sections rather than a terminal submission.
 *
 * A non-empty string array is incremental; a plain string (or no `type` at all)
 * is terminal. This is the one rule the whole feature hangs off — termination,
 * section folding and validation all read it — so it lives in one place.
 */
export function isIncrementalYieldType(type: unknown): type is string[] {
	return Array.isArray(type) && type.length > 0;
}

function yieldLabels(type: string | string[] | undefined): string[] {
	if (typeof type === "string") {
		const label = type.trim();
		return label ? [label] : [];
	}
	if (!Array.isArray(type)) return [];
	const labels: string[] = [];
	for (const value of type) {
		if (typeof value !== "string") continue;
		const label = value.trim();
		if (label) labels.push(label);
	}
	return labels;
}

/** True when `value` is a JSON-schema node whose instances are arrays. */
function isArrayTypedSchema(value: unknown): boolean {
	if (value === null || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (record.type === "array") return true;
	if (Array.isArray(record.type) && record.type.includes("array")) return true;
	for (const key of ["anyOf", "oneOf", "allOf"] as const) {
		const variants = record[key];
		if (Array.isArray(variants) && variants.some(isArrayTypedSchema)) return true;
	}
	return false;
}

/**
 * Top-level output-schema properties declared as arrays. A section for such a
 * label accumulates into a list even when the agent submits it exactly once —
 * otherwise a single `type: ["findings"]` submission would assemble as a bare
 * value and fail the array-typed schema it was written against.
 */
export function arrayValuedLabels(outputSchema: unknown): ReadonlySet<string> {
	const labels = new Set<string>();
	try {
		// Validate against the JTD-converted JSON Schema (same shape validation runs
		// on): JTD `optionalProperties.findings.elements` only becomes
		// `properties.findings: { type: "array" }` after conversion.
		const { jsonSchema } = buildOutputValidator(outputSchema);
		if (jsonSchema === undefined) return labels;
		const dereferenced = dereferenceJsonSchema(jsonSchema);
		const object = isRecord(dereferenced) ? dereferenced : isRecord(jsonSchema) ? jsonSchema : undefined;
		const properties = object?.properties;
		if (!isRecord(properties)) return labels;
		for (const key in properties) {
			if (isArrayTypedSchema(properties[key])) labels.add(key);
		}
	} catch {
		// A schema whose shape defeats conversion declares nothing here; the
		// assembled payload is still validated as a whole by the caller.
	}
	return labels;
}

function appendSection(
	sections: Record<string, unknown>,
	counts: Map<string, number>,
	label: string,
	value: unknown,
	forceArray: boolean,
): void {
	const count = counts.get(label) ?? 0;
	const existing = sections[label];
	if (count === 0) {
		sections[label] = forceArray ? [value] : value;
	} else if (Array.isArray(existing)) {
		existing.push(value);
	} else {
		sections[label] = [existing, value];
	}
	counts.set(label, count + 1);
}

/**
 * Fold a run's yield calls into the payload the parent validates and reports.
 *
 * - A non-empty array `type` contributes a section and never terminates the run.
 * - The terminal submission is the last call that is not a section. When it
 *   carries data it is used verbatim — a final result is not a section, and
 *   nesting it under a label is what reported every field as missing.
 * - A data-less terminal submission keeps the accumulated sections; only when no
 *   section exists either does the caller fall back to the raw output.
 *
 * Returns `undefined` when there were no yields at all, so callers can tell
 * "nothing was submitted" from "something was submitted without data".
 */
export function assembleYieldResult(
	yieldItems: readonly AssembledYieldItem[],
	arrayLabels?: ReadonlySet<string>,
): AssembledYieldResult | undefined {
	if (yieldItems.length === 0) return undefined;

	let terminalItem: AssembledYieldItem | undefined;
	for (let index = yieldItems.length - 1; index >= 0; index--) {
		const item = yieldItems[index];
		if (item && !isIncrementalYieldType(item.type)) {
			terminalItem = item;
			break;
		}
	}

	const sections: Record<string, unknown> = {};
	const counts = new Map<string, number>();
	let missingData = false;
	let hasSections = false;
	for (const item of yieldItems) {
		if (item.status === "aborted") continue;
		if (!isIncrementalYieldType(item.type)) continue;
		if (item.data === undefined || item.data === null) missingData = true;
		for (const label of yieldLabels(item.type)) {
			appendSection(sections, counts, label, item.data, arrayLabels?.has(label) ?? false);
			hasSections = true;
		}
	}

	const terminalStatus = terminalItem?.status;
	const terminalError = terminalItem?.error;

	if (terminalItem && terminalItem.data !== undefined && terminalItem.data !== null) {
		return { data: terminalItem.data, missingData: false, terminalStatus, terminalError };
	}
	if (hasSections) return { data: sections, missingData, terminalStatus, terminalError };
	if (!terminalItem) return undefined;
	return { data: terminalItem.data, missingData: true, terminalStatus, terminalError };
}
