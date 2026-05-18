import type {
	ModelStatsAggregate,
	SessionModelStats,
	SqliteSessionModelStatsStore,
} from "./storage/session-model-stats";

export class ModelEvaluator {
	#statsStore: SqliteSessionModelStatsStore;

	constructor(statsStore: SqliteSessionModelStatsStore) {
		this.#statsStore = statsStore;
	}

	async recordSession(stats: SessionModelStats): Promise<void> {
		await this.#statsStore.insert(stats);
	}

	async getModelStats(modelName: string): Promise<ModelStatsAggregate> {
		return this.#statsStore.getAggregates(modelName);
	}

	async getAllStats(): Promise<ModelStatsAggregate> {
		return this.#statsStore.getAggregates();
	}
}
