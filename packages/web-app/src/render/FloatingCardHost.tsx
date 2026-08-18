import { PermissionHost } from "./PermissionHost";
import "./float-card.css";

/**
 * FloatingCardHost —— 审批/澄清浮层卡的 composer 上方挂载容器（P2-W2-1）。
 *
 * 它是 W1 在 composer 上方的挂载出口：把本组件放在 composer 容器内（其自身即
 * `position:relative` 锚点），内部由 PermissionHost 读 store.pendingPermission →
 * 渲染 ApprovalCard/ClarifyCard（`float-card` 绝对定位 bottom 锚定，从 composer 顶部滑入）。
 * 无 pending 时 PermissionHost 返回 null，容器零视觉占用。
 */
export function FloatingCardHost({ className = "" }: { className?: string }): React.JSX.Element {
	return (
		<div className={`floating-card-host${className ? ` ${className}` : ""}`}>
			<PermissionHost />
		</div>
	);
}
