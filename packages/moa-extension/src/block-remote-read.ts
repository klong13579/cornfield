import type { ExtensionFactory } from "@cornfield/coding-agent";

/** True when `read` path targets a remote http(s) URL (not a local file). */
export function isRemoteReadPath(path: string): boolean {
	const p = path.trim();
	return /^https?:\/\//i.test(p);
}

/**
 * Extension that blocks `read` of http(s) URLs. Used for plan workers after
 * Research already gathered external evidence — local file reads still work.
 */
export function createBlockRemoteReadExtension(): ExtensionFactory {
	return pi => {
		pi.on("tool_call", async event => {
			if (event.toolName !== "read") return;
			const path = typeof event.input?.path === "string" ? event.input.path : "";
			if (!isRemoteReadPath(path)) return;
			return {
				block: true,
				reason:
					"Remote URL reads are disabled for MoA plan workers. Use the research_pack evidence; " +
					"record gaps under ## assumptions instead of fetching pages.",
			};
		});
	};
}
