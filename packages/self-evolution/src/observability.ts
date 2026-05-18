import { logger } from "@oh-my-pi/pi-utils";

export type ObservationEventType =
	| "skill_extracted"
	| "skill_deprecated"
	| "convention_added"
	| "convention_violated"
	| "population_transition"
	| "error_threshold_exceeded";

export interface ObservationEvent {
	type: ObservationEventType;
	timestamp: number;
	data: Record<string, unknown>;
}

export type Observer = (event: ObservationEvent) => void;

export class ObservationBus {
	#observers: Observer[] = [];

	subscribe(observer: Observer): () => void {
		this.#observers.push(observer);
		return () => {
			const idx = this.#observers.indexOf(observer);
			if (idx >= 0) this.#observers.splice(idx, 1);
		};
	}

	emit(type: ObservationEventType, data: Record<string, unknown>): void {
		const event: ObservationEvent = { type, timestamp: Date.now(), data };
		for (const observer of this.#observers) {
			try {
				observer(event);
			} catch (err) {
				logger.warn("Observation observer failed", { error: String(err) });
			}
		}
	}
}

// Singleton instance
let defaultBus: ObservationBus | undefined;

export function getObservationBus(): ObservationBus {
	if (!defaultBus) defaultBus = new ObservationBus();
	return defaultBus;
}
