/**
 * `/memory` compat — delegates to `/evolution memory`.
 */
import type { Database } from "bun:sqlite";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { EmbeddingGenerator } from "./embedding";
import { EVOLUTION_MEMORY_SUBCOMMANDS, runEvolutionMemorySubcommand } from "./evolution-memory";

export function registerMemoryCommands(
	api: ExtensionAPI,
	getDb: () => Database | undefined,
	getEmbeddingGenerator?: () => EmbeddingGenerator | undefined,
	getGlobalStore?: () => boolean,
): void {
	api.registerCommand("memory", {
		description: "Alias for /evolution memory (search, view, enqueue, clear, …)",
		getArgumentCompletions(argumentPrefix: string) {
			if (argumentPrefix.includes(" ")) return null;
			const lower = argumentPrefix.toLowerCase();
			return EVOLUTION_MEMORY_SUBCOMMANDS.filter(s => s.name.startsWith(lower)).map(s => ({
				value: `${s.name} `,
				label: s.name,
				description: s.description,
			}));
		},
		async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
			const db = getDb();
			if (!db) {
				ctx.ui.notify("Memory DB not available. Start a coding session first.", "error");
				return;
			}
			await runEvolutionMemorySubcommand({
				db,
				ctx,
				args,
				globalStore: getGlobalStore?.() ?? false,
				getEmbeddingGenerator,
			});
		},
	});
}
