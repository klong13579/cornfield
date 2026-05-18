/**
 * Model recommendation hint UI component (Phase 5.6).
 *
 * Renders model selection info and cooldown status for display in the agent TUI.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRouter } from "../model-router";

export interface ModelRecommendationOptions {
	router: ModelRouter;
	taskType?: string;
	currentModel?: string;
	showCooldowns?: boolean;
}

export interface ModelStatusLine {
	/** Current model name */
	currentModel: string;
	/** Why this model was selected */
	reason: string;
	/** Whether the current model is in cooldown */
	inCooldown: boolean;
	/** Number of recent failures for current model */
	failureCount: number;
	/** Cooldown remaining in minutes (-1 if not in cooldown) */
	cooldownMinutesRemaining: number;
	/** Cooldown models (other than current) */
	cooldownModels: string[];
}

/**
 * Build a structured model status for rendering.
 */
export function getModelStatus(
	router: ModelRouter,
	options: { taskType?: string; currentModel?: string } = {},
): ModelStatusLine {
	const taskType = options.taskType ?? "general";
	const selection = router.selectModel(taskType);

	const inCooldown = router.isInCooldown(selection.model);
	const failureCount = router.getFailureCount(selection.model);

	// Check all tracked cooldowns for other models
	const cooldownModels: string[] = [];
	if (selection.model !== options.currentModel && router.isInCooldown(options.currentModel ?? "")) {
		cooldownModels.push(options.currentModel!);
	}

	return {
		currentModel: selection.model,
		reason: selection.reason,
		inCooldown,
		failureCount,
		cooldownMinutesRemaining: -1,
		cooldownModels,
	};
}

/**
 * Format a compact model recommendation badge.
 *
 * Example output: "claude-sonnet-4 (task: refactoring) ⚠3 fails"
 */
export function formatModelBadge(status: ModelStatusLine): string {
	const parts: string[] = [status.currentModel];

	if (status.reason !== "default") {
		parts.push(`(${status.reason})`);
	}

	if (status.inCooldown) {
		parts.push("[cooldown]");
	}

	if (status.failureCount > 0) {
		parts.push(`${status.failureCount} fail(s)`);
	}

	return parts.join(" ");
}

/**
 * Format a full model recommendation hint for display as a notification.
 */
export function formatModelHint(status: ModelStatusLine): string {
	const lines: string[] = [];
	lines.push(`Model: ${status.currentModel}`);
	lines.push(`  Reason: ${status.reason}`);

	if (status.inCooldown) {
		lines.push(`  Status: In cooldown`);
	}
	if (status.failureCount > 0) {
		lines.push(`  Recent failures: ${status.failureCount}`);
	}
	if (status.cooldownModels.length > 0) {
		lines.push(`  Cooldown models: ${status.cooldownModels.join(", ")}`);
	}

	return lines.join("\n");
}

logger.debug("Model recommendation component loaded");
