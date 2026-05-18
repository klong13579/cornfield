/**
 * Embedding Generator: produces vector embeddings from text using
 * OpenAI-compatible embeddings API endpoints.
 *
 * Supported models: text-embedding-3-small, text-embedding-3-large, etc.
 * Falls back gracefully when no model/API key is available.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { getEnvApiKey } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmbeddingResult {
	embedding: Float32Array;
	model: string;
	usage?: { promptTokens: number; totalTokens: number };
}

export interface EmbeddingBatchResult {
	embeddings: Float32Array[];
	model: string;
	usage?: { promptTokens: number; totalTokens: number };
}

// ---------------------------------------------------------------------------
// Default embedding model
// ---------------------------------------------------------------------------

const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS: Record<string, number> = {
	"text-embedding-3-small": 1536,
	"text-embedding-3-large": 3072,
	"text-embedding-ada-002": 1536,
};

function getEmbeddingDimension(modelId: string): number {
	// Check known models
	for (const [prefix, dim] of Object.entries(EMBEDDING_DIMENSIONS)) {
		if (modelId.includes(prefix)) return dim;
	}
	// Default to 1536 for unknown models
	return 1536;
}

// ---------------------------------------------------------------------------
// API Client
// ---------------------------------------------------------------------------

interface EmbeddingApiResponse {
	data: Array<{ embedding: number[]; index: number }>;
	model: string;
	usage: { prompt_tokens: number; total_tokens: number };
}

/**
 * Call an OpenAI-compatible /v1/embeddings endpoint.
 */
async function callEmbeddingApi(
	baseUrl: string,
	apiKey: string,
	modelId: string,
	inputs: string[],
): Promise<EmbeddingApiResponse> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 30_000);

	try {
		const url = `${baseUrl.replace(/\/+$/, "")}/v1/embeddings`;
		const response = await fetch(url, {
			method: "POST",
			signal: controller.signal,
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model: modelId,
				input: inputs,
			}),
		});

		if (!response.ok) {
			const errorText = await response.text().catch(() => "unknown error");
			throw new Error(`Embedding API error ${response.status}: ${errorText.slice(0, 500)}`);
		}

		const json = (await response.json()) as unknown;
		if (!isValidEmbeddingResponse(json)) {
			throw new Error("Embedding API returned unexpected response shape");
		}

		return json;
	} finally {
		clearTimeout(timeout);
	}
}

function isValidEmbeddingResponse(value: unknown): value is EmbeddingApiResponse {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (!Array.isArray(v.data)) return false;
	if (typeof v.model !== "string") return false;
	return (v.data as Array<unknown>).every(
		(item: unknown) =>
			typeof item === "object" &&
			item !== null &&
			Array.isArray((item as Record<string, unknown>).embedding) &&
			typeof (item as Record<string, unknown>).index === "number",
	);
}

// ---------------------------------------------------------------------------
// EmbeddingGenerator
// ---------------------------------------------------------------------------

export class EmbeddingGenerator {
	#modelId: string;
	#dimension: number;
	#baseUrl?: string;
	#apiKey?: string;

	constructor(options?: { modelId?: string; baseUrl?: string; apiKey?: string }) {
		this.#modelId = options?.modelId ?? DEFAULT_EMBEDDING_MODEL;
		this.#dimension = getEmbeddingDimension(this.#modelId);
		this.#baseUrl = options?.baseUrl;
		this.#apiKey = options?.apiKey;
	}

	/**
	 * Initialize from a pi-ai Model object, resolving baseUrl and API key.
	 */
	static fromModel(model: Model): EmbeddingGenerator {
		const modelId = model.id;
		const apiKey = getEnvApiKey(model.provider) || "";
		// Derive baseUrl from model metadata or use OpenAI default
		let baseUrl: string | undefined;
		if ("baseUrl" in model && typeof model.baseUrl === "string") {
			baseUrl = model.baseUrl as string;
		}
		if (!baseUrl && model.provider === "openai") {
			baseUrl = "https://api.openai.com";
		}
		return new EmbeddingGenerator({ modelId, baseUrl, apiKey });
	}

	get dimension(): number {
		return this.#dimension;
	}

	get modelId(): string {
		return this.#modelId;
	}

	/**
	 * Generate a single embedding for a text.
	 */
	async embed(text: string): Promise<EmbeddingResult> {
		const batch = await this.embedBatch([text]);
		return {
			embedding: batch.embeddings[0],
			model: batch.model,
			usage: batch.usage,
		};
	}

	/**
	 * Generate embeddings for multiple texts in one API call.
	 */
	async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
		if (texts.length === 0) {
			return { embeddings: [], model: this.#modelId };
		}

		if (!this.#baseUrl || !this.#apiKey) {
			logger.debug("EmbeddingGenerator: no baseUrl/apiKey, returning zero vectors");
			return {
				embeddings: texts.map(() => new Float32Array(this.#dimension)),
				model: this.#modelId,
			};
		}

		try {
			const response = await callEmbeddingApi(this.#baseUrl, this.#apiKey, this.#modelId, texts);

			const embeddings = response.data
				.sort((a, b) => a.index - b.index)
				.map(item => new Float32Array(item.embedding));

			logger.debug("EmbeddingGenerator: batch complete", {
				count: embeddings.length,
				model: response.model,
				tokens: response.usage.total_tokens,
			});

			return {
				embeddings,
				model: response.model,
				usage: {
					promptTokens: response.usage.prompt_tokens,
					totalTokens: response.usage.total_tokens,
				},
			};
		} catch (err) {
			logger.warn("EmbeddingGenerator: API call failed, returning zero vectors", {
				error: String(err),
			});
			return {
				embeddings: texts.map(() => new Float32Array(this.#dimension)),
				model: this.#modelId,
			};
		}
	}

	/**
	 * Generate an embedding and store it directly in the vector store.
	 */
	async embedAndStore(
		store: import("./vector-store").VectorStore,
		id: string,
		namespace: string,
		content: string,
		metadata?: Record<string, unknown>,
	): Promise<Float32Array | undefined> {
		const result = await this.embed(content);
		if (result.embedding.every(v => v === 0)) {
			logger.debug("EmbeddingGenerator: zero vector, skipping store", { id, namespace });
			return undefined;
		}

		store.upsert({
			id,
			namespace,
			content,
			embedding: result.embedding,
			metadata,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		return result.embedding;
	}
}

/**
 * Convenience: create a zero vector of the given dimension.
 */
export function zeroVector(dimension: number): Float32Array {
	return new Float32Array(dimension);
}
