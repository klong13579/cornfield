import type {
	Episode,
	EpisodeEffectiveness,
	EpisodeIntent,
	EvolvedSkill,
	NudgeRecord,
	SkillEffectiveness,
	SkillVersion,
	UserProfile,
	WorkflowPattern,
} from "../types";

export interface EpisodeStore {
	insert(episode: Episode): Promise<void>;
	listRecent(limit: number): Promise<Episode[]>;
	searchByKeyword(query: string, limit: number): Promise<Episode[]>;
	searchFailedByKeyword(query: string, limit: number): Promise<Episode[]>;
	deleteOld(keepCount: number): Promise<number>;
	count(): Promise<number>;
}

export interface SkillStore {
	get(name: string): Promise<EvolvedSkill | undefined>;
	list(filter?: { deprecated?: boolean }): Promise<EvolvedSkill[]>;
	upsert(skill: EvolvedSkill): Promise<void>;
	delete(name: string): Promise<void>;
	count(): Promise<number>;
}

export interface SkillVersionStore {
	record(version: SkillVersion): Promise<void>;
	getHistory(name: string): Promise<SkillVersion[]>;
	getSpecific(name: string, version: number): Promise<SkillVersion | undefined>;
	prune(name: string, keepCount: number): Promise<number>;
	count(): Promise<number>;
}

export interface StatsStore {
	get(key: string): Promise<number>;
	increment(key: string, delta?: number): Promise<void>;
}

export interface IntentStore {
	insert(intent: EpisodeIntent): Promise<void>;
	getByEpisode(episodeId: string): Promise<EpisodeIntent[]>;
	getByIntent(intent: string, limit: number): Promise<EpisodeIntent[]>;
}

export interface WorkflowPatternStore {
	upsert(pattern: WorkflowPattern): Promise<void>;
	getByIntent(intent: string, limit: number): Promise<WorkflowPattern[]>;
	getById(id: string): Promise<WorkflowPattern | undefined>;
	listAll(): Promise<WorkflowPattern[]>;
}

export interface ProfileStore {
	get(id: string): Promise<UserProfile | undefined>;
	upsert(id: string, profile: UserProfile): Promise<void>;
}

export interface EffectivenessStore {
	get(episodeId: string): Promise<EpisodeEffectiveness | undefined>;
	getMany(episodeIds: string[]): Promise<EpisodeEffectiveness[]>;
	recordInjection(episodeId: string): Promise<void>;
	recordOutcome(episodeId: string, helped: boolean): Promise<void>;
}
export interface SkillEffectivenessStore {
	get(skillName: string): Promise<SkillEffectiveness | undefined>;
	recordInjection(skillName: string): Promise<void>;
	recordOutcome(skillName: string, succeeded: boolean): Promise<void>;
}

export interface NudgeOutcomeUpdate {
	postToolCalls: number;
	patternRepeated: boolean;
	outcomeScore: number;
}

export interface NudgeHistoryStore {
	insert(record: NudgeRecord): Promise<void>;
	get(id: string): Promise<NudgeRecord | undefined>;
	listRecent(limit: number): Promise<NudgeRecord[]>;
	listByType(type: string, limit: number): Promise<NudgeRecord[]>;
	countByType(type: string, since: number): Promise<number>;
	acknowledge(id: string): Promise<void>;
	dismiss(id: string): Promise<void>;
	markContextInjected(ids: string[], injectedAt: number): Promise<void>;
	recordOutcome(id: string, update: NudgeOutcomeUpdate): Promise<void>;
	listUnscoredInjectedForSession(sessionId: string): Promise<import("../types").NudgeRecord[]>;
}

export interface DetailedOutcomeStore {
	record(outcome: import("../types").InjectionOutcome): Promise<void>;
	get(episodeId: string): Promise<import("../types").InjectionOutcome | undefined>;
	listRecent(limit: number): Promise<import("../types").InjectionOutcome[]>;
}

export interface FitScoreStore {
	upsert(record: import("../types").FitScoreRecord): Promise<void>;
	get(date: string): Promise<import("../types").FitScoreRecord | undefined>;
	getLast(): Promise<import("../types").FitScoreRecord | undefined>;
	listRecent(limit: number): Promise<import("../types").FitScoreRecord[]>;
}
export interface EpisodeDiagnosisStore {
	insert(diagnosis: import("../types").ToolChainDiagnosis): Promise<void>;
	get(episodeId: string): Promise<import("../types").ToolChainDiagnosis | undefined>;
	listRecent(limit: number): Promise<import("../types").ToolChainDiagnosis[]>;
	listByEpisodeIds(episodeIds: string[]): Promise<import("../types").ToolChainDiagnosis[]>;
	count(): Promise<number>;
	deleteOld(keepCount: number): Promise<number>;
}
export interface RegressionFixtureStore {
	insert(fixture: import("../types").RegressionFixture): Promise<void>;
	listRecent(limit: number): Promise<import("../types").RegressionFixture[]>;
	listForErrorTool(tool: string | undefined, limit: number): Promise<import("../types").RegressionFixture[]>;
}

export interface RegressionTrialStore {
	insert(trial: import("../types").RegressionTrial): Promise<void>;
	listRecent(limit: number): Promise<import("../types").RegressionTrial[]>;
}

export interface SessionTraceStore {
	upsert(trace: import("../types").SessionTrace, episodeId: string): Promise<void>;
	getBySessionId(sessionId: string): Promise<import("../types").SessionTrace | undefined>;
}

export interface SkillPopulationStore {
	insert(record: import("../types").SkillPopulationRecord): Promise<void>;
	get(name: string): Promise<import("../types").SkillPopulationRecord | undefined>;
	list(filter?: {
		state?: import("../types").SkillPopulationState;
		minScore?: number;
	}): Promise<import("../types").SkillPopulationRecord[]>;
	update(record: import("../types").SkillPopulationRecord): Promise<void>;
	delete(name: string): Promise<void>;
	transitionState(
		name: string,
		newState: import("../types").SkillPopulationState,
		reason: string,
		score: number,
	): Promise<void>;
	countByState(state: import("../types").SkillPopulationState): Promise<number>;
}
