import { Files, Maximize2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { ArtifactDto } from "../../lib/pi-client-api";
import { Markdown } from "../../render/Markdown";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";

/**
 * Artifacts 产物面板（工作台右栏 Artifacts tab，R-ARTIFACTS 接真数据）。
 *
 * 数据源：store.listArtifacts(agentId, sessionFile)——有 sessionFile 时按会话隔离视图
 * （只提当前会话的产物），缺省 agent 维度。
 * 预览（点条目）：
 * - html → iframe（/preview 静态路由，serve 端 agentDir docroot）
 * - image → img（同路由；比 fs_read_image dataUrl 支持更大文件）
 * - markdown → fs_read + Markdown 渲染
 * - text → fs_read + 纯文本
 *
 * agentId 未挂载（undefined）→ 空态提示；加载中/失败 → loading/error 态。
 */

type PreviewState =
	| { kind: "loading"; path: string }
	| { kind: "iframe"; path: string; url: string }
	| { kind: "image"; path: string; url: string }
	| { kind: "text"; path: string; text: string; truncated: boolean }
	| { kind: "markdown"; path: string; text: string; truncated: boolean }
	| { kind: "error"; path: string; error: string };

type ArtifactsStatus = "loading" | "error" | "ready";

interface ArtifactsState {
	status: ArtifactsStatus;
	entries: ArtifactDto[];
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

function fmtSize(n: number): string {
	if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}M`;
	if (n >= 1024) return `${(n / 1024).toFixed(0)}K`;
	return String(n);
}

function useArtifacts(
	agentId: string | undefined,
	sessionFile: string | undefined,
	isStreaming: boolean,
): ArtifactsState {
	const store = useSessionStore();
	const [state, setState] = useState<ArtifactsState>({ status: "loading", entries: [], error: null });

	useEffect(() => {
		let cancelled = false;
		if (!agentId) {
			setState({ status: "ready", entries: [], error: null });
			return;
		}
		setState(prev => ({ ...prev, status: "loading", error: null }));
		store
			.listArtifacts(agentId, sessionFile)
			.then(({ artifacts }) => {
				if (cancelled) return;
				setState({ status: "ready", entries: artifacts, error: null });
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setState({ status: "error", entries: [], error: err instanceof Error ? err.message : String(err) });
			});
		return () => {
			cancelled = true;
		};
	}, [agentId, sessionFile, store, isStreaming]);

	return state;
}

export function ArtifactsPanel({
	agentId,
	sessionFile,
}: {
	agentId?: string;
	sessionFile?: string;
}): React.JSX.Element {
	const store = useSessionStore();
	const view = useSession();
	const { status, entries, error } = useArtifacts(agentId, sessionFile, view.isStreaming);
	const [selected, setSelected] = useState<ArtifactDto | null>(null);
	const [preview, setPreview] = useState<PreviewState | null>(null);
	const [zoomed, setZoomed] = useState(false);

	// 产物列表刷新/切换 agent/切换会话时清选择态
	useEffect(() => {
		setSelected(null);
		setPreview(null);
	}, [agentId, sessionFile]);

	const openPreview = (entry: ArtifactDto): void => {
		setSelected(entry);
		if (entry.type === "html" || entry.type === "image") {
			const url = agentId ? store.artifactPreviewUrl(agentId, entry.path) : "";
			setPreview({ kind: entry.type === "html" ? "iframe" : "image", path: entry.path, url });
			return;
		}
		setPreview({ kind: "loading", path: entry.path });
		if (!agentId) return;
		store
			.fsRead(agentId, entry.path)
			.then(({ text, truncated }) => {
				setPreview({
					kind: entry.type === "markdown" ? "markdown" : "text",
					path: entry.path,
					text,
					truncated,
				});
			})
			.catch((err: unknown) => {
				setPreview({ kind: "error", path: entry.path, error: err instanceof Error ? err.message : String(err) });
			});
	};

	const previewBody = useMemo(() => {
		if (!preview) return null;
		switch (preview.kind) {
			case "loading":
				return <div className="skeleton h-32 w-full rounded-lg" />;
			case "iframe":
				return (
					<iframe
						key={preview.url}
						src={preview.url}
						title={preview.path}
						className="h-full w-full border-none bg-white"
					/>
				);
			case "image":
				return (
					<div className="flex min-h-0 flex-1 items-start justify-center overflow-auto">
						<img
							src={preview.url}
							alt={preview.path}
							className="block max-w-full rounded-md border border-hairline"
						/>
					</div>
				);
			case "markdown":
				return (
					<div className="min-h-0 flex-1 overflow-auto px-1 text-[12px]">
						<Markdown text={preview.text} />
					</div>
				);
			case "text":
				return (
					<pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap text-[12px] leading-relaxed text-ink-muted">
						{preview.text}
					</pre>
				);
			case "error":
				return <div className="px-2 py-4 text-[12px] text-danger">{preview.error}</div>;
		}
	}, [preview]);

	return (
		<div className="flex h-full min-h-0 flex-col gap-3">
			{/* 列表 */}
			<div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-hairline bg-surface">
				{status === "loading" && <div className="px-3 py-10 text-center text-[12px] text-ink-faint">加载中…</div>}

				{status === "error" && <div className="px-3 py-2 text-[12px] text-danger">{error ?? "产物加载失败"}</div>}

				{status === "ready" && entries.length === 0 && (
					<div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
						<Files size={24} strokeWidth={1.25} className="text-ink-faint" />
						<div className="text-[12px] text-ink-faint">暂无产物</div>
						<div className="px-2 text-[11px] leading-relaxed text-ink-subtle">
							让 agent 生成网页/图片/文档后，产物会自动出现在这里
						</div>
					</div>
				)}

				{status === "ready" && entries.length > 0 && (
					<ul className="divide-y divide-hairline">
						{entries.map(entry => (
							<li key={entry.id}>
								<button
									type="button"
									className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-2 ${selected?.id === entry.id ? "bg-surface-2" : ""}`}
									onClick={() => openPreview(entry)}
								>
									<div className="min-w-0 flex-1">
										<div className="truncate text-[13px] text-ink">{entry.title}</div>
										<div className="mt-0.5 text-[11px] text-ink-faint">
											{fmtTime(entry.updatedAt)} · {fmtSize(entry.size)}
										</div>
									</div>
									<span className="shrink-0 rounded-full border border-hairline px-2 py-0.5 font-mono text-[10px] text-ink-subtle">
										{entry.type}
									</span>
								</button>
							</li>
						))}
					</ul>
				)}
			</div>

			{/* 预览（选中产物） */}
			{selected && preview ? (
				<div className="flex h-[45%] min-h-0 shrink-0 flex-col overflow-hidden rounded-lg border border-hairline bg-surface">
					<div className="flex shrink-0 items-center justify-between gap-2 border-b border-hairline px-3 py-1.5">
						<span className="truncate font-mono text-[11px] text-ink">{selected.title}</span>
						<div className="flex shrink-0 items-center gap-1.5">
							{preview.kind === "text" && preview.truncated && <span className="badge fail">截断</span>}
							<button
								type="button"
								title="放大预览"
								className="rounded p-1 text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
								onClick={() => setZoomed(true)}
							>
								<Maximize2 size={13} strokeWidth={1.5} />
							</button>
						</div>
					</div>
					<div className="flex min-h-0 flex-1 flex-col p-2">{previewBody}</div>
				</div>
			) : (
				<div className="hidden" />
			)}

			{/* 全屏放大预览（portal 到 body：脱离 aside 的 transform 祖先，fixed 才能占满视口） */}
			{zoomed &&
				selected &&
				preview &&
				createPortal(
					<div
						className="fixed inset-0 z-modal flex flex-col bg-surface p-3"
						role="dialog"
						aria-modal="true"
						aria-label={`${selected.title} 全屏预览`}
						onClick={e => {
							if (e.target === e.currentTarget) setZoomed(false);
						}}
						onKeyDown={e => {
							if (e.key === "Escape") setZoomed(false);
						}}
					>
						<div className="mb-2 flex shrink-0 items-center justify-between gap-2">
							<span className="truncate font-mono text-[13px] text-ink">{selected.title}</span>
							<button
								type="button"
								title="关闭全屏预览"
								className="rounded p-1.5 text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
								onClick={() => setZoomed(false)}
							>
								<X size={16} strokeWidth={1.5} />
							</button>
						</div>
						<div className="flex min-h-0 flex-1 flex-col">{previewBody}</div>
					</div>,
					document.body,
				)}
		</div>
	);
}
