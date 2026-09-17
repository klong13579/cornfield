/**
 * Submit result tool for structured subagent output.
 *
 * Subagents must call this tool to finish and return structured JSON output.
 */
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@cornfield/agent";
import { dereferenceJsonSchema, sanitizeSchemaForStrictMode } from "@cornfield/ai/utils/schema";
import { isRecord } from "@cornfield/utils";
import type { Static, TSchema } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import yieldDescription from "../prompts/tools/yield.md" with { type: "text" };
import { subprocessToolRegistry } from "../task/subprocess-tool-registry";
import { isIncrementalYieldType } from "../task/yield-assembly";
import type { ToolSession } from ".";
import {
	buildOutputValidator,
	compileJsonSchema,
	formatValidationIssues,
	type SchemaValidationResult,
	type SectionMetadata,
	sectionMetadata,
	validateSection,
} from "./output-schema-validator";

export interface YieldDetails {
	data: unknown;
	status: "success" | "aborted";
	error?: string;
	/**
	 * `string[]` (non-empty) = an incremental section submission: the task keeps
	 * going and these sections accumulate. A plain `string` (or absent) = the
	 * terminal submission that finishes the task.
	 */
	type?: string | string[];
}

/**
 * Normalize the raw `type` argument. Unknown shapes are dropped rather than
 * guessed at: a number or an empty list is not a section list, and treating it
 * as one would both terminate the task and assemble a nameless section.
 */
function normalizeYieldType(raw: unknown): string | string[] | undefined {
	if (typeof raw === "string") return raw.trim() === "" ? undefined : raw;
	if (!Array.isArray(raw)) return undefined;
	const labels = raw.filter((v): v is string => typeof v === "string" && v.trim() !== "");
	return labels.length === 0 ? undefined : labels;
}

/**
 * The `type` argument: a plain string marks the terminal submission, a non-empty
 * string array names incremental sections. Built fresh for each variant so no
 * single TypeBox node is shared between two schemas.
 */
function createTypeSchema(): TSchema {
	return Type.Optional(
		Type.Union([
			Type.String({ description: "Terminal result label: a plain string finishes the task." }),
			Type.Array(Type.String(), {
				minItems: 1,
				description: "Incremental section label(s): the task continues and these sections accumulate.",
			}),
		]),
	);
}

function formatSchema(schema: unknown): string {
	if (schema === undefined) return "No schema provided.";
	if (typeof schema === "string") return schema;
	try {
		return JSON.stringify(schema, null, 2);
	} catch {
		return "[unserializable schema]";
	}
}

export class YieldTool implements AgentTool<TSchema, YieldDetails> {
	readonly name = "yield";
	readonly label = "Submit Result";
	readonly loadMode = "internal" as const;
	readonly summary = "Returns structured output to finish a subagent task.";
	readonly description = yieldDescription;
	readonly parameters: TSchema;
	strict = true;
	readonly intent = "omit" as const;
	lenientArgValidation = true;

	readonly #validate?: (value: unknown) => SchemaValidationResult;
	readonly #validateSection?: (label: string, value: unknown) => SchemaValidationResult | undefined;
	/** What the output schema declares about sections (labels + whether an undeclared one can fit). */
	#sections: SectionMetadata = { closed: false };
	#schemaValidationFailures = 0;

	constructor(session: ToolSession) {
		const createParameters = (dataSchema: TSchema): TSchema =>
			Type.Object(
				{
					result: Type.Union([
						Type.Object({ data: dataSchema, type: createTypeSchema() }, { description: "task succeeded" }),
						Type.Object({
							error: Type.String({ description: "error message" }),
							type: createTypeSchema(),
						}),
					]),
				},
				{
					additionalProperties: false,
					description: "submit data or error",
				},
			) as TSchema;

		let validate: ((value: unknown) => SchemaValidationResult) | undefined;
		let dataSchema: TSchema;
		let parameters: TSchema;

		try {
			const {
				validate: schemaValidate,
				jsonSchema: normalizedSchema,
				error: schemaError,
			} = buildOutputValidator(session.outputSchema);
			validate = schemaValidate;

			const schemaHint = formatSchema(normalizedSchema ?? session.outputSchema);
			const schemaDescription = schemaError
				? `Structured JSON output (output schema invalid; accepting unconstrained object): ${schemaError}`
				: `Structured output matching the schema:\n${schemaHint}`;
			const sanitizedSchema =
				!schemaError &&
				normalizedSchema != null &&
				typeof normalizedSchema === "object" &&
				!Array.isArray(normalizedSchema)
					? sanitizeSchemaForStrictMode(normalizedSchema as Record<string, unknown>)
					: !schemaError && normalizedSchema === true
						? {}
						: undefined;

			if (sanitizedSchema !== undefined) {
				const resolved = dereferenceJsonSchema({
					...sanitizedSchema,
					description: schemaDescription,
				});
				dataSchema = Type.Unsafe(resolved as Record<string, unknown>);
			} else {
				dataSchema = Type.Record(Type.String(), Type.Any(), {
					description: schemaError ? schemaDescription : "Structured JSON output (no schema specified)",
				});
			}
			parameters = createParameters(dataSchema);
			JSON.stringify(parameters);
			// Verify the final parameters compile with AJV (catches unresolved $ref, etc.)
			const compilation = compileJsonSchema(parameters);
			if (!compilation.ok) throw new Error(compilation.error);
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			dataSchema = Type.Record(Type.String(), Type.Any(), {
				description: `Structured JSON output (schema processing failed: ${errorMsg})`,
			});
			parameters = createParameters(dataSchema);
			validate = undefined;
			this.strict = false;
		}

		this.#validate = validate;
		this.parameters = parameters;
		// Best-effort read: an exotic schema (circular, pathologically deep) reports
		// "declares nothing" rather than failing the tool's construction.
		this.#sections = sectionMetadata(session.outputSchema);
		this.#validateSection = (label, value) => validateSection(session.outputSchema, label, value);
	}

	/**
	 * Record one schema rejection. The first is surfaced so the model can correct
	 * the payload; later ones are accepted with a notice — the ladder terminal
	 * submissions have always used. Returns whether the payload was accepted over
	 * the rejection.
	 */
	#recordSchemaFailure(message: string): boolean {
		this.#schemaValidationFailures++;
		if (this.#schemaValidationFailures <= 1) throw new Error(message);
		return true;
	}

	async execute(
		_toolCallId: string,
		params: Static<TSchema>,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<YieldDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<YieldDetails>> {
		const raw = params as Record<string, unknown>;
		const rawResult = raw.result;
		if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) {
			throw new Error("result must be an object containing either data or error");
		}

		const resultRecord = rawResult as Record<string, unknown>;
		const errorMessage = typeof resultRecord.error === "string" ? resultRecord.error : undefined;
		const data = resultRecord.data;

		if (errorMessage !== undefined && data !== undefined) {
			throw new Error("result cannot contain both data and error");
		}
		if (errorMessage === undefined && data === undefined) {
			throw new Error(
				'result must contain either `data` or `error`. Use `{result: {data: <your output>}}` for success or `{result: {error: "message"}}` for failure.',
			);
		}

		const type = normalizeYieldType(resultRecord.type);
		const sectionList = Array.isArray(type) ? type : [];
		const isIncremental = sectionList.length > 0;

		const status = errorMessage !== undefined ? "aborted" : "success";
		let schemaValidationOverridden = false;
		if (status === "success") {
			if (data === undefined || data === null) {
				throw new Error("data is required when yield indicates success");
			}
			if (isIncremental) {
				// A section payload is judged against its own label's schema, never against
				// the whole output schema: a part of the result cannot satisfy the shape the
				// whole result has to. An undeclared label is refused only when the schema
				// is closed — there it cannot end up in a valid result, while an open
				// schema still carries it, so refusing would forbid a section the schema
				// itself tolerates.
				const known = this.#sections.labels;
				for (const label of sectionList) {
					if (this.#sections.closed && known !== undefined && !known.has(label)) {
						throw new Error(`Unknown output section "${label}". Known sections: ${[...known].join(", ")}.`);
					}
					const verdict = this.#validateSection?.(label, data);
					if (verdict && !verdict.valid) {
						schemaValidationOverridden = this.#recordSchemaFailure(
							`Output section "${label}" does not match its schema: ${formatValidationIssues(verdict.issues)}`,
						);
					}
				}
			} else if (this.#validate) {
				const verdict = this.#validate(data);
				if (!verdict.valid) {
					schemaValidationOverridden = this.#recordSchemaFailure(
						`Output does not match schema: ${formatValidationIssues(verdict.issues)}`,
					);
				}
			}
		}

		const responseText =
			status === "aborted"
				? `Task aborted: ${errorMessage}`
				: schemaValidationOverridden
					? `Result submitted (schema validation overridden after ${this.#schemaValidationFailures} failed attempt(s)).`
					: isIncremental
						? `Section submitted: ${sectionList.join(", ")}.`
						: "Result submitted.";
		return {
			content: [{ type: "text", text: responseText }],
			details: { data, status, error: errorMessage, type },
		};
	}
}

// Register subprocess tool handler for extraction + termination.
subprocessToolRegistry.register<YieldDetails>("yield", {
	extractData: event => {
		const details = event.result?.details;
		if (!details || typeof details !== "object") return undefined;
		const record = details as Record<string, unknown>;
		const status = record.status;
		if (status !== "success" && status !== "aborted") return undefined;
		return {
			data: record.data,
			status,
			error: typeof record.error === "string" ? record.error : undefined,
			type: normalizeYieldType(record.type),
		};
	},
	// Only a terminal submission finishes the subprocess: an incremental section
	// (`type: [...]`) reports a part of the result and the task continues, so
	// terminating here would cut the agent off mid-result.
	shouldTerminate: event => {
		if (event.isError) return false;
		const details = isRecord(event.result?.details) ? event.result.details : undefined;
		return !isIncrementalYieldType(details?.type);
	},
});
