import { useEffect, useRef } from "react";
import { loadNotifyPrefs, notify, pageHidden } from "../lib/notifications";
import { useSessionStore } from "../state/session-store";

/**
 * B7-1 定时任务通知：cron 开关开 + 浏览器已授权时，页面不在前台期间后台轮询
 * B6 只读代理 get_cron_logs（零后端，读文件），新执行记录（按 exec id 去重）
 * 出现 → 浏览器通知。首轮为基线（已有记录不通知），只盯新增；单轮最多 3 条防刷屏。
 */
export function NotificationCronWatcher(): null {
	const store = useSessionStore();
	const seenRef = useRef<Set<string> | null>(null);

	useEffect(() => {
		if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
		if (!loadNotifyPrefs().cron) return;

		const poll = (): void => {
			if (!pageHidden() || !loadNotifyPrefs().cron) return;
			void store
				.fetchCronLogs({ days: 1, limit: 50 })
				.then(r => {
					const ids = r.logs.map(l => l.id);
					if (!seenRef.current) {
						seenRef.current = new Set(ids);
						return;
					}
					const fresh = r.logs.filter(l => !seenRef.current!.has(l.id)).slice(0, 3);
					for (const l of r.logs) seenRef.current.add(l.id);
					for (const l of fresh) {
						notify(
							"定时任务执行完成",
							`${l.taskId} · ${l.status}${l.durationMs !== null ? ` · ${(l.durationMs / 1000).toFixed(1)}s` : ""}`,
							`omp-notify-cron-${l.id}`,
						);
					}
				})
				.catch(() => undefined);
		};

		// 基线：null 直到首次实际轮询建立（避免陈旧记录轰炸）
		const timer = setInterval(poll, 60_000);
		const onVisibility = (): void => {
			if (document.visibilityState === "visible") return;
			poll();
		};
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [store]);

	return null;
}
