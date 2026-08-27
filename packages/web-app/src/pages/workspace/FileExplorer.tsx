import { useEffect, useState } from "react";
import { useSessionStore } from "../../state/session-store";

/**
 * 文件系统浏览器（fs_list/fs_read 懒加载目录树）——AgentDetailView 与工作台
 * 右栏 Files tab 共用（S5 复用，不重写 fs 目录树逻辑）。
 *
 * variant:
 * - "wide"（默认）：详情页左右双栏（目录树 | 文件预览）
 * - "narrow"：右栏上下布局（目录树 | 文件预览，40% 预览区）
 */

interface FsTreeNode {
	name: string;
	type: "dir" | "file";
	size: number;
	path: string;
	children?: FsTreeNode[];
	loaded?: boolean;
}

const FS_MAX_READ_HINT = ">128KB 仅显示前段";

function fmtSize(n: number): string {
	if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}M`;
	if (n >= 1024) return `${(n / 1024).toFixed(0)}K`;
	return String(n);
}

type SelectedFile =
	| { path: string; kind: "text"; text: string; truncated: boolean }
	| { path: string; kind: "image"; dataUrl: string };

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

export function FileExplorer({
	agentId,
	variant = "wide",
}: {
	agentId: string;
	variant?: "wide" | "narrow";
}): React.JSX.Element {
	const store = useSessionStore();
	const [root, setRoot] = useState<FsTreeNode | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<SelectedFile | null>(null);

	const loadDir = async (node: FsTreeNode): Promise<void> => {
		try {
			const { entries } = await store.fsList(agentId, node.path);
			node.children = entries.map(e => ({ ...e, path: node.path ? `${node.path}/${e.name}` : e.name }));
			node.loaded = true;
			setRoot(prev => (prev ? { ...prev } : { ...node })); // 首载：root 落地
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const readFile = async (node: FsTreeNode): Promise<void> => {
		try {
			if (IMAGE_EXT.test(node.path)) {
				const { dataUrl } = await store.fsReadImage(agentId, node.path);
				setSelected({ path: node.path, kind: "image", dataUrl });
			} else {
				const result = await store.fsRead(agentId, node.path);
				setSelected({ path: node.path, kind: "text", text: result.text, truncated: result.truncated });
			}
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	useEffect(() => {
		void loadDir({ name: "", type: "dir", size: 0, path: "" } as FsTreeNode);
	}, [agentId]);

	const flatVisible = (node: FsTreeNode | null): FsTreeNode[] => {
		if (!node) return [];
		const out: FsTreeNode[] = [node];
		if (node.children) {
			for (const c of node.children) {
				out.push(...flatVisible(c));
			}
		}
		return out;
	};

	/** 键盘导航：↑↓ 移动焦点，→ 展开目录，← 折叠目录。 */
	const onTreeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
		const rows = flatVisible(root);
		const active = e.target as HTMLElement;
		const path = active?.dataset?.path;
		const idx = rows.findIndex(n => n.path === path);
		if (idx < 0) return;
		e.preventDefault();
		const rowEls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-path]"));
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			const next = rows[e.key === "ArrowDown" ? idx + 1 : idx - 1];
			if (!next) return;
			const el = rowEls.find(r => r.dataset.path === next.path);
			el?.focus();
			return;
		}
		const node = rows[idx];
		if (node.type !== "dir") return;
		if (e.key === "ArrowRight" && !node.children) {
			void loadDir(node);
		} else if (e.key === "ArrowLeft" && node.children) {
			node.children = undefined; // 折叠
			setRoot(r => (r ? { ...r } : r));
		}
	};

	const renderNode = (node: FsTreeNode, depth: number): React.JSX.Element => {
		const pad = { paddingLeft: `${depth * 16 + 4}px` };
		if (node.type === "dir") {
			return (
				<button
					key={node.path}
					type="button"
					data-path={node.path}
					aria-expanded={Boolean(node.children)}
					className="flex w-full cursor-pointer items-center gap-1.5 px-1 py-[3px] text-left text-xs text-ink hover:bg-surface-2"
					style={pad}
					onClick={() => {
						if (!node.loaded) void loadDir(node);
						else if (node.children) node.children = undefined; // 折叠
						setRoot(r => (r ? { ...r } : r));
					}}
				>
					<span className="text-ink-faint">{node.children ? "▾" : "▸"}</span>
					<span className="font-mono">{node.name || "·"}</span>
				</button>
			);
		}
		return (
			<button
				key={node.path}
				type="button"
				data-path={node.path}
				className="flex w-full cursor-pointer items-center gap-1.5 px-1 py-[3px] text-left text-xs text-ink-muted hover:bg-surface-2 hover:text-ink"
				style={pad}
				onClick={() => void readFile(node)}
			>
				<span className="text-ink-faint">·</span>
				<span className="truncate font-mono">{node.name}</span>
				<span className="ml-auto shrink-0 pr-2 text-[10px] text-ink-faint">{fmtSize(node.size)}</span>
			</button>
		);
	};

	const renderChildrenAt = (node: FsTreeNode, depth: number): React.JSX.Element[] => {
		if (!node.children) return [];
		return node.children.flatMap(c => [
			renderNode(c, depth),
			...(c.type === "dir" && c.children ? renderChildrenAt(c, depth + 1) : []),
		]);
	};

	const renderChildren = (node: FsTreeNode | null): React.JSX.Element[] => renderChildrenAt(node as FsTreeNode, 1);

	const tree = (
		<div
			role="tree"
			onKeyDown={onTreeKeyDown}
			className="min-h-0 overflow-y-auto rounded-lg border border-hairline bg-surface py-1.5"
		>
			{error && (
				<div className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-danger">
					<span className="truncate">{error}</span>
					<button
						type="button"
						className="link shrink-0"
						onClick={() => void loadDir({ name: "", type: "dir", size: 0, path: "" } as FsTreeNode)}
					>
						重试
					</button>
				</div>
			)}
			{root && renderNode(root, 0)}
			{root?.children && renderChildren(root)}
			{!root && !error && (
				<div className="flex flex-col gap-2 px-3 py-2">
					{[0, 1, 2, 3].map(i => (
						<div key={i} className="skeleton h-4 w-full" style={{ width: `${90 - i * 18}%` }} />
					))}
				</div>
			)}
		</div>
	);

	const preview = (
		<div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-hairline bg-surface px-4 py-3">
			{selected ? (
				<>
					<div className="mb-2 flex shrink-0 items-center gap-2">
						<span className="truncate font-mono text-[12px] text-ink">{selected.path}</span>
						{selected.kind === "text" && selected.truncated && (
							<span className="badge fail">截断（{FS_MAX_READ_HINT}）</span>
						)}
					</div>
					{selected.kind === "image" ? (
						<div className="min-h-0 flex-1 overflow-auto">
							<img
								src={selected.dataUrl}
								alt={selected.path}
								className="block max-w-full rounded-md border border-hairline"
							/>
						</div>
					) : (
						<pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap text-[12px] leading-relaxed text-ink-muted">
							{selected.text}
						</pre>
					)}
				</>
			) : (
				<div className="py-10 text-center text-[12px] text-ink-faint">点击左侧目录展开，点文件查看内容</div>
			)}
		</div>
	);

	if (variant === "narrow") {
		return (
			<div className="flex min-h-0 flex-col gap-3">
				<div className="min-h-0 flex-1">{tree}</div>
				<div className="h-[40%] shrink-0">{preview}</div>
			</div>
		);
	}

	return (
		<div className="grid min-h-[300px] grid-cols-[minmax(220px,340px)_1fr] gap-4">
			{tree}
			{preview}
		</div>
	);
}
