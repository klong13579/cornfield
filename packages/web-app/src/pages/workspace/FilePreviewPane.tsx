import { useEffect, useRef, useState } from "react";
import { selectionLineRange } from "../../lib/context-items";
import type { OpenFile } from "../../state/file-workflow-store";
import { getFileWorkflow, useFileWorkflow } from "../../state/file-workflow-store";
import { DiffView } from "./DiffView";

/**
 * 文件预览 / 编辑面板（右栏与 Agent 详情页共用）。
 *
 * 一个文件只有一种打开状态：内容、草稿、归属都在 file-workflow store 里，本组件只做三件事 ——
 * 把 store 的状态摆出来、把用户动作转成 store 调用、读 textarea 的选区偏移。
 * 组件自己不碰 fs_read/fs_write：否则就等于存在第二套文件编辑 runtime。
 */

/** 截断读数的说明（fs_read 的 128KB 上限；只读降级的理由必须写在脸上）。 */
const TRUNCATED_HINT = "文件超过 128KB，只读到前段";

interface PreviewImage {
	path: string;
	dataUrl: string;
}

export function FilePreviewPane({ image }: { image: PreviewImage | null }): React.JSX.Element {
	const flow = useFileWorkflow();
	const open = flow.open;

	if (flow.diff) {
		return <DiffView review={flow.diff} onClose={() => getFileWorkflow().closeDiff()} />;
	}
	if (open) return <OpenFilePane open={open} pending={flow.pendingOpen !== null} />;
	if (image) {
		return (
			<div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-hairline bg-surface px-4 py-3">
				<div className="mb-2 shrink-0 truncate font-mono text-[12px] text-ink">{image.path}</div>
				<div className="min-h-0 flex-1 overflow-auto">
					<img
						src={image.dataUrl}
						alt={image.path}
						className="block max-w-full rounded-md border border-hairline"
					/>
				</div>
			</div>
		);
	}
	return (
		<div className="flex h-full min-h-0 flex-col items-center justify-center rounded-lg border border-hairline bg-surface px-4 py-3">
			<div className="text-[12px] text-ink-faint">点击左侧目录展开，点文件查看或编辑</div>
		</div>
	);
}

function OpenFilePane({ open, pending }: { open: OpenFile; pending: boolean }): React.JSX.Element {
	const store = getFileWorkflow();
	/** 当前选区（按钮文案用）+ 它是否已经作为上下文项加进去了（避免重复点击与文案误导）。 */
	const [selection, setSelection] = useState<{ label: string; added: boolean } | null>(null);
	const textRef = useRef<HTMLTextAreaElement>(null);

	// 换文件/换会话后上一次的选区就没意义了（它指向的是别处的行号）
	useEffect(() => {
		setSelection(null);
	}, [open.path, open.agentId]);

	const readSelection = (): void => {
		const el = textRef.current;
		if (!el) return;
		const start = el.selectionStart ?? 0;
		const end = el.selectionEnd ?? 0;
		if (end <= start || el.value.slice(start, end).trim().length === 0) {
			setSelection(null);
			return;
		}
		// 行号用与入库同一条规则算（context-items.selectionLineRange）：摆在按钮上的范围
		// 与实际发给 Agent 的范围必须来自同一处，否则用户点到的是第 12-20 行、发出去的是别的。
		const { lineStart, lineEnd } = selectionLineRange(el.value, start, end);
		setSelection({
			label: lineStart === lineEnd ? `第 ${lineStart} 行` : `第 ${lineStart}-${lineEnd} 行`,
			added: false,
		});
	};

	const addSelection = (): void => {
		const el = textRef.current;
		if (!el) return;
		const added = store.addSelectionFromOffsets(open.path, el.value, el.selectionStart ?? 0, el.selectionEnd ?? 0);
		setSelection(prev => (added ? (prev ? { ...prev, added: true } : prev) : null));
	};

	const canEdit = !open.readOnly && !open.orphaned;

	return (
		<div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-hairline bg-surface">
			{/* 顶栏：路径 + 状态 + 动作 */}
			<div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline px-3 py-2">
				<span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink" title={open.path}>
					{open.path}
				</span>
				{open.readOnly && (
					<span className="badge run shrink-0" title={TRUNCATED_HINT}>
						只读 · 已截断
					</span>
				)}
				{open.dirty && <span className="badge run shrink-0">未保存</span>}
				{open.conflict && <span className="badge fail shrink-0">冲突</span>}
				<div className="flex shrink-0 items-center gap-1">
					<button
						type="button"
						className="btn btn-sm"
						disabled={!open.dirty || !canEdit}
						onClick={() => store.save()}
					>
						保存
					</button>
					<button type="button" className="btn-ghost" disabled={!open.dirty} onClick={() => store.revertDraft()}>
						撤销
					</button>
					<button
						type="button"
						className="btn-ghost"
						disabled={open.dirty}
						title={open.dirty ? "有未保存修改：先保存或撤销，再重新加载" : "从磁盘重读这份文件"}
						onClick={() => store.reload()}
					>
						重新加载
					</button>
					<button
						type="button"
						className="btn-ghost"
						disabled={!open.dirty}
						onClick={() => void store.openDraftDiff()}
					>
						查看差异
					</button>
					<button type="button" className="btn-ghost" onClick={() => store.addFileContext(open.path)}>
						+ 上下文
					</button>
				</div>
			</div>

			{/* 带未保存修改换文件：丢掉草稿必须是用户自己说的 */}
			{pending && (
				<div className="flex shrink-0 items-center gap-2 border-b border-hairline bg-surface-2 px-3 py-2 text-[12px] text-ink-muted">
					<span className="flex-1">当前文件有未保存的修改，切换文件会放弃这些修改。</span>
					<button type="button" className="btn btn-sm" onClick={() => store.confirmPendingOpen()}>
						放弃并打开
					</button>
					<button type="button" className="btn-ghost" onClick={() => store.cancelPendingOpen()}>
						取消
					</button>
				</div>
			)}

			{/* 冲突：保存被拒绝，没有写任何东西；两份内容由用户裁决 */}
			{open.conflict && (
				<div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-danger/40 bg-danger/5 px-3 py-2 text-[12px] text-danger">
					<span className="min-w-0 flex-1" title={open.conflict.detail}>
						保存被拒绝：文件在磁盘上已被改写（未写入任何内容）。当前草稿与磁盘版本不同，请选择保留哪一份。
					</span>
					<button type="button" className="btn-ghost" onClick={() => void store.openConflictDiff()}>
						看磁盘差异
					</button>
					<button type="button" className="btn btn-secondary btn-sm" onClick={() => store.acceptDisk()}>
						保留磁盘版本
					</button>
					<button type="button" className="btn btn-danger btn-sm" onClick={() => store.overwriteWithDraft()}>
						用我的覆盖
					</button>
				</div>
			)}

			{/* 会话已切换：路径不再指向同一个文件，保存关闭（草稿留在屏幕上，不静默丢） */}
			{open.orphaned && (
				<div className="flex shrink-0 items-center gap-2 border-b border-hairline bg-surface-2 px-3 py-2 text-[12px] text-ink-muted">
					<span className="flex-1">
						会话已切换：这份草稿属于上一个会话的文件路径，保存已关闭。可复制内容后放弃。
					</span>
					<button type="button" className="btn btn-sm" onClick={() => store.discardOrphan()}>
						放弃修改并关闭
					</button>
				</div>
			)}

			{!open.conflict && !open.orphaned && open.externalUpdate && (
				<div className="shrink-0 border-b border-hairline bg-surface-2 px-3 py-1.5 text-[11px] text-ink-subtle">
					磁盘上的内容在本会话期间被改写，视图已同步到新版本。
				</div>
			)}

			{open.error && (
				<div className="shrink-0 border-b border-danger/40 bg-danger/5 px-3 py-1.5 text-[12px] text-danger">
					{open.error}
				</div>
			)}

			{open.loading ? (
				<div className="flex flex-col gap-2 p-3">
					{[0, 1, 2, 3, 4, 5].map(i => (
						<div key={i} className="skeleton h-4 w-full" style={{ width: `${90 - i * 9}%` }} />
					))}
				</div>
			) : (
				<textarea
					ref={textRef}
					value={open.draft}
					readOnly={!canEdit}
					spellCheck={false}
					aria-label={`编辑 ${open.path}`}
					onChange={e => store.edit(e.target.value)}
					onSelect={readSelection}
					className="min-h-0 w-full flex-1 resize-none border-none bg-transparent px-3 py-2 font-mono text-[12px] leading-[1.6] text-ink-muted outline-none"
				/>
			)}

			<div className="flex shrink-0 items-center gap-2 border-t border-hairline px-3 py-1.5">
				<button type="button" className="btn-ghost" disabled={!selection || selection.added} onClick={addSelection}>
					{!selection
						? "选中文本后可加入上下文"
						: selection.added
							? `已加入上下文（${selection.label}）`
							: `将选区加入上下文（${selection.label}）`}
				</button>
				{open.readOnly && <span className="text-[11px] text-ink-faint">{TRUNCATED_HINT}——不能整段写回</span>}
			</div>
		</div>
	);
}
