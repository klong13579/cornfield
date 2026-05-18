import { logger } from "@oh-my-pi/pi-utils";

export interface ModelRouterConfig {
	defaultModel: string;
	cooldownMinutes: number; // Default: 30
	taskModelMap?: Record<string, string>; // taskType → modelName overrides
	userPreference?: string; // User's preferred model
}

export interface ModelSelection {
	model: string;
	reason: string;
	cooldownActive: boolean;
}

export class ModelRouter {
	#config: ModelRouterConfig;
	#lastFailures: Map<string, { count: number; lastFailedAt: number }> = new Map();
	#modelCooldowns: Map<string, number> = new Map(); // model → cooldown until timestamp

	constructor(config: ModelRouterConfig) {
		this.#config = { ...config, cooldownMinutes: config.cooldownMinutes ?? 30 };
	}

	selectModel(taskType: string): ModelSelection {
		// 1. User preference always wins
		if (this.#config.userPreference) {
			const pref = this.#config.userPreference;
			if (!this.isInCooldown(pref)) {
				return { model: pref, reason: "user preference", cooldownActive: false };
			}
		}

		// 2. Task-type specific mapping
		if (this.#config.taskModelMap?.[taskType]) {
			const mapped = this.#config.taskModelMap[taskType];
			if (!this.isInCooldown(mapped)) {
				return { model: mapped, reason: `task mapping: ${taskType}`, cooldownActive: false };
			}
		}

		// 3. Default model with cooldown check
		const inCooldown = this.isInCooldown(this.#config.defaultModel);
		return {
			model: this.#config.defaultModel,
			reason: inCooldown ? "default (model in cooldown)" : "default",
			cooldownActive: inCooldown,
		};
	}

	recordFailure(model: string): void {
		const entry = this.#lastFailures.get(model) ?? { count: 0, lastFailedAt: 0 };
		entry.count++;
		entry.lastFailedAt = Date.now();
		this.#lastFailures.set(model, entry);

		if (entry.count >= 3) {
			this.applyCooldown(model);
		}
	}

	recordSuccess(model: string): void {
		const entry = this.#lastFailures.get(model);
		if (entry) {
			entry.count = Math.max(0, entry.count - 1);
			if (entry.count === 0) {
				this.#lastFailures.delete(model);
			}
		}
	}

	applyCooldown(model: string, minutes?: number): void {
		const duration = (minutes ?? this.#config.cooldownMinutes) * 60 * 1000;
		this.#modelCooldowns.set(model, Date.now() + duration);
		logger.warn("Model cooldown applied", { model, durationMs: duration });
	}

	isInCooldown(model: string): boolean {
		const until = this.#modelCooldowns.get(model);
		if (!until) return false;
		if (Date.now() >= until) {
			this.#modelCooldowns.delete(model);
			return false;
		}
		return true;
	}

	clearCooldown(model: string): void {
		this.#modelCooldowns.delete(model);
	}

	setUserPreference(model: string | undefined): void {
		this.#config.userPreference = model;
	}

	getFailureCount(model: string): number {
		return this.#lastFailures.get(model)?.count ?? 0;
	}
}
