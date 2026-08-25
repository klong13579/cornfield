import { useEffect, useState } from "react";
import { getWireClient } from "../wire/client";
import { type DiffReviewItem, diffReviewStore } from "./diff-review-store";

const panelStyle: React.CSSProperties = {
	padding: "12px",
	fontSize: "12px",
	lineHeight: 1.6,
	color: "var(--editor-foreground, #333)",
};

const itemStyle: React.CSSProperties = {
	border: "1px solid var(--editorWidget-border, #ddd)",
	borderRadius: "3px",
	padding: "10px",
	marginBottom: "10px",
};

const pathStyle: React.CSSProperties = { fontWeight: 600, marginBottom: "6px", wordBreak: "break-all" };

const diffStyle: React.CSSProperties = {
	fontFamily: "var(--monaco-monospace-font, monospace)",
	fontSize: "11px",
	whiteSpace: "pre-wrap",
	background: "var(--editor-background, #fafafa)",
	padding: "8px",
	borderRadius: "2px",
	maxHeight: "320px",
	overflow: "auto",
};

const buttonStyle: React.CSSProperties = {
	padding: "3px 10px",
	fontSize: "12px",
	cursor: "pointer",
	marginRight: "6px",
	border: "1px solid var(--button-border, #aaa)",
	borderRadius: "2px",
	background: "var(--button-background, #f4f4f4)",
};

const textareaStyle: React.CSSProperties = {
	width: "100%",
	minHeight: "140px",
	boxSizing: "border-box",
	fontFamily: "var(--monaco-monospace-font, monospace)",
	fontSize: "11px",
	padding: "6px",
	border: "1px solid var(--editorWidget-border, #ccc)",
	borderRadius: "2px",
};

const fieldStyle: React.CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: "4px",
	marginBottom: "10px",
};

const inputStyle: React.CSSProperties = {
	width: "100%",
	boxSizing: "border-box",
	padding: "4px 6px",
	fontSize: "12px",
	border: "1px solid var(--editorWidget-border, #ccc)",
	borderRadius: "2px",
};
function DiffReviewItemRow({ item }: { item: DiffReviewItem }): React.JSX.Element {
	const wire = getWireClient();
	const [diff, setDiff] = useState<string>("");
	const [editing, setEditing] = useState(false);
	const [editedAfter, setEditedAfter] = useState(item.after);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: 按 item.id 重载，wire 为单例
	useEffect(() => {
		let cancelled = false;
		void wire
			.fsDiff({ before: item.before, after: item.after })
			.then(d => {
				if (!cancelled) setDiff(d);
			})
			.catch(err => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			cancelled = true;
		};
	}, [item.id]);

	const accept = async () => {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			// 冲突检测：接受前确认磁盘内容仍是 before，避免静默覆盖用户/agent 的并发改动。
			const current = await wire.fsRead(undefined, item.path);
			if (current.truncated) {
				setError("文件超过 128KB，无法精确检测冲突，已中止接受");
				return;
			}
			if (current.text !== item.before) {
				setNotice("冲突：文件在审阅期间已被修改，未落地。请重新审阅后再接受。");
				return;
			}
			await wire.fsWrite(undefined, item.path, item.after);
			diffReviewStore.remove(item.id);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const reject = () => {
		diffReviewStore.remove(item.id);
	};

	const saveEdited = async () => {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			await wire.fsWrite(undefined, item.path, editedAfter);
			diffReviewStore.remove(item.id);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div style={itemStyle}>
			<div style={pathStyle}>{item.path}</div>
			{item.description ? <div style={{ marginBottom: "6px", opacity: 0.7 }}>{item.description}</div> : null}
			{diff ? <pre style={diffStyle}>{diff}</pre> : error ? null : <div>计算 diff…</div>}
			{editing ? (
				<div style={{ marginTop: "8px" }}>
					<textarea style={textareaStyle} value={editedAfter} onChange={e => setEditedAfter(e.target.value)} />
					<div style={{ marginTop: "6px" }}>
						<button type="button" style={buttonStyle} onClick={saveEdited} disabled={busy}>
							保存修改后接受
						</button>
						<button type="button" style={buttonStyle} onClick={() => setEditing(false)} disabled={busy}>
							取消
						</button>
					</div>
				</div>
			) : (
				<div style={{ marginTop: "8px" }}>
					<button type="button" style={buttonStyle} onClick={accept} disabled={busy}>
						接受
					</button>
					<button type="button" style={buttonStyle} onClick={reject} disabled={busy}>
						拒绝
					</button>
					<button type="button" style={buttonStyle} onClick={() => setEditing(true)} disabled={busy}>
						修改后接受
					</button>
				</div>
			)}
			{notice ? <div style={{ marginTop: "6px", color: "var(--warningForeground, #960)" }}>{notice}</div> : null}
			{error ? <div style={{ marginTop: "6px", color: "var(--errorForeground, #c00)" }}>{error}</div> : null}
		</div>
	);
}

function NewReviewForm(): React.JSX.Element {
	const wire = getWireClient();
	const [open, setOpen] = useState(false);
	const [path, setPath] = useState("");
	const [before, setBefore] = useState("");
	const [after, setAfter] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const loadBefore = async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await wire.fsRead(undefined, path);
			setBefore(res.text);
			if (!after) setAfter(res.text);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const submit = () => {
		if (!path) return;
		diffReviewStore.submit({ path, before, after });
		setPath("");
		setBefore("");
		setAfter("");
		setOpen(false);
	};

	if (!open) {
		return (
			<button type="button" style={buttonStyle} onClick={() => setOpen(true)}>
				新建审阅
			</button>
		);
	}

	return (
		<div style={{ ...itemStyle, marginTop: "8px" }}>
			<div style={fieldStyle}>
				<label htmlFor="omp-diff-path">文件路径（agentDir 相对路径）</label>
				<input id="omp-diff-path" style={inputStyle} value={path} onChange={e => setPath(e.target.value)} />
				<button type="button" style={buttonStyle} onClick={loadBefore} disabled={busy || !path}>
					读取当前内容
				</button>
			</div>
			<div style={fieldStyle}>
				<label htmlFor="omp-diff-after">改动后内容</label>
				<textarea
					id="omp-diff-after"
					style={textareaStyle}
					value={after}
					onChange={e => setAfter(e.target.value)}
				/>
			</div>
			<button type="button" style={buttonStyle} onClick={submit} disabled={!path}>
				提交审阅
			</button>
			<button type="button" style={buttonStyle} onClick={() => setOpen(false)}>
				取消
			</button>
			{error ? <div style={{ marginTop: "6px", color: "var(--errorForeground, #c00)" }}>{error}</div> : null}
		</div>
	);
}

/**
 * DiffReviewView —— diff 审阅（票 08）。
 *
 * 订阅 DiffReviewStore，逐项渲染 agent 改动 diff；接受（冲突检测 + fs_write）、
 * 拒绝（丢弃）、修改后接受（编辑 after 后 fs_write）。
 */
export function DiffReviewView(): React.JSX.Element {
	const [items, setItems] = useState<readonly DiffReviewItem[]>(diffReviewStore.items);

	useEffect(() => {
		return diffReviewStore.subscribe(() => setItems([...diffReviewStore.items]));
	}, []);

	return (
		<div style={panelStyle}>
			<div style={{ marginBottom: "8px", fontWeight: 600 }}>diff 审阅</div>
			<NewReviewForm />
			{items.length === 0 ? (
				<div style={{ marginTop: "8px", opacity: 0.7 }}>暂无待审改动</div>
			) : (
				<div style={{ marginTop: "8px" }}>
					{items.map(item => (
						<DiffReviewItemRow key={item.id} item={item} />
					))}
				</div>
			)}
		</div>
	);
}
