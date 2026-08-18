import { useSessionStore } from "../state/session-store";
import { useSession } from "../state/use-session";
import { ApprovalCard } from "./ApprovalCard";
import { ClarifyCard } from "./ClarifyCard";

/**
 * PermissionHost —— 权限请求渲染出口（R6 通电）。
 *
 * 消费 store.pendingPermission（permission_request push 驱动），按 kind 渲染
 * ApprovalCard / ClarifyCard；裁决/澄清走 store.permissionRespond（→ permission_respond 命令）。
 * W1 在 composer 上方（position:relative 容器内）挂载本组件即可，卡从 composer 顶部滑入。
 */
export function PermissionHost({ className = "" }: { className?: string }): React.JSX.Element | null {
	const view = useSession();
	const store = useSessionStore();
	const pending = view.pendingPermission;

	if (!pending) return null;

	if (pending.kind === "approval") {
		return (
			<ApprovalCard
				command={pending.command}
				description={pending.description}
				patternKeys={pending.patternKeys}
				onRespond={choice => store.permissionRespond(pending.requestId, choice)}
				className={className}
			/>
		);
	}

	return (
		<ClarifyCard
			question={pending.question}
			options={pending.options}
			onAnswer={option => store.permissionRespond(pending.requestId, option)}
			className={className}
		/>
	);
}
