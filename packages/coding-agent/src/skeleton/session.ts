/**
 * Session file path builder.
 *
 * Sessions are stored as `<agentDir>/sessions/cid_<safeConvId>.jsonl` per
 * `packages/agent/docs/agent-design-v1.md` §2. The `cid_` prefix and the
 * safeConvId transform are kept stable for backwards-compatibility with
 * existing gateways and tools that parse the path.
 */

import * as path from "node:path";

/**
 * Build the session file path for a given conversation inside `<agentDir>/sessions/`.
 *
 * `<conversationId>` is sanitized to `[A-Za-z0-9_-]` and truncated to 64 chars
 * to keep paths portable across filesystems.
 */
export function buildAgentSessionPath(agentDir: string, conversationId: string): string {
	const safeId = conversationId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	return path.join(agentDir, "sessions", `${safeId}.jsonl`);
}
