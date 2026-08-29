/**
 * AgentHub - live agent roster overlay (Alt+A).
 *
 * Shows every agent registered in the process registry — the main session
 * plus all subagents — with status, current activity, and freshness, sorted
 * so busy agents float to the top. A detail footer on the selected row shows
 * identity (parent, session file, model role) and any persisted artifacts.
 *
 * Read-only by design: messaging is covered by `irc`, async-job control by
 * `job`, and killing/reviving agents belongs to a human operator (or the
 * future orchestration layer). It subscribes to registry changes so the
 * roster stays live while the panel is open.
 */

import type { Component } from "@cornfield/tui";
import { Container, matchesKey, replaceTabs, Text } from "@cornfield/tui";
import { formatAge } from "@cornfield/utils";
import { type AgentRef, AgentRegistry } from "../../registry/agent-registry";
import { type ThemeColor, theme } from "../theme/theme";

const STATUS_ORDER: Record<string, number> = { running: 0, idle: 1, parked: 2, aborted: 3 };

interface RosterRow {
	ref: AgentRef;
	statusLabel: string;
	color: ThemeColor;
}

function buildRows(registry: AgentRegistry): RosterRow[] {
	return registry
		.list()
		.sort((a, b) => {
			const orderA = STATUS_ORDER[a.status] ?? 9;
			const orderB = STATUS_ORDER[b.status] ?? 9;
			if (orderA !== orderB) return orderA - orderB;
			return (b.lastActivity ?? 0) - (a.lastActivity ?? 0);
		})
		.map(ref => {
			switch (ref.status) {
				case "running":
					return { ref, statusLabel: "▶", color: "success" };
				case "idle":
					return { ref, statusLabel: "○", color: "muted" };
				case "parked":
					return { ref, statusLabel: "◌", color: "dim" };
				default:
					return { ref, statusLabel: "✕", color: "error" };
			}
		});
}

export class AgentHub extends Container {
	#registry: AgentRegistry;
	#rows: RosterRow[] = [];
	#selectedIndex = 0;
	#scrollOffset = 0;
	#unsubscribe: (() => void) | null = null;

	onClose?: () => void;
	onRequestRender?: () => void;

	private constructor(registry: AgentRegistry) {
		super();
		this.#registry = registry;
	}

	static create(registry: AgentRegistry = AgentRegistry.global()): AgentHub {
		const hub = new AgentHub(registry);
		hub.#refresh();
		hub.#unsubscribe = registry.onChange(() => hub.#refresh());
		return hub;
	}

	async dispose(): Promise<void> {
		this.#unsubscribe?.();
		this.#unsubscribe = null;
	}

	#refresh(): void {
		this.#rows = buildRows(this.#registry);
		this.#clampSelection();
		this.#buildLayout();
		this.onRequestRender?.();
	}

	#clampSelection(): void {
		if (this.#selectedIndex >= this.#rows.length) {
			this.#selectedIndex = Math.max(0, this.#rows.length - 1);
		}
	}

	#buildLayout(): void {
		this.clear();
		const width = process.stdout.columns ?? 80;
		const height = process.stdout.rows ?? 24;

		const stats = this.#statsLine();
		const headerLine = `  Agent Hub   ${stats}   (↑↓/jk select · r refresh · esc close)`;
		this.addChild(new Text(theme.bold(theme.fg("accent", replaceTabs(headerLine))), 0, 0));

		const bodyLines: string[] = [];
		const windowRows = height - 8;
		for (let i = this.#scrollOffset; i < Math.min(this.#rows.length, this.#scrollOffset + windowRows); i++) {
			const row = this.#rows[i];
			const ref = row.ref;
			const age = ref.lastActivity ? formatAge((Date.now() - ref.lastActivity) / 1000) : "n/a";
			const activity = ref.activity ? ` — ${ref.activity}` : "";
			const kind = ref.kind === "main" ? "" : ` [${ref.kind}]`;
			const marker = i === this.#selectedIndex ? "▸ " : "  ";
			const styled = theme.fg(row.color, `${marker}${row.statusLabel} ${ref.id}${kind} · ${age}${activity}`);
			bodyLines.push(i === this.#selectedIndex ? theme.bold(styled) : styled);
		}
		if (bodyLines.length === 0) {
			bodyLines.push(theme.fg("muted", "(no agents registered)"));
		}
		this.addChild(new Text(bodyLines.join("\n"), 0, 0));

		const detail = this.#detailLines();
		if (detail) {
			this.addChild(new Text(theme.fg("muted", replaceTabs(detail)), 0, 0));
		}

		void width;
	}

	#statsLine(): string {
		const total = this.#rows.length;
		const running = this.#rows.filter(r => r.ref.status === "running").length;
		const idle = this.#rows.filter(r => r.ref.status === "idle").length;
		return `${total} agents · ${running} running · ${idle} idle`;
	}

	#detailLines(): string {
		const row = this.#rows[this.#selectedIndex];
		if (!row) return "";
		const ref = row.ref;
		const parts: string[] = [];
		parts.push(`${ref.id} · ${ref.displayName} · ${ref.kind} · ${ref.status}`);
		if (ref.parentId) parts.push(`parent: ${ref.parentId}`);
		if (ref.sessionFile) parts.push(`session: ${ref.sessionFile}`);
		if (ref.history?.modelRole) parts.push(`role: ${ref.history.modelRole}`);
		if (ref.history?.resolvedModel) parts.push(`model: ${ref.history.resolvedModel}`);
		if (ref.history?.metrics) {
			parts.push(
				`tok: ${ref.history.metrics.tokens} · req: ${ref.history.metrics.requests} · cost: $${ref.history.metrics.cost.toFixed(4)}`,
			);
		}
		if (ref.history?.outputPath) parts.push(`output: ${ref.history.outputPath}`);
		return parts.join("  |  ");
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "esc")) {
			this.onClose?.();
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			if (this.#selectedIndex > 0) {
				this.#selectedIndex--;
				this.#ensureVisible();
				this.#refresh();
			}
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			if (this.#selectedIndex < this.#rows.length - 1) {
				this.#selectedIndex++;
				this.#ensureVisible();
				this.#refresh();
			}
			return;
		}
		if (matchesKey(data, "ctrl+r") || data === "r") {
			this.#refresh();
		}
	}

	#ensureVisible(): void {
		const windowRows = (process.stdout.rows ?? 24) - 8;
		if (this.#selectedIndex < this.#scrollOffset) {
			this.#scrollOffset = this.#selectedIndex;
		} else if (this.#selectedIndex >= this.#scrollOffset + windowRows) {
			this.#scrollOffset = this.#selectedIndex - windowRows + 1;
		}
	}
}

/** Type guard so callers can share the Component surface. */
export function isAgentHub(component: Component): component is AgentHub {
	return component instanceof AgentHub;
}
