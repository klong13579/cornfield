/**
 * Pure A∪B merge for the once-right single-Ask pipeline.
 *
 * A (discovery) and B (input-collect workers) each surface a list of missing
 * inputs. This function unions them into the single set of questions the user
 * is asked exactly once. See `docs/plans/2026-07-17-moa-once-right-design.md`
 * §4.3 for the rules:
 *
 *   1. Union A ∪ B.
 *   2. Dedupe by identical key OR synonymous question (punctuation-insensitive);
 *      keep the more specific wording; OR the `required` flags; union B roles.
 *   3. Priority: `required` > discovery (intent) > multi-role B > single-role B.
 *   4. Cap at `maxItems` (required items are kept first by construction).
 *
 * Pure: never mutates its inputs.
 */

import type { TcoMissingInput } from "./tco";

export interface MergeMissingOptions {
	maxItems: number;
}

function normalizeText(text: string): string {
	return text.toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function cloneItem(raw: TcoMissingInput): TcoMissingInput {
	return {
		...raw,
		options: raw.options ? [...raw.options] : undefined,
		roles: raw.roles ? [...raw.roles] : undefined,
	};
}

function unionRoles(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
	if (!a && !b) return undefined;
	const set = new Set<string>([...(a ?? []), ...(b ?? [])]);
	return [...set];
}

/** Merge `incoming` into the earlier `existing` (A precedence). */
function mergeInto(existing: TcoMissingInput, incoming: TcoMissingInput): TcoMissingInput {
	const existingQ = existing.question.trim();
	const incomingQ = incoming.question.trim();
	return {
		...existing,
		question: incomingQ.length > existingQ.length ? incoming.question : existing.question,
		required: existing.required || incoming.required,
		source:
			existing.source === "discovery" || incoming.source === "discovery"
				? "discovery"
				: (existing.source ?? incoming.source),
		roles: unionRoles(existing.roles, incoming.roles),
		type: existing.type !== "text" ? existing.type : incoming.type,
		options: existing.options ?? incoming.options,
		defaultValue: existing.defaultValue ?? incoming.defaultValue,
		why_critical: existing.why_critical.trim() ? existing.why_critical : incoming.why_critical,
	};
}

function priorityTuple(item: TcoMissingInput, index: number): number[] {
	return [item.required ? 0 : 1, item.source === "discovery" ? 0 : 1, -(item.roles?.length ?? 0), index];
}

function compareTuples(x: number[], y: number[]): number {
	for (let i = 0; i < x.length; i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

export function mergeMissingInputs(
	discovery: ReadonlyArray<TcoMissingInput>,
	worker: ReadonlyArray<TcoMissingInput>,
	options: MergeMissingOptions,
): TcoMissingInput[] {
	const merged: TcoMissingInput[] = [];
	const byKey = new Map<string, number>();
	const byQuestion = new Map<string, number>();

	// A first so discovery items become the primary slot on collision. Each
	// list stamps its default source when the item did not carry one, so
	// discovery (intent) items outrank worker items in the priority sort.
	const tagged: Array<{ raw: TcoMissingInput; def: "discovery" | "worker" }> = [
		...discovery.map(raw => ({ raw, def: "discovery" as const })),
		...worker.map(raw => ({ raw, def: "worker" as const })),
	];
	for (const { raw, def } of tagged) {
		const item = cloneItem(raw);
		if (!item.source) item.source = def;
		const nk = normalizeText(item.key);
		const nq = normalizeText(item.question);
		let idx: number | undefined;
		if (nk && byKey.has(nk)) idx = byKey.get(nk);
		if (idx === undefined && nq && byQuestion.has(nq)) idx = byQuestion.get(nq);

		if (idx === undefined) {
			const at = merged.length;
			merged.push(item);
			if (nk) byKey.set(nk, at);
			if (nq) byQuestion.set(nq, at);
		} else {
			merged[idx] = mergeInto(merged[idx]!, item);
			// Alias this item's key/question to the same slot for later matches.
			if (nk && !byKey.has(nk)) byKey.set(nk, idx);
			if (nq && !byQuestion.has(nq)) byQuestion.set(nq, idx);
		}
	}

	const decorated = merged.map((item, index) => ({ item, tuple: priorityTuple(item, index) }));
	decorated.sort((l, r) => compareTuples(l.tuple, r.tuple));
	const ordered = decorated.map(d => d.item);
	return ordered.slice(0, Math.max(0, Math.floor(options.maxItems)));
}
