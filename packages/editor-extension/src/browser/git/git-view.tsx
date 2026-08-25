import { useEffect, useState } from "react";
import { getWireClient } from "../wire/client";
import type { GitBranchesResult, GitLogEntry, GitStatusResult } from "../wire/types";

interface GitSnapshot {
	status: GitStatusResult;
	diff: string;
	log: GitLogEntry[];
	branches: GitBranchesResult;
}

const panelStyle: React.CSSProperties = {
	padding: "12px",
	fontSize: "12px",
	lineHeight: 1.6,
	color: "var(--editor-foreground, #333)",
};

const sectionStyle: React.CSSProperties = { marginBottom: "14px" };

const sectionTitleStyle: React.CSSProperties = { fontWeight: 600, marginBottom: "4px" };

const monoStyle: React.CSSProperties = {
	fontFamily: "var(--monaco-monospace-font, monospace)",
	fontSize: "11px",
	whiteSpace: "pre-wrap",
	wordBreak: "break-all",
	background: "var(--editorWidget-background, #f7f7f7)",
	padding: "6px 8px",
	borderRadius: "3px",
	maxHeight: "220px",
	overflow: "auto",
};

const listStyle: React.CSSProperties = { listStyle: "none", padding: 0, margin: 0 };

const itemStyle: React.CSSProperties = {
	padding: "3px 0",
	borderBottom: "1px solid var(--editorWidget-border, #eee)",
};

const fieldStyle: React.CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: "4px",
	marginBottom: "8px",
};

const inputStyle: React.CSSProperties = {
	width: "100%",
	boxSizing: "border-box",
	padding: "4px 6px",
	fontSize: "12px",
	border: "1px solid var(--editorWidget-border, #ccc)",
	borderRadius: "2px",
};

const buttonStyle: React.CSSProperties = {
	alignSelf: "flex-start",
	padding: "4px 10px",
	fontSize: "12px",
	cursor: "pointer",
	border: "1px solid var(--button-border, #aaa)",
	borderRadius: "2px",
	background: "var(--button-background, #f4f4f4)",
};

/**
 * GitPanelView —— Git 面板（票 11）。
 *
 * 展示 status（分支/staged/unstaged/untracked）、diff、log、分支列表 —— 数据来自
 * wire git_* 命令。提交入口调 wire git_commit（serve 端实现，见补票）。
 */
export function GitPanelView(): React.JSX.Element {
	const wire = getWireClient();
	const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [commitMessage, setCommitMessage] = useState("");
	const [notice, setNotice] = useState<string | null>(null);

	const load = async () => {
		setError(null);
		try {
			const [status, diffRes, log, branches] = await Promise.all([
				wire.gitStatus(undefined),
				wire.gitDiff(undefined),
				wire.gitLog(undefined, 20),
				wire.gitBranches(undefined),
			]);
			setSnapshot({ status, diff: diffRes.diff, log: log.commits, branches });
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: mount 时加载一次（wire 为单例）
	useEffect(() => {
		wire.ensureConnected();
		void load();
	}, []);

	const commit = async () => {
		setNotice(null);
		setError(null);
		try {
			const res = await wire.gitCommit(commitMessage);
			if (res.committed) {
				setNotice(`已提交 ${res.hash?.slice(0, 8)}`);
				setCommitMessage("");
				void load();
			} else {
				setNotice(res.reason ?? "无可提交内容");
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	return (
		<div style={panelStyle}>
			<div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
				<span style={{ fontWeight: 600 }}>Git</span>
				<button type="button" style={buttonStyle} onClick={() => void load()}>
					刷新
				</button>
			</div>

			{error ? <div style={{ color: "var(--errorForeground, #c00)", marginBottom: "10px" }}>{error}</div> : null}

			{snapshot ? (
				<>
					<div style={sectionStyle}>
						<div style={sectionTitleStyle}>状态 · {snapshot.status.branch}</div>
						{snapshot.status.staged.length > 0 ? (
							<pre style={monoStyle}>staged：{snapshot.status.staged.join(", ")}</pre>
						) : null}
						{snapshot.status.unstaged.length > 0 ? (
							<pre style={monoStyle}>unstaged：{snapshot.status.unstaged.join(", ")}</pre>
						) : null}
						{snapshot.status.untracked.length > 0 ? (
							<pre style={monoStyle}>untracked：{snapshot.status.untracked.join(", ")}</pre>
						) : null}
						{snapshot.status.staged.length === 0 &&
						snapshot.status.unstaged.length === 0 &&
						snapshot.status.untracked.length === 0 ? (
							<div style={{ opacity: 0.7 }}>工作区干净</div>
						) : null}
					</div>

					<div style={sectionStyle}>
						<div style={sectionTitleStyle}>diff</div>
						{snapshot.diff ? (
							<pre style={monoStyle}>{snapshot.diff}</pre>
						) : (
							<div style={{ opacity: 0.7 }}>无改动</div>
						)}
					</div>

					<div style={sectionStyle}>
						<div style={sectionTitleStyle}>log</div>
						{snapshot.log.length === 0 ? (
							<div style={{ opacity: 0.7 }}>无 commit</div>
						) : (
							<ul style={listStyle}>
								{snapshot.log.slice(0, 10).map(c => (
									<li key={c.hash} style={itemStyle}>
										<div style={monoStyle}>
											{c.hash.slice(0, 7)} · {c.author} · {c.message}
										</div>
									</li>
								))}
							</ul>
						)}
					</div>

					<div style={sectionStyle}>
						<div style={sectionTitleStyle}>分支</div>
						<div style={{ opacity: 0.85 }}>
							当前：{snapshot.branches.current}
							{snapshot.branches.local.length > 0 ? ` · local：${snapshot.branches.local.join(", ")}` : ""}
						</div>
					</div>

					<div style={sectionStyle}>
						<div style={sectionTitleStyle}>提交</div>
						<div style={fieldStyle}>
							<textarea
								style={{ ...inputStyle, minHeight: "60px" }}
								value={commitMessage}
								onChange={e => setCommitMessage(e.target.value)}
								placeholder="commit message"
							/>
							<button type="button" style={buttonStyle} onClick={commit} disabled={!commitMessage}>
								提交
							</button>
						</div>
						{notice ? <div style={{ opacity: 0.8 }}>{notice}</div> : null}
					</div>
				</>
			) : error ? null : (
				<div style={{ opacity: 0.7 }}>加载中…</div>
			)}
		</div>
	);
}
