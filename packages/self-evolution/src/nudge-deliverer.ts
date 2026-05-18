/**
 * NudgeDeliverer: formats and delivers nudge messages to the user.
 */
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { formatNudgeContextContent } from "./nudge-context-injector";
import type { Nudge } from "./types";

export class NudgeDeliverer {
	format(nudge: Nudge): string {
		return formatNudgeContextContent(nudge);
	}

	deliver(nudge: Nudge, ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.notify(
			`[Nudge: ${nudge.type}] ${nudge.message} (full guidance added to agent context)`,
			nudge.severity === "warn" ? "warning" : "info",
		);
	}
}
