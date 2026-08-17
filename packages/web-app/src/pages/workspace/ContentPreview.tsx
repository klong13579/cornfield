import { useState } from "react";
import type { ContentPreviewState } from "../../state/ui-store";

/**
 * 右栏内容预览（FR-10）：mermaid / drawio / 网页链接三卡。
 * 不动消息权威数据，纯展示层；mermaid 为几何占位，正式版接 mermaid.js（TODO）。
 */
export function ContentPreview({ preview }: { preview: ContentPreviewState }): React.JSX.Element {
	return (
		<div className="border-b border-hairline">
			<div className="flex items-center gap-2 px-4 pt-3.5 pb-3">
				<span className="flex-1 font-mono text-[11px] font-medium text-accent">{preview.title}</span>
			</div>
			<div className="px-4 pb-3.5">
				{preview.kind === "mermaid" && <MermaidBody />}
				{preview.kind === "drawio" && <DrawioBody />}
				{preview.kind === "web" && <WebBody />}
			</div>
		</div>
	);
}

function MermaidBody(): React.JSX.Element {
	return (
		<div>
			<svg viewBox="0 0 560 190" className="pv-frame" role="img" aria-label="mermaid 流程图占位">
				<defs>
					<marker
						id="pv-arrow"
						viewBox="0 0 10 10"
						refX="9"
						refY="5"
						markerWidth="7"
						markerHeight="7"
						orient="auto-start-reverse"
					>
						<path d="M0 0 L10 5 L0 10 z" fill="var(--color-ink-subtle)" />
					</marker>
				</defs>
				<path className="pv-edge" markerEnd="url(#pv-arrow)" d="M150 70 C 200 70, 200 58, 240 58" />
				<text className="pv-edge-label" x="180" y="64">
					30s
				</text>
				<path className="pv-edge" markerEnd="url(#pv-arrow)" d="M300 70 C 340 70, 340 30, 372 30" />
				<text className="pv-edge-label" x="330" y="44">
					yes
				</text>
				<path className="pv-edge" markerEnd="url(#pv-arrow)" d="M300 74 C 340 74, 340 112, 372 112" />
				<text className="pv-edge-label" x="330" y="96">
					no
				</text>
				<path className="pv-edge" markerEnd="url(#pv-arrow)" d="M432 30 C 470 30, 470 36, 500 36" />
				<path className="pv-edge" markerEnd="url(#pv-arrow)" d="M432 112 C 470 112, 470 106, 500 106" />
				<g className="pv-node">
					<rect
						x="20"
						y="52"
						width="130"
						height="36"
						rx="6"
						fill="var(--color-surface-2)"
						stroke="var(--color-ink-subtle)"
					/>
					<text x="85" y="74" textAnchor="middle">
						service stop
					</text>
				</g>
				<g className="pv-node">
					<polygon
						points="300,30 370,70 300,110 230,70"
						fill="var(--color-surface-2)"
						stroke="var(--color-accent)"
					/>
					<text x="300" y="74" textAnchor="middle">
						graceful?
					</text>
				</g>
				<g className="pv-node">
					<rect
						x="372"
						y="14"
						width="60"
						height="32"
						rx="6"
						fill="var(--color-surface-2)"
						stroke="var(--color-success)"
					/>
					<text x="402" y="34" textAnchor="middle">
						写哨兵
					</text>
				</g>
				<g className="pv-node">
					<rect
						x="372"
						y="96"
						width="60"
						height="32"
						rx="6"
						fill="var(--color-surface-2)"
						stroke="var(--color-danger)"
					/>
					<text x="402" y="116" textAnchor="middle">
						bootout
					</text>
				</g>
			</svg>
			<div className="mt-2 text-[11px] text-ink-faint">轻量内联渲染（mock）· 正式版接 mermaid.js</div>
		</div>
	);
}

function DrawioBody(): React.JSX.Element {
	return (
		<div>
			<div className="flex items-center gap-4 rounded-md border border-hairline p-3.5">
				<div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border-[1.5px] border-hairline-strong">
					<svg
						width="22"
						height="22"
						viewBox="0 0 24 24"
						fill="none"
						stroke="var(--color-ink-subtle)"
						strokeWidth="1.5"
					>
						<title>drawio 文件图标</title>
						<rect x="3" y="3" width="8" height="8" rx="1" />
						<rect x="13" y="13" width="8" height="8" rx="1" />
						<path d="M7 11v4a2 2 0 0 0 2 2h4" />
					</svg>
				</div>
				<div className="min-w-0 flex-1">
					<div className="text-[13px] text-ink">gateway-restart-flow.drawio</div>
					<div className="mt-0.5 text-[11px] text-ink-faint">流程图 · 2.4 KB · 上次修改 8/16</div>
				</div>
				<button type="button" className="cbtn shrink-0 border border-hairline px-3 py-1">
					打开查看
				</button>
			</div>
			<div className="mt-2 text-[11px] text-ink-faint">drawio 画布示意（mock）· 正式版接 drawio 查看器</div>
		</div>
	);
}

function WebBody(): React.JSX.Element {
	const [open, setOpen] = useState(false);
	return (
		<div>
			{open ? (
				<>
					<div className="flex items-center justify-center border border-hairline px-4 py-5 text-[12px] text-ink-faint">
						正在加载 https://github.com/oven-sh/bun …
					</div>
					<iframe
						title="网页预览"
						src="https://github.com/oven-sh/bun"
						className="hidden"
						style={{ display: open ? "block" : "none", height: 260 }}
					/>
					<div className="mt-2 text-[11px] text-ink-faint">浏览器内 iframe 预览（需联网）· 离线时为占位</div>
				</>
			) : (
				<button
					type="button"
					className="cbtn w-full border border-hairline px-3 py-1.5"
					onClick={() => setOpen(true)}
				>
					内嵌打开
				</button>
			)}
		</div>
	);
}
