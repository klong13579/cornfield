import { useEffect, useState } from "react";
import { PaneDivider } from "../../layout/PaneDivider";
import { useFileSplit } from "../../layout/use-pane-layout";
import { fmtSize } from "../../lib/format-size";
import { FILE_SPLIT_VAR } from "../../lib/pane-resize";
import { getFileWorkflow } from "../../state/file-workflow-store";
import { useSessionStore } from "../../state/session-store";
import { FilePreviewPane } from "./FilePreviewPane";

/**
 * 文件系统浏览器（fs_list 懒加载目录树）——AgentDetailView 与工作台
 * 右栏 Files tab 共用（S5 复用，不重写 fs 目录树逻辑）。
 *
 * 右侧预览/编辑交给 FilePreviewPane：文本文件的打开状态（内容/草稿/归属）归 file-workflow
 * store，本组件只负责「点了哪个节点」和目录树本身的展开收起。
 *
 * ## 两个身份，不要揉
 *
 *   `attachmentAddress` —— **wire 身份**（会话身份）：fs_list/fs_read/fs_write 的 `sessionId`
 *     （服务端叫附件地址）。它回答「列哪一个工作根」；未绑 Project 的会话地址就是 Agent 名。
 *   `agentId` —— **展示/归属 Agent**：它回答「这些文件是谁的」，给打开记录的归属与范围用。
 *
 * 拿 Agent 名当 wire 身份指向的是「那个 Agent 自己根上的附件」——绑了 Project 的会话因此
 * 会列到另一个根（本次修的缺陷）。
 *
 * variant:
 * - "wide"（默认）：详情页左右双栏（目录树 | 文件预览）
 * - "narrow"：右栏上下布局（目录树 | 文件预览，中间可拖 —— 份额存比例，右栏宽度可变）
 */

interface FsTreeNode {
	name: string;
	type: "dir" | "file";
	size: number;
	path: string;
	children?: FsTreeNode[];
	loaded?: boolean;
}

/** 图片预览（二进制，不进编辑器：它不是可编辑文本）。 */
interface PreviewImage {
	path: string;
	dataUrl: string;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

export function FileExplorer({
	attachmentAddress,
	agentId,
	variant = "wide",
}: {
	/** wire 身份（会话身份）：fs_* 命令的 `sessionId`（附件地址）。 */
	attachmentAddress: string;
	/** 展示/归属 Agent：这些文件是谁的（打开记录的归属与范围锚点）。 */
	agentId: string;
	variant?: "wide" | "narrow";
}): React.JSX.Element {
	const store = useSessionStore();
	const [root, setRoot] = useState<FsTreeNode | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [image, setImage] = useState<PreviewImage | null>(null);
	// 上下分栏的几何：narrow 变体用，wide 变体不看它（hook 本身不自带副作用）。
	const split = useFileSplit();

	const loadDir = async (node: FsTreeNode): Promise<void> => {
		try {
			const { entries } = await store.fsList(attachmentAddress, node.path);
			node.children = entries.map(e => ({ ...e, path: node.path ? `${node.path}/${e.name}` : e.name }));
			node.loaded = true;
			// 根节点加载（path 为空串）= 整棵树换人；子目录只是它自己的 children 变了。
			setRoot(prev => (node.path === "" ? { ...node } : prev ? { ...prev } : prev));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const readFile = async (node: FsTreeNode): Promise<void> => {
		try {
			if (IMAGE_EXT.test(node.path)) {
				const { dataUrl } = await store.fsReadImage(attachmentAddress, node.path);
				// 换到图片会把文本编辑器关掉：一个预览区只显示一件事，两份内容叠着就是两个真相
				getFileWorkflow().close();
				setImage({ path: node.path, dataUrl });
			} else {
				setImage(null);
				// 文本文件进编辑器（走 fs_read/fs_write 唯一的那条路；未保存修改由 store 挂起确认）
				getFileWorkflow().requestOpen({ attachmentAddress, agentId, path: node.path });
			}
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	// 换会话身份 = 换一个工作根：上一棵树的路径在新根下指的是另一些文件，必须整棵丢掉重载
	// （留着它就是让上一个会话的目录树挂在新会话的文件面上）。
	useEffect(() => {
		setRoot(null);
		setError(null);
		setImage(null);
		void loadDir({ name: "", type: "dir", size: 0, path: "" } as FsTreeNode);
	}, [attachmentAddress]);

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

	const preview = <FilePreviewPane image={image} />;

	if (variant === "narrow") {
		return (
			<div className="flex min-h-0 flex-col gap-3" ref={split.containerRef} style={split.containerStyle}>
				<div className="min-h-0 flex-1">{tree}</div>
				{/* 预览在分隔条下侧（edge="after"）：分隔条下移 = 预览变矮 */}
				<PaneDivider axis="horizontal" edge="after" target={split.target} />
				<div className="shrink-0" ref={split.previewRef} style={{ height: `var(${FILE_SPLIT_VAR})` }}>
					{preview}
				</div>
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
