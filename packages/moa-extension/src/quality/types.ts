export interface MoaQualityRoleWeights {
	required: number;
	planSubstance: number;
	openQuestions: number;
	assumptions: number;
	noRefusal: number;
}

export interface MoaQualityJudgeSettings {
	enabled: boolean;
	mode: "hybrid";
	model: string;
	grayMargin: number;
	timeoutMs: number;
	onError: "keep_heuristic";
}

export interface MoaQualitySettings {
	roleWeights?: Partial<Record<string, Partial<MoaQualityRoleWeights>>>;
	judge: MoaQualityJudgeSettings;
}

export interface WorkerQualityBreakdownV2 {
	weights: MoaQualityRoleWeights;
	hits: {
		required: number;
		planSubstance: number;
		openQuestions: number;
		assumptions: number;
		noRefusal: number;
	};
	contributions: {
		required: number;
		planSubstance: number;
		openQuestions: number;
		assumptions: number;
		noRefusal: number;
	};
}

export interface MoaQualityMeta {
	version: 2;
	heuristicScore: number;
	judgeScore?: number;
	source: "heuristic" | "judge";
	roleKey: string;
	contractHardFail: boolean;
	judged: boolean;
	judgeError?: string;
	breakdown?: WorkerQualityBreakdownV2;
}
