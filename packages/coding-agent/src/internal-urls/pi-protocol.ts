/**
 * Protocol handler for pi:// URLs.
 *
 * Serves statically embedded documentation files bundled at build time.
 *
 * URL forms:
 * - pi:// - Lists all available documentation files
 * - pi://<file>.md - Reads a specific documentation file
 */
import * as path from "node:path";
import type * as DocsIndexModule from "./docs-index.generated";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

/**
 * The embedded docs index is ~1.6MB of generated source, and only `pi://` reads
 * need it. A static import put it in the boot graph of *every* process —
 * measured 2026-09-19: each cornfield process materialises the same 2348 module
 * records (54MB) whether it is an interactive session, a plain agent process or
 * a gateway child that never reads a doc. Loaded on first use instead.
 *
 * The type comes from a type-only import, which is erased at transpile time and
 * therefore costs no module record of its own.
 */
type DocsIndex = {
	EMBEDDED_DOC_FILENAMES: typeof DocsIndexModule.EMBEDDED_DOC_FILENAMES;
	EMBEDDED_DOCS: typeof DocsIndexModule.EMBEDDED_DOCS;
};

let docsIndexPromise: Promise<DocsIndex> | undefined;

function loadDocsIndex(): Promise<DocsIndex> {
	docsIndexPromise ??= import("./docs-index.generated");
	return docsIndexPromise;
}

/**
 * Handler for pi:// URLs.
 *
 * Resolves documentation file names to their content, or lists available docs.
 */
export class PiProtocolHandler implements ProtocolHandler {
	readonly scheme = "pi";
	readonly immutable = true;

	async resolve(url: InternalUrl): Promise<InternalResource> {
		// Extract filename from host + path
		const host = url.rawHost || url.hostname;
		const pathname = url.rawPathname ?? url.pathname;
		const filename = host ? (pathname && pathname !== "/" ? host + pathname : host) : "";

		if (!filename) {
			return this.#listDocs(url);
		}

		return this.#readDoc(filename, url);
	}

	async #listDocs(url: InternalUrl): Promise<InternalResource> {
		const { EMBEDDED_DOC_FILENAMES } = await loadDocsIndex();
		if (EMBEDDED_DOC_FILENAMES.length === 0) {
			throw new Error("No documentation files found");
		}

		const listing = EMBEDDED_DOC_FILENAMES.map(f => `- [${f}](pi://${f})`).join("\n");
		const content = `# Documentation\n\n${EMBEDDED_DOC_FILENAMES.length} files available:\n\n${listing}\n`;

		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
		};
	}

	async #readDoc(filename: string, url: InternalUrl): Promise<InternalResource> {
		// Validate: no traversal, no absolute paths
		if (path.isAbsolute(filename)) {
			throw new Error("Absolute paths are not allowed in pi:// URLs");
		}

		const normalized = path.posix.normalize(filename.replaceAll("\\", "/"));
		if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
			throw new Error("Path traversal (..) is not allowed in pi:// URLs");
		}

		const { EMBEDDED_DOCS, EMBEDDED_DOC_FILENAMES } = await loadDocsIndex();
		const content = EMBEDDED_DOCS[normalized];
		if (content === undefined) {
			const lookup = normalized.replace(/\.md$/, "");
			const suggestions = EMBEDDED_DOC_FILENAMES.filter(
				f => f.includes(lookup) || lookup.includes(f.replace(/\.md$/, "")),
			).slice(0, 5);
			const suffix =
				suggestions.length > 0
					? `\nDid you mean: ${suggestions.join(", ")}`
					: "\nUse pi:// to list available files.";
			throw new Error(`Documentation file not found: ${filename}${suffix}`);
		}

		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
		};
	}
}
