import type { AgentMessageDto, WireSessionIndexEntry } from "@oh-my-pi/pi-wire";
import { useEffect, useState } from "react";
import { getWireClient } from "../wire/client";

const panelStyle: React.CSSProperties = {
	padding: "12px",
	fontSize: "12px",
	lineHeight: 1.6,
	color: "var(--editor-foreground, #333)",
};

const sessionRowStyle: React.CSSProperties = {
	padding: "6px 8px",
	borderBottom: "1px solid var(--editorWidget-border, #eee)",
	cursor: "pointer",
	borderRadius: "3px",
};

const entryStyle: React.CSSProperties = {
	marginBottom: "8px",
	padding: "8px",
	borderRadius: "4px",
	borderLeft: "3px solid var(--editorWidget-border, #ccc)",
	background: "var(--editorWidget-background, #fafafa)",
};

const roleBadgeStyle: React.CSSProperties = {
	fontSize: "10px",
	padding: "1px 6px",
	borderRadius: "8px",
	marginRight: "6px",
	color: "#fff",
};

const thinkingStyle: React.CSSProperties = {
	fontSize: "11px",
	color: "var(--descriptionForeground, #888)",
	fontStyle: "italic",
	whiteSpace: "pre-wrap",
	wordBreak: "break-all",
	margin: "2px 0",
};

const textStyle: React.CSSProperties = { whiteSpace: "pre-wrap", wordBreak: "break-all" };

const toolStyle: React.CSSProperties = {
	fontFamily: "var(--monaco-monospace-font, monospace)",
	fontSize: "11px",
	background: "var(--editor-background, #fff)",
	borderRadius: "3px",
	padding: "4px 6px",
	margin: "2px 0",
	wordBreak: "break-all",
};

const badgeColor: Record<string, string> = {
	user: "#1a73e8",
	assistant: "#188038",
	tool: "#b06000",
	system: "#5f6368",
};

function summarize(text: string, limit = 160): string {
	if (!text) return "";
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** content 块渲染（text / thinking / tool_use / tool_result）。 */
function ContentBlock({ block }: { block: Record<string, unknown> }): React.JSX.Element {
	const type = (block.type as string) ?? "text";
	if (type === "thinking") {
		return <div style={thinkingStyle}>💭 {summarize(String(block.thinking ?? ""), 400)}</div>;
	}
	if (type === "tool_use") {
		const input = block.input as Record<string, unknown> | undefined;
		return (
			<div style={toolStyle}>
				🔧 {String(block.name ?? "")}({input ? summarize(JSON.stringify(input)) : ""})
			</div>
		);
	}
	const text = String(block.text ?? block.content ?? "");
	return <div style={textStyle}>{text}</div>;
}

/** 单条消息时间线条目。 */
function TraceEntry({ message, index }: { message: AgentMessageDto; index: number }): React.JSX.Element {
	const role = (message.role as string) ?? "system";
	const isTool = role === "toolResult" || role === "tool";
	const badge = isTool ? "tool" : role;
	const toolName = "toolName" in message ? String(message.toolName ?? "") : "";
	const content = Array.isArray(message.content) ? message.content : message.content ? [message.content] : [];
	return (
		<div style={entryStyle}>
			<div style={{ marginBottom: "2px" }}>
				<span style={{ ...roleBadgeStyle, background: badgeColor[badge] ?? "#5f6368" }}>{index}</span>
				<span style={{ fontWeight: 600 }}>{isTool ? `工具 ${toolName}` : role}</span>
			</div>
			{isTool ? (
				<div style={toolStyle}>{summarize(String(message.content ?? ""), 300)}</div>
			) : (
				content.map((block, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: 内容块无稳定 id（静态渲染列表）
					<ContentBlock key={i} block={block as Record<string, unknown>} />
				))
			)}
		</div>
	);
}

/**
 * TraceView —— 追溯台（B4，User Story 23）。
 *
 * 会话/工具调用/决策依据回放：会话列表（wire list_sessions）→ 选中后时间线渲染
 * （wire get_session_messages：user/assistant/toolResult + thinking 折叠）。
 */
export function TraceView(): React.JSX.Element {
	const wire = getWireClient();
	const [sessions, setSessions] = useState<WireSessionIndexEntry[] | null>(null);
	const [selected, setSelected] = useState<WireSessionIndexEntry | null>(null);
	const [messages, setMessages] = useState<AgentMessageDto[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: mount 时加载一次（wire 为单例）
	useEffect(() => {
		wire.ensureConnected();
		let cancelled = false;
		void (async () => {
			try {
				const res = await wire.listSessions(undefined, 20);
				if (!cancelled) setSessions(res.sessions);
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const openSession = (session: WireSessionIndexEntry): void => {
		setSelected(session);
		setMessages(null);
		setError(null);
		void (async () => {
			try {
				const res = await wire.getSessionMessages(session.sessionFile);
				setMessages(res.messages);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		})();
	};

	if (error && !selected) {
		return (
			<div style={panelStyle}>
				<div style={{ fontWeight: 600, marginBottom: "8px" }}>追溯台</div>
				<div style={{ color: "var(--errorForeground, #c00)" }}>{error}</div>
			</div>
		);
	}

	if (!sessions) {
		return (
			<div style={panelStyle}>
				<div style={{ fontWeight: 600, marginBottom: "8px" }}>追溯台</div>
				<div style={{ opacity: 0.7 }}>加载中…</div>
			</div>
		);
	}

	return (
		<div style={panelStyle}>
			<div style={{ fontWeight: 600, marginBottom: "8px" }}>追溯台</div>
			{selected ? (
				<>
					<button
						type="button"
						style={{
							marginBottom: "8px",
							padding: "2px 8px",
							cursor: "pointer",
							border: "1px solid var(--button-border, #aaa)",
							borderRadius: "3px",
							background: "var(--button-background, #f4f4f4)",
							fontSize: "11px",
						}}
						onClick={() => setSelected(null)}
					>
						← 返回列表
					</button>
					<div style={{ marginBottom: "10px" }}>
						<div style={{ fontWeight: 600 }}>{selected.title ?? selected.sessionId}</div>
						<div style={{ opacity: 0.65, fontSize: "11px" }}>
							{selected.agentName} · {new Date(selected.startTime).toLocaleString()} · {selected.status}
						</div>
					</div>
					{!messages ? (
						<div style={{ opacity: 0.7 }}>加载会话…</div>
					) : messages.length === 0 ? (
						<div style={{ opacity: 0.7 }}>无消息</div>
					) : (
						messages.map((m, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: 会话消息无稳定 id（静态时间线）
							<TraceEntry key={i} message={m} index={i + 1} />
						))
					)}
				</>
			) : (
				<>
					{sessions.length === 0 ? (
						<div style={{ opacity: 0.7 }}>暂无会话</div>
					) : (
						sessions.map(session => (
							<button
								type="button"
								key={session.sessionFile}
								style={{
									...sessionRowStyle,
									textAlign: "left",
									width: "100%",
									background: "none",
									border: "none",
									color: "inherit",
								}}
								onClick={() => openSession(session)}
							>
								<div>{session.title ?? session.sessionId}</div>
								<div style={{ opacity: 0.65, fontSize: "11px" }}>
									{session.agentName} · {new Date(session.startTime).toLocaleString()} · {session.messageCount}{" "}
									条
								</div>
							</button>
						))
					)}
				</>
			)}
		</div>
	);
}
