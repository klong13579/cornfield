import { Files } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Artifacts 产物面板骨架（工作台右栏 Artifacts tab，替换原占位）。
 *
 * 条目列表区渲染：标题 / 类型 / 更新时间 三字段（见 ArtifactRow）。
 * 数据层现状：wire 协议暂无 artifacts 命令或帧（pi-client-api.ts 的 PiClient
 * 无对应方法），故 `useArtifacts()` 只留接入钩子 + 注释，不伪造条目 ——
 * 长驻 ready 空态；协议落地后接真命令，loading / error / 列表三态即自然可达。
 */

/** 产物条目（本地渲染形状；协议落地后字段以 wire DTO 为准）。 */
interface ArtifactEntry {
	id: string;
	/** 产物标题。 */
	title: string;
	/** 产物类型（如 markdown / image / pdf / code）。 */
	type: string;
	/** 更新时间（毫秒 epoch）。 */
	updatedAt: number;
}

type ArtifactsStatus = "loading" | "error" | "ready";

interface ArtifactsState {
	status: ArtifactsStatus;
	entries: ArtifactEntry[];
	error: string | null;
}

function fmtTime(ts: number): string {
	return new Date(ts).toLocaleString("zh-CN", {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/**
 * Artifacts 数据源（接入钩子）。
 * wire 协议暂无 artifacts 命令/帧，禁止伪造数据源——此处直接落 ready 空态。
 * 协议落地后替换下方 settle 为真拉取：
 *
 *   useSessionStore().listArtifacts()
 *     .then(entries => setState({ status: "ready", entries, error: null }))
 *     .catch(err => setState({ status: "error", entries: [], error: msg(err) }));
 */
function useArtifacts(): ArtifactsState {
	const [state, setState] = useState<ArtifactsState>({ status: "loading", entries: [], error: null });

	useEffect(() => {
		setState({ status: "ready", entries: [], error: null });
	}, []);

	return state;
}

export function ArtifactsPanel(): React.JSX.Element {
	const { status, entries, error } = useArtifacts();

	return (
		<div className="min-h-0 overflow-y-auto rounded-lg border border-hairline bg-surface">
			{status === "loading" && <div className="px-3 py-10 text-center text-[12px] text-ink-faint">加载中…</div>}

			{status === "error" && <div className="px-3 py-2 text-[12px] text-danger">{error ?? "产物加载失败"}</div>}

			{status === "ready" && entries.length === 0 && (
				<div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
					<Files size={24} strokeWidth={1.25} className="text-ink-faint" />
					<div className="text-[12px] text-ink-faint">暂无产物</div>
				</div>
			)}

			{status === "ready" && entries.length > 0 && (
				<ul className="divide-y divide-hairline">
					{entries.map(entry => (
						<ArtifactRow key={entry.id} entry={entry} />
					))}
				</ul>
			)}
		</div>
	);
}

function ArtifactRow({ entry }: { entry: ArtifactEntry }): React.JSX.Element {
	return (
		<li className="flex items-center gap-2 px-3 py-2 transition-colors hover:bg-surface-2">
			<div className="min-w-0 flex-1">
				<div className="truncate text-[13px] text-ink">{entry.title}</div>
				<div className="mt-0.5 text-[11px] text-ink-faint">{fmtTime(entry.updatedAt)}</div>
			</div>
			<span className="shrink-0 rounded-full border border-hairline px-2 py-0.5 font-mono text-[10px] text-ink-subtle">
				{entry.type}
			</span>
		</li>
	);
}
