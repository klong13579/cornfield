import { ShieldAlert, X } from "lucide-react";
import { useState } from "react";
import "./float-card.css";

/**
 * ApprovalCard —— 危险命令审批浮层卡（R6·UI 壳）。视觉基准：v8 `.float-card`/`.fc-inner`。
 *
 * 协议形状（permission_request push 到时通电）：
 *   <ApprovalCard
 *     command="git push origin main --force-with-lease"
 *     description="本会话已放行 2 条"
 *     patternKeys={["git push --force*"]}
 *     onRespond={(choice) => …}   // choice: deny | once | session | always
 *   />
 * 渲染位置由父层决定：放在 `position:relative` 的 composer 容器内，卡从 composer
 * 上方滑入（.float-card 绝对定位 bottom 锚定）。数据当前用组件默认 demo 值。
 */
export type ApprovalChoice = "deny" | "once" | "session";

export interface ApprovalCardProps {
	/** 待审批命令（默认 demo）。 */
	command?: string;
	/** 辅助说明，如已放行条数（默认 demo）。 */
	description?: string;
	/** 命中的审批规则 keys（默认 demo）。 */
	patternKeys?: string[];
	/** 用户裁决回调（deny/once/session/always）。 */
	onRespond?: (choice: ApprovalChoice) => void;
	/** 收起（不裁决），可选。 */
	onDismiss?: () => void;
	className?: string;
}

const DEMO_COMMAND = "git push origin main --force-with-lease";
const DEMO_DESCRIPTION = "本会话已放行 2 条";
const DEMO_KEYS = ["git push --force*"];

const BUTTONS: { choice: ApprovalChoice; label: string; kind: "deny" | "plain" }[] = [
	{ choice: "deny", label: "拒绝", kind: "deny" },
	{ choice: "once", label: "本次放行", kind: "plain" },
	{ choice: "session", label: "本会话放行", kind: "plain" },
];

export function ApprovalCard({
	command = DEMO_COMMAND,
	description = DEMO_DESCRIPTION,
	patternKeys = DEMO_KEYS,
	onRespond,
	onDismiss,
	className = "",
}: ApprovalCardProps): React.JSX.Element | null {
	const [hidden, setHidden] = useState(false);
	if (hidden) return null;

	const tool = command.trim().split(/\s+/)[0] ?? "shell";
	const respond = (choice: ApprovalChoice) => {
		onRespond?.(choice);
		setHidden(true);
	};

	return (
		<div className={`float-card${className ? ` ${className}` : ""}`}>
			<div className="fc-inner">
				<div className="fc-header fc-header--err">
					<ShieldAlert size={15} strokeWidth={1.6} />
					<span>需要审批 · {tool}</span>
					<button
						type="button"
						className="fc-dismiss"
						aria-label="收起"
						title="收起"
						onClick={() => {
							onDismiss?.();
							setHidden(true);
						}}
					>
						<X size={13} strokeWidth={1.6} />
					</button>
				</div>
				<div className="fc-cmd">{command}</div>
				<div className="fc-keys">
					匹配规则
					{patternKeys.map(key => (
						<code key={key}>{key}</code>
					))}
					<span> · {description}</span>
				</div>
				<div className="fc-btns">
					{BUTTONS.map(b => (
						<button
							key={b.choice}
							type="button"
							className={`abtn${b.kind === "deny" ? " deny" : ""}`}
							onClick={() => respond(b.choice)}
						>
							{b.label}
						</button>
					))}
				</div>
			</div>
		</div>
	);
}
