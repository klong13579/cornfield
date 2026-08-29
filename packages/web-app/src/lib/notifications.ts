/**
 * B7-1 浏览器通知（零后端）：Notification API + localStorage 持久化开关。
 *
 * 语义：
 * - 仅「页面不在前台」时通知（document.visibilityState hidden/prerender）——前台不打扰
 * - 权限：首次触发时 request（toggle 开启 = 用户手势内授权）；拒绝后不再打扰（desc 提示）
 * - 三个开关：agentDone（Agent 完成）/ errors（出错告警）/ cron（定时任务）
 * - 钉钉推送通道不做（gateway 侧另一个故事，B7 缺口记录保留）
 */

export interface NotifyPrefs {
	agentDone: boolean;
	errors: boolean;
	cron: boolean;
}

const PREFS_KEY = "cornfield.notify.prefs";

export const NOTIFY_PREFS_DEFAULTS: NotifyPrefs = { agentDone: true, errors: true, cron: true };

export function loadNotifyPrefs(): NotifyPrefs {
	try {
		const raw = localStorage.getItem(PREFS_KEY);
		if (!raw) return { ...NOTIFY_PREFS_DEFAULTS };
		const parsed = JSON.parse(raw) as Partial<NotifyPrefs>;
		return {
			agentDone: parsed.agentDone ?? NOTIFY_PREFS_DEFAULTS.agentDone,
			errors: parsed.errors ?? NOTIFY_PREFS_DEFAULTS.errors,
			cron: parsed.cron ?? NOTIFY_PREFS_DEFAULTS.cron,
		};
	} catch {
		return { ...NOTIFY_PREFS_DEFAULTS };
	}
}

export function saveNotifyPrefs(prefs: NotifyPrefs): void {
	try {
		localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
	} catch {
		// localStorage 不可用（隐私模式）——仅内存态
	}
}

export function pageHidden(): boolean {
	return typeof document !== "undefined" && document.visibilityState !== "visible";
}

function notificationsSupported(): boolean {
	return typeof window !== "undefined" && "Notification" in window;
}

/** 请求权限（用户手势内调用）；已授权/已拒绝原样返回。 */
export async function ensureNotifyPermission(): Promise<boolean> {
	if (!notificationsSupported()) return false;
	if (Notification.permission === "granted") return true;
	if (Notification.permission === "denied") return false;
	try {
		const result = await Notification.requestPermission();
		return result === "granted";
	} catch {
		return false;
	}
}

/** 通知（仅前台隐藏时）；权限未授予返回 false。未返回 promise——fire-and-forget。 */
export function notify(title: string, body?: string, tag?: string): boolean {
	if (!notificationsSupported()) return false;
	if (Notification.permission !== "granted") return false;
	if (!pageHidden()) return false;
	try {
		new Notification(title, { body, tag, silent: true });
		return true;
	} catch {
		return false;
	}
}

/** guard：隐藏 + 权限（必要时请求）→ 发通知。 */
export async function notifyGuarded(title: string, body?: string, tag?: string): Promise<boolean> {
	if (!pageHidden()) return false;
	if (!notificationsSupported()) return false;
	if (Notification.permission !== "granted") {
		const ok = await ensureNotifyPermission();
		if (!ok) return false;
	}
	return notify(title, body, tag);
}
