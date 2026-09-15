import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type {
	MemoryFileZoneDto,
	MemoryProjectionDto,
	MemoryScope,
	MemorySessionZoneDto,
	MemoryTextFileDto,
} from "../../lib/pi-client-api";
import { activeAgentIdOf } from "../../state/agent-context";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";

/**
 * 记忆工作台（T10B）—— 按**真实 scope** 分区，每个区都说清「从哪读的、什么时候更新的」：
 *
 *   Agent 记忆     Agent 自己的 home：WP1 声明的记忆目录（declared）+ 旧版 agentDir/memories 列布局
 *   Project 记忆   会话所在 Project 的 canonical 记忆根（+ 旧版回落）
 *   Session 记忆   本会话在记忆管线里的 stage-1 输出（按会话文件取，未沉淀 = pending）
 *   User 记忆      ~/.cornfield/user.md（身份画像，跨 Project）
 *   记忆库         self-evolution vector_embeddings（全局库，跨 Project）
 *
 * 三条不能混的语义（旧实现全混成「空态」）：
 *   读不到 ≠ 没内容：每个区带 error，读失败按红色错误显示；
 *   没沉淀 ≠ 空记忆：session 区 pending 是「管线还没处理过这个会话」；
 *   不适用 ≠ 没有：区为 null 时说明原因，不显示成「空」。
 *
 * 换 Agent 必须重读：投影锚在焦点 Agent（activeAgentIdOf）上。
 */

const SCOPE_LABELS: Record<MemoryScope, string> = {
	user: "用户记忆",
	agent: "Agent 记忆",
	project: "Project 记忆",
	session: "Session 记忆",
	global: "记忆库",
};

function fmtImportance(n: number): string {
	return `${Math.round(n * 100)}%`;
}

function fmtDate(ts: number): string {
	return new Date(ts).toISOString().slice(0, 10);
}

/** mtime → 本地日期（无时间就说没有，不编）。 */
function fmtUpdatedAt(ts: number | undefined): string | null {
	if (ts === undefined) return null;
	const date = new Date(ts);
	if (Number.isNaN(date.getTime())) return null;
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function MemoryView(): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const agentId = activeAgentIdOf(view);
	const [memory, setMemory] = useState<MemoryProjectionDto | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [reloading, setReloading] = useState(false);

	const load = async (): Promise<void> => {
		setReloading(true);
		try {
			const result = await store.fetchMemory(agentId);
			setMemory(result);
			setError(null);
		} catch (err) {
			setMemory(null);
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setReloading(false);
		}
	};

	useEffect(() => {
		if (!view.connected) {
			setMemory(null);
			return;
		}
		void load();
	}, [store, view.connected, agentId]);

	return (
		<div className="px-10 pt-8 pb-12">
			<div className="mx-auto max-w-[1000px]">
				<div className="mb-7 flex items-center justify-between gap-4">
					<h1 className="text-[32px] font-semibold tracking-[-0.8px] text-ink">记忆</h1>
					<button
						type="button"
						className="cbtn"
						onClick={() => void load()}
						disabled={!view.connected || reloading}
						aria-label="重读记忆投影"
						title="重读记忆投影"
					>
						<RefreshCw size={13} strokeWidth={1.5} />
					</button>
				</div>

				{!view.connected && (
					<div className="py-20 text-center text-[13px] text-ink-faint">未连接——记忆投影不可用</div>
				)}
				{error && <div className="py-20 text-center text-[13px] text-ink-faint">记忆不可用：{error}</div>}
				{view.connected && !error && !memory && (
					<div className="py-20 text-center text-[13px] text-ink-faint">加载记忆投影…</div>
				)}

				{memory && !error && (
					<div className="space-y-8">
						{/* 锚点：这份投影是「谁的、按哪个会话根算的」。 */}
						<ResolutionCard memory={memory} />

						<FileZoneCard zone={memory.agent} scope="agent" emptyHint="Agent 记忆尚未生成" />
						<FileZoneCard zone={memory.project} scope="project" emptyHint="项目记忆尚未生成" />
						<SessionZoneCard zone={memory.session} />
						<UserZoneCard file={memory.user} error={memory.userError} />
						<MemoryStoreCard memory={memory} />
					</div>
				)}
			</div>
		</div>
	);
}

/** 投影锚点 + 说明（某个区为什么不可计算）。 */
function ResolutionCard({ memory }: { memory: MemoryProjectionDto }): React.JSX.Element {
	const { resolution } = memory;
	return (
		<div className="rounded-lg border border-hairline bg-surface px-5 py-3">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-3xs text-ink-faint">
				<span>
					Agent <b className="text-ink-subtle">{resolution.agentId}</b>
				</span>
				<span className="truncate" title={resolution.agentDir}>
					agentDir {resolution.agentDir}
				</span>
				<span className="truncate" title={resolution.sessionCwd}>
					会话根 {resolution.sessionCwd}
				</span>
				<span className="truncate" title={resolution.projectRoot ?? ""}>
					Project {resolution.projectRoot ?? "未归属"}
				</span>
				<span>{resolution.sessionFile ? "已挂会话" : "会话未 attach"}</span>
			</div>
			{resolution.notes.length > 0 && (
				<div className="mt-2 space-y-0.5">
					{resolution.notes.map(note => (
						<div key={note} className="text-2xs text-ink-subtle">
							· {note}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function SectionCard({
	title,
	subtitle,
	children,
	tone,
}: {
	title: string;
	subtitle?: string;
	children: React.ReactNode;
	tone?: "error";
}): React.JSX.Element {
	return (
		<div className={`rounded-lg border bg-surface ${tone === "error" ? "border-danger/30" : "border-hairline"}`}>
			<div className="flex items-baseline justify-between px-5 pt-4 pb-2">
				<div className="section-title text-ink-faint">{title}</div>
				{subtitle && <div className="font-mono text-[11px] text-ink-faint">{subtitle}</div>}
			</div>
			{children}
		</div>
	);
}

/** 读失败不是空：有 error 就显示错误，不给空态。 */
function ZoneError({ error }: { error: string }): React.JSX.Element {
	return (
		<div className="px-5 pb-5">
			<div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger">{error}</div>
		</div>
	);
}

function FileBlock({ label, file }: { label: string; file: MemoryTextFileDto }): React.JSX.Element {
	const updated = fmtUpdatedAt(file.updatedAt);
	return (
		<div className="px-5 pb-4">
			<div className="mb-1 flex items-baseline justify-between">
				<div className="text-xs font-semibold text-ink">{label}</div>
				<div className="font-mono text-3xs text-ink-faint">
					{file.path.split("/").pop()}
					{file.truncated ? "（128KB 截断）" : ""}
					{updated ? ` · 更新 ${updated}` : ""}
				</div>
			</div>
			<pre className="max-h-72 overflow-auto rounded-md border border-hairline bg-surface-2 px-3 py-2.5 font-mono text-2xs leading-relaxed whitespace-pre-wrap text-ink-subtle">
				{file.content}
			</pre>
		</div>
	);
}

/** 目录型 zone（agent / project / user）：根 + 三份投影文件 + 读失败。 */
function FileZoneCard({
	zone,
	scope,
	emptyHint,
}: {
	zone: MemoryFileZoneDto | null;
	scope: MemoryScope;
	emptyHint: string;
}): React.JSX.Element {
	const title = SCOPE_LABELS[scope];
	if (!zone) {
		return (
			<SectionCard title={title}>
				<div className="px-5 pb-6 text-xs text-ink-faint">
					不可用——没有解析到这个 scope 的记忆根（详见上方说明）
				</div>
			</SectionCard>
		);
	}
	const files = [
		{ label: "MEMORY.md", file: zone.memoryMd },
		{ label: "memory_summary.md", file: zone.summaryMd },
		{ label: "raw_memories.md", file: zone.rawMd },
	].filter((entry): entry is { label: string; file: MemoryTextFileDto } => entry.file !== null);
	return (
		<SectionCard
			title={title}
			subtitle={zone.memoryRoot ? `${zone.rootKind ? `${zone.rootKind} · ` : ""}${zone.memoryRoot}` : undefined}
			tone={zone.error ? "error" : undefined}
		>
			{zone.error ? (
				<ZoneError error={zone.error} />
			) : files.length === 0 ? (
				<div className="px-5 pb-6 text-xs text-ink-faint">
					{emptyHint}
					{zone.searchedRoots.length > 0 && (
						<span className="mt-1 block font-mono text-3xs">已查：{zone.searchedRoots.join(" · ")}</span>
					)}
				</div>
			) : (
				<div className="space-y-3">
					{files.map(entry => (
						<FileBlock key={entry.label} label={entry.label} file={entry.file} />
					))}
				</div>
			)}
		</SectionCard>
	);
}

/** 用户记忆：单文件（user.md），读失败与没建过分开。 */
function UserZoneCard({ file, error }: { file: MemoryTextFileDto | null; error?: string }): React.JSX.Element {
	return (
		<SectionCard title={SCOPE_LABELS.user} subtitle={file ? "user.md" : undefined} tone={error ? "error" : undefined}>
			{error ? (
				<ZoneError error={error} />
			) : file ? (
				<FileBlock label="user.md" file={file} />
			) : (
				<div className="px-5 pb-6 text-xs text-ink-faint">未找到 user.md——用 identity 工具更新人设后生成</div>
			)}
		</SectionCard>
	);
}

/** 会话记忆：pending（管线未处理）与读失败分开。 */
function SessionZoneCard({ zone }: { zone: MemorySessionZoneDto | null }): React.JSX.Element {
	const title = SCOPE_LABELS.session;
	if (!zone) {
		return (
			<SectionCard title={title}>
				<div className="px-5 pb-6 text-xs text-ink-faint">
					不可用——会话未 attach，没有会话事实（session 文件）可查
				</div>
			</SectionCard>
		);
	}
	const generated = zone.generatedAt ? new Date(zone.generatedAt * 1000).toISOString().slice(0, 10) : null;
	return (
		<SectionCard
			title={title}
			subtitle={zone.threadId ? `thread ${zone.threadId}${generated ? ` · ${generated}` : ""}` : undefined}
			tone={zone.error ? "error" : undefined}
		>
			{zone.error ? (
				<ZoneError error={zone.error} />
			) : zone.pending ? (
				<div className="px-5 pb-6 text-xs text-ink-faint">
					记忆管线尚未处理这个会话（未沉淀，不是「没有记忆」）
					<span className="mt-1 block truncate font-mono text-3xs" title={zone.rolloutPath}>
						{zone.rolloutPath}
					</span>
				</div>
			) : (
				<div className="px-5 pb-5">
					<div className="mb-1 font-mono text-3xs break-all text-ink-faint">{zone.rolloutPath}</div>
					{zone.summary && (
						<div className="mb-2">
							<div className="mb-1 text-xs font-semibold text-ink">会话摘要</div>
							<div className="text-xs leading-relaxed text-ink-subtle">{zone.summary}</div>
						</div>
					)}
					{zone.rawMemory && (
						<pre className="max-h-72 overflow-auto rounded-md border border-hairline bg-surface-2 px-3 py-2.5 font-mono text-2xs leading-relaxed whitespace-pre-wrap text-ink-subtle">
							{zone.rawMemory}
						</pre>
					)}
					{!zone.summary && !zone.rawMemory && (
						<div className="text-xs text-ink-faint">管线跑过这个会话，但这一轮没有产出记忆</div>
					)}
				</div>
			)}
		</SectionCard>
	);
}

/** 记忆库（全局 self-evolution 库，跨 Project）。 */
function MemoryStoreCard({ memory }: { memory: MemoryProjectionDto }): React.JSX.Element {
	const store = memory.memoryStore;
	return (
		<SectionCard
			title={SCOPE_LABELS.global}
			subtitle={store.dbPath ? `${store.totalEntries} 条 · ${store.dbPath}` : undefined}
			tone={store.error ? "error" : undefined}
		>
			{store.error ? (
				<ZoneError error={store.error} />
			) : store.sections.length === 0 ? (
				<div className="px-5 pb-6 text-xs text-ink-faint">
					暂无记忆条目——self-evolution 在会话后自动沉淀，沉淀后这里会出现
				</div>
			) : (
				<div className="space-y-4 px-5 pb-5">
					{store.sections.map(section => (
						<div key={section.namespace}>
							<div className="mb-1.5 text-xs font-semibold text-ink">{section.namespace}</div>
							<div className="space-y-1.5">
								{section.entries.map(entry => (
									<div key={entry.id} className="rounded-md border border-hairline bg-surface-2 px-3 py-2">
										<div className="text-xs leading-relaxed text-ink-subtle">{entry.content}</div>
										<div className="mt-1 font-mono text-3xs text-ink-faint">
											{fmtImportance(entry.importance)} 重要度 · 最近访问 {fmtDate(entry.lastAccessedAt)}
										</div>
									</div>
								))}
							</div>
						</div>
					))}
				</div>
			)}
		</SectionCard>
	);
}
