import { useEffect, useState } from "react";
import type { MemoryProjectionDto } from "../../lib/wire-dto";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";

/**
 * 记忆面板（W3 D3）—— serve get_memory 只读投影，三分区：
 * - 记忆库（memory）：self-evolution vector_embeddings 分区（importance 降序）
 * - 项目（project）：当前项目 memories 目录的 MEMORY.md / memory_summary.md / raw_memories.md
 * - 用户（user）：~/.omp/user.md 身份画像
 *
 * 无 mock：任一区取不到（null / 空）渲染对应空态，绝不回退假数据。
 */

function fmtImportance(n: number): string {
	return `${Math.round(n * 100)}%`;
}

function fmtDate(ts: number): string {
	return new Date(ts).toISOString().slice(0, 10);
}

export function MemoryView(): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const [memory, setMemory] = useState<MemoryProjectionDto | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!view.connected) return;
		setError(null);
		void store
			.fetchMemory()
			.then(setMemory)
			.catch(err => setError(err instanceof Error ? err.message : String(err)));
	}, [store, view.connected]);

	return (
		<div className="px-10 pt-8 pb-12">
			<div className="mx-auto max-w-[1000px]">
				<h1 className="mb-7 text-[32px] font-semibold tracking-[-0.8px] text-ink">记忆</h1>

				{!view.connected && (
					<div className="py-20 text-center text-[13px] text-ink-faint">未连接——记忆投影不可用</div>
				)}
				{error && <div className="py-20 text-center text-[13px] text-ink-faint">记忆不可用：{error}</div>}
				{view.connected && !error && !memory && (
					<div className="py-20 text-center text-[13px] text-ink-faint">加载记忆投影…</div>
				)}

				{memory && !error && (
					<div className="space-y-8">
						<MemoryStoreSection
							sections={memory.memoryStore.sections}
							totalEntries={memory.memoryStore.totalEntries}
						/>
						<ProjectSection
							memoryRoot={memory.project?.memoryRoot}
							memoryMd={memory.project?.memoryMd ?? null}
							summaryMd={memory.project?.summaryMd ?? null}
							rawMd={memory.project?.rawMd ?? null}
						/>
						<UserSection file={memory.user} />
					</div>
				)}
			</div>
		</div>
	);
}

function SectionCard({
	title,
	subtitle,
	children,
}: {
	title: string;
	subtitle?: string;
	children: React.ReactNode;
}): React.JSX.Element {
	return (
		<div className="rounded-xl border border-hairline bg-surface">
			<div className="flex items-baseline justify-between px-5 pt-4 pb-2">
				<div className="text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase">{title}</div>
				{subtitle && <div className="font-mono text-[11px] text-ink-faint">{subtitle}</div>}
			</div>
			{children}
		</div>
	);
}

function MemoryStoreSection({
	sections,
	totalEntries,
}: {
	sections: MemoryProjectionDto["memoryStore"]["sections"];
	totalEntries: number;
}): React.JSX.Element {
	return (
		<SectionCard title="记忆库" subtitle={totalEntries > 0 ? `${totalEntries} 条` : undefined}>
			{sections.length === 0 ? (
				<div className="px-5 pb-6 text-[12px] text-ink-faint">
					暂无记忆条目——self-evolution 在会话后自动沉淀，沉淀后这里会出现
				</div>
			) : (
				<div className="space-y-4 px-5 pb-5">
					{sections.map(section => (
						<div key={section.namespace}>
							<div className="mb-1.5 text-[12px] font-semibold text-ink">{section.namespace}</div>
							<div className="space-y-1.5">
								{section.entries.map(entry => (
									<div key={entry.id} className="rounded-md border border-hairline bg-surface-2 px-3 py-2">
										<div className="text-[12.5px] leading-relaxed text-ink-subtle">{entry.content}</div>
										<div className="mt-1 font-mono text-[10.5px] text-ink-faint">
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

function FileBlock({
	label,
	file,
}: {
	label: string;
	file: { path: string; content: string; truncated: boolean } | null;
}): React.JSX.Element | null {
	if (!file) return null;
	return (
		<div className="px-5 pb-4">
			<div className="mb-1 flex items-baseline justify-between">
				<div className="text-[12px] font-semibold text-ink">{label}</div>
				<div className="font-mono text-[10.5px] text-ink-faint">
					{file.path.split("/").pop()}
					{file.truncated ? "（128KB 截断）" : ""}
				</div>
			</div>
			<pre className="max-h-72 overflow-auto rounded-md border border-hairline bg-surface-2 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-subtle">
				{file.content}
			</pre>
		</div>
	);
}

function ProjectSection({
	memoryRoot,
	memoryMd,
	summaryMd,
	rawMd,
}: {
	memoryRoot?: string;
	memoryMd: { path: string; content: string; truncated: boolean } | null;
	summaryMd: { path: string; content: string; truncated: boolean } | null;
	rawMd: { path: string; content: string; truncated: boolean } | null;
}): React.JSX.Element {
	const hasAny = Boolean(memoryMd || summaryMd || rawMd);
	return (
		<SectionCard title="项目记忆" subtitle={memoryRoot ? memoryRoot.split("/").slice(-2).join("/") : undefined}>
			{!memoryRoot || !hasAny ? (
				<div className="px-5 pb-6 text-[12px] text-ink-faint">
					{memoryRoot ? "项目记忆尚未生成——会话沉淀后自动生成 MEMORY.md" : "当前目录不适用项目记忆（系统路径）"}
				</div>
			) : (
				<div className="space-y-3">
					<FileBlock label="MEMORY.md" file={memoryMd} />
					<FileBlock label="memory_summary.md" file={summaryMd} />
					<FileBlock label="raw_memories.md" file={rawMd} />
				</div>
			)}
		</SectionCard>
	);
}

function UserSection({
	file,
}: {
	file: { path: string; content: string; truncated: boolean } | null;
}): React.JSX.Element {
	return (
		<SectionCard title="用户画像" subtitle={file ? "user.md" : undefined}>
			{!file ? (
				<div className="px-5 pb-6 text-[12px] text-ink-faint">未找到 user.md——用 identity 工具更新人设后生成</div>
			) : (
				<FileBlock label="user.md" file={file} />
			)}
		</SectionCard>
	);
}
