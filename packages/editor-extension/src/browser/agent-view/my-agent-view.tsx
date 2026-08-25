import type { MemoryProjectionDto, SessionListEntry, SkillDto, WireSessionIndexEntry } from "@oh-my-pi/pi-wire";
import { useEffect, useState } from "react";
import { getWireClient } from "../wire/client";

interface AgentSnapshot {
	agents: SessionListEntry[];
	memory: MemoryProjectionDto | null;
	skills: SkillDto[];
	sessions: WireSessionIndexEntry[];
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
	maxHeight: "160px",
	overflow: "auto",
};

const listStyle: React.CSSProperties = { listStyle: "none", padding: 0, margin: 0 };

const itemStyle: React.CSSProperties = {
	padding: "3px 0",
	borderBottom: "1px solid var(--editorWidget-border, #eee)",
	display: "flex",
	justifyContent: "space-between",
	gap: "8px",
};

const buttonStyle: React.CSSProperties = {
	padding: "4px 10px",
	fontSize: "12px",
	cursor: "pointer",
	border: "1px solid var(--button-border, #aaa)",
	borderRadius: "3px",
	background: "var(--button-background, #f4f4f4)",
};

const phaseLabel: Record<string, string> = {
	idle: "空闲",
	streaming: "流式输出中",
	compacting: "压缩中",
	retrying: "重试中",
	executing_tool: "执行工具中",
};

function summarize(text: string | undefined, limit = 200): string {
	if (!text) return "（无）";
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * MyAgentView —— 我的 agent 轻视图（票 10）。
 *
 * 数据全部来自 omp 平台（wire list_agents / get_memory / get_skills / list_sessions），
 * 壳内不建第二份存储。默认员工角色（role 注入骨架）。
 */
export function MyAgentView(): React.JSX.Element {
	const wire = getWireClient();
	const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: mount 时加载一次（wire 为单例）
	useEffect(() => {
		wire.ensureConnected();
		let cancelled = false;
		void (async () => {
			try {
				const [agentsRes, memory, skillsRes, sessionsRes] = await Promise.all([
					wire.listAgents(),
					wire.getMemory().catch(() => null),
					wire.getSkills().catch(() => ({ skills: [], disabled: [] })),
					wire.listSessions(undefined, 10).catch(() => ({ sessions: [] })),
				]);
				if (cancelled) return;
				setSnapshot({
					agents: agentsRes.agents,
					memory,
					skills: skillsRes.skills,
					sessions: sessionsRes.sessions,
				});
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	if (error) {
		return (
			<div style={panelStyle}>
				<div style={{ fontWeight: 600, marginBottom: "8px" }}>我的 agent</div>
				<div style={{ color: "var(--errorForeground, #c00)" }}>{error}</div>
			</div>
		);
	}

	if (!snapshot) {
		return (
			<div style={panelStyle}>
				<div style={{ fontWeight: 600, marginBottom: "8px" }}>我的 agent</div>
				<div style={{ opacity: 0.7 }}>加载中…</div>
			</div>
		);
	}

	const agent = snapshot.agents.find(a => a.active) ?? snapshot.agents[0];
	const userProfile = snapshot.memory?.user?.content;

	return (
		<div style={panelStyle}>
			<div style={{ fontWeight: 600, marginBottom: "8px" }}>我的 agent</div>

			<div style={sectionStyle}>
				<div style={sectionTitleStyle}>状态</div>
				{agent ? (
					<div>
						<div style={{ marginBottom: "2px" }}>
							{agent.name ?? agent.id} · {phaseLabel[agent.phase ?? "idle"] ?? agent.phase ?? "空闲"}
						</div>
						<div style={{ opacity: 0.75 }}>
							{agent.role ? `角色：${agent.role} · ` : ""}
							{agent.model ? `模型：${agent.model.provider}/${agent.model.id}` : "未 attach"}
							{agent.skillCount !== undefined ? ` · ${agent.skillCount} 技能` : ""}
						</div>
					</div>
				) : (
					<div style={{ opacity: 0.7 }}>暂无 agent</div>
				)}
			</div>

			<div style={sectionStyle}>
				<div style={sectionTitleStyle}>知识库</div>
				{snapshot.skills.length === 0 ? (
					<div style={{ opacity: 0.7 }}>（无）</div>
				) : (
					<ul style={listStyle}>
						{snapshot.skills.slice(0, 8).map(skill => (
							<li key={skill.name} style={itemStyle}>
								<span>{skill.name}</span>
								<span style={{ opacity: 0.6 }}>{skill.level}</span>
							</li>
						))}
					</ul>
				)}
			</div>

			<div style={sectionStyle}>
				<div style={sectionTitleStyle}>画像</div>
				<pre style={monoStyle}>{summarize(userProfile)}</pre>
			</div>

			<div style={sectionStyle}>
				<div style={sectionTitleStyle}>近期任务</div>
				{snapshot.sessions.length === 0 ? (
					<div style={{ opacity: 0.7 }}>（无）</div>
				) : (
					<ul style={listStyle}>
						{snapshot.sessions.slice(0, 6).map(session => (
							<li key={session.sessionId} style={itemStyle}>
								<span>{session.title ?? session.sessionId}</span>
								<span style={{ opacity: 0.6 }}>{session.status}</span>
							</li>
						))}
					</ul>
				)}
			</div>

			<div style={sectionStyle}>
				<div style={sectionTitleStyle}>对话入口</div>
				<button
					type="button"
					style={buttonStyle}
					onClick={() => {
						// 打开 OpenSumi Agentic 对话（AI Chat 视图），进入 agent 会话。
						window.dispatchEvent(new CustomEvent("omp:open-agent-chat"));
					}}
				>
					与我的 agent 对话
				</button>
			</div>
		</div>
	);
}
