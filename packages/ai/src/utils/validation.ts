import { structuredCloneJSON } from "@oh-my-pi/pi-utils";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { Tool, ToolCall } from "../types";

// ============================================================================
// Type Coercion Utilities
// ============================================================================
//
// LLMs sometimes produce tool arguments where a value that should be a number,
// boolean, array, or object is instead passed as a JSON-encoded string. For
// example, an array parameter might arrive as `"[1, 2, 3]"` instead of `[1, 2, 3]`.
//
// Rather than rejecting these outright, we attempt automatic coercion:
//   1. AJV validates the arguments and reports type errors
//   2. For each type error where the actual value is a string, we check if
//      parsing it as JSON yields a value matching the expected type
//   3. If so, we replace the string with the parsed value and re-validate
//
// This is intentionally conservative: we only parse strings that look like
// valid JSON literals (objects, arrays, booleans, null, numbers) and only
// accept the result if it matches the schema's expected type.
// ============================================================================

/** Regex matching valid JSON number literals (integers, decimals, scientific notation) */
const JSON_NUMBER_PATTERN = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** Regex matching numeric strings (allows leading zeros) */
const NUMERIC_STRING_PATTERN = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * Normalizes AJV's `params.type` into a consistent string array.
 * AJV may report the expected type as a single string or an array of strings
 * (for union types like `["string", "null"]`).
 */
function normalizeExpectedTypes(typeParam: unknown): string[] {
	if (typeof typeParam === "string") return [typeParam];
	if (Array.isArray(typeParam)) {
		return typeParam.filter((entry): entry is string => typeof entry === "string");
	}
	return [];
}

/**
 * Checks if a value matches any of the expected JSON Schema types.
 * Used to verify that a parsed JSON value is actually what the schema wants.
 */
function matchesExpectedType(value: unknown, expectedTypes: string[]): boolean {
	return expectedTypes.some(type => {
		switch (type) {
			case "string":
				return typeof value === "string";
			case "number":
				return typeof value === "number" && Number.isFinite(value);
			case "integer":
				return typeof value === "number" && Number.isInteger(value);
			case "boolean":
				return typeof value === "boolean";
			case "null":
				return value === null;
			case "array":
				return Array.isArray(value);
			case "object":
				return value !== null && typeof value === "object" && !Array.isArray(value);
			default:
				return false;
		}
	});
}

function tryParseNumberString(value: string, expectedTypes: string[]): { value: unknown; changed: boolean } {
	if (!expectedTypes.includes("number") && !expectedTypes.includes("integer")) {
		return { value, changed: false };
	}

	const trimmed = value.trim();
	if (!trimmed || !NUMERIC_STRING_PATTERN.test(trimmed)) {
		return { value, changed: false };
	}

	const parsed = Number(trimmed);
	if (!Number.isFinite(parsed)) {
		return { value, changed: false };
	}

	if (!matchesExpectedType(parsed, expectedTypes)) {
		return { value, changed: false };
	}

	return { value: parsed, changed: true };
}

function tryParseLeadingJsonContainer(value: string): unknown | undefined {
	const firstChar = value[0];
	const closingChar = firstChar === "{" ? "}" : firstChar === "[" ? "]" : undefined;
	if (!closingChar) return undefined;

	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === '"') inString = false;
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}

		if (char === firstChar) {
			depth += 1;
			continue;
		}

		if (char !== closingChar) continue;
		depth -= 1;
		if (depth !== 0) continue;

		const prefix = value.slice(0, index + 1);
		try {
			return JSON.parse(prefix) as unknown;
		} catch {
			// LLMs sometimes emit literal `\n` or `\t` between JSON tokens
			// (e.g. `[{...}\n]`). Convert these to real whitespace and retry.
			const cleaned = cleanLiteralEscapes(prefix);
			if (cleaned !== prefix) {
				try {
					return JSON.parse(cleaned) as unknown;
				} catch {}
			}
			// Try escaping raw control chars that appear inside string literals.
			const escapedControls = escapeRawControlsInJsonStrings(prefix);
			if (escapedControls !== prefix) {
				try {
					return JSON.parse(escapedControls) as unknown;
				} catch {}
			}
			// Also try single-char healing on the extracted prefix.
			return tryHealMalformedJson(prefix);
		}
	}

	return undefined;
}

/**
 * Replace literal `\n`, `\t`, `\r` sequences that appear OUTSIDE of JSON
 * strings with actual whitespace.  LLMs sometimes produce these when they
 * confuse the tool-call encoding with the content encoding.
 */
function cleanLiteralEscapes(value: string): string {
	let result = "";
	let inString = false;
	let i = 0;
	while (i < value.length) {
		const ch = value[i];
		if (inString) {
			if (ch === "\\" && i + 1 < value.length) {
				result += ch + value[i + 1];
				i += 2;
				continue;
			}
			if (ch === '"') inString = false;
			result += ch;
			i += 1;
			continue;
		}
		if (ch === '"') {
			inString = true;
			result += ch;
			i += 1;
			continue;
		}
		// Outside a string: replace literal \n, \t, \r with whitespace
		if (ch === "\\" && i + 1 < value.length) {
			const next = value[i + 1];
			if (next === "n" || next === "t" || next === "r") {
				result += " ";
				i += 2;
				continue;
			}
		}
		result += ch;
		i += 1;
	}
	return result;
}
/**
 * Escape raw control characters (0x00–0x1F) that appear *inside* JSON string
 * literals. LLMs sometimes emit literal newlines/tabs/etc. inside string
 * content instead of `\n` / `\t` escape sequences, which `JSON.parse` rejects
 * even though the surrounding structure is valid.
 *
 * This function only rewrites characters while inside a string; structural
 * whitespace outside of strings is preserved unchanged.
 */
function escapeRawControlsInJsonStrings(value: string): string {
	let result = "";
	let inString = false;
	let escaped = false;
	let changed = false;
	for (let i = 0; i < value.length; i += 1) {
		const ch = value[i];
		if (inString) {
			if (escaped) {
				result += ch;
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				result += ch;
				escaped = true;
				continue;
			}
			if (ch === '"') {
				result += ch;
				inString = false;
				continue;
			}
			const code = ch.charCodeAt(0);
			if (code < 0x20) {
				changed = true;
				switch (ch) {
					case "\n":
						result += "\\n";
						break;
					case "\r":
						result += "\\r";
						break;
					case "\t":
						result += "\\t";
						break;
					case "\b":
						result += "\\b";
						break;
					case "\f":
						result += "\\f";
						break;
					default:
						result += `\\u${code.toString(16).padStart(4, "0")}`;
				}
				continue;
			}
			result += ch;
			continue;
		}
		if (ch === '"') {
			inString = true;
		}
		result += ch;
	}
	return changed ? result : value;
}

/** Maximum single-character edits to attempt when healing malformed JSON. */
const MAX_HEAL_DISTANCE = 3;
const BRACKET_CHARS = ["[", "]", "{", "}"] as const;

/**
 * Attempts to heal near-valid JSON by applying single-character edits near the
 * end of the string. LLMs (especially smaller ones) sometimes produce JSON with
 * a single misplaced, extra, or wrong bracket at the end — e.g. `"}]"` becomes
 * `"]}"` or gets an extra `}` appended. This function tries:
 *   1. Removing a single character from the last few positions
 *   2. Replacing a single character in the last few positions with each bracket type
 *
 * Returns the parsed value on success, undefined on failure.
 */
function tryHealMalformedJson(value: string): unknown | undefined {
	// Verify it actually fails to parse
	try {
		return JSON.parse(value) as unknown;
	} catch {}

	// Only attempt edits within the last few characters — the error is always
	// a bracket issue at the tail for the class of LLM mistakes this targets.
	const tailStart = Math.max(0, value.length - (MAX_HEAL_DISTANCE * 2 + 1));

	// Strategy 1: remove a single character from the tail
	for (let i = tailStart; i < value.length; i += 1) {
		const candidate = value.slice(0, i) + value.slice(i + 1);
		try {
			return JSON.parse(candidate) as unknown;
		} catch {}
	}

	// Strategy 2: replace a single character in the tail with each bracket type
	for (let i = tailStart; i < value.length; i += 1) {
		const original = value[i];
		for (const replacement of BRACKET_CHARS) {
			if (replacement === original) continue;
			const candidate = value.slice(0, i) + replacement + value.slice(i + 1);
			try {
				return JSON.parse(candidate) as unknown;
			} catch {}
		}
	}

	return undefined;
}

/**
 * Attempts to parse a string as JSON if it looks like a JSON literal and
 * the parsed result matches one of the expected types.
 *
 * Only attempts parsing for strings that syntactically look like JSON:
 *   - Objects: `{...}`
 *   - Arrays: `[...]`
 *   - Literals: `true`, `false`, `null`, or numeric strings
 *
 * Returns `{ changed: true }` only if parsing succeeded AND the result
 * matches an expected type. This prevents false positives like parsing
 * the string `"123"` when the schema actually wants a string.
 */
function tryParseJsonForTypes(value: string, expectedTypes: string[]): { value: unknown; changed: boolean } {
	const trimmed = value.trim();
	if (!trimmed) return { value, changed: false };

	const numberCoercion = tryParseNumberString(trimmed, expectedTypes);
	if (numberCoercion.changed) {
		return numberCoercion;
	}

	// Quick syntactic checks to avoid unnecessary parse attempts
	const looksJsonObject = trimmed.startsWith("{");
	const looksJsonArray = trimmed.startsWith("[");
	const looksJsonLiteral =
		trimmed === "true" || trimmed === "false" || trimmed === "null" || JSON_NUMBER_PATTERN.test(trimmed);

	if (!looksJsonObject && !looksJsonArray && !looksJsonLiteral) {
		return { value, changed: false };
	}

	try {
		const parsed = JSON.parse(trimmed) as unknown;
		// If the string was "null", we parsed it to actual null.
		// Accept this even if null isn't in expectedTypes - the LLM meant "no value".
		// normalizeOptionalNullsForSchema will strip it from optional fields, and
		// AJV will correctly error on required fields.
		if (parsed === null && trimmed === "null") {
			return { value: null, changed: true };
		}
		// For non-null values, only accept if the parsed type matches what the schema expects
		if (matchesExpectedType(parsed, expectedTypes)) {
			return { value: parsed, changed: true };
		}
	} catch {
		if (looksJsonObject || looksJsonArray) {
			// Try escaping raw control chars inside string literals (LLMs sometimes
			// emit literal newlines/tabs inside string content rather than `\n`/`\t`).
			const escapedControls = escapeRawControlsInJsonStrings(trimmed);
			if (escapedControls !== trimmed) {
				try {
					const parsed = JSON.parse(escapedControls) as unknown;
					if (matchesExpectedType(parsed, expectedTypes)) {
						return { value: parsed, changed: true };
					}
				} catch {}
			}
			// Try extracting a valid JSON prefix (handles trailing junk after balanced container)
			const leading = tryParseLeadingJsonContainer(trimmed);
			if (leading !== undefined && matchesExpectedType(leading, expectedTypes)) {
				return { value: leading, changed: true };
			}
			// Try healing single-character bracket errors near the end of the string
			const healed = tryHealMalformedJson(trimmed);
			if (healed !== undefined && matchesExpectedType(healed, expectedTypes)) {
				return { value: healed, changed: true };
			}
		}
		return { value, changed: false };
	}

	return { value, changed: false };
}

// ============================================================================
// JSON Pointer Utilities (RFC 6901)
// ============================================================================
//
// AJV reports error locations using JSON Pointer syntax (e.g., `/foo/0/bar`).
// These utilities allow reading and writing values at those paths.
// ============================================================================

/**
 * Decodes a JSON Pointer string into path segments.
 * Handles RFC 6901 escape sequences: ~1 -> /, ~0 -> ~
 */
function decodeJsonPointer(pointer: string): string[] {
	if (!pointer) return [];
	return pointer
		.split("/")
		.slice(1) // Remove leading empty segment from initial "/"
		.map(segment => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * Retrieves a value from a nested object/array structure using a JSON Pointer.
 * Returns undefined if the path doesn't exist or traversal fails.
 */
function getValueAtPointer(root: unknown, pointer: string): unknown {
	if (!pointer) return root;
	const segments = decodeJsonPointer(pointer);
	let current: unknown = root;

	for (const segment of segments) {
		if (current === null || current === undefined) return undefined;
		if (Array.isArray(current)) {
			const index = Number(segment);
			if (!Number.isInteger(index)) return undefined;
			current = current[index];
			continue;
		}
		if (typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}

	return current;
}

/**
 * Sets a value in a nested object/array structure using a JSON Pointer.
 * Mutates the structure in-place. Returns the root (possibly unchanged if
 * the path was invalid).
 */
function setValueAtPointer(root: unknown, pointer: string, value: unknown): unknown {
	if (!pointer) return value;
	const segments = decodeJsonPointer(pointer);
	let current: unknown = root;

	// Navigate to the parent of the target location
	for (let index = 0; index < segments.length - 1; index += 1) {
		const segment = segments[index];
		if (current === null || current === undefined) return root;
		if (Array.isArray(current)) {
			const arrayIndex = Number(segment);
			if (!Number.isInteger(arrayIndex)) return root;
			current = current[arrayIndex];
			continue;
		}
		if (typeof current !== "object") return root;
		current = (current as Record<string, unknown>)[segment];
	}

	// Set the value at the final segment
	const lastSegment = segments[segments.length - 1];
	if (Array.isArray(current)) {
		const arrayIndex = Number(lastSegment);
		if (!Number.isInteger(arrayIndex)) return root;
		current[arrayIndex] = value;
		return root;
	}

	if (typeof current !== "object" || current === null) return root;
	(current as Record<string, unknown>)[lastSegment] = value;
	return root;
}

function normalizeOptionalNullsForSchema(schema: unknown, value: unknown): { value: unknown; changed: boolean } {
	if (value === null || value === undefined) return { value, changed: false };
	if (schema === null || typeof schema !== "object") return { value, changed: false };

	const schemaObject = schema as Record<string, unknown>;

	const normalizeAnyOfLike = (keyword: "anyOf" | "oneOf"): { value: unknown; changed: boolean } => {
		const branches = schemaObject[keyword];
		if (!Array.isArray(branches)) return { value, changed: false };

		let changedCandidate: { value: unknown; changed: true } | null = null;

		for (const branch of branches) {
			const normalized = normalizeOptionalNullsForSchema(branch, value);
			if (!normalized.changed) continue;

			try {
				const validateBranch = ajv.compile(branch);
				if (validateBranch(normalized.value)) {
					return normalized;
				}
			} catch {
				// Ignore branch-level compilation/validation errors and keep scanning.
			}

			if (!changedCandidate) {
				changedCandidate = { value: normalized.value, changed: true };
			}
		}

		return changedCandidate ?? { value, changed: false };
	};

	const anyOfNormalization = normalizeAnyOfLike("anyOf");
	if (anyOfNormalization.changed) return anyOfNormalization;

	const oneOfNormalization = normalizeAnyOfLike("oneOf");
	if (oneOfNormalization.changed) return oneOfNormalization;

	if (Array.isArray(schemaObject.allOf)) {
		let changed = false;
		let nextValue: unknown = value;
		for (const branch of schemaObject.allOf) {
			const normalized = normalizeOptionalNullsForSchema(branch, nextValue);
			if (!normalized.changed) continue;
			nextValue = normalized.value;
			changed = true;
		}
		if (changed) return { value: nextValue, changed: true };
	}

	if (Array.isArray(value)) {
		const itemSchema = schemaObject.items;
		if (itemSchema === null || typeof itemSchema !== "object" || Array.isArray(itemSchema)) {
			return { value, changed: false };
		}

		let changed = false;
		let nextValue = value;
		for (let i = 0; i < value.length; i += 1) {
			const normalized = normalizeOptionalNullsForSchema(itemSchema, value[i]);
			if (!normalized.changed) continue;
			if (!changed) {
				nextValue = [...value];
				changed = true;
			}
			nextValue[i] = normalized.value;
		}
		return { value: changed ? nextValue : value, changed };
	}

	// Coerce string → number/integer when the schema branch declares those types.
	// This fixes anyOf:[{type:"number"},{type:"null"}] (i.e. Optional<number>) where
	// AJV reports an "anyOf" error rather than a "type" error, bypassing
	// coerceArgsFromErrors which only handles keyword:"type" errors.
	if ((schemaObject.type === "number" || schemaObject.type === "integer") && typeof value === "string") {
		return tryParseNumberString(value, [schemaObject.type as string]);
	}

	if (schemaObject.type !== "object") return { value, changed: false };
	if (typeof value !== "object" || value === null) return { value, changed: false };
	if (Array.isArray(value)) return { value, changed: false };
	if (schemaObject.properties === null || typeof schemaObject.properties !== "object") {
		return { value, changed: false };
	}

	const properties = schemaObject.properties as Record<string, unknown>;
	const required = new Set(Array.isArray(schemaObject.required) ? (schemaObject.required as string[]) : []);

	let changed = false;
	let nextValue = value as Record<string, unknown>;

	for (const [key, propertySchema] of Object.entries(properties)) {
		if (!(key in nextValue)) continue;
		const currentValue = nextValue[key];

		// Strip null and the string "null" from optional fields.
		// The LLM sometimes outputs string "null" to mean "no value".
		if ((currentValue === null || currentValue === "null") && !required.has(key)) {
			if (!changed) {
				nextValue = { ...nextValue };
				changed = true;
			}
			delete nextValue[key];
			continue;
		}
		const normalized = normalizeOptionalNullsForSchema(propertySchema, currentValue);
		if (!normalized.changed) continue;

		if (!changed) {
			nextValue = { ...nextValue };
			changed = true;
		}
		nextValue[key] = normalized.value;
	}

	// Strip unknown keys with null/"null" values when the schema forbids extras.
	// LLMs sometimes hallucinate verbs alongside valid ones (e.g. `split: null`,
	// `original: null`). Rejecting the entire tool call wastes a turn; treating
	// these the same as null on known optional fields is a safer fallback. Keys
	// with non-null unknown values are left intact so genuine schema mistakes
	// still surface as validation errors.
	if (schemaObject.additionalProperties === false) {
		const knownKeys = new Set(Object.keys(properties));
		for (const key of Object.keys(nextValue)) {
			if (knownKeys.has(key)) continue;
			const v = nextValue[key];
			if (v !== null && v !== "null") continue;
			if (!changed) {
				nextValue = { ...nextValue };
				changed = true;
			}
			delete nextValue[key];
		}
	}

	return { value: changed ? nextValue : value, changed };
}

/**
 * Attempts to fix type errors by parsing JSON-encoded strings.
 *
 * When AJV reports type errors, this function checks if the offending values
 * are strings that contain valid JSON matching the expected type. If so, it
 * returns a new args object with those strings replaced by their parsed values.
 *
 * The function is designed to be safe and conservative:
 *   - Only processes "type" errors (not format, pattern, etc.)
 *   - Only attempts coercion on string values
 *   - Only accepts parsed results that match the expected type
 *   - Clones the args object before mutation (copy-on-write)
 */
function coerceArgsFromErrors(
	args: unknown,
	errors: Array<{ keyword?: string; instancePath?: string; params?: { type?: unknown } }> | null | undefined,
): { value: unknown; changed: boolean } {
	if (!errors || errors.length === 0) return { value: args, changed: false };

	let changed = false;
	let nextArgs: unknown = args;

	for (const error of errors) {
		// Only handle type mismatch errors
		if (error.keyword !== "type") continue;

		const instancePath = error.instancePath ?? "";
		const expectedTypes = normalizeExpectedTypes(error.params?.type);
		if (expectedTypes.length === 0) continue;

		// Get the current value at the error location
		const currentValue = getValueAtPointer(nextArgs, instancePath);

		// Object-wrapper coercion: when the schema expects a string and the LLM
		// sent an object like {task: "..."} (commonly happens with todo_write
		// `items` where the model wraps each task content in {task: "..."}),
		// extract the string field so validation passes. This is the second
		// half of the LLM-shape error family that preParseJsonStrings catches
		// for the "stringified-JSON" case — here the LLM didn't stringify,
		// it just wrapped the string in a single-key object.
		if (
			expectedTypes.includes("string") &&
			typeof currentValue === "object" &&
			currentValue !== null &&
			!Array.isArray(currentValue)
		) {
			const extracted = extractStringFromWrapperObject(currentValue as Record<string, unknown>);
			if (extracted !== undefined) {
				if (!changed) {
					nextArgs = structuredCloneJSON(nextArgs);
					changed = true;
				}
				nextArgs = setValueAtPointer(nextArgs, instancePath, extracted);
				continue;
			}
		}

		// Object-to-array coercion: when the schema expects an array and the LLM
		// sent an object (e.g. items: { task1: "desc1", task2: "desc2" } instead of
		// items: ["desc1", "desc2"]), extract the values into an array.
		if (
			expectedTypes.includes("array") &&
			typeof currentValue === "object" &&
			currentValue !== null &&
			!Array.isArray(currentValue)
		) {
			const values = Object.values(currentValue as Record<string, unknown>);
			if (!changed) {
				nextArgs = structuredCloneJSON(nextArgs);
				changed = true;
			}
			nextArgs = setValueAtPointer(nextArgs, instancePath, values);
			continue;
		}

		if (typeof currentValue !== "string") continue;

		// Try to parse the string as JSON
		const result = tryParseJsonForTypes(currentValue, expectedTypes);
		if (!result.changed) continue;

		// Clone on first modification (copy-on-write)
		if (!changed) {
			nextArgs = structuredCloneJSON(nextArgs);
			changed = true;
		}
		nextArgs = setValueAtPointer(nextArgs, instancePath, result.value);
	}

	// $‑prefixed key → required property: when the LLM sends an object
	// with a `$`-prefixed key (like `$text`) instead of the schema's
	// required property (like `op`), rename the key. This catches the
	// common LLM error of using intent-field naming conventions for
	// actual tool arguments.
	for (const error of errors) {
		if (error.keyword !== "required") continue;

		const instancePath = error.instancePath ?? "";
		const missingProperty = (error.params as { missingProperty?: string })?.missingProperty;
		if (!missingProperty) continue;

		const currentValue = getValueAtPointer(nextArgs, instancePath);
		if (typeof currentValue !== "object" || currentValue === null || Array.isArray(currentValue)) continue;

		const obj = currentValue as Record<string, unknown>;
		const dollarKey = Object.keys(obj).find(k => k.startsWith("$"));
		if (!dollarKey) continue;

		if (!changed) {
			nextArgs = structuredCloneJSON(nextArgs);
			changed = true;
		}

		const repaired = { ...(getValueAtPointer(nextArgs, instancePath) as Record<string, unknown>) };
		repaired[missingProperty] = repaired[dollarKey];
		delete repaired[dollarKey];
		nextArgs = setValueAtPointer(nextArgs, instancePath, repaired);
	}

	return { value: changed ? nextArgs : args, changed };
}

/**
 * Pre-scans tool call arguments and attempts to JSON.parse any string values
 * that look like JSON arrays or objects. LLMs sometimes serialize array/object
 * parameters as JSON strings (e.g. `ops="[{...}]"` instead of `ops=[{...}]`).
 *
 * This runs BEFORE AJV validation, so it catches these cases proactively
 * rather than relying on the post-failure coercion loop.
 *
 * Only parses strings that start with `[` or `{` and only accepts the result
 * if it's an array or object. All other types (numbers, booleans, null) are
 * left untouched — those are handled by coerceArgsFromErrors if needed.
 */
function preParseJsonStrings(args: unknown): { value: unknown; changed: boolean } {
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		return { value: args, changed: false };
	}

	let changed = false;
	const result: Record<string, unknown> = { ...(args as Record<string, unknown>) };

	for (const [key, value] of Object.entries(result)) {
		if (typeof value !== "string") continue;

		const trimmed = value.trim();
		if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;

		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (parsed !== null && typeof parsed === "object") {
				result[key] = parsed;
				changed = true;
			}
		} catch {
			// Not valid JSON — leave as-is; coerceArgsFromErrors may still
			// handle it via tryParseLeadingJsonContainer or healing.
		}
	}

	return changed ? { value: result, changed: true } : { value: args, changed: false };
}

// Create a singleton AJV instance with formats (only if not in browser extension)
// AJV requires 'unsafe-eval' CSP which is not allowed in Manifest V3
//
// Silent logger: MCP servers may declare non-standard format keywords (e.g. "uint")
// which cause Ajv to emit console.warn() with strict:false — corrupting TUI output.
const ajv = new Ajv({
	allErrors: true,
	strict: false,
	logger: false,
});
addFormats(ajv);

/**
 * LLM mistake pattern: when the schema expects a flat `string[]`, the model
 * sometimes sends an array of single-key objects like
 * `[{task: "..."}, {task: "..."}]` instead of `["...", "..."]`. The most common
 * observed case is todo_write `items` (the model treats each task content as
 * a structured field), but the same shape recurs for any string-typed list.
 *
 * Heuristic: prefer well-known content field names in this order —
 *   task > text > content > name > value > description > label
 * If none of those are present, fall back to a single non-empty string field
 * (catches `{foo: "bar"}` with one string). Returns `undefined` if no
 * extractable string exists, so AJV will still report the original error.
 */
const STRING_WRAPPER_PREFERRED_KEYS = ["task", "text", "content", "name", "value", "description", "label"] as const;

function extractStringFromWrapperObject(obj: Record<string, unknown>): string | undefined {
	for (const key of STRING_WRAPPER_PREFERRED_KEYS) {
		const v = obj[key];
		if (typeof v === "string" && v.length > 0) return v;
	}
	const stringFields = Object.entries(obj).filter(([, v]) => typeof v === "string" && v.length > 0);
	if (stringFields.length === 1) {
		const candidate = stringFields[0]?.[1];
		if (typeof candidate === "string") return candidate;
	}
	return undefined;
}

// Cache compiled validators by schema object identity to avoid
// re-compiling the same tool schema on every call.
const compiledSchemaCache = new WeakMap<object, import("ajv").ValidateFunction>();
function compileSchema(schema: object): import("ajv").ValidateFunction {
	let validate = compiledSchemaCache.get(schema);
	if (!validate) {
		validate = ajv.compile(schema);
		compiledSchemaCache.set(schema, validate);
	}
	return validate;
}

const MAX_TYPE_COERCION_PASSES = 5;

/**
 * Finds a tool by name and validates the tool call arguments against its TypeBox schema
 * @param tools Array of tool definitions
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error if tool is not found or validation fails
 */
export function validateToolCall(tools: Tool[], toolCall: ToolCall): ToolCall["arguments"] {
	const tool = tools.find(t => t.name === toolCall.name);
	if (!tool) {
		throw new Error(`Tool "${toolCall.name}" not found`);
	}
	return validateToolArguments(tool, toolCall);
}

/**
 * Validates tool call arguments against the tool's TypeBox schema
 * @param tool The tool definition with TypeBox schema
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error with formatted message if validation fails
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): ToolCall["arguments"] {
	const originalArgs = toolCall.arguments;

	const validate = compileSchema(tool.parameters);

	// Always normalize first - strip null and string "null" from optional fields.
	// This handles LLM outputting string "null" to mean "no value" even when
	// validation would pass (e.g., optional string field where "null" is a valid string).
	let normalizedArgs: unknown = originalArgs;
	let changed = false;

	const initialNormalization = normalizeOptionalNullsForSchema(tool.parameters, normalizedArgs);
	if (initialNormalization.changed) {
		normalizedArgs = initialNormalization.value;
		changed = true;
	}

	// Pre-scan: auto-parse string values that look like JSON arrays/objects.
	// LLMs sometimes serialize array/object parameters as JSON strings.
	// This runs before AJV validation (not after failure), so it proactively
	// prevents type errors like "ops: must be array" instead of recovering.
	const preParsed = preParseJsonStrings(normalizedArgs);
	if (preParsed.changed) {
		normalizedArgs = preParsed.value;
		changed = true;

		// Re-normalize: the pre-scan may have parsed string-encoded arrays
		// or objects, revealing null fields that weren't visible when they
		// were still strings. Strip those nulls from optional fields now.
		const postScanNormalization = normalizeOptionalNullsForSchema(tool.parameters, normalizedArgs);
		if (postScanNormalization.changed) {
			normalizedArgs = postScanNormalization.value;
		}
	}

	// Validate after normalization and pre-scan
	if (validate(normalizedArgs)) {
		return normalizedArgs as ToolCall["arguments"];
	}

	for (let pass = 0; pass < MAX_TYPE_COERCION_PASSES; pass += 1) {
		const coercion = coerceArgsFromErrors(normalizedArgs, validate.errors);
		if (!coercion.changed) break;

		normalizedArgs = coercion.value;
		changed = true;

		const nullNormalization = normalizeOptionalNullsForSchema(tool.parameters, normalizedArgs);
		if (nullNormalization.changed) {
			normalizedArgs = nullNormalization.value;
		}

		if (validate(normalizedArgs)) {
			return normalizedArgs as ToolCall["arguments"];
		}
	}

	// Format validation errors nicely
	const errors =
		validate.errors
			?.map((err: any) => {
				const path = err.instancePath ? err.instancePath.substring(1) : err.params.missingProperty || "root";
				return `  - ${path}: ${err.message}`;
			})
			.join("\n") || "Unknown validation error";

	const receivedArgs = changed
		? {
				original: originalArgs,
				normalized: normalizedArgs,
			}
		: originalArgs;

	let errorMessage = `Validation failed for tool "${
		toolCall.name
	}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(receivedArgs, null, 2)}`;

	// Enhanced hint: when the LLM sent an args object that contains ONLY
	// intent fields (like `_i`) and is missing all required properties, the
	// standard error doesn't tell the LLM what to fix. Surface a clear hint.
	const missingRequired = Array.isArray(validate.errors)
		? validate.errors
				.filter((err: any) => err.keyword === "required")
				.map((err: any) => err.params?.missingProperty)
				.filter((name: unknown): name is string => typeof name === "string")
		: [];
	if (
		missingRequired.length > 0 &&
		typeof originalArgs === "object" &&
		originalArgs !== null &&
		!Array.isArray(originalArgs) &&
		isIntentOnlyArgs(originalArgs as Record<string, unknown>)
	) {
		errorMessage += `\n\nHint: your arguments object only contains intent fields (e.g. _i) ` +
			`but is missing required properties: ${missingRequired.join(", ")}. ` +
			`Did you forget to include the actual tool arguments? Re-emit the tool call ` +
			`with the full argument object (intent fields are optional, not a substitute for args).`;
	}

	throw new Error(errorMessage);
}

/**
 * Returns true when an args object contains ONLY intent fields (keys starting
 * with `_` like `_i`) and no real arguments. Used to detect the LLM failure
 * mode where it sends the intent description but forgets the actual tool args.
 */
function isIntentOnlyArgs(args: Record<string, unknown>): boolean {
	const keys = Object.keys(args);
	if (keys.length === 0) return false;
	return keys.every(k => k.startsWith("_"));
}
