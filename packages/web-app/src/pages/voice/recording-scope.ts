/**
 * 听记的 scope 分桶（T10C）—— 纯函数。
 *
 * 听记库是**客户端级**的（`~/.cornfield/listen/`）：一个 Agent 的录音与另一个的躺在同一个目录里。
 * 所以「这条是谁的」只能看写入时标下的 provenance，而**没有 provenance 就是没有** ——
 * 旧记录（v1）不得被归给当前选中的 Agent（那会让另一个 bot 的录音出现在你的历史里）。
 *
 * 一条录音只进一个桶，按具体度优先：本会话 > 本 Agent > 本 Project > 其他（有标注但不属于本 scope）>
 * 未标注。判定用的都是等值比较，不做时间/路径推断。
 */

import type { ListenRecordingDto } from "@cornfield/wire";

/** 当前页面的 scope 锚点（来自 session view / agent registry，前端不自己拼）。 */
export interface RecordingScope {
	/** 焦点 Agent 的注册 id。 */
	agentId?: string;
	/** 焦点 Agent 的 home（CLI 写入的记录没有 agentId，只有 home）。 */
	agentDir?: string;
	/** 当前会话文件（服务端 attach 会话）。比较时做路径归一（分隔符/重复/trailing）。 */
	sessionFile?: string;
	/** 当前 Project。 */
	projectId?: string;
}

export type RecordingBucket = "session" | "agent" | "project" | "other" | "unlabeled";

export interface BucketedRecordings {
	bucket: RecordingBucket;
	label: string;
	recordings: ListenRecordingDto[];
}

export const RECORDING_BUCKET_LABELS: Record<RecordingBucket, string> = {
	session: "本会话",
	agent: "本 Agent",
	project: "本 Project",
	other: "其他 Agent/项目",
	unlabeled: "未标注（旧记录）",
};

/** 分桶顺序（展示顺序一致）：越具体的越靠前。 */
export const RECORDING_BUCKET_ORDER: RecordingBucket[] = ["session", "agent", "project", "other", "unlabeled"];

/** 一条录音进哪个桶。 */
export function bucketOf(recording: ListenRecordingDto, scope: RecordingScope): RecordingBucket {
	const provenance = recording.provenance;
	if (!provenance) return "unlabeled";
	// 路径比较先归一：同一份会话文件在不同写入方手里可能是 `/x//y/`、`\x\y` 或带尾随分隔符，
	// 字面量相等会把同一条录音判成「别的会话」（或反过来漏掉本会话）。
	if (scope.sessionFile && provenance.sessionFile && samePath(provenance.sessionFile, scope.sessionFile)) {
		return "session";
	}
	if (scope.agentId && provenance.agentId && provenance.agentId === scope.agentId) return "agent";
	if (scope.agentDir && provenance.agentDir && samePath(provenance.agentDir, scope.agentDir)) {
		return "agent";
	}
	if (scope.projectId && provenance.projectId && provenance.projectId === scope.projectId) return "project";
	return "other";
}

/** 分桶（空桶不出现；桶内保持传入顺序 —— listen_list 已是文件名倒序）。 */
export function bucketRecordings(
	recordings: readonly ListenRecordingDto[],
	scope: RecordingScope,
): BucketedRecordings[] {
	const buckets = new Map<RecordingBucket, ListenRecordingDto[]>();
	for (const recording of recordings) {
		const bucket = bucketOf(recording, scope);
		const list = buckets.get(bucket);
		if (list) list.push(recording);
		else buckets.set(bucket, [recording]);
	}
	return RECORDING_BUCKET_ORDER.filter(bucket => buckets.has(bucket)).map(bucket => ({
		bucket,
		label: RECORDING_BUCKET_LABELS[bucket],
		recordings: buckets.get(bucket)!,
	}));
}

/** 关键词过滤（文件名或转写全文；空关键词 = 不过滤）。 */
export function filterRecordings(
	recordings: readonly ListenRecordingDto[],
	search: string,
	bucket?: RecordingBucket,
	scope?: RecordingScope,
): ListenRecordingDto[] {
	const keyword = search.trim();
	return recordings.filter(recording => {
		if (bucket && scope && bucketOf(recording, scope) !== bucket) return false;
		if (!keyword) return true;
		return recording.name.includes(keyword) || recording.text.includes(keyword);
	});
}

/** 一条录音的 scope 说明文本（列表行上显示；未标注要说清楚，不要留白让人以为是当前的）。 */
export function recordingScopeLabel(recording: ListenRecordingDto): string {
	const provenance = recording.provenance;
	if (!provenance) return RECORDING_BUCKET_LABELS.unlabeled;
	if (provenance.agentId) return provenance.agentId;
	if (provenance.agentDir) return provenance.agentDir;
	if (provenance.sessionFile) return provenance.sessionFile.split("/").pop() ?? provenance.sessionFile;
	if (provenance.projectId) return provenance.projectId;
	return RECORDING_BUCKET_LABELS.unlabeled;
}

/** 路径是否指向同一个位置（比较用，非解析）：分隔符统一、折叠重复、去尾随。 */
function samePath(a: string, b: string): boolean {
	return normalizePath(a) === normalizePath(b);
}

function normalizePath(value: string): string {
	const unified = value.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
	return unified.length > 1 ? unified.replace(/\/+$/, "") : unified;
}
