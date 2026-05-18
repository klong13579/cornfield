/**
 * Unified memory ops for `/evolution memory` and `/memory` (compat redirect).
 */
import type { Database } from "bun:sqlite";
import * as path from "node:path";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { getAgentDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { EmbeddingGenerator } from "./embedding";
import { clearMemoryData, enqueueMemoryConsolidation } from "./memory/index";
import { generateMemoryMd, loadSectionsFromDb } from "./memory/projection";
import { ensureMemorySummaryFromMemory } from "./memory/summary";
import { getMemoryRoot } from "./paths";
import { VectorStore } from "./vector-store";

export const EVOLUTION_MEMORY_SUBCOMMANDS = [
	{ name: "search", description: "Semantic search (vector + keyword fallback)" },
	{ name: "stats", description: "Vector embedding counts by namespace" },
	{ name: "report", description: "Show MEMORY.md-style report from DB sections" },
	{ name: "skills", description: "Graduated skills stored in memory index" },
	{ name: "view", description: "Show prompt injection payload (memory_summary)" },
	{ name: "enqueue", description: "Enqueue Phase2 memory consolidation" },
	{ name: "rebuild", description: "Alias for enqueue" },
	{ name: "refresh-summary", description: "Rebuild memory_summary.md from MEMORY.md" },
	{ name: "clear", description: "Clear memory DB rows and .omp/memory artifacts only" },
] as const;

export interface RunEvolutionMemoryOptions {
	db: Database;
	ctx: ExtensionCommandContext;
	args: string;
	globalStore: boolean;
	getEmbeddingGenerator?: () => EmbeddingGenerator | undefined;
}

export async function runEvolutionMemorySubcommand(opts: RunEvolutionMemoryOptions): Promise<void> {
	const trimmed = opts.args.trim();
	const parts = trimmed.split(/\s+/, 2);
	const sub = parts[0]?.toLowerCase() || "stats";
	const rest = parts.length > 1 ? parts.slice(1).join(" ").trim() : "";
	const agentDir = getAgentDir();
	const memoryRoot = getMemoryRoot(agentDir, opts.ctx.cwd, { globalStore: opts.globalStore });

	switch (sub) {
		case "search": {
			if (!rest) {
				opts.ctx.ui.notify("Usage: /evolution memory search <query>", "warning");
				return;
			}
			try {
				const gen = opts.getEmbeddingGenerator?.();
				if (gen) {
					const store = new VectorStore(opts.db);
					const { embedding } = await gen.embed(rest);
					if (embedding.some(v => v !== 0)) {
						const results = store.search(embedding, { minSimilarity: 0.2, limit: 10 });
						if (results.length > 0) {
							const lines = results.map(
								r =>
									`[${r.entry.namespace}] ${r.entry.content.slice(0, 120)} (${(r.similarity * 100).toFixed(0)}% match)`,
							);
							opts.ctx.ui.notify(lines.join("\n"), "info");
							return;
						}
					}
				}
				const rows = opts.db
					.prepare(
						"SELECT namespace, content FROM vec_embeddings WHERE content LIKE ? ORDER BY created_at DESC LIMIT 10",
					)
					.all(`%${rest}%`) as Array<{ namespace: string; content: string }>;
				if (rows.length === 0) {
					opts.ctx.ui.notify(`No results for "${rest}"`, "info");
					return;
				}
				const lines = rows.map(r => `[${r.namespace}] ${r.content.slice(0, 120)}`);
				opts.ctx.ui.notify(lines.join("\n"), "info");
			} catch (err) {
				logger.error("evolution memory search failed", { error: String(err) });
				opts.ctx.ui.notify(`Memory search failed: ${String(err)}`, "error");
			}
			break;
		}
		case "skills": {
			try {
				const sections = loadSectionsFromDb(opts.db);
				const skillsSection = sections.find(s => s.namespace === "skills");
				if (!skillsSection || skillsSection.entries.length === 0) {
					opts.ctx.ui.notify("No graduated skills in memory index", "info");
					return;
				}
				const lines = skillsSection.entries
					.sort((a, b) => b.importance - a.importance)
					.slice(0, 20)
					.map(e => `- ${e.content} (${(e.importance * 100).toFixed(0)}%)`);
				opts.ctx.ui.notify(lines.join("\n"), "info");
			} catch (err) {
				logger.error("evolution memory skills failed", { error: String(err) });
				opts.ctx.ui.notify(`Memory skills failed: ${String(err)}`, "error");
			}
			break;
		}
		case "report": {
			try {
				const sections = loadSectionsFromDb(opts.db);
				const md = generateMemoryMd(sections);
				opts.ctx.ui.notify(md.slice(0, 2000) + (md.length > 2000 ? "\n... (truncated)" : ""), "info");
			} catch (err) {
				logger.error("evolution memory report failed", { error: String(err) });
				opts.ctx.ui.notify(`Memory report failed: ${String(err)}`, "error");
			}
			break;
		}
		case "view": {
			try {
				const summaryPath = path.join(memoryRoot, "memory_summary.md");
				const text = (await Bun.file(summaryPath).text()).trim();
				if (!text) {
					opts.ctx.ui.notify(
						"memory_summary.md is empty. Try /evolution memory refresh-summary or enqueue.",
						"warning",
					);
					return;
				}
				opts.ctx.ui.notify(
					`## memory_summary (injected via memory://root/memory_summary.md)\n\n${text}`.slice(0, 2500) +
						(text.length > 2400 ? "\n... (truncated)" : ""),
					"info",
				);
			} catch (err) {
				if (isEnoent(err)) {
					opts.ctx.ui.notify(`No ${path.join(memoryRoot, "memory_summary.md")} yet.`, "warning");
					return;
				}
				logger.error("evolution memory view failed", { error: String(err) });
				opts.ctx.ui.notify(`Memory view failed: ${String(err)}`, "error");
			}
			break;
		}
		case "enqueue":
		case "rebuild": {
			try {
				enqueueMemoryConsolidation(agentDir, opts.ctx.cwd);
				opts.ctx.ui.notify("Memory consolidation enqueued (Phase2 runs on idle).", "info");
			} catch (err) {
				logger.error("evolution memory enqueue failed", { error: String(err) });
				opts.ctx.ui.notify(`Memory enqueue failed: ${String(err)}`, "error");
			}
			break;
		}
		case "refresh-summary": {
			try {
				const result = await ensureMemorySummaryFromMemory(memoryRoot);
				if (result.written) {
					opts.ctx.ui.notify(
						`Updated ${path.join(memoryRoot, "memory_summary.md")} (${result.length} chars, source: ${result.source}).`,
						"info",
					);
				} else {
					opts.ctx.ui.notify(
						`No change — MEMORY.md too short or missing (need ≥200 chars). Path: ${path.join(memoryRoot, "MEMORY.md")}`,
						"warning",
					);
				}
			} catch (err) {
				logger.error("evolution memory refresh-summary failed", { error: String(err) });
				opts.ctx.ui.notify(`Refresh summary failed: ${String(err)}`, "error");
			}
			break;
		}
		case "clear":
		case "reset": {
			const confirmed = await opts.ctx.ui.confirm(
				"Clear project memory",
				`Deletes memory DB rows and files under:\n${memoryRoot}\n\n(Evolution DB and skills are kept. Use /evolution clear for full reset.)`,
			);
			if (!confirmed) {
				opts.ctx.ui.notify("Cancelled", "info");
				return;
			}
			try {
				await clearMemoryData(agentDir, opts.ctx.cwd);
				opts.ctx.ui.notify(`Cleared memory data under ${memoryRoot}`, "info");
			} catch (err) {
				logger.error("evolution memory clear failed", { error: String(err) });
				opts.ctx.ui.notify(`Memory clear failed: ${String(err)}`, "error");
			}
			break;
		}
		default: {
			try {
				const store = new VectorStore(opts.db);
				const total = store.count();
				const nsStats = store.namespaceStats();
				const summaryPath = path.join(memoryRoot, "memory_summary.md");
				let summaryLen = 0;
				try {
					summaryLen = (await Bun.file(summaryPath).text()).trim().length;
				} catch {
					/* optional */
				}
				const lines = [
					`Vector embeddings: ${total}`,
					`memory_summary.md: ${summaryLen} chars`,
					`MEMORY.md: ${path.join(memoryRoot, "MEMORY.md")}`,
				];
				for (const r of nsStats) lines.push(`  ${r.namespace}: ${r.count}`);
				opts.ctx.ui.notify(lines.join("\n"), "info");
			} catch (err) {
				logger.error("evolution memory stats failed", { error: String(err) });
				opts.ctx.ui.notify(`Memory stats failed: ${String(err)}`, "error");
			}
			break;
		}
	}
}
