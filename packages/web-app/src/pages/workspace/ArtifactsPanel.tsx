import { Files, Maximize2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { fmtSize } from "../../lib/format-size";
import type { ArtifactDto } from "../../lib/pi-client-api";
import { Markdown } from "../../render/Markdown";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";

/**
 * Artifacts 产物面板（工作台右栏 Artifacts tab，R-ARTIFACTS 接真数据）。
 *
 * 这本账有**两个来源**，`entry.source` 说清每条是谁放进来的：`agent`（Tool 写出的文件）与
 * `user`（用户贴/选进来的图）。两者同一个列表、按时间倒序 —— 不合成一个看不见的字段，
 * 也不拆成两个列表：用户问的是「这个会话手上都有什么」。
 *
 * 数据源：store.listArtifacts(attachmentAddress, sessionFile) —— 第一个入参是**会话身份**
 * （`view.attachmentAddress`，焦点附件的地址），不是屏幕上那个 Agent 名：
 * - 列表：wire 拿它 + `sessionFile` 解出那个会话的工作面（产物路径就是相对它报的）
 * - 预览：/preview 的第一段也是它 —— 拿 Agent 名指过去，服务端解到的是该 Agent **未绑定**的
 *   附件（另一个根），Project 根里的产物会 404
 * - markdown/text：fs_read 同样按会话身份定向
 * 预览（点条目）：
 * - html → iframe（/preview 静态路由，serve 端按那个附件的工作面当 docroot）
 * - image → img（同路由；比 fs_read_image dataUrl 支持更大文件）
 * - markdown → fs_read + Markdown 渲染
 * - text → fs_read + 纯文本
 *
 * ## 三种「没有」必须分开说（与右栏文件/改动两 tab 同一套）
 *
 *   未连接   —— 连不上 serve，清单读不到（同「未连接——文件系统不可用」「未连接——读不到工作区改动」）
 *   未挂载   —— 连上了但会话身份还没到（附件地址空串）：还不知道该问谁
 *   没有产物 —— 真读到了，这本账本里确实没有产物
 *
 * 前两种**都不是**「没有产物」：把「没问过」渲染成「一条都没有」，用户会据此以为 agent 什么都没写。
 * 加载中/读失败另有 loading/error 两态。
 */

type PreviewState =
	| { kind: "loading"; path: string }
	| { kind: "iframe"; path: string; url: string }
	| { kind: "image"; path: string; url: string }
	| { kind: "text"; path: string; text: string; truncated: boolean }
	| { kind: "markdown"; path: string; text: string; truncated: boolean }
	| { kind: "error"; path: string; error: string };

/**
 * 产物清单的读取状态。
 *
 * 五种而不是三种：`list_artifacts` 之外还有两个**没有问过**的前提（未连接 / 会话身份未挂载），
 * 它们既不是「没有产物」也不是「读不到」——各自有名字，「有没有问过」这件事因此不能靠
 * 「清单是空的」反推（这正是上一版把未挂载渲染成「暂无产物」的形状）。
 */
type ArtifactsState =
	/** 连不上 serve：清单读不到（不是「没有产物」）。 */
	| { status: "disconnected" }
	/** 连上了、会话身份还没挂载（附件地址空串）：还不知道该问谁。 */
	| { status: "unmounted" }
	| { status: "loading" }
	| { status: "ready"; entries: ArtifactDto[] }
	| { status: "error"; error: string };

function fmtTime(ts: number): string {
	return new Date(ts).toLocaleString("zh-CN", {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/**
 * 读产物清单。
 *
 * 只有「连上了 **且** 会话身份已挂载」才发请求：另外两个前提（未连接 / 身份未挂载）在这里
 * **不发请求、也不返回空清单**，而是各自给出自己的状态名（见 {@link ArtifactsState}）。
 * `connected` 与 `attachmentAddress` 由调用方从**与右栏文件/改动两 tab 同一处**取
 * （`view.connected` / `view.attachmentAddress`），三个 tab 因此说的是同一件事。
 */
/**
 * 来源标记的文案。两个标记各管一件事：`type` 决定点开怎么预览，`source` 说明这个文件是谁
 * 放进会话的 —— 用户贴的图和 agent 写出的文件同处一个列表，不标来源就是让用户自己猜。
 */
const SOURCE_LABELS: Record<ArtifactDto["source"], string> = {
	agent: "agent",
	user: "我发的",
};

/**
 * 产物清单的一行（纯展示，从 ArtifactsPanel 提出，静态渲染可断言）。
 */
export function ArtifactRow({
	entry,
	selected,
	onOpen,
}: {
	entry: ArtifactDto;
	selected: boolean;
	onOpen: (entry: ArtifactDto) => void;
}): React.JSX.Element {
	return (
		<button
			type="button"
			className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-2 ${selected ? "bg-surface-2" : ""}`}
			onClick={() => onOpen(entry)}
		>
			<div className="min-w-0 flex-1">
				<div className="truncate text-[13px] text-ink">{entry.title}</div>
				<div className="mt-0.5 text-[11px] text-ink-faint">
					{fmtTime(entry.updatedAt)} · {fmtSize(entry.size)}
				</div>
			</div>
			<span
				className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${entry.source === "user" ? "bg-accent-dim text-ink" : "border border-hairline text-ink-subtle"}`}
			>
				{SOURCE_LABELS[entry.source]}
			</span>
			<span className="shrink-0 rounded-full border border-hairline px-2 py-0.5 font-mono text-[10px] text-ink-subtle">
				{entry.type}
			</span>
		</button>
	);
}

function useArtifacts(
	connected: boolean,
	attachmentAddress: string,
	sessionFile: string | undefined,
	isStreaming: boolean,
): ArtifactsState {
	const store = useSessionStore();
	const [state, setState] = useState<ArtifactsState>({ status: "loading" });

	useEffect(() => {
		let cancelled = false;
		if (!connected || attachmentAddress === "") return;
		setState({ status: "loading" });
		store
			.listArtifacts(attachmentAddress, sessionFile)
			.then(({ artifacts }) => {
				if (cancelled) return;
				setState({ status: "ready", entries: artifacts });
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
			});
		return () => {
			cancelled = true;
		};
	}, [connected, attachmentAddress, sessionFile, store, isStreaming]);

	// 两个前提在**渲染时**判定（不是 effect 里补写状态）：连不上的那一帧就已经是「未连接」，
	// 不会先闪一下「加载中」或「暂无产物」。
	if (!connected) return { status: "disconnected" };
	if (attachmentAddress === "") return { status: "unmounted" };
	return state;
}

export function ArtifactsPanel({
	attachmentAddress,
	sessionFile,
	connected,
}: {
	/** **会话身份**（`view.attachmentAddress`）：list_artifacts / fs_read / /preview 的定向身份。 */
	attachmentAddress: string;
	sessionFile?: string;
	/** 本连接是否连上 serve（与文件/改动两 tab 同一处取：`view.connected`）。
	 * 未连接 ≠ 没有产物（见文件头「三种「没有」」）。 */
	connected: boolean;
}): React.JSX.Element {
	const store = useSessionStore();
	const view = useSession();
	const state = useArtifacts(connected, attachmentAddress, sessionFile, view.isStreaming);
	const [selected, setSelected] = useState<ArtifactDto | null>(null);
	const [preview, setPreview] = useState<PreviewState | null>(null);
	const [zoomed, setZoomed] = useState(false);

	// 产物列表刷新/换会话身份时清选择态
	useEffect(() => {
		setSelected(null);
		setPreview(null);
	}, [attachmentAddress, sessionFile]);

	const openPreview = (entry: ArtifactDto): void => {
		setSelected(entry);
		if (entry.type === "html" || entry.type === "image") {
			const url = attachmentAddress === "" ? "" : store.artifactPreviewUrl(attachmentAddress, entry.path);
			setPreview({ kind: entry.type === "html" ? "iframe" : "image", path: entry.path, url });
			return;
		}
		setPreview({ kind: "loading", path: entry.path });
		if (attachmentAddress === "") return;
		store
			.fsRead(attachmentAddress, entry.path)
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
				{state.status === "disconnected" && (
					<div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
						<Files size={24} strokeWidth={1.25} className="text-ink-faint" />
						<div className="text-[12px] text-ink-faint">未连接——读不到产物清单</div>
						<div className="px-2 text-[11px] leading-relaxed text-ink-subtle">
							连上 serve 后这里会列出 agent 生成的产物
						</div>
					</div>
				)}

				{state.status === "unmounted" && (
					<div className="py-10 text-center text-[12px] text-ink-faint">等待会话挂载…</div>
				)}

				{state.status === "loading" && (
					<div className="px-3 py-10 text-center text-[12px] text-ink-faint">加载中…</div>
				)}

				{state.status === "error" && <div className="px-3 py-2 text-[12px] text-danger">{state.error}</div>}

				{state.status === "ready" && state.entries.length === 0 && (
					<div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
						<Files size={24} strokeWidth={1.25} className="text-ink-faint" />
						<div className="text-[12px] text-ink-faint">暂无产物</div>
						<div className="px-2 text-[11px] leading-relaxed text-ink-subtle">
							agent 写出的文件、以及你贴进来的图，都会出现在这里
						</div>
					</div>
				)}

				{state.status === "ready" && state.entries.length > 0 && (
					<ul className="divide-y divide-hairline">
						{state.entries.map(entry => (
							<li key={entry.id}>
								<ArtifactRow entry={entry} selected={selected?.id === entry.id} onOpen={openPreview} />
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
