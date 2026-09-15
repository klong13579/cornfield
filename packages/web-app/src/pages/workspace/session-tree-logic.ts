import type { ChildSessionNodeDto, ChildSessionStatusDto } from "../../lib/pi-client-api";

/**
 * 会话树面板的显示逻辑（与渲染分离，便于按仓库既有 *-logic 惯例单测）。
 *
 * 这里只有一件真正有判断的事：**什么时候允许点「带回结果」**。
 * 它必须严格等于 serve 侧 `bring_back_child_result` 会成功的条件 —— 有结果指针、且还没带回；
 * 放宽一格，用户就会点到一个必然失败（或重复注入）的按钮。
 */

export const STATUS_LABEL: Record<ChildSessionStatusDto, string> = {
	running: "运行中",
	waiting_user: "等待你",
	completed: "已完成",
	failed: "失败",
	cancelled: "已取消",
};

export const STATUS_BADGE: Record<ChildSessionStatusDto, string> = {
	running: "badge run",
	waiting_user: "badge run",
	completed: "badge done",
	failed: "badge fail",
	cancelled: "badge",
};

export interface ResultState {
	label: string;
	/** 只有它为真时「带回结果」可用。 */
	canBringBack: boolean;
}

/** 结果状态：没有结果 / 结果就绪待带回 / 已带回（终态，不再可操作）。 */
export function resultStateOf(child: Pick<ChildSessionNodeDto, "resultRef" | "resultBroughtBackAt">): ResultState {
	if (!child.resultRef) return { label: "无结果", canBringBack: false };
	if (child.resultBroughtBackAt === undefined) return { label: "结果待带回", canBringBack: true };
	return { label: "已带回", canBringBack: false };
}

/** 相对时间（分钟粒度；跨天回落到日期）。 */
export function shortTime(epochMs: number, now: number = Date.now()): string {
	const minutes = Math.floor((now - epochMs) / 60_000);
	if (minutes < 1) return "刚刚";
	if (minutes < 60) return `${minutes} 分钟前`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} 小时前`;
	return new Date(epochMs).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}
