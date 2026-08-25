import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { getWireClient } from "../wire/client";
import { permissionStore } from "./permission-store";

/** 审批决策白名单（与 pi-wire permission_respond / web-app ApprovalCard 同一 schema）。 */
export type ApprovalChoice = "deny" | "once" | "session" | "always";

const overlayStyle: React.CSSProperties = {
	position: "fixed",
	right: "16px",
	bottom: "16px",
	width: "360px",
	maxWidth: "calc(100vw - 32px)",
	zIndex: 10000,
	display: "flex",
	flexDirection: "column",
	gap: "10px",
};

const cardStyle: React.CSSProperties = {
	background: "var(--editor-background, #fff)",
	border: "1px solid var(--editorWidget-border, #ddd)",
	borderRadius: "6px",
	boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
	padding: "12px",
	fontSize: "12px",
	lineHeight: 1.6,
	color: "var(--editor-foreground, #333)",
};

const headerStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: "6px", marginBottom: "8px" };

const cmdStyle: React.CSSProperties = {
	fontFamily: "var(--monaco-monospace-font, monospace)",
	fontSize: "11px",
	background: "var(--editorWidget-background, #f4f4f4)",
	padding: "6px 8px",
	borderRadius: "3px",
	marginBottom: "8px",
	wordBreak: "break-all",
};

const keysStyle: React.CSSProperties = { marginBottom: "10px", opacity: 0.85 };

const btnRowStyle: React.CSSProperties = { display: "flex", gap: "6px", flexWrap: "wrap" };

const buttonStyle: React.CSSProperties = {
	padding: "4px 10px",
	fontSize: "12px",
	cursor: "pointer",
	border: "1px solid var(--button-border, #aaa)",
	borderRadius: "3px",
	background: "var(--button-background, #f4f4f4)",
};

const denyButtonStyle: React.CSSProperties = {
	...buttonStyle,
	borderColor: "var(--errorForeground, #c00)",
	color: "var(--errorForeground, #c00)",
};

function ApprovalCard({
	command,
	description,
	patternKeys,
	onRespond,
	onDismiss,
}: {
	command: string;
	description: string;
	patternKeys: string[];
	onRespond: (choice: ApprovalChoice) => void;
	onDismiss: () => void;
}): React.JSX.Element {
	const tool = command.trim().split(/\s+/)[0] ?? "command";
	return (
		<div style={cardStyle}>
			<div style={headerStyle}>
				<span style={{ fontWeight: 600 }}>需要审批 · {tool}</span>
				<button type="button" style={{ ...buttonStyle, marginLeft: "auto" }} onClick={onDismiss} aria-label="收起">
					×
				</button>
			</div>
			<div style={cmdStyle}>{command}</div>
			<div style={keysStyle}>
				匹配规则：
				{patternKeys.map(k => (
					<code key={k}>{k} </code>
				))}
				{description ? ` · ${description}` : ""}
			</div>
			<div style={btnRowStyle}>
				<button type="button" style={denyButtonStyle} onClick={() => onRespond("deny")}>
					拒绝
				</button>
				<button type="button" style={buttonStyle} onClick={() => onRespond("once")}>
					本次放行
				</button>
				<button type="button" style={buttonStyle} onClick={() => onRespond("session")}>
					本会话放行
				</button>
				<button type="button" style={buttonStyle} onClick={() => onRespond("always")}>
					总是放行
				</button>
			</div>
		</div>
	);
}

function ClarifyCard({
	question,
	options,
	onAnswer,
	onDismiss,
}: {
	question: string;
	options: string[];
	onAnswer: (option: string) => void;
	onDismiss: () => void;
}): React.JSX.Element {
	return (
		<div style={cardStyle}>
			<div style={headerStyle}>
				<span style={{ fontWeight: 600 }}>需要澄清</span>
				<button type="button" style={{ ...buttonStyle, marginLeft: "auto" }} onClick={onDismiss} aria-label="收起">
					×
				</button>
			</div>
			<div style={{ marginBottom: "10px" }}>{question}</div>
			<div style={btnRowStyle}>
				{options.map(option => (
					<button key={option} type="button" style={buttonStyle} onClick={() => onAnswer(option)}>
						{option}
					</button>
				))}
			</div>
		</div>
	);
}

/**
 * PermissionHost —— 审批卡/澄清卡宿主（票 09）。
 *
 * 订阅 PermissionStore（由 wire permission_request push 驱动），以 body portal
 * 浮层渲染审批卡（approval）或澄清卡（clarify）；决策走 permission_respond，
 * 与 web-app PermissionHost 使用同一 schema（deny/once/session/always）。
 */
export function PermissionHost(): React.JSX.Element | null {
	const wire = getWireClient();
	const [pending, setPending] = useState(permissionStore.pending);

	useEffect(() => {
		return permissionStore.subscribe(() => setPending(permissionStore.pending));
	}, []);

	const respond = async (requestId: string, choice: string) => {
		permissionStore.clear();
		try {
			await wire.permissionRespond(requestId, choice);
		} catch {
			// 决策已发；serve 回首包失败仅表示超时/断链，UI 不再纠缠
		}
	};

	if (!pending) return null;

	const content =
		pending.kind === "approval" ? (
			<ApprovalCard
				command={pending.command}
				description={pending.description}
				patternKeys={pending.patternKeys}
				onRespond={choice => void respond(pending.requestId, choice)}
				onDismiss={() => permissionStore.clear()}
			/>
		) : (
			<ClarifyCard
				question={pending.question}
				options={pending.options}
				onAnswer={option => void respond(pending.requestId, option)}
				onDismiss={() => permissionStore.clear()}
			/>
		);

	return createPortal(<div style={overlayStyle}>{content}</div>, document.body);
}
