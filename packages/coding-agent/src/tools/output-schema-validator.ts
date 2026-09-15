/**
 * The single entry point for the "does this subagent output match the declared output schema"
 * judgment.
 *
 * Two callsites need the same verdict for the same declaration: the `yield` tool on the subagent
 * side, and the subagent executor's post-mortem finalizer on the parent side. A payload the child
 * accepted must not be rejected by the parent (or the reverse), so schema normalization,
 * compilation and issue formatting live here and nowhere else. Each callsite keeps only its own
 * policy — `yield` runs its retry/override ladder, the executor decides whether a raw-text
 * completion is an acceptable fallback.
 */
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import { dereferenceJsonSchema } from "@cornfield/ai/utils/schema";
import { isRecord } from "@cornfield/utils";
import { jtdToJsonSchema, normalizeSchema } from "./jtd-to-json-schema";

/**
 * The one AJV instance every output-schema verdict is computed with. `logger: false` is
 * load-bearing: a schema carrying a non-standard keyword would otherwise reach `console.warn`
 * and corrupt TUI output.
 */
const ajv = new Ajv({ allErrors: true, strict: false, logger: false });

/** Compiled validators keyed by schema identity — a session's output schema is a stable object. */
const compiledSchemas = new WeakMap<object, ValidateFunction>();

export type SchemaCompilation = { ok: true; validate: ValidateFunction } | { ok: false; error: string };

/**
 * Compile a JSON Schema with the shared instance. Boolean schemas (`true` accepts everything,
 * `false` rejects everything) compile too, but are not cached — they carry no identity to key on.
 */
export function compileJsonSchema(schema: unknown): SchemaCompilation {
	if (schema === null || typeof schema !== "object") {
		try {
			return { ok: true, validate: ajv.compile(schema as boolean) };
		} catch (err) {
			return { ok: false, error: errorMessage(err) };
		}
	}

	const cached = compiledSchemas.get(schema);
	if (cached) return { ok: true, validate: cached };

	try {
		const validate = ajv.compile(schema);
		compiledSchemas.set(schema, validate);
		return { ok: true, validate };
	} catch (err) {
		return { ok: false, error: errorMessage(err) };
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** One violated constraint, located by JSON Pointer. */
export interface SchemaValidationIssue {
	/** JSON Pointer (RFC 6901) to the offending value — AJV's `instancePath`, empty at the root. */
	pointer: string;
	/** AJV's message for the rule that failed; it names the rule and the expectation where there is one. */
	message: string;
}

export interface SchemaValidationResult {
	/** True when the value satisfies the schema. */
	valid: boolean;
	/** Every violated constraint when `valid` is false; empty otherwise. */
	issues: SchemaValidationIssue[];
}

export interface OutputSchemaValidation {
	/** The declaration after `normalizeSchema` (a JSON string becomes its parsed value). `undefined` when none was supplied. */
	normalized?: unknown;
	/** The JTD-converted JSON Schema the verdict is computed against. `undefined` when the declaration could not be read. */
	jsonSchema?: unknown;
	/** The judgment itself. Absent when the declaration does not constrain output. */
	validate?: (value: unknown) => SchemaValidationResult;
	/**
	 * Why the declaration cannot constrain output: unreadable, `false`, or uncompilable.
	 * Whether that is fatal belongs to the caller.
	 */
	error?: string;
}

/**
 * Build the verdict function for an output-schema declaration — JTD or JSON Schema, object or
 * JSON string.
 *
 * - `{ validate }` for a constraining declaration, including `true` (accepts everything).
 * - `{}` when no declaration was supplied.
 * - `{ error, normalized, jsonSchema }` when the declaration cannot constrain output.
 *
 * A declaration that normalizes and converts cleanly but fails AJV compilation is reported as
 * `error`, not thrown: both callsites treat "schema unusable" as loose acceptance with a
 * diagnostic. A declaration whose *shape* defeats conversion (circular, pathologically deep)
 * still throws from `jtdToJsonSchema`; callers keep whatever handling they already had for that.
 */
export function buildOutputValidator(schema: unknown): OutputSchemaValidation {
	const { normalized, error: normalizeError } = normalizeSchema(schema);
	if (normalizeError) return { error: normalizeError, normalized };
	if (normalized === undefined) return {};

	const jsonSchema = jtdToJsonSchema(normalized);
	if (jsonSchema === false) {
		return { error: "boolean false schema rejects all outputs", normalized, jsonSchema };
	}

	const compilation = compileJsonSchema(jsonSchema);
	if (!compilation.ok) return { error: compilation.error, normalized, jsonSchema };

	const validate = compilation.validate;
	return { normalized, jsonSchema, validate: value => toResult(validate, value) };
}

function toResult(validate: ValidateFunction, value: unknown): SchemaValidationResult {
	if (validate(value)) return { valid: true, issues: [] };
	return { valid: false, issues: toIssues(validate.errors) };
}

/**
 * Top-level `properties` of the schema's object form, or `undefined` when the
 * declaration names no properties (absent, loose, boolean, or not an object).
 *
 * `undefined` is not "no section is known": it means there is nothing to check
 * a label against, so callers must not reject labels on its account.
 */
function topLevelProperties(schema: unknown): { properties: Record<string, unknown>; closed: boolean } | undefined {
	const { jsonSchema } = buildOutputValidator(schema);
	if (jsonSchema === undefined) return undefined;
	const dereferenced = dereferenceJsonSchema(jsonSchema);
	const object = isRecord(dereferenced) ? dereferenced : isRecord(jsonSchema) ? jsonSchema : undefined;
	if (object === undefined) return undefined;
	const properties = object.properties;
	if (!isRecord(properties)) return undefined;
	return { properties, closed: object.additionalProperties === false };
}

/** What an output schema says about incremental `yield` sections. */
export interface SectionMetadata {
	/** Top-level labels the schema declares; `undefined` when it declares no properties. */
	labels?: ReadonlySet<string>;
	/**
	 * True when the top-level schema is closed (`additionalProperties: false`).
	 * Only then is an undeclared label impossible to assemble into a valid
	 * result — an open schema can still carry one, so rejecting it there would
	 * forbid sections the schema tolerates.
	 */
	closed: boolean;
}

/**
 * Read what the schema declares about sections. Best-effort by construction: a
 * declaration whose shape defeats conversion (circular, pathologically deep)
 * reports "declares nothing" instead of throwing, because every caller treats
 * that as "nothing to check" — and a tool that cannot be constructed because of
 * an exotic schema is a worse failure than a missed label check.
 */
export function sectionMetadata(schema: unknown): SectionMetadata {
	try {
		const top = topLevelProperties(schema);
		if (top === undefined) return { closed: false };
		return { labels: new Set(Object.keys(top.properties)), closed: top.closed };
	} catch {
		return { closed: false };
	}
}

/**
 * Validate one section payload.
 *
 * An array-typed property validates the payload against its `items` schema,
 * because each section submission contributes exactly one element of that list
 * (the caller accumulates the elements). Scalar properties validate against the
 * property schema itself. Returns `undefined` when the schema declares no
 * subschema for `label`, or when that subschema cannot be compiled — there is no
 * verdict to give, and the caller decides whether an undeclared label is an error.
 */
export function validateSection(
	schema: unknown,
	label: string,
	value: unknown,
): SchemaValidationResult | undefined {
	try {
		const sub = topLevelProperties(schema)?.properties[label];
		if (sub === undefined || sub === null) return undefined;
		// An array-typed property receives the payload as one element of that list,
		// so it is judged by the element schema — not by the list shape, which the
		// caller builds.
		const record = isRecord(sub) ? sub : undefined;
		const elementSchema = record?.type === "array" && record.items != null ? record.items : sub;
		const compilation = compileJsonSchema(elementSchema);
		if (!compilation.ok) return undefined;
		return toResult(compilation.validate, value);
	} catch {
		return undefined;
	}
}

function toIssues(errors: ErrorObject[] | null | undefined): SchemaValidationIssue[] {
	if (!errors || errors.length === 0) return [];
	return errors.map(error => ({ pointer: error.instancePath ?? "", message: error.message ?? "invalid" }));
}

/**
 * Render issues for the model: `pointer: message`, joined with `; `.
 *
 * Every problem is reported at once so one retry can fix the whole payload, and the pointer keeps
 * the failing location distinguishable from a message that merely mentions the field name.
 */
export function formatValidationIssues(issues: readonly SchemaValidationIssue[] | undefined): string {
	if (!issues || issues.length === 0) return "Unknown schema validation error.";
	return issues.map(issue => (issue.pointer ? `${issue.pointer}: ${issue.message}` : issue.message)).join("; ");
}
