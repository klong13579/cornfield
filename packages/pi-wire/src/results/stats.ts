/**
 * get_stats 结果形状（W3 D1/D2）—— 对齐 omp-stats AggregatedStats。
 * 前端 DashboardStats 消费；wire-server serve 端产出同形状。
 */

/** 聚合行（overall/byModel/byFolder 共用形状，对齐 omp-stats AggregatedStats）。 */
export interface StatsAggregatedDto {
	totalRequests: number;
	successfulRequests: number;
	failedRequests: number;
	errorRate: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	cacheRate: number;
	totalCost: number;
	totalPremiumRequests: number;
	avgDuration: number | null;
	avgTtft: number | null;
	avgTokensPerSecond: number | null;
	firstTimestamp: number;
	lastTimestamp: number;
}

/** 按模型聚合行。 */
export interface StatsModelRowDto extends StatsAggregatedDto {
	model: string;
	provider: string;
}

/** 按目录聚合行。 */
export interface StatsFolderRowDto extends StatsAggregatedDto {
	folder: string;
}

/** 小时桶（timeSeries）。 */
export interface StatsTimePointDto {
	timestamp: number;
	requests: number;
	errors: number;
	tokens: number;
	cost: number;
}

/** 日桶请求数（modelSeries）。 */
export interface StatsModelSeriesPointDto {
	timestamp: number;
	model: string;
	provider: string;
	requests: number;
}

/** 日桶性能（modelPerformanceSeries）。 */
export interface StatsPerformancePointDto {
	timestamp: number;
	model: string;
	provider: string;
	requests: number;
	avgTtft: number | null;
	avgTokensPerSecond: number | null;
}

/** 日桶费用按模型分解（costSeries）。 */
export interface StatsCostPointDto {
	timestamp: number;
	model: string;
	provider: string;
	cost: number;
	costInput: number;
	costOutput: number;
	costCacheRead: number;
	costCacheWrite: number;
	requests: number;
}

/** 模型单价（美元 / 1M tokens；models.json 目录，查不到的模型不出现）。 */
export interface StatsPriceDto {
	provider: string;
	model: string;
	price: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** get_stats 响应（DashboardStats + priceCatalog）。 */
export interface DashboardStatsDto {
	overall: StatsAggregatedDto;
	byModel: StatsModelRowDto[];
	byFolder: StatsFolderRowDto[];
	timeSeries: StatsTimePointDto[];
	modelSeries: StatsModelSeriesPointDto[];
	modelPerformanceSeries: StatsPerformancePointDto[];
	costSeries: StatsCostPointDto[];
	/** 单价目录（models.json，仅含 byModel 出现的模型）。 */
	priceCatalog: StatsPriceDto[];
}

/** get_stats 时间窗口参数。 */
export type StatsPeriodDto = "1d" | "7d" | "30d" | "90d" | "all";
