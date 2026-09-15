/**
 * Types for the internal URL routing system.
 *
 * Internal URLs (agent://, artifact://, memory://, skill://, rule://, mcp://, pi://, local://) are resolved by tools like read,
 * providing access to agent outputs and server resources without exposing filesystem paths.
 */

/**
 * Resolved internal resource returned by protocol handlers.
 */
export interface InternalResource {
	/** Canonical URL that was resolved */
	url: string;
	/** Resolved text content */
	content: string;
	/** MIME type: text/markdown, application/json, or text/plain */
	contentType: "text/markdown" | "application/json" | "text/plain";
	/** Content size in bytes */
	size?: number;
	/** Underlying filesystem path (for debugging, not exposed to agent) */
	sourcePath?: string;
	/**
	 * True when the resource is a directory listing rather than file content.
	 * `content` is empty in that case; callers that need the entries render them
	 * from `sourcePath` (see the read tool's dirent listing).
	 */
	isDirectory?: boolean;
	/**
	 * True when the resource has no edit path (the router copies it from the
	 * handler). Callers use it to suppress edit affordances — a hashline anchor
	 * that no edit tool can consume only invites an edit that must fail.
	 * Set per resource only to override the handler's answer.
	 */
	immutable?: boolean;
	/** Additional notes about resolution */
	notes?: string[];
}

/**
 * Parsed internal URL with preserved host casing.
 */
export interface InternalUrl extends URL {
	/**
	 * Raw host segment extracted from input, preserving case.
	 */
	rawHost: string;
	/**
	 * Raw pathname extracted from input, preserving traversal markers before URL normalization.
	 */
	rawPathname?: string;
}

/**
 * Handler for a specific internal URL scheme (e.g., agent://, memory://, skill://, mcp://).
 */
export interface ProtocolHandler {
	/** The scheme this handler processes (without trailing ://) */
	readonly scheme: string;
	/**
	 * Whether resources from this handler can be edited by the agent. `false`
	 * only for handlers that address a writable file (local://); read-only
	 * handlers declare `true` so the read tool stops minting hashline anchors
	 * that no edit path could consume. Required: a new handler must answer.
	 */
	readonly immutable: boolean;
	/**
	 * Resolve an internal URL to its content.
	 * @param url Parsed URL object
	 * @throws Error with user-friendly message if resolution fails
	 */
	resolve(url: InternalUrl): Promise<InternalResource>;
}
